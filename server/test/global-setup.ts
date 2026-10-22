import pg from 'pg';
import { runMigrations } from '../src/migrate.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://monitor:monitor@localhost:5432/monitor_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await runMigrations(url, () => undefined);
}
