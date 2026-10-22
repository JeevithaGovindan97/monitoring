import { query, type Queryable, getPool } from '../db.js';

/** Recompute hourly buckets for [from, to). Idempotent (upsert), so late-arriving checks are safe. */
export async function aggregateHourly(from: Date, to: Date, q: Queryable = getPool()) {
  const r = await query(
    `INSERT INTO uptime_hourly (website_id, bucket, total, successful, failed, maintenance, avg_ms, p95_ms, min_ms, max_ms)
     SELECT website_id, date_trunc('hour', started_at),
            count(*) FILTER (WHERE NOT in_maintenance)::int,
            count(*) FILTER (WHERE success AND NOT in_maintenance)::int,
            count(*) FILTER (WHERE NOT success AND NOT in_maintenance)::int,
            count(*) FILTER (WHERE in_maintenance)::int,
            round(avg(response_ms) FILTER (WHERE success AND NOT in_maintenance))::int,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms) FILTER (WHERE success AND NOT in_maintenance))::int,
            min(response_ms) FILTER (WHERE success AND NOT in_maintenance),
            max(response_ms) FILTER (WHERE success AND NOT in_maintenance)
       FROM website_checks
      WHERE kind = 'http' AND started_at >= date_trunc('hour', $1::timestamptz) AND started_at < $2
      GROUP BY 1, 2
     ON CONFLICT (website_id, bucket) DO UPDATE SET total=EXCLUDED.total, successful=EXCLUDED.successful,
       failed=EXCLUDED.failed, maintenance=EXCLUDED.maintenance, avg_ms=EXCLUDED.avg_ms, p95_ms=EXCLUDED.p95_ms,
       min_ms=EXCLUDED.min_ms, max_ms=EXCLUDED.max_ms
     RETURNING 1`,
    [from, to],
    q,
  );
  return r.length;
}

export async function aggregateDaily(from: Date, to: Date, q: Queryable = getPool()) {
  const r = await query(
    `INSERT INTO uptime_daily (website_id, bucket, total, successful, failed, maintenance, avg_ms, p95_ms, min_ms, max_ms)
     SELECT website_id, (started_at AT TIME ZONE 'UTC')::date,
            count(*) FILTER (WHERE NOT in_maintenance)::int,
            count(*) FILTER (WHERE success AND NOT in_maintenance)::int,
            count(*) FILTER (WHERE NOT success AND NOT in_maintenance)::int,
            count(*) FILTER (WHERE in_maintenance)::int,
            round(avg(response_ms) FILTER (WHERE success AND NOT in_maintenance))::int,
            round(percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms) FILTER (WHERE success AND NOT in_maintenance))::int,
            min(response_ms) FILTER (WHERE success AND NOT in_maintenance),
            max(response_ms) FILTER (WHERE success AND NOT in_maintenance)
       FROM website_checks
      WHERE kind = 'http' AND started_at >= ((($1::timestamptz) AT TIME ZONE 'UTC')::date)::timestamptz AND started_at < $2
      GROUP BY 1, 2
     ON CONFLICT (website_id, bucket) DO UPDATE SET total=EXCLUDED.total, successful=EXCLUDED.successful,
       failed=EXCLUDED.failed, maintenance=EXCLUDED.maintenance, avg_ms=EXCLUDED.avg_ms, p95_ms=EXCLUDED.p95_ms,
       min_ms=EXCLUDED.min_ms, max_ms=EXCLUDED.max_ms
     RETURNING 1`,
    [from, to],
    q,
  );
  return r.length;
}

/** Called by the worker every few minutes: refresh the last 3 hours and the last 2 UTC days. */
export async function runAggregation(now = new Date()) {
  const end = new Date(now.getTime() + 1000);
  const h = await aggregateHourly(new Date(now.getTime() - 3 * 3600_000), end);
  const d = await aggregateDaily(new Date(now.getTime() - 2 * 86400_000), end);
  return { hourly: h, daily: d };
}
