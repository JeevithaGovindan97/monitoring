import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { closePool, getPool, one, query } from '../src/db.js';
import type { CreateWebsite } from '../src/lib/website-schema.js';
import { createWebsite } from '../src/lib/website-service.js';

export const PASSWORD = 'Sup3r-Secret-Passw0rd';
export const app = createApp();

export async function resetDb() {
  await getPool().query(`TRUNCATE users, websites, incidents, tasks, notifications, notification_deliveries, report_jobs, audit_logs,
    maintenance_windows, escalation_rules, scheduled_job_runs, worker_heartbeats, analytics_daily, search_console_daily, search_console_top,
    performance_audits, ssl_checks, uptime_hourly, uptime_daily, website_checks, form_checks, escalations_sent CASCADE`);
  await query("UPDATE integrations SET status='not_connected', last_success_at=NULL, last_error=NULL");
  await query("UPDATE system_settings SET value='[]' WHERE key='alert_recipients'");
  await query("UPDATE system_settings SET value='30' WHERE key='alert_cooldown_minutes'");
}

export async function makeUser(role: 'admin' | 'manager', email = `${role}@example.com`, opts: { mustChange?: boolean } = {}) {
  return one(
    'INSERT INTO users (email,name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [email, `${role[0]!.toUpperCase()}${role.slice(1)} User`, role, await hashPassword(PASSWORD), opts.mustChange ?? false],
  );
}

export interface Session { agent: ReturnType<typeof request.agent>; csrf: string; user: any }

export async function login(role: 'admin' | 'manager', email = `${role}@example.com`): Promise<Session> {
  let user = await one('SELECT * FROM users WHERE email=$1', [email]);
  user ??= await makeUser(role, email);
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    agent, csrf: res.body.csrfToken, user,
  };
}

export const post = (s: Session, url: string, body?: object) => s.agent.post(`/api/v1${url}`).set('X-CSRF-Token', s.csrf).send(body ?? {});
export const patch = (s: Session, url: string, body?: object) => s.agent.patch(`/api/v1${url}`).set('X-CSRF-Token', s.csrf).send(body ?? {});
export const put = (s: Session, url: string, body?: object) => s.agent.put(`/api/v1${url}`).set('X-CSRF-Token', s.csrf).send(body ?? {});
export const del = (s: Session, url: string) => s.agent.delete(`/api/v1${url}`).set('X-CSRF-Token', s.csrf);
export const get = (s: Session, url: string) => s.agent.get(`/api/v1${url}`);

export async function makeSite(over: Partial<CreateWebsite> & { name?: string; url?: string } = {}) {
  const n = Math.random().toString(36).slice(2, 8);
  const input = {
    name: `Site ${n}`, url: `https://${n}.example.com`, hosting_type: 'vps', environment: 'production', criticality: 'medium', monitoring_status: 'active',
    expected_status: '200-399', check_interval_seconds: 300, timeout_ms: 10000, max_redirects: 5, fail_threshold: 2, recover_threshold: 2,
    ssl_check_enabled: true, ssl_failure_is_outage: false, performance_audit_enabled: true, performance_interval_hours: 24, form_type: 'none',
    ga4_status: 'not_connected', gsc_status: 'not_connected', ...over,
  } as CreateWebsite;
  return createWebsite(input, null);
}

export { closePool };
