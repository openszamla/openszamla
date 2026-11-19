/**
 * WEB-5: a damaged or incomplete nav-credentials.json (hand-edited, a save cut short) is a bad setting like any other:
 * loading never throws, the NAV settings are there with the reason (navProblem: source 'file', the environment when it
 * can be read), nothing is sent, and no value of the file is ever echoed. Incomplete OPENSZAMLA_NAV_* variables stay
 * the documented INVALID_CONFIG.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { NAV_CREDENTIALS_FILE, dataDirOption, loadConfig, navSetupCommandLine } from '../../src/service/config.ts';

const SECRETS = { login: 'abcdefghijklmno', password: 'Jelszo-2026-Titok', signingKey: 'ab-cd12-0123456789abcdefEXAMPLE0', exchangeKey: '0123456789ABCDEF' };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function withFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-creds-'));
  dirs.push(dir);
  writeFileSync(join(dir, NAV_CREDENTIALS_FILE), content);
  return dir;
}

function load(dir: string, env: Record<string, string> = {}) {
  return loadConfig({ dataDir: dir, env });
}

function neverEchoes(text: string | null): void {
  for (const s of Object.values(SECRETS)) expect(text ?? '').not.toContain(s);
}

describe('WEB-5: a broken credentials file never stops the program', () => {
  it('an empty password: the settings from the file with the reason', () => {
    const c = load(withFile(JSON.stringify({ environment: 'test', ...SECRETS, password: '' })));
    expect(c.nav).toMatchObject({ environment: 'test', source: 'file' });
    expect(c.navProblem).toBe('A NAV technikai felhasználó adatai hibásak: a jelszó üres.');
  });

  it('a trailing comma (hand-edited JSON): not JSON, with the environment the file names, and no value of it', () => {
    const dir = withFile(`{\n  "environment": "production",\n  "login": "${SECRETS.login}",\n  "password": "${SECRETS.password}",\n  "signingKey": "${SECRETS.signingKey}",\n  "exchangeKey": "${SECRETS.exchangeKey}",\n}\n`);
    const c = load(dir);
    expect(c.nav).toMatchObject({ environment: 'production', source: 'file' });
    expect(c.navProblem).toBe(`A NAV-beállítás fájlja (${join(dir, NAV_CREDENTIALS_FILE)}) nem érvényes JSON (pl. kézi szerkesztés vagy félbeszakadt mentés miatt).`);
    neverEchoes(c.navProblem);
    // OPENSZAMLA_NAV_ENV still decides the environment.
    expect(load(dir, { OPENSZAMLA_NAV_ENV: 'test' }).nav?.environment).toBe('test');
  });

  it('other damage: empty, not an object, a value that is not text, an unknown environment, unreadable', () => {
    expect(load(withFile('')).navProblem).toMatch(/nem érvényes JSON/);
    expect(load(withFile('{"environment": "production", "login": "abc')).nav?.environment).toBe('production');
    expect(load(withFile('[]')).navProblem).toMatch(/nem a várt formátumú \(egy JSON-objektum kell\)\.$/);
    const numeric = load(withFile(JSON.stringify({ environment: 'test', ...SECRETS, password: 20262026 })));
    expect(numeric.navProblem).toMatch(/a\(z\) „password” mező nem szöveg \(az értéket idézőjelek között kell megadni\)\.$/);
    expect(numeric.navProblem).not.toContain('20262026');
    const env = load(withFile(JSON.stringify({ environment: 'staging', ...SECRETS })));
    expect(env.nav).toMatchObject({ environment: 'test', source: 'file' });
    expect(env.navProblem).toMatch(/a környezet \(„environment”\) értéke test vagy production lehet\.$/);
    const unreadable = mkdtempSync(join(tmpdir(), 'openszamla-creds-'));
    dirs.push(unreadable);
    mkdirSync(join(unreadable, NAV_CREDENTIALS_FILE)); // a directory in its place
    expect(load(unreadable).navProblem).toMatch(/nem olvasható \(E[A-Z]+\)\.$/);
  });

  it('the program works: status shows the problem with the setup command of this data directory, nothing is sent', async () => {
    const dir = withFile('{"environment": "test", "login": "abcdefghijklmno",}');
    const app = OpenSzamla.open({ dataDir: dir, env: {} });
    try {
      app.updateSeller({ name: 'Teszt Kft.', taxNumber: '12345676-2-42', address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Fő u. 1.' }, vatStatus: 'normal' });
      const s = app.status();
      expect(s.nav).toMatchObject({ configured: false, environment: 'test', source: 'file', problem: expect.stringMatching(/nem érvényes JSON/) });
      expect(s.nextSteps.join('\n')).toContain(navSetupCommandLine(dir));
      await expect(app.navSync()).rejects.toMatchObject({ code: 'NAV_INVALID_CONFIG', hint: expect.stringContaining(dataDirOption(dir).trim()) });
      expect(app.verifyIntegrity().ok).toBe(true);
    } finally {
      app.close();
    }
  });

  it('incomplete OPENSZAMLA_NAV_* variables stay a start-up error (documented, 3.3)', () => {
    const dir = withFile(JSON.stringify({ environment: 'test', ...SECRETS }));
    expect(() => load(dir, { OPENSZAMLA_NAV_LOGIN: 'envlogin' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => load(withFile('{'), { OPENSZAMLA_NAV_ENV: 'staging' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
