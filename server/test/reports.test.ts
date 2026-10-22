import ExcelJS from 'exceljs';
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { aggregateHourly } from '../src/monitor/aggregate.js';
import { processWebsiteResult } from '../src/monitor/process.js';
import { collectReport } from '../src/reports/data.js';
import { renderPdf } from '../src/reports/pdf.js';
import { runQueuedReports, reportsDir } from '../src/reports/runner.js';
import { renderXlsx } from '../src/reports/xlsx.js';
import { get, login, makeSite, makeUser, post, resetDb } from './helpers.js';
import request from 'supertest';
import { app } from './helpers.js';

beforeEach(async () => { await resetDb(); fs.rmSync(reportsDir(), { recursive: true, force: true }); });

const ok = (t: Date, ms = 150) => ({ startedAt: t, finishedAt: new Date(t.getTime() + ms), success: true, statusCode: 200, responseMs: ms, errorCategory: null, errorMessage: null, redirectCount: 0, finalUrl: 'x' });
const bad = (t: Date) => ({ ...ok(t), success: false, statusCode: 503, responseMs: 20, errorCategory: 'http_status' as const, errorMessage: 'HTTP 503' });

async function seed() {
  await makeUser('admin');
  const good = await makeSite({ name: 'Good Site', url: 'https://good.example.com', fail_threshold: 1, recover_threshold: 1, ga4_status: 'not_applicable' });
  const flaky = await makeSite({ name: '=cmd|evil', url: 'https://flaky.example.com', fail_threshold: 1, recover_threshold: 1, criticality: 'critical' });
  const unchecked = await makeSite({ name: 'Never Checked', url: 'https://never.example.com' });
  const base = Date.now() - 3600_000;
  for (let i = 0; i < 6; i++) { await processWebsiteResult(good.id, ok(new Date(base + i * 60_000))); await processWebsiteResult(flaky.id, i === 2 || i === 3 ? bad(new Date(base + i * 60_000)) : ok(new Date(base + i * 60_000))); }
  await aggregateHourly(new Date(base - 3600_000), new Date());
  await query("INSERT INTO ssl_checks (website_id,checked_at,valid,subject,issuer,valid_to,days_remaining) VALUES ($1,now(),true,'good','LE',now()+interval '10 days',10)", [good.id]);
  await query("INSERT INTO performance_audits (website_id,strategy,audited_at,status,performance_score,accessibility_score,best_practices_score,seo_score,lcp_ms,cls) VALUES ($1,'mobile',now(),'ok',42,90,90,90,4200,0.2)", [good.id]);
  await query("INSERT INTO analytics_daily (website_id,date,active_users,sessions,page_views,engagement_rate) VALUES ($1,current_date - 1,100,150,400,0.61)", [flaky.id]);
  const [fc] = await query("INSERT INTO form_checks (website_id,label,type,url,state,last_check_at,last_status_code) VALUES ($1,'Checkout','checkout','https://flaky.example.com/checkout','down',now(),500) RETURNING id", [flaky.id]);
  for (const okc of [true, false, false]) await query("INSERT INTO website_checks (website_id,form_check_id,kind,started_at,finished_at,success,status_code,response_ms) VALUES ($1,$2,'form',now(),now(),$3,$4,50)", [flaky.id, fc.id, okc, okc ? 200 : 500]);
  return { good, flaky, unchecked };
}

describe('report data', () => {
  it('uses stored data only; unavailable data is null/"n/a", never zero or invented', async () => {
    const { good, flaky, unchecked } = await seed();
    const d = await collectReport({ type: 'daily' });
    expect(d.summary.websites_total).toBe(3);
    const row = (id: string) => d.websites.find((w) => w.id === id)!;
    expect(row(good.id)).toMatchObject({ observations: 6, uptime_pct: 100 });
    expect(row(flaky.id)).toMatchObject({ observations: 6, failed: 2, uptime_pct: 66.667 });
    expect(row(unchecked.id)).toMatchObject({ observations: 0, uptime_pct: null });
    expect(d.summary.observations).toBe(12); // never-checked site adds nothing to the denominator
    expect(d.summary.uptime_pct).toBe(83.333);
    expect(d.analytics.find((a) => a.website_id === good.id)).toMatchObject({ days: 0, sessions: null }); // no data ⇒ null, not 0
    expect(d.analytics.find((a) => a.website_id === flaky.id)).toMatchObject({ days: 1, sessions: 150 });
    expect(d.missing.join(' ')).toMatch(/Never Checked/);
    expect(d.missing.join(' ')).toMatch(/Traffic data unavailable for 2 of 3/);
    expect(d.recommendations.join('\n')).toMatch(/performance score 42/);
    expect(d.recommendations.join('\n')).toMatch(/expires in 10 day/);
    expect(d.recommendations.join('\n')).toMatch(/checkout.*failed|failed.*check|Checkout/i);
    expect(d.incidents.length).toBe(1);
  });

  it('single-website and typed reports are scoped', async () => {
    const { flaky } = await seed();
    const one = await collectReport({ type: 'website', websiteId: flaky.id });
    expect(one.websites).toHaveLength(1);
    expect(one.scope.websiteName).toBe('=cmd|evil');
    const t = await collectReport({ type: 'traffic_seo' });
    expect(t.sections.has('uptime')).toBe(false);
    await expect(collectReport({ type: 'website', websiteId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/not found/);
    await expect(collectReport({ type: 'custom', from: '2026-02-01', to: '2026-01-01' })).rejects.toThrow(/Invalid report period/);
  });
});

describe('renderers', () => {
  it('produces a real multi-section PDF', async () => {
    await seed();
    const buf = await renderPdf(await collectReport({ type: 'weekly' }));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(3000);
    expect(buf.toString('latin1')).toMatch(/\/Type\s*\/Page/);
  });

  it('produces an Excel workbook with the documented sheets, formats, filters and no formula injection', async () => {
    await seed();
    const buf = await renderXlsx(await collectReport({ type: 'monthly' }));
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Executive Summary', 'Website Inventory', 'Uptime Summary', 'Incidents', 'Analytics', 'SEO', 'Performance', 'SSL', 'Forms & Checkout', 'Tasks', 'Integration Status']);
    const up = wb.getWorksheet('Uptime Summary')!;
    expect(up.autoFilter).toBeTruthy();
    expect(up.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const names = [] as string[]; up.eachRow((r, n) => n > 1 && names.push(String(r.getCell(1).value)));
    expect(names).toContain("'=cmd|evil"); // sanitised
    expect(names).not.toContain('=cmd|evil');
    const pctCol = up.getRow(1).values as string[];
    expect(up.getCell(2, (pctCol as any[]).indexOf('Uptime %')).numFmt).toBe('0.000');
    const an = wb.getWorksheet('Analytics')!;
    const goodRow = [...Array(an.rowCount).keys()].map((i) => an.getRow(i + 1)).find((r) => r.getCell(1).value === 'Good Site')!;
    expect(goodRow.getCell(4).value).toBeNull(); // no GA data ⇒ empty cell, not 0
    expect(wb.getWorksheet('Incidents')!.getCell(2, 1).value).toBe('=cmd|evil'.replace(/^/, "'"));
  });
});

describe('report API', () => {
  it('queues, generates in the background, tracks progress, and downloads with authorization + audit trail', async () => {
    await seed();
    const a = await login('admin'); const m = await login('manager');
    const r = await post(m, '/reports', { type: 'daily', format: 'pdf' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('queued');
    expect((await get(m, `/reports/${r.body.id}/download`)).status).toBe(400); // not ready yet
    expect(await runQueuedReports()).toBe(1);
    const st = (await get(a, `/reports/${r.body.id}`)).body;
    expect(st).toMatchObject({ status: 'done', progress: 100, format: 'pdf' });
    expect(st.expires_at).toBeTruthy();
    const dl = await m.agent.get(`/api/v1/reports/${r.body.id}/download`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="report_daily_\d{4}-\d{2}-\d{2}\.pdf"/);
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    expect((dl.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await query("SELECT count(*)::int n FROM audit_logs WHERE action IN ('report.requested','report.downloaded')"))[0].n).toBe(2);
    expect((await query('SELECT download_count FROM report_jobs'))[0].download_count).toBe(1);
    // file lives outside any served directory under an opaque name
    expect(fs.readdirSync(reportsDir())).toEqual([`${r.body.id}.pdf`]);
  });

  it('requires authentication and never serves reports to anonymous users or by guessable paths', async () => {
    await seed();
    const m = await login('manager');
    const r = await post(m, '/reports', { type: 'weekly', format: 'xlsx' });
    await runQueuedReports();
    expect((await request(app).get(`/api/v1/reports/${r.body.id}/download`)).status).toBe(401);
    expect((await request(app).get(`/reports/${r.body.id}.xlsx`)).status).toBe(404);
    expect((await get(m, '/reports/not-a-uuid/download')).status).toBe(400);
    expect((await get(m, '/reports/00000000-0000-0000-0000-000000000000/download')).status).toBe(404);
  });

  it('reports failures instead of hanging, validates params, and expires old files', async () => {
    const m = await login('manager');
    expect((await post(m, '/reports', { type: 'custom', format: 'pdf' })).status).toBe(400);
    expect((await post(m, '/reports', { type: 'website', format: 'pdf' })).status).toBe(400);
    expect((await post(m, '/reports', { type: 'bogus', format: 'pdf' })).status).toBe(400);
    expect((await post(m, '/reports', { type: 'custom', format: 'pdf', from: '2026-02-01', to: '2026-01-01' })).status).toBe(400);
    const w = await makeSite();
    const r = await post(m, '/reports', { type: 'website', format: 'xlsx', websiteId: w.id });
    await query('DELETE FROM websites WHERE id=$1', [w.id]); // vanishes before generation
    await runQueuedReports();
    expect((await get(m, `/reports/${r.body.id}`)).body).toMatchObject({ status: 'failed', error: expect.stringMatching(/not found/i) });
    // expiry
    const ok = await post(m, '/reports', { type: 'daily', format: 'xlsx' });
    await runQueuedReports();
    await query("UPDATE report_jobs SET expires_at = now() - interval '1 day' WHERE id=$1", [ok.body.id]);
    expect((await get(m, `/reports/${ok.body.id}/download`)).status).toBe(404);
    const { purgeExpiredReports } = await import('../src/reports/runner.js');
    expect(await purgeExpiredReports()).toBe(1);
    expect(fs.readdirSync(reportsDir())).toEqual([]);
  });
});
