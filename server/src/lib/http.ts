import type { Request } from 'express';
import { z } from 'zod';

export const uuidParam = z.string().uuid();

export function pageParams(req: Request, maxSize = 200) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number(req.query.pageSize) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paged<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { data: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Resolve ?from=&to= (or ?days=) into a concrete [from,to) range, default 30 days. */
export function resolveRange(req: Request, defaultDays = 30) {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const days = Math.min(400, Math.max(1, Number(req.query.days) || defaultDays));
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - days * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Invalid date range');
  return { from, to };
}
