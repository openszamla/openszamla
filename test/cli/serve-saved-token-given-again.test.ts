/**
 * S3: a token given with --token or OPENSZAMLA_HTTP_TOKEN that is the one saved in <dataDir>/http-token counts as
 * the saved token. docs/kliensek.md tells Codex users to export the file's token as OPENSZAMLA_HTTP_TOKEN; a weak
 * saved token must then start with the warning, as it does without the variable – not refuse the start. Any other
 * weak value given there is still refused.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRun, removeTempDirs, serve, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

const STARTED = /PDF másolása mappába[^\n]*\n/;
const WEAK = 'Szamla+2026#titok&x=%41';

describe('the saved weak token given once more', () => {
  it('in OPENSZAMLA_HTTP_TOKEN or with --token: serve starts with the warning about the saved token', async () => {
    const cases: Array<[string[], Record<string, string>]> = [
      [[], { OPENSZAMLA_HTTP_TOKEN: WEAK }],
      [[], { OPENSZAMLA_HTTP_TOKEN: ` ${WEAK} ` }],
      [['--token', WEAK], {}],
    ];
    for (const [args, env] of cases) {
      const dir = tempDir();
      writeFileSync(join(dir, 'http-token'), `${WEAK}\n`);
      const s = await serve(['--data-dir', dir, '--port', '0', ...args], STARTED, { env });
      if (isRun(s)) throw new Error(`serve did not start (${JSON.stringify([args, env])}, exit ${s.code}): ${s.stderr}`);
      await s.stop();
      expect(s.stderr).toContain(`FIGYELEM: a(z) ${join(dir, 'http-token')} fájlban lévő hozzáférési token gyenge: az angol ábécé betűin`);
      expect(s.stderr).toContain(`/?token=${encodeURIComponent(WEAK)}\n`);
      expect(s.stderr).not.toContain('Hiba [');
      expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe(`${WEAK}\n`);
    }
  });

  it('another weak value is still refused, and a strong custom token gets no warning', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'http-token'), WEAK);
    const r = await serve(['--data-dir', dir, '--port', '0'], STARTED, { env: { OPENSZAMLA_HTTP_TOKEN: `${WEAK}x` } });
    if (!isRun(r)) {
      await r.stop();
      throw new Error(`serve started: ${r.stderr}`);
    }
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [INVALID_INPUT]: A(z) OPENSZAMLA_HTTP_TOKEN változóban megadott hozzáférési token túl gyenge');
    expect(r.stderr).not.toContain(WEAK);

    const s = await serve(['--data-dir', dir, '--port', '0', '--token', 'Sajat_Token-2026-abcdefgh'], STARTED);
    if (isRun(s)) throw new Error(`serve did not start: ${s.stderr}`);
    await s.stop();
    expect(s.stderr).not.toContain('FIGYELEM');
  });
});
