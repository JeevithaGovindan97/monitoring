import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getPool } from '../db.js';
import { notifyAdmins } from '../monitor/notify.js';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, outFile?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', outFile ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    p.stderr!.on('data', (d) => (err += d.toString().slice(0, 2000)));
    if (outFile) {
      import('node:fs').then(({ createWriteStream }) => p.stdout!.pipe(createWriteStream(outFile, { mode: 0o600 })));
    }
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${err.trim().slice(0, 400)}`))));
  });
}

/**
 * pg_dump (custom format) → optional AES-256 encryption (openssl, PBKDF2) → retention → optional off-server upload command.
 * A backup is only considered verified after scripts/restore-test.sh has restored it into a scratch database.
 */
export async function runBackup(now = new Date()): Promise<{ file: string; bytes: number; encrypted: boolean; pruned: number; uploaded: boolean }> {
  const c = config();
  await fs.mkdir(c.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dump = path.join(c.BACKUP_DIR, `monitor-${stamp}.dump`);
  await run('pg_dump', ['--format=custom', '--no-owner', '--dbname', c.DATABASE_URL, '--file', dump]);
  let final = dump;
  const pass = c.BACKUP_ENCRYPTION_PASSPHRASE;
  if (pass) {
    final = `${dump}.enc`;
    await run('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', dump, '-out', final, '-pass', 'env:BACKUP_PASS'], { BACKUP_PASS: pass });
    await fs.rm(dump, { force: true });
  }
  const stat = await fs.stat(final);
  if (stat.size < 1024) throw new Error(`Backup file is suspiciously small (${stat.size} bytes)`);
  // retention
  let pruned = 0;
  const cutoff = Date.now() - c.BACKUP_RETENTION_DAYS * 86400_000;
  for (const f of await fs.readdir(c.BACKUP_DIR)) {
    if (!/^monitor-.*\.dump(\.enc)?$/.test(f)) continue;
    const s = await fs.stat(path.join(c.BACKUP_DIR, f));
    if (s.mtimeMs < cutoff) { await fs.rm(path.join(c.BACKUP_DIR, f)); pruned++; }
  }
  let uploaded = false;
  if (c.BACKUP_UPLOAD_COMMAND) {
    // Operator-provided command (e.g. `rclone copy "$BACKUP_FILE" remote:bucket/`); runs with BACKUP_FILE set.
    await run('sh', ['-c', c.BACKUP_UPLOAD_COMMAND], { BACKUP_FILE: final });
    uploaded = true;
  }
  return { file: path.basename(final), bytes: stat.size, encrypted: Boolean(pass), pruned, uploaded };
}

export async function runBackupJob() {
  const pool = getPool();
  try {
    const r = await runBackup();
    logger.info(r, 'backup completed');
    return r;
  } catch (err) {
    logger.error({ err }, 'backup failed');
    await notifyAdmins(pool, { type: 'backup_failed', severity: 'critical', title: 'Database backup failed', body: (err as Error).message.slice(0, 400), link: '/system', dedupeKey: `backup_failed:${new Date().toISOString().slice(0, 10)}`, email: true });
    throw err;
  }
}
