/**
 * WEB-14: a bad --port, a busy port and a data directory that cannot be one end with "Hiba [<KÓD>]: …"
 * and "Tipp: …" (7.1), not with an English stack trace; in stdio mode stdout stays clean.
 */
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { startHttpServer } from '../../src/mcp/http.ts';
import { makeTestApp } from '../helpers/app.ts';
import { cli, isRun, removeTempDirs, serve, tempDir } from '../helpers/cli.ts';

const blockers: Server[] = [];
afterEach(async () => {
  removeTempDirs();
  while (blockers.length) await new Promise((r) => (blockers.pop() as Server).close(r));
});

/** A port taken by another program. */
async function busyPort(): Promise<number> {
  const s = createServer();
  blockers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as { port: number }).port;
}

function noStackTrace(stderr: string): void {
  expect(stderr).not.toMatch(/\n\s+at /);
  expect(stderr).not.toMatch(/^Hiba: [A-Za-z]*Error/m);
}

describe('serve: port problems', () => {
  it('--port and OPENSZAMLA_HTTP_PORT must be an integer from 0 to 65535', async () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [['--port', 'abc'], {}, 'Érvénytelen port (--port): abc'],
      [['--port', '65536'], {}, 'Érvénytelen port (--port): 65536'],
      [['--port', '80.5'], {}, 'Érvénytelen port (--port): 80.5'],
      [[], { OPENSZAMLA_HTTP_PORT: 'nyolcezer' }, 'Érvénytelen port (OPENSZAMLA_HTTP_PORT): nyolcezer'],
    ];
    for (const [args, env, message] of cases) {
      const dir = join(tempDir(), 'adatok');
      const r = await cli(['serve', '--data-dir', dir, ...args], { env });
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toContain(`Hiba [INVALID_INPUT]: ${message}\n`);
      expect(r.stderr).toContain('Tipp: A port 0 és 65535 közötti egész szám');
      noStackTrace(r.stderr);
    }
  });

  it('a busy port is PORT_IN_USE with a hint', async () => {
    const port = await busyPort();
    const r = await serve(['--data-dir', tempDir(), '--port', String(port)], /Webes felület/);
    if (!isRun(r)) {
      await r.stop();
      throw new Error('serve started on a busy port');
    }
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Hiba [PORT_IN_USE]: A port már foglalt: 127.0.0.1:${port}.`);
    expect(r.stderr).toContain('Tipp: Fut már egy openszamla serve (vagy más program) ezen a porton?');
    noStackTrace(r.stderr);
  });

  it('startHttpServer itself rejects with the AppError', async () => {
    const port = await busyPort();
    const t = makeTestApp();
    try {
      const e: unknown = await startHttpServer(t.app, { port, token: 'x'.repeat(32), web: false }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(AppError);
      expect(e).toMatchObject({ code: 'PORT_IN_USE' });
    } finally {
      t.cleanup();
    }
  });
});

describe('a data directory that cannot be one', () => {
  it('a file in its place, or in its path: DATA_DIR_UNAVAILABLE naming the folder', async () => {
    const file = join(tempDir(), 'adatok.txt');
    writeFileSync(file, 'nem mappa');
    for (const dir of [file, join(file, 'alkonyvtar')]) {
      const r = await cli(['status', '--data-dir', dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Hiba [DATA_DIR_UNAVAILABLE]: Az adatkönyvtár nem hozható létre és nem nyitható meg: ${dir} – a helyén vagy az útvonalában fájl van, nem mappa.`);
      expect(r.stderr).toContain('Tipp: Adj meg egy létező vagy létrehozható mappát');
      noStackTrace(r.stderr);
    }
  });

  it('the folder of OPENSZAMLA_DB too', async () => {
    const file = join(tempDir(), 'adatok.txt');
    writeFileSync(file, 'nem mappa');
    const r = await cli(['status', '--data-dir', tempDir()], { env: { OPENSZAMLA_DB: join(file, 'openszamla.db') } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Hiba [DATA_DIR_UNAVAILABLE]: Az adatbázis mappája nem hozható létre és nem nyitható meg: ${file}`);
  });

  it('mcp (stdio) and serve report it on stderr; stdout stays clean', async () => {
    const file = join(tempDir(), 'adatok.txt');
    writeFileSync(file, 'nem mappa');
    const mcp = await cli(['mcp'], { env: { OPENSZAMLA_HOME: file } });
    expect(mcp.code).toBe(1);
    expect(mcp.stdout).toBe('');
    expect(mcp.stderr).toContain('Hiba [DATA_DIR_UNAVAILABLE]');
    noStackTrace(mcp.stderr);
    const srv = await cli(['serve', '--data-dir', file, '--port', '0']);
    expect(srv.code).toBe(1);
    expect(srv.stderr).toContain('Hiba [DATA_DIR_UNAVAILABLE]');
    noStackTrace(srv.stderr);
  });
});
