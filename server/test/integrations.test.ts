import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/db.js';
import { syncGa4 } from '../src/integrations/ga4.js';
import { deps, googleJson } from '../src/integrations/google.js';
import { parsePageSpeed, runDueAudits } from '../src/integrations/pagespeed.js';
import { syncSearchConsole } from '../src/integrations/searchconsole.js';
import { get, login, makeSite, post, put, resetDb } from './helpers.js';
import { resetConfigForTests } from '../src/config.js';

const SA = JSON.stringify({ client_email: 'monitor@proj.iam.gserviceaccount.com', private_key: 'unused-in-tests' });
const orig = { fetch: deps.fetch, sleep: deps.sleep, getToken: deps.getToken };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(async () => {
  await resetDb();
  deps.sleep = async () => undefined;
  deps.getToken = async () => 'test-token';
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = SA; resetConfigForTests();
});
afterEach(() => { Object.assign(deps, orig); delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; resetConfigForTests(); });

const ga4Rows = (n = 3) => ({ rowCount: n, rows: Array.from({ length: n }, (_, i) => ({ dimensionValues: [{ value: `2026030${i + 1}` }], metricValues: [{ value: String(10 + i) }, { value: String(20 + i) }, { value: String(30 + i) }, { value: '0.5' }, { value: '2' }] })) });

describe('Google client', () => {
  it('retries 429/5xx with exponential backoff and honours Retry-After', async () => {
    const waits: number[] = []; deps.sleep = async (ms) => void waits.push(ms);
    let n = 0;
    deps.fetch = (async () => (++n === 1 ? json({ error: { message: 'slow down' } }, 429, { 'retry-after': '3' }) : n === 2 ? json({}, 503) : json({ ok: true }))) as any;
    expect(await googleJson('https://x.test/y', { scopes: ['s'] })).toEqual({ ok: true });
    expect(waits).toEqual([3000, 1000]);
    expect(n).toBe(3);
  });
  it('gives up after the retry budget and classifies access errors', async () => {
    deps.fetch = (async () => json({ error: { message: 'Rate Limit' } }, 429)) as any;
    await expect(googleJson('https://x.test/y', { scopes: ['s'], retries: 2 })).rejects.toMatchObject({ kind: 'quota' });
    deps.fetch = (async () => json({ error: { message: 'User does not have sufficient permissions' } }, 403)) as any;
    await expect(googleJson('https://x.test/y', { scopes: ['s'] })).rejects.toMatchObject({ kind: 'access_denied' });
    deps.fetch = (async () => json({ error: { message: 'Quota exceeded for quota metric' } }, 403)) as any;
    await expect(googleJson('https://x.test/y', { scopes: ['s'] })).rejects.toMatchObject({ kind: 'quota' });
  });
});

describe('GA4 sync', () => {
  it('stores daily snapshots, marks the property connected and is idempotent', async () => {
    const w = await makeSite({ ga4_property_id: '123456789' });
    const urls: string[] = [];
    deps.fetch = (async (u: string, init: any) => { urls.push(u); expect(init.headers.Authorization).toBe('Bearer test-token'); return json(ga4Rows()); }) as any;
    expect(await syncGa4()).toMatchObject({ total: 1, ok: 1 });
    await syncGa4();
    expect(urls[0]).toContain('properties/123456789:runReport');
    const rows = await query('SELECT * FROM analytics_daily ORDER BY date');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ active_users: 10, sessions: 20, page_views: 30, conversions: 2 });
    expect((await query('SELECT ga4_status FROM websites WHERE id=$1', [w.id]))[0].ga4_status).toBe('connected');
    expect((await query("SELECT status, last_success_at FROM integrations WHERE kind='ga4'"))[0].status).toBe('connected');
  });

  it('records "access required" for denied properties and writes NO data (never zeros)', async () => {
    const w = await makeSite({ ga4_property_id: '555555555' });
    deps.fetch = (async () => json({ error: { message: 'forbidden' } }, 403)) as any;
    expect(await syncGa4()).toMatchObject({ ok: 0, access_required: 1 });
    expect((await query('SELECT ga4_status, ga4_status_detail FROM websites WHERE id=$1', [w.id]))[0]).toMatchObject({ ga4_status: 'access_required', ga4_status_detail: 'forbidden' });
    expect((await query('SELECT count(*)::int n FROM analytics_daily'))[0].n).toBe(0);
    const a = await login('admin');
    const api = await get(a, `/websites/${w.id}/analytics`);
    expect(api.body).toMatchObject({ connected: false, status: 'access_required', series: [], totals: null });
  });

  it('does nothing harmful without credentials and ignores sites without a property', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; resetConfigForTests();
    await makeSite({ ga4_property_id: '123456789' }); await makeSite({});
    deps.fetch = (async () => { throw new Error('must not be called'); }) as any;
    expect(await syncGa4()).toMatchObject({ total: 1, error: 1 });
    expect((await query("SELECT status, last_error FROM integrations WHERE kind='ga4'"))[0]).toMatchObject({ status: 'not_connected', last_error: expect.stringMatching(/not configured/) });
  });

  it('stops hammering Google when the quota is exhausted', async () => {
    await makeSite({ ga4_property_id: '111111111' }); await makeSite({ ga4_property_id: '222222222' });
    let calls = 0; deps.fetch = (async () => { calls++; return json({ error: { message: 'Quota exceeded' } }, 429); }) as any;
    await syncGa4();
    expect(calls).toBe(5); // 1 try + 4 retries for the first site, then the job aborts
  });

  it('GA4 test endpoint and mapping UI endpoint', async () => {
    const a = await login('admin');
    const w = await makeSite({});
    const map = await put(a, `/integrations/mapping/${w.id}`, { ga4_property_id: '123456789', gsc_property_url: 'sc-domain:example.com' });
    expect(map.body).toMatchObject({ ga4_status: 'access_required', gsc_status: 'access_required' });
    deps.fetch = (async () => json(ga4Rows(1))) as any;
    expect((await post(a, '/integrations/ga4/test', { website_id: w.id })).body).toEqual({ ok: true });
    deps.fetch = (async () => json({ error: { message: 'no access' } }, 403)) as any;
    expect((await post(a, '/integrations/ga4/test', { property_id: '123456789' })).body).toMatchObject({ ok: false, kind: 'access_denied' });
    expect((await post(a, `/integrations/mapping/${w.id}`.replace('/integrations', '/integrations'), {})).status).toBe(404);
    const na = await put(a, `/integrations/mapping/${w.id}`, { not_applicable: true });
    expect(na.body).toMatchObject({ ga4_status: 'not_applicable', gsc_status: 'not_applicable', ga4_property_id: null });
    const info = await get(a, '/integrations');
    expect(info.body.google).toEqual({ credentials_configured: true, service_account_email: 'monitor@proj.iam.gserviceaccount.com' });
    expect(JSON.stringify(info.body)).not.toContain('unused-in-tests'); // private key never leaves the server
  });
});

describe('Search Console sync', () => {
  it('stores daily + top queries/pages, paginates, and reports access problems per site', async () => {
    const good = await makeSite({ gsc_property_url: 'sc-domain:good.example' });
    const denied = await makeSite({ gsc_property_url: 'https://denied.example/' });
    const bodies: any[] = [];
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    const d1 = day(6), d2 = day(5);
    deps.fetch = (async (u: string, init: any) => {
      if (u.includes(encodeURIComponent('https://denied.example/'))) return json({ error: { message: 'User does not have sufficient permission for site' } }, 403);
      const b = JSON.parse(init.body); bodies.push(b);
      if (b.dimensions[0] === 'date') return json({ rows: [{ keys: [d1], clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 }, { keys: [d2], clicks: 12, impressions: 250, ctr: 0.048, position: 7.1 }] });
      return json({ rows: [{ keys: ['best widgets'], clicks: 5, impressions: 50, ctr: 0.1, position: 3 }] });
    }) as any;
    expect(await syncSearchConsole()).toMatchObject({ total: 2, ok: 1, access_required: 1 });
    expect((await query('SELECT * FROM search_console_daily ORDER BY date')).map((r) => [r.date, r.clicks, r.impressions])).toEqual([[d1, 10, 200], [d2, 12, 250]]);
    expect((await query('SELECT dimension, key FROM search_console_top ORDER BY dimension')).map((r) => `${r.dimension}:${r.key}`)).toEqual(['page:best widgets', 'query:best widgets']);
    expect((await query('SELECT gsc_status FROM websites WHERE id=$1', [good.id]))[0].gsc_status).toBe('connected');
    expect((await query('SELECT gsc_status FROM websites WHERE id=$1', [denied.id]))[0].gsc_status).toBe('access_required');
    const a = await login('admin');
    const seo = (await get(a, `/websites/${good.id}/seo?days=60`)).body;
    expect(seo.connected).toBe(true);
    expect(seo.totals).toMatchObject({ clicks: 22, impressions: 450 });
    expect(seo.top_queries[0].key).toBe('best widgets');
    expect(seo.note).toMatch(/not real-time/);
    expect((await get(a, `/websites/${denied.id}/seo`)).body).toMatchObject({ connected: false, series: [], totals: null });
  });
});

describe('PageSpeed audits', () => {
  const psi = (withField: boolean) => ({
    loadingExperience: withField ? { overall_category: 'FAST', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: 'FAST' }, INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' } } } : { id: 'https://x/' },
    lighthouseResult: {
      fetchTime: '2026-03-01T00:00:00Z', lighthouseVersion: '12', finalUrl: 'https://x/',
      categories: { performance: { score: 0.87 }, accessibility: { score: 0.95 }, 'best-practices': { score: 1 }, seo: { score: 0.9 } },
      audits: { 'largest-contentful-paint': { numericValue: 2345.6 }, 'cumulative-layout-shift': { numericValue: 0.0123 }, 'first-contentful-paint': { numericValue: 900 }, 'server-response-time': { numericValue: 120 }, 'total-blocking-time': { numericValue: 80 } },
    },
  });
  it('separates lab from field data and never invents field data', () => {
    const lab = parsePageSpeed(psi(false));
    expect(lab).toMatchObject({ performance: 87, accessibility: 95, bestPractices: 100, seo: 90, lcpMs: 2346, cls: 0.0123, fcpMs: 900, ttfbMs: 120, inpMs: null, fieldData: null });
    const field = parsePageSpeed(psi(true));
    expect(field.fieldData).toMatchObject({ overall_category: 'FAST' });
    expect(field.inpMs).toBe(180);
    expect(() => parsePageSpeed({})).toThrow(/no Lighthouse/);
  });
  it('runs due audits on their own low-frequency schedule, stores baseline, handles errors with a retry delay', async () => {
    const w = await makeSite({ url: 'https://audit.example.com', performance_interval_hours: 24 });
    const bad = await makeSite({ url: 'https://broken.example.com' });
    deps.fetch = (async (u: string) => (u.includes('broken.example.com') ? json({ error: { message: 'Lighthouse returned error: FAILED_DOCUMENT_REQUEST' } }, 500) : json(psi(false)))) as any;
    expect(await runDueAudits(5)).toBe(2);
    const a = (await query('SELECT * FROM performance_audits WHERE website_id=$1', [w.id]))[0];
    expect(a).toMatchObject({ status: 'ok', performance_score: 87, is_baseline: true, strategy: 'mobile' });
    expect(a.field_data).toBeNull();
    const e = (await query('SELECT * FROM performance_audits WHERE website_id=$1', [bad.id]))[0];
    expect(e).toMatchObject({ status: 'error', performance_score: null });
    const next = await query('SELECT id, perf_next_audit_at FROM websites');
    const hrs = (id: string) => (new Date(next.find((n) => n.id === id)!.perf_next_audit_at).getTime() - Date.now()) / 3600_000;
    expect(hrs(w.id)).toBeGreaterThan(23.5); expect(hrs(bad.id)).toBeGreaterThan(1.5); expect(hrs(bad.id)).toBeLessThan(2.5);
    expect(await runDueAudits(5)).toBe(0); // nothing due ⇒ no repeated calls for unchanged inputs
    const adm = await login('admin');
    const perf = (await get(adm, `/websites/${w.id}/performance`)).body;
    expect(perf.latest.performance_score).toBe(87);
    expect(perf.baseline.id).toBe(a.id);
    expect(perf.note).toMatch(/Field data/);
    // manual audits are throttled (a recent audit blocks a new one)
    expect((await post(adm, `/websites/${w.id}/performance/run`)).status).toBe(409);
    await query("UPDATE performance_audits SET audited_at = now() - interval '1 hour'");
    expect((await post(adm, `/websites/${w.id}/performance/run`)).status).toBe(202);
  });
  it('rejects private URLs before calling Google', async () => {
    const w = await makeSite({ url: 'https://ok.example.com' });
    await query("UPDATE websites SET url='http://10.1.1.1/' WHERE id=$1", [w.id]);
    deps.fetch = (async () => { throw new Error('must not be called'); }) as any;
    await runDueAudits(1);
    expect((await query('SELECT status, error FROM performance_audits'))[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/private|reserved/i) });
  });
});

void vi;
