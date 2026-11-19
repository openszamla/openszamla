/**
 * Invoice number patterns ("sorszám").
 * CONTRACT FILE – keep the signatures.
 *
 * Pattern tokens: {YYYY} (4-digit year of the issue date), {YY} (2-digit year), {SEQ} (sequence),
 * {SEQ:n} (sequence zero-padded to n digits, 1 ≤ n ≤ 10). Every other character is literal and must
 * be one of A–Z a–z 0–9 - / _ . (NAV invoiceNumber is SimpleText50NotBlankType: max 50 chars).
 * A pattern must contain exactly one {SEQ…} token. yearlyReset requires {YYYY} or {YY}.
 *
 * Length guarantee: the longest number a pattern can produce is computed with the largest
 * supported sequence (MAX_SEQ = 9 999 999 999, 10 digits) and must fit NAV's 50 characters. As
 * whitespace is not an allowed literal, a number can never start or end with whitespace
 * (NAV ERROR INVALID_INVOICE_NUMBER).
 */
import { AppError } from './errors.ts';
import type { ValidationIssue } from './types.ts';

export const DEFAULT_INVOICE_PATTERN = 'SZ-{YYYY}-{SEQ:5}';
export const DEFAULT_PROFORMA_PATTERN = 'DB-{YYYY}-{SEQ:5}';

/** NAV invoiceNumber: SimpleText50NotBlankType. */
const MAX_NUMBER_LENGTH = 50;
/** Largest supported sequence value (10 digits). */
const MAX_SEQ = 9_999_999_999;
const MAX_SEQ_DIGITS = 10;

type Token = { kind: 'literal'; text: string } | { kind: 'YYYY' } | { kind: 'YY' } | { kind: 'SEQ'; pad: number };

interface Parsed {
  tokens: Token[];
  issues: ValidationIssue[];
}

function err(code: string, message: string): ValidationIssue {
  return { severity: 'error', code, message, field: 'pattern' };
}

const LITERAL_RE = /^[A-Za-z0-9\-/_.]$/;
const HINT = 'Példa: "SZ-{YYYY}-{SEQ:5}" → SZ-2026-00001.';

function parse(pattern: string): Parsed {
  const tokens: Token[] = [];
  const issues: ValidationIssue[] = [];
  const badChars = new Set<string>();
  const unknown: string[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal) tokens.push({ kind: 'literal', text: literal });
    literal = '';
  };
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === '{') {
      const close = chars.indexOf('}', i + 1);
      const open = chars.indexOf('{', i + 1);
      if (close === -1 || (open !== -1 && open < close)) {
        badChars.add('{');
        continue;
      }
      const name = chars.slice(i + 1, close).join('');
      i = close;
      if (name === 'YYYY') {
        flush();
        tokens.push({ kind: 'YYYY' });
      } else if (name === 'YY') {
        flush();
        tokens.push({ kind: 'YY' });
      } else if (name === 'SEQ') {
        flush();
        tokens.push({ kind: 'SEQ', pad: 0 });
      } else if (/^SEQ:\d{1,2}$/.test(name)) {
        const pad = Number(name.slice(4));
        if (pad < 1 || pad > MAX_SEQ_DIGITS) {
          issues.push(err('PATTERN_SEQ_PADDING_INVALID', `A {SEQ:n} tokenben n értéke 1 és ${MAX_SEQ_DIGITS} között lehet (megadva: ${pad}). ${HINT}`));
        }
        flush();
        tokens.push({ kind: 'SEQ', pad });
      } else {
        unknown.push(`{${name}}`);
      }
      continue;
    }
    if (LITERAL_RE.test(c)) literal += c;
    else badChars.add(c === ' ' ? 'szóköz' : c);
  }
  flush();
  if (unknown.length) {
    issues.push(err('PATTERN_UNKNOWN_TOKEN', `Ismeretlen token a mintában: ${unknown.join(', ')}. Használható: {YYYY}, {YY}, {SEQ}, {SEQ:n}. ${HINT}`));
  }
  if (badChars.size) {
    issues.push(
      err(
        'PATTERN_INVALID_CHARACTER',
        `Nem megengedett karakter a mintában: ${[...badChars].map((c) => `"${c}"`).join(', ')}. A tokeneken kívül csak A–Z, a–z, 0–9 és a - / _ . karakterek használhatók (szóköz és ékezet sem). ${HINT}`,
      ),
    );
  }
  return { tokens, issues };
}

/** Longest number the tokens can produce (SEQ at its maximum of 10 digits). */
function maxLength(tokens: Token[]): number {
  let n = 0;
  for (const t of tokens) {
    if (t.kind === 'literal') n += Array.from(t.text).length;
    else if (t.kind === 'YYYY') n += 4;
    else if (t.kind === 'YY') n += 2;
    else n += Math.max(t.pad, MAX_SEQ_DIGITS);
  }
  return n;
}

export function validatePattern(pattern: string, yearlyReset: boolean): ValidationIssue[] {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return [err('PATTERN_EMPTY', `A sorszám-minta nem lehet üres. ${HINT}`)];
  }
  const { tokens, issues } = parse(pattern);
  const seqCount = tokens.filter((t) => t.kind === 'SEQ').length;
  if (seqCount === 0) {
    issues.push(err('PATTERN_SEQ_MISSING', `A mintának pontosan egy {SEQ} vagy {SEQ:n} tokent kell tartalmaznia (ez adja a folyamatos sorszámot). ${HINT}`));
  } else if (seqCount > 1) {
    issues.push(err('PATTERN_SEQ_DUPLICATE', `A minta csak egy {SEQ…} tokent tartalmazhat (most ${seqCount} van). ${HINT}`));
  }
  const hasYear = tokens.some((t) => t.kind === 'YYYY' || t.kind === 'YY');
  if (yearlyReset && !hasYear) {
    issues.push(
      err(
        'PATTERN_YEAR_REQUIRED',
        'Évenkénti újrakezdésnél ({SEQ} 1-ről indul új évben) a mintának tartalmaznia kell az évet ({YYYY} vagy {YY}), különben a sorszámok ismétlődnének. Add hozzá az évet, vagy kapcsold ki az évenkénti újrakezdést.',
      ),
    );
  }
  const max = maxLength(tokens);
  if (max > MAX_NUMBER_LENGTH) {
    issues.push(
      err(
        'PATTERN_TOO_LONG',
        `A mintából képzett sorszám legfeljebb ${MAX_NUMBER_LENGTH} karakter lehet (NAV), de a leghosszabb lehetséges sorszám ${max} karakter (a {SEQ} legfeljebb 10 jegyű). Rövidítsd az állandó részt.`,
      ),
    );
  }
  return issues;
}

/** One character position of a number: a literal character (upper-cased), any digit, or a digit 1–9. */
type CharClass = { kind: 'char'; c: string } | { kind: 'digit'; nonZero: boolean };

const ANY_DIGIT: CharClass = { kind: 'digit', nonZero: false };
const NON_ZERO_DIGIT: CharClass = { kind: 'digit', nonZero: true };

/**
 * Every number a pattern can produce, as fixed-length sequences of character classes – one per possible
 * length of the sequence part (a pattern has exactly one {SEQ…}, so at most 10 sequences). {YYYY} is a
 * 4-digit year (1000–9999), {YY} two digits, {SEQ:n} n digits (zero padded) or more digits without a
 * leading zero, {SEQ} 1–10 digits without a leading zero. Literal letters are compared case-insensitively.
 */
function shapes(tokens: Token[]): CharClass[][] {
  let out: CharClass[][] = [[]];
  for (const t of tokens) {
    let options: CharClass[][];
    if (t.kind === 'literal') options = [Array.from(t.text.toUpperCase(), (c): CharClass => ({ kind: 'char', c }))];
    else if (t.kind === 'YYYY') options = [[NON_ZERO_DIGIT, ANY_DIGIT, ANY_DIGIT, ANY_DIGIT]];
    else if (t.kind === 'YY') options = [[ANY_DIGIT, ANY_DIGIT]];
    else {
      options = [];
      for (let len = Math.max(t.pad, 1); len <= MAX_SEQ_DIGITS; len++) {
        const padded = t.pad > 0 && len === t.pad;
        options.push(Array.from({ length: len }, (_, i) => (i === 0 && !padded ? NON_ZERO_DIGIT : ANY_DIGIT)));
      }
    }
    out = out.flatMap((prefix) => options.map((o) => [...prefix, ...o]));
  }
  return out;
}

function digitMeets(d: { nonZero: boolean }, c: string): boolean {
  return /^[0-9]$/.test(c) && !(d.nonZero && c === '0');
}

function classesMeet(a: CharClass, b: CharClass): boolean {
  if (a.kind === 'char') return b.kind === 'char' ? a.c === b.c : digitMeets(b, a.c);
  return b.kind === 'char' ? digitMeets(a, b.c) : true;
}

/**
 * True when two number patterns can produce the same invoice number (for some sequence values and
 * years), e.g. "SZ-{YYYY}-{SEQ:5}" and "SZ-{YYYY}-0{SEQ:4}". Invoice numbers are unique across all
 * series, so such series would block each other. Letters count case-insensitively (a number differing
 * only in case would also give the same PDF file name on Windows). Invalid patterns never overlap.
 */
export function patternsOverlap(a: string, b: string): boolean {
  if (validatePattern(a, false).length || validatePattern(b, false).length) return false;
  const sb = shapes(parse(b).tokens);
  return shapes(parse(a).tokens).some((x) => sb.some((y) => x.length === y.length && x.every((c, i) => classesMeet(c, y[i] as CharClass))));
}

/** formatNumber("SZ-{YYYY}-{SEQ:5}", 42, 2026) → "SZ-2026-00042". Throws AppError on invalid input. */
export function formatNumber(pattern: string, seq: number, year: number): string {
  const errors = validatePattern(pattern, false).filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new AppError('INVALID_SERIES_PATTERN', `Érvénytelen sorszám-minta ("${String(pattern)}"): ${errors.map((e) => e.message).join(' ')}`, {
      hint: 'Javítsd a sorszámtartomány mintáját.',
      details: { issues: errors },
    });
  }
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new AppError('INVALID_SEQUENCE', `Érvénytelen sorszám: ${String(seq)} (1 és ${MAX_SEQ} közötti egész szám lehet).`, {
      hint: 'A sorozat következő sorszáma pozitív egész szám legyen.',
    });
  }
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new AppError('INVALID_YEAR', `Érvénytelen év a sorszámhoz: ${String(year)} (négyjegyű év kell).`, {
      hint: 'Az év a számla keltének éve, pl. 2026.',
    });
  }
  const { tokens } = parse(pattern);
  let out = '';
  for (const t of tokens) {
    if (t.kind === 'literal') out += t.text;
    else if (t.kind === 'YYYY') out += String(year);
    else if (t.kind === 'YY') out += String(year % 100).padStart(2, '0');
    else out += String(seq).padStart(t.pad, '0');
  }
  // Cannot happen after validatePattern + the MAX_SEQ check; kept as a last line of defence.
  if (Array.from(out).length > MAX_NUMBER_LENGTH || out.trim() !== out || out === '') {
    throw new AppError('INVALID_SERIES_PATTERN', `A képzett sorszám nem felel meg a NAV szabályainak: "${out}".`);
  }
  return out;
}
