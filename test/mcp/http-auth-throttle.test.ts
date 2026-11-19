/**
 * WEB-8: /mcp (and /mcp/<token>) limit wrong access tokens per client address, with a global cap,
 * and answer 429 with Retry-After. A client that works with the right token – e.g. the claude.ai connector
 * while someone else guesses – is not refused (past the global cap: if it authenticated in the last hour).
 * These servers take the address from X-Forwarded-For (trustProxy, OPENSZAMLA_TRUST_PROXY), as behind a
 * local reverse proxy; without it see http-throttle-forwarded-for.test.ts.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/mcp/http.ts';
import { AddressThrottle, clientAddress } from '../../src/web/security.ts';
import { makeTestApp } from '../helpers/app.ts';
import { rawRequest, type Res } from '../web/helpers.ts';

const TOKEN = 'throttle-test-token-0123456789-abcdef';
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function server(): Promise<RunningHttpServer> {
  const t = makeTestApp();
  const http = await startHttpServer(t.app, { port: 0, token: TOKEN, web: false, trustProxy: true });
  cleanups.push(async () => {
    await http.close();
    t.cleanup();
  });
  return http;
}

/** POST tools/list to /mcp; `from` is the client address the local reverse proxy reports (X-Forwarded-For). */
function mcp(http: RunningHttpServer, o: { from: string; bearer?: string; path?: string }): Promise<Res> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(PING)),
    'x-forwarded-for': o.from,
  };
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  return rawRequest(http.url, 'POST', o.path ?? '/mcp', { headers, body: PING });
}

describe('/mcp token guessing is limited per address', () => {
  it('10 wrong tokens from one address, then 429 with Retry-After for that address only', async () => {
    const http = await server();
    for (let i = 0; i < 10; i++) expect((await mcp(http, { from: '203.0.113.5', bearer: `guess-${i}` })).status, `attempt ${i + 1}`).toBe(401);
    const refused = await mcp(http, { from: '203.0.113.5', bearer: 'guess-10' });
    expect(refused.status).toBe(429);
    const wait = Number(refused.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect(JSON.parse(refused.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect(JSON.parse(refused.body).error.message).toMatch(/Túl sok hibás hozzáférési token erről a címről/);
    // The waiting address is not checked at all – not even with the right token (that would let the guessing go on).
    expect((await mcp(http, { from: '203.0.113.5', bearer: TOKEN })).status).toBe(429);
    // Others are not affected: the right token from another address works, a wrong one is a plain 401.
    expect((await mcp(http, { from: '198.51.100.7', bearer: TOKEN })).status).toBe(200);
    expect((await mcp(http, { from: '198.51.100.8', bearer: 'nope' })).status).toBe(401);
  });

  it('the token in the path counts the same; requests without any token are not counted', async () => {
    const http = await server();
    for (let i = 0; i < 20; i++) expect((await mcp(http, { from: '192.0.2.1' })).status).toBe(401);
    expect((await mcp(http, { from: '192.0.2.1', bearer: TOKEN })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await mcp(http, { from: '192.0.2.2', path: `/mcp/guess-${i}` })).status).toBe(401);
    expect((await mcp(http, { from: '192.0.2.2', path: `/mcp/${TOKEN}` })).status).toBe(429);
    expect((await mcp(http, { from: '192.0.2.3', path: `/mcp/${TOKEN}` })).status).toBe(200);
  });

  it('a guess spread over many addresses: past the global cap only a recently authenticated client still gets in', async () => {
    const http = await server();
    expect((await mcp(http, { from: '10.0.1.2', bearer: TOKEN })).status).toBe(200);
    for (let a = 1; a <= 10; a++) {
      for (let i = 0; i < 10; i++) expect((await mcp(http, { from: `10.0.0.${a}`, bearer: `g-${a}-${i}` })).status).toBe(401);
    }
    expect((await mcp(http, { from: '10.0.1.1', bearer: 'fresh-guess' })).status).toBe(429);
    expect((await mcp(http, { from: '10.0.1.2', bearer: TOKEN })).status).toBe(200);
  });
});

describe('AddressThrottle', () => {
  const NOW = Date.parse('2026-10-27T09:00:00.000Z');

  it('blocks an address after its limit until the oldest counted failure leaves the window', () => {
    const t = new AddressThrottle({ perAddress: 3, global: 100, windowMs: 60_000 });
    t.fail('a', NOW);
    t.fail('a', NOW + 10_000);
    expect(t.retryAfterSeconds('a', NOW + 10_001)).toBe(0);
    t.fail('a', NOW + 20_000);
    expect(t.retryAfterSeconds('a', NOW + 20_001)).toBe(40);
    expect(t.retryAfterSeconds('b', NOW + 20_001)).toBe(0);
    expect(t.retryAfterSeconds('a', NOW + 60_000)).toBe(0);
  });

  it('past the global cap every address waits, except one that authenticated in the last hour', () => {
    const t = new AddressThrottle({ perAddress: 10, global: 3, windowMs: 60_000 });
    t.succeed('known', NOW - 59 * 60_000);
    t.fail('a', NOW);
    t.fail('b', NOW + 1_000);
    expect(t.retryAfterSeconds('a', NOW + 2_000)).toBe(0);
    t.fail('c', NOW + 2_000);
    // Free when the total falls below the cap (at NOW + 60 s).
    expect(t.retryAfterSeconds('a', NOW + 2_000)).toBe(58);
    expect(t.retryAfterSeconds('c', NOW + 2_000)).toBe(58);
    expect(t.retryAfterSeconds('clean', NOW + 2_000)).toBe(58);
    expect(t.retryAfterSeconds('known', NOW + 2_000)).toBe(0);
    expect(t.retryAfterSeconds('c', NOW + 60_000)).toBe(0);
  });

  it('keeps memory bounded', () => {
    const t = new AddressThrottle({ perAddress: 1, global: 1_000_000, maxAddresses: 2 });
    t.fail('a', NOW);
    t.fail('b', NOW);
    t.fail('c', NOW);
    expect(t.retryAfterSeconds('a', NOW)).toBe(0);
    expect(t.retryAfterSeconds('c', NOW)).toBeGreaterThan(0);
  });
});

describe('clientAddress', () => {
  const req = (remoteAddress: string, xff?: string): IncomingMessage =>
    ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

  it('with trustProxy: X-Forwarded-For only from this machine (a local reverse proxy), and then only its last entry', () => {
    expect(clientAddress(req('127.0.0.1', '10.9.9.9, 203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientAddress(req('::ffff:127.0.0.1', '203.0.113.9:51234'), true)).toBe('203.0.113.9');
    expect(clientAddress(req('203.0.113.1', '198.51.100.1'), true)).toBe('203.0.113.1');
    expect(clientAddress(req('127.0.0.1', 'not an address'), true)).toBe('127.0.0.1');
    expect(clientAddress(req('127.0.0.1'), true)).toBe('127.0.0.1');
  });

  it('counts IPv4-mapped addresses as IPv4 and IPv6 addresses by their /64 network', () => {
    expect(clientAddress(req('::ffff:198.51.100.2'))).toBe('198.51.100.2');
    expect(clientAddress(req('2001:db8:abcd:12::1'))).toBe('2001:db8:abcd:12::/64');
    expect(clientAddress(req('2001:0db8:abcd:0012:ffff:1:2:3'))).toBe('2001:db8:abcd:12::/64');
    expect(clientAddress(req('::1', '[2001:db8:1:2:3::4]:443'), true)).toBe('2001:db8:1:2::/64');
    expect(clientAddress(req('fe80::1%eth0'))).toBe('fe80:0:0:0::/64');
  });
});
