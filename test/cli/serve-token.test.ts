/**
 * The access token of `openszamla serve`: an empty --token counts as not given and never replaces the
 * saved http-token file (WEB-9); a weak token given with --token or OPENSZAMLA_HTTP_TOKEN is refused, a
 * weak saved one only warned about (WEB-8); the printed login link carries the token URL-encoded, and a
 * saved token with special characters works as link, Bearer header and /mcp/<token> path (WEB-10).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, isRun, removeTempDirs, serve, tempDir, type CliRun, type Serving } from '../helpers/cli.ts';
import { rawRequest } from '../web/helpers.ts';

afterEach(() => removeTempDirs());

const STARTED = /PDF másolása mappába[^\n]*\n/;
const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };

/** Starts serve on a free port (until its last startup line, after any warning); fails the test if it does not start. */
async function started(dir: string, args: string[] = [], env: Record<string, string> = {}): Promise<Serving> {
  const r = await serve(['--data-dir', dir, '--port', '0', ...args], STARTED, { env });
  if (isRun(r)) throw new Error(`serve did not start (exit ${r.code}): ${r.stderr}`);
  return r;
}

/** Runs serve expecting it to refuse to start. */
async function refused(dir: string, args: string[] = [], env: Record<string, string> = {}): Promise<CliRun> {
  const r = await serve(['--data-dir', dir, '--port', '0', ...args], STARTED, { env });
  if (!isRun(r)) {
    await r.stop();
    throw new Error(`serve started: ${r.stderr}`);
  }
  return r;
}

function loginLink(stderr: string): string {
  const link = /Webes felület: (\S+)/.exec(stderr)?.[1];
  if (!link) throw new Error(`no login link: ${stderr}`);
  return link;
}

const SAVED = 'Mentett-Token-a-claude-ai-connectorhoz-2026';

describe('an empty --token counts as not given (WEB-9)', () => {
  it('the saved token stays in use and in its file', async () => {
    for (const empty of ['', '   ']) {
      const dir = tempDir();
      writeFileSync(join(dir, 'http-token'), SAVED);
      const s = await started(dir, ['--token', empty]);
      await s.stop();
      expect(loginLink(s.stderr)).toMatch(new RegExp(`/\\?token=${SAVED}$`));
      expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe(SAVED);
    }
  });

  it('an empty http-token file is not overwritten either: serve refuses to start and says what to do', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'http-token'), '\n');
    const r = await refused(dir, ['--token', '']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Hiba [INVALID_CONFIG]: A hozzáférési token fájlja üres: ${join(dir, 'http-token')}`);
    expect(r.stderr).toContain('Tipp: Töröld a fájlt');
    expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe('\n');
  });

  it('without any token a new random one is generated and saved, and used again at the next start', async () => {
    const dir = tempDir();
    const first = await started(dir);
    await first.stop();
    const token = readFileSync(join(dir, 'http-token'), 'utf8');
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.stderr).not.toContain('FIGYELEM');
    const again = await started(dir);
    await again.stop();
    expect(loginLink(again.stderr).endsWith(`?token=${token}`)).toBe(true);
  });
});

describe('weak tokens (WEB-8, serve start)', () => {
  it('refuses a weak --token or OPENSZAMLA_HTTP_TOKEN without echoing it, before anything is created', async () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [['--token', 'Kovacs-Bt'], {}, 'A(z) --token kapcsolóval megadott hozzáférési token túl gyenge: 20 karakternél rövidebb.'],
      [['--token', 'Kovacs Bt szamlazo jelszava 2026'], {}, 'túl gyenge: az angol ábécé betűin, a számjegyeken, a „_” és a „-” jelen kívül más karaktert is tartalmaz.'],
      [[], { OPENSZAMLA_HTTP_TOKEN: 'Kovacs+Bt' }, 'A(z) OPENSZAMLA_HTTP_TOKEN változóban megadott hozzáférési token túl gyenge: 20 karakternél rövidebb, és az angol'],
    ];
    for (const [args, env, message] of cases) {
      const dir = join(tempDir(), 'adatok');
      const r = await refused(dir, args, env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(message);
      expect(r.stderr).toContain(`Tipp: Hagyd el, és a program a(z) ${join(dir, 'http-token')} fájlban lévő`);
      expect(r.stderr).not.toMatch(/Kovacs[ +-]Bt/);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('accepts a strong custom token (20+ characters of A–Z, a–z, 0–9, _ and -) and leaves the saved one alone', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'http-token'), SAVED);
    const custom = 'Sajat_Token-2026-abcdefgh';
    const s = await started(dir, ['--token', custom]);
    await s.stop();
    expect(loginLink(s.stderr).endsWith(`?token=${custom}`)).toBe(true);
    expect(s.stderr).not.toContain('FIGYELEM');
    expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe(SAVED);
  });
});

describe('a saved token with special characters (WEB-8 warning, WEB-10 encoded link)', () => {
  it('starts with a loud warning; the printed link, the Bearer header and /mcp/<token> all accept it', async () => {
    const dir = tempDir();
    const token = 'Szamla+2026#titok&x=%41';
    writeFileSync(join(dir, 'http-token'), token);
    const s = await started(dir);
    try {
      expect(s.stderr).toContain(`FIGYELEM: a(z) ${join(dir, 'http-token')} fájlban lévő hozzáférési token gyenge: az angol ábécé betűin`);
      expect(s.stderr).toContain('Cseréld le: töröld a fájlt, és indítsd újra a szervert');
      const link = loginLink(s.stderr);
      expect(link.endsWith(`/?token=${encodeURIComponent(token)}`), link).toBe(true);
      const base = new URL(link).origin;
      const login = await rawRequest(base, 'GET', link, { headers: NAVIGATE });
      expect(login.status).toBe(303);
      expect(login.headers['set-cookie']?.join(';')).toMatch(/openszamla_session=/);
      const form = new URLSearchParams({ token, next: '/' }).toString();
      const typed = await rawRequest(base, 'POST', '/login', {
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin', 'content-length': String(Buffer.byteLength(form)) },
        body: form,
      });
      expect(typed.status).toBe(303);
      const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      expect((await rawRequest(base, 'POST', '/mcp', { headers: { ...headers, authorization: `Bearer ${token}` }, body: list })).status).toBe(200);
      expect((await rawRequest(base, 'POST', `/mcp/${encodeURIComponent(token)}`, { headers, body: list })).status).toBe(200);
      expect((await rawRequest(base, 'POST', `/mcp/${encodeURIComponent('Szamla+2026#titok&x=%42')}`, { headers, body: list })).status).toBe(401);
    } finally {
      await s.stop();
    }
    expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe(token);
  });
});

describe('the other serve options', () => {
  it('an empty --host or --port counts as not given: 127.0.0.1, and the port from OPENSZAMLA_HTTP_PORT', async () => {
    const dir = tempDir();
    const s = await serve(['--data-dir', dir, '--host', '', '--port', ''], STARTED, { env: { OPENSZAMLA_HTTP_PORT: '0' } });
    if (isRun(s)) throw new Error(`serve did not start: ${s.stderr}`);
    await s.stop();
    expect(loginLink(s.stderr)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  });

  it('a mistyped option (--tokn) refuses the start: no token file is written, no generated token replaces the meant one', async () => {
    const dir = tempDir();
    const r = await cli(['serve', '--data-dir', dir, '--tokn', 'Sajat_Token-2026-abcdefgh']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Ismeretlen kapcsoló: --tokn');
    expect(existsSync(join(dir, 'http-token'))).toBe(false);
  });
});
