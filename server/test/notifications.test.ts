import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { resetConfigForTests } from '../src/config.js';
import { processDeliveries, setMailerForTests } from '../src/monitor/email.js';
import { processWebsiteResult } from '../src/monitor/process.js';
import { get, login, makeSite, makeUser, patch, post, resetDb } from './helpers.js';

beforeEach(async () => { await resetDb(); setMailerForTests(undefined); });

const fail = () => ({ startedAt: new Date(), finishedAt: new Date(), success: false, statusCode: 500, responseMs: 5, errorCategory: 'http_status' as const, errorMessage: 'boom', redirectCount: 0, finalUrl: 'x' });
async function openIncident(name = 'Mailer') {
  const w = await makeSite({ name, fail_threshold: 1 });
  await processWebsiteResult(w.id, fail());
  return w;
}

describe('e-mail delivery tracking', () => {
  it('marks deliveries sent only after a successful send, and records it on the incident timeline', async () => {
    await makeUser('admin', 'a@example.com');
    const sent: any[] = [];
    setMailerForTests({ send: async (m) => void sent.push(m) });
    await openIncident();
    const r = await processDeliveries();
    expect(r).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(sent[0].subject).toMatch(/DOWN: Mailer/);
    expect(sent[0].text).toMatch(/Dashboard: http:\/\/dashboard\.test\/incidents\//);
    expect((await query('SELECT status, attempts, sent_at FROM notification_deliveries'))[0]).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await query("SELECT message FROM incident_events WHERE type='notification_sent'")).length).toBe(1);
  });

  it('retries failures with backoff, then marks them failed – never "sent"', async () => {
    await makeUser('admin', 'a@example.com');
    setMailerForTests({ send: async () => { throw new Error('535 auth failed for user x with password hunter2'); } });
    process.env.SMTP_PASSWORD = 'hunter2'; resetConfigForTests();
    await openIncident();
    expect(await processDeliveries()).toEqual({ sent: 0, failed: 0, retried: 1 });
    let d = (await query('SELECT * FROM notification_deliveries'))[0];
    expect(d.status).toBe('pending');
    expect(d.last_error).not.toContain('hunter2'); // credentials never reach the DB / UI
    expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    for (let i = 0; i < 6; i++) {
      await query("UPDATE notification_deliveries SET next_attempt_at = now() - interval '1s' WHERE status='pending'");
      await processDeliveries();
    }
    d = (await query('SELECT * FROM notification_deliveries'))[0];
    expect(d).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await query("SELECT type FROM incident_events WHERE type LIKE 'notification_%'")).map((e) => e.type)).toEqual(['notification_failed']);
    delete process.env.SMTP_PASSWORD; resetConfigForTests();
  });

  it('fails immediately and honestly when SMTP is not configured', async () => {
    await makeUser('admin', 'a@example.com');
    await openIncident();
    expect(await processDeliveries()).toMatchObject({ sent: 0, failed: 1 });
    const d = (await query('SELECT status, last_error FROM notification_deliveries'))[0];
    expect(d.status).toBe('failed');
    expect(d.last_error).toMatch(/SMTP is not configured/);
  });

  it('deduplicates: one delivery per recipient per incident event', async () => {
    await makeUser('admin', 'a@example.com');
    const w = await makeSite({ fail_threshold: 1 });
    const out = await processWebsiteResult(w.id, fail());
    await processWebsiteResult(w.id, fail());
    await processWebsiteResult(w.id, fail());
    expect(out.event).toBe('outage_opened');
    expect((await query('SELECT count(*)::int n FROM notification_deliveries'))[0].n).toBe(1);
    expect((await query('SELECT count(*)::int n FROM notifications'))[0].n).toBe(1);
    await expect(query("INSERT INTO notification_deliveries (recipient,subject,body_text,dedupe_key) SELECT recipient,subject,body_text,dedupe_key FROM notification_deliveries")).rejects.toThrow(/duplicate/);
  });

  it('supports configured extra recipients and per-user opt-out', async () => {
    const a = await login('admin');
    await makeUser('manager', 'm@example.com');
    await patch(a, '/settings/me', { notify_email: false });
    await a.agent.put('/api/v1/settings').set('X-CSRF-Token', a.csrf).send({ alert_recipients: ['ops@example.com'] });
    await openIncident();
    const to = (await query('SELECT recipient FROM notification_deliveries ORDER BY recipient')).map((r) => r.recipient);
    expect(to).toEqual(['m@example.com', 'ops@example.com']);
  });

  it('test-email endpoint reports SMTP problems without leaking secrets', async () => {
    const a = await login('admin');
    const r = await post(a, '/notifications/test-email', {});
    expect(r.status).toBe(502);
    expect(r.body.error.message).toMatch(/not configured/);
    setMailerForTests({ send: async () => undefined });
    const ok = await post(a, '/notifications/test-email', { to: 'x@example.com' });
    expect(ok.status).toBe(200);
    setMailerForTests(undefined);
  });
});

describe('in-dashboard notifications', () => {
  it('lists, counts, filters and marks as read – only the owner can touch their notifications', async () => {
    const a = await login('admin'); const m = await login('manager');
    await openIncident();
    const list = await get(m, '/notifications');
    expect(list.body.unread).toBe(1);
    expect(list.body.data[0]).toMatchObject({ type: 'incident_opened', severity: 'warning' });
    expect(list.body.data[0].link).toMatch(/^\/incidents\//);
    expect((await get(m, '/notifications/unread-count')).body.unread).toBe(1);
    const id = list.body.data[0].id;
    expect((await patch(a, `/notifications/${(await get(a, '/notifications')).body.data[0].id}/read`)).status).toBe(200);
    const other = await m.agent.patch(`/api/v1/notifications/${(await get(a, '/notifications')).body.data[0].id}/read`).set('X-CSRF-Token', m.csrf);
    expect(other.status).toBe(404); // someone else's notification
    expect((await patch(m, `/notifications/${id}/read`)).status).toBe(200);
    expect((await get(m, '/notifications?unread=true')).body.total).toBe(0);
    expect((await get(m, '/notifications?type=incident_opened')).body.total).toBe(1);
    expect((await post(m, '/notifications/read-all')).status).toBe(200);
  });
});
