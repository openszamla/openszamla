/**
 * `openszamla doctor` (7.12): checks the runtime, the data directory and database, the seller, the NAV settings, the
 * client configurations naming openszamla (and whether their command exists) and the skill copies; a fix for every
 * problem, exit 1 only for what blocks use. It creates nothing and never prints a secret.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { SELLER_INPUT } from '../helpers/app.ts';
import { makeProfile, removeProfiles, runIn, type Profile } from '../helpers/client-profile.ts';

afterEach(() => removeProfiles());

const dataDir = (p: Profile): string => join(p.home, '.openszamla');

const desktopConfig = (p: Profile): string =>
  process.platform === 'win32'
    ? join(p.appData, 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? join(p.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : join(p.xdgConfig, 'Claude', 'claude_desktop_config.json');

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** A seller and test-environment NAV credentials, as setup / init / nav-setup leave them. */
function setUp(p: Profile): void {
  const app = OpenSzamla.open({ dataDir: dataDir(p), env: {}, actor: 'cli' });
  try {
    app.updateSeller(SELLER_INPUT);
  } finally {
    app.close();
  }
  writeJson(join(dataDir(p), 'nav-credentials.json'), { environment: 'test', login: 'tesztelek1', password: 'Titkos-Jelszo-123', signingKey: 'ALAIRO-KULCS-XYZ', exchangeKey: 'CSEREKULCS123456' });
}

describe('openszamla doctor', () => {
  it('a fresh machine: warnings with fixes, exit 0, and nothing is created', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['doctor']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/rendben\s+Node\.js \d+\.\d+\.\d+ .*legalább 22\.13\.0 kell; a beépített SQLite \(node:sqlite\) működik\./);
    expect(r.stdout).toContain(`Az adatkönyvtár még nem létezik: ${dataDir(p)}`);
    expect(r.stdout).toContain('Az eladó (a saját vállalkozásod) adatai még nincsenek megadva');
    expect(r.stdout).toContain('A NAV-kapcsolat nincs beállítva');
    expect(r.stdout).toContain('Egyik ismert AI-kliens beállításában sincs OpenSzámla');
    expect(r.stdout).toContain('→ Csatlakoztatás: openszamla setup vagy openszamla config <kliens> --write');
    expect(r.stdout).toMatch(/Összesen: 0 hiba, \d+ figyelmeztetés\.\nA program használható\./);
    expect(r.stdout).toContain('Élő NAV-kapcsolatteszt: openszamla doctor --nav');
    expect(readdirSync(p.home).sort()).toEqual(['.config', 'AppData']);
  });

  it('set up and connected: "rendben" for the data, the seller and the client; the test environment is a warning; no secret is printed', async () => {
    const p = makeProfile();
    setUp(p);
    expect((await runIn(p, ['config', 'claude-desktop', '--write'])).code).toBe(0);
    const r = await runIn(p, ['doctor']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(`Adatkönyvtár: ${dataDir(p)} (írható).`);
    expect(r.stdout).toMatch(/Adatbázis: .*openszamla\.db – megnyitható, sémaverzió: \d+\./);
    expect(r.stdout).toContain(`Eladó: ${SELLER_INPUT.name} (${SELLER_INPUT.taxNumber}).`);
    expect(r.stdout).toContain('NAV: TESZT környezet');
    // The profile's own ~/.openszamla is the built-in data directory: the command needs no --data-dir.
    expect(r.stdout).toContain('openszamla nav-setup --env production (az éles technikai felhasználó adataival)');
    expect(r.stdout).toMatch(/rendben\s+Claude Desktop: .*claude_desktop_config\.json – openszamla bejegyzés, a parancs létezik/);
    for (const secret of ['Titkos-Jelszo-123', 'ALAIRO-KULCS-XYZ', 'CSEREKULCS123456']) expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it('a client entry whose command no longer exists (e.g. after moving Node.js) is an error with the command that fixes it', async () => {
    const p = makeProfile();
    const gone = join(p.root, 'regi-node', process.platform === 'win32' ? 'node.exe' : 'node');
    writeJson(desktopConfig(p), { mcpServers: { openszamla: { command: gone, args: ['x.js', 'mcp'], env: { OPENSZAMLA_NAV_PASSWORD: 'nav-jelszo-xyz' } } } });
    const r = await runIn(p, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`HIBA      Claude Desktop: ${desktopConfig(p)} – a beállított parancs nem létezik: ${gone}`);
    expect(r.stdout).toContain('→ Írd be újra a mostani útvonallal: openszamla config claude-desktop --write --force');
    expect(r.stdout).toMatch(/Összesen: 1 hiba, \d+ figyelmeztetés\.\nA hibák akadályozzák a használatot/);
    expect(r.stdout).not.toContain('nav-jelszo-xyz');
  });

  it('a missing script, a command not on PATH and a client file that is not valid JSON are errors; another data directory is a warning', async () => {
    const p = makeProfile();
    writeJson(join(p.home, '.cursor', 'mcp.json'), { mcpServers: { openszamla: { command: process.execPath, args: [join(p.root, 'nincs', 'main.js'), 'mcp'] } } });
    writeJson(join(p.home, '.claude.json'), { mcpServers: { openszamla: { type: 'stdio', command: 'openszamla-nincs-ilyen', args: ['mcp'], env: { OPENSZAMLA_HOME: join(p.root, 'masik') } } } });
    mkdirSync(join(p.work, '.vscode'), { recursive: true });
    // Broken also as JSON with comments (which VS Code allows, and doctor reads): a value is missing.
    writeFileSync(join(p.work, '.vscode', 'mcp.json'), '{ "servers": { // megjegyzés\n "x": } }');
    const r = await runIn(p, ['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`a Node.js-nek megadott programfájl nem létezik: ${join(p.root, 'nincs', 'main.js')}`);
    expect(r.stdout).toContain('a beállított parancs (openszamla-nincs-ilyen) nincs a PATH-on');
    expect(r.stdout).toMatch(/HIBA\s+VS Code \(munkaterület\): A\(z\) .*mcp\.json nem érvényes JSON/);
    expect(r.stdout).toContain(`a kliens másik adatkönyvtárat használ: ${join(p.root, 'masik')}`);
    expect(r.stdout).toMatch(/Összesen: 3 hiba/);
  });

  it('a database of a newer program version and a data directory that is a file block use (exit 1)', async () => {
    const p = makeProfile();
    const app = OpenSzamla.open({ dataDir: dataDir(p), env: {} });
    app.close();
    const db = new DatabaseSync(join(dataDir(p), 'openszamla.db'));
    db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    db.close();
    const newer = await runIn(p, ['doctor']);
    expect(newer.code).toBe(1);
    expect(newer.stdout).toContain('Az adatbázis nem használható: Az adatbázis sémaverziója (99) újabb, mint amit ez a programverzió ismer');
    expect(newer.stdout).toContain('→ Frissítsd az OpenSzámla programot a legújabb verzióra.');

    const file = join(p.root, 'adatok.txt');
    writeFileSync(file, 'nem mappa');
    const notDir = await runIn(p, ['doctor', '--data-dir', file]);
    expect(notDir.code).toBe(1);
    expect(notDir.stdout).toContain(`Az adatkönyvtár helyén fájl van: ${file}`);
  });

  it('an HTTP entry (url) is only noted, its URL – which may carry the token – is never printed', async () => {
    const p = makeProfile();
    const token = 'titkos-token-0123456789abcdef';
    writeJson(join(p.home, '.cursor', 'mcp.json'), { mcpServers: { openszamla: { url: `http://127.0.0.1:8787/mcp/${token}` } } });
    mkdirSync(join(p.home, '.codex'), { recursive: true });
    writeFileSync(join(p.home, '.codex', 'config.toml'), `[mcp_servers.openszamla]\nurl = "http://127.0.0.1:8787/mcp/${token}"\n`);
    const r = await runIn(p, ['doctor']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout.match(/HTTP-kapcsolat \(url\); a szervert itt nem a kliens indítja/g)).toHaveLength(2);
    expect(r.stdout).not.toContain(token);
  });

  it('a broken nav-credentials.json is a warning naming the problem, never its content; --nav without usable settings tests nothing', async () => {
    const p = makeProfile();
    mkdirSync(dataDir(p), { recursive: true });
    writeFileSync(join(dataDir(p), 'nav-credentials.json'), '{ "environment": "test", "password": "nav-jelszo-xyz", }');
    const r = await runIn(p, ['doctor', '--nav']);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('A NAV-beállítás hibás (test,');
    expect(r.stdout).toContain('nem érvényes JSON');
    expect(r.stdout).toContain('A NAV-kapcsolat nem tesztelhető: nincs (használható) beállítás.');
    expect(r.stdout).not.toContain('nav-jelszo-xyz');
  });

  it('skill copies: missing (when the client is connected), current, or different from this version', async () => {
    const p = makeProfile();
    expect((await runIn(p, ['config', 'codex', '--write'])).code).toBe(0);
    const missing = await runIn(p, ['doctor']);
    expect(missing.stdout).toContain('Codex (OpenAI) skill: nincs telepítve (ajánlott, nem kötelező).');
    expect(missing.stdout).toContain('→ openszamla install-skill codex');
    expect((await runIn(p, ['install-skill', 'codex'])).code).toBe(0);
    expect((await runIn(p, ['doctor'])).stdout).toMatch(/rendben\s+Codex \(OpenAI\) skill: .*magyar-szamlazas \(a program ezen változatáé\)\./);
    writeFileSync(join(p.home, '.agents', 'skills', 'magyar-szamlazas', 'SKILL.md'), '# régi változat\n');
    expect((await runIn(p, ['doctor'])).stdout).toContain('eltér a program ezen változatáétól.');
  });
});
