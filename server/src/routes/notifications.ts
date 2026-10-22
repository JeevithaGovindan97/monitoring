import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { wrap, notFound } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';
import { sendTestEmail } from '../monitor/email.js';
import { audit } from '../lib/audit.js';
import { allSettings, setSetting } from '../lib/settings.js';
import { config } from '../config.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req);
  const where = ['n.user_id = $1'];
  const params: unknown[] = [req.user!.id];
  if (req.query.unread === 'true') where.push('n.read_at IS NULL');
  if (req.query.type) { params.push(String(req.query.type)); where.push(`n.type = $${params.length}`); }
  if (req.query.website_id) { params.push(String(req.query.website_id)); where.push(`n.website_id = $${params.length}`); }
  const w = where.join(' AND ');
  const rows = await query(`SELECT n.* FROM notifications n WHERE ${w} ORDER BY n.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*)::int n FROM notifications n WHERE ${w}`, params)).n;
  const unread = (await one('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user!.id])).n;
  res.json({ ...paged(rows, total, page, pageSize), unread });
}));
notificationsRouter.get('/unread-count', wrap(async (req, res) => {
  res.json({ unread: (await one('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user!.id])).n });
}));
notificationsRouter.post('/read-all', wrap(async (req, res) => {
  const r = await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL RETURNING id', [req.user!.id]);
  res.json({ updated: r.length });
}));
notificationsRouter.patch('/:id/read', wrap(async (req, res) => {
  const r = await one('UPDATE notifications SET read_at=COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2 RETURNING *', [z.string().uuid().parse(req.params.id), req.user!.id]);
  if (!r) throw notFound('Notification not found');
  res.json(r);
}));

notificationsRouter.get('/deliveries', requireAdmin, wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req);
  const rows = await query(`SELECT id, recipient, subject, status, attempts, last_error, sent_at, created_at, kind, website_id, incident_id FROM notification_deliveries ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`);
  const total = (await one('SELECT count(*)::int n FROM notification_deliveries')).n;
  res.json(paged(rows, total, page, pageSize));
}));

notificationsRouter.post('/test-email', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
  const to = b.to ?? req.user!.email;
  try {
    await sendTestEmail(to);
    await audit(req, 'notifications.test_email', 'smtp', undefined, { to, ok: true });
    res.json({ ok: true, to });
  } catch (e) {
    await audit(req, 'notifications.test_email', 'smtp', undefined, { to, ok: false });
    res.status(502).json({ error: { code: 'smtp_failed', message: (e as Error).message } });
  }
}));

// ---- notification settings
const SETTINGS_SCHEMA = z.object({
  alert_cooldown_minutes: z.coerce.number().int().min(0).max(1440),
  degraded_threshold_ms: z.coerce.number().int().min(100).max(120000),
  ssl_alert_days: z.array(z.coerce.number().int().min(1).max(365)).min(1).max(6),
  alert_recipients: z.array(z.string().email()).max(50),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone'),
  retention_checks_days: z.coerce.number().int().min(7).max(3650),
  retention_hourly_days: z.coerce.number().int().min(30).max(3650),
  retention_reports_days: z.coerce.number().int().min(1).max(3650),
  retention_audit_days: z.coerce.number().int().min(30).max(3650),
  retention_notifications_days: z.coerce.number().int().min(7).max(3650),
}).partial();

export const settingsRouter = Router();
settingsRouter.get('/', wrap(async (_req, res) => {
  const c = config();
  res.json({
    settings: await allSettings(),
    smtp: { configured: c.smtpConfigured, host: c.SMTP_HOST ?? null, port: c.SMTP_PORT, from: c.SMTP_FROM ?? null, user_set: Boolean(c.SMTP_USER) /* password is never returned */ },
    env_recipients: c.alertRecipients,
  });
}));
settingsRouter.put('/', requireAdmin, wrap(async (req, res) => {
  const b = SETTINGS_SCHEMA.parse(req.body);
  for (const [k, v] of Object.entries(b)) await setSetting(k, v, req.user!.id);
  await audit(req, 'settings.updated', 'settings', undefined, { keys: Object.keys(b) });
  res.json({ settings: await allSettings() });
}));
settingsRouter.patch('/me', wrap(async (req, res) => {
  const b = z.object({ notify_email: z.boolean(), notify_in_app: z.boolean() }).partial().parse(req.body);
  const keys = Object.keys(b) as Array<keyof typeof b>;
  if (keys.length) await query(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE id=$1`, [req.user!.id, ...keys.map((k) => b[k])]);
  res.json(await one('SELECT notify_email, notify_in_app FROM users WHERE id=$1', [req.user!.id]));
}));
settingsRouter.get('/me', wrap(async (req, res) => {
  res.json(await one('SELECT notify_email, notify_in_app FROM users WHERE id=$1', [req.user!.id]));
}));
