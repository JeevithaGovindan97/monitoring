import os from 'node:os';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query, one } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { performCheck, type CheckResult } from './http-check.js';
import { processFormResult, processWebsiteResult, openIncident, resolveIncidentAuto } from './process.js';
import { checkCertificate, sslAlertLevel } from './ssl.js';
import { notifyAdmins, notifyIncident } from './notify.js';
import { tx } from '../db.js';

/** Test seams (replaced in tests to simulate certificate results and internal failures). */
export const hooks = { check: performCheck, process: processWebsiteResult, certificate: checkCertificate };

export const WORKER_ID = `${os.hostname()}-${process.pid}`;

/** Claim due websites atomically. FOR UPDATE SKIP LOCKED + lock_until lease ⇒ no duplicate/overlapping checks, even with several workers. */
export async function claimDueWebsites(limit: number, owner = WORKER_ID) {
  return query<any>(
    `UPDATE websites w SET lock_until = now() + make_interval(secs => (w.timeout_ms / 1000.0) * (w.max_redirects + 1) + 30), lock_owner = $2
      WHERE w.id IN (
        SELECT id FROM websites
         WHERE monitoring_status = 'active' AND next_check_at <= now() AND (lock_until IS NULL OR lock_until < now())
         ORDER BY next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING w.id, w.url, w.health_check_url, w.timeout_ms, w.max_redirects, w.expected_status, w.ssl_failure_is_outage, w.internal_error_count, w.check_interval_seconds`,
    [limit, owner],
  );
}

export async function claimDueForms(limit: number) {
  return query<any>(
    `UPDATE form_checks f SET lock_until = now() + make_interval(secs => f.timeout_ms / 1000.0 + 30)
      WHERE f.id IN (
        SELECT f2.id FROM form_checks f2 JOIN websites w ON w.id = f2.website_id
         WHERE f2.enabled AND w.monitoring_status = 'active' AND f2.next_check_at <= now() AND (f2.lock_until IS NULL OR f2.lock_until < now())
         ORDER BY f2.next_check_at LIMIT $1 FOR UPDATE OF f2 SKIP LOCKED)
      RETURNING f.id, f.url, f.timeout_ms, f.expected_status, f.interval_seconds`,
    [limit],
  );
}

/** Internal (monitor-side) failures back off exponentially instead of hammering the DB or the target. */
async function handleInternalError(websiteId: string, count: number, err: unknown) {
  const delay = Math.min(300, 15 * 2 ** Math.min(count, 5));
  logger.error({ err, websiteId }, 'internal error while processing a check; backing off');
  await query(
    `UPDATE websites SET lock_until=NULL, lock_owner=NULL, internal_error_count = internal_error_count + 1, next_check_at = now() + make_interval(secs => $2) WHERE id=$1`,
    [websiteId, delay],
  ).catch(() => undefined);
}

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runDueChecks(opts: { concurrency?: number; limit?: number } = {}) {
  const c = config();
  const conc = opts.concurrency ?? c.CHECK_CONCURRENCY;
  const due = await claimDueWebsites(opts.limit ?? conc * 4);
  await mapLimit(due, conc, async (w) => {
    let result: CheckResult;
    try {
      result = await hooks.check({
        url: w.health_check_url || w.url, timeoutMs: w.timeout_ms, maxRedirects: w.max_redirects, expectedStatus: w.expected_status,
        verifyTls: w.ssl_failure_is_outage, allowPrivate: c.ALLOW_PRIVATE_TARGETS,
      });
    } catch (err) {
      return handleInternalError(w.id, w.internal_error_count, err);
    }
    try {
      await hooks.process(w.id, result);
    } catch (err) {
      await handleInternalError(w.id, w.internal_error_count, err);
    }
  });
  return due.length;
}

export async function runDueFormChecks(opts: { concurrency?: number } = {}) {
  const c = config();
  const due = await claimDueForms(20);
  await mapLimit(due, opts.concurrency ?? 5, async (f) => {
    try {
      const result = await hooks.check({ url: f.url, timeoutMs: f.timeout_ms, maxRedirects: 5, expectedStatus: f.expected_status, allowPrivate: c.ALLOW_PRIVATE_TARGETS });
      await processFormResult(f.id, result);
    } catch (err) {
      logger.error({ err, form: f.id }, 'form check failed internally');
      await query('UPDATE form_checks SET lock_until=NULL, next_check_at = now() + interval \'1 minute\' WHERE id=$1', [f.id]).catch(() => undefined);
    }
  });
  return due.length;
}

// ------------------------------------------------------------------ SSL

export async function runDueSslChecks(limit = 10) {
  const c = config();
  const due = await query<any>(
    `UPDATE websites SET ssl_lock_until = now() + interval '2 minutes'
      WHERE id IN (SELECT id FROM websites WHERE monitoring_status='active' AND ssl_check_enabled AND url ILIKE 'https:%'
                      AND ssl_next_check_at <= now() AND (ssl_lock_until IS NULL OR ssl_lock_until < now())
                    ORDER BY ssl_next_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, name, url, criticality, alert_preferences, ssl_last_alert_level, ssl_failure_is_outage`,
    [limit],
  );
  const thresholds = await getSetting<number[]>('ssl_alert_days', [30, 14, 7]);
  for (const w of due) {
    try {
      const r = await hooks.certificate(w.url, { allowPrivate: c.ALLOW_PRIVATE_TARGETS });
      await tx(async (cl) => {
        await query(
          `INSERT INTO ssl_checks (website_id, checked_at, valid, subject, issuer, valid_from, valid_to, days_remaining, protocol, error) VALUES ($1,now(),$2,$3,$4,$5,$6,$7,$8,$9)`,
          [w.id, r.valid, r.subject, r.issuer, r.validFrom, r.validTo, r.daysRemaining, r.protocol, r.error], cl);
        const level = sslAlertLevel(r, thresholds);
        const wsite = { id: w.id, name: w.name, url: w.url, alert_preferences: w.alert_preferences };
        if (level === 0) {
          // expired / invalid ⇒ incident (high, or the site's criticality if the site opted to treat SSL as outage)
          const { incident, created } = await openIncident(cl, {
            websiteId: w.id, kind: 'ssl', dedupeKey: 'ssl', severity: w.ssl_failure_is_outage ? w.criticality : 'high',
            title: `SSL certificate problem on ${w.name}`, summary: r.error ?? 'Certificate expired', startedAt: new Date(), lastFailureAt: new Date(),
          });
          if (created) await notifyIncident({ incident, website: wsite, event: 'ssl', detail: r.error ?? 'Certificate expired' }, cl);
        } else {
          const inc = await resolveIncidentAuto(cl, w.id, 'ssl', new Date(), 'Certificate is valid again');
          if (inc) await notifyIncident({ incident: inc, website: wsite, event: 'recovered' }, cl);
          if (level !== null && (w.ssl_last_alert_level === null || level < w.ssl_last_alert_level)) {
            await notifyAdmins(cl, {
              type: 'ssl_expiring', severity: level <= 7 ? 'critical' : 'warning',
              title: `SSL certificate for ${w.name} expires in ${r.daysRemaining} day(s)`,
              body: `Valid until ${r.validTo?.toISOString()}. Issuer: ${r.issuer ?? 'unknown'}`, link: `/websites/${w.id}?tab=ssl`,
              dedupeKey: `ssl:${w.id}:${level}:${r.validTo?.toISOString().slice(0, 10)}`, email: true, websiteId: w.id,
            });
          }
        }
        await query(
          `UPDATE websites SET ssl_next_check_at = now() + interval '6 hours', ssl_lock_until=NULL, ssl_last_alert_level = $2 WHERE id=$1`,
          [w.id, level === 0 ? 0 : level], cl);
      });
    } catch (err) {
      logger.error({ err, website: w.id }, 'ssl check failed internally');
      await query("UPDATE websites SET ssl_lock_until=NULL, ssl_next_check_at = now() + interval '15 minutes' WHERE id=$1", [w.id]).catch(() => undefined);
    }
  }
  return due.length;
}

export async function workerHealth() {
  const r = await one("SELECT max(last_beat_at) AS last FROM worker_heartbeats WHERE role IN ('monitor','all')");
  const last: Date | null = r?.last ?? null;
  return { lastHeartbeat: last, alive: last !== null && Date.now() - new Date(last).getTime() < 120_000 };
}
