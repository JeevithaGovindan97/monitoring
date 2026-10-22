import type pg from 'pg';
import { one, query, tx } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { notifyIncident } from './notify.js';
import { step, type SiteState } from './state.js';
import type { CheckResult } from './http-check.js';

async function inMaintenance(c: pg.PoolClient, websiteId: string, at: Date) {
  const r = await one(
    'SELECT 1 FROM maintenance_windows WHERE (website_id = $1 OR website_id IS NULL) AND starts_at <= $2 AND ends_at > $2 LIMIT 1',
    [websiteId, at],
    c,
  );
  return Boolean(r);
}

async function addEvent(c: pg.PoolClient, incidentId: string, type: string, message: string | null, data: object = {}, actor: string | null = null) {
  await query('INSERT INTO incident_events (incident_id, type, message, data, actor_user_id) VALUES ($1,$2,$3,$4,$5)', [incidentId, type, message, JSON.stringify(data), actor], c);
}

/** Open (or attach to the existing) incident for a dedupe key. Returns the incident and whether it is new. */
export async function openIncident(
  c: pg.PoolClient,
  p: { websiteId: string; kind: 'outage' | 'ssl' | 'form'; dedupeKey: string; severity: string; title: string; summary?: string; startedAt: Date; lastFailureAt?: Date | null },
) {
  const existing = await one("SELECT * FROM incidents WHERE website_id=$1 AND dedupe_key=$2 AND status <> 'resolved' FOR UPDATE", [p.websiteId, p.dedupeKey], c);
  if (existing) {
    await query('UPDATE incidents SET last_failure_at = COALESCE($2, last_failure_at), updated_at = now() WHERE id=$1', [existing.id, p.lastFailureAt ?? null], c);
    return { incident: existing, created: false };
  }
  const inc = await one(
    `INSERT INTO incidents (website_id, kind, dedupe_key, severity, title, summary, started_at, last_failure_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [p.websiteId, p.kind, p.dedupeKey, p.severity, p.title, p.summary ?? null, p.startedAt, p.lastFailureAt ?? p.startedAt],
    c,
  );
  await addEvent(c, inc.id, 'opened', p.title, { kind: p.kind, detected_at: new Date().toISOString() });
  return { incident: inc, created: true };
}

export async function resolveIncidentAuto(c: pg.PoolClient, websiteId: string, dedupeKey: string, resolvedAt: Date, message: string) {
  const inc = await one("SELECT * FROM incidents WHERE website_id=$1 AND dedupe_key=$2 AND status <> 'resolved' FOR UPDATE", [websiteId, dedupeKey], c);
  if (!inc) return null;
  const duration = Math.max(0, Math.round((resolvedAt.getTime() - new Date(inc.started_at).getTime()) / 1000));
  const row = await one(
    `UPDATE incidents SET status='resolved', resolved_at=$2, duration_seconds=$3, auto_resolved=true, updated_at=now() WHERE id=$1 RETURNING *`,
    [inc.id, resolvedAt, duration],
    c,
  );
  await addEvent(c, inc.id, 'resolved', message, { auto: true, duration_seconds: duration });
  return row;
}

export interface ProcessOutcome {
  checkId: number;
  state: SiteState;
  event: 'outage_opened' | 'recovered' | null;
  inMaintenance: boolean;
  incidentId?: string;
}

/** Persist a website check result and advance the state machine, incidents and notifications — atomically. */
export async function processWebsiteResult(websiteId: string, r: CheckResult): Promise<ProcessOutcome> {
  const defaultSlow = await getSetting<number>('degraded_threshold_ms', 3000);
  return tx(async (c) => {
    const w = await one('SELECT * FROM websites WHERE id=$1 FOR UPDATE', [websiteId], c);
    if (!w) throw new Error('website vanished');
    const maint = await inMaintenance(c, websiteId, r.startedAt);
    const chk = await one(
      `INSERT INTO website_checks (website_id, kind, started_at, finished_at, success, status_code, response_ms, error_category, error_message, redirect_count, final_url, in_maintenance)
       VALUES ($1,'http',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [websiteId, r.startedAt, r.finishedAt, r.success, r.statusCode, r.responseMs, r.errorCategory, r.errorMessage, r.redirectCount, r.finalUrl, maint],
      c,
    );
    const nextCheck = `now() + make_interval(secs => ${Number(w.check_interval_seconds)} + (random()*10)::int)`;
    if (maint) {
      // During maintenance we keep recording but do not move counters, state or incidents.
      await query(
        `UPDATE websites SET last_check_at=$2, last_status_code=$3, last_response_ms=$4, last_error=$5, next_check_at=${nextCheck},
                lock_until=NULL, lock_owner=NULL, internal_error_count=0, updated_at=updated_at WHERE id=$1`,
        [websiteId, r.finishedAt, r.statusCode, r.responseMs, r.errorMessage], c);
      return { checkId: chk.id, state: w.state as SiteState, event: null, inMaintenance: true };
    }
    const slowLimit = w.degraded_threshold_ms ?? defaultSlow;
    const slow = r.success && r.responseMs !== null && r.responseMs > slowLimit;
    const s = step(
      { state: w.state, consecutiveFailures: w.consecutive_failures, consecutiveSuccesses: w.consecutive_successes },
      r.success, slow, w.fail_threshold, w.recover_threshold,
    );
    const firstFail = r.success ? null : (w.consecutive_failures === 0 ? r.startedAt : w.streak_first_failure_at ?? r.startedAt);
    const firstSuccess = r.success ? (w.consecutive_successes === 0 ? r.finishedAt : w.streak_first_success_at ?? r.finishedAt) : null;
    const stateChanged = s.state !== w.state;
    await query(
      `UPDATE websites SET state=$2, state_since = CASE WHEN $3 THEN $4 ELSE state_since END,
              consecutive_failures=$5, consecutive_successes=$6, streak_first_failure_at=$7, streak_first_success_at=$8,
              last_check_at=$4, last_status_code=$9, last_response_ms=$10, last_error=$11, next_check_at=${nextCheck},
              lock_until=NULL, lock_owner=NULL, internal_error_count=0
        WHERE id=$1`,
      [websiteId, s.state, stateChanged || w.state_since === null, r.finishedAt, s.consecutiveFailures, s.consecutiveSuccesses, firstFail, firstSuccess, r.statusCode, r.responseMs, r.errorMessage],
      c,
    );
    let incidentId: string | undefined;
    if (s.event === 'outage_opened') {
      const startedAt = firstFail ?? r.startedAt;
      const { incident, created } = await openIncident(c, {
        websiteId, kind: 'outage', dedupeKey: 'outage', severity: w.criticality,
        title: `${w.name} is unreachable`, summary: r.errorMessage ?? undefined, startedAt, lastFailureAt: r.finishedAt,
      });
      incidentId = incident.id;
      if (created) await notifyIncident({ incident, website: w, event: 'opened', detail: r.errorMessage ?? undefined }, c);
    } else if (!r.success && w.state === 'down') {
      // Still down: keep the single deduplicated incident current. If someone resolved it manually while the
      // site is still failing, a fresh incident is opened (and announced) instead of silently losing the outage.
      const { incident, created } = await openIncident(c, {
        websiteId, kind: 'outage', dedupeKey: 'outage', severity: w.criticality, title: `${w.name} is unreachable`,
        summary: r.errorMessage ?? undefined, startedAt: firstFail ?? r.startedAt, lastFailureAt: r.finishedAt,
      });
      incidentId = incident.id;
      if (created) await notifyIncident({ incident, website: w, event: 'opened', detail: r.errorMessage ?? undefined }, c);
    } else if (s.event === 'recovered') {
      const resolvedAt = firstSuccess ?? r.finishedAt;
      const inc = await resolveIncidentAuto(c, websiteId, 'outage', resolvedAt, `Service recovered (${w.recover_threshold} consecutive successful checks)`);
      if (inc) {
        incidentId = inc.id;
        await notifyIncident({ incident: inc, website: w, event: 'recovered' }, c);
      }
    }
    return { checkId: chk.id, state: s.state, event: s.event, inMaintenance: false, incidentId };
  });
}

/** Same logic for form/checkout page checks (state kept on form_checks, incidents of kind "form"). */
export async function processFormResult(formId: string, r: CheckResult) {
  return tx(async (c) => {
    const f = await one('SELECT f.*, w.name AS site_name, w.criticality, w.url AS site_url, w.alert_preferences, w.fail_threshold, w.recover_threshold, w.id AS wid FROM form_checks f JOIN websites w ON w.id=f.website_id WHERE f.id=$1 FOR UPDATE OF f', [formId], c);
    if (!f) return null;
    const maint = await inMaintenance(c, f.wid, r.startedAt);
    await query(
      `INSERT INTO website_checks (website_id, form_check_id, kind, started_at, finished_at, success, status_code, response_ms, error_category, error_message, redirect_count, final_url, in_maintenance)
       VALUES ($1,$2,'form',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [f.wid, formId, r.startedAt, r.finishedAt, r.success, r.statusCode, r.responseMs, r.errorCategory, r.errorMessage, r.redirectCount, r.finalUrl, maint], c);
    const next = `now() + make_interval(secs => ${Number(f.interval_seconds)})`;
    if (maint) {
      await query(`UPDATE form_checks SET last_check_at=$2,last_status_code=$3,last_response_ms=$4,last_error=$5,next_check_at=${next},lock_until=NULL WHERE id=$1`, [formId, r.finishedAt, r.statusCode, r.responseMs, r.errorMessage], c);
      return null;
    }
    const s = step({ state: f.state === 'unknown' ? 'unknown' : f.state, consecutiveFailures: f.consecutive_failures, consecutiveSuccesses: f.consecutive_successes }, r.success, false, f.fail_threshold, f.recover_threshold);
    const firstFail = r.success ? null : f.consecutive_failures === 0 ? r.startedAt : f.streak_first_failure_at ?? r.startedAt;
    const firstSuccess = r.success ? (f.consecutive_successes === 0 ? r.finishedAt : f.streak_first_success_at ?? r.finishedAt) : null;
    await query(
      `UPDATE form_checks SET state=$2, consecutive_failures=$3, consecutive_successes=$4, streak_first_failure_at=$5, streak_first_success_at=$6,
              last_check_at=$7, last_status_code=$8, last_response_ms=$9, last_error=$10, next_check_at=${next}, lock_until=NULL WHERE id=$1`,
      [formId, s.state === 'degraded' ? 'up' : s.state, s.consecutiveFailures, s.consecutiveSuccesses, firstFail, firstSuccess, r.finishedAt, r.statusCode, r.responseMs, r.errorMessage], c);
    const website = { id: f.wid, name: `${f.site_name} — ${f.label}`, url: f.url, alert_preferences: f.alert_preferences };
    const key = `form:${formId}`;
    if (s.event === 'outage_opened') {
      // Critical-business pages (checkout/login/booking) are at least "high" severity.
      const sev = ['checkout', 'login', 'booking'].includes(f.type) && f.criticality !== 'critical' ? 'high' : f.criticality;
      const { incident, created } = await openIncident(c, { websiteId: f.wid, kind: 'form', dedupeKey: key, severity: sev, title: `${f.label} page failing on ${f.site_name}`, summary: r.errorMessage ?? undefined, startedAt: firstFail ?? r.startedAt, lastFailureAt: r.finishedAt });
      if (created) await notifyIncident({ incident, website, event: 'form_opened', detail: r.errorMessage ?? undefined }, c);
    } else if (s.event === 'recovered') {
      const inc = await resolveIncidentAuto(c, f.wid, key, firstSuccess ?? r.finishedAt, 'Form page recovered');
      if (inc) await notifyIncident({ incident: inc, website, event: 'form_recovered' }, c);
    } else if (!r.success && f.state === 'down') {
      await query('UPDATE incidents SET last_failure_at=$3, updated_at=now() WHERE website_id=$1 AND dedupe_key=$2 AND status <> \'resolved\'', [f.wid, key, r.finishedAt], c);
    }
    return s;
  });
}
