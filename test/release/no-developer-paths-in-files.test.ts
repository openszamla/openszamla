/**
 * C9: the published files hold no path of the developer's machine – no session or scratch folder of the tools the
 * project was built with, no "C:/Users/<someone>/AppData/…" of a real profile. Example paths with made-up names
 * (C:\Users\<név>\…, C:\Users\Anna\…) are fine.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.tmp', '.git', 'coverage']);
const TEXT = new Set(['.md', '.ts', '.mts', '.mjs', '.js', '.cjs', '.json', '.toml', '.yml', '.yaml', '.txt', '.xml', '.xsd', '']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (TEXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

// Built from parts, so this file does not match itself. The Microsoft Store Claude Desktop's own data folder
// (%LOCALAPPDATA%\Claude-Data\claude_…, where it keeps claude_desktop_config.json) is public and documented; a tool's
// session or scratch folder inside it is what must not appear – those markers, and a real profile path, catch it.
const MARKERS = [['scratch', 'workspaces'].join('-'), ['local', 'agent', 'mode', 'sessions'].join('-'), ['scratch', 'pad'].join(''), ['AppData', 'Local', 'Temp', 'claude'].join('/')];
/** A real-looking Windows profile path into AppData: a name that is not a placeholder (<…>, …) or an example. */
const PROFILE_APPDATA = /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!<|…|\.\.\.)[^\\/\s"'`]+[\\/]{1,2}AppData[\\/]{1,2}(Local|Roaming)[\\/]{1,2}(?!Packages[\\/])/i;

describe('no developer machine paths in the files (C9)', () => {
  it('no session, scratch or profile path in any text file of the project', () => {
    const found: string[] = [];
    for (const f of files(ROOT)) {
      const text = readFileSync(f, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        const lower = line.toLowerCase();
        if (MARKERS.some((m) => lower.includes(m.toLowerCase())) || PROFILE_APPDATA.test(line)) found.push(`${relative(ROOT, f)}:${i + 1}`);
      }
    }
    expect(found).toEqual([]);
  });
});
