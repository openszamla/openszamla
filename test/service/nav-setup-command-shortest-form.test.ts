/**
 * The commands the program prints for a data directory are as short as they can be and still right (dataDirOption): no
 * --data-dir for the built-in ~/.openszamla, a folder under the home folder as "~\…" (the program expands the ~ itself),
 * any other one as it is. The web's NAV setup step shows one command to copy, its npx form folded away for when the
 * command is not found, and the blocks never break a command inside a word.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirOption, navSendCommandLine, navSetupCommandLine, resolveConfiguredPath } from '../../src/service/config.ts';
import { startWeb, type WebEnv } from '../web/helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

describe('dataDirOption', () => {
  it('Windows: none for the built-in folder (in any letter case), "~\\…" under the home folder, else the path', () => {
    const home = 'C:\\Users\\Kata';
    expect(dataDirOption('C:\\Users\\Kata\\.openszamla', home, 'win32')).toBe('');
    expect(dataDirOption('c:\\users\\kata\\.OpenSzamla', home, 'win32')).toBe('');
    expect(dataDirOption('C:\\Users\\Kata\\Dokumentumok\\Számlák', home, 'win32')).toBe(' --data-dir "~\\Dokumentumok\\Számlák"');
    expect(dataDirOption('C:\\Users\\Kata', home, 'win32')).toBe(' --data-dir "~"');
    expect(dataDirOption('C:\\Users\\Katalin\\.openszamla', home, 'win32')).toBe(' --data-dir "C:\\Users\\Katalin\\.openszamla"');
    expect(dataDirOption('D:\\Adatok\\OpenSzámla', home, 'win32')).toBe(' --data-dir "D:\\Adatok\\OpenSzámla"');
  });

  it('macOS / Linux: "~/…" under the home folder; Linux paths are case-sensitive', () => {
    expect(dataDirOption('/home/kata/.openszamla', '/home/kata', 'linux')).toBe('');
    expect(dataDirOption('/home/kata/szamlak', '/home/kata', 'linux')).toBe(' --data-dir "~/szamlak"');
    expect(dataDirOption('/home/Kata/.openszamla', '/home/kata', 'linux')).toBe(' --data-dir "/home/Kata/.openszamla"');
    expect(dataDirOption('/srv/openszamla', '/home/kata', 'linux')).toBe(' --data-dir "/srv/openszamla"');
    expect(dataDirOption('/Users/Kata/.openszamla', '/Users/kata', 'darwin')).toBe('');
  });

  it('the "~" form is a path the program reads back to the same folder', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\Kata' : '/home/kata';
    const dir = join(home, 'Dokumentumok', 'Számlák');
    const shown = dataDirOption(dir, home).replace(/^ --data-dir "|"$/g, '');
    expect(shown.startsWith('~')).toBe(true);
    // resolveConfiguredPath expands "~" with the running user's home folder: the same folder for that home.
    expect(resolveConfiguredPath(shown, '--data-dir').endsWith(join('Dokumentumok', 'Számlák'))).toBe(true);
  });

  it('every command of the program uses it', () => {
    const dir = 'D:\\Adatok\\OpenSzámla';
    expect(navSetupCommandLine(dir)).toBe(`openszamla nav-setup${dataDirOption(dir)}`);
    expect(navSetupCommandLine(dir, 'production')).toBe(`openszamla nav-setup --env production${dataDirOption(dir)}`);
    expect(navSendCommandLine('SZ-2026-00001', dir)).toBe(`openszamla nav-send-to-configured-environment "SZ-2026-00001" --confirm${dataDirOption(dir)}`);
  });
});

describe('the NAV setup step of the web UI', () => {
  it('one command to copy, run in a new terminal window; the npx form folded away; the blocks scroll instead of wrapping', async () => {
    const e = await startWeb();
    envs.push(e);
    const b = await e.loggedIn();
    const page = (await b.get('/')).body;
    const step = page.slice(page.indexOf('id="guide-nav"'), page.indexOf('</li>', page.indexOf('<details class="cmd-alt">')));
    expect(step).toContain('Egy új terminálablakban (az <code>openszamla serve</code> ablakát hagyd nyitva) futtasd ezt a parancsot, és add meg a kért adatokat');
    expect(step.match(/<code class="cmd"/g)?.length).toBe(2);
    expect(step.indexOf('<details class="cmd-alt"><summary>Ha az „openszamla” parancs nem található</summary>')).toBeLessThan(step.indexOf('id="guide-nav-npx"'));
    expect(step.indexOf('id="guide-nav-cmd"')).toBeLessThan(step.indexOf('<details class="cmd-alt">'));
    expect(page).toContain('.cmd{display:block;margin:.5rem 0;padding:.75rem 1rem;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);font-size:.8125rem;white-space:pre;overflow-x:auto;overflow-wrap:normal}');
  });
});
