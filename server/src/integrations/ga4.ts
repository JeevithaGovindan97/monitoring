import { query } from '../db.js';
import { logger } from '../logger.js';
import { GoogleError, deps, googleJson, loadServiceAccount } from './google.js';

const SCOPE = ['https://www.googleapis.com/auth/analytics.readonly'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface Ga4Row { date: string; active_users: number; sessions: number; page_views: number; engagement_rate: number; conversions: number }

export async function fetchGa4Daily(propertyId: string, start: string, end: string): Promise<Ga4Row[]> {
  const rows: Ga4Row[] = [];
  let offset = 0;
  const limit = 10000;
  for (;;) {
    const r: any = await googleJson(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      scopes: SCOPE,
      body: {
        dateRanges: [{ startDate: start, endDate: end }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'engagementRate' }, { name: 'keyEvents' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit, offset,
      },
    });
    for (const row of r.rows ?? []) {
      const d: string = row.dimensionValues[0].value; // YYYYMMDD
      const m = row.metricValues.map((x: any) => Number(x.value));
      rows.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, active_users: m[0], sessions: m[1], page_views: m[2], engagement_rate: m[3], conversions: m[4] });
    }
    offset += limit;
    if (!r.rowCount || offset >= r.rowCount) break;
  }
  return rows;
}

export async function testGa4(propertyId: string) {
  const y = ymd(new Date(Date.now() - 86400_000));
  try {
    await fetchGa4Daily(propertyId, y, y);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, kind: e instanceof GoogleError ? e.kind : 'error', message: (e as Error).message };
  }
}

/** Sync the last `days` complete days for every website that has a GA4 property. Missing access is recorded, never faked as zeros. */
export async function syncGa4(days = 7) {
  const sites = await query<any>("SELECT id, name, ga4_property_id FROM websites WHERE ga4_property_id IS NOT NULL AND monitoring_status <> 'archived' AND ga4_status <> 'not_applicable'");
  const out = { total: sites.length, ok: 0, access_required: 0, error: 0 };
  if (!sites.length) return out;
  if (!loadServiceAccount()) {
    await query("UPDATE integrations SET status='not_connected', last_error='Google service-account credentials are not configured', last_error_at=now(), updated_at=now() WHERE kind='ga4'");
    return { ...out, error: sites.length };
  }
  const end = ymd(new Date(Date.now() - 86400_000));
  const start = ymd(new Date(Date.now() - days * 86400_000));
  for (const s of sites) {
    try {
      const rows = await fetchGa4Daily(s.ga4_property_id, start, end);
      for (const r of rows) {
        await query(
          `INSERT INTO analytics_daily (website_id,date,active_users,sessions,page_views,engagement_rate,conversions,synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
           ON CONFLICT (website_id,date) DO UPDATE SET active_users=EXCLUDED.active_users, sessions=EXCLUDED.sessions, page_views=EXCLUDED.page_views, engagement_rate=EXCLUDED.engagement_rate, conversions=EXCLUDED.conversions, synced_at=now()`,
          [s.id, r.date, r.active_users, r.sessions, r.page_views, r.engagement_rate, r.conversions]);
      }
      await query("UPDATE websites SET ga4_status='connected', ga4_status_detail=NULL WHERE id=$1", [s.id]);
      out.ok++;
    } catch (e) {
      const kind = e instanceof GoogleError ? e.kind : 'error';
      const accessProblem = kind === 'access_denied' || kind === 'not_found';
      await query('UPDATE websites SET ga4_status=$2, ga4_status_detail=$3 WHERE id=$1', [s.id, accessProblem ? 'access_required' : 'error', (e as Error).message.slice(0, 300)]);
      if (accessProblem) out.access_required++;
      else out.error++;
      logger.warn({ website: s.id, kind }, `GA4 sync failed: ${(e as Error).message}`);
      if (kind === 'quota') break; // stop hammering an exhausted quota
    }
    await deps.sleep(200); // gentle pacing
  }
  const failed = out.error > 0 && out.ok === 0;
  if (out.ok > 0) await query("UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL, updated_at=now() WHERE kind='ga4'");
  else if (failed) await query("UPDATE integrations SET status='error', last_error='All GA4 syncs failed – see website statuses', last_error_at=now(), updated_at=now() WHERE kind='ga4'");
  return out;
}
