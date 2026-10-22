import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { SsrfError, resolvePublic, validateMonitorUrl } from '../security/ssrf.js';
import { statusMatches } from '../lib/status.js';

export type ErrorCategory = 'dns' | 'connect' | 'tls' | 'timeout' | 'http_status' | 'redirect' | 'ssrf_blocked' | 'internal' | 'other';

export interface CheckOptions {
  url: string;
  timeoutMs: number;
  maxRedirects: number;
  expectedStatus: string;
  /** Verify the TLS certificate. When false, certificate problems are left to the SSL monitor. */
  verifyTls?: boolean;
  allowPrivate?: boolean;
  /** Test seam: exact addresses exempt from the SSRF block list. */
  allowAddresses?: string[];
  /** Test seam */
  lookup?: typeof dns.promises.lookup;
}

export interface CheckResult {
  startedAt: Date;
  finishedAt: Date;
  success: boolean;
  statusCode: number | null;
  responseMs: number | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  redirectCount: number;
  finalUrl: string | null;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const UA = 'IGO-Monitor/1.0 (website uptime check)';

export function classifyError(err: any): { category: ErrorCategory; message: string } {
  if (err instanceof SsrfError) return { category: 'ssrf_blocked', message: err.message };
  const code: string = err?.code ?? '';
  if (err?.name === 'CheckTimeout') return { category: 'timeout', message: err.message };
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL'].includes(code)) return { category: 'dns', message: `DNS lookup failed (${code})` };
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return { category: 'timeout', message: 'Connection timed out' };
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED'].includes(code)) {
    return { category: 'connect', message: `Connection failed (${code})` };
  }
  if (/^(CERT_|ERR_TLS|ERR_SSL|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|EPROTO|HOSTNAME_MISMATCH|ERR_OSSL)/.test(code) || /certificate|tls|ssl/i.test(err?.message ?? '')) {
    return { category: 'tls', message: `TLS error: ${err?.code ?? err?.message}` };
  }
  return { category: 'other', message: String(err?.message ?? err).slice(0, 300) };
}

interface Hop {
  statusCode: number;
  location?: string;
  headersAt: number;
}

function requestOnce(u: URL, opts: CheckOptions, pinned: { address: string; family: number }, remainingMs: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    let settled = false;
    const req = mod.request(
      {
        protocol: u.protocol,
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        agent: false,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Encoding': 'identity', Connection: 'close' },
        // DNS-rebinding protection: connect only to the address we already validated.
        lookup: (_h: string, _o: any, cb: any) => {
          if (_o?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        },
        ...(isHttps ? { rejectUnauthorized: opts.verifyTls !== false, servername: net_isIP(u.hostname) ? undefined : u.hostname } : {}),
      } as https.RequestOptions,
      (res) => {
        settled = true;
        const hop = { statusCode: res.statusCode ?? 0, location: res.headers.location, headersAt: Date.now() };
        res.destroy();
        resolve(hop);
      },
    );
    const timer = setTimeout(() => {
      const e = new Error(`Timed out after ${opts.timeoutMs} ms`);
      e.name = 'CheckTimeout';
      req.destroy(e);
    }, Math.max(1, remainingMs));
    req.on('error', (e) => {
      clearTimeout(timer);
      if (!settled) reject(e);
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

const net_isIP = (h: string) => net.isIP(h.replace(/^\[|\]$/g, '')) !== 0;

export async function performCheck(opts: CheckOptions): Promise<CheckResult> {
  const startedAt = new Date();
  const t0 = Date.now();
  const deadline = t0 + opts.timeoutMs;
  const policy = { allowPrivate: opts.allowPrivate, allowAddresses: opts.allowAddresses };
  let redirects = 0;
  let current = opts.url;
  const done = (p: Partial<CheckResult>): CheckResult => ({
    startedAt, finishedAt: new Date(), success: false, statusCode: null, responseMs: null, errorCategory: null,
    errorMessage: null, redirectCount: redirects, finalUrl: current, ...p,
  });
  try {
    for (;;) {
      const u = validateMonitorUrl(current, policy); // re-validated on every hop (redirect targets too)
      const pinned = await Promise.race([
        resolvePublic(u.hostname, policy, opts.lookup),
        new Promise<never>((_, rej) => setTimeout(() => { const e = new Error('DNS resolution timed out'); e.name = 'CheckTimeout'; rej(e); }, Math.max(1, deadline - Date.now()))),
      ]);
      const remaining = deadline - Date.now();
      if (remaining <= 0) { const e = new Error(`Timed out after ${opts.timeoutMs} ms`); e.name = 'CheckTimeout'; throw e; }
      const hop = await requestOnce(u, opts, pinned, remaining);
      if (REDIRECT_CODES.has(hop.statusCode) && hop.location && opts.maxRedirects > 0) {
        if (redirects >= opts.maxRedirects) {
          return done({ statusCode: hop.statusCode, errorCategory: 'redirect', errorMessage: `Too many redirects (limit ${opts.maxRedirects})` });
        }
        redirects++;
        try {
          current = new URL(hop.location, u).toString();
        } catch {
          return done({ statusCode: hop.statusCode, errorCategory: 'redirect', errorMessage: 'Invalid redirect location' });
        }
        continue;
      }
      const ok = statusMatches(opts.expectedStatus, hop.statusCode);
      return done({
        success: ok, statusCode: hop.statusCode, responseMs: hop.headersAt - t0, finalUrl: current,
        errorCategory: ok ? null : 'http_status', errorMessage: ok ? null : `Unexpected HTTP status ${hop.statusCode} (expected ${opts.expectedStatus})`,
      });
    }
  } catch (err) {
    const c = classifyError(err);
    return done({ errorCategory: c.category, errorMessage: c.message });
  }
}
