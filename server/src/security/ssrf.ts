import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF protection.
 *  - Only http/https URLs are accepted.
 *  - Host names are resolved by us and EVERY resolved address must be public.
 *  - The checker then connects to the validated address (pinned), so a DNS answer that
 *    changes between validation and connection (DNS rebinding) cannot redirect the request.
 *  - Redirect targets go through the same validation (see monitor/http-check.ts).
 */

const blocked = new net.BlockList();
const v4 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, 'ipv4');
const v6 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, 'ipv6');
v4('0.0.0.0', 8); // "this" network
v4('10.0.0.0', 8); // private
v4('100.64.0.0', 10); // CGNAT
v4('127.0.0.0', 8); // loopback
v4('169.254.0.0', 16); // link-local + cloud metadata (169.254.169.254)
v4('172.16.0.0', 12); // private
v4('192.0.0.0', 24); // IETF protocol assignments
v4('192.0.2.0', 24); // TEST-NET-1
v4('192.88.99.0', 24); // 6to4 relay
v4('192.168.0.0', 16); // private
v4('198.18.0.0', 15); // benchmarking
v4('198.51.100.0', 24); // TEST-NET-2
v4('203.0.113.0', 24); // TEST-NET-3
v4('224.0.0.0', 4); // multicast
v4('240.0.0.0', 4); // reserved + broadcast
v6('::', 128); // unspecified
v6('::1', 128); // loopback
v6('64:ff9b::', 96); // NAT64
v6('100::', 64); // discard
v6('2001:db8::', 32); // documentation
v6('fc00::', 7); // unique local
v6('fe80::', 10); // link-local
v6('fec0::', 10); // site-local (deprecated)
v6('ff00::', 8); // multicast

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i];

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export function isBlockedAddress(address: string): boolean {
  let ip = address;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) -> check the embedded IPv4 address
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mappedHex) {
    const a = parseInt(mappedHex[1]!, 16);
    const b = parseInt(mappedHex[2]!, 16);
    ip = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  const family = net.isIP(ip);
  if (family === 0) return true; // not an IP at all: refuse
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export interface UrlPolicy {
  /** Explicit internal-monitoring policy (ALLOW_PRIVATE_TARGETS). Disabled by default. */
  allowPrivate?: boolean;
  /** Programmatic exemptions for exact IP addresses (used by tests; never populated from user input or env). */
  allowAddresses?: string[];
}

const exempt = (policy: UrlPolicy, ip: string) => Boolean(policy.allowAddresses?.includes(ip));

/** Synchronous, DNS-free validation used at input time (API, import). */
export function validateMonitorUrl(raw: string, policy: UrlPolicy = {}): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`Unsupported URL scheme "${u.protocol.replace(':', '')}" (only http and https are allowed)`);
  }
  if (u.username || u.password) throw new SsrfError('URLs with embedded credentials are not allowed');
  if (!u.hostname) throw new SsrfError('URL has no host');
  if (!policy.allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (BLOCKED_HOSTNAMES.some((r) => r.test(host))) throw new SsrfError('Host name is not allowed (internal/loopback)');
    if (net.isIP(host) && isBlockedAddress(host) && !exempt(policy, host)) throw new SsrfError('IP address is private, loopback or reserved');
    // Decimal/octal/hex IPv4 forms like http://2130706433 are normalised by WHATWG URL to dotted quad
    // before we get here, so the isIP check above covers them.
  }
  return u;
}

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/** Resolve a hostname and make sure every answer is public. Returns the address to pin. */
export async function resolvePublic(
  hostname: string,
  policy: UrlPolicy = {},
  lookup: typeof dns.promises.lookup = dns.promises.lookup,
): Promise<ResolvedTarget> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!policy.allowPrivate && isBlockedAddress(host) && !exempt(policy, host)) throw new SsrfError('Target address is private or reserved');
    return { address: host, family: net.isIP(host) as 4 | 6 };
  }
  const answers = await lookup(host, { all: true, verbatim: true });
  if (!answers.length) {
    const e: NodeJS.ErrnoException = new Error(`ENOTFOUND ${host}`);
    e.code = 'ENOTFOUND';
    throw e;
  }
  if (!policy.allowPrivate) {
    for (const a of answers) {
      if (isBlockedAddress(a.address) && !exempt(policy, a.address)) {
        throw new SsrfError(`Host resolves to a private or reserved address (${a.address})`);
      }
    }
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family as 4 | 6 };
}
