import { query, tx } from '../db.js';
import { config } from '../config.js';

const SEV_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

async function targets(c: any, rule: { notify_role: string | null; notify_user_id: string | null }) {
  if (rule.notify_user_id) return query<{ id: string; email: string; notify_email: boolean; notify_in_app: boolean }>('SELECT id, email, notify_email, notify_in_app FROM users WHERE id=$1 AND is_active', [rule.notify_user_id], c);
  return query<{ id: string; email: string; notify_email: boolean; notify_in_app: boolean }>('SELECT id, email, notify_email, notify_in_app FROM users WHERE role=$1 AND is_active', [rule.notify_role], c);
}

/**
 * Applies escalation rules. `escalations_sent(rule_id, subject_id)` has a primary key, so an escalation
 * for a given rule fires AT MOST ONCE per incident/task: no loops, no duplicate floods.
 */
export async function runEscalations(): Promise<{ escalated: number }> {
  const rules = await query<any>('SELECT * FROM escalation_rules WHERE enabled');
  let escalated = 0;
  for (const rule of rules) {
    const minRank = SEV_RANK[rule.min_severity ?? 'low']!;
    if (rule.subject === 'incident') {
      const incs = await query<any>(
        `SELECT i.*, w.name AS website_name FROM incidents i JOIN websites w ON w.id=i.website_id
          WHERE i.status <> 'resolved' AND i.detected_at <= now() - make_interval(mins => $1)
            AND ($2::boolean = false OR i.acknowledged_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM escalations_sent e WHERE e.rule_id=$3 AND e.subject_id=i.id)`,
        [rule.after_minutes, rule.only_unacknowledged, rule.id]);
      for (const i of incs.filter((x) => (SEV_RANK[x.severity] ?? 0) >= minRank)) {
        await tx(async (c) => {
          const ins = await query('INSERT INTO escalations_sent (rule_id, subject_type, subject_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1', [rule.id, 'incident', i.id], c);
          if (!ins.length) return;
          const title = `ESCALATION: ${i.title} still ${i.acknowledged_at ? 'unresolved' : 'unacknowledged'} after ${rule.after_minutes} min`;
          const body = `Rule "${rule.name}" · severity ${i.severity} · ${i.website_name}`;
          for (const u of await targets(c, rule)) {
            if (u.notify_in_app) await query(`INSERT INTO notifications (user_id,type,severity,title,body,link,website_id,incident_id,dedupe_key) VALUES ($1,'escalation','critical',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [u.id, title, body, `/incidents/${i.id}`, i.website_id, i.id, `esc:${rule.id}:${i.id}`], c);
            if (u.notify_email) await query(`INSERT INTO notification_deliveries (recipient,subject,body_text,dedupe_key,kind,website_id,incident_id) VALUES ($1,$2,$3,$4,'escalation',$5,$6) ON CONFLICT DO NOTHING`,
              [u.email.toLowerCase(), `[ESCALATION] ${i.website_name}: ${i.title}`, `${title}\n${body}\n\n${config().APP_BASE_URL}/incidents/${i.id}`, `esc:${rule.id}:${i.id}`, i.website_id, i.id], c);
          }
          await query("INSERT INTO incident_events (incident_id,type,message,data) VALUES ($1,'escalated',$2,$3)", [i.id, `Escalated by rule "${rule.name}"`, JSON.stringify({ rule_id: rule.id })], c);
          escalated++;
        });
      }
    } else {
      const tasks = await query<any>(
        `SELECT t.*, w.name AS website_name FROM tasks t LEFT JOIN websites w ON w.id=t.website_id
          WHERE t.status IN ('open','in_progress','blocked') AND t.due_at IS NOT NULL AND t.due_at <= now() - make_interval(mins => $1)
            AND NOT EXISTS (SELECT 1 FROM escalations_sent e WHERE e.rule_id=$2 AND e.subject_id=t.id)`, [rule.after_minutes, rule.id]);
      for (const t of tasks.filter((x) => (SEV_RANK[x.priority] ?? 0) >= minRank)) {
        await tx(async (c) => {
          const ins = await query('INSERT INTO escalations_sent (rule_id, subject_type, subject_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1', [rule.id, 'task', t.id], c);
          if (!ins.length) return;
          const title = `Overdue task escalated: ${t.title}`;
          for (const u of await targets(c, rule)) {
            if (u.notify_in_app) await query(`INSERT INTO notifications (user_id,type,severity,title,body,link,website_id,task_id,dedupe_key) VALUES ($1,'escalation','warning',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [u.id, title, `Rule "${rule.name}" · was due ${new Date(t.due_at).toISOString()}`, `/tasks?open=${t.id}`, t.website_id, t.id, `esc:${rule.id}:${t.id}`], c);
            if (u.notify_email) await query(`INSERT INTO notification_deliveries (recipient,subject,body_text,dedupe_key,kind,website_id) VALUES ($1,$2,$3,$4,'escalation',$5) ON CONFLICT DO NOTHING`,
              [u.email.toLowerCase(), `[ESCALATION] ${title}`, `${title}\nRule "${rule.name}"\n\n${config().APP_BASE_URL}/tasks?open=${t.id}`, `esc:${rule.id}:${t.id}`, t.website_id], c);
          }
          await query("INSERT INTO task_events (task_id,type,message,data) VALUES ($1,'escalated',$2,$3)", [t.id, `Escalated by rule "${rule.name}"`, JSON.stringify({ rule_id: rule.id })], c);
          escalated++;
        });
      }
    }
  }
  return { escalated };
}
