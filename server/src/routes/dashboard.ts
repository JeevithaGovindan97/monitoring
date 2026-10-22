import { Router } from 'express';
import { one, query } from '../db.js';
import { wrap } from '../lib/errors.js';
import { resolveRange } from '../lib/http.js';
import { responsePercentiles, uptimeByWebsite } from '../lib/uptime.js';
import { EFFECTIVE_STATE_SQL } from '../lib/website-service.js';
import { workerHealth } from '../monitor/scheduler.js';
import { collectReport } from '../reports/data.js';

export const dashboardRouter = Router();

export async function buildSummary(from: Date, to: Date) {
  const counts = await one(
    `SELECT count(*) FILTER (WHERE w.monitoring_status <> 'archived')::int AS total,
            count(*) FILTER (WHERE ${EFFECTIVE_STATE_SQL} = 'up')::int AS online,
            count(*) FILTER (WHERE ${EFFECTIVE_STATE_SQL} = 'down')::int AS down,
            count(*) FILTER (WHERE ${EFFECTIVE_STATE_SQL} = 'degraded')::int AS degraded,
            count(*) FILTER (WHERE ${EFFECTIVE_STATE_SQL} = 'unknown' AND w.monitoring_status = 'active')::int AS unknown,
            count(*) FILTER (WHERE w.monitoring_status = 'disabled')::int AS disabled
       FROM websites w`,
  );
  const ids = (await query<{ id: string }>("SELECT id FROM websites WHERE monitoring_status <> 'archived'")).map((r) => r.id);
  const [uptimeRows, pctl] = await Promise.all([ids.length ? uptimeByWebsite(from, to, ids) : [], responsePercentiles(from, to, ids.length ? ids : undefined)]);
  const total = uptimeRows.reduce((a, r) => a + r.total, 0);
  const ok = uptimeRows.reduce((a, r) => a + r.successful, 0);
  const incidents = await one(
    `SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open,
            count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical')::int AS critical,
            count(*) FILTER (WHERE status <> 'resolved' AND acknowledged_at IS NULL)::int AS unacknowledged
       FROM incidents`,
  );
  const ssl = await one(
    `WITH latest AS (SELECT DISTINCT ON (s.website_id) s.* FROM ssl_checks s JOIN websites w ON w.id = s.website_id
                      WHERE w.monitoring_status = 'active' ORDER BY s.website_id, s.checked_at DESC)
     SELECT count(*) FILTER (WHERE valid AND days_remaining <= 30)::int AS expiring_soon,
            count(*) FILTER (WHERE NOT valid)::int AS invalid, count(*)::int AS checked FROM latest`,
  );
  const perf = await one(
    `WITH latest AS (SELECT DISTINCT ON (p.website_id) p.* FROM performance_audits p JOIN websites w ON w.id=p.website_id
                      WHERE w.monitoring_status <> 'archived' AND p.strategy = 'mobile' ORDER BY p.website_id, p.audited_at DESC)
     SELECT count(*) FILTER (WHERE status = 'ok')::int AS audited, count(*) FILTER (WHERE status = 'error')::int AS errors,
            round(avg(performance_score) FILTER (WHERE status = 'ok'))::int AS avg_score,
            count(*) FILTER (WHERE status = 'ok' AND performance_score < 50)::int AS poor, max(audited_at) AS last_audit_at FROM latest`,
  );
  const traffic = await one(
    `SELECT count(DISTINCT a.website_id)::int AS properties, sum(a.sessions)::int AS sessions, sum(a.active_users)::int AS active_users, sum(a.page_views)::int AS page_views
       FROM analytics_daily a WHERE a.date >= $1::date AND a.date < $2::date`, [from, to]);
  const seo = await one(
    `SELECT count(DISTINCT website_id)::int AS properties, sum(clicks)::int AS clicks, sum(impressions)::int AS impressions
       FROM search_console_daily WHERE date >= $1::date AND date < $2::date`, [from, to]);
  const integ = await one(
    `SELECT count(*) FILTER (WHERE ga4_status = 'connected')::int AS ga4_connected,
            count(*) FILTER (WHERE ga4_status = 'access_required')::int AS ga4_access_required,
            count(*) FILTER (WHERE gsc_status = 'connected')::int AS gsc_connected,
            count(*) FILTER (WHERE gsc_status = 'access_required')::int AS gsc_access_required,
            count(*) FILTER (WHERE ga4_status = 'error' OR gsc_status = 'error')::int AS errors
       FROM websites WHERE monitoring_status <> 'archived'`);
  const tasks = await one(
    `SELECT count(*) FILTER (WHERE status IN ('open','in_progress','blocked'))::int AS pending,
            count(*) FILTER (WHERE status IN ('open','in_progress','blocked') AND due_at < now())::int AS overdue FROM tasks`);
  const jobs = await one(
    `SELECT count(*) FILTER (WHERE status = 'failed' AND started_at > now() - interval '24 hours')::int AS failed_24h FROM scheduled_job_runs`);
  const stale = await one(
    `SELECT count(*)::int AS n FROM integrations WHERE kind IN ('ga4','search_console','pagespeed') AND enabled AND last_success_at IS NOT NULL AND last_success_at < now() - interval '48 hours'`);
  const worker = await workerHealth();
  return {
    period: { from, to },
    websites: counts,
    uptime: { pct: total ? Math.round((ok / total) * 100_000) / 1000 : null, observations: total, websites_with_data: uptimeRows.filter((r) => r.total > 0).length, websites_in_scope: ids.length },
    response_ms: pctl,
    incidents,
    ssl,
    performance: perf,
    traffic: traffic?.properties ? traffic : null,
    organic: seo?.properties ? seo : null,
    integrations: integ,
    tasks,
    jobs: { failed_24h: jobs?.failed_24h ?? 0, stale_integrations: stale?.n ?? 0 },
    worker: { alive: worker.alive, last_heartbeat: worker.lastHeartbeat },
    generated_at: new Date(),
  };
}

dashboardRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req, 7);
    res.json(await buildSummary(from, to));
  }),
);

/** Compact table for the overview page: per-website uptime for the period + current state. */
dashboardRouter.get(
  '/websites',
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req, 7);
    const sites = await query(
      `SELECT w.id, w.name, w.url, w.criticality, w.last_check_at, w.last_response_ms, w.last_status_code, w.state_since, ${EFFECTIVE_STATE_SQL} AS effective_state
         FROM websites w WHERE w.monitoring_status <> 'archived' ORDER BY lower(w.name)`);
    const up = new Map((await uptimeByWebsite(from, to)).map((r) => [r.website_id, r]));
    res.json({ period: { from, to }, data: sites.map((s) => ({ ...s, uptime_pct: up.get(s.id)?.uptime_pct ?? null, observations: up.get(s.id)?.total ?? 0, avg_ms: up.get(s.id)?.avg_ms ?? null })) });
  }),
);

/** Cross-website data for the Traffic / SEO / Performance / SSL / Forms pages (same stored data the reports use). */
dashboardRouter.get(
  '/sections',
  wrap(async (req, res) => {
    const { from, to } = resolveRange(req, 28);
    const d = await collectReport({ type: 'custom', from: from.toISOString(), to: to.toISOString() });
    res.json({
      period: d.period, timezone: d.timezone, websites: d.websites, analytics: d.analytics, seo: d.seo, performance: d.performance,
      ssl: d.ssl, forms: d.forms, integrations: d.integrations, missing: d.missing,
    });
  }),
);
