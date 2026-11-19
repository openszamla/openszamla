/**
 * W2: a nav-credentials.json saved with a UTF-8 byte order mark – Windows PowerShell 5.1 `Out-File -Encoding utf8`
 * and older Notepad write one – is read like the same file without it: at start (loadConfig) and when a running
 * program follows the file (NavSettingsWatch). It is not "nem érvényes JSON".
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NAV_CREDENTIALS_FILE, NavSettingsWatch, loadConfig } from '../../src/service/config.ts';

const SECRETS = { login: 'abcdefghijklmno', password: 'Jelszo-2026-Titok', signingKey: 'ab-cd12-0123456789abcdefEXAMPLE0', exchangeKey: '0123456789ABCDEF' };
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-bom-'));
  dirs.push(dir);
  return dir;
}

function writeWithBom(dir: string, text: string): void {
  writeFileSync(join(dir, NAV_CREDENTIALS_FILE), Buffer.concat([BOM, Buffer.from(text, 'utf8')]));
}

describe('a byte order mark at the start of nav-credentials.json', () => {
  it('is skipped when the configuration is loaded', () => {
    const dir = dataDir();
    writeWithBom(dir, JSON.stringify({ environment: 'production', ...SECRETS }, null, 2));
    const c = loadConfig({ dataDir: dir, env: {} });
    expect(c.navProblem).toBeNull();
    expect(c.nav).toMatchObject({ environment: 'production', source: 'file', credentials: SECRETS });
  });

  it('is skipped when a running program reads the file again', () => {
    const dir = dataDir();
    const config = loadConfig({ dataDir: dir, env: {} });
    expect(config.nav).toBeNull();
    const watch = new NavSettingsWatch(dir, {});
    expect(watch.refresh(config)).toMatchObject({ nav: null });
    writeWithBom(dir, JSON.stringify({ environment: 'test', ...SECRETS }));
    const next = watch.refresh(config);
    expect(next?.navProblem).toBeNull();
    expect(next?.nav).toMatchObject({ environment: 'test', source: 'file', credentials: SECRETS });
  });

  it('a file that is broken after it is still reported as not JSON, without its values', () => {
    const dir = dataDir();
    writeWithBom(dir, `{"environment": "production", "login": "${SECRETS.login}",`);
    const c = loadConfig({ dataDir: dir, env: {} });
    expect(c.nav).toMatchObject({ environment: 'production', source: 'file' });
    expect(c.navProblem).toBe(`A NAV-beállítás fájlja (${join(dir, NAV_CREDENTIALS_FILE)}) nem érvényes JSON (pl. kézi szerkesztés vagy félbeszakadt mentés miatt).`);
  });
});
