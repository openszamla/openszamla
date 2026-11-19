/**
 * NS5: a nav-credentials.json saved as UTF-16 with a byte order mark – what Windows PowerShell 5.1 `Out-File` and `>`
 * write without -Encoding, and Notepad's "Unicode" save – is read like the same file in UTF-8, little and big endian
 * alike: at start (loadConfig) and when a running program reads the file again (NavSettingsWatch). It is not
 * "nem érvényes JSON". A UTF-16 file that cannot be decoded, and UTF-16 without a byte order mark, still are – and the
 * message never shows anything of the file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NAV_CREDENTIALS_FILE, NavSettingsWatch, loadConfig } from '../../src/service/config.ts';

// Accented letters too: they are two bytes in UTF-8 and one code unit in UTF-16.
const SECRETS = { login: 'abcdefghijklmno', password: 'Jelszó-Árvíztűrő-2026', signingKey: 'ab-cd12-0123456789abcdefEXAMPLE0', exchangeKey: '0123456789ABCDEF' };
const JSON_TEXT = JSON.stringify({ environment: 'production', ...SECRETS }, null, 2);

/** `text` as UTF-16, little endian (Buffer's utf16le) or big endian (the byte pairs swapped), with or without a BOM. */
function utf16(text: string, endian: 'le' | 'be', bom = true): Buffer {
  const units = Buffer.from(`${bom ? '﻿' : ''}${text}`, 'utf16le');
  return endian === 'be' ? units.swap16() : units;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-utf16-'));
  dirs.push(dir);
  return dir;
}

function notJson(dir: string): string {
  return `A NAV-beállítás fájlja (${join(dir, NAV_CREDENTIALS_FILE)}) nem érvényes JSON (pl. kézi szerkesztés vagy félbeszakadt mentés miatt).`;
}

describe('nav-credentials.json saved as UTF-16 with a byte order mark', () => {
  it.each(['le', 'be'] as const)('UTF-16 %s: read like UTF-8 when the configuration is loaded', (endian) => {
    const dir = dataDir();
    const bytes = utf16(JSON_TEXT, endian);
    expect([...bytes.subarray(0, 2)]).toEqual(endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    writeFileSync(join(dir, NAV_CREDENTIALS_FILE), bytes);
    const c = loadConfig({ dataDir: dir, env: {} });
    expect(c.navProblem).toBeNull();
    expect(c.nav).toEqual({ environment: 'production', source: 'file', credentials: SECRETS });
  });

  it('a running program reads a file saved again as UTF-16 (big endian) too', () => {
    const dir = dataDir();
    const config = loadConfig({ dataDir: dir, env: {} });
    expect(config.nav).toBeNull();
    const watch = new NavSettingsWatch(dir, {});
    expect(watch.refresh(config)).toMatchObject({ nav: null });
    writeFileSync(join(dir, NAV_CREDENTIALS_FILE), utf16(JSON.stringify({ environment: 'test', ...SECRETS }), 'be'));
    const next = watch.refresh(config);
    expect(next?.navProblem).toBeNull();
    expect(next?.nav).toMatchObject({ environment: 'test', source: 'file', credentials: SECRETS });
  });

  it('the same checks as for UTF-8 follow the decoding: a field that is not text is named, its value is not', () => {
    const dir = dataDir();
    writeFileSync(join(dir, NAV_CREDENTIALS_FILE), utf16(JSON.stringify({ environment: 'test', ...SECRETS, password: 12345678 }), 'le'));
    const c = loadConfig({ dataDir: dir, env: {} });
    expect(c.navProblem).toBe(`A NAV-beállítás fájlja (${join(dir, NAV_CREDENTIALS_FILE)}) hibás: a(z) „password” mező nem szöveg (az értéket idézőjelek között kell megadni).`);
  });
});

describe('content that cannot be decoded keeps the "nem érvényes JSON" message, without anything of the file', () => {
  const cases: Array<[string, Buffer]> = [
    ['UTF-16 little endian, a byte missing at the end', utf16(JSON_TEXT, 'le').subarray(0, -1)],
    ['UTF-16 big endian, a byte missing at the end', utf16(JSON_TEXT, 'be').subarray(0, -1)],
    ['UTF-16 with a broken surrogate pair', Buffer.concat([utf16('{"login": "', 'le'), Buffer.from([0x00, 0xd8]), Buffer.from(`x", "password": "${SECRETS.password}"}`, 'utf16le')])],
    ['UTF-16 without a byte order mark', utf16(JSON_TEXT, 'le', false)],
  ];
  it.each(cases)('%s', (_label, bytes) => {
    const dir = dataDir();
    writeFileSync(join(dir, NAV_CREDENTIALS_FILE), bytes);
    const c = loadConfig({ dataDir: dir, env: {} });
    expect(c.navProblem).toBe(notJson(dir));
    expect(c.nav).toMatchObject({ source: 'file', credentials: { login: '', password: '', signingKey: '', exchangeKey: '' } });
    for (const secret of Object.values(SECRETS)) expect(JSON.stringify(c)).not.toContain(secret);
  });
});
