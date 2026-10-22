import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db.js';

export interface Mailer {
  send(p: { to: string; subject: string; text: string; html?: string | null }): Promise<void>;
}

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
let override: Mailer | undefined;
export function setMailerForTests(m: Mailer | undefined) {
  override = m;
}

export function smtpConfigured() {
  return override ? true : config().smtpConfigured;
}

export function getMailer(): Mailer {
  if (override) return override;
  const c = config();
  transport ??= nodemailer.createTransport({
    host: c.SMTP_HOST,
    port: c.SMTP_PORT,
    secure: c.SMTP_SECURE || c.SMTP_PORT === 465,
    auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(p) {
      await transport!.sendMail({ from: c.SMTP_FROM, to: p.to, subject: p.subject, text: p.text, html: p.html ?? undefined });
    },
  };
}

/** Sanitise an SMTP error so that credentials can never reach the DB/UI. */
export function safeError(e: unknown): string {
  let m = String((e as any)?.message ?? e).slice(0, 300);
  const pw = config().SMTP_PASSWORD;
  if (pw) m = m.split(pw).join('[redacted]');
  return m;
}

const backoffSeconds = (attempt: number) => Math.min(3600, 60 * 2 ** (attempt - 1));

/** Drain pending deliveries. Safe to run from several workers (rows are leased with SKIP LOCKED). */
export async function processDeliveries(limit = 20): Promise<{ sent: number; failed: number; retried: number }> {
  const out = { sent: 0, failed: 0, retried: 0 };
  const rows = await query<any>(
    `UPDATE notification_deliveries d SET next_attempt_at = now() + interval '3 minutes', attempts = attempts + 1
      WHERE d.id IN (SELECT id FROM notification_deliveries WHERE status='pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.*`,
    [limit],
  );
  if (!rows.length) return out;
  if (!smtpConfigured()) {
    for (const d of rows) {
      await query("UPDATE notification_deliveries SET status='failed', last_error='SMTP is not configured (set SMTP_HOST and SMTP_FROM)' WHERE id=$1", [d.id]);
      await recordIncidentEvent(d, 'notification_failed', 'E-mail not sent: SMTP is not configured');
      out.failed++;
    }
    await query("UPDATE integrations SET status='not_connected', last_error='SMTP is not configured', last_error_at=now(), updated_at=now() WHERE kind='smtp'");
    return out;
  }
  const mailer = getMailer();
  for (const d of rows) {
    try {
      await mailer.send({ to: d.recipient, subject: d.subject, text: d.body_text, html: d.body_html });
      await query("UPDATE notification_deliveries SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1", [d.id]);
      await query("UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL, updated_at=now() WHERE kind='smtp'");
      await recordIncidentEvent(d, 'notification_sent', `E-mail delivered to ${d.recipient}`);
      out.sent++;
    } catch (e) {
      const msg = safeError(e);
      logger.warn({ delivery: d.id, attempts: d.attempts }, `email send failed: ${msg}`);
      await query("UPDATE integrations SET status='error', last_error=$1, last_error_at=now(), updated_at=now() WHERE kind='smtp'", [msg]);
      if (d.attempts >= d.max_attempts) {
        await query("UPDATE notification_deliveries SET status='failed', last_error=$2 WHERE id=$1", [d.id, msg]);
        await recordIncidentEvent(d, 'notification_failed', `E-mail to ${d.recipient} failed permanently: ${msg}`);
        out.failed++;
      } else {
        await query("UPDATE notification_deliveries SET last_error=$2, next_attempt_at = now() + make_interval(secs => $3) WHERE id=$1", [d.id, msg, backoffSeconds(d.attempts)]);
        out.retried++;
      }
    }
  }
  return out;
}

async function recordIncidentEvent(d: any, type: string, message: string) {
  if (!d.incident_id) return;
  await query('INSERT INTO incident_events (incident_id, type, message, data) VALUES ($1,$2,$3,$4)', [d.incident_id, type, message, JSON.stringify({ delivery_id: d.id, recipient: d.recipient })]);
}

export async function sendTestEmail(to: string) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST and SMTP_FROM)');
  try {
    await getMailer().send({ to, subject: 'Test e-mail from the monitoring dashboard', text: 'If you can read this, SMTP is working.' });
    await query("UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL, updated_at=now() WHERE kind='smtp'");
  } catch (e) {
    const msg = safeError(e);
    await query("UPDATE integrations SET status='error', last_error=$1, last_error_at=now(), updated_at=now() WHERE kind='smtp'", [msg]);
    throw new Error(msg, { cause: e });
  }
}
