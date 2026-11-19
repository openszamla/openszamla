/**
 * `openszamla setup` (7.11): one guided run of the first set-up. Without a terminal it never waits for input – the
 * clients come from --client, for the seller and NAV it prints the command to run; in a terminal every step asks
 * first and can be skipped, secrets are not echoed, and Ctrl+C stops it cleanly. Rerunning only checks what is done.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientContext } from '../../src/cli/clients.ts';
import { runSetup } from '../../src/cli/setup.ts';
import { SELLER_INPUT } from '../helpers/app.ts';
import { CLI } from '../helpers/cli.ts';
import { makeProfile, removeProfiles, runIn, type Profile } from '../helpers/client-profile.ts';

afterEach(() => removeProfiles());

const desktopConfig = (p: Profile): string =>
  process.platform === 'win32'
    ? join(p.appData, 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? join(p.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : join(p.xdgConfig, 'Claude', 'claude_desktop_config.json');

describe('setup without a terminal', () => {
  it('never waits for input: stdin left open, it still finishes and prints what to run for the seller and NAV', async () => {
    const p = makeProfile();
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'setup'], { env: p.env, cwd: p.work, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`setup waited for input:\n${stdout}`));
      }, 20_000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    }); // stdin is never ended
    expect(code).toBe(0);
    const dataDir = join(p.home, '.openszamla');
    expect(existsSync(join(dataDir, 'openszamla.db'))).toBe(true);
    expect(stdout).toContain('A bemenet nem terminál, ezért semmit nem kérdezek');
    for (const step of ['[1/5] Futtatókörnyezet', '[2/5] Adatkönyvtár', '[3/5] Eladói adatok', '[4/5] NAV Online Számla', '[5/5] AI-kliensek csatlakoztatása', 'Összegzés', 'Mit tovább?']) {
      expect(stdout, step).toContain(step);
    }
    expect(stdout).toContain(`létrehoztam: ${dataDir}`);
    expect(stdout).toContain('teendő – add meg egy terminálban: openszamla init');
    // The profile's own ~/.openszamla is the built-in data directory: the command needs no --data-dir.
    expect(stdout).toContain('teendő – amikor megvannak a technikai felhasználó adatai, egy terminálban: openszamla nav-setup (telepítés nélkül: npx -y openszamla nav-setup)');
    expect(stdout).toContain('TESZT (test): a NAV próbarendszere');
    expect(stdout).toContain('https://onlineszamla-test.nav.gov.hu');
    expect(stdout).toContain('https://onlineszamla.nav.gov.hu/dokumentaciok');
    expect(stdout).toContain('a --client kapcsoló nélkül nem csatlakoztattam klienst');
    expect(stdout).toContain('Kérdezd meg az AI-t: „Mi a helyzet a számlázóval?”');
    expect(stdout).toContain('Webes felület AI nélkül: openszamla serve');
  });

  it('--client connects the clients and installs the skill where it applies; a rerun only checks', async () => {
    const p = makeProfile({ fakeClaude: true });
    const r = await runIn(p, ['setup', '--client', 'claude-desktop,codex,claude-code']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(desktopConfig(p), 'utf8')).mcpServers.openszamla.args[1]).toBe('mcp');
    expect(readFileSync(join(p.home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.openszamla]');
    expect(p.claudeCalls().map((a) => a.slice(0, 2).join(' '))).toEqual(['mcp add']);
    expect(existsSync(join(p.home, '.claude', 'skills', 'magyar-szamlazas', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(p.home, '.agents', 'skills', 'magyar-szamlazas', 'SKILL.md'))).toBe(true);
    expect(r.stdout).toContain('Lépj ki teljesen a Claude Desktopból');
    expect(r.stdout).toContain('  AI-kliensek: kész');

    const again = await runIn(p, ['setup', '--client', 'claude-desktop,codex']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('1) Claude Desktop – már csatlakoztatva');
    expect(again.stdout).toContain('Claude Desktop: már be van állítva, nem változtattam semmit');
    expect(again.stdout).toContain('Codex (OpenAI): már be van állítva, nem változtattam semmit');
    expect(again.stdout).toContain('A magyar-szamlazas skill már telepítve');
    expect(again.stdout).not.toContain('Lépj ki teljesen a Claude Desktopból');
  });

  it('with --data-dir every printed command and the client entry name that folder', async () => {
    const p = makeProfile();
    const dir = join(p.root, 'Kovács Anna', 'Számlák');
    const r = await runIn(p, ['setup', '--data-dir', dir, '--client', 'cursor']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`openszamla init --data-dir "${dir}"`);
    expect(r.stdout).toContain(`openszamla doctor --data-dir "${dir}"`);
    expect(r.stdout).toContain(`openszamla serve --data-dir "${dir}"`);
    expect(JSON.parse(readFileSync(join(p.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.openszamla.env).toEqual({ OPENSZAMLA_HOME: dir });
  });

  it.runIf(process.platform === 'win32')('Git Bash (no console for programs): says how to get the questions', async () => {
    const p = makeProfile();
    const bash = await runIn(p, ['setup'], { env: { MSYSTEM: 'MINGW64' } });
    expect(bash.code).toBe(0);
    expect(bash.stdout).toContain('Git Bash-ben a programok nem kapnak terminált: a kérdésekhez futtasd így: winpty openszamla setup');
    const plain = await runIn(p, ['setup'], { env: { MSYSTEM: '' } });
    expect(plain.stdout).not.toContain('Git Bash-ben');
  });

  it('an unknown --client name is refused before anything is created', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['setup', '--client', 'cursor,cluade']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [INVALID_INPUT]: Ismeretlen kliens a --client kapcsolóban: cluade');
    expect(r.stderr).toContain('claude-desktop, claude-code, codex, cursor, vscode');
    expect(existsSync(join(p.home, '.openszamla'))).toBe(false);
    expect(existsSync(join(p.home, '.cursor'))).toBe(false);
  });

  it('an existing different entry is not replaced without --force (exit 1), and is with it', async () => {
    const p = makeProfile();
    expect((await runIn(p, ['config', 'cursor', '--write', '--data-dir', join(p.root, 'masik')])).code).toBe(0);
    const refused = await runIn(p, ['setup', '--client', 'cursor']);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('4) Cursor – van openszamla bejegyzése, más beállítással');
    expect(refused.stdout).toContain('HIBA – A(z)');
    expect(refused.stdout).toContain('  AI-kliensek: hiba');
    const forced = await runIn(p, ['setup', '--client', 'cursor', '--force']);
    expect(forced.code, forced.stdout).toBe(0);
    expect(JSON.parse(readFileSync(join(p.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.openszamla.env).toBeUndefined();
  });
});

/**
 * A stand-in terminal: input with isTTY (readline switches it to raw mode) and the text shown on screen. Like a
 * person, it types each answer (key by key, then Enter) only once its question is on the screen; "\u0003" is Ctrl+C.
 */
function terminal(answers: string[]): { input: PassThrough & { isTTY?: boolean }; output: Writable; screen: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  input.isTTY = true;
  input.setRawMode = () => input;
  let shown = '';
  const screen = (): string => shown.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  let next = 0;
  let answeredAt = -1;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      shown += chunk.toString();
      cb();
      setImmediate(() => {
        const s = screen();
        if (next >= answers.length || !s.endsWith(': ') || s.length === answeredAt) return;
        answeredAt = s.length;
        const a = answers[next++] as string;
        for (const ch of a) input.write(ch);
        if (a !== '\u0003') input.write('\r');
      });
    },
  });
  return { input, output, screen };
}

const contextOf = (p: Profile): ClientContext => ({ env: p.env, platform: process.platform, cwd: p.work, dataDir: join(p.home, '.openszamla'), now: new Date() });

describe('setup in a terminal', () => {
  it('asks step by step: seller saved, NAV skipped, Claude Desktop and Codex connected, the Codex skill installed', async () => {
    const p = makeProfile();
    const s = SELLER_INPUT;
    const t = terminal([
      'i', // enter the seller now
      s.name,
      s.taxNumber,
      s.address.postalCode,
      s.address.city,
      s.address.addressLine,
      s.bankAccount,
      'n',
      s.email,
      '', // NAV: not now (default)
      '1,3', // Claude Desktop, Codex
      '', // the skill: yes (default)
    ]);
    const code = await runSetup({ ctx: contextOf(p), force: false, input: t.input, output: t.output });
    const screen = t.screen();
    expect(code, screen).toBe(0);
    expect(screen).toContain('Megadod most? (i/n) [i]:');
    expect(screen).toContain(`Mentve: ${s.name} (${s.taxNumber})`);
    expect(screen).toContain('Megvannak a technikai felhasználó adatai? Megadod most? (i/n) [n]:');
    expect(screen).toContain('kihagyva – később: openszamla nav-setup --data-dir');
    expect(screen).toContain('Melyikhez csatlakoztassam?');
    expect(JSON.parse(readFileSync(desktopConfig(p), 'utf8')).mcpServers.openszamla).toBeDefined();
    expect(readFileSync(join(p.home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.openszamla]');
    expect(existsSync(join(p.home, '.agents', 'skills', 'magyar-szamlazas', 'SKILL.md'))).toBe(true);
    expect(screen).toMatch(/Eladói adatok: kész[\s\S]*NAV: kihagyva[\s\S]*AI-kliensek: kész/);
  });

  it('NAV entered without a seller: saved without echoing a secret, no connection test yet', async () => {
    const p = makeProfile();
    const t = terminal(['n', 'i', '', 'tesztelek1', 'Titkos-Jelszo-123', 'ALAIRO-KULCS-XYZ', 'CSEREKULCS123456', '0']);
    const code = await runSetup({ ctx: contextOf(p), force: false, input: t.input, output: t.output });
    const screen = t.screen();
    expect(code, screen).toBe(0);
    const saved = JSON.parse(readFileSync(join(p.home, '.openszamla', 'nav-credentials.json'), 'utf8')) as Record<string, string>;
    expect(saved).toEqual({ environment: 'test', login: 'tesztelek1', password: 'Titkos-Jelszo-123', signingKey: 'ALAIRO-KULCS-XYZ', exchangeKey: 'CSEREKULCS123456' });
    expect(screen).toContain('Jelszó (a beírt szöveg nem jelenik meg)');
    expect(screen).toContain('Mentve. Az eladói adatok (adószám) még hiányoznak');
    expect(screen).toContain('TESZT környezet: a számlák csak a NAV próbarendszerébe kerülnek');
    for (const secret of ['Titkos-Jelszo-123', 'ALAIRO-KULCS-XYZ', 'CSEREKULCS123456']) expect(screen).not.toContain(secret);
  });

  it('wrong NAV data is not saved; declining to retry leaves the step to do (exit 1)', async () => {
    const p = makeProfile();
    const t = terminal(['n', 'i', '', 'x', 'pw', 'sign', 'rovid', 'n', '0']);
    const code = await runSetup({ ctx: contextOf(p), force: false, input: t.input, output: t.output });
    const screen = t.screen();
    expect(code).toBe(1);
    expect(screen).toContain('HIBA – A megadott NAV adatok hibásak, nem mentettem el őket');
    expect(screen).toContain('Újra megpróbálod? (i/n) [i]:');
    expect(existsSync(join(p.home, '.openszamla', 'nav-credentials.json'))).toBe(false);
    expect(screen).toMatch(/NAV: hiba/);
  });

  it('an existing different entry: asks before replacing it', async () => {
    const p = makeProfile();
    expect((await runIn(p, ['config', 'cursor', '--write', '--data-dir', join(p.root, 'masik')])).code).toBe(0);
    const t = terminal(['n', '', '4', 'i']);
    const code = await runSetup({ ctx: contextOf(p), force: false, input: t.input, output: t.output });
    const screen = t.screen();
    expect(code, screen).toBe(0);
    expect(screen).toContain('Lecseréljem (a régiről biztonsági másolat készül)? (i/n) [n]:');
    expect(screen).toContain('Lecseréltem a korábbi openszamla bejegyzést');
    expect(JSON.parse(readFileSync(join(p.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.openszamla.env).toBeUndefined();
  });

  it('Ctrl+C stops it cleanly: what was done stays, how to continue is printed', async () => {
    const p = makeProfile();
    const t = terminal(['\u0003']);
    const code = await runSetup({ ctx: contextOf(p), force: false, input: t.input, output: t.output });
    expect(code).toBe(1);
    expect(t.screen()).toContain('Megszakítva (Ctrl+C). Ami eddig elkészült, megmaradt; a beállítás folytatható: openszamla setup');
    expect(existsSync(join(p.home, '.openszamla', 'openszamla.db'))).toBe(true);
  });
});
