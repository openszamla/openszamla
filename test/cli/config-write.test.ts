/**
 * `openszamla config <client> --write` (7.9): the server entry goes into the client's own configuration, merged with
 * what is there, after a timestamped backup; an existing different "openszamla" entry is replaced only with --force;
 * the output says what changed and how to undo it, and never echoes secrets. The entry starts the server without a
 * shell and without PATH. Every run uses a throw-away profile (HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
 * XDG_CONFIG_HOME) and a fake `claude`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { entryScript, jsonErrorOffset, nodeExecutable, stripJsonComments } from '../../src/cli/clients.ts';
import { makeProfile, removeProfiles, runIn, type Profile } from '../helpers/client-profile.ts';

afterEach(() => removeProfiles());

type Json = Record<string, any>;

function desktopConfig(p: Profile): string {
  if (process.platform === 'win32') return join(p.appData, 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(p.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(p.xdgConfig, 'Claude', 'claude_desktop_config.json');
}

const writeJson = (file: string, data: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;
const backups = (file: string): string[] => readdirSync(dirname(file)).filter((f) => f.startsWith(`${file.slice(dirname(file).length + 1)}.bak-`));
const expectedLaunch = (p: Profile): { command: string; script: string } => ({ command: nodeExecutable({ env: p.env, platform: process.platform }), script: entryScript() });

describe('config claude-desktop --write', () => {
  it('adds the entry next to the other servers and settings, after a backup; says what changed and how to undo it', async () => {
    const p = makeProfile();
    const file = desktopConfig(p);
    const before = { mcpServers: { filesystem: { command: 'npx', args: ['-y', 'fs-server'], env: { SECRET_TOKEN: 'titkos-ertek-123' } } }, preferences: { menuBarEnabled: false } };
    writeJson(file, before);
    const original = readFileSync(file, 'utf8');
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    const after = readJson(file);
    const { command, script } = expectedLaunch(p);
    expect(after.mcpServers.openszamla).toEqual({ command, args: [script, 'mcp'] });
    expect(after.mcpServers.filesystem).toEqual(before.mcpServers.filesystem);
    expect(after.preferences).toEqual(before.preferences);
    const [backup] = backups(file);
    expect(backup).toMatch(/\.bak-\d{8}-\d{6}$/);
    expect(readFileSync(join(dirname(file), backup as string), 'utf8')).toBe(original);
    expect(r.stdout).toContain(`Claude Desktop: módosítottam – ${file}`);
    expect(r.stdout).toContain('Hozzáadtam az openszamla bejegyzést:');
    expect(r.stdout).toContain('A fájl többi része változatlan (további szerverek: filesystem).');
    expect(r.stdout).toContain(`Biztonsági másolat: ${join(dirname(file), backup as string)}`);
    expect(r.stdout).toMatch(process.platform === 'win32' ? /Visszavonás: Copy-Item -Force '.+\.bak-\d{8}-\d{6}' '.+claude_desktop_config\.json'/ : /Visszavonás: cp '.+\.bak-\d{8}-\d{6}' '.+claude_desktop_config\.json'/);
    expect(r.stdout).toContain('Következő lépés: lépj ki teljesen a Claude Desktopból');
    expect(r.stdout + r.stderr).not.toContain('titkos-ertek-123');
  });

  it('a second run changes nothing; a different entry is refused without --force and replaced with it', async () => {
    const p = makeProfile();
    const file = desktopConfig(p);
    expect((await runIn(p, ['config', 'claude-desktop', '--write'])).code).toBe(0);
    expect(backups(file)).toEqual([]); // there was nothing to back up
    const again = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Claude Desktop: már be van állítva, nem változtattam semmit');
    expect(backups(file)).toEqual([]);

    // An entry of the user's own, with a secret in it.
    const own = readJson(file);
    own.mcpServers.openszamla = { command: 'openszamla', args: ['mcp'], env: { OPENSZAMLA_NAV_PASSWORD: 'nav-jelszo-xyz' } };
    writeJson(file, own);
    const text = readFileSync(file, 'utf8');
    const other = join(p.root, 'Számlák 2026');
    const refused = await runIn(p, ['config', 'claude-desktop', '--write', '--data-dir', other]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Hiba [CLIENT_ENTRY_EXISTS]');
    expect(refused.stderr).toContain('(parancs: openszamla; 1 argumentum; környezeti változók: OPENSZAMLA_NAV_PASSWORD)');
    expect(refused.stderr).toContain(`Tipp: Ha le akarod cserélni (a régiről biztonsági másolat készül): openszamla config claude-desktop --write --force --data-dir "${other}"`);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(backups(file)).toEqual([]);

    const forced = await runIn(p, ['config', 'claude-desktop', '--write', '--force', '--data-dir', other]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain('Lecseréltem a korábbi openszamla bejegyzést (parancs: openszamla; 1 argumentum; környezeti változók: OPENSZAMLA_NAV_PASSWORD)');
    expect(readJson(file).mcpServers.openszamla.env).toEqual({ OPENSZAMLA_HOME: other });
    expect(backups(file)).toHaveLength(1);
    expect(refused.stderr + forced.stdout + forced.stderr).not.toContain('nav-jelszo-xyz');
  });

  it('a file that is not valid JSON is left alone: no backup, the place of the error, nothing of its content', async () => {
    const p = makeProfile();
    const file = desktopConfig(p);
    mkdirSync(dirname(file), { recursive: true });
    const broken = '{\n  "mcpServers": {\n    "x": { "command": "titkos-parancs-42", }\n  }\n}\n';
    writeFileSync(file, broken);
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [CLIENT_CONFIG_INVALID]');
    expect(r.stderr).toMatch(/nem érvényes JSON \(3\. sor, \d+\. oszlop\) – nem módosítottam\./);
    expect(r.stderr).not.toContain('titkos-parancs-42');
    expect(readFileSync(file, 'utf8')).toBe(broken);
    expect(backups(file)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('Windows, older Store builds: writes the file the Microsoft Store (MSIX) app reads once that app has created its folder', async () => {
    const p = makeProfile();
    const msixDir = join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(msixDir, { recursive: true });
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(msixDir, 'claude_desktop_config.json'))).toBe(true);
    expect(existsSync(desktopConfig(p))).toBe(false);
    expect(r.stdout).toContain('a Microsoft Store-ból (MSIX) telepített régebbi Claude Desktop ezt olvassa');
  });

  it.runIf(process.platform === 'win32')('Windows: the classic file wins while the Store app has no file of its own', async () => {
    const p = makeProfile();
    mkdirSync(join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'), { recursive: true });
    writeJson(desktopConfig(p), { mcpServers: {} });
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(desktopConfig(p)).mcpServers.openszamla).toBeDefined();
  });

  // Current Store builds keep their whole state – claude_desktop_config.json too – in %LOCALAPPDATA%\Claude-Data\claude_<id>
  // and read nothing else: a file an older build (or a tool inside the package) left in the AppData copy must not win.
  it.runIf(process.platform === 'win32')('Windows, current Store builds: writes the app data folder\'s file, keeps the app\'s own settings, leaves the older files alone', async () => {
    const p = makeProfile();
    const dataFile = join(p.localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json');
    writeJson(dataFile, { mcpServers: {}, coworkUserFilesPath: 'C:\\Felhasznalo\\Cowork', preferences: { menuBarEnabled: true, sidebarMode: 'chat' } });
    const legacyFile = join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
    writeJson(legacyFile, { mcpServers: { other: { command: 'x', args: [] } } });
    writeJson(desktopConfig(p), { mcpServers: { other: { command: 'x', args: [] } } });
    const legacyBefore = readFileSync(legacyFile, 'utf8');
    const classicBefore = readFileSync(desktopConfig(p), 'utf8');

    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    const written = readJson(dataFile);
    expect(written.mcpServers.openszamla.args.at(-1)).toBe('mcp');
    expect(written.preferences).toEqual({ menuBarEnabled: true, sidebarMode: 'chat' });
    expect(written.coworkUserFilesPath).toBe('C:\\Felhasznalo\\Cowork');
    expect(Object.keys(written)).toEqual(['mcpServers', 'coworkUserFilesPath', 'preferences']);
    expect(backups(dataFile)).toHaveLength(1);
    expect(readFileSync(legacyFile, 'utf8')).toBe(legacyBefore);
    expect(readFileSync(desktopConfig(p), 'utf8')).toBe(classicBefore);
    expect(r.stdout).toContain(`Claude Desktop (a Microsoft Store-ból (MSIX) telepített Claude Desktop ezt olvassa): módosítottam – ${dataFile}`);

    // Run again: the entry is there, nothing is written.
    const again = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(again.code, again.stderr).toBe(0);
    expect(backups(dataFile)).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('Windows, current Store builds: the app data folder wins even before the app has written the file there', async () => {
    const p = makeProfile();
    const dataDir = join(p.localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), '{}\n');
    const legacyFile = join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
    writeJson(legacyFile, { mcpServers: {} });
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(join(dataDir, 'claude_desktop_config.json')).mcpServers.openszamla).toBeDefined();
    expect(readJson(legacyFile).mcpServers.openszamla).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows: an empty data folder left behind by an uninstalled Store build does not hide the classic configuration in use', async () => {
    const p = makeProfile();
    const leftover = join(p.localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
    mkdirSync(leftover, { recursive: true });
    writeJson(desktopConfig(p), { mcpServers: { other: { command: 'x', args: [] } } });
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(desktopConfig(p)).mcpServers.openszamla).toBeDefined();
    expect(existsSync(join(leftover, 'claude_desktop_config.json'))).toBe(false);
    // doctor and config agree: run again, nothing more to do.
    const doctor = await runIn(p, ['doctor']);
    expect(doctor.stdout).toMatch(/rendben\s+Claude Desktop: .*openszamla bejegyzés, a parancs létezik/);
  });

  it.runIf(process.platform === 'win32')('Windows: of two Store data folders the one whose configuration changed last is the app in use', async () => {
    const p = makeProfile();
    const older = join(p.localAppData, 'Claude-Data', 'claude_aaaa1111', 'claude_desktop_config.json');
    const newer = join(p.localAppData, 'Claude-Data', 'claude_zzzz9999', 'claude_desktop_config.json');
    writeJson(older, { mcpServers: {} });
    writeJson(newer, { mcpServers: {} });
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newer, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    const r = await runIn(p, ['config', 'claude-desktop', '--write']);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(newer).mcpServers.openszamla).toBeDefined();
    expect(readJson(older).mcpServers.openszamla).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('Windows: doctor shows every Claude Desktop file and marks the one config --write writes', async () => {
    const p = makeProfile();
    const dataFile = join(p.localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json');
    writeJson(dataFile, { mcpServers: {}, preferences: {} });
    writeJson(join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'), { mcpServers: {} });
    expect((await runIn(p, ['config', 'claude-desktop', '--write'])).code).toBe(0);
    const r = await runIn(p, ['doctor']);
    const lines = r.stdout.split('\n').filter((l) => l.includes(`Claude Desktop: ${dataFile}`));
    expect(lines.find((l) => l.includes('info'))).toContain('a Microsoft Store-ból (MSIX) telepített Claude Desktop ezt olvassa; a config --write ezt a fájlt írja.');
    expect(lines.find((l) => l.includes('rendben'))).toMatch(/rendben\s+Claude Desktop: .*openszamla bejegyzés, a parancs létezik/);
  });
});

describe('config cursor / vscode --write', () => {
  it('cursor: creates ~/.cursor/mcp.json; undo is removing the new file', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['config', 'cursor', '--write']);
    expect(r.code, r.stderr).toBe(0);
    const file = join(p.home, '.cursor', 'mcp.json');
    expect(readJson(file).mcpServers.openszamla.args[1]).toBe('mcp');
    expect(r.stdout).toContain(`Cursor: létrehoztam – ${file}`);
    expect(r.stdout).toMatch(process.platform === 'win32' ? /Visszavonás: Remove-Item '.+mcp\.json'/ : /Visszavonás: rm '.+mcp\.json'/);
  });

  it('vscode: .vscode/mcp.json of the workspace (the working directory) with "servers" and type stdio – never into the home folder', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['config', 'vscode', '--write']);
    expect(r.code, r.stderr).toBe(0);
    const entry = readJson(join(p.work, '.vscode', 'mcp.json')).servers.openszamla;
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual([entryScript(), 'mcp']);
    const home = await runIn(p, ['config', 'vscode', '--write'], { cwd: p.home });
    expect(home.code).toBe(1);
    expect(home.stderr).toContain('Hiba [INVALID_INPUT]: A VS Code-beállítást a munkaterület (projekt) mappájába írom');
    expect(existsSync(join(p.home, '.vscode'))).toBe(false);
  });

  // The working directory a process reports is a resolved path, the home folder may be named through a link (a home on
  // another volume; macOS keeps even its temp folder behind one): the two are compared by their real paths.
  it('vscode: the home folder is recognised through a link too', async () => {
    const p = makeProfile();
    const link = join(p.root, 'home-link');
    symlinkSync(p.home, link, 'junction');
    const r = await runIn(p, ['config', 'vscode', '--write'], { cwd: realpathSync(p.home), env: { HOME: link, USERPROFILE: link } });
    expect(r.code, r.stdout).toBe(1);
    expect(r.stderr).toContain('Hiba [INVALID_INPUT]: A VS Code-beállítást a munkaterület (projekt) mappájába írom');
    expect(existsSync(join(p.home, '.vscode'))).toBe(false);
  });

  // VS Code reads mcp.json as JSON with comments (and trailing commas): such a file is valid, not corrupt.
  it('vscode: a commented mcp.json is not rewritten (the comments would be lost) – the entry to add by hand is shown; doctor reads it', async () => {
    const p = makeProfile();
    const file = join(p.work, '.vscode', 'mcp.json');
    mkdirSync(dirname(file), { recursive: true });
    const commented = '{\n  // my servers – "not // a comment" inside a string stays\n  "servers": {\n    "other": { "type": "stdio", "command": "x", "args": ["a//b", "/* c */"], },\n  },\n  /* inputs */\n  "inputs": [],\n}\n';
    writeFileSync(file, commented);
    const r = await runIn(p, ['config', 'vscode', '--write']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [CLIENT_CONFIG_HAS_COMMENTS]');
    expect(r.stderr).toContain('megjegyzéseket vagy záró vesszőt tartalmaz (a VS Code megengedi), amelyeket az átírás elveszítene – nem módosítottam.');
    expect(r.stderr).toContain('Add hozzá kézzel a „servers” részhez');
    expect(r.stderr).toContain('"openszamla": {"type":"stdio","command":');
    expect(readFileSync(file, 'utf8')).toBe(commented);
    expect(backups(file)).toEqual([]);

    // The entry added by hand, still with comments: doctor reads it as VS Code does.
    const launch = expectedLaunch(p);
    const byHand = commented.replace('"other":', `"openszamla": { "type": "stdio", "command": ${JSON.stringify(launch.command)}, "args": [${JSON.stringify(launch.script)}, "mcp"] }, // added\n    "other":`);
    writeFileSync(file, byHand);
    const doctor = await runIn(p, ['doctor'], { cwd: p.work });
    expect(doctor.stdout).toMatch(/rendben\s+VS Code \(munkaterület\): .*openszamla bejegyzés, a parancs létezik/);
    expect(doctor.stdout).not.toContain('nem érvényes JSON');
    // And config --write sees that it is already there.
    const again = await runIn(p, ['config', 'vscode', '--write']);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('már be van állítva, nem változtattam semmit');
    expect(readFileSync(file, 'utf8')).toBe(byHand);
  });

  it('a file that is not JSON even without its comments is still reported with the place of the error', async () => {
    const p = makeProfile();
    const file = join(p.work, '.vscode', 'mcp.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{\n  // comment\n  "servers": { "x": }\n}\n');
    const r = await runIn(p, ['config', 'vscode', '--write']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [CLIENT_CONFIG_INVALID]');
    // The real mistake – the missing value in line 3 –, not the comment in line 2 (which VS Code allows).
    expect(r.stderr).toMatch(/nem érvényes JSON \(3\. sor, \d+\. oszlop\) – nem módosítottam\./);
    expect(r.stderr).toContain('a megjegyzés és a záró vessző itt megengedett');
  });
});

describe('jsonErrorOffset', () => {
  it('agrees with JSON.parse on what is valid, and names where an invalid text stops being JSON', () => {
    const cases: Array<[string, number | null]> = [
      ['{}', null], ['{"a":[1,2,{"b":null}],"c":"x"}', null], [' [ ] ', null], ['-1.5e+3', null], ['"szöveg"', null],
      ['{"a": }', 6], ['{"a":1,}', 7], ['{"a":1 "b":2}', 7], ['[1,2', 4], ['{"a":"x', 7], ['{a:1}', 1], ['{"a":01}', 6], ['', 0], ['{} x', 3],
    ];
    for (const [text, at] of cases) {
      let valid = true;
      try {
        JSON.parse(text);
      } catch {
        valid = false;
      }
      expect(jsonErrorOffset(text), text).toBe(at);
      expect(valid, text).toBe(at === null);
    }
  });
});

describe('stripJsonComments', () => {
  it('removes comments and trailing commas, keeps strings and line numbers', () => {
    const text = '{\n  "a": "x // y", // c\n  /* b\n  c */ "b": [1, 2, ],\n  "c": "\\"/* no */",\n}';
    const stripped = stripJsonComments(text);
    expect(JSON.parse(stripped)).toEqual({ a: 'x // y', b: [1, 2], c: '"/* no */' });
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('config codex --write (config.toml without a TOML library)', () => {
  it('appends the table with literal strings, keeps the rest byte for byte (CRLF included)', async () => {
    const p = makeProfile();
    const file = join(p.home, '.codex', 'config.toml');
    mkdirSync(dirname(file), { recursive: true });
    const before = 'model = "gpt-5"\r\n\r\n[mcp_servers.other]\r\ncommand = "other"\r\n';
    writeFileSync(file, before);
    const dir = join(p.root, "O'Brien számlái");
    const r = await runIn(p, ['config', 'codex', '--write', '--data-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    const { command, script } = expectedLaunch(p);
    expect(after).toContain(`[mcp_servers.openszamla]\r\ncommand = '${command}'\r\nargs = ['${script}', 'mcp']\r\n`);
    expect(after).toContain(`env = { OPENSZAMLA_HOME = ${JSON.stringify(dir)} }\r\n`); // a quote in the path: basic string
    expect(after).toContain('startup_timeout_sec = 30\r\ntool_timeout_sec = 300\r\n');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(backups(file)).toHaveLength(1);
    expect((await runIn(p, ['config', 'codex', '--write', '--data-dir', dir])).stdout).toContain('Codex (OpenAI): már be van állítva');
  });

  it('an existing [mcp_servers.openszamla] is refused; --force replaces it with its subtables and keeps everything else', async () => {
    const p = makeProfile();
    const file = join(p.home, '.codex', 'config.toml');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        '[mcp_servers.openszamla]',
        'command = "openszamla"',
        'args = ["mcp"]',
        'env = { OPENSZAMLA_NAV_PASSWORD = "nav-jelszo-xyz" }',
        '',
        '[mcp_servers.openszamla.tools.invoice_issue]',
        'approval_mode = "prompt"',
        '',
        '# the other server',
        '[mcp_servers.other]',
        'command = "other"',
        '',
      ].join('\n'),
    );
    const refused = await runIn(p, ['config', 'codex', '--write']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Hiba [CLIENT_ENTRY_EXISTS]');
    expect(refused.stderr).toContain('parancs: openszamla; 1 argumentum; környezeti változók: OPENSZAMLA_NAV_PASSWORD; 1., 6. sor');
    const forced = await runIn(p, ['config', 'codex', '--write', '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after).not.toContain('nav-jelszo-xyz');
    expect(after).not.toContain('invoice_issue');
    expect(after).toContain('# the other server\n[mcp_servers.other]\ncommand = "other"\n');
    expect(after.match(/\[mcp_servers\.openszamla\]/g)).toHaveLength(1);
    expect(refused.stderr + forced.stdout).not.toContain('nav-jelszo-xyz');
  });

  it('forms it cannot edit safely are refused even with --force: dotted keys, an inline mcp_servers table', async () => {
    const p = makeProfile();
    const file = join(p.home, '.codex', 'config.toml');
    mkdirSync(dirname(file), { recursive: true });
    for (const text of ['mcp_servers.openszamla.command = "openszamla"\n', 'mcp_servers = { other = { command = "other" } }\n']) {
      writeFileSync(file, text);
      const r = await runIn(p, ['config', 'codex', '--write', '--force']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Hiba [CLIENT_CONFIG_UNSUPPORTED]');
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });

  it('a byte order mark at the start (Notepad, PowerShell 5.1) is no obstacle: the JSON is read, the TOML keeps it', async () => {
    const p = makeProfile();
    const BOM = String.fromCharCode(0xfeff);
    const json = join(p.home, '.cursor', 'mcp.json');
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, `${BOM}{ "mcpServers": {} }\n`);
    expect((await runIn(p, ['config', 'cursor', '--write'])).code).toBe(0);
    expect(readJson(json).mcpServers.openszamla).toBeDefined(); // written back without the mark
    const toml = join(p.home, '.codex', 'config.toml');
    mkdirSync(dirname(toml), { recursive: true });
    writeFileSync(toml, `${BOM}model = "x"\n`);
    expect((await runIn(p, ['config', 'codex', '--write'])).code).toBe(0);
    const after = readFileSync(toml, 'utf8');
    expect(after.startsWith(`${BOM}model = "x"\n`)).toBe(true);
    expect(after.split(BOM)).toHaveLength(2);
  });

  it('follows CODEX_HOME', async () => {
    const p = makeProfile();
    const codexHome = join(p.root, 'codex-home');
    const r = await runIn(p, ['config', 'codex', '--write'], { env: { CODEX_HOME: codexHome } });
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('[mcp_servers.openszamla]');
    expect(existsSync(join(p.home, '.codex'))).toBe(false);
  });
});

describe('config claude-code --write', () => {
  it('runs `claude mcp add --scope user …` without a shell (a fake claude records the arguments)', async () => {
    const p = makeProfile({ fakeClaude: true });
    const dir = join(p.root, 'Kovács Anna', 'Számlák');
    const r = await runIn(p, ['config', 'claude-code', '--write', '--data-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    const { command, script } = expectedLaunch(p);
    expect(p.claudeCalls()).toEqual([['mcp', 'add', '-e', `OPENSZAMLA_HOME=${dir}`, '--transport', 'stdio', '--scope', 'user', 'openszamla', '--', command, script, 'mcp']]);
    expect(r.stdout).toContain('Claude Code: beállítottam (felhasználói szint, minden projektben).');
    expect(r.stdout).toContain('claude: Added stdio MCP server openszamla to user config');
    expect(r.stdout).toContain('Visszavonás: claude mcp remove --scope user openszamla');
  });

  it('an existing different user-scope entry (~/.claude.json) is refused; --force removes it first', async () => {
    const p = makeProfile({ fakeClaude: true });
    writeJson(join(p.home, '.claude.json'), { mcpServers: { openszamla: { type: 'stdio', command: 'openszamla', args: ['mcp'], env: {} } } });
    const refused = await runIn(p, ['config', 'claude-code', '--write']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Hiba [CLIENT_ENTRY_EXISTS]');
    expect(p.claudeCalls()).toEqual([]);
    const forced = await runIn(p, ['config', 'claude-code', '--write', '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    expect(p.claudeCalls().map((a) => a.slice(0, 2).join(' '))).toEqual(['mcp remove', 'mcp add']);
    expect(p.claudeCalls()[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'openszamla']);
  });

  it('a failing claude is CLAUDE_COMMAND_FAILED (exit 1) with the line to run by hand', async () => {
    const p = makeProfile({ fakeClaude: true, claudeExit: 3 });
    const r = await runIn(p, ['config', 'claude-code', '--write']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Hiba [CLAUDE_COMMAND_FAILED]: A claude mcp add nem sikerült');
    expect(r.stderr).toContain('Tipp: Futtasd kézzel egy terminálban: claude mcp add --transport stdio --scope user openszamla -- ');
  });

  it('without claude on PATH it prints the exact command instead', async () => {
    const p = makeProfile();
    const r = await runIn(p, ['config', 'claude-code', '--write']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('A claude parancs nincs a PATH-on');
    const { command, script } = expectedLaunch(p);
    expect(r.stdout).toContain(`claude mcp add --transport stdio --scope user openszamla -- "${command}" "${script}" mcp`);
  });

  it.runIf(process.platform === 'win32')('Windows: a claude.cmd shim is not run (it would need a shell) – the command is printed', async () => {
    const p = makeProfile();
    const marker = join(p.root, 'ran.txt');
    writeFileSync(join(p.bin, 'claude.cmd'), `@echo off\r\necho ran> "${marker}"\r\n`);
    const r = await runIn(p, ['config', 'claude-code', '--write']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`A claude parancs (${join(p.bin, 'claude.cmd')}) csak parancsértelmezővel indítható, ezért nem futtatom.`);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('what --write refuses', () => {
  it('http has nothing to write; --force needs --write; an unknown client', async () => {
    const p = makeProfile();
    const http = await runIn(p, ['config', 'http', '--write']);
    expect(http.code).toBe(1);
    expect(http.stderr).toContain('Hiba [INVALID_INPUT]: A HTTP-kapcsolatot nem lehet beírni');
    const force = await runIn(p, ['config', 'cursor', '--force']);
    expect(force.code).toBe(1);
    expect(force.stderr).toContain('Hiba [INVALID_INPUT]: A --force kapcsoló csak a --write kapcsolóval együtt használható.');
    const unknown = await runIn(p, ['config', 'cluade-desktop', '--write']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Hiba [INVALID_INPUT]: Ismeretlen kliens: cluade-desktop');
    expect(readdirSync(p.home).sort()).toEqual(['.config', 'AppData']);
  });
});

/** Starts `command args` without a shell, like a desktop client, and lists the tools over MCP (stdio); resolves once the server has exited. */
function listTools(command: string, args: string[], env: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let stderr = '';
    let tools: string[] | null = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer: ${stderr}`));
    }, 20_000);
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line) as Json;
        if (msg.id === 2) {
          tools = (msg.result.tools as Json[]).map((t) => t.name as string);
          child.stdin.end(); // the server exits at the end of its input
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // The database stays open until the process is gone (Windows cannot delete the folder before).
    child.on('close', () => {
      clearTimeout(timer);
      if (tools) resolve(tools);
      else reject(new Error(`the server ended without answering: ${stderr}`));
    });
    const send = (m: Json): boolean => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
  });
}

describe('the written entry', () => {
  it('starts the server without a shell and without Node.js on PATH (as a desktop app does)', async () => {
    const p = makeProfile();
    const dir = join(p.root, 'adatok');
    expect((await runIn(p, ['config', 'claude-desktop', '--write', '--data-dir', dir])).code).toBe(0);
    const entry = readJson(desktopConfig(p)).mcpServers.openszamla as { command: string; args: string[]; env: Record<string, string> };
    const empty = join(p.root, 'empty-path');
    mkdirSync(empty);
    // What the MCP SDK passes on by default, from the throw-away profile; PATH without Node.js.
    const env: Record<string, string> = {};
    for (const k of DEFAULT_INHERITED_ENV_VARS) {
      const v = p.env[k] ?? Object.entries(p.env).find(([key]) => key.toUpperCase() === k)?.[1];
      if (v !== undefined) env[k] = v;
    }
    env.PATH = empty;
    const tools = await listTools(entry.command, entry.args, { ...env, ...entry.env });
    expect(tools).toContain('setup_status');
    expect(tools).toContain('invoice_issue');
    expect(existsSync(join(dir, 'openszamla.db'))).toBe(true);
  });
});
