import { query, type Queryable, getPool } from '../db.js';

/**
 * Uptime calculation method (also documented in docs/UPTIME.md):
 *
 *   uptime % = successful checks / (successful + failed checks) over the period
 *
 *  - Only scheduled HTTP observations stored by the monitoring worker are counted.
 *  - Checks taken during a maintenance window are excluded from both numerator and denominator.
 *  - Disabled/archived periods produce no observations and therefore do not count.
 *  - A period with zero valid observations has uptime = null ("no data"); it is never reported as 100 %.
 *  - Ranges up to 14 days use hourly summaries, longer ranges use UTC daily summaries (range is snapped to whole buckets).
 *  - "coverage" = observations / expected observations (period / interval): it shows when the worker was not running.
 */
export interface UptimeRow {
  website_id: string;
  total: number;
  successful: number;
  failed: number;
  maintenance: number;
  uptime_pct: number | null;
  avg_ms: number | null;
}

export function pct(successful: number, total: number): number | null {
  if (!total) return null;
  return Math.round((successful / total) * 100_000) / 1000; // 3 decimals
}

export function pickGranularity(from: Date, to: Date): 'hourly' | 'daily' {
  return to.getTime() - from.getTime() <= 14 * 86400_000 ? 'hourly' : 'daily';
}

export async function uptimeByWebsite(from: Date, to: Date, websiteIds?: string[], q: Queryable = getPool()): Promise<UptimeRow[]> {
  const g = pickGranularity(from, to);
  const table = g === 'hourly' ? 'uptime_hourly' : 'uptime_daily';
  const rows = await query<any>(
    `SELECT website_id, sum(total)::int AS total, sum(successful)::int AS successful, sum(failed)::int AS failed,
            sum(maintenance)::int AS maintenance,
            CASE WHEN sum(total) FILTER (WHERE avg_ms IS NOT NULL) > 0
                 THEN round(sum(avg_ms::numeric * total) FILTER (WHERE avg_ms IS NOT NULL) / sum(total) FILTER (WHERE avg_ms IS NOT NULL))::int END AS avg_ms
       FROM ${table}
      WHERE bucket >= ${g === 'hourly' ? '$1::timestamptz' : "($1::timestamptz AT TIME ZONE 'UTC')::date"}
        AND bucket < ${g === 'hourly' ? '$2::timestamptz' : "($2::timestamptz AT TIME ZONE 'UTC')::date + 1"}
        ${websiteIds ? 'AND website_id = ANY($3)' : ''}
      GROUP BY website_id`,
    websiteIds ? [from, to, websiteIds] : [from, to],
    q,
  );
  return rows.map((r) => ({ ...r, uptime_pct: pct(r.successful, r.total) }));
}

export interface Percentiles { p50: number | null; p95: number | null; p99: number | null; avg: number | null }

/** Response-time percentiles of successful raw observations (raw data is retained for `retention_checks_days`). */
export async function responsePercentiles(from: Date, to: Date, websiteIds?: string[], q: Queryable = getPool()): Promise<Percentiles> {
  const r = await query<any>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY response_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY response_ms) AS p99,
            avg(response_ms) AS avg
       FROM website_checks
      WHERE kind = 'http' AND success AND NOT in_maintenance AND started_at >= $1 AND started_at < $2
        ${websiteIds ? 'AND website_id = ANY($3)' : ''}`,
    websiteIds ? [from, to, websiteIds] : [from, to],
    q,
  );
  const x = r[0] ?? {};
  const rd = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return { p50: rd(x.p50), p95: rd(x.p95), p99: rd(x.p99), avg: rd(x.avg) };
}

export async function seriesForWebsite(websiteId: string, from: Date, to: Date) {
  const g = pickGranularity(from, to);
  const table = g === 'hourly' ? 'uptime_hourly' : 'uptime_daily';
  const rows = await query<any>(
    `SELECT bucket, total, successful, failed, maintenance, avg_ms, p95_ms, min_ms, max_ms FROM ${table}
      WHERE website_id = $1
        AND bucket >= ${g === 'hourly' ? '$2::timestamptz' : "($2::timestamptz AT TIME ZONE 'UTC')::date"}
        AND bucket < ${g === 'hourly' ? '$3::timestamptz' : "($3::timestamptz AT TIME ZONE 'UTC')::date + 1"}
      ORDER BY bucket`,
    [websiteId, from, to],
  );
  return {
    granularity: g,
    points: rows.map((r) => ({ ...r, uptime_pct: pct(r.successful, r.total) })),
  };
}
