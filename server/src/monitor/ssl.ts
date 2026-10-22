import tls from 'node:tls';
import net from 'node:net';
import { SsrfError, resolvePublic } from '../security/ssrf.js';

export interface SslResult {
  valid: boolean;
  subject: string | null;
  issuer: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  daysRemaining: number | null;
  protocol: string | null;
  error: string | null;
}

export function daysUntil(validTo: Date, now = new Date()): number {
  return Math.floor((validTo.getTime() - now.getTime()) / 86400_000);
}

/** Alert level for a certificate: 0 = expired/invalid, 7/14/30 = thresholds crossed, null = fine. */
export function sslAlertLevel(r: Pick<SslResult, 'valid' | 'daysRemaining' | 'error'>, thresholds: number[] = [30, 14, 7]): number | null {
  if (r.daysRemaining !== null && r.daysRemaining < 0) return 0;
  if (!r.valid && r.error) return 0;
  if (r.daysRemaining === null) return null;
  const sorted = [...thresholds].sort((a, b) => a - b);
  for (const t of sorted) if (r.daysRemaining <= t) return t;
  return null;
}

const name = (o: any) => (o ? (o.CN ?? o.O ?? Object.values(o).join(', ')) : null);

export async function checkCertificate(urlStr: string, opts: { timeoutMs?: number; allowPrivate?: boolean; now?: Date } = {}): Promise<SslResult> {
  const now = opts.now ?? new Date();
  const u = new URL(urlStr);
  const empty: SslResult = { valid: false, subject: null, issuer: null, validFrom: null, validTo: null, daysRemaining: null, protocol: null, error: null };
  if (u.protocol !== 'https:') return { ...empty, error: 'Not an HTTPS URL' };
  let pinned;
  try {
    pinned = await resolvePublic(u.hostname, { allowPrivate: opts.allowPrivate });
  } catch (e) {
    return { ...empty, error: e instanceof SsrfError ? e.message : `DNS lookup failed: ${(e as any).code ?? (e as Error).message}` };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise<SslResult>((resolve) => {
    let done = false;
    const finish = (r: SslResult) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = tls.connect({
      host: pinned.address,
      port: Number(u.port || 443),
      servername: net.isIP(host) ? undefined : host,
      // We want to read the certificate even when it is invalid; validity is judged from socket.authorized.
      rejectUnauthorized: false,
      timeout: opts.timeoutMs ?? 10_000,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ ...empty, error: 'No certificate presented' });
      const validTo = new Date(cert.valid_to);
      const validFrom = new Date(cert.valid_from);
      const days = daysUntil(validTo, now);
      let error: string | null = null;
      let valid = socket.authorized;
      if (!valid) error = String(socket.authorizationError ?? 'Certificate not trusted');
      if (days < 0) { valid = false; error = 'Certificate has expired'; }
      else if (now < validFrom) { valid = false; error = 'Certificate is not yet valid'; }
      finish({ valid, subject: name(cert.subject), issuer: name(cert.issuer), validFrom, validTo, daysRemaining: days, protocol: socket.getProtocol(), error });
    });
    socket.once('timeout', () => finish({ ...empty, error: 'TLS handshake timed out' }));
    socket.once('error', (e: any) => finish({ ...empty, error: `TLS connection failed: ${e.code ?? e.message}` }));
  });
}
