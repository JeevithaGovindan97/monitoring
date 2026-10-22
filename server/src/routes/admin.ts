import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';
import { loadServiceAccount, serviceAccountEmail } from '../integrations/google.js';
import { testGa4 } from '../integrations/ga4.js';
import { listAccessibleSites, testSearchConsole } from '../integrations/searchconsole.js';
import { smtpConfigured } from '../monitor/email.js';
import { workerHealth } from '../monitor/scheduler.js';

// ---------------------------------------------------------------- integrations
export const integrationsRouter = Router();

integrationsRouter.get('/', wrap(async (_req, res) => {
  const rows = await query('SELECT kind, enabled, status, config, last_success_at, last_error, last_error_at, updated_at FROM integrations ORDER BY kind');
  const counts = await one(`SELECT
    count(*) FILTER (WHERE ga4_property_id IS NOT NULL)::int AS ga4_mapped, count(*) FILTER (WHERE ga4_status='connected')::int AS ga4_connected,
    count(*) FILTER (WHERE ga4_status='access_required')::int AS ga4_access_required, count(*) FILTER (WHERE ga4_status='error')::int AS ga4_error,
    count(*) FILTER (WHERE gsc_property_url IS NOT NULL)::int AS gsc_mapped, count(*) FILTER (WHERE gsc_status='connected')::int AS gsc_connected,
    count(*) FILTER (WHERE gsc_status='access_required')::int AS gsc_access_required, count(*) FILTER (WHERE gsc_status='error')::int AS gsc_error
    FROM websites WHERE monitoring_status <> 'archived'`);
  const c = config();
  res.json({
    integrations: rows.map((r) => r.kind === 'smtp' && !smtpConfigured() ? { ...r, status: 'not_connected' } : r),
    google: { credentials_configured: Boolean(loadServiceAccount()), service_account_email: serviceAccountEmail() },
    pagespeed: { api_key_configured: Boolean(c.PAGESPEED_API_KEY) },
    smtp: { configured: c.smtpConfigured },
    uptime_kuma: { url_configured: Boolean(c.UPTIME_KUMA_URL), authoritative: 'This dashboard is the authoritative monitoring engine. Uptime Kuma checks are not duplicated.' },
    counts,
  });
}));

integrationsRouter.post('/ga4/test', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ property_id: z.string().regex(/^\d{5,15}$/).optional(), website_id: z.string().uuid().optional() }).parse(req.body ?? {});
  if (!loadServiceAccount()) return res.status(200).json({ ok: false, kind: 'not_configured', message: 'Google service-account credentials are not configured on the server' });
  let prop = b.property_id;
  if (!prop && b.website_id) prop = (await one('SELECT ga4_property_id FROM websites WHERE id=$1', [b.website_id]))?.ga4_property_id;
  if (!prop) throw badRequest('Provide property_id or a website_id that has a GA4 property');
  const r = await testGa4(prop);
  await audit(req, 'integration.ga4_test', 'integration', 'ga4', { ok: r.ok });
  res.json(r);
}));

integrationsRouter.post('/search-console/test', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ property: z.string().max(2048).optional(), website_id: z.string().uuid().optional() }).parse(req.body ?? {});
  if (!loadServiceAccount()) return res.status(200).json({ ok: false, kind: 'not_configured', message: 'Google service-account credentials are not configured on the server' });
  let prop = b.property;
  if (!prop && b.website_id) prop = (await one('SELECT gsc_property_url FROM websites WHERE id=$1', [b.website_id]))?.gsc_property_url;
  const r = await testSearchConsole(prop);
  await audit(req, 'integration.gsc_test', 'integration', 'search_console', { ok: r.ok });
  res.json(r);
}));

integrationsRouter.get('/search-console/sites', requireAdmin, wrap(async (_req, res) => {
  if (!loadServiceAccount()) throw badRequest('Google service-account credentials are not configured');
  res.json({ data: await listAccessibleSites() });
}));

integrationsRouter.patch('/pagespeed', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ strategies: z.array(z.enum(['mobile', 'desktop'])).min(1), enabled: z.boolean().optional() }).parse(req.body);
  await query("UPDATE integrations SET config = config || $1::jsonb, enabled = COALESCE($2, enabled), updated_at = now() WHERE kind='pagespeed'", [JSON.stringify({ strategies: b.strategies }), b.enabled ?? null]);
  await audit(req, 'integration.pagespeed_updated', 'integration', 'pagespeed', b);
  res.status(204).end();
}));

/** Map a website to GA4 / Search Console properties (also possible via PATCH /websites/:id). */
integrationsRouter.put('/mapping/:websiteId', requireAdmin, wrap(async (req, res) => {
  const wid = z.string().uuid().parse(req.params.websiteId);
  const b = z.object({
    ga4_property_id: z.string().regex(/^\d{5,15}$/).nullable().optional(),
    gsc_property_url: z.string().max(2048).regex(/^(sc-domain:[^\s/]+|https?:\/\/\S+)$/).nullable().optional(),
    not_applicable: z.boolean().optional(),
  }).parse(req.body);
  const w = await one('SELECT id FROM websites WHERE id=$1', [wid]);
  if (!w) throw notFound('Website not found');
  if (b.not_applicable) {
    await query("UPDATE websites SET ga4_status='not_applicable', gsc_status='not_applicable', ga4_property_id=NULL, gsc_property_url=NULL, updated_at=now() WHERE id=$1", [wid]);
  } else {
    if ('ga4_property_id' in b) await query("UPDATE websites SET ga4_property_id=$2, ga4_status=CASE WHEN $2::text IS NULL THEN 'not_connected' ELSE 'access_required' END, ga4_status_detail=NULL, updated_at=now() WHERE id=$1", [wid, b.ga4_property_id ?? null]);
    if ('gsc_property_url' in b) await query("UPDATE websites SET gsc_property_url=$2, gsc_status=CASE WHEN $2::text IS NULL THEN 'not_connected' ELSE 'access_required' END, gsc_status_detail=NULL, updated_at=now() WHERE id=$1", [wid, b.gsc_property_url ?? null]);
  }
  await audit(req, 'integration.mapping_updated', 'website', wid, b);
  res.json(await one('SELECT id, ga4_property_id, ga4_status, gsc_property_url, gsc_status FROM websites WHERE id=$1', [wid]));
}));

// ---------------------------------------------------------------- audit logs
export const auditRouter = Router();
auditRouter.use(requireAdmin);
auditRouter.get('/', wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req, 200);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.action) add('a.action ILIKE ?', `${String(req.query.action).replace(/[%_\\]/g, '\\$&')}%`);
  if (req.query.user_id) add('a.user_id = ?', String(req.query.user_id));
  if (req.query.entity_type) add('a.entity_type = ?', String(req.query.entity_type));
  if (req.query.from) add('a.at >= ?', new Date(String(req.query.from)));
  if (req.query.to) add('a.at < ?', new Date(String(req.query.to)));
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await query(`SELECT a.* FROM audit_logs a ${w} ORDER BY a.at DESC, a.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*)::int n FROM audit_logs a ${w}`, params)).n;
  res.json(paged(rows, total, page, pageSize));
}));

// ---------------------------------------------------------------- system
export const systemRouter = Router();

systemRouter.get('/health', wrap(async (_req, res) => {
  const t0 = Date.now();
  await query('SELECT 1');
  const dbMs = Date.now() - t0;
  const w = await workerHealth();
  const workers = await query("SELECT worker, role, started_at, last_beat_at, details, (last_beat_at > now() - interval '2 minutes') AS alive FROM worker_heartbeats ORDER BY worker");
  const queue = await one(`SELECT
    (SELECT count(*)::int FROM websites WHERE monitoring_status='active' AND next_check_at < now() - interval '2 minutes') AS overdue_checks,
    (SELECT count(*)::int FROM websites WHERE monitoring_status='active') AS active_websites,
    (SELECT count(*)::int FROM notification_deliveries WHERE status='pending') AS pending_emails,
    (SELECT count(*)::int FROM notification_deliveries WHERE status='failed') AS failed_emails,
    (SELECT count(*)::int FROM report_jobs WHERE status IN ('queued','running')) AS reports_in_flight,
    (SELECT max(started_at) FROM website_checks) AS last_check_stored`);
  const jobs = await query(`SELECT DISTINCT ON (job_name) job_name, status, started_at, finished_at, error, details FROM scheduled_job_runs ORDER BY job_name, started_at DESC`);
  const failed = await query("SELECT job_name, started_at, error FROM scheduled_job_runs WHERE status='failed' AND started_at > now() - interval '24 hours' ORDER BY started_at DESC LIMIT 20");
  res.json({
    status: !w.alive ? 'degraded' : 'ok',
    database: { ok: true, latency_ms: dbMs },
    monitoring_worker: { alive: w.alive, last_heartbeat: w.lastHeartbeat, note: w.alive ? undefined : 'No worker heartbeat in the last 2 minutes. Website statuses may be stale — this is a monitoring problem, not necessarily a website outage.' },
    workers, queue, jobs, failed_jobs_24h: failed,
    version: process.env.APP_VERSION ?? 'dev', time: new Date(),
  });
}));

systemRouter.get('/jobs', requireAdmin, wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req, 200);
  const rows = await query(`SELECT * FROM scheduled_job_runs ORDER BY started_at DESC LIMIT ${pageSize} OFFSET ${offset}`);
  const total = (await one('SELECT count(*)::int n FROM scheduled_job_runs')).n;
  res.json(paged(rows, total, page, pageSize));
}));

// ---------------------------------------------------------------- global maintenance windows
export const maintenanceRouter = Router();
maintenanceRouter.get('/', wrap(async (_req, res) => {
  res.json({ data: await query('SELECT m.*, w.name AS website_name FROM maintenance_windows m LEFT JOIN websites w ON w.id=m.website_id WHERE m.ends_at > now() - interval \'30 days\' ORDER BY m.starts_at DESC LIMIT 200') });
}));
maintenanceRouter.post('/', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ website_id: z.string().uuid().nullish(), starts_at: z.coerce.date(), ends_at: z.coerce.date(), reason: z.string().max(500).optional() }).parse(req.body);
  if (b.ends_at <= b.starts_at) throw badRequest('End must be after start');
  const row = await one('INSERT INTO maintenance_windows (website_id, starts_at, ends_at, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.website_id ?? null, b.starts_at, b.ends_at, b.reason ?? null, req.user!.id]);
  await audit(req, 'maintenance.created', 'maintenance', row.id, { website_id: b.website_id ?? 'all' });
  res.status(201).json(row);
}));
maintenanceRouter.delete('/:id', requireAdmin, wrap(async (req, res) => {
  const r = await query('DELETE FROM maintenance_windows WHERE id=$1 RETURNING id', [z.string().uuid().parse(req.params.id)]);
  if (!r.length) throw notFound('Maintenance window not found');
  await audit(req, 'maintenance.deleted', 'maintenance', String(r[0].id));
  res.status(204).end();
}));
