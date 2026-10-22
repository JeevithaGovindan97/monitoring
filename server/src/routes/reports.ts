import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';
import { REPORT_TYPES, resolvePeriod } from '../reports/data.js';
import { reportsDir } from '../reports/runner.js';

export const reportsRouter = Router();
const id = (req: any) => z.string().uuid().parse(req.params.id);

const createSchema = z.object({
  type: z.enum(REPORT_TYPES),
  format: z.enum(['pdf', 'xlsx']),
  from: z.string().optional(),
  to: z.string().optional(),
  websiteId: z.string().uuid().optional(),
});

const createLimiter = rateLimit({
  windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 1000 : 10, validate: false,
  keyGenerator: (req) => (req as any).user?.id ?? req.ip ?? 'anon',
  message: { error: { code: 'rate_limited', message: 'Too many reports requested. Please wait a minute.' } },
});

const COLS = 'id, type, format, params, status, progress, file_name, file_size, error, requested_by, created_at, started_at, finished_at, expires_at, download_count';

reportsRouter.post('/', createLimiter, wrap(async (req, res) => {
  const b = createSchema.parse(req.body);
  if (b.type === 'website' && !b.websiteId) throw badRequest('websiteId is required for a single-website report');
  if (b.type === 'custom' && (!b.from || !b.to)) throw badRequest('from and to are required for a custom report');
  try { resolvePeriod({ type: b.type, from: b.from, to: b.to }); } catch (e) { throw badRequest((e as Error).message); }
  if (b.websiteId && !(await one('SELECT 1 FROM websites WHERE id=$1', [b.websiteId]))) throw notFound('Website not found');
  const params = { ...(b.from ? { from: b.from } : {}), ...(b.to ? { to: b.to } : {}), ...(b.websiteId ? { websiteId: b.websiteId } : {}) };
  const row = await one(`INSERT INTO report_jobs (type, format, params, requested_by) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`, [b.type, b.format, JSON.stringify(params), req.user!.id]);
  await audit(req, 'report.requested', 'report', row.id, { type: b.type, format: b.format });
  res.status(202).json(row);
}));

reportsRouter.get('/', wrap(async (req, res) => {
  const { page, pageSize, offset } = pageParams(req);
  const rows = await query(`SELECT r.${COLS.split(', ').join(', r.')}, u.name AS requested_by_name FROM report_jobs r LEFT JOIN users u ON u.id=r.requested_by ORDER BY r.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`);
  const total = (await one('SELECT count(*)::int n FROM report_jobs')).n;
  res.json(paged(rows, total, page, pageSize));
}));

reportsRouter.get('/:id', wrap(async (req, res) => {
  const r = await one(`SELECT ${COLS} FROM report_jobs WHERE id=$1`, [id(req)]);
  if (!r) throw notFound('Report not found');
  res.json(r);
}));

reportsRouter.get('/:id/download', wrap(async (req, res) => {
  // Auth + CSRF-free GET, but still requires a valid session cookie (see sessionMiddleware/requireAuth).
  const r = await one("SELECT * FROM report_jobs WHERE id=$1", [id(req)]);
  if (!r) throw notFound('Report not found');
  if (r.status !== 'done' || !r.file_path) throw badRequest(`Report is ${r.status}; it cannot be downloaded yet`);
  if (r.expires_at && new Date(r.expires_at) < new Date()) throw notFound('This report has expired and was removed');
  const file = path.join(reportsDir(), path.basename(r.file_path));
  if (!fs.existsSync(file)) throw notFound('Report file is no longer available');
  await query('UPDATE report_jobs SET download_count = download_count + 1 WHERE id=$1', [r.id]);
  await audit(req, 'report.downloaded', 'report', r.id, { type: r.type, format: r.format });
  res.setHeader('Content-Type', r.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(r.file_name).replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(file).pipe(res);
}));
