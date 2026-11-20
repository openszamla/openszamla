/**
 * Release artifacts: what the npm package and the Claude Desktop extension (.mcpb) ship, and that every
 * place declaring the version, the minimum Node.js version, the server's tools/prompts and the NAV
 * options agrees with the code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { npm } from '../../scripts/lib/npm.mjs';
import { createMcpServer } from '../../src/mcp/server.ts';
import { FONT_DIR } from '../../src/pdf/engine.ts';
import { makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string): Json => JSON.parse(read(path)) as Json;
const pkg = json('package.json');
const manifest = json('mcpb/manifest.json');
const DOC_URL = `https://github.com/openszamla/openszamla/blob/v${pkg.version as string}/docs/felhasznaloi-dokumentacio.md`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Tests do not touch the network: npm runs offline, without its update check. */
const OFFLINE = { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };

describe('npm package', () => {
  it('ships the user documentation, the changelog and the licence notices', () => {
    const [packed] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, env: OFFLINE }) ?? '[]') as Array<{ files: Array<{ path: string }> }>;
    const files = (packed?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
    for (const f of [
      'docs/felhasznaloi-dokumentacio.md',
      'docs/jogi-megfeleles.md',
      'docs/nav-beallitas.md',
      'docs/kliensek.md',
      'CHANGELOG.md',
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES',
      'skills/magyar-szamlazas/SKILL.md',
    ]) {
      expect(files, f).toContain(f);
    }
  });

  it('links to the source, the issue tracker and the homepage', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/openszamla/openszamla.git' });
    expect(pkg.bugs?.url).toBe('https://github.com/openszamla/openszamla/issues');
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\/openszamla\/openszamla/);
  });

  it('declares only entry points that the build produces', () => {
    const targets: string[] = [...Object.values(pkg.bin as Record<string, string>)];
    for (const key of ['main', 'types', 'module']) if (typeof pkg[key] === 'string') targets.push(pkg[key] as string);
    const collect = (v: unknown): void => {
      if (typeof v === 'string') targets.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(pkg.exports);
    for (const t of targets.map((p) => p.replace(/^\.\//, ''))) {
      if (t === 'package.json') continue;
      const source = t.replace(/^dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts');
      expect(existsSync(join(ROOT, source)), `${t} is built from ${source}`).toBe(true);
    }
  });

  it('npm is run without a shell: an argument with spaces arrives intact (build-mcpb)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'openszamla-npm-')), 'Kovács Anna', 'openszamla');
    dirs.push(join(dir, '..', '..'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'szokoz-proba', version: '1.0.0' }));
    expect(JSON.parse(npm(['pkg', 'get', 'name', '--prefix', dir], { env: OFFLINE }) ?? '')).toBe('szokoz-proba');
    expect(read('scripts/build-mcpb.mjs')).not.toMatch(/shell\s*:\s*(true|process)/);
  });
});

describe('declared runtime', () => {
  it('the smoke test that CI runs on the minimum Node.js passes (here against the sources)', () => {
    const out = execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts', 'smoke.mjs'), '--src'], { encoding: 'utf8' });
    expect(out).toContain('smoke test passed');
  }, 60_000);

  it('states the same minimum Node.js version everywhere, and CI tests it', () => {
    const min = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node as string);
    expect(min, 'engines.node is ">=X.Y.Z"').not.toBeNull();
    const [, major, minor, patch] = min!;
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
    expect(read('src/cli/main.ts')).toContain(`const MIN = [${major}, ${minor}, ${patch}] as const;`);
    expect(json('package-lock.json').packages[''].engines.node).toBe(pkg.engines.node);
    for (const doc of ['README.md', 'docs/kliensek.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/felhasznaloi-dokumentacio.md']) {
      expect(read(doc), doc).toContain(`${major}.${minor}`);
    }
    // Development runs src/*.ts directly: type stripping without a flag (Node.js 22.18.0).
    for (const doc of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md']) expect(read(doc), doc).toContain('22.18');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain(`'${major}.${minor}.${patch}'`);
    expect(ci).toContain("'22.18.0'");
  });
});

describe('release metadata', () => {
  it('versions, pinned package and documentation links agree with package.json', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.documentation).toBe(DOC_URL);
    expect(json('plugins/openszamla/.claude-plugin/plugin.json').version).toBe(pkg.version);
    expect(json('plugins/openszamla/.mcp.json').mcpServers.openszamla.args).toContain(`openszamla@${pkg.version as string}`);
    const readme = read('README.md');
    expect(readme).toContain(DOC_URL);
    expect(readme).toContain('OPENSZAMLA-0000001');
    expect(read('plugins/openszamla/README.md')).toContain(DOC_URL);
    expect(read('docs/felhasznaloi-dokumentacio.md')).toContain(`| Verzió | ${pkg.version as string} (`);
    expect(read('CHANGELOG.md')).toContain(`\n## [${pkg.version as string}] – `);
    expect(json('package-lock.json').version).toBe(pkg.version);
  });

  it('extension and plugin options left empty do not override the NAV environment chosen in nav-setup', () => {
    const uc = manifest.user_config;
    expect(uc.nav_env.required).toBe(false);
    expect(uc.nav_env.default).toBe('');
    for (const k of ['nav_login', 'nav_password', 'nav_signing_key', 'nav_exchange_key']) {
      expect(uc[k].required, k).toBe(false);
      expect(uc[k].default, k).toBe('');
    }
    const plugin = json('plugins/openszamla/.claude-plugin/plugin.json');
    expect([undefined, '']).toContain(plugin.userConfig.nav_env.default);
    expect(manifest.server.mcp_config.env.OPENSZAMLA_NAV_ENV).toBe('${user_config.nav_env}');
    expect(json('plugins/openszamla/.mcp.json').mcpServers.openszamla.env.OPENSZAMLA_NAV_ENV).toBe('${user_config.nav_env}');
  });

  it('the plugin options pass Claude Code validation: a choice list needs a default from it, or required', () => {
    // `claude plugin validate` / `plugin install` refuse the whole plugin otherwise ("a field with options needs a
    // default among them, or required: true"). nav_env must stay empty by default (above), so it is free text.
    for (const [key, o] of Object.entries(json('plugins/openszamla/.claude-plugin/plugin.json').userConfig as Record<string, Json>)) {
      expect(['string', 'number', 'boolean', 'directory', 'file'], key).toContain(o.type);
      if (Array.isArray(o.options) && o.required !== true) expect(o.options, key).toContain(o.default);
    }
  });

  it('the extension manifest lists exactly the server tools and prompts, with the server prompt texts', async () => {
    const t = makeTestApp();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    try {
      await client.connect(clientT);
      const tools = (await client.listTools()).tools.map((x) => x.name).sort();
      expect((manifest.tools as Json[]).map((x) => x.name).sort()).toEqual(tools);
      const { prompts } = await client.listPrompts();
      expect((manifest.prompts as Json[]).map((p) => p.name).sort()).toEqual(prompts.map((p) => p.name).sort());
      for (const p of prompts) {
        const m = (manifest.prompts as Json[]).find((x) => x.name === p.name)!;
        const names = (p.arguments ?? []).map((a) => a.name);
        expect(m.description, p.name).toBe(p.description);
        expect(m.arguments ?? [], p.name).toEqual(names);
        // The manifest text is the server text with every argument given as its ${arguments.…} placeholder.
        const r = await client.getPrompt({ name: p.name, arguments: Object.fromEntries(names.map((n) => [n, `\${arguments.${n}}`])) });
        const first = r.messages[0];
        expect(m.text, p.name).toBe(first?.content.type === 'text' ? first.content.text : undefined);
      }
    } finally {
      await client.close();
      await handle.close();
      t.cleanup();
    }
  });
});

/** Name-table record (0 = copyright, 13 = licence) of a TrueType font. */
function fontName(file: string, nameId: number): string | undefined {
  const buf = readFileSync(file);
  let table = -1;
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    if (buf.toString('latin1', 12 + i * 16, 16 + i * 16) === 'name') table = buf.readUInt32BE(12 + i * 16 + 8);
  }
  const strings = table + buf.readUInt16BE(table + 4);
  for (let i = 0; i < buf.readUInt16BE(table + 2); i++) {
    const r = table + 6 + i * 12;
    if (buf.readUInt16BE(r + 6) !== nameId || buf.readUInt16BE(r) !== 3) continue; // Windows platform, UTF-16BE
    const raw = buf.subarray(strings + buf.readUInt16BE(r + 10), strings + buf.readUInt16BE(r + 10) + buf.readUInt16BE(r + 8));
    return Array.from({ length: raw.length / 2 }, (_, j) => String.fromCharCode(raw.readUInt16BE(j * 2))).join('');
  }
  return undefined;
}

describe('third-party notices', () => {
  const notices = read('THIRD-PARTY-NOTICES');

  it('carry the copyright and the full licence of every bundled font file', () => {
    const fonts = readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf'));
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      expect(notices, f).toContain(fontName(join(FONT_DIR, f), 0));
      expect(fontName(join(FONT_DIR, f), 13), f).toContain('SIL Open Font License, Version 1.1');
    }
    for (const part of ['SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007', 'PERMISSION & CONDITIONS', 'OTHER DEALINGS IN THE FONT SOFTWARE.']) {
      expect(notices).toContain(part);
    }
  });

  it('give the notice of every bundled production package that ships without a licence file', () => {
    const lock = json('package-lock.json').packages as Record<string, Json>;
    for (const [path, entry] of Object.entries(lock)) {
      if (!path.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.optional || !existsSync(join(ROOT, path))) continue;
      if (readdirSync(join(ROOT, path)).some((f) => /^(licen[cs]e|copying)/i.test(f))) continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      expect(notices, `${name} has no licence file of its own`).toContain(`- ${name} – Copyright`);
    }
  });
});
