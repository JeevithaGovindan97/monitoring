import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { generatePassword, hashPassword, passwordProblems } from '../auth/password.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';

export const usersRouter = Router();
const COLS = 'id, email, name, role, is_active, must_change_password, notify_email, notify_in_app, last_login_at, created_at, locked_until';

// Light list for assignment dropdowns – available to managers too.
usersRouter.get(
  '/directory',
  wrap(async (_req, res) => {
    res.json({ data: await query('SELECT id, name, email, role FROM users WHERE is_active ORDER BY name') });
  }),
);

usersRouter.use(requireAdmin);

usersRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json({ data: await query(`SELECT ${COLS} FROM users ORDER BY created_at`) });
  }),
);

const createSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['admin', 'manager']),
  password: z.string().optional(),
});

usersRouter.post(
  '/',
  wrap(async (req, res) => {
    const b = createSchema.parse(req.body);
    let password = b.password;
    let generated = false;
    if (password) {
      const p = passwordProblems(password);
      if (p) throw badRequest(p);
    } else {
      password = generatePassword();
      generated = true;
    }
    const exists = await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email]);
    if (exists) throw conflict('A user with this e-mail already exists');
    const row = await one(
      `INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,true) RETURNING ${COLS}`,
      [b.email.trim(), b.name, b.role, await hashPassword(password)],
    );
    await audit(req, 'user.created', 'user', row.id, { email: b.email, role: b.role });
    // The temporary password is shown exactly once and is never stored in clear text.
    res.status(201).json({ user: row, temporaryPassword: generated ? password : undefined });
  }),
);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['admin', 'manager']).optional(),
  is_active: z.boolean().optional(),
  notify_email: z.boolean().optional(),
  notify_in_app: z.boolean().optional(),
});

async function assertNotLastAdmin(id: string, becomingNonAdmin: boolean) {
  if (!becomingNonAdmin) return;
  const r = await one("SELECT count(*)::int AS n FROM users WHERE role='admin' AND is_active AND id <> $1", [id]);
  if (r.n === 0) throw badRequest('At least one active administrator is required');
}

usersRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const b = patchSchema.parse(req.body);
    const cur = await one('SELECT * FROM users WHERE id = $1', [id]);
    if (!cur) throw notFound('User not found');
    await assertNotLastAdmin(id, cur.role === 'admin' && (b.role === 'manager' || b.is_active === false));
    const keys = Object.keys(b) as Array<keyof typeof b>;
    if (!keys.length) return res.json({ user: cur });
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const row = await one(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, ...keys.map((k) => b[k])]);
    if (b.is_active === false || (b.role && b.role !== cur.role)) await revokeAllSessions(id);
    await audit(req, 'user.updated', 'user', id, b);
    res.json({ user: row });
  }),
);

usersRouter.post(
  '/:id/reset-password',
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const cur = await one('SELECT id FROM users WHERE id = $1', [id]);
    if (!cur) throw notFound('User not found');
    const password = generatePassword();
    await query('UPDATE users SET password_hash=$2, must_change_password=true, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE id=$1', [
      id,
      await hashPassword(password),
    ]);
    await revokeAllSessions(id);
    await audit(req, 'user.password_reset', 'user', id);
    res.json({ temporaryPassword: password });
  }),
);
