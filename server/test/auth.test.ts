import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { app, del, get, login, makeUser, PASSWORD, patch, post, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('authentication', () => {
  it('logs in with valid credentials, sets an HttpOnly SameSite cookie and returns a CSRF token', async () => {
    await makeUser('admin');
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.csrfToken).toBeTruthy();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/igo_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|"password"|argon2/i);
  });

  it('rejects wrong passwords and unknown users with the same message', async () => {
    await makeUser('admin');
    const a = await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'wrong' });
    const b = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    await makeUser('admin');
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'bad' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    const audit = await query("SELECT * FROM audit_logs WHERE action='auth.login_failed'");
    expect(audit.length).toBeGreaterThanOrEqual(6);
  });

  it('requires a session for protected routes', async () => {
    expect((await request(app).get('/api/v1/websites')).status).toBe(401);
    expect((await request(app).get('/api/v1/dashboard/summary')).status).toBe(401);
  });

  it('enforces CSRF on state-changing requests', async () => {
    const s = await login('admin');
    const noToken = await s.agent.post('/api/v1/websites').send({ name: 'x', url: 'https://x.example.com' });
    expect(noToken.status).toBe(403);
    const bad = await s.agent.post('/api/v1/websites').set('X-CSRF-Token', 'nope').send({ name: 'x', url: 'https://x.example.com' });
    expect(bad.status).toBe(403);
    const ok = await post(s, '/websites', { name: 'x', url: 'https://x.example.com' });
    expect(ok.status).toBe(201);
  });

  it('blocks cross-origin state changes', async () => {
    const s = await login('admin');
    const res = await s.agent.post('/api/v1/websites').set('Origin', 'https://evil.example').set('X-CSRF-Token', s.csrf).send({ name: 'x', url: 'https://x.example.com' });
    expect(res.status).toBe(403);
  });

  it('logout invalidates the session server-side', async () => {
    const s = await login('admin');
    expect((await get(s, '/auth/me')).status).toBe(200);
    await post(s, '/auth/logout');
    const cookieHeader = s.agent.get('/api/v1/auth/me');
    expect((await cookieHeader).status).toBe(401);
  });

  it('has no public registration or password-reset endpoint', async () => {
    const a = await login('admin');
    for (const p of ['/auth/register', '/auth/signup', '/auth/forgot-password', '/auth/reset-password']) {
      const anon = await request(app).post(`/api/v1${p}`).send({ email: 'a@b.co', password: PASSWORD });
      expect([401, 404]).toContain(anon.status); // never a success
      expect((await post(a, p, { email: 'a@b.co', password: PASSWORD })).status).toBe(404);
    }
    expect((await query('SELECT 1 FROM users WHERE email=$1', ['a@b.co'])).length).toBe(0);
  });

  it('forces a password change when required and enforces password strength', async () => {
    await makeUser('manager', 'm@example.com', { mustChange: true });
    const s = await login('manager', 'm@example.com');
    expect((await get(s, '/websites')).status).toBe(403);
    const weak = await post(s, '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const ok = await post(s, '/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another-Str0ng-Pass' });
    expect(ok.status).toBe(204);
    expect((await get(s, '/websites')).status).toBe(200);
  });

  it('stores Argon2id hashes only', async () => {
    await makeUser('admin');
    const [u] = await query('SELECT password_hash FROM users');
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('role permissions', () => {
  it('lets managers read but not administer', async () => {
    const m = await login('manager');
    expect((await get(m, '/websites')).status).toBe(200);
    expect((await get(m, '/dashboard/summary')).status).toBe(200);
    expect((await get(m, '/incidents')).status).toBe(200);
    expect((await post(m, '/websites', { name: 'x', url: 'https://x.example.com' })).status).toBe(403);
    expect((await get(m, '/users')).status).toBe(403);
    expect((await post(m, '/users', { email: 'z@example.com', name: 'Z', role: 'admin' })).status).toBe(403);
    expect((await get(m, '/audit-logs')).status).toBe(403);
    expect((await put403(m)).status).toBe(403);
    expect((await post(m, '/notifications/test-email', {})).status).toBe(403);
    expect((await post(m, '/integrations/ga4/test', {})).status).toBe(403);
  });

  it('lets managers use the user directory (for assignments) but never see password hashes', async () => {
    const m = await login('manager');
    await makeUser('admin');
    const res = await get(m, '/users/directory');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/hash/);
  });

  it('lets admins manage users; temporary passwords are shown once and force a change', async () => {
    const a = await login('admin');
    const res = await post(a, '/users', { email: 'mgr@example.com', name: 'Mgr', role: 'manager' });
    expect(res.status).toBe(201);
    const temp = res.body.temporaryPassword as string;
    expect(temp).toBeTruthy();
    const list = await get(a, '/users');
    expect(JSON.stringify(list.body)).not.toContain(temp);
    const l = await request(app).post('/api/v1/auth/login').send({ email: 'mgr@example.com', password: temp });
    expect(l.body.user.mustChangePassword).toBe(true);
  });

  it('refuses to remove the last administrator', async () => {
    const a = await login('admin');
    const r1 = await patch(a, `/users/${a.user.id}`, { role: 'manager' });
    expect(r1.status).toBe(400);
    const r2 = await patch(a, `/users/${a.user.id}`, { is_active: false });
    expect(r2.status).toBe(400);
  });

  it('deactivating a user revokes their sessions', async () => {
    const a = await login('admin');
    const m = await login('manager');
    expect((await get(m, '/websites')).status).toBe(200);
    expect((await patch(a, `/users/${m.user.id}`, { is_active: false })).status).toBe(200);
    expect((await get(m, '/websites')).status).toBe(401);
  });
});

function put403(m: Awaited<ReturnType<typeof login>>) {
  return m.agent.put('/api/v1/settings').set('X-CSRF-Token', m.csrf).send({ alert_cooldown_minutes: 1 });
}
void del;
