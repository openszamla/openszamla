/**
 * C8, U1: every command block of the README and the client guide can be pasted as it is into PowerShell, cmd and bash –
 * one command per line, no comment after a command (cmd has none: "#" would become arguments), no "&&" (Windows
 * PowerShell 5.1 has none), no pipe –, and the quick start gives Windows PowerShell commands that work with its default
 * execution policy (npm.cmd, openszamla.cmd) apart from the macOS / Linux ones.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
/** The version the package file of the quick start is named after. */
const VERSION = (JSON.parse(read('package.json')) as { version: string }).version;

/** The fenced blocks of a Markdown file: [language, lines]. */
function blocks(md: string): Array<{ lang: string; lines: string[] }> {
  const out: Array<{ lang: string; lines: string[] }> = [];
  let open: { lang: string; lines: string[] } | null = null;
  for (const line of md.split('\n')) {
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      if (open) {
        out.push(open);
        open = null;
      } else open = { lang: fence[1] ?? '', lines: [] };
    } else open?.lines.push(line);
  }
  return out;
}

const SHELL = new Set(['bash', 'sh', 'powershell', 'cmd', '']);

describe('command blocks are copy-paste safe (C8)', () => {
  it.each(['README.md', 'docs/kliensek.md'])('%s: one command per line, no trailing comment, no && or pipe', (file) => {
    const commands = blocks(read(file)).filter((b) => SHELL.has(b.lang)).flatMap((b) => b.lines.filter((l) => l.trim() !== ''));
    expect(commands.length).toBeGreaterThan(5);
    const unsafe = commands.filter((l) => /\s#|&&|\s\|\s/.test(l));
    expect(unsafe).toEqual([]);
  });

  it('README: the clone and cd are two lines', () => {
    const lines = blocks(read('README.md')).flatMap((b) => b.lines);
    expect(lines).toContain('git clone https://github.com/openszamla/openszamla.git');
    expect(lines).toContain('cd openszamla');
  });
});

describe('the quick start works in a default Windows PowerShell (U1)', () => {
  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('## Telepítés'), readme.indexOf('## Tartalom'));
  const all = blocks(install);
  const ps = all.filter((b) => b.lang === 'powershell').flatMap((b) => b.lines);
  const sh = all.filter((b) => b.lang === 'bash').flatMap((b) => b.lines);

  it('PowerShell blocks use the .cmd starters, the macOS / Linux blocks the plain commands', () => {
    expect(ps).toEqual(['npm.cmd install -g openszamla', `npm.cmd install -g .\\openszamla-${VERSION}.tgz`, 'openszamla.cmd setup']);
    expect(sh).toEqual(['npm install -g openszamla', `npm install -g ./openszamla-${VERSION}.tgz`, 'openszamla setup']);
    for (const l of ps) expect(l, l).toMatch(/^(npm|openszamla)\.cmd /);
  });

  it('it says why before the first command, and keeps the troubleshooting', () => {
    const why = install.indexOf('A Windows alapbeállítása a PowerShellben letiltja az npm és az OpenSzámla `.ps1`');
    expect(why).toBeGreaterThan(0);
    expect(why).toBeLessThan(install.indexOf('```powershell'));
    expect(install).toContain('running scripts is disabled on this system');
    expect(install).toContain('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
    expect(install).toContain('`openszamla.cmd doctor`');
  });

  it('the user documentation (3.1, 7.1) and the client guide give the same forms', () => {
    const doc = read('docs/felhasznaloi-dokumentacio.md');
    const s31 = doc.slice(doc.indexOf('### 3.1 Telepítés'), doc.indexOf('### 3.2 Adatkönyvtár'));
    for (const s of ['`npm.cmd install -g openszamla`', '`openszamla.cmd setup`', '`openszamla.cmd --version`', '`npm install -g openszamla`']) expect(s31, s).toContain(s);
    const s71 = doc.slice(doc.indexOf('### 7.1 Közös szabályok'), doc.indexOf('### 7.2'));
    expect(s71).toContain('`.cmd` végződéssel');
    expect(read('docs/kliensek.md')).toContain('`openszamla.cmd setup`');
  });
});
