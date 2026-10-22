import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// Return numeric/bigint columns as JS numbers where safe (counts, ids).
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: 15,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      options: '-c timezone=UTC',
    });
    pool.on('error', (err) => logger.error({ err }, 'unexpected idle pg client error'));
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function query<T = any>(sql: string, params: unknown[] = [], q: Queryable = getPool()) {
  const r = await q.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = [], q: Queryable = getPool()) {
  const rows = await query<T>(sql, params, q);
  return rows[0] as T | undefined;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
