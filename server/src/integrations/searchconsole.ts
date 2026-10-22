import { query } from '../db.js';
import { logger } from '../logger.js';
import { GoogleError, deps, googleJson, loadServiceAccount } from './google.js';

const SCOPE = ['https://www.googleapis.com/auth/webmasters.readonly'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const base = (site: string) => `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;

interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

async function queryAll(site: string, body: Record<string, unknown>, maxRows = 25000): Promise<GscRow[]> {
  const rows: GscRow[] = [];
  let startRow = 0;
  const pageSize = Math.min(25000, maxRows);
  for (;;) {
    const r: any = await googleJson(base(site), { scopes: SCOPE, body: { ...body, rowLimit: pageSize, startRow } });
    const got: GscRow[] = r.rows ?? [];
    rows.push(...got);
    if (got.length < pageSize || rows.length >= maxRows) break;
    startRow += pageSize;
  }
  return rows;
}

export async function listAccessibleSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const r: any = await googleJson('https://www.googleapis.com/webmasters/v3/sites', { scopes: SCOPE });
  return r.siteEntry ?? [];
}

export async function testSearchConsole(property?: string) {
  try {
    const sites = await listAccessibleSites();
    if (property) {
      const hit = sites.find((s) => s.siteUrl === property && s.permissionLevel !== 'siteUnverifiedUser');
      return hit ? { ok: true as const, sites: sites.length } : { ok: false as const, kind: 'access_denied', message: `The service account has no access to "${property}"`, sites: sites.length };
    }
    return { ok: true as const, sites: sites.length };
  } catch (e) {
    return { ok: false as const, kind: e instanceof GoogleError ? e.kind : 'error', message: (e as Error).message };
  }
}

export async function syncSearchConsole(days = 10) {
  const sites = await query<any>("SELECT id, name, gsc_property_url FROM websites WHERE gsc_property_url IS NOT NULL AND monitoring_status <> 'archived' AND gsc_status <> 'not_applicable'");
  const out = { total: sites.length, ok: 0, access_required: 0, error: 0 };
  if (!sites.length) return out;
  if (!loadServiceAccount()) {
    await query("UPDATE integrations SET status='not_connected', last_error='Google service-account credentials are not configured', last_error_at=now(), updated_at=now() WHERE kind='search_console'");
    return { ...out, error: sites.length };
  }
  // Search Console data is final ~2-3 days late: re-pull a rolling window and upsert.
  const end = ymd(new Date(Date.now() - 2 * 86400_000));
  const start = ymd(new Date(Date.now() - (days + 2) * 86400_000));
  for (const s of sites) {
    try {
      const daily = await queryAll(s.gsc_property_url, { startDate: start, endDate: end, dimensions: ['date'] });
      for (const r of daily) {
        await query(
          `INSERT INTO search_console_daily (website_id,date,clicks,impressions,ctr,position,synced_at) VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (website_id,date) DO UPDATE SET clicks=EXCLUDED.clicks, impressions=EXCLUDED.impressions, ctr=EXCLUDED.ctr, position=EXCLUDED.position, synced_at=now()`,
          [s.id, r.keys[0], Math.round(r.clicks), Math.round(r.impressions), r.ctr, r.position]);
      }
      const topStart = ymd(new Date(Date.now() - 30 * 86400_000));
      for (const dim of ['query', 'page'] as const) {
        const top = await queryAll(s.gsc_property_url, { startDate: topStart, endDate: end, dimensions: [dim] }, 50);
        await query('DELETE FROM search_console_top WHERE website_id=$1 AND dimension=$2', [s.id, dim]);
        for (const r of top.slice(0, 50)) {
          await query(
            `INSERT INTO search_console_top (website_id,period_start,period_end,dimension,key,clicks,impressions,ctr,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [s.id, topStart, end, dim, r.keys[0], Math.round(r.clicks), Math.round(r.impressions), r.ctr, r.position]);
        }
      }
      await query("UPDATE websites SET gsc_status='connected', gsc_status_detail=NULL WHERE id=$1", [s.id]);
      out.ok++;
    } catch (e) {
      const kind = e instanceof GoogleError ? e.kind : 'error';
      const accessProblem = kind === 'access_denied' || kind === 'not_found';
      await query('UPDATE websites SET gsc_status=$2, gsc_status_detail=$3 WHERE id=$1', [s.id, accessProblem ? 'access_required' : 'error', (e as Error).message.slice(0, 300)]);
      if (accessProblem) out.access_required++;
      else out.error++;
      logger.warn({ website: s.id, kind }, `Search Console sync failed: ${(e as Error).message}`);
      if (kind === 'quota') break;
    }
    await deps.sleep(200);
  }
  if (out.ok > 0) await query("UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL, updated_at=now() WHERE kind='search_console'");
  else if (out.error > 0) await query("UPDATE integrations SET status='error', last_error='All Search Console syncs failed – see website statuses', last_error_at=now(), updated_at=now() WHERE kind='search_console'");
  return out;
}
