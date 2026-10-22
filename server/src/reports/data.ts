import { query, one } from '../db.js';
import { responsePercentiles, uptimeByWebsite } from '../lib/uptime.js';
import { EFFECTIVE_STATE_SQL } from '../lib/website-service.js';
import { getSetting } from '../lib/settings.js';

export const REPORT_TYPES = ['daily', 'weekly', 'monthly', 'custom', 'website', 'incidents', 'traffic_seo', 'performance_ssl', 'tasks'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportParams { type: ReportType; from?: string; to?: string; websiteId?: string }

export function resolvePeriod(p: ReportParams, now = new Date()): { from: Date; to: Date } {
  const to = p.to ? new Date(p.to) : now;
  if (p.type === 'daily' && !p.from) return { from: new Date(to.getTime() - 86400_000), to };
  if (p.type === 'weekly' && !p.from) return { from: new Date(to.getTime() - 7 * 86400_000), to };
  if (p.type === 'monthly' && !p.from) return { from: new Date(to.getTime() - 30 * 86400_000), to };
  const from = p.from ? new Date(p.from) : new Date(to.getTime() - 30 * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('Invalid report period');
  return { from, to };
}

export interface ReportData {
  type: ReportType;
  title: string;
  generatedAt: Date;
  timezone: string;
  period: { from: Date; to: Date };
  scope: { websiteId?: string; websiteName?: string; websiteCount: number };
  sections: Set<string>;
  summary: any;
  websites: any[];
  incidents: any[];
  ssl: any[];
  analytics: any[];
  seo: any[];
  performance: any[];
  forms: any[];
  tasks: any[];
  integrations: any[];
  missing: string[];
  recommendations: string[];
  inventory: any[];
}

const TITLES: Record<ReportType, string> = {
  daily: 'Daily summary report', weekly: 'Weekly summary report', monthly: 'Monthly summary report', custom: 'Custom date-range report',
  website: 'Website report', incidents: 'Incident report', traffic_seo: 'Traffic & SEO report', performance_ssl: 'Performance & SSL report', tasks: 'Tasks & escalations report',
};
const SECTIONS: Record<ReportType, string[]> = {
  daily: ['uptime', 'incidents', 'ssl', 'analytics', 'seo', 'performance', 'forms', 'tasks', 'integrations'],
  weekly: ['uptime', 'incidents', 'ssl', 'analytics', 'seo', 'performance', 'forms', 'tasks', 'integrations'],
  monthly: ['uptime', 'incidents', 'ssl', 'analytics', 'seo', 'performance', 'forms', 'tasks', 'integrations'],
  custom: ['uptime', 'incidents', 'ssl', 'analytics', 'seo', 'performance', 'forms', 'tasks', 'integrations'],
  website: ['uptime', 'incidents', 'ssl', 'analytics', 'seo', 'performance', 'forms', 'tasks', 'integrations'],
  incidents: ['uptime', 'incidents'],
  traffic_seo: ['analytics', 'seo', 'integrations'],
  performance_ssl: ['performance', 'ssl'],
  tasks: ['tasks'],
};

export async function collectReport(p: ReportParams, onProgress: (pct: number) => Promise<void> | void = () => undefined): Promise<ReportData> {
  const { from, to } = resolvePeriod(p);
  const sections = new Set(SECTIONS[p.type]);
  const tz = await getSetting<string>('timezone', 'UTC');
  const siteFilter = p.websiteId ? 'AND w.id = $1' : '';
  const siteParams = p.websiteId ? [p.websiteId] : [];
  const sites = await query<any>(
    `SELECT w.id, w.name, w.url, w.hosting_type, w.environment, w.owner, w.criticality, w.monitoring_status, w.check_interval_seconds, w.expected_status,
            w.ga4_status, w.gsc_status, w.ga4_property_id, w.gsc_property_url, w.notes, ${EFFECTIVE_STATE_SQL} AS effective_state, w.last_check_at, w.last_response_ms
       FROM websites w WHERE w.monitoring_status <> 'archived' ${siteFilter} ORDER BY lower(w.name)`, siteParams);
  if (p.websiteId && !sites.length) throw new Error('Website not found');
  const ids = sites.map((s) => s.id);
  const idParam = ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
  await onProgress(10);

  const up = new Map((await uptimeByWebsite(from, to, idParam)).map((r) => [r.website_id, r]));
  const pctl = await responsePercentiles(from, to, idParam);
  const incidents = await query<any>(
    `SELECT i.id, i.title, i.kind, i.severity, i.status, i.started_at, i.detected_at, i.acknowledged_at, i.resolved_at, i.duration_seconds, i.auto_resolved,
            w.name AS website_name, w.id AS website_id, au.name AS assigned_name
       FROM incidents i JOIN websites w ON w.id=i.website_id LEFT JOIN users au ON au.id=i.assigned_to
      WHERE i.website_id = ANY($1) AND i.started_at < $3 AND (i.resolved_at IS NULL OR i.resolved_at >= $2) ORDER BY i.started_at DESC LIMIT 2000`, [idParam, from, to]);
  await onProgress(30);
  const inc = new Map<string, { n: number; secs: number }>();
  for (const i of incidents) {
    if (i.kind !== 'outage') continue;
    const end = i.resolved_at ? new Date(i.resolved_at) : to;
    const start = new Date(i.started_at) < from ? from : new Date(i.started_at);
    const e = inc.get(i.website_id) ?? { n: 0, secs: 0 };
    e.n++; e.secs += Math.max(0, Math.round((Math.min(end.getTime(), to.getTime()) - start.getTime()) / 1000));
    inc.set(i.website_id, e);
  }
  const websites = sites.map((s) => {
    const u = up.get(s.id);
    return { ...s, observations: u?.total ?? 0, successful: u?.successful ?? 0, failed: u?.failed ?? 0, uptime_pct: u?.uptime_pct ?? null, avg_ms: u?.avg_ms ?? null,
      outages: inc.get(s.id)?.n ?? 0, downtime_seconds: inc.get(s.id)?.secs ?? 0 };
  });

  const ssl = await query<any>(
    `SELECT DISTINCT ON (s.website_id) w.id AS website_id, w.name AS website_name, w.url, s.checked_at, s.valid, s.subject, s.issuer, s.valid_to, s.days_remaining, s.error
       FROM ssl_checks s JOIN websites w ON w.id=s.website_id WHERE s.website_id = ANY($1) ORDER BY s.website_id, s.checked_at DESC`, [idParam]);
  const sslSorted = ssl.sort((a, b) => (a.days_remaining ?? 9999) - (b.days_remaining ?? 9999));

  const fmtD = (d: Date) => d.toISOString().slice(0, 10);
  const analytics = sections.has('analytics') ? await query<any>(
    `SELECT w.id AS website_id, w.name AS website_name, w.ga4_status, count(a.date)::int AS days, sum(a.active_users)::int AS active_users, sum(a.sessions)::int AS sessions,
            sum(a.page_views)::int AS page_views, avg(a.engagement_rate) AS engagement_rate, sum(a.conversions) AS conversions, max(a.synced_at) AS last_sync
       FROM websites w LEFT JOIN analytics_daily a ON a.website_id=w.id AND a.date >= $2::date AND a.date < $3::date
      WHERE w.id = ANY($1) GROUP BY w.id ORDER BY lower(w.name)`, [idParam, fmtD(from), fmtD(to)]) : [];
  const seo = sections.has('seo') ? await query<any>(
    `SELECT w.id AS website_id, w.name AS website_name, w.gsc_status, count(s.date)::int AS days, sum(s.clicks)::int AS clicks, sum(s.impressions)::int AS impressions,
            CASE WHEN sum(s.impressions) > 0 THEN sum(s.clicks)::numeric / sum(s.impressions) END AS ctr,
            CASE WHEN sum(s.impressions) > 0 THEN sum(s.position * s.impressions) / sum(s.impressions) END AS position, max(s.date) AS data_through, max(s.synced_at) AS last_sync
       FROM websites w LEFT JOIN search_console_daily s ON s.website_id=w.id AND s.date >= $2::date AND s.date < $3::date
      WHERE w.id = ANY($1) GROUP BY w.id ORDER BY lower(w.name)`, [idParam, fmtD(from), fmtD(to)]) : [];
  await onProgress(55);
  const performance = sections.has('performance') ? await query<any>(
    `SELECT DISTINCT ON (p.website_id) w.id AS website_id, w.name AS website_name, p.strategy, p.audited_at, p.status, p.error, p.performance_score, p.accessibility_score,
            p.best_practices_score, p.seo_score, p.lcp_ms, p.cls, p.inp_ms, p.fcp_ms, p.ttfb_ms, p.field_data IS NOT NULL AS has_field_data,
            b.performance_score AS baseline_performance
       FROM performance_audits p JOIN websites w ON w.id=p.website_id
       LEFT JOIN performance_audits b ON b.website_id=p.website_id AND b.strategy=p.strategy AND b.is_baseline
      WHERE p.website_id = ANY($1) AND p.strategy='mobile' ORDER BY p.website_id, p.audited_at DESC`, [idParam]) : [];
  const forms = sections.has('forms') ? await query<any>(
    `SELECT f.id, w.name AS website_name, f.label, f.type, f.url, f.enabled, f.state, f.last_check_at, f.last_status_code, f.last_response_ms, f.last_error,
            (SELECT count(*)::int FROM website_checks c WHERE c.form_check_id=f.id AND NOT c.success AND NOT c.in_maintenance AND c.started_at >= $2 AND c.started_at < $3) AS failures,
            (SELECT count(*)::int FROM website_checks c WHERE c.form_check_id=f.id AND NOT c.in_maintenance AND c.started_at >= $2 AND c.started_at < $3) AS checks
       FROM form_checks f JOIN websites w ON w.id=f.website_id WHERE f.website_id = ANY($1) ORDER BY lower(w.name), f.label`, [idParam, from, to]) : [];
  const tasks = sections.has('tasks') ? await query<any>(
    `SELECT t.id, t.title, t.status, t.priority, t.due_at, t.completed_at, t.created_at, w.name AS website_name, au.name AS assigned_name,
            (t.due_at < now() AND t.status IN ('open','in_progress','blocked')) AS overdue
       FROM tasks t LEFT JOIN websites w ON w.id=t.website_id LEFT JOIN users au ON au.id=t.assigned_to
      WHERE ${p.websiteId ? 't.website_id = $1 AND' : ''} (t.status IN ('open','in_progress','blocked') OR t.completed_at >= ${p.websiteId ? '$2' : '$1'} OR t.created_at >= ${p.websiteId ? '$2' : '$1'})
      ORDER BY (t.status IN ('completed','cancelled')), t.due_at NULLS LAST LIMIT 2000`, p.websiteId ? [p.websiteId, from] : [from]) : [];
  const integrations = await query<any>('SELECT kind, status, enabled, last_success_at, last_error, last_error_at FROM integrations ORDER BY kind');
  await onProgress(75);

  const total = websites.reduce((a, w) => a + w.observations, 0);
  const okc = websites.reduce((a, w) => a + w.successful, 0);
  const count = (st: string) => websites.filter((w) => w.effective_state === st).length;
  const summary = {
    websites_total: websites.length, online: count('up'), down: count('down'), degraded: count('degraded'), unknown: count('unknown'), unmonitored: count('unmonitored'),
    uptime_pct: total ? Math.round((okc / total) * 100_000) / 1000 : null, observations: total, response: pctl,
    incidents_total: incidents.length, incidents_open: incidents.filter((i) => i.status !== 'resolved').length,
    incidents_critical: incidents.filter((i) => i.severity === 'critical').length,
    outage_seconds: websites.reduce((a, w) => a + w.downtime_seconds, 0),
    ssl_expiring_30: sslSorted.filter((s) => s.valid && s.days_remaining <= 30).length, ssl_invalid: sslSorted.filter((s) => !s.valid).length,
    tasks_pending: tasks.filter((t) => ['open', 'in_progress', 'blocked'].includes(t.status)).length,
    tasks_completed: tasks.filter((t) => t.status === 'completed' && t.completed_at && new Date(t.completed_at) >= from).length,
    tasks_overdue: tasks.filter((t) => t.overdue).length,
  };

  const missing: string[] = [];
  const noData = websites.filter((w) => w.monitoring_status === 'active' && w.observations === 0).map((w) => w.name);
  if (noData.length) missing.push(`No uptime observations in this period for: ${noData.slice(0, 15).join(', ')}${noData.length > 15 ? ` (+${noData.length - 15} more)` : ''}`);
  if (sections.has('analytics')) {
    const na = analytics.filter((a) => a.days === 0);
    if (na.length) missing.push(`Traffic data unavailable for ${na.length} of ${analytics.length} website(s) (not connected / access required / no data yet).`);
  }
  if (sections.has('seo')) {
    const ns = seo.filter((a) => a.days === 0);
    if (ns.length) missing.push(`Search Console data unavailable for ${ns.length} of ${seo.length} website(s). Search Console data lags by 2-3 days.`);
  }
  if (sections.has('performance')) {
    const np = websites.filter((w) => !performance.find((p2) => p2.website_id === w.id && p2.status === 'ok'));
    if (np.length) missing.push(`No successful performance audit for ${np.length} website(s).`);
  }

  const recommendations: string[] = [];
  for (const w of websites.filter((w) => w.effective_state === 'down')) recommendations.push(`${w.name} is currently DOWN – investigate immediately.`);
  for (const w of websites.filter((w) => w.uptime_pct !== null && w.uptime_pct < 99).slice(0, 10)) recommendations.push(`${w.name}: uptime ${w.uptime_pct}% is below 99% (${w.outages} outage(s), ${Math.round(w.downtime_seconds / 60)} min downtime).`);
  for (const s of sslSorted.filter((s) => !s.valid)) recommendations.push(`SSL certificate for ${s.website_name} is invalid/expired${s.error ? ` (${s.error})` : ''} – renew now.`);
  for (const s of sslSorted.filter((s) => s.valid && s.days_remaining <= 30)) recommendations.push(`SSL certificate for ${s.website_name} expires in ${s.days_remaining} day(s) – schedule renewal.`);
  for (const p2 of performance.filter((p2) => p2.status === 'ok' && p2.performance_score !== null && p2.performance_score < 50)) recommendations.push(`${p2.website_name}: mobile performance score ${p2.performance_score}/100 is poor – review LCP (${p2.lcp_ms ?? 'n/a'} ms) and render-blocking resources.`);
  for (const f of forms.filter((f) => f.failures > 0)) recommendations.push(`${f.website_name}: ${f.type} page "${f.label}" failed ${f.failures} of ${f.checks} check(s).`);
  if (summary.tasks_overdue) recommendations.push(`${summary.tasks_overdue} task(s) are overdue.`);
  if (summary.unknown) recommendations.push(`${summary.unknown} website(s) have unknown status (never checked or stale). Verify the monitoring worker is running.`);
  if (!recommendations.length) recommendations.push('No issues detected in the stored data for this period.');

  const inventory = p.type === 'custom' || p.type === 'monthly' || p.type === 'website' || p.type === 'weekly' || p.type === 'daily' ? websites : [];
  await onProgress(90);
  return {
    type: p.type, title: TITLES[p.type], generatedAt: new Date(), timezone: tz, period: { from, to },
    scope: { websiteId: p.websiteId, websiteName: p.websiteId ? websites[0]?.name : undefined, websiteCount: websites.length },
    sections, summary, websites, incidents, ssl: sslSorted, analytics, seo, performance, forms, tasks, integrations, missing, recommendations, inventory,
  };
}

export async function reportExists(id: string) { return one('SELECT 1 FROM report_jobs WHERE id=$1', [id]); }
