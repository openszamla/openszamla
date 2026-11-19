/** The `openszamla` command as a child process: client configuration output, data directory, nav-setup. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { entryScript, nodeExecutable } from '../../src/cli/clients.ts';
import { navSetupCommandLine } from '../../src/service/config.ts';

const CLI = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openszamla-cli-'));
  dirs.push(d);
  return d;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with a clean environment (no OPENSZAMLA_* of the developer's shell). */
function cli(args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENSZAMLA_')) env[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...env, ...opts.env }, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

describe('runtime check', () => {
  it('refuses a node:sqlite without the features the store uses (checked, not inferred from the version)', async () => {
    const preload = join(tempDir(), 'old-sqlite.mjs');
    writeFileSync(
      preload,
      `const real = process.getBuiltinModule;
       process.getBuiltinModule = (id) => {
         const m = real.call(process, id);
         if (id !== 'node:sqlite') return m;
         class StatementSync {} // no iterate(), as before Node.js 22.13.0
         return { ...m, StatementSync };
       };`,
    );
    const r = await cli(['--version'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Node.js 22.13.0 vagy újabb szükséges');
    const ok = await cli(['--version']);
    expect(ok.code).toBe(0);
  });
});

describe('openszamla config', () => {
  // The printed command starts Node.js and this installation's entry script by absolute path (no shell, no PATH needed).
  const node = `"${nodeExecutable({ env: process.env, platform: process.platform })}"`;
  const script = `"${entryScript()}"`;

  it('claude-code: -e is followed by another option (it takes every value up to the next one) and the value is quoted', async () => {
    const dir = join(tempDir(), 'Kovács Anna', 'Számlák 2026');
    const r = await cli(['config', 'claude-code', '--data-dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`claude mcp add -e "OPENSZAMLA_HOME=${dir}" --transport stdio --scope user openszamla -- ${node} ${script} mcp`);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)) as { mcpServers: { openszamla: { env: Record<string, string> } } };
    expect(json.mcpServers.openszamla.env).toEqual({ OPENSZAMLA_HOME: dir });
  });

  it('codex: quoted --env value, and a TOML string that keeps the path intact', async () => {
    const dir = join(tempDir(), 'Kovács Anna', 'Számlák 2026');
    const r = await cli(['config', 'codex', '--data-dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`codex mcp add openszamla --env "OPENSZAMLA_HOME=${dir}" -- ${node} ${script} mcp`);
    expect(r.stdout).toContain(`env = { OPENSZAMLA_HOME = '${dir}' }`);
    const quote = join(tempDir(), "O'Brien számlái");
    const q = await cli(['config', 'codex', '--data-dir', quote]);
    expect(q.stdout).toContain(`env = { OPENSZAMLA_HOME = ${JSON.stringify(quote)} }`);
  });

  it('the default data directory needs no env setting; a data directory from OPENSZAMLA_HOME is written out', async () => {
    const home = tempDir();
    const profile = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config') };
    const plain = await cli(['config', 'claude-code'], { env: profile });
    expect(plain.stdout).toContain(`claude mcp add --transport stdio --scope user openszamla -- ${node} ${script} mcp`);
    expect(plain.stdout).not.toContain('OPENSZAMLA_HOME');
    // A desktop client does not see the variables of the shell this command runs in.
    const custom = join(home, 'Számlák');
    const r = await cli(['config', 'claude-desktop'], { env: { ...profile, OPENSZAMLA_HOME: custom } });
    expect(r.stdout).toContain(JSON.stringify({ OPENSZAMLA_HOME: custom }));
  });
});

describe('data directory', () => {
  it('expands ~ in --data-dir and OPENSZAMLA_HOME', async () => {
    const home = tempDir();
    const r = await cli(['status', '--data-dir', '~/osz'], { env: { HOME: home, USERPROFILE: home } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Adatkönyvtár: ${join(home, 'osz')}`);
    const e = await cli(['status'], { env: { HOME: home, USERPROFILE: home, OPENSZAMLA_HOME: '~/.openszamla' } });
    expect(e.stdout).toContain(`Adatkönyvtár: ${join(home, '.openszamla')}`);
  });

  it('refuses an unexpanded variable instead of creating a database under the working directory', async () => {
    const cwd = tempDir();
    const r = await cli(['status'], { env: { OPENSZAMLA_HOME: '${OPENSZAMLA_HOME:-~/.openszamla}' }, cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [INVALID_CONFIG]');
    expect(existsSync(join(cwd, '${OPENSZAMLA_HOME:-~'))).toBe(false);
  });

  it('mcp reports the data directory on stderr and warns when it depends on the working directory', async () => {
    // By its real path, as the program sees its working directory: the temp folder may sit behind a link (macOS).
    const cwd = realpathSync(tempDir());
    const r = await cli(['mcp'], { env: { OPENSZAMLA_HOME: 'adatok' }, cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // stdio: nothing but JSON-RPC on stdout
    expect(r.stderr).toContain(`adatkönyvtár: ${join(cwd, 'adatok')}`);
    expect(r.stderr).toContain('Figyelem: relatív útvonal ("adatok")');
    const abs = await cli(['mcp'], { env: { OPENSZAMLA_HOME: join(cwd, 'abs') }, cwd });
    expect(abs.stderr).not.toContain('relatív');
    const db = await cli(['mcp'], { env: { OPENSZAMLA_HOME: join(cwd, 'abs'), OPENSZAMLA_DB: 'cég.db' }, cwd });
    expect(db.stderr).toContain('Figyelem: relatív útvonal ("cég.db")');
  });
});

describe('openszamla serve', () => {
  /** Starts `serve` on a free port with a clean environment plus `extraEnv`, stops it once stderr matches `ready`. */
  async function serveStartup(extraEnv: Record<string, string>, ready: RegExp): Promise<string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENSZAMLA_')) env[k] = v;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let stderr = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve did not start: ${stderr}`)), 20_000);
        child.stderr.setEncoding('utf8').on('data', (d: string) => {
          stderr += d;
          if (ready.test(stderr)) {
            clearTimeout(timer);
            resolve();
          }
        });
        void exited.then(() => reject(new Error(`serve exited: ${stderr}`)));
      });
    } finally {
      child.kill();
      await exited; // the database file stays open until the process is gone (Windows cannot delete it before)
    }
    return stderr;
  }

  it('empty OPENSZAMLA_HTTP_* variables count as not set: the saved token stays, it listens on 127.0.0.1', async () => {
    const dir = tempDir();
    const saved = 'mentett-token-0123456789abcdefghij';
    writeFileSync(join(dir, 'http-token'), saved);
    const stderr = await serveStartup({ OPENSZAMLA_HOME: dir, OPENSZAMLA_HTTP_TOKEN: '', OPENSZAMLA_HTTP_HOST: '', OPENSZAMLA_ALLOWED_HOSTS: '' }, /Token fájl:/);
    expect(stderr).toMatch(new RegExp(`Webes felület: http://127\\.0\\.0\\.1:\\d+/\\?token=${saved}`));
    expect(readFileSync(join(dir, 'http-token'), 'utf8')).toBe(saved);
  });

  it('does not copy PDFs into server folders unless OPENSZAMLA_ALLOW_FILE_COPY allows it (its clients may be remote)', async () => {
    const line = /Haladó beállítás – PDF másolása mappába \(AI-kliens kérésére\): ([^\r\n]*)\r?\n/;
    const off = await serveStartup({ OPENSZAMLA_HOME: tempDir() }, line);
    expect(off.match(line)?.[1]).toBe('kikapcsolva (OPENSZAMLA_ALLOW_FILE_COPY=1 engedélyezi)');
    const on = await serveStartup({ OPENSZAMLA_HOME: tempDir(), OPENSZAMLA_ALLOW_FILE_COPY: '1' }, line);
    expect(on.match(line)?.[1]).toBe('engedélyezve');
  });
});

describe('openszamla nav-setup', () => {
  it('saves piped answers (one per line) and normalises the environment', async () => {
    const dir = tempDir();
    const r = await cli(['nav-setup', '--data-dir', dir], { input: 'éles\ntechuser\nTitkos-Jelszo-123\nALAIRO-KULCS\nCSEREKULCS123456\n' });
    expect(r.code).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, 'nav-credentials.json'), 'utf8')) as Record<string, string>;
    expect(saved).toEqual({ environment: 'production', login: 'techuser', password: 'Titkos-Jelszo-123', signingKey: 'ALAIRO-KULCS', exchangeKey: 'CSEREKULCS123456' });
    expect(r.stderr).toContain('Mentve.');
    for (const secret of ['Titkos-Jelszo-123', 'ALAIRO-KULCS', 'CSEREKULCS123456']) expect(r.stderr + r.stdout).not.toContain(secret);
  });

  it('rejects an unknown environment before asking for the secrets', async () => {
    const dir = tempDir();
    const r = await cli(['nav-setup', '--data-dir', dir, '--env', 'prodution'], { input: 'techuser\npw\nsign\nexch\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Ismeretlen NAV környezet');
    expect(r.stderr).not.toContain('Jelszó');
    expect(existsSync(join(dir, 'nav-credentials.json'))).toBe(false);
  });

  it('refuses technical user data in a wrong format before saving anything (BIZ-5)', async () => {
    const dir = tempDir();
    // 15-character exchange key, login with a dot
    const r = await cli(['nav-setup', '--data-dir', dir], { input: 'test\ntech.user\nTitkos-Jelszo-123\nALAIRO-KULCS\nCSEREKULCS12345\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [INVALID_INPUT]');
    expect(r.stderr).toContain('a login név 6–15 betű/szám lehet; az XML cserekulcs nem 16 karakteres');
    expect(existsSync(join(dir, 'nav-credentials.json'))).toBe(false);
    for (const secret of ['Titkos-Jelszo-123', 'ALAIRO-KULCS', 'CSEREKULCS12345']) expect(r.stderr + r.stdout).not.toContain(secret);
  });

  it('status names the problem of saved settings that cannot be used (BIZ-5)', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'nav-credentials.json'), JSON.stringify({ environment: 'production', login: 'techuser', password: 'pw', signingKey: 'sign', exchangeKey: 'tooshort' }));
    const r = await cli(['status', '--data-dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NAV: HIBÁS BEÁLLÍTÁS (production, file) – A NAV technikai felhasználó adatai hibásak: az XML cserekulcs nem 16 karakteres.');
    expect(r.stdout).toContain(navSetupCommandLine(dir));
    expect(r.stdout).not.toContain('tooshort');
  });

  it('warns when OPENSZAMLA_NAV_ENV overrides the saved environment, but not when it is empty', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const input = 'production\ntechuser\nTitkos-Jelszo-123\nALAIRO-KULCS\nCSEREKULCS123456\n';
    const overridden = await cli(['nav-setup', '--data-dir', dir], { input, env: { OPENSZAMLA_NAV_ENV: 'test' } });
    expect(overridden.stderr).toContain('felülírják a most mentett beállítást');
    const empty = await cli(['nav-setup', '--data-dir', dir], { input, env: { OPENSZAMLA_NAV_ENV: '' } });
    expect(empty.code).toBe(0);
    expect(empty.stderr).not.toContain('felülírják');
    const status = await cli(['status', '--data-dir', dir], { env: { OPENSZAMLA_NAV_ENV: '' } });
    expect(status.stdout).toContain('NAV: production (file)');
  });

  it('stops with an error (nothing saved) when the input ends early', async () => {
    const dir = tempDir();
    const r = await cli(['nav-setup', '--data-dir', dir], { input: 'test\ntechuser\n' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [INPUT_ENDED]');
    expect(existsSync(join(dir, 'nav-credentials.json'))).toBe(false);
  });
});

describe('export and verify', () => {
  it('export takes --date-basis issue|fulfillment (MCP-UX-6); verify reports every check and the chain head (BIZ-6)', async () => {
    const dir = tempDir();
    const exp = await cli(['export', '--data-dir', dir, '--from', '2026-09-01', '--to', '2026-09-30', '--date-basis', 'fulfillment']);
    expect(exp.code).toBe(0);
    expect(exp.stdout).toContain('0 számla (teljesítés dátuma szerint)');
    expect(exp.stdout).toContain(join(dir, 'export', 'szamlak_teljesites_2026-09-01_2026-09-30.csv'));
    const bad = await cli(['export', '--data-dir', dir, '--from', '2026-09-01', '--to', '2026-09-30', '--date-basis', 'kelt']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Ismeretlen dátumalap: kelt');
    const verify = await cli(['verify', '--data-dir', dir]);
    expect(verify.code).toBe(0);
    for (const s of ['Ellenőrzött számlák: 0', 'Auditnapló: rendben', 'Sorszámhézagok: nincs', 'adatbázis-védelmek (triggerek): nincs', 'Az auditnapló utolsó bejegyzése: #', 'Eredmény: rendben.']) {
      expect(verify.stdout, s).toContain(s);
    }
  });
});
