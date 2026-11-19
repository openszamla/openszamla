/**
 * WEB-5 at the command line: with a damaged nav-credentials.json every command starts (status, list, verify, backup),
 * status names the problem with the environment and the source, and nav-setup can overwrite the file.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { navSetupCommandLine } from '../../src/service/config.ts';

const CLI = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openszamla-cli-creds-'));
  dirs.push(d);
  return d;
}

function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENSZAMLA_')) env[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const CREDS = { login: 'abcdefghijklmno', password: 'Jelszo-2026', signingKey: 'ab-cd12-0123456789abcdefEXAMPLE0', exchangeKey: '0123456789ABCDEF' };

describe('WEB-5: every command starts with a damaged nav-credentials.json', () => {
  it.each([
    ['an empty password', JSON.stringify({ environment: 'test', ...CREDS, password: '' }), 'NAV: HIBÁS BEÁLLÍTÁS (test, file) – A NAV technikai felhasználó adatai hibásak: a jelszó üres.'],
    ['a trailing comma', `{"environment": "production", "login": "${CREDS.login}", "password": "${CREDS.password}",}`, 'NAV: HIBÁS BEÁLLÍTÁS (production, file) – A NAV-beállítás fájlja'],
  ])('%s', async (_label, content, line) => {
    const dir = tempDir();
    expect((await cli(['status', '--data-dir', dir])).code).toBe(0); // creates the database
    writeFileSync(join(dir, 'nav-credentials.json'), content);
    const status = await cli(['status', '--data-dir', dir]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout.split('\n').find((l) => l.startsWith('NAV:'))).toContain(line);
    expect(status.stdout).toContain(navSetupCommandLine(dir));
    expect(status.stdout + status.stderr).not.toContain(CREDS.password);
    for (const args of [['list'], ['verify'], ['backup', join(dir, 'mentes.db')]]) {
      const r = await cli([...args, '--data-dir', dir]);
      expect(r.code, `${args[0]}: ${r.stderr}`).toBe(0);
    }
    expect(existsSync(join(dir, 'mentes.db'))).toBe(true);
  });

  it('nav-setup overwrites the damaged file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'nav-credentials.json'), '{"environment": "test",');
    const r = await cli(['nav-setup', '--env', 'test', '--data-dir', dir], `${CREDS.login}\n${CREDS.password}\n${CREDS.signingKey}\n${CREDS.exchangeKey}\n`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Mentve/);
    expect(JSON.parse(readFileSync(join(dir, 'nav-credentials.json'), 'utf8'))).toMatchObject({ environment: 'test', login: CREDS.login });
    const status = await cli(['status', '--data-dir', dir]);
    expect(status.stdout.split('\n').find((l) => l.startsWith('NAV:'))).toBe('NAV: test (file)');
  });
});
