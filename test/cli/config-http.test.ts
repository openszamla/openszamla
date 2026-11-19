/**
 * WEB-12: `openszamla config http` writes a data directory other than the built-in ~/.openszamla into the
 * serve command and names its token file (7.9) – also when it comes from OPENSZAMLA_HOME, which a desktop
 * shortcut or another shell does not have – in the form every hint gives (dataDirOption: `~` for a folder under
 * the home folder, which the program expands itself). The default output is unchanged.
 */
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

describe('openszamla config http', () => {
  it('a data directory from --data-dir or OPENSZAMLA_HOME goes into the serve command and the token path', async () => {
    const home = tempDir();
    const dir = join(home, 'Könyvelés', 'OpenSzámla');
    for (const [args, env] of [
      [['config', 'http', '--data-dir', dir], {}],
      [['config', 'http'], { OPENSZAMLA_HOME: dir }],
    ] as const) {
      const r = await cli([...args], { env: { HOME: home, USERPROFILE: home, ...env } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`\nopenszamla serve --data-dir "~${sep}Könyvelés${sep}OpenSzámla" --host 127.0.0.1 --port 8787\n`);
      expect(r.stdout).toContain(`(token: ${join(dir, 'http-token')})`);
      expect(r.stdout).not.toContain('<adatkönyvtár>');
    }
  });

  it('a data directory outside the home folder: its full path', async () => {
    const home = tempDir();
    const dir = join(tempDir(), 'Számlák');
    const r = await cli(['config', 'http', '--data-dir', dir], { env: { HOME: home, USERPROFILE: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`\nopenszamla serve --data-dir "${dir}" --host 127.0.0.1 --port 8787\n`);
  });

  it('the built-in data directory: unchanged output', async () => {
    const home = tempDir();
    const r = await cli(['config', 'http'], { env: { HOME: home, USERPROFILE: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('\nopenszamla serve --host 127.0.0.1 --port 8787\n');
    expect(r.stdout).toContain('(token: <adatkönyvtár>/http-token)');
    expect(r.stdout).not.toContain('--data-dir');
  });
});
