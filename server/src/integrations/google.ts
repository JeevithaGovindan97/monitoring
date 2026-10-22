import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

export interface ServiceAccount { client_email: string; private_key: string }

/** Test seam: replace network + auth. */
export const deps = {
  fetch: (...a: Parameters<typeof fetch>) => fetch(...a),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  getToken: undefined as undefined | ((scopes: string[]) => Promise<string>),
};

export function loadServiceAccount(): ServiceAccount | null {
  const c = config();
  let raw = c.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw && c.GOOGLE_SERVICE_ACCOUNT_FILE) {
    try { raw = fs.readFileSync(c.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'); } catch { return null; }
  }
  if (!raw) return null;
  try {
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return null;
    return { client_email: j.client_email, private_key: j.private_key };
  } catch {
    return null;
  }
}

/** Only the e-mail address (needed by admins to grant access) ever leaves this module — never the key. */
export function serviceAccountEmail(): string | null {
  return loadServiceAccount()?.client_email ?? null;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
export async function getAccessToken(scopes: string[]): Promise<string> {
  if (deps.getToken) return deps.getToken(scopes);
  const key = scopes.join(' ');
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const sa = loadServiceAccount();
  if (!sa) throw new GoogleError('not_configured', 'Google service-account credentials are not configured');
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes });
  const t = await jwt.getAccessToken();
  if (!t.token) throw new GoogleError('auth', 'Could not obtain a Google access token');
  tokenCache.set(key, { token: t.token, exp: Date.now() + 50 * 60_000 });
  return t.token;
}

export type GoogleErrorKind = 'not_configured' | 'auth' | 'access_denied' | 'not_found' | 'quota' | 'server' | 'bad_request';
export class GoogleError extends Error {
  constructor(public kind: GoogleErrorKind, message: string, public status?: number) { super(message); }
}

/** JSON request with retry (429 / 5xx) and exponential backoff, honouring Retry-After. */
export async function googleJson<T = any>(url: string, opts: { method?: string; body?: unknown; scopes: string[]; retries?: number; key?: string }): Promise<T> {
  const retries = opts.retries ?? 4;
  let attempt = 0;
  for (;;) {
    // `key` given (even empty) = API-key mode (public APIs such as PageSpeed): no service-account token.
    const keyMode = opts.key !== undefined;
    const token = keyMode ? undefined : await getAccessToken(opts.scopes);
    const res = await deps.fetch(keyMode && opts.key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(opts.key)}` : url, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* keep raw */ }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 500 * 2 ** attempt);
      attempt++;
      await deps.sleep(wait);
      continue;
    }
    if (res.status === 401) throw new GoogleError('auth', `Authentication failed: ${msg}`, 401);
    if (res.status === 403) {
      // 403 can also be an exhausted quota
      if (/quota|rate limit|exhausted/i.test(msg)) throw new GoogleError('quota', `Quota exceeded: ${msg}`, 403);
      throw new GoogleError('access_denied', msg || 'Access denied', 403);
    }
    if (res.status === 404) throw new GoogleError('not_found', msg || 'Not found', 404);
    if (res.status === 429) throw new GoogleError('quota', `Rate limited: ${msg}`, 429);
    if (res.status >= 500) throw new GoogleError('server', `Google API error ${res.status}: ${msg}`, res.status);
    throw new GoogleError('bad_request', `Request rejected (${res.status}): ${msg}`, res.status);
  }
}
