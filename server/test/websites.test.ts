import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { del, get, login, makeSite, patch, post, resetDb } from './helpers.js';

beforeEach(resetDb);

describe('website inventory', () => {
  it('creates, reads, updates and deletes a website', async () => {
    const a = await login('admin');
    const c = await post(a, '/websites', { name: 'Shop', url: 'https://shop.example.com', criticality: 'critical', hosting_type: 'dokploy', owner: 'Ana' });
    expect(c.status).toBe(201);
    expect(c.body.check_interval_seconds).toBe(300);
    expect(c.body.expected_status).toBe('200-399');
    const id = c.body.id;
    const r = await get(a, `/websites/${id}`);
    expect(r.body.effective_state).toBe('unknown'); // never checked ⇒ never shown as online
    const u = await patch(a, `/websites/${id}`, { name: 'Shop 2', check_interval_seconds: 600, notes: 'hello' });
    expect(u.status).toBe(200);
    expect(u.body.check_interval_seconds).toBe(600);
    expect((await del(a, `/websites/${id}`)).status).toBe(204);
    expect((await get(a, `/websites/${id}`)).status).toBe(404);
    const log = await query("SELECT action FROM audit_logs WHERE entity_type='website' ORDER BY id");
    expect(log.map((l) => l.action)).toEqual(['website.created', 'website.updated', 'website.deleted']);
  });

  it('rejects unsupported schemes, credentials, private and metadata targets', async () => {
    const a = await login('admin');
    for (const url of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1',
      'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://user:pw@example.com', 'http://2130706433', 'not a url', 'http://foo.internal']) {
      const res = await post(a, '/websites', { name: 'bad', url });
      expect(res.status, url).toBe(400);
    }
  });

  it('validates fields', async () => {
    const a = await login('admin');
    expect((await post(a, '/websites', { name: '', url: 'https://ok.example.com' })).status).toBe(400);
    expect((await post(a, '/websites', { name: 'x', url: 'https://ok.example.com', check_interval_seconds: 5 })).status).toBe(400);
    expect((await post(a, '/websites', { name: 'x', url: 'https://ok.example.com', expected_status: 'abc' })).status).toBe(400);
    expect((await post(a, '/websites', { name: 'x', url: 'https://ok.example.com', ga4_property_id: 'abc' })).status).toBe(400);
    const bad = await post(a, '/websites', { name: 'x', url: 'https://ok.example.com', criticality: 'urgent' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('prevents duplicate URLs (normalised)', async () => {
    const a = await login('admin');
    expect((await post(a, '/websites', { name: 'A', url: 'https://Dup.example.com/' })).status).toBe(201);
    const d = await post(a, '/websites', { name: 'B', url: 'https://dup.example.com:443' });
    expect(d.status).toBe(409);
  });

  it('supports search, filters, sorting and pagination', async () => {
    const a = await login('admin');
    for (let i = 0; i < 30; i++) await makeSite({ name: `Site ${String(i).padStart(2, '0')}`, url: `https://s${i}.example.com`, criticality: i % 2 ? 'high' : 'low', owner: i === 3 ? 'Zed' : 'Amy' });
    const p1 = await get(a, '/websites?pageSize=10&page=1&sort=name');
    expect(p1.body.total).toBe(30);
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.data[0].name).toBe('Site 00');
    expect((await get(a, '/websites?pageSize=10&page=3')).body.data).toHaveLength(10);
    expect((await get(a, '/websites?criticality=high')).body.total).toBe(15);
    expect((await get(a, '/websites?q=zed')).body.total).toBe(1);
    expect((await get(a, '/websites?q=%25')).body.total).toBe(0); // wildcard characters are escaped
    expect((await get(a, '/websites?sort=name&dir=desc&pageSize=1')).body.data[0].name).toBe('Site 29');
    expect((await get(a, '/websites?state=unknown')).body.total).toBe(30);
  });

  it('never reports disabled, unchecked or stale sites as online', async () => {
    const a = await login('admin');
    const up = await makeSite({ name: 'Fresh' });
    const stale = await makeSite({ name: 'Stale' });
    const off = await makeSite({ name: 'Off', monitoring_status: 'disabled' });
    await query("UPDATE websites SET state='up', last_check_at=now() WHERE id=$1", [up.id]);
    await query("UPDATE websites SET state='up', last_check_at=now() - interval '1 hour' WHERE id=$1", [stale.id]);
    await query("UPDATE websites SET state='up', last_check_at=now() WHERE id=$1", [off.id]);
    const byName = Object.fromEntries((await get(a, '/websites')).body.data.map((w: any) => [w.name, w.effective_state]));
    expect(byName).toEqual({ Fresh: 'up', Stale: 'unknown', Off: 'unmonitored' });
  });

  it('bulk actions: disable, enable, archive, delete', async () => {
    const a = await login('admin');
    const w1 = await makeSite(); const w2 = await makeSite();
    expect((await post(a, '/websites/bulk', { ids: [w1.id, w2.id], action: 'disable' })).body.affected).toBe(2);
    expect((await query('SELECT monitoring_status FROM websites')).every((r) => r.monitoring_status === 'disabled')).toBe(true);
    await post(a, '/websites/bulk', { ids: [w1.id], action: 'set_interval', value: 120 });
    expect((await query('SELECT check_interval_seconds FROM websites WHERE id=$1', [w1.id]))[0].check_interval_seconds).toBe(120);
    await post(a, '/websites/bulk', { ids: [w1.id, w2.id], action: 'archive' });
    expect((await get(a, '/websites')).body.total).toBe(0); // archived hidden by default
    await post(a, '/websites/bulk', { ids: [w1.id, w2.id], action: 'delete' });
    expect((await query('SELECT 1 FROM websites')).length).toBe(0);
  });

  it('keeps an analytics-less website monitored and flags integration state correctly', async () => {
    const a = await login('admin');
    const c = await post(a, '/websites', { name: 'NoGA', url: 'https://noga.example.com' });
    expect(c.body.ga4_status).toBe('not_connected');
    const m = await post(a, '/websites', { name: 'Mapped', url: 'https://mapped.example.com', ga4_property_id: 'properties/123456789' });
    expect(m.body.ga4_property_id).toBe('123456789');
    expect(m.body.ga4_status).toBe('access_required'); // configured but unproven ⇒ not "connected"
    expect(c.body.monitoring_status).toBe('active');
  });

  it('check-now is queued, requires an active site and a free lock', async () => {
    const a = await login('manager');
    const w = await makeSite();
    await query("UPDATE websites SET next_check_at = now() + interval '1 hour' WHERE id=$1", [w.id]);
    const r = await post(a, `/websites/${w.id}/check-now`);
    expect(r.status).toBe(202);
    expect((await query('SELECT next_check_at <= now() AS due FROM websites WHERE id=$1', [w.id]))[0].due).toBe(true);
    await query("UPDATE websites SET lock_until = now() + interval '1 minute' WHERE id=$1", [w.id]);
    expect((await post(a, `/websites/${w.id}/check-now`)).status).toBe(409);
    const off = await makeSite({ monitoring_status: 'disabled' });
    expect((await post(a, `/websites/${off.id}/check-now`)).status).toBe(400);
  });
});

describe('API error handling', () => {
  it('returns JSON errors without stack traces', async () => {
    const a = await login('admin');
    const r1 = await get(a, '/websites/not-a-uuid');
    expect(r1.status).toBe(400);
    const r2 = await get(a, '/nope');
    expect(r2.status).toBe(404);
    const r3 = await a.agent.post('/api/v1/websites').set('X-CSRF-Token', a.csrf).set('Content-Type', 'application/json').send('{bad json');
    expect(r3.status).toBe(400);
    for (const r of [r1, r2, r3]) {
      expect(JSON.stringify(r.body)).not.toMatch(/at .*\.(ts|js)|node_modules/);
      expect(r.body.error.code).toBeTruthy();
    }
  });
});
