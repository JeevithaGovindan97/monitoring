import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { step } from '../src/monitor/state.js';
import { processWebsiteResult } from '../src/monitor/process.js';
import type { CheckResult } from '../src/monitor/http-check.js';
import { get, login, makeSite, makeUser, post, resetDb } from './helpers.js';

beforeEach(resetDb);

let clock = Date.parse('2026-03-01T10:00:00Z');
const res = (ok: boolean, ms = 120): CheckResult => {
  const startedAt = new Date((clock += 300_000));
  return { startedAt, finishedAt: new Date(startedAt.getTime() + ms), success: ok, statusCode: ok ? 200 : 503, responseMs: ms, errorCategory: ok ? null : 'http_status', errorMessage: ok ? null : 'Unexpected HTTP status 503', redirectCount: 0, finalUrl: 'https://x' };
};

describe('state machine', () => {
  const s0 = { state: 'unknown' as const, consecutiveFailures: 0, consecutiveSuccesses: 0 };
  it('opens an outage only after N consecutive failures and recovers after M successes', () => {
    let s = step(s0, true, false, 2, 2);
    expect(s).toMatchObject({ state: 'up', event: null });
    s = step(s, false, false, 2, 2);
    expect(s).toMatchObject({ state: 'up', consecutiveFailures: 1, event: null }); // single failure never flips state
    s = step(s, false, false, 2, 2);
    expect(s).toMatchObject({ state: 'down', event: 'outage_opened' });
    s = step(s, false, false, 2, 2);
    expect(s).toMatchObject({ state: 'down', event: null }); // no duplicate event
    s = step(s, true, false, 2, 2);
    expect(s).toMatchObject({ state: 'down', event: null }); // one success is not enough
    s = step(s, true, false, 2, 2);
    expect(s).toMatchObject({ state: 'up', event: 'recovered' });
  });
  it('a success between failures resets the streak (flap protection)', () => {
    let s = step(s0, false, false, 2, 2);
    s = step(s, true, false, 2, 2);
    s = step(s, false, false, 2, 2);
    expect(s.state).not.toBe('down');
  });
  it('supports custom thresholds and degraded state', () => {
    let s = step({ ...s0, state: 'up' }, false, false, 1, 1);
    expect(s.event).toBe('outage_opened');
    s = step(s, true, true, 1, 1);
    expect(s).toMatchObject({ state: 'degraded', event: 'recovered' });
  });
});

describe('incident lifecycle', () => {
  it('two failures open ONE incident with correct start time; repeated failures are deduplicated; two successes resolve it', async () => {
    const w = await makeSite({ criticality: 'critical', name: 'Shop' });
    await makeUser('admin'); await makeUser('manager');
    const r1 = res(false); await processWebsiteResult(w.id, r1);
    expect((await query('SELECT * FROM incidents')).length).toBe(0); // suspected, not yet an outage
    const r2 = res(false); const o2 = await processWebsiteResult(w.id, r2);
    expect(o2.event).toBe('outage_opened');
    for (let i = 0; i < 5; i++) await processWebsiteResult(w.id, res(false));
    const incs = await query('SELECT * FROM incidents');
    expect(incs).toHaveLength(1);
    expect(incs[0]).toMatchObject({ severity: 'critical', status: 'open', kind: 'outage' });
    expect(new Date(incs[0].started_at).getTime()).toBe(r1.startedAt.getTime()); // first failure of the streak
    expect(new Date(incs[0].last_failure_at).getTime()).toBeGreaterThan(r2.finishedAt.getTime());
    expect((await query('SELECT state FROM websites WHERE id=$1', [w.id]))[0].state).toBe('down');

    const s1 = res(true); await processWebsiteResult(w.id, s1);
    expect((await query('SELECT status FROM incidents'))[0].status).toBe('open'); // one success is not recovery
    const s2 = res(true); const o = await processWebsiteResult(w.id, s2);
    expect(o.event).toBe('recovered');
    const done = (await query('SELECT * FROM incidents'))[0];
    expect(done.status).toBe('resolved');
    expect(done.auto_resolved).toBe(true);
    expect(new Date(done.resolved_at).getTime()).toBe(s1.finishedAt.getTime()); // first success of the recovery streak
    expect(done.duration_seconds).toBe(Math.round((s1.finishedAt.getTime() - r1.startedAt.getTime()) / 1000));
    const types = (await query('SELECT type FROM incident_events ORDER BY id')).map((e) => e.type);
    expect(types).toEqual(['opened', 'resolved']);
    expect((await query('SELECT count(*)::int n FROM website_checks'))[0].n).toBe(9); // every check is stored, including failures that created no incident
  });

  it('creates in-dashboard notifications and queued e-mail deliveries – never marked sent without a send', async () => {
    const w = await makeSite({ name: 'Blog' });
    await makeUser('admin', 'a@example.com'); await makeUser('manager', 'm@example.com');
    await processWebsiteResult(w.id, res(false)); await processWebsiteResult(w.id, res(false));
    const notes = await query("SELECT user_id, title FROM notifications WHERE type='incident_opened'");
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toContain('DOWN: Blog');
    const del = await query('SELECT recipient, status, attempts FROM notification_deliveries ORDER BY recipient');
    expect(del.map((d) => [d.recipient, d.status, d.attempts])).toEqual([['a@example.com', 'pending', 0], ['m@example.com', 'pending', 0]]);
  });

  it('respects per-website alert preferences', async () => {
    const w = await makeSite({ alert_preferences: { email: false, in_app: true } });
    await makeUser('admin');
    await processWebsiteResult(w.id, res(false)); await processWebsiteResult(w.id, res(false));
    expect((await query('SELECT 1 FROM notifications')).length).toBe(1);
    expect((await query('SELECT 1 FROM notification_deliveries')).length).toBe(0);
  });

  it('suppresses repeat outage e-mails inside the cooldown window but still records them as suppressed', async () => {
    const w = await makeSite({ fail_threshold: 1, recover_threshold: 1 });
    await makeUser('admin');
    await processWebsiteResult(w.id, res(false)); // incident 1 → email pending
    await processWebsiteResult(w.id, res(true));  // recovered
    await processWebsiteResult(w.id, res(false)); // incident 2 inside cooldown
    const del = await query("SELECT kind, status FROM notification_deliveries ORDER BY created_at, kind");
    const opened = del.filter((d) => d.kind === 'incident_opened').map((d) => d.status).sort();
    expect(opened).toEqual(['pending', 'suppressed']);
    expect((await query('SELECT count(*)::int n FROM incidents'))[0].n).toBe(2);
  });

  it('maintenance windows exclude checks from state, incidents and uptime', async () => {
    const w = await makeSite({ fail_threshold: 1 });
    await query("INSERT INTO maintenance_windows (website_id, starts_at, ends_at) VALUES ($1, $2, $3)", [w.id, new Date(clock), new Date(clock + 3 * 300_000 + 1000)]);
    await processWebsiteResult(w.id, res(false));
    await processWebsiteResult(w.id, res(false));
    expect((await query('SELECT count(*)::int n FROM incidents'))[0].n).toBe(0);
    expect((await query('SELECT state, consecutive_failures FROM websites WHERE id=$1', [w.id]))[0]).toEqual({ state: 'unknown', consecutive_failures: 0 });
    expect((await query('SELECT count(*)::int n FROM website_checks WHERE in_maintenance'))[0].n).toBe(2);
    clock += 10 * 300_000;
    await processWebsiteResult(w.id, res(false)); // window over → real failure
    expect((await query('SELECT count(*)::int n FROM incidents'))[0].n).toBe(1);
  });

  it('a global (all sites) maintenance window applies too', async () => {
    const w = await makeSite({ fail_threshold: 1 });
    await query("INSERT INTO maintenance_windows (website_id, starts_at, ends_at) VALUES (NULL, $1, $2)", [new Date(clock), new Date(clock + 2 * 300_000)]);
    await processWebsiteResult(w.id, res(false));
    expect((await query('SELECT count(*)::int n FROM incidents'))[0].n).toBe(0);
  });

  it('slow-but-successful responses mark the site degraded, not down', async () => {
    const w = await makeSite({ degraded_threshold_ms: 1000 });
    await processWebsiteResult(w.id, res(true, 2500));
    expect((await query('SELECT state FROM websites WHERE id=$1', [w.id]))[0].state).toBe('degraded');
    await processWebsiteResult(w.id, res(true, 200));
    expect((await query('SELECT state FROM websites WHERE id=$1', [w.id]))[0].state).toBe('up');
  });

  it('a site that is still failing after a manual resolve gets a fresh incident (outage is never silently lost)', async () => {
    const a = await login('admin');
    const w = await makeSite({});
    await processWebsiteResult(w.id, res(false)); await processWebsiteResult(w.id, res(false));
    const inc = (await query('SELECT id FROM incidents'))[0];
    expect((await post(a, `/incidents/${inc.id}/resolve`, { note: 'false alarm' })).status).toBe(200);
    await processWebsiteResult(w.id, res(false));
    const all = await query('SELECT status FROM incidents ORDER BY created_at');
    expect(all.map((i) => i.status)).toEqual(['resolved', 'open']);
  });
});

describe('incident workflow API', () => {
  it('acknowledge → assign → note → resolve → reopen, with an append-only timeline', async () => {
    const a = await login('admin'); const m = await login('manager');
    const w = await makeSite({ name: 'Wf' });
    await processWebsiteResult(w.id, res(false)); await processWebsiteResult(w.id, res(false));
    const id = (await query('SELECT id FROM incidents'))[0].id;

    expect((await post(m, `/incidents/${id}/acknowledge`)).body.status).toBe('acknowledged');
    expect((await post(m, `/incidents/${id}/acknowledge`)).status).toBe(409);
    const asg = await post(m, `/incidents/${id}/assign`, { user_id: a.user.id });
    expect(asg.body.assigned_to).toBe(a.user.id);
    expect((await query('SELECT 1 FROM notifications WHERE user_id=$1 AND type=$2', [a.user.id, 'incident_assigned'])).length).toBe(1);
    expect((await post(m, `/incidents/${id}/assign`, { user_id: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    expect((await post(m, `/incidents/${id}/notes`, { message: 'Restarted the container' })).status).toBe(201);
    expect((await post(m, `/incidents/${id}/investigate`)).body.status).toBe('investigating');
    const resolved = await post(m, `/incidents/${id}/resolve`, { note: 'fixed' });
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.duration_seconds).toBeGreaterThanOrEqual(0);
    expect((await post(m, `/incidents/${id}/resolve`)).status).toBe(409);
    expect((await post(m, `/incidents/${id}/reopen`, { reason: 'came back' })).body.status).toBe('reopened');
    expect((await post(m, `/incidents/${id}/reopen`)).status).toBe(409);

    const detail = (await get(a, `/incidents/${id}`)).body;
    expect(detail.events.map((e: any) => e.type)).toEqual(['opened', 'acknowledged', 'assigned', 'note', 'status_change', 'resolved', 'reopened']);
    // append-only: the database refuses edits to the timeline
    await expect(query("UPDATE incident_events SET message='tampered' WHERE incident_id=$1", [id])).rejects.toThrow(/append-only/);

    const list = await get(a, `/incidents?status=open_all&severity=medium&website_id=${w.id}`);
    expect(list.body.total).toBe(1);
    expect((await get(a, '/incidents?status=resolved')).body.total).toBe(0);
    expect((await get(a, '/incidents?assigned_to=me')).body.total).toBe(1);
  });

  it('cannot reopen when a newer incident for the same problem is already open', async () => {
    const a = await login('admin');
    const w = await makeSite({ fail_threshold: 1, recover_threshold: 1 });
    await processWebsiteResult(w.id, res(false));
    const first = (await query('SELECT id FROM incidents'))[0].id;
    await processWebsiteResult(w.id, res(true));
    await processWebsiteResult(w.id, res(false)); // new incident
    expect((await post(a, `/incidents/${first}/reopen`)).status).toBe(409);
  });
});
