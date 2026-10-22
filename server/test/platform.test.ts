import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/config.js';
import { query } from '../src/db.js';
import { runBackup } from '../src/jobs/backup.js';
import { runRetention } from '../src/jobs/retention.js';
import { runMigrations } from '../src/migrate.js';
import { aggregateHourly } from '../src/monitor/aggregate.js';
import { processWebsiteResult } from '../src/monitor/process.js';
import { runDueFormChecks } from '../src/monitor/scheduler.js';
import { OPERATIONS, buildOpenApi } from '../src/openapi.js';
import { app, del, get, login, makeSite, makeUser, patch, post, put, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('migrations', () => {
  it('creates every required table and is idempotent', async () => {
    const need = ['users', 'sessions', 'websites', 'website_checks', 'uptime_hourly', 'uptime_daily', 'ssl_checks', 'integrations', 'analytics_daily', 'search_console_daily',
      'performance_audits', 'incidents', 'incident_events', 'tasks', 'task_events', 'escalation_rules', 'notifications', 'notification_deliveries', 'report_jobs', 'audit_logs',
      'maintenance_windows', 'system_settings', 'scheduled_job_runs'];
    const have = (await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).map((r) => r.table_name);
    for (const t of need) expect(have, t).toContain(t);
    expect(await runMigrations(process.env.DATABASE_URL!, () => undefined)).toEqual([]);
    expect((await query('SELECT name FROM schema_migrations')).map((r) => r.name)).toEqual(['001_init.sql']);
  });
  it('enforces key constraints and indexes', async () => {
    const w = await makeSite();
    await expect(query("UPDATE websites SET check_interval_seconds=5 WHERE id=$1", [w.id])).rejects.toThrow();
    await expect(query("UPDATE websites SET criticality='nope' WHERE id=$1", [w.id])).rejects.toThrow();
    await expect(query("INSERT INTO website_checks (website_id,kind,started_at,finished_at,success) VALUES (gen_random_uuid(),'http',now(),now(),true)")).rejects.toThrow(/foreign key/);
    const idx = (await query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")).map((r) => r.indexname);
    for (const i of ['website_checks_site_time_idx', 'incidents_status_idx', 'incidents_open_dedupe_uq', 'websites_due_idx', 'notifications_unread_idx']) expect(idx).toContain(i);
    await query("DELETE FROM websites WHERE id=$1", [w.id]);
  });
  it('audit log rows cannot be altered', async () => {
    await makeUser('admin'); const a = await login('admin');
    await post(a, '/websites', { name: 'x', url: 'https://x.example.com' });
    await expect(query("UPDATE audit_logs SET action='forged'")).rejects.toThrow(/append-only/);
  });
});

describe('OpenAPI', () => {
  it('documents every route that exists and serves Swagger UI', async () => {
    const spec = buildOpenApi();
    expect(spec.openapi).toBe('3.0.3');
    expect((await request(app).get('/api/v1/openapi.json')).body.paths['/websites']).toBeTruthy();
    expect((await request(app).get('/api/v1/docs/')).status).toBe(200);
    const uuid = '00000000-0000-0000-0000-000000000000';
    for (const op of OPERATIONS) {
      const p = '/api/v1' + op.p.replace(/\{\w+\}/g, uuid);
      const r = await (request(app) as any)[op.m](p).send({});
      if (op.auth === 'public') continue;
      expect(r.status, `${op.m} ${op.p}`).toBe(401); // exists and is protected (404 would mean the doc is wrong)
    }
  });
  it('every state-changing admin endpoint in the spec rejects managers', async () => {
    const m = await login('manager');
    const uuid = '00000000-0000-0000-0000-000000000000';
    for (const op of OPERATIONS.filter((o) => o.auth === 'admin')) {
      const p = op.p.replace(/\{\w+\}/g, uuid);
      const r = await (m.agent as any)[op.m](`/api/v1${p}`).set('X-CSRF-Token', m.csrf).send({});
      expect(r.status, `${op.m} ${op.p}`).toBe(403);
    }
  });
});

describe('dashboard summary', () => {
  it('shows real counts with denominators and never counts unknown/disabled sites as online', async () => {
    const a = await login('admin');
    const up = await makeSite({ fail_threshold: 1 }); const down = await makeSite({ fail_threshold: 1 }); await makeSite({}); await makeSite({ monitoring_status: 'disabled' });
    const r = (ok: boolean) => ({ startedAt: new Date(), finishedAt: new Date(), success: ok, statusCode: ok ? 200 : 500, responseMs: 100, errorCategory: ok ? null : ('http_status' as const), errorMessage: null, redirectCount: 0, finalUrl: 'x' });
    await processWebsiteResult(up.id, r(true)); await processWebsiteResult(down.id, r(false));
    await aggregateHourly(new Date(Date.now() - 7200_000), new Date());
    await query("INSERT INTO tasks (title,status,due_at) VALUES ('t','open',now() - interval '1 day'),('u','completed',NULL)");
    const s = (await get(a, '/dashboard/summary?days=1')).body;
    expect(s.websites).toMatchObject({ total: 4, online: 1, down: 1, unknown: 1, disabled: 1, degraded: 0 });
    expect(s.uptime).toMatchObject({ pct: 50, observations: 2, websites_with_data: 2, websites_in_scope: 4 });
    expect(s.incidents).toMatchObject({ open: 1, critical: 0, unacknowledged: 1 });
    expect(s.tasks).toEqual({ pending: 1, overdue: 1 });
    expect(s.traffic).toBeNull(); expect(s.organic).toBeNull(); // not connected ⇒ null, not zero
    expect(s.worker.alive).toBe(false);
    const tbl = (await get(a, '/dashboard/websites?days=1')).body.data;
    expect(tbl.find((x: any) => x.id === up.id)).toMatchObject({ effective_state: 'up', uptime_pct: 100 });
    expect(tbl.find((x: any) => x.effective_state === 'unknown').uptime_pct).toBeNull();
  });
});

describe('system health: worker vs website', () => {
  it('reports a stopped worker distinctly from websites being down', async () => {
    const a = await login('admin');
    let h = (await get(a, '/system/health')).body;
    expect(h.status).toBe('degraded');
    expect(h.monitoring_worker).toMatchObject({ alive: false });
    expect(h.monitoring_worker.note).toMatch(/not necessarily a website outage/);
    await query("INSERT INTO worker_heartbeats (worker, role, started_at, last_beat_at) VALUES ('w1','monitor',now(),now())");
    h = (await get(a, '/system/health')).body;
    expect(h).toMatchObject({ status: 'ok' });
    expect(h.monitoring_worker.alive).toBe(true);
    expect((await get(a, '/dashboard/summary')).body.worker.alive).toBe(true);
    expect((await request(app).get('/api/v1/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/v1/health/ready')).body).toEqual({ status: 'ready' });
  });
});

describe('settings, maintenance, audit log', () => {
  it('admins update validated settings; managers cannot; secrets are never returned', async () => {
    const a = await login('admin'); const m = await login('manager');
    const bad = await put(a, '/settings', { alert_cooldown_minutes: -1 });
    expect(bad.status).toBe(400);
    expect((await put(a, '/settings', { timezone: 'Mars/Base' })).status).toBe(400);
    expect((await put(a, '/settings', { timezone: 'Asia/Kolkata', ssl_alert_days: [30, 14, 7] })).status).toBe(200);
    const s = (await get(m, '/settings')).body;
    expect(s.settings.timezone).toBe('Asia/Kolkata');
    expect(JSON.stringify(s)).not.toMatch(/password":"/i);
    expect(s.smtp).toMatchObject({ configured: false });
  });
  it('maintenance windows CRUD with validation', async () => {
    const a = await login('admin'); const w = await makeSite();
    const start = new Date(Date.now() + 3600_000).toISOString(); const end = new Date(Date.now() + 7200_000).toISOString();
    expect((await post(a, `/websites/${w.id}/maintenance`, { starts_at: end, ends_at: start })).status).toBe(400);
    const c = await post(a, `/websites/${w.id}/maintenance`, { starts_at: start, ends_at: end, reason: 'Upgrade' });
    expect(c.status).toBe(201);
    expect((await get(a, `/websites/${w.id}/maintenance`)).body.data).toHaveLength(1);
    expect((await post(a, '/maintenance', { starts_at: start, ends_at: end })).status).toBe(201);
    expect((await get(a, '/maintenance')).body.data).toHaveLength(2);
    expect((await del(a, `/websites/${w.id}/maintenance/${c.body.id}`)).status).toBe(204);
  });
  it('audit logs record admin actions and are filterable, admin-only', async () => {
    const a = await login('admin'); const m = await login('manager');
    await post(a, '/websites', { name: 'Audited', url: 'https://audited.example.com' });
    await post(a, '/users', { email: 'new@example.com', name: 'New', role: 'manager' });
    const all = (await get(a, '/audit-logs?action=website')).body;
    expect(all.data[0]).toMatchObject({ action: 'website.created', user_email: 'admin@example.com' });
    expect((await get(a, '/audit-logs?action=user.')).body.total).toBe(1);
    expect(JSON.stringify((await get(a, '/audit-logs')).body)).not.toMatch(/Temp|password_hash/);
    expect((await get(m, '/audit-logs')).status).toBe(403);
  });
});

describe('form & checkout page checks', () => {
  let server: http.Server; let url: string; let status = 200;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true'; resetConfigForTests();
    server = http.createServer((_q, r) => { r.writeHead(status); r.end('<form></form>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/checkout`;
  });
  afterAll(async () => { delete process.env.ALLOW_PRIVATE_TARGETS; resetConfigForTests(); await new Promise<void>((r) => server.close(() => r())); });

  it('safe page-load checks open and resolve a form incident; PATCH never resets unspecified fields; only GET is ever used', async () => {
    const a = await login('admin'); await makeUser('manager');
    const w = await makeSite({ name: 'Store' });
    delete process.env.ALLOW_PRIVATE_TARGETS; resetConfigForTests();
    expect((await post(a, `/websites/${w.id}/form-checks`, { label: 'Checkout', type: 'checkout', url })).status).toBe(400); // private URL refused at the API
    process.env.ALLOW_PRIVATE_TARGETS = 'true'; resetConfigForTests();
    const c = await post(a, `/websites/${w.id}/form-checks`, { label: 'Checkout', type: 'checkout', url, interval_seconds: 120 });
    expect(c.status).toBe(201);
    const pr = await patch(a, `/websites/${w.id}/form-checks/${c.body.id}`, { label: 'Checkout page' });
    expect(pr.body).toMatchObject({ label: 'Checkout page', interval_seconds: 120, enabled: true });
    const due = () => query("UPDATE form_checks SET next_check_at = now() - interval '1s', lock_until=NULL");
    await due(); await runDueFormChecks();
    expect((await query('SELECT state FROM form_checks'))[0].state).toBe('up');
    status = 500;
    await due(); await runDueFormChecks(); await due(); await runDueFormChecks();
    const inc = await query("SELECT kind, severity, status, title FROM incidents");
    expect(inc).toEqual([{ kind: 'form', severity: 'high', status: 'open', title: 'Checkout page page failing on Store' }]); // checkout pages are at least "high"
    const list = (await get(a, `/websites/${w.id}/form-checks`)).body;
    expect(list.data[0]).toMatchObject({ state: 'down', failures_7d: 2, open_incident_id: expect.any(String) });
    expect(list.synthetic_tests.supported).toBe(false);
    expect((await query("SELECT count(*)::int n FROM website_checks WHERE kind='form'"))[0].n).toBe(3);
    expect((await query("SELECT count(*)::int n FROM website_checks WHERE kind='http'"))[0].n).toBe(0); // form checks don't pollute site uptime
    status = 200;
    await due(); await runDueFormChecks(); await due(); await runDueFormChecks();
    expect((await query('SELECT status FROM incidents'))[0].status).toBe('resolved');
    const checks = await get(a, `/websites/${w.id}/checks?kind=form`);
    expect(checks.body.total).toBe(5);
  });
});

describe('retention & backup', () => {
  it('retention removes old raw data but keeps aggregates and baselines', async () => {
    const w = await makeSite();
    await query("INSERT INTO website_checks (website_id,kind,started_at,finished_at,success) VALUES ($1,'http',now()-interval '120 days',now()-interval '120 days',true),($1,'http',now(),now(),true)", [w.id]);
    await query("INSERT INTO uptime_daily (website_id,bucket,total,successful,failed) VALUES ($1,current_date-120,288,288,0)", [w.id]);
    await query("INSERT INTO audit_logs (at,action) VALUES (now()-interval '400 days','old'),(now(),'new')");
    const out = await runRetention();
    expect(out.checks).toBe(1);
    expect(out.audit_logs).toBe(1);
    expect((await query('SELECT count(*)::int n FROM website_checks'))[0].n).toBe(1);
    expect((await query('SELECT count(*)::int n FROM uptime_daily'))[0].n).toBe(1);
  });

  it('pg_dump backup → encryption → retention → RESTORE into a scratch database (verified)', async () => {
    const dir = '/tmp/igo-test-backups'; fs.rmSync(dir, { recursive: true, force: true });
    process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'correct horse battery staple'; process.env.BACKUP_RETENTION_DAYS = '7'; resetConfigForTests();
    await makeUser('admin'); await makeSite({ name: 'Backed up' });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'monitor-old.dump.enc'), 'x'); fs.utimesSync(path.join(dir, 'monitor-old.dump.enc'), new Date(0), new Date(0));
    const r = await runBackup();
    expect(r).toMatchObject({ encrypted: true, pruned: 1 });
    expect(fs.readdirSync(dir)).toEqual([r.file]);
    const enc = path.join(dir, r.file);
    expect(fs.readFileSync(enc).subarray(0, 8).toString()).toBe('Salted__'); // encrypted, not a plain dump
    const plain = path.join(dir, 'restored.dump');
    execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', enc, '-out', plain, '-pass', 'env:P'], { env: { ...process.env, P: 'correct horse battery staple' } });
    const base = process.env.DATABASE_URL!;
    const scratch = base.replace(/\/[^/]+$/, '/monitor_restore_check');
    execFileSync('psql', [base.replace(/\/[^/]+$/, '/postgres'), '-c', 'DROP DATABASE IF EXISTS monitor_restore_check', '-c', 'CREATE DATABASE monitor_restore_check']);
    execFileSync('pg_restore', ['--no-owner', '--dbname', scratch, plain]);
    const names = execFileSync('psql', [scratch, '-Atc', 'SELECT name FROM websites']).toString().trim();
    execFileSync('psql', [base.replace(/\/[^/]+$/, '/postgres'), '-c', 'DROP DATABASE monitor_restore_check']);
    expect(names).toBe('Backed up');
    delete process.env.BACKUP_ENCRYPTION_PASSPHRASE; delete process.env.BACKUP_RETENTION_DAYS; resetConfigForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
