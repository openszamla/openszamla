/**
 * U14, U15, U1: what setup, doctor and serve tell a non-technical user. Setup's production switch names the data
 * directory (dataDirOption, from the home folder the command runs with), setup and doctor link the NAV guide of this version instead of a repository path an
 * npm installation does not have, serve says to open the address in the browser, to keep the window open and that
 * Ctrl+C stops it – the MCP details below, the PDF-copy switch as an advanced setting –, and on Windows setup and doctor
 * say how a PowerShell that blocks npm's .ps1 starters runs the commands (.cmd, or Set-ExecutionPolicy).
 */
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientContext } from '../../src/cli/clients.ts';
import { doctorChecks, POWERSHELL_HINT } from '../../src/cli/doctor.ts';
import { runSetup } from '../../src/cli/setup.ts';
import { dataDirOption } from '../../src/service/config.ts';
import { VERSION } from '../../src/version.ts';
import { isRun, removeTempDirs, serve, tempDir } from '../helpers/cli.ts';
import { makeProfile, removeProfiles, runIn, type Profile } from '../helpers/client-profile.ts';

afterEach(() => {
  removeProfiles();
  removeTempDirs();
});

const GUIDE = `https://github.com/openszamla/openszamla/blob/v${VERSION}/docs/nav-beallitas.md`;

/** setup without a terminal (it asks nothing), on the given platform. */
async function setupText(p: Profile, platform: NodeJS.Platform, dataDir: string): Promise<string> {
  let shown = '';
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      shown += chunk.toString();
      cb();
    },
  });
  const ctx: ClientContext = { env: p.env, platform, cwd: p.work, dataDir, now: new Date() };
  await runSetup({ ctx, force: false, input: new PassThrough(), output });
  return shown;
}

describe('setup and doctor guidance (U14, U1)', () => {
  it('setup: the production switch with the data directory, the NAV guide of this version', async () => {
    const p = makeProfile();
    const dir = join(p.root, 'Kovács Anna', 'Számlák');
    const r = await runIn(p, ['setup', '--data-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    // The command names the data directory as the setup process sees it: its home folder is the profile's.
    const production = `openszamla nav-setup --env production${dataDirOption(dir, p.home, process.platform)}`;
    expect(production).toContain('--data-dir');
    expect(r.stdout).toContain(`Kezdd a TESZT rendszerrel; élesre később, az éles technikai felhasználó adataival állsz át (${production}).`);
    expect(r.stdout).toContain(`és az OpenSzámla leírása (${GUIDE}).`);
    expect(r.stdout).not.toMatch(/[^/]docs\/nav-beallitas\.md/);
  });

  it('doctor: the NAV guide of this version in the fix for a missing NAV connection', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['doctor']);
    // The built-in data directory (~/.openszamla of the profile) needs no --data-dir.
    expect(r.stdout).toContain(`→ Hozd létre a technikai felhasználót (lépésről lépésre: ${GUIDE}), majd: openszamla nav-setup (telepítés nélkül: npx -y openszamla nav-setup)`);
    expect(r.stdout).not.toMatch(/[^/]docs\/nav-beallitas\.md/);
  });

  it('on Windows setup and doctor say how PowerShell runs the commands; elsewhere they do not', async () => {
    const p = makeProfile();
    const dataDir = join(p.home, '.openszamla');
    expect(POWERSHELL_HINT).toContain('openszamla.cmd');
    expect(POWERSHELL_HINT).toContain('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
    expect(await setupText(p, 'win32', dataDir)).toContain(`  • ${POWERSHELL_HINT}`);
    expect(await setupText(p, 'linux', dataDir)).not.toContain('Set-ExecutionPolicy');
    const ctx = (platform: NodeJS.Platform): ClientContext => ({ env: p.env, platform, cwd: p.work, dataDir, now: new Date() });
    expect((await doctorChecks({ ctx: ctx('win32'), nav: false })).find((c) => c.text === POWERSHELL_HINT)).toMatchObject({ section: 'Futtatókörnyezet', level: 'info' });
    expect((await doctorChecks({ ctx: ctx('linux'), nav: false })).some((c) => c.text === POWERSHELL_HINT)).toBe(false);
  });
});

describe('serve start-up text (U15)', () => {
  it('open the address in the browser, keep the window open, Ctrl+C stops it; the MCP details below', async () => {
    const dir = tempDir();
    const s = await serve(['--data-dir', dir, '--port', '0'], /PDF másolása mappába[^\n]*\n/);
    if (isRun(s)) throw new Error(`serve did not start: ${s.stderr}`);
    try {
      const lines = s.stderr.split(/\r?\n/);
      const web = lines.findIndex((l) => l.startsWith('  Webes felület: http://127.0.0.1:'));
      expect(web).toBeGreaterThan(0);
      expect(lines[web + 1]).toBe('  Nyisd meg ezt a címet a böngészőben. Amíg használod, ezt az ablakot hagyd nyitva; leállítás: Ctrl+C.');
      expect(lines[web + 2]).toBe('  AI-kliensek (MCP) ugyanitt csatlakozhatnak:');
      expect(lines[web + 3]).toMatch(/^ {2}MCP végpont: {3}http:\/\/127\.0\.0\.1:\d+\/mcp/);
      expect(lines[web + 4]).toBe(`  Token fájl:    ${join(dir, 'http-token')}`);
      expect(s.stderr).toContain('  Haladó beállítás – PDF másolása mappába (AI-kliens kérésére): kikapcsolva (OPENSZAMLA_ALLOW_FILE_COPY=1 engedélyezi)');
      expect(s.stderr).not.toContain('invoice_pdf');
    } finally {
      await s.stop();
    }
  });
});
