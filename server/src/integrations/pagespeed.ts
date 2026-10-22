import { config } from '../config.js';
import { logger } from '../logger.js';
import { query, one } from '../db.js';
import { SsrfError, validateMonitorUrl } from '../security/ssrf.js';
import { GoogleError, googleJson } from './google.js';

export interface AuditResult {
  performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null;
  lcpMs: number | null; cls: number | null; inpMs: number | null; fcpMs: number | null; ttfbMs: number | null; tbtMs: number | null;
  fieldData: unknown | null; labData: Record<string, unknown>; raw: Record<string, unknown>;
}

const score = (c: any) => (typeof c?.score === 'number' ? Math.round(c.score * 100) : null);
const num = (a: any) => (typeof a?.numericValue === 'number' ? a.numericValue : null);

/** Normalise a PageSpeed Insights v5 response. Field data is only reported when Google actually returns it. */
export function parsePageSpeed(j: any): AuditResult {
  const lh = j?.lighthouseResult;
  if (!lh) throw new Error('Response contained no Lighthouse result');
  const cat = lh.categories ?? {};
  const a = lh.audits ?? {};
  const fm = j.loadingExperience?.metrics;
  const hasField = fm && Object.keys(fm).length > 0;
  const fieldData = hasField
    ? {
        overall_category: j.loadingExperience.overall_category ?? null,
        metrics: Object.fromEntries(Object.entries(fm).map(([k, v]: [string, any]) => [k, { percentile: v.percentile, category: v.category }])),
      }
    : null;
  const fieldInp = fm?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null;
  const labData = {
    lcp_ms: num(a['largest-contentful-paint']), cls: num(a['cumulative-layout-shift']), fcp_ms: num(a['first-contentful-paint']),
    tbt_ms: num(a['total-blocking-time']), speed_index_ms: num(a['speed-index']), ttfb_ms: num(a['server-response-time']),
    inp_ms: num(a['interaction-to-next-paint']),
  };
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    performance: score(cat.performance), accessibility: score(cat.accessibility), bestPractices: score(cat['best-practices']), seo: score(cat.seo),
    lcpMs: r(labData.lcp_ms), cls: labData.cls === null ? null : Math.round(labData.cls * 10000) / 10000,
    inpMs: fieldInp ?? r(labData.inp_ms), fcpMs: r(labData.fcp_ms), ttfbMs: r(labData.ttfb_ms), tbtMs: r(labData.tbt_ms),
    fieldData, labData,
    raw: { fetchTime: lh.fetchTime, lighthouseVersion: lh.lighthouseVersion, finalUrl: lh.finalUrl, requestedUrl: lh.requestedUrl, runWarnings: lh.runWarnings ?? [], source: 'pagespeed-insights-v5' },
  };
}

export async function runPageSpeed(url: string, strategy: 'mobile' | 'desktop'): Promise<AuditResult> {
  validateMonitorUrl(url, { allowPrivate: false }); // Google cannot reach private URLs anyway
  const params = new URLSearchParams({ url, strategy });
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) params.append('category', c);
  const j = await googleJson(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { scopes: [], key: config().PAGESPEED_API_KEY ?? '', retries: 3 });
  return parsePageSpeed(j);
}

async function strategies(): Promise<Array<'mobile' | 'desktop'>> {
  const r = await one("SELECT config FROM integrations WHERE kind='pagespeed'");
  const s = r?.config?.strategies;
  return Array.isArray(s) && s.length ? s.filter((x: string) => x === 'mobile' || x === 'desktop') : ['mobile'];
}

/** Audit websites that are due (low frequency, separate from uptime checks). */
export async function runDueAudits(limit = 2) {
  const due = await query<any>(
    `UPDATE websites SET perf_lock_until = now() + interval '10 minutes'
      WHERE id IN (SELECT id FROM websites WHERE monitoring_status='active' AND performance_audit_enabled AND perf_next_audit_at <= now()
                      AND (perf_lock_until IS NULL OR perf_lock_until < now()) ORDER BY perf_next_audit_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, url, performance_interval_hours`, [limit]);
  const strats = await strategies();
  for (const w of due) {
    let anyError = false;
    for (const strategy of strats) {
      try {
        const r = await runPageSpeed(w.url, strategy);
        await query(
          `INSERT INTO performance_audits (website_id,strategy,audited_at,status,performance_score,accessibility_score,best_practices_score,seo_score,lcp_ms,cls,inp_ms,fcp_ms,ttfb_ms,tbt_ms,field_data,lab_data,raw_summary,is_baseline)
           VALUES ($1,$2,now(),'ok',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   NOT EXISTS (SELECT 1 FROM performance_audits WHERE website_id=$1 AND strategy=$2 AND is_baseline))`,
          [w.id, strategy, r.performance, r.accessibility, r.bestPractices, r.seo, r.lcpMs, r.cls, r.inpMs, r.fcpMs, r.ttfbMs, r.tbtMs,
            r.fieldData ? JSON.stringify(r.fieldData) : null, JSON.stringify(r.labData), JSON.stringify(r.raw)]);
        await query("UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL, updated_at=now() WHERE kind='pagespeed'");
      } catch (e) {
        anyError = true;
        const msg = e instanceof SsrfError ? e.message : (e as Error).message;
        logger.warn({ website: w.id, strategy }, `PageSpeed audit failed: ${msg}`);
        await query(`INSERT INTO performance_audits (website_id,strategy,audited_at,status,error) VALUES ($1,$2,now(),'error',$3)`, [w.id, strategy, msg.slice(0, 500)]);
        await query("UPDATE integrations SET status='error', last_error=$1, last_error_at=now(), updated_at=now() WHERE kind='pagespeed'", [msg.slice(0, 300)]);
        if (e instanceof GoogleError && e.kind === 'quota') break;
      }
    }
    // success: wait the configured interval; failure: retry in 2 hours
    await query("UPDATE websites SET perf_lock_until=NULL, perf_next_audit_at = now() + make_interval(hours => $2) WHERE id=$1", [w.id, anyError ? 2 : w.performance_interval_hours]);
  }
  return due.length;
}
