import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';

export const incidentsRouter = Router();
const id = (req: any) => z.string().uuid().parse(req.params.id);

const SELECT = `SELECT i.*, w.name AS website_name, w.url AS website_url, au.name AS assigned_name, ack.name AS acknowledged_name
  FROM incidents i JOIN websites w ON w.id = i.website_id LEFT JOIN users au ON au.id = i.assigned_to LEFT JOIN users ack ON ack.id = i.acknowledged_by`;

incidentsRouter.get(
  '/',
  wrap(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    const q = req.query;
    if (q.website_id) add('i.website_id = ?', String(q.website_id));
    if (q.severity) add('i.severity = ?', String(q.severity));
    if (q.kind) add('i.kind = ?', String(q.kind));
    if (q.status === 'open_all' || q.open === 'true') where.push("i.status <> 'resolved'");
    else if (q.status) add('i.status = ?', String(q.status));
    if (q.assigned_to === 'me') add('i.assigned_to = ?', req.user!.id);
    else if (q.assigned_to === 'none') where.push('i.assigned_to IS NULL');
    else if (q.assigned_to) add('i.assigned_to = ?', String(q.assigned_to));
    if (q.unacknowledged === 'true') where.push("i.acknowledged_at IS NULL AND i.status <> 'resolved'");
    if (q.from) add('i.started_at >= ?', new Date(String(q.from)));
    if (q.to) add('i.started_at < ?', new Date(String(q.to)));
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await query(`${SELECT} ${w} ORDER BY (i.status <> 'resolved') DESC, i.started_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*)::int n FROM incidents i ${w}`, params)).n;
    res.json(paged(rows, total, page, pageSize));
  }),
);

incidentsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const inc = await one(`${SELECT} WHERE i.id = $1`, [id(req)]);
    if (!inc) throw notFound('Incident not found');
    const events = await query(
      `SELECT e.id, e.at, e.type, e.message, e.data, u.name AS actor_name FROM incident_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.incident_id=$1 ORDER BY e.at, e.id`,
      [inc.id]);
    const deliveries = await query('SELECT id, recipient, status, attempts, last_error, sent_at, created_at, kind FROM notification_deliveries WHERE incident_id=$1 ORDER BY created_at', [inc.id]);
    const tasks = await query('SELECT id, title, status, priority, due_at FROM tasks WHERE incident_id=$1 ORDER BY created_at', [inc.id]);
    res.json({ ...inc, events, deliveries, tasks });
  }),
);

async function event(c: any, incidentId: string, type: string, message: string | null, req: any, data: object = {}) {
  await query('INSERT INTO incident_events (incident_id, type, message, actor_user_id, data) VALUES ($1,$2,$3,$4,$5)', [incidentId, type, message, req.user.id, JSON.stringify(data)], c);
}

async function lockIncident(c: any, incId: string) {
  const inc = await one('SELECT * FROM incidents WHERE id=$1 FOR UPDATE', [incId], c);
  if (!inc) throw notFound('Incident not found');
  return inc;
}

incidentsRouter.post('/:id/acknowledge', wrap(async (req, res) => {
  const out = await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    if (!['open', 'reopened'].includes(inc.status)) throw conflict(`Incident is ${inc.status}; only open incidents can be acknowledged`);
    const row = await one("UPDATE incidents SET status='acknowledged', acknowledged_at=now(), acknowledged_by=$2, updated_at=now() WHERE id=$1 RETURNING *", [inc.id, req.user!.id], c);
    await event(c, inc.id, 'acknowledged', null, req);
    return row;
  });
  await audit(req, 'incident.acknowledged', 'incident', out.id);
  res.json(out);
}));

incidentsRouter.post('/:id/investigate', wrap(async (req, res) => {
  const out = await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    if (inc.status === 'resolved') throw conflict('Incident is already resolved');
    const row = await one("UPDATE incidents SET status='investigating', acknowledged_at=COALESCE(acknowledged_at, now()), acknowledged_by=COALESCE(acknowledged_by, $2), updated_at=now() WHERE id=$1 RETURNING *", [inc.id, req.user!.id], c);
    await event(c, inc.id, 'status_change', 'Investigation started', req, { status: 'investigating' });
    return row;
  });
  res.json(out);
}));

incidentsRouter.post('/:id/assign', wrap(async (req, res) => {
  const b = z.object({ user_id: z.string().uuid().nullable() }).parse(req.body);
  const out = await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    let name = 'nobody';
    if (b.user_id) {
      const u = await one('SELECT id, name FROM users WHERE id=$1 AND is_active', [b.user_id], c);
      if (!u) throw badRequest('Assignee must be an active user');
      name = u.name;
    }
    const row = await one('UPDATE incidents SET assigned_to=$2, updated_at=now() WHERE id=$1 RETURNING *', [inc.id, b.user_id], c);
    await event(c, inc.id, 'assigned', `Assigned to ${name}`, req, { user_id: b.user_id });
    if (b.user_id && b.user_id !== req.user!.id) {
      await query(`INSERT INTO notifications (user_id, type, severity, title, body, link, website_id, incident_id) VALUES ($1,'incident_assigned','warning',$2,$3,$4,$5,$6)`,
        [b.user_id, `Incident assigned to you: ${inc.title}`, `Assigned by ${req.user!.name}`, `/incidents/${inc.id}`, inc.website_id, inc.id], c);
    }
    return row;
  });
  await audit(req, 'incident.assigned', 'incident', out.id, { user_id: b.user_id });
  res.json(out);
}));

incidentsRouter.post('/:id/notes', wrap(async (req, res) => {
  const b = z.object({ message: z.string().trim().min(1).max(5000) }).parse(req.body);
  await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    await event(c, inc.id, 'note', b.message, req);
  });
  res.status(201).json({ ok: true });
}));

incidentsRouter.post('/:id/resolve', wrap(async (req, res) => {
  const b = z.object({ note: z.string().max(5000).optional() }).parse(req.body ?? {});
  const out = await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    if (inc.status === 'resolved') throw conflict('Incident is already resolved');
    const duration = Math.max(0, Math.round((Date.now() - new Date(inc.started_at).getTime()) / 1000));
    const row = await one("UPDATE incidents SET status='resolved', resolved_at=now(), resolved_by=$2, duration_seconds=$3, auto_resolved=false, updated_at=now() WHERE id=$1 RETURNING *", [inc.id, req.user!.id, duration], c);
    await event(c, inc.id, 'resolved', b.note ?? 'Resolved manually', req, { auto: false, duration_seconds: duration });
    return row;
  });
  await audit(req, 'incident.resolved', 'incident', out.id);
  res.json(out);
}));

incidentsRouter.post('/:id/reopen', wrap(async (req, res) => {
  const b = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
  const out = await tx(async (c) => {
    const inc = await lockIncident(c, id(req));
    if (inc.status !== 'resolved') throw conflict('Only resolved incidents can be reopened');
    const clash = await one("SELECT id FROM incidents WHERE website_id=$1 AND dedupe_key=$2 AND status <> 'resolved'", [inc.website_id, inc.dedupe_key], c);
    if (clash) throw conflict('A newer incident for the same problem is already open', { existingId: clash.id });
    const row = await one("UPDATE incidents SET status='reopened', resolved_at=NULL, resolved_by=NULL, duration_seconds=NULL, auto_resolved=false, updated_at=now() WHERE id=$1 RETURNING *", [inc.id], c);
    await event(c, inc.id, 'reopened', b.reason ?? 'Reopened', req);
    return row;
  });
  await audit(req, 'incident.reopened', 'incident', out.id);
  res.json(out);
}));
