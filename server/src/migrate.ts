import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrationsDir() {
  // src/ -> ../migrations ; dist/ -> ../migrations (Docker image copies migrations next to dist)
  return path.resolve(here, '..', 'migrations');
}

/**
 * Minimal forward-only SQL migration runner. Uses a pg advisory lock so concurrent
 * invocations (e.g. two deploys) cannot apply the same migration twice.
 */
export async function runMigrations(databaseUrl: string, log: (m: string) => void = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
    const done: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir(), f), 'utf8');
      log(`applying ${f}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        done.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    log(done.length ? `applied ${done.length} migration(s)` : 'database is up to date');
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    await client.end();
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
