import { config } from '../config.js';
import { query, one, type Queryable } from '../db.js';
import { getSetting } from '../lib/settings.js';

export interface NotifyContext {
  incident: { id: string; title: string; severity: string; kind: string; started_at: Date; resolved_at?: Date | null; duration_seconds?: number | null };
  website: { id: string; name: string; url: string; alert_preferences?: { email?: boolean; in_app?: boolean } };
  event: 'opened' | 'recovered' | 'escalated' | 'ssl' | 'form_opened' | 'form_recovered';
  detail?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtDuration(sec?: number | null) {
  if (sec === null || sec === undefined) return 'n/a';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', !h && !m ? `${s}s` : ''].filter(Boolean).join(' ');
}

export function composeMessage(ctx: NotifyContext) {
  const link = `${config().APP_BASE_URL.replace(/\/$/, '')}/incidents/${ctx.incident.id}`;
  const { incident: i, website: w } = ctx;
  let headline: string;
  switch (ctx.event) {
    case 'opened': headline = `DOWN: ${w.name}`; break;
    case 'recovered': headline = `RECOVERED: ${w.name}`; break;
    case 'escalated': headline = `ESCALATION: ${w.name}`; break;
    case 'ssl': headline = `SSL: ${w.name}`; break;
    case 'form_opened': headline = `FORM CHECK FAILING: ${w.name}`; break;
    case 'form_recovered': headline = `FORM CHECK RECOVERED: ${w.name}`; break;
  }
  const lines = [
    `Website: ${w.name} (${w.url})`,
    `Incident: ${i.title}`,
    `Severity: ${i.severity}`,
    `Started: ${new Date(i.started_at).toISOString()}`,
    ...(i.resolved_at ? [`Resolved: ${new Date(i.resolved_at).toISOString()}`, `Duration: ${fmtDuration(i.duration_seconds)}`] : []),
    ...(ctx.detail ? [`Details: ${ctx.detail}`] : []),
    `Dashboard: ${link}`,
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><h3>${esc(headline)}</h3><ul>${lines
    .filter((l) => !l.startsWith('Dashboard'))
    .map((l) => `<li>${esc(l)}</li>`)
    .join('')}</ul><p><a href="${esc(link)}">Open in dashboard</a></p></div>`;
  return { subject: `[${i.severity.toUpperCase()}] ${headline}`, text: lines.join('\n'), html, headline, link };
}

export async function emailRecipients(): Promise<string[]> {
  const users = await query<{ email: string }>('SELECT email FROM users WHERE is_active AND notify_email');
  const extra = await getSetting<string[]>('alert_recipients', []);
  return [...new Set([...users.map((u) => u.email), ...config().alertRecipients, ...extra].map((e) => e.toLowerCase()))];
}

/**
 * Creates in-dashboard notifications and queued e-mail deliveries for an incident event.
 * Nothing is claimed as "sent" here: deliveries start as `pending` and are marked by the e-mail sender.
 * Deduplication is enforced by unique indexes on (user, dedupe_key) and (dedupe_key, recipient).
 */
export async function notifyIncident(ctx: NotifyContext, q: Queryable) {
  const msg = composeMessage(ctx);
  const prefs = { email: true, in_app: true, ...(ctx.website.alert_preferences ?? {}) };
  const dedupe = `incident:${ctx.incident.id}:${ctx.event}`;
  const severity = ctx.incident.severity === 'critical' || ctx.incident.severity === 'high' ? 'critical' : 'warning';
  const isRecovery = ctx.event === 'recovered' || ctx.event === 'form_recovered';

  if (prefs.in_app) {
    await query(
      `INSERT INTO notifications (user_id, type, severity, title, body, link, website_id, incident_id, dedupe_key)
       SELECT id, $1, $2, $3, $4, $5, $6, $7, $8 FROM users WHERE is_active AND notify_in_app
       ON CONFLICT DO NOTHING`,
      [`incident_${ctx.event}`, isRecovery ? 'info' : severity, msg.headline, msg.text.split('\n').slice(0, 4).join(' · '), `/incidents/${ctx.incident.id}`, ctx.website.id, ctx.incident.id, dedupe],
      q,
    );
  }
  if (!prefs.email) return { emails: 0 };

  const recipients = await emailRecipients();
  const cooldown = await getSetting<number>('alert_cooldown_minutes', 30);
  let suppressReason: string | null = null;
  if (ctx.event === 'opened' || ctx.event === 'form_opened') {
    // Flap protection: another alert for this website within the cooldown window suppresses this one.
    const recent = await one(
      `SELECT 1 FROM notification_deliveries WHERE website_id = $1 AND kind = 'incident_opened' AND status IN ('pending','sent')
          AND incident_id <> $2 AND created_at > now() - make_interval(mins => $3) LIMIT 1`,
      [ctx.website.id, ctx.incident.id, cooldown],
      q,
    );
    if (recent) suppressReason = `suppressed: alert cooldown (${cooldown} min) for this website`;
  } else if (isRecovery) {
    const opened = await one(
      `SELECT 1 FROM notification_deliveries WHERE incident_id = $1 AND kind = 'incident_opened' AND status IN ('pending','sent') LIMIT 1`,
      [ctx.incident.id],
      q,
    );
    if (!opened) suppressReason = 'suppressed: no outage alert was delivered for this incident';
  }
  let n = 0;
  for (const to of recipients) {
    const r = await query(
      `INSERT INTO notification_deliveries (recipient, subject, body_text, body_html, status, last_error, dedupe_key, kind, website_id, incident_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [to, msg.subject, msg.text, msg.html, suppressReason ? 'suppressed' : 'pending', suppressReason, dedupe,
       isRecovery ? 'incident_recovered' : ctx.event === 'opened' || ctx.event === 'form_opened' ? 'incident_opened' : `incident_${ctx.event}`,
       ctx.website.id, ctx.incident.id],
      q,
    );
    n += r.length;
  }
  return { emails: n };
}

/** Plain admin/system notification (e.g. backup failed, integration failing). */
export async function notifyAdmins(
  q: Queryable,
  p: { type: string; title: string; body?: string; link?: string; severity?: 'info' | 'warning' | 'critical'; dedupeKey?: string; email?: boolean; websiteId?: string },
) {
  await query(
    `INSERT INTO notifications (user_id, type, severity, title, body, link, website_id, dedupe_key)
     SELECT id, $1, $2, $3, $4, $5, $6, $7 FROM users WHERE is_active AND notify_in_app AND role = 'admin' ON CONFLICT DO NOTHING`,
    [p.type, p.severity ?? 'warning', p.title, p.body ?? null, p.link ?? null, p.websiteId ?? null, p.dedupeKey ?? null],
    q,
  );
  if (p.email) {
    const admins = await query<{ email: string }>("SELECT email FROM users WHERE is_active AND notify_email AND role='admin'");
    const to = [...new Set([...admins.map((a) => a.email), ...config().alertRecipients])];
    for (const r of to) {
      await query(
        `INSERT INTO notification_deliveries (recipient, subject, body_text, status, dedupe_key, kind, website_id)
         VALUES ($1,$2,$3,'pending',$4,$5,$6) ON CONFLICT DO NOTHING`,
        [r, `[${(p.severity ?? 'warning').toUpperCase()}] ${p.title}`, `${p.title}\n\n${p.body ?? ''}\n\n${config().APP_BASE_URL}${p.link ?? ''}`, p.dedupeKey ?? null, p.type, p.websiteId ?? null],
        q,
      );
    }
  }
}
