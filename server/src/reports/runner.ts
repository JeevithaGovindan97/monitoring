import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { collectReport, type ReportParams } from './data.js';
import { renderPdf } from './pdf.js';
import { renderXlsx } from './xlsx.js';

export function reportsDir() {
  return path.resolve(config().REPORTS_DIR);
}

/** Generate queued reports. Jobs are leased with SKIP LOCKED so several workers never build the same report. */
export async function runQueuedReports(limit = 2) {
  const jobs = await query<any>(
    `UPDATE report_jobs SET status='running', started_at=now(), attempts=attempts+1, lock_until=now()+interval '10 minutes', progress=5
      WHERE id IN (SELECT id FROM report_jobs WHERE (status='queued' OR (status='running' AND lock_until < now() AND attempts < 3))
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING *`, [limit]);
  for (const j of jobs) {
    try {
      const params: ReportParams = { type: j.type, ...j.params };
      const data = await collectReport(params, async (pct) => { await query('UPDATE report_jobs SET progress=$2 WHERE id=$1', [j.id, pct]); });
      const buf = j.format === 'pdf' ? await renderPdf(data) : await renderXlsx(data);
      await fs.mkdir(reportsDir(), { recursive: true, mode: 0o750 });
      const rel = `${j.id}.${j.format}`; // opaque uuid file name; never served statically
      await fs.writeFile(path.join(reportsDir(), rel), buf, { mode: 0o640 });
      const days = await getSetting<number>('retention_reports_days', 30);
      const label = j.type === 'website' && data.scope.websiteName ? data.scope.websiteName.replace(/[^\w.-]+/g, '_') : j.type;
      const fileName = `report_${label}_${data.period.to.toISOString().slice(0, 10)}.${j.format}`;
      await query(
        `UPDATE report_jobs SET status='done', progress=100, file_path=$2, file_name=$3, file_size=$4, finished_at=now(), expires_at=now()+make_interval(days => $5), error=NULL WHERE id=$1`,
        [j.id, rel, fileName, buf.length, days]);
    } catch (err) {
      logger.error({ err, report: j.id }, 'report generation failed');
      await query("UPDATE report_jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [j.id, (err as Error).message.slice(0, 500)]);
    }
  }
  return jobs.length;
}

export async function purgeExpiredReports() {
  const rows = await query<any>("DELETE FROM report_jobs WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING id, file_path");
  for (const r of rows) if (r.file_path) await fs.rm(path.join(reportsDir(), path.basename(r.file_path)), { force: true });
  return rows.length;
}
