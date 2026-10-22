export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);
let onUnauthorized: (() => void) | undefined;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

const BASE = '/api/v1';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const e = data?.error;
    throw new ApiError(res.status, e?.message ?? `Request failed (${res.status})`, e?.code, e?.details ?? data);
  }
  return data as T;
}

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Authenticated file download via a normal navigation (cookie auth); works for reports/exports. */
export const downloadUrl = (path: string) => BASE + path;
