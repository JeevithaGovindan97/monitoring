import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { dummyHash, hashPassword, passwordProblems, verifyPassword } from '../auth/password.js';
import { createSession, revokeAllSessions, revokeSession, SESSION_COOKIE } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { audit } from '../lib/audit.js';
import { badRequest, unauthorized, wrap } from '../lib/errors.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many login attempts. Try again later.' } },
});

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function cookieOpts(maxAgeMs?: number) {
  return { httpOnly: true, sameSite: 'strict' as const, secure: config().cookieSecure, path: '/', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) };
}

authRouter.post(
  '/login',
  loginLimiter,
  wrap(async (req, res) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
    const fail = async (reason: string) => {
      await audit(req, 'auth.login_failed', 'user', user?.id, { email: body.email, reason }, undefined, { email: body.email });
      throw unauthorized('Invalid email or password');
    };
    if (!user) {
      await verifyPassword(await dummyHash(), body.password); // equalise timing
      return fail('unknown_user');
    }
    if (!user.is_active) return fail('inactive');
    if (user.locked_until && new Date(user.locked_until) > new Date()) return fail('locked');
    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok) {
      const n = user.failed_login_count + 1;
      await query(
        `UPDATE users SET failed_login_count = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE id = $1`,
        [user.id, n, MAX_FAILED, LOCK_MINUTES],
      );
      return fail('bad_password');
    }
    await query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const s = await createSession(user.id, req.ip, req.get('user-agent'));
    res.cookie(SESSION_COOKIE, s.token, cookieOpts(s.maxAgeMs));
    await audit(req, 'auth.login', 'user', user.id, {}, undefined, { id: user.id, email: user.email });
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.must_change_password },
      csrfToken: s.csrf,
    });
  }),
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await revokeSession(token);
    if (req.user) await audit(req, 'auth.logout', 'user', req.user.id);
    res.clearCookie(SESSION_COOKIE, cookieOpts());
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  wrap(async (req, res) => {
    if (!req.user) throw unauthorized();
    const u = req.user;
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword }, csrfToken: u.csrf });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }).parse(req.body);
    const user = await one('SELECT * FROM users WHERE id = $1', [req.user!.id]);
    if (!user || !(await verifyPassword(user.password_hash, body.currentPassword))) throw badRequest('Current password is incorrect');
    const problem = passwordProblems(body.newPassword);
    if (problem) throw badRequest(problem);
    if (body.newPassword === body.currentPassword) throw badRequest('New password must differ from the current one');
    await query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
      user.id,
      await hashPassword(body.newPassword),
    ]);
    await revokeAllSessions(user.id, req.user!.sessionId);
    await audit(req, 'auth.password_changed', 'user', user.id);
    res.status(204).end();
  }),
);
