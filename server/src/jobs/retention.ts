import { query } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { purgeExpiredReports } from '../reports/runner.js';

/** Data retention. Aggregates (hourly/daily) outlive raw checks so long-range reports keep working. */
export async function runRetention() {
  const days = {
    checks: await getSetting<number>('retention_checks_days', 90),
    hourly: await getSetting<number>('retention_hourly_days', 400),
    audit: await getSetting<number>('retention_audit_days', 365),
    notifications: await getSetting<number>('retention_notifications_days', 180),
  };
  const del = async (sql: string, params: unknown[]) => (await query(sql + ' RETURNING 1', params)).length;
  const out = {
    checks: await del("DELETE FROM website_checks WHERE started_at < now() - make_interval(days => $1)", [days.checks]),
    hourly: await del('DELETE FROM uptime_hourly WHERE bucket < now() - make_interval(days => $1)', [days.hourly]),
    ssl_checks: await del('DELETE FROM ssl_checks WHERE checked_at < now() - make_interval(days => $1)', [days.checks * 4]),
    audits: await del("DELETE FROM performance_audits WHERE audited_at < now() - make_interval(days => $1) AND NOT is_baseline", [days.hourly]),
    audit_logs: await del('DELETE FROM audit_logs WHERE at < now() - make_interval(days => $1)', [days.audit]),
    notifications: await del('DELETE FROM notifications WHERE created_at < now() - make_interval(days => $1) AND read_at IS NOT NULL', [days.notifications]),
    deliveries: await del("DELETE FROM notification_deliveries WHERE created_at < now() - make_interval(days => $1) AND status <> 'pending'", [days.notifications]),
    sessions: await del("DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'", []),
    job_runs: await del("DELETE FROM scheduled_job_runs WHERE started_at < now() - interval '60 days'", []),
    reports: await purgeExpiredReports(),
  };
  return out;
}
