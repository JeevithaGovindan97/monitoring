import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query, tx } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, wrap } from '../lib/errors.js';
import { pageParams, paged } from '../lib/http.js';
import { buildTemplate, exportCsv, exportXlsx, parseInventoryFile, validateRows } from '../lib/inventory-io.js';
import { createWebsiteSchema, updateWebsiteSchema } from '../lib/website-schema.js';
import { createWebsite, deleteWebsite, EFFECTIVE_STATE_SQL, getWebsite, updateWebsite, WEBSITE_COLUMNS } from '../lib/website-service.js';
import { websiteDetailRouter } from './website-detail.js';

export const websitesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const SORTS: Record<string, string> = {
  name: 'lower(w.name)', url: 'w.url', criticality: "array_position(ARRAY['critical','high','medium','low'], w.criticality)",
  state: 'effective_state', last_check_at: 'w.last_check_at', response: 'w.last_response_ms', created_at: 'w.created_at',
};

websitesRouter.get(
  '/',
  wrap(async (req, res) => {
    const { page, pageSize, offset } = pageParams(req);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    const q = req.query;
    if (q.q) {
      params.push(`%${String(q.q).replace(/[%_\\]/g, '\\$&')}%`);
      const n = params.length;
      where.push(`(w.name ILIKE $${n} OR w.url ILIKE $${n} OR w.owner ILIKE $${n})`);
    }
    if (q.criticality) add('w.criticality = ?', String(q.criticality));
    if (q.hosting_type) add('w.hosting_type = ?', String(q.hosting_type));
    if (q.environment) add('w.environment = ?', String(q.environment));
    if (q.monitoring_status) add('w.monitoring_status = ?', String(q.monitoring_status));
    else if (!q.include_archived) where.push("w.monitoring_status <> 'archived'");
    if (q.ga4_status) add('w.ga4_status = ?', String(q.ga4_status));
    if (q.gsc_status) add('w.gsc_status = ?', String(q.gsc_status));
    if (q.state) add(`${EFFECTIVE_STATE_SQL} = ?`, String(q.state));
    const sortKey = SORTS[String(q.sort)] ?? SORTS.name!;
    const dir = String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const cols = WEBSITE_COLUMNS.split(',').map((c) => 'w.' + c.trim()).join(', ');
    const rows = await query(
      `SELECT ${cols}, ${EFFECTIVE_STATE_SQL} AS effective_state,
              (SELECT count(*)::int FROM incidents i WHERE i.website_id = w.id AND i.status <> 'resolved') AS open_incidents
         FROM websites w ${whereSql} ORDER BY ${sortKey} ${dir}, w.id LIMIT ${pageSize} OFFSET ${offset}`,
      params,
    );
    const total = (await one(`SELECT count(*)::int AS n FROM websites w ${whereSql}`, params)).n;
    res.json(paged(rows, total, page, pageSize));
  }),
);

websitesRouter.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const input = createWebsiteSchema.parse(req.body);
    const row = await createWebsite(input, req.user!.id);
    await audit(req, 'website.created', 'website', row.id, { url: row.url });
    res.status(201).json(row);
  }),
);

// ---- import / export / template (declared before /:id)
websitesRouter.get(
  '/import-template',
  wrap(async (_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="website-inventory-template.xlsx"');
    res.send(await buildTemplate(27));
  }),
);

const exportLimiter = rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 1000 : 20 });
websitesRouter.get(
  '/export',
  exportLimiter,
  wrap(async (req, res) => {
    const fmt = String(req.query.format ?? 'csv');
    await audit(req, 'website.exported', 'website', undefined, { format: fmt });
    if (fmt === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="website-inventory.xlsx"');
      return res.send(await exportXlsx());
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="website-inventory.csv"');
    res.send('﻿' + (await exportCsv()));
  }),
);

websitesRouter.post(
  '/import',
  requireAdmin,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('Upload a .csv or .xlsx file in the "file" field');
    const mode = String(req.query.mode ?? 'preview');
    if (!['preview', 'commit'].includes(mode)) throw badRequest('mode must be "preview" or "commit"');
    const skipInvalid = req.query.skipInvalid === 'true';
    let parsed;
    try {
      parsed = await parseInventoryFile(req.file.buffer, req.file.originalname);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const results = await validateRows(parsed.rows);
    const summary = {
      totalRows: results.length,
      valid: results.filter((r) => r.ok).length,
      invalid: results.filter((r) => !r.ok).length,
      duplicates: results.filter((r) => r.duplicateOf).length,
      unknownHeaders: parsed.unknownHeaders,
    };
    const preview = results.map(({ data: _d, ...r }) => r);
    if (mode === 'preview') return res.json({ mode, summary, rows: preview });

    if (summary.invalid > 0 && !skipInvalid) {
      return res.status(422).json({
        error: { code: 'import_has_errors', message: `${summary.invalid} row(s) have errors. Fix them or import valid rows only.` },
        summary, rows: preview,
      });
    }
    const toInsert = results.filter((r) => r.ok && r.data);
    const created = await tx(async (c) => {
      let n = 0;
      for (const r of toInsert) {
        const w = await createWebsite(r.data!, req.user!.id, c);
        if (r.formUrl) {
          await query(
            `INSERT INTO form_checks (website_id, label, type, url) VALUES ($1,$2,$3,$4)`,
            [w.id, `${r.data!.form_type === 'none' ? 'form' : r.data!.form_type} page`, r.data!.form_type === 'none' ? 'other' : r.data!.form_type, r.formUrl], c);
        }
        n++;
      }
      return n;
    });
    await audit(req, 'website.imported', 'website', undefined, { file: req.file.originalname, created, skipped: summary.invalid });
    res.status(201).json({ mode, created, skipped: summary.invalid, summary, rows: preview });
  }),
);

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(['enable', 'disable', 'archive', 'delete', 'set_criticality', 'set_interval']),
  value: z.union([z.string(), z.number()]).optional(),
});
websitesRouter.post(
  '/bulk',
  requireAdmin,
  wrap(async (req, res) => {
    const b = bulkSchema.parse(req.body);
    let sql: string;
    const params: unknown[] = [b.ids];
    switch (b.action) {
      case 'enable': sql = "UPDATE websites SET monitoring_status='active', next_check_at=now(), updated_at=now() WHERE id = ANY($1)"; break;
      case 'disable': sql = "UPDATE websites SET monitoring_status='disabled', updated_at=now() WHERE id = ANY($1)"; break;
      case 'archive': sql = "UPDATE websites SET monitoring_status='archived', updated_at=now() WHERE id = ANY($1)"; break;
      case 'delete': sql = 'DELETE FROM websites WHERE id = ANY($1)'; break;
      case 'set_criticality': {
        const v = z.enum(['critical', 'high', 'medium', 'low']).parse(b.value);
        params.push(v);
        sql = 'UPDATE websites SET criticality=$2, updated_at=now() WHERE id = ANY($1)';
        break;
      }
      case 'set_interval': {
        const v = z.coerce.number().int().min(60).max(86400).parse(b.value);
        params.push(v);
        sql = 'UPDATE websites SET check_interval_seconds=$2, updated_at=now() WHERE id = ANY($1)';
        break;
      }
    }
    const r = await query(sql + ' RETURNING id', params);
    await audit(req, `website.bulk_${b.action}`, 'website', undefined, { count: r.length, value: b.value });
    res.json({ affected: r.length });
  }),
);

websitesRouter.get('/:id', wrap(async (req, res) => {
  res.json(await getWebsite(z.string().uuid().parse(req.params.id)));
}));

websitesRouter.patch(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const patch = updateWebsiteSchema.parse(req.body);
    const row = await updateWebsite(id, patch);
    await audit(req, 'website.updated', 'website', id, { fields: Object.keys(patch) });
    res.json(row);
  }),
);

websitesRouter.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const w = await one('SELECT url FROM websites WHERE id = $1', [id]);
    if (!w) throw notFound('Website not found');
    await deleteWebsite(id);
    await audit(req, 'website.deleted', 'website', id, { url: w.url });
    res.status(204).end();
  }),
);

websitesRouter.use('/:id', websiteDetailRouter);
