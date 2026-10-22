import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { runEscalations } from '../src/jobs/escalation.js';
import { processWebsiteResult } from '../src/monitor/process.js';
import { del, get, login, makeSite, makeUser, patch, post, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('tasks', () => {
  it('create, assign (with notification), update status, comment, overdue flag', async () => {
    const a = await login('admin'); const m = await login('manager');
    const w = await makeSite();
    const t = await post(a, '/tasks', { title: 'Renew cert', website_id: w.id, assigned_to: m.user.id, priority: 'high', due_at: new Date(Date.now() - 3600_000).toISOString() });
    expect(t.status).toBe(201);
    expect((await query("SELECT 1 FROM notifications WHERE user_id=$1 AND type='task_assigned'", [m.user.id])).length).toBe(1);
    const list = await get(m, '/tasks?status=pending');
    expect(list.body.data[0]).toMatchObject({ title: 'Renew cert', overdue: true, assigned_name: 'Manager User', website_name: w.name });
    expect((await get(m, '/tasks?overdue=true')).body.total).toBe(1);
    expect((await patch(m, `/tasks/${t.body.id}`, { status: 'in_progress' })).body.status).toBe('in_progress');
    expect((await post(m, `/tasks/${t.body.id}/comments`, { message: 'On it' })).status).toBe(201);
    const done = await patch(m, `/tasks/${t.body.id}`, { status: 'completed' });
    expect(done.body.completed_at).toBeTruthy();
    const detail = (await get(a, `/tasks/${t.body.id}`)).body;
    expect(detail.overdue).toBe(false); // completed tasks are never overdue
    expect(detail.events.map((e: any) => e.type)).toEqual(['created', 'status_change', 'comment', 'status_change']);
    expect((await get(m, '/tasks?assigned_to=me&status=completed')).body.total).toBe(1);
  });

  it('managers can only change tasks assigned to or created by them; only admins delete', async () => {
    const a = await login('admin'); const m = await login('manager'); const m2 = await login('manager', 'm2@example.com');
    const adminTask = await post(a, '/tasks', { title: 'Admin only', assigned_to: a.user.id });
    expect((await patch(m, `/tasks/${adminTask.body.id}`, { status: 'completed' })).status).toBe(403);
    const mine = await post(m, '/tasks', { title: 'Mine' });
    expect((await patch(m, `/tasks/${mine.body.id}`, { priority: 'low' })).status).toBe(200);
    const assignedToM2 = await post(a, '/tasks', { title: 'For m2', assigned_to: m2.user.id });
    expect((await patch(m2, `/tasks/${assignedToM2.body.id}`, { status: 'blocked' })).status).toBe(200);
    expect((await patch(m, `/tasks/${assignedToM2.body.id}`, { status: 'completed' })).status).toBe(403);
    expect((await del(m, `/tasks/${mine.body.id}`)).status).toBe(403);
    expect((await del(a, `/tasks/${mine.body.id}`)).status).toBe(204);
  });

  it('validates input and links tasks to incidents', async () => {
    const a = await login('admin');
    expect((await post(a, '/tasks', { title: '' })).status).toBe(400);
    expect((await post(a, '/tasks', { title: 'x', assigned_to: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    const w = await makeSite({ fail_threshold: 1 });
    await processWebsiteResult(w.id, { startedAt: new Date(), finishedAt: new Date(), success: false, statusCode: 500, responseMs: 1, errorCategory: 'http_status', errorMessage: 'x', redirectCount: 0, finalUrl: 'x' });
    const inc = (await query('SELECT id FROM incidents'))[0];
    const t = await post(a, '/tasks', { title: 'Investigate', incident_id: inc.id });
    expect(t.body.website_id).toBe(w.id);
    expect((await get(a, `/incidents/${inc.id}`)).body.tasks).toHaveLength(1);
  });
});

describe('escalation rules', () => {
  const failing = { startedAt: new Date(), finishedAt: new Date(), success: false, statusCode: 500, responseMs: 1, errorCategory: 'http_status' as const, errorMessage: 'x', redirectCount: 0, finalUrl: 'x' };

  it('escalates an old unacknowledged incident exactly once, never in a loop, and respects severity/ack', async () => {
    const a = await login('admin'); await makeUser('manager', 'm@example.com');
    const rule = await post(a, '/escalation-rules', { name: 'Page admins', subject: 'incident', min_severity: 'high', after_minutes: 15, notify_role: 'admin' });
    expect(rule.status).toBe(201);
    const crit = await makeSite({ name: 'Crit', criticality: 'critical', fail_threshold: 1 });
    const low = await makeSite({ name: 'Low', criticality: 'low', fail_threshold: 1 });
    await processWebsiteResult(crit.id, failing); await processWebsiteResult(low.id, failing);
    expect((await runEscalations()).escalated).toBe(0); // too young
    await query("UPDATE incidents SET detected_at = now() - interval '20 minutes'");
    expect((await runEscalations()).escalated).toBe(1); // only the critical one (min_severity=high)
    expect((await runEscalations()).escalated).toBe(0); // idempotent: no loop, no duplicate
    expect((await runEscalations()).escalated).toBe(0);
    const n = await query("SELECT user_id, title FROM notifications WHERE type='escalation'");
    expect(n).toHaveLength(1);
    expect(n[0].user_id).toBe(a.user.id);
    expect((await query("SELECT count(*)::int n FROM notification_deliveries WHERE kind='escalation'"))[0].n).toBe(1);
    expect((await query("SELECT type FROM incident_events WHERE type='escalated'")).length).toBe(1);
    // acknowledged incidents are skipped by rules with only_unacknowledged
    const rule2 = await post(a, '/escalation-rules', { name: 'Ack', subject: 'incident', min_severity: 'low', after_minutes: 10, notify_role: 'manager' });
    await query("UPDATE incidents SET acknowledged_at = now()");
    expect((await runEscalations()).escalated).toBe(0);
    await patch(a, `/escalation-rules/${rule2.body.id}`, { only_unacknowledged: false });
    expect((await runEscalations()).escalated).toBe(2);
  });

  it('escalates overdue tasks once', async () => {
    const a = await login('admin');
    await post(a, '/escalation-rules', { name: 'Overdue', subject: 'task', after_minutes: 60, notify_role: 'admin', only_unacknowledged: false });
    const t = await post(a, '/tasks', { title: 'Late', due_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await post(a, '/tasks', { title: 'Not late', due_at: new Date(Date.now() + 3600_000).toISOString() });
    expect((await runEscalations()).escalated).toBe(1);
    expect((await runEscalations()).escalated).toBe(0);
    expect((await get(a, `/tasks/${t.body.id}`)).body.events.map((e: any) => e.type)).toContain('escalated');
    await patch(a, `/tasks/${t.body.id}`, { status: 'completed' });
  });

  it('rule management is admin-only and validated', async () => {
    const m = await login('manager'); const a = await login('admin');
    expect((await post(m, '/escalation-rules', { name: 'x', subject: 'task', after_minutes: 5, notify_role: 'admin' })).status).toBe(403);
    expect((await post(a, '/escalation-rules', { name: 'x', subject: 'task', after_minutes: 5 })).status).toBe(400); // nobody to notify
    expect((await post(a, '/escalation-rules', { name: 'x', subject: 'task', after_minutes: 0, notify_role: 'admin' })).status).toBe(400);
    expect((await get(m, '/escalation-rules')).status).toBe(200);
  });
});
