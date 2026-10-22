import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db.js';

export const SESSION_COOKIE = 'igo_session';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(userId: string, ip?: string, ua?: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const hours = config().SESSION_TTL_HOURS;
  await query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6)`,
    [sha(token), userId, csrf, hours, ip ?? null, (ua ?? '').slice(0, 300)],
  );
  return { token, csrf, maxAgeMs: hours * 3600_000 };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager';
  mustChangePassword: boolean;
  sessionId: string;
  csrf: string;
}

export async function loadSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const id = sha(token);
  const row = await one(
    `SELECT s.id AS sid, s.csrf_token, u.id, u.email, u.name, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
    [id],
  );
  if (!row) return null;
  // sliding "last seen" – cheap, best effort
  query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]).catch(() => undefined);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    mustChangePassword: row.must_change_password,
    sessionId: row.sid,
    csrf: row.csrf_token,
  };
}

export async function revokeSession(token: string) {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sha(token)]);
}
export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> COALESCE($2, \'\')', [
    userId,
    exceptSessionId ?? null,
  ]);
}
