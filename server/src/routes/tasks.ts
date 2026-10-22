import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';

export const tasksRouter = Router();
const id = (req: any) => z.string().uuid().parse(req.params.id);

const PRIORITY = ['critical', 'high', 'medium', 'low'] as const;
const STATUS = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] as const;

const SELECT = `SELECT t.*, w.name AS website_name, au.name AS assigned_name, cu.name AS created_name,
  (t.due_at IS NOT NULL AND t.due_at < now() AND t.status IN ('open','in_progress','blocked')) AS overdue
  FROM tasks t LEFT JOIN websites w ON w.id = t.website_id LEFT JOIN users au ON au.id = t.assigned_to LEFT JOIN users cu ON cu.id = t.created_by`;

tasksRouter.get('/', wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  const q = req.query;
  if (q.status === 'pending') where.push("t.status IN ('open','in_progress','blocked')");
  else if (q.status) add('t.status = ?', String(q.status));
  if (q.priority) add('t.priority = ?', String(q.priority));
  if (q.website_id) add('t.website_id = ?', String(q.website_id));
  if (q.incident_id) add('t.incident_id = ?', String(q.incident_id));
  if (q.assigned_to === 'me') add('t.assigned_to = ?', req.user!.id);
  else if (q.assigned_to) add('t.assigned_to = ?', String(q.assigned_to));
  if (q.overdue === 'true') where.push("t.due_at < now() AND t.status IN ('open','in_progress','blocked')");
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await query(`${SELECT} ${w} ORDER BY (t.status IN ('completed','cancelled')), t.due_at NULLS LAST, t.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  const total = (await one(`SELECT count(*)::int n FROM tasks t ${w}`, params)).n;
  res.json(paged(rows, total, page, pageSize));
}));

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).nullish(),
  website_id: z.string().uuid().nullish(),
  incident_id: z.string().uuid().nullish(),
  assigned_to: z.string().uuid().nullish(),
  priority: z.enum(PRIORITY).default('medium'),
  due_at: z.coerce.date().nullish(),
});

async function addEvent(c: any, taskId: string, type: string, message: string | null, actor: string | null, data: object = {}) {
  await query('INSERT INTO task_events (task_id, type, message, actor_user_id, data) VALUES ($1,$2,$3,$4,$5)', [taskId, type, message, actor, JSON.stringify(data)], c ?? undefined);
}

tasksRouter.post('/', wrap(async (req, res) => {
  const b = createSchema.parse(req.body);
  const row = await tx(async (c) => {
    if (b.assigned_to && !(await one('SELECT 1 FROM users WHERE id=$1 AND is_active', [b.assigned_to], c))) throw badRequest('Assignee must be an active user');
    if (b.incident_id && !b.website_id) {
      const inc = await one('SELECT website_id FROM incidents WHERE id=$1', [b.incident_id], c);
      if (!inc) throw badRequest('Incident not found');
      b.website_id = inc.website_id;
    }
    const t = await one(
      `INSERT INTO tasks (title, description, website_id, incident_id, assigned_to, priority, due_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.title, b.description ?? null, b.website_id ?? null, b.incident_id ?? null, b.assigned_to ?? null, b.priority, b.due_at ?? null, req.user!.id], c);
    await addEvent(c, t.id, 'created', 'Task created', req.user!.id);
    if (b.assigned_to && b.assigned_to !== req.user!.id) {
      await query(`INSERT INTO notifications (user_id, type, severity, title, body, link, website_id, task_id) VALUES ($1,'task_assigned','info',$2,$3,$4,$5,$6)`,
        [b.assigned_to, `Task assigned to you: ${b.title}`, `Assigned by ${req.user!.name}`, `/tasks?open=${t.id}`, b.website_id ?? null, t.id], c);
    }
    return t;
  });
  await audit(req, 'task.created', 'task', row.id);
  res.status(201).json(row);
}));

tasksRouter.get('/:id', wrap(async (req, res) => {
  const t = await one(`${SELECT} WHERE t.id = $1`, [id(req)]);
  if (!t) throw notFound('Task not found');
  const events = await query('SELECT e.*, u.name AS actor_name FROM task_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE task_id=$1 ORDER BY at, id', [t.id]);
  res.json({ ...t, events });
}));

// NB: no .partial() on createSchema – its priority default would silently reset the priority on every PATCH.
const patchSchema = z.object({
  title: createSchema.shape.title.optional(), description: createSchema.shape.description, website_id: createSchema.shape.website_id,
  incident_id: createSchema.shape.incident_id, assigned_to: createSchema.shape.assigned_to, due_at: createSchema.shape.due_at,
  priority: z.enum(PRIORITY).optional(), status: z.enum(STATUS).optional(),
});

tasksRouter.patch('/:id', wrap(async (req, res) => {
  const b = patchSchema.parse(req.body);
  const row = await tx(async (c) => {
    const cur = await one('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id(req)], c);
    if (!cur) throw notFound('Task not found');
    // Managers may change tasks they created or that are assigned to them (or unassigned); admins may change any task.
    if (req.user!.role === 'manager' && cur.assigned_to && cur.assigned_to !== req.user!.id && cur.created_by !== req.user!.id) {
      throw forbidden('Managers can only modify tasks assigned to them or created by them');
    }
    const keys = (Object.keys(b) as Array<keyof typeof b>).filter((k) => b[k] !== undefined);
    if (!keys.length) return cur;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const vals = keys.map((k) => b[k]);
    if (b.status) sets.push(b.status === 'completed' ? 'completed_at = now()' : 'completed_at = NULL');
    const t = await one(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [cur.id, ...vals], c);
    for (const k of keys) {
      if (cur[k] instanceof Date ? cur[k].getTime() !== (b[k] as any)?.getTime?.() : cur[k] !== b[k]) {
        await addEvent(c, cur.id, k === 'status' ? 'status_change' : 'updated', `${k} changed`, req.user!.id, { field: k, from: cur[k], to: b[k] });
      }
    }
    if (b.assigned_to && b.assigned_to !== cur.assigned_to && b.assigned_to !== req.user!.id) {
      await query(`INSERT INTO notifications (user_id, type, severity, title, body, link, website_id, task_id) VALUES ($1,'task_assigned','info',$2,$3,$4,$5,$6)`,
        [b.assigned_to, `Task assigned to you: ${cur.title}`, `Assigned by ${req.user!.name}`, `/tasks?open=${cur.id}`, cur.website_id, cur.id], c);
    }
    return t;
  });
  await audit(req, 'task.updated', 'task', row.id, { fields: Object.keys(b) });
  res.json(row);
}));

tasksRouter.post('/:id/comments', wrap(async (req, res) => {
  const b = z.object({ message: z.string().trim().min(1).max(5000) }).parse(req.body);
  const t = await one('SELECT id FROM tasks WHERE id=$1', [id(req)]);
  if (!t) throw notFound('Task not found');
  await addEvent(null, t.id, 'comment', b.message, req.user!.id);
  res.status(201).json({ ok: true });
}));

tasksRouter.delete('/:id', requireAdmin, wrap(async (req, res) => {
  const r = await query('DELETE FROM tasks WHERE id=$1 RETURNING id', [id(req)]);
  if (!r.length) throw notFound('Task not found');
  await audit(req, 'task.deleted', 'task', id(req));
  res.status(204).end();
}));

// ---- escalation rules (admin)
export const escalationRouter = Router();
escalationRouter.get('/', wrap(async (_req, res) => {
  res.json({ data: await query('SELECT r.*, u.name AS notify_user_name FROM escalation_rules r LEFT JOIN users u ON u.id=r.notify_user_id ORDER BY r.created_at') });
}));
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.enum(['incident', 'task']),
  min_severity: z.enum(PRIORITY).nullish(),
  after_minutes: z.coerce.number().int().min(1).max(60 * 24 * 30),
  only_unacknowledged: z.boolean().default(true),
  notify_role: z.enum(['admin', 'manager']).nullish(),
  notify_user_id: z.string().uuid().nullish(),
  enabled: z.boolean().default(true),
}).refine((r) => r.notify_role || r.notify_user_id, { message: 'Choose a role or a user to notify' });
escalationRouter.post('/', requireAdmin, wrap(async (req, res) => {
  const b = ruleSchema.parse(req.body);
  const row = await one(`INSERT INTO escalation_rules (name,subject,min_severity,after_minutes,only_unacknowledged,notify_role,notify_user_id,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [b.name, b.subject, b.min_severity ?? null, b.after_minutes, b.only_unacknowledged, b.notify_role ?? null, b.notify_user_id ?? null, b.enabled]);
  await audit(req, 'escalation_rule.created', 'escalation_rule', row.id);
  res.status(201).json(row);
}));
escalationRouter.patch('/:id', requireAdmin, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(120), min_severity: z.enum(PRIORITY).nullable(), after_minutes: z.coerce.number().int().min(1), only_unacknowledged: z.boolean(), enabled: z.boolean() }).partial().parse(req.body);
  const keys = Object.keys(b) as Array<keyof typeof b>;
  if (!keys.length) throw badRequest('No fields to update');
  const row = await one(`UPDATE escalation_rules SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`, [id(req), ...keys.map((k) => b[k])]);
  if (!row) throw notFound('Rule not found');
  await audit(req, 'escalation_rule.updated', 'escalation_rule', row.id);
  res.json(row);
}));
escalationRouter.delete('/:id', requireAdmin, wrap(async (req, res) => {
  const r = await query('DELETE FROM escalation_rules WHERE id=$1 RETURNING id', [id(req)]);
  if (!r.length) throw notFound('Rule not found');
  await audit(req, 'escalation_rule.deleted', 'escalation_rule', id(req));
  res.status(204).end();
}));
