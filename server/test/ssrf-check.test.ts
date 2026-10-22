import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performCheck } from '../src/monitor/http-check.js';
import { isBlockedAddress, resolvePublic, validateMonitorUrl } from '../src/security/ssrf.js';
import { parseExpectedStatus, statusMatches } from '../src/lib/status.js';

describe('SSRF protection', () => {
  it('blocks private, loopback, link-local, metadata and reserved addresses (v4 + v6 + mapped)', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'ff02::1', 'not-an-ip']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('validates URL syntax and schemes without DNS', () => {
    expect(() => validateMonitorUrl('https://example.com/path?q=1')).not.toThrow();
    for (const bad of ['ftp://x.com', 'gopher://x.com', 'file:///etc/passwd', 'data:text/html,hi', 'http://localhost:8080', 'http://a.localhost', 'http://0x7f.0.0.1', 'http://017700000001', 'http://[::ffff:7f00:1]', 'http://u:p@x.com', 'http://x.local', '']) {
      expect(() => validateMonitorUrl(bad), bad).toThrow();
    }
  });

  it('allows private targets only under an explicit policy', () => {
    expect(() => validateMonitorUrl('http://10.0.0.5', { allowPrivate: true })).not.toThrow();
    expect(() => validateMonitorUrl('http://10.0.0.5')).toThrow();
  });

  it('re-validates DNS answers: a name resolving to a private address is refused (DNS rebinding)', async () => {
    const rebind: any = async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }];
    await expect(resolvePublic('evil.example.com', {}, rebind)).rejects.toThrow(/private or reserved/);
    const good: any = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(resolvePublic('ok.example.com', {}, good)).resolves.toMatchObject({ address: '93.184.216.34' });
  });
});

describe('status expressions', () => {
  it('parses and matches', () => {
    expect(parseExpectedStatus('200-299, 301')).toEqual([[200, 299], [301, 301]]);
    expect(statusMatches('200-399', 301)).toBe(true);
    expect(statusMatches('200-399', 404)).toBe(false);
    expect(statusMatches('200,401', 401)).toBe(true);
    expect(() => parseExpectedStatus('abc')).toThrow();
    expect(() => parseExpectedStatus('300-200')).toThrow();
  });
});

describe('HTTP checker', () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url!);
      const u = req.url!;
      if (u === '/ok') { res.writeHead(200); res.end('ok'); }
      else if (u === '/500') { res.writeHead(500); res.end('boom'); }
      else if (u === '/404') { res.writeHead(404); res.end(); }
      else if (u === '/slow') { setTimeout(() => { res.writeHead(200); res.end(); }, 3000); }
      else if (u === '/r1') { res.writeHead(302, { Location: '/r2' }); res.end(); }
      else if (u === '/r2') { res.writeHead(301, { Location: '/ok' }); res.end(); }
      else if (u === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
      else if (u === '/to-metadata') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); }
      else if (u === '/to-ftp') { res.writeHead(302, { Location: 'ftp://example.com/x' }); res.end(); }
      else if (u === '/reset') { req.socket.destroy(); }
      else { res.writeHead(200); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const opts = (p: string, o: object = {}) => ({ url: base + p, timeoutMs: 2000, maxRedirects: 5, expectedStatus: '200-399', allowAddresses: ['127.0.0.1'], ...o });

  it('succeeds on 200 and records latency + final URL', async () => {
    const r = await performCheck(opts('/ok'));
    expect(r).toMatchObject({ success: true, statusCode: 200, errorCategory: null, redirectCount: 0 });
    expect(r.responseMs).toBeGreaterThanOrEqual(0);
    expect(r.finishedAt.getTime()).toBeGreaterThanOrEqual(r.startedAt.getTime());
  });

  it('classifies unexpected status codes (not every status is success)', async () => {
    expect(await performCheck(opts('/500'))).toMatchObject({ success: false, statusCode: 500, errorCategory: 'http_status' });
    expect(await performCheck(opts('/404'))).toMatchObject({ success: false, statusCode: 404, errorCategory: 'http_status' });
    expect(await performCheck(opts('/404', { expectedStatus: '200,404' }))).toMatchObject({ success: true, statusCode: 404 });
    expect(await performCheck(opts('/ok', { expectedStatus: '201' }))).toMatchObject({ success: false, errorCategory: 'http_status' });
  });

  it('times out slow servers', async () => {
    const r = await performCheck(opts('/slow', { timeoutMs: 700 }));
    expect(r).toMatchObject({ success: false, errorCategory: 'timeout' });
    expect(r.finishedAt.getTime() - r.startedAt.getTime()).toBeLessThan(1800);
  });

  it('follows redirects up to the limit and reports loops', async () => {
    expect(await performCheck(opts('/r1'))).toMatchObject({ success: true, statusCode: 200, redirectCount: 2 });
    expect(await performCheck(opts('/loop', { maxRedirects: 3 }))).toMatchObject({ success: false, errorCategory: 'redirect', redirectCount: 3 });
    // maxRedirects=0 evaluates the redirect response itself
    expect(await performCheck(opts('/r1', { maxRedirects: 0 }))).toMatchObject({ statusCode: 302, success: true });
  });

  it('refuses redirects to metadata / private / unsupported destinations', async () => {
    expect(await performCheck(opts('/to-metadata'))).toMatchObject({ success: false, errorCategory: 'ssrf_blocked' });
    expect(await performCheck(opts('/to-ftp'))).toMatchObject({ success: false, errorCategory: 'ssrf_blocked' });
  });

  it('blocks direct private targets (no allow-list)', async () => {
    const r = await performCheck({ url: `${base}/ok`, timeoutMs: 1000, maxRedirects: 2, expectedStatus: '200-399' });
    expect(r).toMatchObject({ success: false, errorCategory: 'ssrf_blocked' });
    expect(hits.filter((h) => h === '/to-metadata').length).toBeGreaterThan(0);
  });

  it('classifies connection refused, resets and DNS errors', async () => {
    const free: number = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
    expect(await performCheck({ ...opts('/'), url: `http://127.0.0.1:${free}/` })).toMatchObject({ success: false, errorCategory: 'connect' });
    expect(await performCheck(opts('/reset'))).toMatchObject({ success: false, errorCategory: 'connect' });
    const nx: any = async () => { const e: any = new Error('nx'); e.code = 'ENOTFOUND'; throw e; };
    expect(await performCheck({ url: 'http://does-not-exist.example/', timeoutMs: 1000, maxRedirects: 1, expectedStatus: '200', lookup: nx })).toMatchObject({ success: false, errorCategory: 'dns' });
  });

  it('pins the validated address: the connection goes to the resolved IP even if the name would resolve elsewhere', async () => {
    let calls = 0;
    const lookup: any = async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; };
    const port = new URL(base).port;
    const r = await performCheck({ url: `http://pinned.example:${port}/ok`, timeoutMs: 1500, maxRedirects: 0, expectedStatus: '200', lookup, allowAddresses: ['127.0.0.1'] });
    expect(r.success).toBe(true);
    expect(calls).toBe(1); // resolved exactly once; the socket connected to the pinned address
  });
});
