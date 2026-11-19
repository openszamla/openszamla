/**
 * Installation documentation: the README starts with the install quick start (Node.js per system, the package, then
 * `openszamla setup`, the .mcpb, the common problems), and the user documentation names every command and option the
 * command line accepts – the program may only perform documented functions (23/2014. NGM rendelet 10. §).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const version = (JSON.parse(read('package.json')) as { version: string }).version;

describe('README', () => {
  const readme = read('README.md');

  it('starts with the install quick start', () => {
    expect(readme.match(/^## .+$/m)?.[0]).toBe('## Telepítés');
    const install = readme.slice(readme.indexOf('## Telepítés'), readme.indexOf('## Tartalom'));
    for (const s of [
      'winget install OpenJS.NodeJS.LTS',
      'https://nodejs.org',
      'brew install node',
      'NodeSource',
      'új terminálablakot',
      'npm install -g openszamla',
      `npm install -g ./openszamla-${version}.tgz`, // the version of package.json
      'npm pack',
      'npm link',
      'openszamla setup',
      'openszamla doctor',
      '.mcpb',
      'Use Built-in Node.js for MCP',
      'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
      'npm.cmd install -g openszamla',
      'npm config set https-proxy',
      'NODE_OPTIONS=--use-env-proxy',
    ]) {
      expect(install, s).toContain(s);
    }
  });
});

describe('user documentation', () => {
  const doc = read('docs/felhasznaloi-dokumentacio.md');
  const source = read('src/cli/commands.ts');
  const block = (name: string): string => {
    const start = source.indexOf(`const ${name}`);
    return source.slice(start, source.indexOf('\n};', start));
  };

  it('documents every command of the command line', () => {
    const commands = [...block('COMMANDS').matchAll(/^\s+'?([a-z-]+)'?: \{ options:/gm)].map((m) => m[1] as string);
    expect(commands).toEqual(expect.arrayContaining(['setup', 'doctor', 'config', 'install-skill']));
    for (const c of commands) expect(doc, c).toMatch(new RegExp(`\`openszamla ${c}[\` ]`));
  });

  it('documents every option', () => {
    const options = [...block('OPTIONS').matchAll(/^\s+'?([a-z-]+)'?: \{ type:/gm)].map((m) => m[1] as string);
    expect(options).toEqual(expect.arrayContaining(['write', 'force', 'client', 'nav']));
    for (const o of options) expect(doc, o).toContain(`--${o}`);
  });

  it('describes setup, doctor and config --write in chapter 7, and the install steps in chapter 3', () => {
    for (const s of ['### 7.11 `openszamla setup', '### 7.12 `openszamla doctor', '**Beírás** (`--write`)', 'CLIENT_ENTRY_EXISTS', 'TRANSIENT_INSTALL', '### 3.6 Hibaelhárítás telepítéskor']) {
      expect(doc, s).toContain(s);
    }
  });
});

describe('client guide', () => {
  it('leads with setup and config --write, and points to doctor', () => {
    const k = read('docs/kliensek.md');
    for (const s of ['openszamla setup', 'openszamla config claude-desktop --write', 'openszamla config codex --write', 'openszamla config claude-code --write', 'openszamla doctor']) {
      expect(k, s).toContain(s);
    }
  });
});
