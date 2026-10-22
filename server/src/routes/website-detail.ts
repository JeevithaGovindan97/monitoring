import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged, resolveRange } from '../lib/http.js';
import { responsePercentiles, seriesForWebsite, uptimeByWebsite } from '../lib/uptime.js';
import { isValidExpectedStatus } from '../lib/status.js';
import { urlField } from '../lib/website-schema.js';

export const websiteDetailRouter = Router({ mergeParams: true });

const idOf = (req: any) => z.string().uuid().parse(req.params.id);

async function site(id: string) {
  const w = await one('SELECT id, name, url, check_interval_seconds, ga4_property_id, ga4_status, ga4_status_detail, gsc_property_url, gsc_status, gsc_status_detail FROM websites WHERE id=$1', [id]);
  if (!w) throw notFound('Website not found');
  return w;
}

websiteDetailRouter.get(
  '/checks',
  wrap(async (req, res) => {
    const id = idOf(req);
    await site(id);
    const { page, pageSize, offset } = pageParams(req, 500);
    const { from, to } = resolveRange(req, 7);
    const kind = req.query.kind === 'form' ? 'form' : 'http';
    const onlyFailed = req.query.failed === 'true';
    const where = `website_id=$1 AND kind=$2 AND started_at >= $3 AND started_at < $4 ${onlyFailed ? 'AND NOT success' : ''}`;
    const rows = await query(
      `SELECT id, started_at, finished_at, success, status_code, response_ms, error_category, error_message, redirect_count, final_url, in_maintenance, form_check_id
         FROM website_checks WHERE ${where} ORDER BY started_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
      [id, kind, from, to],
    );
    const total = (await one(`SELECT count(*)::int n FROM website_checks WHERE ${where}`, [id, kind, from, to])).n;
    res.json(paged(rows, total, page, pageSize));
  }),
);

websiteDetailRouter.get(
  '/uptime',
  wrap(async (req, res) => {
    const id = idOf(req);
    const w = await site(id);
    const { from, to } = resolveRange(req, 7);
    const [series, [summary], pctl] = await Promise.all([seriesForWebsite(id, from, to), uptimeByWebsite(from, to, [id]), responsePercentiles(from, to, [id])]);
    const expected = Math.floor((to.getTime() - from.getTime()) / 1000 / w.check_interval_seconds);
    const observed = (summary?.total ?? 0) + (summary?.maintenance ?? 0);
    res.json({
      range: { from, to },
      ...series,
      summary: summary ?? { total: 0, successful: 0, failed: 0, maintenance: 0, uptime_pct: null, avg_ms: null },
      percentiles: pctl,
      coverage_pct: expected > 0 ? Math.min(100, Math.round((observed / expected) * 1000) / 10) : null,
      method: 'successful / (successful + failed) scheduled checks; maintenance excluded; null when no observations',
    });
  }),
);

const checkNowLimiter = rateLimit({
  windowMs: 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anon',
  validate: false,
  message: { error: { code: 'rate_limited', message: 'Too many manual checks. Please wait a minute.' } },
});

websiteDetailRouter.post(
  '/check-now',
  checkNowLimiter,
  wrap(async (req, res) => {
    const id = idOf(req);
    // The worker (not the API) performs the request: the API process never makes outbound calls to monitored hosts.
    const r = await one(
      `UPDATE websites SET next_check_at = now() WHERE id = $1 AND monitoring_status = 'active'
         AND (lock_until IS NULL OR lock_until < now()) RETURNING id, last_check_at`,
      [id],
    );
    if (!r) {
      const w = await one('SELECT monitoring_status, lock_until FROM websites WHERE id = $1', [id]);
      if (!w) throw notFound('Website not found');
      if (w.monitoring_status !== 'active') throw badRequest('Monitoring is not active for this website');
      throw conflict('A check is already running for this website');
    }
    await audit(req, 'website.check_now', 'website', id);
    res.status(202).json({ queued: true, previous_check_at: r.last_check_at });
  }),
);

function sumRows(rows: any[], f: string) {
  const vals = rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined);
  return vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
}

websiteDetailRouter.get(
  '/analytics',
  wrap(async (req, res) => {
    const id = idOf(req);
    const w = await site(id);
    const { from, to } = resolveRange(req, 28);
    const span = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);
    const sel = `SELECT date, active_users, sessions, page_views, engagement_rate, conversions, synced_at FROM analytics_daily WHERE website_id=$1 AND date >= $2::date AND date < $3::date ORDER BY date`;
    const [cur, prev, integ] = await Promise.all([
      query(sel, [id, from, to]),
      query(sel, [id, prevFrom, from]),
      one("SELECT last_success_at, last_error, last_error_at, status FROM integrations WHERE kind='ga4'"),
    ]);
    const tot = (rows: any[]) => ({
      active_users: sumRows(rows, 'active_users'), sessions: sumRows(rows, 'sessions'), page_views: sumRows(rows, 'page_views'),
      conversions: sumRows(rows, 'conversions'),
      engagement_rate: rows.length ? rows.reduce((a, r) => a + Number(r.engagement_rate ?? 0), 0) / rows.length : null,
    });
    res.json({
      status: w.ga4_status, status_detail: w.ga4_status_detail, property_id: w.ga4_property_id,
      connected: w.ga4_status === 'connected',
      last_sync_at: cur.length ? cur.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), cur[0].synced_at) : null,
      integration: integ, range: { from, to },
      // When not connected there is no data at all: callers must show a prompt, never zeros.
      series: cur, totals: cur.length ? tot(cur) : null, previous_totals: prev.length ? tot(prev) : null,
      note: 'GA4 data is processed with a delay of up to 24-48 hours.',
    });
  }),
);

websiteDetailRouter.get(
  '/seo',
  wrap(async (req, res) => {
    const id = idOf(req);
    const w = await site(id);
    const { from, to } = resolveRange(req, 28);
    const span = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);
    const sel = `SELECT date, clicks, impressions, ctr, position, synced_at FROM search_console_daily WHERE website_id=$1 AND date >= $2::date AND date < $3::date ORDER BY date`;
    const [cur, prev, top, integ] = await Promise.all([
      query(sel, [id, from, to]),
      query(sel, [id, prevFrom, from]),
      query(
        `SELECT dimension, key, clicks, impressions, ctr, position, period_start, period_end FROM search_console_top
          WHERE website_id=$1 AND (period_start, period_end) = (SELECT period_start, period_end FROM search_console_top WHERE website_id=$1 ORDER BY period_end DESC LIMIT 1)
          ORDER BY clicks DESC LIMIT 100`, [id]),
      one("SELECT last_success_at, last_error, last_error_at FROM integrations WHERE kind='search_console'"),
    ]);
    const tot = (rows: any[]) => {
      const clicks = rows.reduce((a, r) => a + r.clicks, 0);
      const imp = rows.reduce((a, r) => a + r.impressions, 0);
      const posW = rows.reduce((a, r) => a + Number(r.position ?? 0) * r.impressions, 0);
      return { clicks, impressions: imp, ctr: imp ? clicks / imp : null, position: imp ? posW / imp : null };
    };
    res.json({
      status: w.gsc_status, status_detail: w.gsc_status_detail, property: w.gsc_property_url, connected: w.gsc_status === 'connected',
      data_through: cur.length ? cur[cur.length - 1].date : null,
      last_sync_at: cur.length ? cur.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), cur[0].synced_at) : null,
      integration: integ, range: { from, to }, series: cur, totals: cur.length ? tot(cur) : null,
      previous_totals: prev.length ? tot(prev) : null,
      top_queries: top.filter((t) => t.dimension === 'query'), top_pages: top.filter((t) => t.dimension === 'page'),
      note: 'Search Console data is not real-time; it typically lags by 2-3 days.',
    });
  }),
);

websiteDetailRouter.get(
  '/performance',
  wrap(async (req, res) => {
    const id = idOf(req);
    await site(id);
    const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';
    const { from, to } = resolveRange(req, 90);
    const audits = await query(
      `SELECT id, strategy, audited_at, status, error, performance_score, accessibility_score, best_practices_score, seo_score,
              lcp_ms, cls, inp_ms, fcp_ms, ttfb_ms, tbt_ms, field_data IS NOT NULL AS has_field_data, field_data, is_baseline
         FROM performance_audits WHERE website_id=$1 AND strategy=$2 AND audited_at >= $3 AND audited_at < $4 ORDER BY audited_at DESC LIMIT 400`,
      [id, strategy, from, to],
    );
    const baseline = await one(
      `SELECT id, audited_at, performance_score, accessibility_score, best_practices_score, seo_score, lcp_ms, cls, fcp_ms
         FROM performance_audits WHERE website_id=$1 AND strategy=$2 AND is_baseline`, [id, strategy]);
    const latest = audits.find((a) => a.status === 'ok') ?? null;
    const lastAttempt = audits[0] ?? null;
    res.json({
      strategy, latest, last_attempt: lastAttempt, baseline, audits,
      comparison: latest && baseline ? {
        performance_score: (latest.performance_score ?? 0) - (baseline.performance_score ?? 0),
        lcp_ms: latest.lcp_ms !== null && baseline.lcp_ms !== null ? latest.lcp_ms - baseline.lcp_ms : null,
        cls: latest.cls !== null && baseline.cls !== null ? Number(latest.cls) - Number(baseline.cls) : null,
      } : null,
      note: 'Lab data comes from a simulated Lighthouse run. Field data (real users, CrUX) is shown only when Google reports it.',
    });
  }),
);

websiteDetailRouter.post(
  '/performance/baseline',
  requireAdmin,
  wrap(async (req, res) => {
    const id = idOf(req);
    const b = z.object({ audit_id: z.number().int() }).parse(req.body);
    const a = await one("SELECT id, strategy FROM performance_audits WHERE id=$1 AND website_id=$2 AND status='ok'", [b.audit_id, id]);
    if (!a) throw notFound('Audit not found');
    await query('UPDATE performance_audits SET is_baseline=false WHERE website_id=$1 AND strategy=$2 AND is_baseline', [id, a.strategy]);
    await query('UPDATE performance_audits SET is_baseline=true WHERE id=$1', [a.id]);
    await audit(req, 'performance.baseline_set', 'website', id, { audit_id: a.id });
    res.status(204).end();
  }),
);

const auditLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: process.env.NODE_ENV === 'test' ? 1000 : 5, validate: false,
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anon',
  message: { error: { code: 'rate_limited', message: 'Manual audits are throttled. Try again in a few minutes.' } },
});
websiteDetailRouter.post(
  '/performance/run',
  requireAdmin,
  auditLimiter,
  wrap(async (req, res) => {
    const id = idOf(req);
    const r = await one(
      `UPDATE websites SET perf_next_audit_at = now() WHERE id=$1 AND monitoring_status='active'
         AND NOT EXISTS (SELECT 1 FROM performance_audits p WHERE p.website_id=$1 AND p.audited_at > now() - interval '10 minutes')
       RETURNING id`, [id]);
    if (!r) throw conflict('An audit ran in the last 10 minutes or monitoring is not active');
    await audit(req, 'performance.run_requested', 'website', id);
    res.status(202).json({ queued: true });
  }),
);

websiteDetailRouter.get(
  '/ssl',
  wrap(async (req, res) => {
    const id = idOf(req);
    const w = await one('SELECT id, url, ssl_check_enabled FROM websites WHERE id=$1', [id]);
    if (!w) throw notFound('Website not found');
    const history = await query('SELECT checked_at, valid, subject, issuer, valid_from, valid_to, days_remaining, protocol, error FROM ssl_checks WHERE website_id=$1 ORDER BY checked_at DESC LIMIT 100', [id]);
    const lastOk = await one('SELECT checked_at FROM ssl_checks WHERE website_id=$1 AND valid ORDER BY checked_at DESC LIMIT 1', [id]);
    res.json({ applicable: /^https:/i.test(w.url), enabled: w.ssl_check_enabled, latest: history[0] ?? null, last_success_at: lastOk?.checked_at ?? null, history });
  }),
);

// ---- forms / checkout page checks
const formBase = z.object({
  label: z.string().trim().min(1).max(120),
  type: z.enum(['contact', 'login', 'booking', 'checkout', 'other']),
  url: urlField,
  enabled: z.boolean(),
  expected_status: z.string().refine(isValidExpectedStatus, 'Invalid expected status'),
  interval_seconds: z.coerce.number().int().min(60).max(86400),
  timeout_ms: z.coerce.number().int().min(1000).max(60000),
});
// defaults apply on create only; PATCH uses the plain partial so omitted fields are never reset
const formSchema = formBase.extend({
  enabled: formBase.shape.enabled.default(true), expected_status: formBase.shape.expected_status.default('200-399'),
  interval_seconds: formBase.shape.interval_seconds.default(900), timeout_ms: formBase.shape.timeout_ms.default(10000),
});
const formPatchSchema = formBase.partial();

websiteDetailRouter.get(
  '/form-checks',
  wrap(async (req, res) => {
    const id = idOf(req);
    const rows = await query(
      `SELECT f.*, (SELECT count(*)::int FROM website_checks c WHERE c.form_check_id=f.id AND NOT c.success AND c.started_at > now() - interval '7 days') AS failures_7d,
              (SELECT i.id FROM incidents i WHERE i.website_id=f.website_id AND i.dedupe_key = 'form:' || f.id AND i.status <> 'resolved') AS open_incident_id
         FROM form_checks f WHERE website_id=$1 ORDER BY created_at`, [id]);
    res.json({ data: rows, synthetic_tests: { supported: false, note: 'Page-load checks only. Browser-based synthetic tests are not enabled in this release; no forms are submitted and no orders are created.' } });
  }),
);
websiteDetailRouter.post(
  '/form-checks',
  requireAdmin,
  wrap(async (req, res) => {
    const id = idOf(req);
    await site(id);
    const b = formSchema.parse(req.body);
    const row = await one(
      `INSERT INTO form_checks (website_id,label,type,url,enabled,expected_status,interval_seconds,timeout_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.label, b.type, b.url, b.enabled, b.expected_status, b.interval_seconds, b.timeout_ms]);
    await audit(req, 'form_check.created', 'form_check', row.id, { website_id: id });
    res.status(201).json(row);
  }),
);
websiteDetailRouter.patch(
  '/form-checks/:fid',
  requireAdmin,
  wrap(async (req, res) => {
    const id = idOf(req);
    const fid = z.string().uuid().parse(req.params.fid);
    const b = formPatchSchema.parse(req.body);
    const keys = Object.keys(b) as Array<keyof typeof b>;
    if (!keys.length) throw badRequest('No fields to update');
    const row = await one(
      `UPDATE form_checks SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now() WHERE id=$1 AND website_id=$2 RETURNING *`,
      [fid, id, ...keys.map((k) => b[k])]);
    if (!row) throw notFound('Form check not found');
    await audit(req, 'form_check.updated', 'form_check', fid);
    res.json(row);
  }),
);
websiteDetailRouter.delete(
  '/form-checks/:fid',
  requireAdmin,
  wrap(async (req, res) => {
    const r = await query('DELETE FROM form_checks WHERE id=$1 AND website_id=$2 RETURNING id', [z.string().uuid().parse(req.params.fid), idOf(req)]);
    if (!r.length) throw notFound('Form check not found');
    await audit(req, 'form_check.deleted', 'form_check', String(r[0].id));
    res.status(204).end();
  }),
);

// ---- maintenance windows
websiteDetailRouter.get(
  '/maintenance',
  wrap(async (req, res) => {
    res.json({ data: await query('SELECT * FROM maintenance_windows WHERE website_id=$1 ORDER BY starts_at DESC LIMIT 100', [idOf(req)]) });
  }),
);
websiteDetailRouter.post(
  '/maintenance',
  requireAdmin,
  wrap(async (req, res) => {
    const id = idOf(req);
    const b = z.object({ starts_at: z.coerce.date(), ends_at: z.coerce.date(), reason: z.string().max(500).optional() }).parse(req.body);
    if (b.ends_at <= b.starts_at) throw badRequest('End must be after start');
    await site(id);
    const row = await one('INSERT INTO maintenance_windows (website_id,starts_at,ends_at,reason,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [id, b.starts_at, b.ends_at, b.reason ?? null, req.user!.id]);
    await audit(req, 'maintenance.created', 'website', id, { window: row.id });
    res.status(201).json(row);
  }),
);
websiteDetailRouter.delete(
  '/maintenance/:mid',
  requireAdmin,
  wrap(async (req, res) => {
    const r = await query('DELETE FROM maintenance_windows WHERE id=$1 AND website_id=$2 RETURNING id', [z.string().uuid().parse(req.params.mid), idOf(req)]);
    if (!r.length) throw notFound('Maintenance window not found');
    await audit(req, 'maintenance.deleted', 'website', idOf(req));
    res.status(204).end();
  }),
);
