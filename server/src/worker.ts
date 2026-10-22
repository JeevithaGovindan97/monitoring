import os from 'node:os';
import { config } from './config.js';
import { closePool, getPool, one, query, tx } from './db.js';
import { logger } from './logger.js';
import { runEscalations } from './jobs/escalation.js';
import { runBackupJob } from './jobs/backup.js';
import { runRetention } from './jobs/retention.js';
import { syncGa4 } from './integrations/ga4.js';
import { runDueAudits } from './integrations/pagespeed.js';
import { syncSearchConsole } from './integrations/searchconsole.js';
import { processDeliveries } from './monitor/email.js';
import { runAggregation } from './monitor/aggregate.js';
import { runDueChecks, runDueFormChecks, runDueSslChecks } from './monitor/scheduler.js';
import { runQueuedReports } from './reports/runner.js';

const c = config();
const mode = c.WORKER_MODE;
const NAME = c.WORKER_NAME ?? `${os.hostname()}-${process.pid}-${mode}`;
const startedAt = new Date();
let stopping = false;
const inflight = new Set<Promise<unknown>>();

/** Run `fn` in a loop every `ms`, never overlapping itself, surviving errors. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (stopping || running) return;
    running = true;
    const p = fn().catch((err) => logger.error({ err, job: name }, 'loop iteration failed')).finally(() => { running = false; inflight.delete(p); });
    inflight.add(p);
  };
  const t = setInterval(tick, ms);
  t.unref();
  void tick();
}

/**
 * Run a slow job at most once per `minIntervalMs` across ALL worker replicas: an advisory lock serialises the
 * check-and-insert of the scheduled_job_runs row, so two workers can never both start the same daily job.
 */
async function runOncePer(job: string, minIntervalMs: number, fn: () => Promise<unknown>, onlyAtHourUtc?: number) {
  if (onlyAtHourUtc !== undefined && new Date().getUTCHours() !== onlyAtHourUtc) return;
  const runId = await tx(async (cl) => {
    await cl.query('SELECT pg_advisory_xact_lock(hashtext($1))', [job]);
    const last = await one<{ started_at: Date }>("SELECT started_at FROM scheduled_job_runs WHERE job_name=$1 AND status IN ('ok','running') ORDER BY started_at DESC LIMIT 1", [job], cl);
    // a 'running' row older than 2h is considered dead
    if (last && Date.now() - new Date(last.started_at).getTime() < minIntervalMs) return null;
    const r = await one<{ id: number }>("INSERT INTO scheduled_job_runs (job_name, worker) VALUES ($1,$2) RETURNING id", [job, NAME], cl);
    return r!.id;
  });
  if (!runId) return;
  try {
    const details = await fn();
    await query("UPDATE scheduled_job_runs SET status='ok', finished_at=now(), details=$2 WHERE id=$1", [runId, JSON.stringify(details ?? {})]);
  } catch (err) {
    logger.error({ err, job }, 'scheduled job failed');
    await query("UPDATE scheduled_job_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1", [runId, String((err as Error).message).slice(0, 500)]);
  }
}

async function heartbeat() {
  await query(
    `INSERT INTO worker_heartbeats (worker, role, started_at, last_beat_at, details) VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (worker) DO UPDATE SET last_beat_at = now(), details = EXCLUDED.details`,
    [NAME, mode, startedAt, JSON.stringify({ pid: process.pid, host: os.hostname(), mem_mb: Math.round(process.memoryUsage().rss / 1048576) })],
  );
}

async function main() {
  logger.info({ worker: NAME, mode }, 'worker starting');
  await getPool().query('SELECT 1'); // fail fast if the DB is unreachable
  every('heartbeat', 20_000, heartbeat);

  if (mode === 'monitor' || mode === 'all') {
    every('checks', c.SCHEDULER_TICK_MS, async () => { await runDueChecks(); await runDueFormChecks(); });
    every('ssl', 60_000, () => runDueSslChecks());
    every('email', 10_000, () => processDeliveries());
    every('aggregate', 5 * 60_000, runAggregation);
    every('escalation', 60_000, runEscalations);
  }
  if (mode === 'reports' || mode === 'all') {
    every('reports', 5_000, () => runQueuedReports());
    every('pagespeed', 60_000, () => runDueAudits(c.PAGESPEED_CONCURRENCY));
    every('daily-jobs', 10 * 60_000, async () => {
      await runOncePer('ga4_sync', 20 * 3600_000, () => syncGa4(7));
      await runOncePer('search_console_sync', 20 * 3600_000, () => syncSearchConsole(10));
      await runOncePer('retention', 20 * 3600_000, runRetention);
      if (c.BACKUP_ENABLED) await runOncePer('backup', 20 * 3600_000, runBackupJob, c.BACKUP_HOUR_UTC);
    });
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal, inflight: inflight.size }, 'worker shutting down (waiting for in-flight work)');
  const deadline = setTimeout(() => { logger.warn('shutdown timeout, exiting'); process.exit(1); }, 25_000);
  await Promise.allSettled([...inflight]);
  await query('DELETE FROM worker_heartbeats WHERE worker=$1', [NAME]).catch(() => undefined);
  await closePool().catch(() => undefined);
  clearTimeout(deadline);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));

main().catch((err) => { logger.fatal({ err }, 'worker failed to start'); process.exit(1); });
