import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { resetConfigForTests } from '../src/config.js';
import { aggregateDaily, aggregateHourly } from '../src/monitor/aggregate.js';
import { claimDueWebsites, runDueChecks, runDueSslChecks } from '../src/monitor/scheduler.js';
import { checkCertificate, daysUntil, sslAlertLevel } from '../src/monitor/ssl.js';
import { responsePercentiles, uptimeByWebsite, pct } from '../src/lib/uptime.js';
import { get, login, makeSite, makeUser, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('scheduler', () => {
  it('claims each due website exactly once even with concurrent workers (no duplicate checks)', async () => {
    for (let i = 0; i < 12; i++) await makeSite();
    const [a, b, c] = await Promise.all([claimDueWebsites(8, 'w1'), claimDueWebsites(8, 'w2'), claimDueWebsites(8, 'w3')]);
    const ids = [...a, ...b, ...c].map((r) => r.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(await claimDueWebsites(10, 'w4')).toHaveLength(0); // leased ⇒ not re-claimed while a check is running
  });

  it('only claims active, due, unlocked sites', async () => {
    await makeSite({ monitoring_status: 'disabled' });
    await makeSite({ monitoring_status: 'archived' });
    const future = await makeSite();
    await query("UPDATE websites SET next_check_at = now() + interval '1 hour' WHERE id=$1", [future.id]);
    const ok = await makeSite();
    expect((await claimDueWebsites(10)).map((r) => r.id)).toEqual([ok.id]);
  });

  it('a crashed worker\'s lease expires so the check is picked up again', async () => {
    const w = await makeSite();
    await claimDueWebsites(10, 'dead-worker');
    await query("UPDATE websites SET lock_until = now() - interval '1 second' WHERE id=$1", [w.id]);
    expect((await claimDueWebsites(10, 'alive')).map((r) => r.id)).toEqual([w.id]);
  });
});

describe('end-to-end check cycle against a real HTTP server', () => {
  let server: http.Server; let url: string; let healthy = true;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = 'true'; resetConfigForTests();
    server = http.createServer((_q, r) => { r.writeHead(healthy ? 200 : 503); r.end('x'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => { delete process.env.ALLOW_PRIVATE_TARGETS; resetConfigForTests(); await new Promise<void>((r) => server.close(() => r())); });

  it('stores results, advances next_check_at by the interval, and walks through outage → recovery', async () => {
    await makeUser('admin');
    // creation validation blocks private targets, so insert directly like an operator with ALLOW_PRIVATE_TARGETS would
    const w = await makeSite({ name: 'Local' });
    await query('UPDATE websites SET url=$2, url_normalized=$2, check_interval_seconds=60 WHERE id=$1', [w.id, url]);
    const force = () => query('UPDATE websites SET next_check_at = now() - interval \'1 second\' WHERE id=$1', [w.id]);

    expect(await runDueChecks()).toBe(1);
    let row = (await query('SELECT * FROM websites WHERE id=$1', [w.id]))[0];
    expect(row).toMatchObject({ state: 'up', last_status_code: 200, consecutive_failures: 0 });
    expect(row.lock_until).toBeNull();
    const delta = (new Date(row.next_check_at).getTime() - Date.now()) / 1000;
    expect(delta).toBeGreaterThan(55); expect(delta).toBeLessThan(75);
    expect(await runDueChecks()).toBe(0); // not due again until the interval has passed

    healthy = false;
    await force(); await runDueChecks();
    await force(); await runDueChecks();
    row = (await query('SELECT * FROM websites WHERE id=$1', [w.id]))[0];
    expect(row.state).toBe('down');
    expect((await query("SELECT count(*)::int n FROM incidents WHERE status='open'"))[0].n).toBe(1);

    healthy = true;
    await force(); await runDueChecks();
    await force(); await runDueChecks();
    expect((await query('SELECT state FROM websites WHERE id=$1', [w.id]))[0].state).toBe('up');
    expect((await query("SELECT status FROM incidents"))[0].status).toBe('resolved');
    const checks = await query('SELECT success, status_code, error_category FROM website_checks WHERE website_id=$1 ORDER BY id', [w.id]);
    expect(checks.map((c) => c.success)).toEqual([true, false, false, true, true]);
    expect(checks[1]).toMatchObject({ status_code: 503, error_category: 'http_status' });
  });

  it('survives an internal failure with exponential backoff and releases the lease', async () => {
    const { hooks } = await import('../src/monitor/scheduler.js');
    const w = await makeSite({ name: 'Boom' });
    await query('UPDATE websites SET url=$2, url_normalized=$2 WHERE id=$1', [w.id, url]);
    const orig = hooks.process;
    hooks.process = async () => { throw new Error('db down'); };
    try {
      await runDueChecks();
      let row = (await query('SELECT lock_until, internal_error_count, next_check_at FROM websites WHERE id=$1', [w.id]))[0];
      expect(row.lock_until).toBeNull();
      expect(row.internal_error_count).toBe(1);
      const d1 = (new Date(row.next_check_at).getTime() - Date.now()) / 1000;
      expect(d1).toBeGreaterThan(10);
      await query("UPDATE websites SET next_check_at = now() - interval '1s' WHERE id=$1", [w.id]);
      await runDueChecks();
      row = (await query('SELECT internal_error_count, next_check_at FROM websites WHERE id=$1', [w.id]))[0];
      expect(row.internal_error_count).toBe(2);
      expect((new Date(row.next_check_at).getTime() - Date.now()) / 1000).toBeGreaterThan(d1 * 1.5); // backed off
      expect((await query("SELECT count(*)::int n FROM incidents"))[0].n).toBe(0); // internal errors are not website outages
    } finally { hooks.process = orig; }
  });
});

describe('uptime aggregation', () => {
  const insert = async (siteId: string, at: string, ok: boolean, ms: number | null, maint = false) =>
    query(`INSERT INTO website_checks (website_id, kind, started_at, finished_at, success, status_code, response_ms, in_maintenance)
           VALUES ($1,'http',$2,$2,$3,$4,$5,$6)`, [siteId, at, ok, ok ? 200 : 500, ms, maint]);

  it('computes uptime from valid observations only, excludes maintenance, and reports null when there is no data', async () => {
    const w = await makeSite(); const empty = await makeSite();
    for (let i = 0; i < 9; i++) await insert(w.id, `2026-03-01T10:${String(i * 5).padStart(2, '0')}:00Z`, true, 100 + i * 10);
    await insert(w.id, '2026-03-01T10:50:00Z', false, null);
    await insert(w.id, '2026-03-01T10:55:00Z', false, null, true); // maintenance ⇒ ignored
    await aggregateHourly(new Date('2026-03-01T10:00:00Z'), new Date('2026-03-01T11:00:00Z'));
    const from = new Date('2026-03-01T10:00:00Z'), to = new Date('2026-03-01T11:00:00Z');
    const rows = await uptimeByWebsite(from, to, [w.id, empty.id]);
    expect(rows).toHaveLength(1); // the empty site has no row ⇒ callers must show "no data", not 100 %
    expect(rows[0]).toMatchObject({ total: 10, successful: 9, failed: 1, maintenance: 1, uptime_pct: 90, avg_ms: 140 });
    const p = await responsePercentiles(from, to, [w.id]);
    expect(p).toMatchObject({ p50: 140, avg: 140 });
    expect(p.p95).toBeGreaterThan(170);
    expect(pct(0, 0)).toBeNull();
  });

  it('aggregation is idempotent and daily buckets match hourly ones', async () => {
    const w = await makeSite();
    await insert(w.id, '2026-03-02T01:00:00Z', true, 100);
    await insert(w.id, '2026-03-02T15:00:00Z', false, null);
    for (let i = 0; i < 3; i++) { await aggregateHourly(new Date('2026-03-02T00:00:00Z'), new Date('2026-03-03T00:00:00Z')); await aggregateDaily(new Date('2026-03-02T00:00:00Z'), new Date('2026-03-03T00:00:00Z')); }
    expect((await query('SELECT count(*)::int n FROM uptime_hourly'))[0].n).toBe(2);
    const d = await query('SELECT * FROM uptime_daily');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ total: 2, successful: 1, failed: 1 });
    // long ranges use the daily table
    const rows = await uptimeByWebsite(new Date('2026-01-01T00:00:00Z'), new Date('2026-03-05T00:00:00Z'), [w.id]);
    expect(rows[0]).toMatchObject({ total: 2, uptime_pct: 50 });
  });

  it('the API distinguishes "no data" and reports coverage', async () => {
    const a = await login('admin');
    const w = await makeSite({ check_interval_seconds: 300 });
    const r = await get(a, `/websites/${w.id}/uptime?days=1`);
    expect(r.body.summary.uptime_pct).toBeNull();
    expect(r.body.points).toEqual([]);
    expect(r.body.coverage_pct).toBe(0);
  });
});

describe('SSL monitoring', () => {
  it('calculates days remaining and alert levels (30/14/7, expired, invalid)', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    expect(daysUntil(new Date('2026-03-31T00:00:00Z'), now)).toBe(30);
    expect(daysUntil(new Date('2026-02-28T00:00:00Z'), now)).toBe(-1);
    const lvl = (days: number | null, valid = true, error: string | null = null) => sslAlertLevel({ valid, daysRemaining: days, error });
    expect(lvl(90)).toBeNull();
    expect(lvl(31)).toBeNull();
    expect(lvl(30)).toBe(30);
    expect(lvl(15)).toBe(30);
    expect(lvl(14)).toBe(14);
    expect(lvl(7)).toBe(7);
    expect(lvl(1)).toBe(7);
    expect(lvl(-1, false, 'expired')).toBe(0);
    expect(lvl(60, false, 'self signed certificate')).toBe(0);
  });

  it('reads a real certificate over TLS and flags an untrusted one without calling it an outage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '20', '-subj', '/CN=selfsigned.test/O=Test'], { stdio: 'ignore' });
    const https = await import('node:https');
    const srv = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (_q, r) => r.end('ok'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const r = await checkCertificate(`https://127.0.0.1:${port}/`, { allowPrivate: true });
    srv.close();
    expect(r.valid).toBe(false); // self-signed ⇒ not trusted
    expect(r.error).toMatch(/self.signed|SELF_SIGNED|unable to/i);
    expect(r.subject).toBe('selfsigned.test');
    expect(r.daysRemaining).toBeGreaterThanOrEqual(19);
    expect(r.daysRemaining).toBeLessThanOrEqual(20);
    expect(r.protocol).toMatch(/TLS/);
    expect(await checkCertificate('https://127.0.0.1:1/', { timeoutMs: 500 })).toMatchObject({ valid: false }); // SSRF-blocked
    expect(await checkCertificate('http://example.com')).toMatchObject({ valid: false, error: 'Not an HTTPS URL' });
  });

  it('alerts once per threshold crossing (no duplicate e-mails) and opens/resolves an incident for expired certs', async () => {
    const { hooks } = await import('../src/monitor/scheduler.js');
    await makeUser('admin', 'a@example.com');
    const w = await makeSite({ name: 'Cert Co', url: 'https://cert.example.com' });
    let next: any;
    const orig = hooks.certificate;
    hooks.certificate = async () => next;
    const cert = (days: number, valid = true, error: string | null = null) => ({ valid, subject: 'cert.example.com', issuer: 'LE', validFrom: new Date(), validTo: new Date(Date.now() + days * 86400000), daysRemaining: days, protocol: 'TLSv1.3', error });
    const run = async (c: any) => { next = c; await query("UPDATE websites SET ssl_next_check_at = now() - interval '1s', ssl_lock_until=NULL WHERE id=$1", [w.id]); await runDueSslChecks(); };
    const mails = async () => (await query("SELECT subject FROM notification_deliveries WHERE kind='ssl_expiring'")).length;
    try {
      await run(cert(90));
      expect(await mails()).toBe(0);
      await run(cert(29)); expect(await mails()).toBe(1);   // 30-day threshold crossed
      await run(cert(28)); expect(await mails()).toBe(1);   // same level ⇒ no repeat
      await run(cert(13)); expect(await mails()).toBe(2);   // 14-day threshold
      await run(cert(6));  expect(await mails()).toBe(3);   // 7-day threshold
      expect((await query("SELECT count(*)::int n FROM incidents"))[0].n).toBe(0); // expiring soon is a warning, not an outage
      expect((await query("SELECT severity FROM notifications WHERE type='ssl_expiring' ORDER BY created_at DESC LIMIT 1"))[0].severity).toBe('critical');
      await run(cert(-2, false, 'Certificate has expired'));
      const inc = await query("SELECT kind, status, severity FROM incidents");
      expect(inc).toEqual([{ kind: 'ssl', status: 'open', severity: 'high' }]);
      expect((await query("SELECT state FROM websites WHERE id=$1", [w.id]))[0].state).toBe('unknown'); // an SSL problem is not an HTTP outage
      await run(cert(80)); // renewed
      expect((await query("SELECT status FROM incidents"))[0].status).toBe('resolved');
      await run(cert(20)); expect(await mails()).toBe(4); // a fresh cycle may alert again after renewal
      const hist = await query('SELECT valid, days_remaining FROM ssl_checks ORDER BY id');
      expect(hist).toHaveLength(8);
    } finally { hooks.certificate = orig; }
  });
});
