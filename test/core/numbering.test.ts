/** Invoice number patterns: NAV invoiceNumber rules (≤ 50 chars, no surrounding whitespace, unique). */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { DEFAULT_INVOICE_PATTERN, DEFAULT_PROFORMA_PATTERN, formatNumber, patternsOverlap, validatePattern } from '../../src/core/numbering.ts';
import { int, mulberry32, pick } from './gen.ts';

const codes = (pattern: string, yearlyReset = false): string[] => validatePattern(pattern, yearlyReset).map((i) => i.code);

function appErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_APP_ERROR';
  }
}

describe('formatNumber', () => {
  it('default patterns', () => {
    expect(formatNumber(DEFAULT_INVOICE_PATTERN, 42, 2026)).toBe('SZ-2026-00042');
    expect(formatNumber(DEFAULT_PROFORMA_PATTERN, 1, 2027)).toBe('DB-2027-00001');
    expect(validatePattern(DEFAULT_INVOICE_PATTERN, true)).toEqual([]);
    expect(validatePattern(DEFAULT_PROFORMA_PATTERN, true)).toEqual([]);
  });

  it('tokens', () => {
    expect(formatNumber('A{YY}/{SEQ:3}', 7, 2005)).toBe('A05/007');
    expect(formatNumber('{SEQ}', 1, 2026)).toBe('1');
    expect(formatNumber('{SEQ:3}', 12345, 2026)).toBe('12345'); // padding never truncates
    expect(formatNumber('{SEQ:05}', 3, 2026)).toBe('00003');
    expect(formatNumber('{YYYY}{SEQ:10}', 9_999_999_999, 2026)).toBe('20269999999999');
    expect(formatNumber('x.y_z/{YYYY}-{SEQ}', 9, 2026)).toBe('x.y_z/2026-9');
  });

  it('rejects invalid input with AppError codes', () => {
    expect(appErrorCode(() => formatNumber('SZ {SEQ}', 1, 2026))).toBe('INVALID_SERIES_PATTERN');
    for (const seq of [0, -1, 1.5, Number.NaN, 10_000_000_000, Number.MAX_SAFE_INTEGER + 2]) {
      expect(appErrorCode(() => formatNumber(DEFAULT_INVOICE_PATTERN, seq, 2026)), String(seq)).toBe('INVALID_SEQUENCE');
    }
    for (const year of [999, 10000, 2026.5, Number.NaN]) {
      expect(appErrorCode(() => formatNumber(DEFAULT_INVOICE_PATTERN, 1, year)), String(year)).toBe('INVALID_YEAR');
    }
  });
});

describe('validatePattern', () => {
  it('edge cases', () => {
    expect(codes('')).toEqual(['PATTERN_EMPTY']);
    expect(codes('   ')).toEqual(['PATTERN_EMPTY']);
    expect(codes('SZ-{YYYY}')).toEqual(['PATTERN_SEQ_MISSING']);
    expect(codes('{SEQ}-{SEQ:2}')).toEqual(['PATTERN_SEQ_DUPLICATE']);
    expect(codes('SZ {SEQ}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes(' SZ-{SEQ}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('SZ-{SEQ}\n')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('É-{SEQ}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('🧾-{SEQ}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('SZ-{seq}')).toEqual(['PATTERN_UNKNOWN_TOKEN', 'PATTERN_SEQ_MISSING']);
    expect(codes('SZ-{SEQ:0}')).toEqual(['PATTERN_SEQ_PADDING_INVALID']);
    expect(codes('SZ-{SEQ:11}')).toEqual(['PATTERN_SEQ_PADDING_INVALID']);
    expect(codes('SZ-{SEQ:}')).toEqual(['PATTERN_UNKNOWN_TOKEN', 'PATTERN_SEQ_MISSING']);
    expect(codes('SZ-{SEQ')).toEqual(['PATTERN_INVALID_CHARACTER', 'PATTERN_SEQ_MISSING']);
    expect(codes('SZ-{SEQ}}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('SZ-{{SEQ}}')).toEqual(['PATTERN_INVALID_CHARACTER']);
    expect(codes('SZ-{SEQ}', true)).toEqual(['PATTERN_YEAR_REQUIRED']);
    expect(codes('SZ-{YY}-{SEQ}', true)).toEqual([]);
    expect(codes(null as unknown as string)).toEqual(['PATTERN_EMPTY']);
  });

  it('the longest possible number must fit NAV invoiceNumber (50 characters, SEQ up to 10 digits)', () => {
    expect(codes(`${'X'.repeat(40)}{SEQ}`)).toEqual([]);
    expect(codes(`${'X'.repeat(41)}{SEQ}`)).toEqual(['PATTERN_TOO_LONG']);
    expect(codes(`${'X'.repeat(36)}{YYYY}{SEQ}`)).toEqual([]);
    expect(codes(`${'X'.repeat(37)}{YYYY}{SEQ}`)).toEqual(['PATTERN_TOO_LONG']);
    expect(formatNumber(`${'X'.repeat(36)}{YYYY}{SEQ}`, 9_999_999_999, 2026)).toHaveLength(50);
  });
});

describe('property: every valid pattern gives NAV-valid, unique numbers', () => {
  const PIECES = ['SZ', '-', '/', '_', '.', 'A', 'inv', '2026', '{YYYY}', '{YY}'];
  const rnd = mulberry32(42);
  const patterns: string[] = [];
  while (patterns.length < 300) {
    const parts = Array.from({ length: int(rnd, 0, 5) }, () => pick(rnd, PIECES));
    parts.splice(int(rnd, 0, parts.length), 0, pick(rnd, ['{SEQ}', `{SEQ:${int(rnd, 1, 10)}}`]));
    const p = parts.join('');
    if (validatePattern(p, false).length === 0) patterns.push(p);
  }

  it('≤ 50 characters, allowed characters only, no surrounding whitespace', () => {
    for (const p of patterns) {
      for (const seq of [1, 9, 10, 99_999, 9_999_999_999]) {
        for (const year of [2000, 2026, 2099]) {
          const n = formatNumber(p, seq, year);
          expect(n.length, p).toBeLessThanOrEqual(50);
          expect(n, p).toMatch(/^[A-Za-z0-9\-/_.]+$/);
          expect(n.trim(), p).toBe(n);
        }
      }
    }
  });

  it('distinct sequence values never collide within a year', () => {
    for (const p of patterns) {
      const seen = new Set<string>();
      for (let seq = 1; seq <= 1200; seq++) seen.add(formatNumber(p, seq, 2026));
      expect(seen.size, p).toBe(1200);
    }
  });

  it('with yearly reset, (year, seq) pairs never collide across years', () => {
    for (const p of patterns.filter((x) => validatePattern(x, true).length === 0)) {
      const seen = new Set<string>();
      for (const year of [2025, 2026, 2027]) for (let seq = 1; seq <= 120; seq++) seen.add(formatNumber(p, seq, year));
      expect(seen.size, p).toBe(360);
    }
  });
});

describe('patternsOverlap (invoice numbers are unique across all series)', () => {
  it.each([
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-{YYYY}-{SEQ:5}', true],
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-{YYYY}-0{SEQ:4}', true],
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-{YYYY}-1{SEQ:5}', true],
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-2026-{SEQ:5}', true],
    ['SZ-{YYYY}-{SEQ:5}', 'sz-{YYYY}-{SEQ:5}', true],
    ['{SEQ:2}', '0{SEQ}', true],
    ['SZ-{YYYY}-{SEQ:5}', 'WEB-{YYYY}-{SEQ:5}', false],
    ['SZ-{YYYY}-{SEQ:5}', DEFAULT_PROFORMA_PATTERN, false],
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-{YY}-{SEQ:5}', false],
    ['SZ-{YYYY}-{SEQ:5}', 'SZ-{YYYY}-A{SEQ:5}', false],
    ['{SEQ}', '0{SEQ}', false],
    ['SZ/{YYYY}/{SEQ}', 'SZ_{YYYY}_{SEQ}', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });

  it('agrees with brute force on generated pattern pairs', () => {
    const rnd = mulberry32(7);
    const parts = ['SZ', 'A', '-', '/', '0', '1', '{YYYY}', '{YY}'];
    const make = (): string => {
      const pre = Array.from({ length: int(rnd, 0, 3) }, () => pick(rnd, parts)).join('');
      const post = Array.from({ length: int(rnd, 0, 2) }, () => pick(rnd, parts)).join('');
      return `${pre}${pick(rnd, ['{SEQ}', '{SEQ:1}', '{SEQ:2}', '{SEQ:3}'])}${post}`;
    };
    for (let n = 0; n < 150; n++) {
      const a = make();
      const b = make();
      const numbersOf = (p: string): Set<string> => {
        const out = new Set<string>();
        for (const year of [2026, 2099]) for (let seq = 1; seq <= 1200; seq++) out.add(formatNumber(p, seq, year).toUpperCase());
        return out;
      };
      const na = numbersOf(a);
      const common = [...numbersOf(b)].some((x) => na.has(x));
      // Brute force only sees small sequences and two years: when it finds a common number, the check must too.
      if (common) expect(patternsOverlap(a, b), `${a} / ${b}`).toBe(true);
    }
  });
});
