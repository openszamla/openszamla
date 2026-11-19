/**
 * `openszamla` without a command: in a terminal a short welcome pointing to setup, doctor and --help (7.); piped or
 * redirected, the help as before. The help lists the new commands and options.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { welcomeText } from '../../src/cli/setup.ts';
import { VERSION } from '../../src/version.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

describe('openszamla without a command', () => {
  it('the welcome names the first steps and where to read more', () => {
    const w = welcomeText();
    expect(w).toContain(`OpenSzámla ${VERSION}`);
    expect(w).toContain('Első használathoz futtasd:  openszamla setup');
    expect(w).toContain('openszamla doctor');
    expect(w).toContain('openszamla serve');
    expect(w).toContain('openszamla --help');
    expect(w).toContain(`https://github.com/openszamla/openszamla/blob/v${VERSION}/docs/felhasznaloi-dokumentacio.md`);
  });

  it('not in a terminal (stdout is a pipe): the help, exit 0, nothing created', async () => {
    const home = tempDir();
    const r = await cli([], { env: { HOME: home, USERPROFILE: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Használat: openszamla <parancs> [kapcsolók]');
    expect(r.stdout).not.toContain('Első használathoz futtasd');
  });

  it('the help lists setup, doctor and the new options of config', async () => {
    const r = await cli(['--help']);
    expect(r.stdout).toMatch(/\n {2}setup {20}első beállítás lépésenként: .*\[--client …\] \[--force\]/);
    expect(r.stdout).toMatch(/\n {2}doctor {19}a telepítés és a beállítások ellenőrzése, javítási tippekkel {2}\[--nav\]/);
    expect(r.stdout).toContain('[--write: beírás a kliens saját beállításába, biztonsági másolattal] [--force: meglévő bejegyzés cseréje]');
  });

  it('the new options belong to their commands only', async () => {
    const dir = tempDir();
    for (const [args, message] of [
      [['status', '--data-dir', dir, '--write'], 'A(z) --write kapcsoló a(z) status parancsnál nem használható.'],
      [['doctor', '--data-dir', dir, '--client', 'codex'], 'A(z) --client kapcsoló a(z) doctor parancsnál nem használható.'],
      [['setup', '--data-dir', dir, '--nav'], 'A(z) --nav kapcsoló a(z) setup parancsnál nem használható.'],
    ] as const) {
      const r = await cli([...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toContain(`Hiba [INVALID_INPUT]: ${message}`);
    }
  });
});
