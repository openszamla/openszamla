/**
 * S1: the /mcp token-guessing throttle cannot be bypassed with forged client addresses.
 * - X-Forwarded-For is ignored unless the operator opts in (OPENSZAMLA_TRUST_PROXY=1, HttpOptions.trustProxy) –
 *   any local program, a TCP tunnel (ssh -R, frp, ngrok) or a proxy that passes the client's own header through
 *   would otherwise let the client pick a fresh "address" for every guess;
 * - past the global cap of wrong tokens, an address that has not authenticated successfully in the last 60 minutes
 *   is refused (429 + Retry-After) without its token being checked, so a guess spread over many (real or forged)
 *   addresses gets at most the cap per window, while a connector that already works keeps working.
 */
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/mcp/http.ts';
import { AddressThrottle, clientAddress } from '../../src/web/security.ts';
import { makeTestApp } from '../helpers/app.ts';
import { isRun, removeTempDirs, serve, tempDir } from '../helpers/cli.ts';
import { rawRequest, type Res } from '../web/helpers.ts';

const TOKEN = 'forwarded-for-test-token-0123456789-abcdef';
const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const GLOBAL_MESSAGE = /Túl sok hibás hozzáférési token érkezett a szerverre, ezért most csak az elmúlt 60 percben sikeresen azonosított címekről fogad kérést – próbáld újra \d+ másodperc múlva\./;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  removeTempDirs();
});

async function server(trustProxy?: boolean): Promise<RunningHttpServer> {
  const t = makeTestApp();
  const http = await startHttpServer(t.app, { port: 0, token: TOKEN, web: false, ...(trustProxy === undefined ? {} : { trustProxy }) });
  cleanups.push(async () => {
    await http.close();
    t.cleanup();
  });
  return http;
}

/** POST tools/list to /mcp from this machine, claiming the client address `xff` in X-Forwarded-For. */
function mcp(base: string, bearer: string, xff?: string): Promise<Res> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(PING)),
    authorization: `Bearer ${bearer}`,
  };
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  return rawRequest(base, 'POST', '/mcp', { headers, body: PING });
}

const req = (remoteAddress: string, xff?: string): IncomingMessage =>
  ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

describe('X-Forwarded-For is ignored unless the operator opts in', () => {
  it('clientAddress: the connecting peer by default, also for a peer on this machine', () => {
    expect(clientAddress(req('127.0.0.1', '203.0.113.9'))).toBe('127.0.0.1');
    expect(clientAddress(req('::1', '[2001:db8:1:2:3::4]:443'))).toBe('0:0:0:0::/64');
    expect(clientAddress(req('::ffff:127.0.0.1', '203.0.113.9'), false)).toBe('127.0.0.1');
    // With the opt-in: the last entry, and only from this machine.
    expect(clientAddress(req('127.0.0.1', '198.18.0.1, 203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientAddress(req('198.51.100.1', '203.0.113.9'), true)).toBe('198.51.100.1');
  });

  it('a local client rotating X-Forwarded-For is refused after 10 wrong tokens like any other address', async () => {
    const http = await server();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await mcp(http.url, `guess-${i}`, `198.18.0.${i + 1}`)).status);
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(401));
    expect(new Set(statuses.slice(10))).toEqual(new Set([429]));
    // The address is the loopback peer: the right token from there waits too (every client behind a proxy shares it).
    const right = await mcp(http.url, TOKEN, '198.19.0.1');
    expect(right.status).toBe(429);
    expect(JSON.parse(right.body).error.message).toMatch(/^Túl sok hibás hozzáférési token erről a címről – próbáld újra \d+ másodperc múlva\.$/);
  });

  it('openszamla serve trusts X-Forwarded-For only with OPENSZAMLA_TRUST_PROXY=1, and says so at start', async () => {
    const line = 'Kliens címe a /mcp korlátjához: a saját gépről érkező kapcsolatnál az X-Forwarded-For fejléc utolsó eleme (OPENSZAMLA_TRUST_PROXY)';
    for (const [env, trusted] of [[{}, false], [{ OPENSZAMLA_TRUST_PROXY: '' }, false], [{ OPENSZAMLA_TRUST_PROXY: 'nem' }, false], [{ OPENSZAMLA_TRUST_PROXY: '1' }, true]] as const) {
      const dir = tempDir();
      const s = await serve(['--data-dir', dir, '--port', '0', '--token', TOKEN], /PDF másolása mappába[^\n]*\n/, { env: { ...env } });
      if (isRun(s)) throw new Error(`serve did not start: ${s.stderr}`);
      try {
        expect(s.stderr.includes(line), JSON.stringify(env)).toBe(trusted);
        const base = /MCP végpont:\s+(http:\/\/\S+)\/mcp/.exec(s.stderr)?.[1];
        if (!base) throw new Error(`no MCP endpoint: ${s.stderr}`);
        for (let i = 0; i < 10; i++) expect((await mcp(base, `guess-${i}`, '203.0.113.5')).status).toBe(401);
        // Another client behind the proxy: its own address with the opt-in, the shared loopback address without it.
        expect((await mcp(base, 'other-guess', '203.0.113.6')).status, JSON.stringify(env)).toBe(trusted ? 401 : 429);
      } finally {
        await s.stop();
      }
    }
  });
});

describe('past the global cap only recently authenticated addresses may present a token', () => {
  it('a fresh address is refused without a token check, even with the right token; a working connector is not', async () => {
    const http = await server(true);
    expect((await mcp(http.url, TOKEN, '198.51.100.7')).status).toBe(200); // the connector, before the guessing starts
    // 100 wrong tokens, each from another (forged) address: the per-address limit never triggers.
    for (let i = 0; i < 100; i++) expect((await mcp(http.url, `guess-${i}`, `198.18.${i >> 8}.${i & 255}`)).status).toBe(401);
    const late: Array<[string, string]> = [['guess-100', '198.18.1.1'], [TOKEN, '198.18.1.2'], ['guess-0', '198.18.0.0']];
    for (const [bearer, xff] of late) {
      const r = await mcp(http.url, bearer, xff);
      expect(r.status, `${xff}`).toBe(429);
      const wait = Number(r.headers['retry-after']);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(JSON.parse(r.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
      expect(JSON.parse(r.body).error.message).toMatch(GLOBAL_MESSAGE);
    }
    expect((await mcp(http.url, TOKEN, '198.51.100.7')).status).toBe(200);
  });

  it('AddressThrottle: the cause, the wait, and a success remembered for 60 minutes (bounded)', () => {
    const NOW = Date.parse('2026-11-14T09:00:00.000Z');
    const t = new AddressThrottle({ perAddress: 2, global: 3, windowMs: 60_000, maxAddresses: 2 });
    t.succeed('connector', NOW - 60 * 60_000 + 5_000);
    t.succeed('old', NOW - 60 * 60_000);
    t.fail('a', NOW);
    t.fail('a', NOW + 1_000);
    expect(t.check('a', NOW + 1_000)).toEqual({ seconds: 59, cause: 'address' });
    expect(t.check('fresh', NOW + 1_000)).toBeNull();
    t.fail('b', NOW + 2_000);
    expect(t.check('fresh', NOW + 2_000)).toEqual({ seconds: 58, cause: 'global' });
    expect(t.check('a', NOW + 2_000)).toEqual({ seconds: 58, cause: 'address' });
    expect(t.check('connector', NOW + 2_000)).toBeNull();
    expect(t.check('old', NOW + 2_000)).toEqual({ seconds: 58, cause: 'global' });
    // The success is forgotten after 60 minutes; the cap clears when its oldest failure leaves the window.
    expect(t.check('connector', NOW + 5_000)).toEqual({ seconds: 55, cause: 'global' });
    expect(t.check('fresh', NOW + 60_000)).toBeNull();
    // Memory stays bounded: the address that succeeded longest ago is forgotten first.
    const u = new AddressThrottle({ perAddress: 10, global: 1, maxAddresses: 2 });
    for (const a of ['x', 'y', 'z']) u.succeed(a, NOW);
    u.fail('g', NOW);
    expect(u.check('x', NOW)?.cause).toBe('global');
    expect(u.check('y', NOW)).toBeNull();
    expect(u.check('z', NOW)).toBeNull();
  });
});
