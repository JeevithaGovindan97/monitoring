import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { forbidden, unauthorized } from '../lib/errors.js';
import { loadSession, SESSION_COOKIE, type SessionUser } from './sessions.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Loads the session (if any) and enforces CSRF on state-changing requests. */
export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await loadSession(req.cookies?.[SESSION_COOKIE]);
    if (user) {
      req.user = user;
      if (!SAFE.has(req.method)) {
        const sent = req.get('x-csrf-token') ?? '';
        if (!safeEq(sent, user.csrf)) return next(forbidden('Missing or invalid CSRF token'));
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.mustChangePassword && !req.originalUrl.startsWith('/api/v1/auth/')) {
    return next(forbidden('You must change your password before continuing'));
  }
  next();
}

export const requireRole =
  (...roles: Array<'admin' | 'manager'>) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const requireAdmin = requireRole('admin');
