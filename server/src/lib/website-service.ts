import { one, query, tx, type Queryable, getPool } from '../db.js';
import { conflict, notFound } from './errors.js';
import { normalizeUrl, type CreateWebsite } from './website-schema.js';

export const WEBSITE_COLUMNS = `id, name, url, health_check_url, hosting_type, environment, owner, criticality,
  monitoring_status, expected_status, check_interval_seconds, timeout_ms, max_redirects, degraded_threshold_ms,
  fail_threshold, recover_threshold, ssl_check_enabled, ssl_failure_is_outage, performance_audit_enabled,
  performance_interval_hours, form_type, ga4_property_id, ga4_status, ga4_status_detail, gsc_property_url, gsc_status,
  gsc_status_detail, notes, alert_preferences, state, state_since, last_check_at, last_status_code, last_response_ms,
  last_error, consecutive_failures, created_at, updated_at`;

/**
 * State shown to users. A website that is not actively monitored, has never been checked or whose
 * last check is older than 3 intervals is "unknown" — never "online".
 */
export const EFFECTIVE_STATE_SQL = `(CASE
  WHEN w.monitoring_status <> 'active' THEN 'unmonitored'
  WHEN w.last_check_at IS NULL THEN 'unknown'
  WHEN w.last_check_at < now() - make_interval(secs => w.check_interval_seconds * 3) THEN 'unknown'
  ELSE w.state END)`;

export async function createWebsite(input: CreateWebsite, userId: string | null, q: Queryable = getPool()) {
  const norm = normalizeUrl(input.url);
  const dupe = await one('SELECT id FROM websites WHERE url_normalized = $1 AND monitoring_status <> \'archived\'', [norm], q);
  if (dupe) throw conflict('A website with this URL already exists', { existingId: dupe.id });
  // Integration status defaults: a configured property id means "access required" until a sync proves access.
  const ga4Status = input.ga4_property_id && input.ga4_status === 'not_connected' ? 'access_required' : input.ga4_status;
  const gscStatus = input.gsc_property_url && input.gsc_status === 'not_connected' ? 'access_required' : input.gsc_status;
  const row = await one(
    `INSERT INTO websites (name, url, url_normalized, health_check_url, hosting_type, environment, owner, criticality,
       monitoring_status, expected_status, check_interval_seconds, timeout_ms, max_redirects, degraded_threshold_ms,
       fail_threshold, recover_threshold, ssl_check_enabled, ssl_failure_is_outage, performance_audit_enabled,
       performance_interval_hours, form_type, ga4_property_id, ga4_status, gsc_property_url, gsc_status, notes,
       alert_preferences, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING ${WEBSITE_COLUMNS}`,
    [
      input.name, input.url.trim(), norm, input.health_check_url ?? null, input.hosting_type, input.environment,
      input.owner ?? null, input.criticality, input.monitoring_status, input.expected_status,
      input.check_interval_seconds, input.timeout_ms, input.max_redirects, input.degraded_threshold_ms ?? null,
      input.fail_threshold, input.recover_threshold, input.ssl_check_enabled, input.ssl_failure_is_outage,
      input.performance_audit_enabled, input.performance_interval_hours, input.form_type,
      input.ga4_property_id ?? null, ga4Status, input.gsc_property_url ?? null, gscStatus, input.notes ?? null,
      JSON.stringify({ email: true, in_app: true, ...(input.alert_preferences ?? {}) }), userId,
    ],
    q,
  );
  return row;
}

const UPDATABLE = [
  'name', 'url', 'health_check_url', 'hosting_type', 'environment', 'owner', 'criticality', 'monitoring_status',
  'expected_status', 'check_interval_seconds', 'timeout_ms', 'max_redirects', 'degraded_threshold_ms', 'fail_threshold',
  'recover_threshold', 'ssl_check_enabled', 'ssl_failure_is_outage', 'performance_audit_enabled',
  'performance_interval_hours', 'form_type', 'ga4_property_id', 'ga4_status', 'gsc_property_url', 'gsc_status', 'notes',
  'alert_preferences',
] as const;

export async function updateWebsite(id: string, patch: Record<string, any>) {
  return tx(async (c) => {
    const cur = await one('SELECT * FROM websites WHERE id = $1 FOR UPDATE', [id], c);
    if (!cur) throw notFound('Website not found');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    for (const k of UPDATABLE) {
      if (!(k in patch) || patch[k] === undefined) continue;
      if (k === 'alert_preferences') push(k, JSON.stringify({ ...cur.alert_preferences, ...patch[k] }));
      else if (k === 'url') {
        const norm = normalizeUrl(patch.url);
        if (norm !== cur.url_normalized) {
          const dupe = await one(
            "SELECT id FROM websites WHERE url_normalized = $1 AND id <> $2 AND monitoring_status <> 'archived'", [norm, id], c);
          if (dupe) throw conflict('Another website already uses this URL', { existingId: dupe.id });
        }
        push('url', patch.url.trim());
        push('url_normalized', norm);
      } else push(k, patch[k]);
    }
    // Integration mapping changes reset the status so a stale "connected" is never shown.
    if ('ga4_property_id' in patch && patch.ga4_property_id !== cur.ga4_property_id && !('ga4_status' in patch)) {
      push('ga4_status', patch.ga4_property_id ? 'access_required' : 'not_connected');
    }
    if ('gsc_property_url' in patch && patch.gsc_property_url !== cur.gsc_property_url && !('gsc_status' in patch)) {
      push('gsc_status', patch.gsc_property_url ? 'access_required' : 'not_connected');
    }
    // Re-activating or changing the interval makes the site due immediately.
    if (patch.monitoring_status === 'active' && cur.monitoring_status !== 'active') {
      sets.push('next_check_at = now()');
    }
    if (!sets.length) return one(`SELECT ${WEBSITE_COLUMNS} FROM websites w WHERE id = $1`, [id], c);
    sets.push('updated_at = now()');
    vals.push(id);
    return one(`UPDATE websites SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${WEBSITE_COLUMNS}`, vals, c);
  });
}

export async function getWebsite(id: string) {
  const row = await one(
    `SELECT ${WEBSITE_COLUMNS.split(',').map((c) => 'w.' + c.trim()).join(', ')}, ${EFFECTIVE_STATE_SQL} AS effective_state
       FROM websites w WHERE w.id = $1`,
    [id],
  );
  if (!row) throw notFound('Website not found');
  return row;
}

export async function deleteWebsite(id: string) {
  const r = await query('DELETE FROM websites WHERE id = $1 RETURNING id', [id]);
  if (!r.length) throw notFound('Website not found');
}
