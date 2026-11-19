/**
 * The example tax numbers the program shows – in hints, error messages, form placeholders, tool descriptions and the user
 * documentation – pass the program's own check: a user who types the example must not be told "az ellenőrző számjegye
 * nem stimmel". Every tax-number-shaped example in the sources is parsed with parseHuTaxNumber (the "HU…" community
 * numbers and the bare 8-digit törzsszám examples too).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBankAccount, parseHuTaxNumber } from '../../src/core/validate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Tax-number-shaped examples: 12345676-1-23 (either hyphen), 12345676123, HU12345676, "pl. 12345676". */
const SHAPES = [/(?<![\d-])\d{8}[-‑][1-5][-‑]\d{2}(?!\d)/g, /(?<![\d\w])HU\d{8}(?!\d)/g, /(?<=pl\. |e\.g\. )\d{8}(?![\d‑-])/g];

describe('example tax numbers', () => {
  it('every example in the sources and the user documentation passes the check digit', () => {
    const files = [...sources(join(ROOT, 'src')), join(ROOT, 'docs', 'felhasznaloi-dokumentacio.md'), join(ROOT, 'README.md'), join(ROOT, 'docs', 'kliensek.md')];
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of SHAPES) {
        for (const m of text.matchAll(re)) {
          seen++;
          const example = m[0].replace(/‑/g, '-');
          if (!parseHuTaxNumber(example).ok) bad.push(`${relative(ROOT, f)}: ${example}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it('every bank-account example in the sources, the user documentation and the README passes the GIRO check', () => {
    const files = [...sources(join(ROOT, 'src')), join(ROOT, 'docs', 'felhasznaloi-dokumentacio.md'), join(ROOT, 'README.md')];
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?<![\d-‑])\d{8}[-‑]\d{8}(?:[-‑]\d{8})?(?![\d‑-])/g)) {
        seen++;
        const example = m[0].replace(/‑/g, '-');
        if (!parseBankAccount(example).ok) bad.push(`${relative(ROOT, f)}: ${example}`);
      }
    }
    expect(seen).toBeGreaterThan(2);
    expect(bad).toEqual([]);
  });

  it('a bare 8-digit tax number in a sample sentence is a valid one too', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const m of readme.matchAll(/(?<![\d-‑])(\d{8}) adószámú/g)) expect(parseHuTaxNumber(m[1] as string).ok, m[0]).toBe(true);
  });

  it('the old example fails the check, the new one passes', () => {
    expect(parseHuTaxNumber('12345678-1-23').ok).toBe(false);
    expect(parseHuTaxNumber('12345676-1-23').ok).toBe(true);
  });
});
