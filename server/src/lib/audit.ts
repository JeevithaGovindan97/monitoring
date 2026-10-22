import type { Request } from 'express';
import { query, type Queryable, getPool } from '../db.js';

export async function audit(
  req: Request | null,
  action: string,
  entityType?: string,
  entityId?: string,
  data: Record<string, unknown> = {},
  q: Queryable = getPool(),
  actor?: { id?: string; email?: string },
) {
  const user = req?.user ?? actor;
  await query(
    `INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, ip, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [(user as any)?.id ?? null, (user as any)?.email ?? null, action, entityType ?? null, entityId ?? null, req?.ip ?? null, JSON.stringify(data)],
    q,
  );
}
