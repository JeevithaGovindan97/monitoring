import { one, query } from '../db.js';

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const r = await one<{ value: T }>('SELECT value FROM system_settings WHERE key = $1', [key]);
  return r ? r.value : fallback;
}
export async function setSetting(key: string, value: unknown, userId?: string) {
  await query(
    `INSERT INTO system_settings (key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId ?? null],
  );
}
export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM system_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
