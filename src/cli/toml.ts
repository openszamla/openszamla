/**
 * Just enough TOML for the Codex configuration (`openszamla config codex --write`, `openszamla doctor`), without a
 * TOML dependency: the document is split into statements (table headers and key/value pairs, a value may span
 * lines), so it can be told where a table such as `mcp_servers.openszamla` is defined – as a [table], [subtables],
 * dotted keys or an inline table –, the string, string-array and inline-table values of its keys can be read, and
 * the table can be dropped together with its subtables. Anything that cannot be read reliably is reported as such
 * (null / ok: false), never guessed.
 */

export interface TomlStatement {
  /** First and last line (0-based, inclusive). */
  start: number;
  end: number;
  kind: 'table' | 'array-table' | 'key' | 'other';
  /** Header path of a [table] / [[array table]], or the dotted key of a key/value pair; null when unreadable. */
  path: string[] | null;
  /** The table a key/value pair belongs to ([] = the root table). */
  table: string[];
  /** Value text of a key/value pair (may span lines). */
  value?: string;
}

const BARE = /[A-Za-z0-9_-]/;

/** A single-line basic string ("…") starting at `i`: its value and the index after the closing quote; null when invalid. */
function readBasic(s: string, i: number): { value: string; end: number } | null {
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j] as string;
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++j];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\u001b' };
    if (e !== undefined && simple[e] !== undefined) {
      out += simple[e];
      continue;
    }
    const len = e === 'u' ? 4 : e === 'U' ? 8 : e === 'x' ? 2 : 0;
    const hex = s.slice(j + 1, j + 1 + len);
    if (!len || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) return null;
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    j += len;
  }
  return null;
}

/** A dotted key (`a."b c".'d'`) as its parts; null when the text is not one. */
export function parseDottedKey(text: string): string[] | null {
  const s = text.trim();
  const parts: string[] = [];
  let i = 0;
  const skip = (): void => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  for (;;) {
    skip();
    if (s[i] === '"') {
      const r = readBasic(s, i);
      if (!r) return null;
      parts.push(r.value);
      i = r.end;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const from = i;
      while (i < s.length && BARE.test(s[i] as string)) i++;
      if (i === from) return null;
      parts.push(s.slice(from, i));
    }
    skip();
    if (i >= s.length) return parts;
    if (s[i] !== '.') return null;
    i++;
  }
}

interface ScanState {
  /** Inside a multi-line string with this delimiter. */
  ml: '"""' | "'''" | null;
  /** Open [ and { of the value. */
  depth: number;
}

/** Follows strings, comments and brackets through `text`, updating `state`. */
function scan(text: string, state: ScanState): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state.ml) {
      if (state.ml === '"""' && c === '\\') i++;
      else if (text.startsWith(state.ml, i)) {
        state.ml = null;
        i += 2;
      }
      continue;
    }
    if (c === '#') return;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      state.ml = text.startsWith('"""', i) ? '"""' : "'''";
      i += 2;
    } else if (c === '"') {
      const r = readBasic(text, i);
      i = r ? r.end - 1 : text.length;
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      i = j < 0 ? text.length : j;
    } else if (c === '[' || c === '{') state.depth++;
    else if ((c === ']' || c === '}') && state.depth > 0) state.depth--;
  }
}

/** Index of the first `ch` in `s` outside quotes (from `from`), or -1. */
function indexOutsideQuotes(s: string, ch: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === ch) return i;
    if (c === '"') {
      const r = readBasic(s, i);
      if (!r) return -1;
      i = r.end - 1;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
    }
  }
  return -1;
}

/** Splits a document (its lines) into statements. */
export function tomlStatements(lines: readonly string[]): TomlStatement[] {
  const out: TomlStatement[] = [];
  let table: string[] = [];
  let open: TomlStatement | null = null;
  const state: ScanState = { ml: null, depth: 0 };
  lines.forEach((line, n) => {
    if (open) {
      open.end = n;
      open.value += `\n${line}`;
      scan(line, state);
      if (!state.ml && state.depth === 0) open = null;
      return;
    }
    const t = line.trimStart();
    if (t === '' || t.startsWith('#')) {
      out.push({ start: n, end: n, kind: 'other', path: null, table });
      return;
    }
    if (t.startsWith('[')) {
      const array = t.startsWith('[[');
      const from = array ? 2 : 1;
      const close = indexOutsideQuotes(t, ']', from);
      const path = close < 0 ? null : parseDottedKey(t.slice(from, close));
      table = path ?? ['\u0000unreadable'];
      out.push({ start: n, end: n, kind: array ? 'array-table' : 'table', path, table });
      return;
    }
    const eq = indexOutsideQuotes(line, '=');
    if (eq < 0) {
      out.push({ start: n, end: n, kind: 'other', path: null, table });
      return;
    }
    const value = line.slice(eq + 1);
    const st: TomlStatement = { start: n, end: n, kind: 'key', path: parseDottedKey(line.slice(0, eq)), table, value };
    out.push(st);
    state.ml = null;
    state.depth = 0;
    scan(value, state);
    if (state.ml || state.depth > 0) open = st;
  });
  return out;
}

export type TomlPlain = string | string[] | Record<string, string>;

/** Reads a string, an array of strings or an inline table of strings; ok: false for anything else. */
export function parseTomlValue(text: string): { ok: true; value: TomlPlain } | { ok: false } {
  let i = 0;
  const fail = { ok: false } as const;
  const skip = (): void => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i] as string)) i++;
      if (text[i] !== '#') return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  const str = (): string | null => {
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) return null;
    if (text[i] === '"') {
      const r = readBasic(text, i);
      if (!r) return null;
      i = r.end;
      return r.value;
    }
    if (text[i] === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0 || text.slice(i + 1, j).includes('\n')) return null;
      const v = text.slice(i + 1, j);
      i = j + 1;
      return v;
    }
    return null;
  };
  skip();
  let value: TomlPlain;
  if (text[i] === '[') {
    i++;
    const items: string[] = [];
    for (;;) {
      skip();
      if (text[i] === ']') {
        i++;
        break;
      }
      const s = str();
      if (s === null) return fail;
      items.push(s);
      skip();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') return fail;
    }
    value = items;
  } else if (text[i] === '{') {
    i++;
    const table: Record<string, string> = {};
    for (;;) {
      skip();
      if (text[i] === '}') {
        i++;
        break;
      }
      const eq = indexOutsideQuotes(text, '=', i);
      const key = eq < 0 ? null : parseDottedKey(text.slice(i, eq));
      if (!key || key.length !== 1) return fail;
      i = eq + 1;
      skip();
      const s = str();
      if (s === null) return fail;
      table[key[0] as string] = s;
      skip();
      if (text[i] === ',') i++;
      else if (text[i] !== '}') return fail;
    }
    value = table;
  } else {
    const s = str();
    if (s === null) return fail;
    value = s;
  }
  skip();
  return i >= text.length ? { ok: true, value } : fail;
}

const startsWith = (a: readonly string[], prefix: readonly string[]): boolean => prefix.every((p, i) => a[i] === p);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);

export interface TomlDefinitions {
  /** The [table] header statement, if the table has one. */
  table: TomlStatement | null;
  /** [table.sub] headers below it. */
  subtables: TomlStatement[];
  /** Key/value pairs that define the table or keys of it outside its own header (dotted keys, inline tables). */
  elsewhere: TomlStatement[];
  /** A parent defined inline or as an array of tables (e.g. `mcp_servers = { … }`): a [table] cannot be added below it. */
  closedParent: TomlStatement | null;
}

/** Where the table `path` (e.g. ['mcp_servers', 'openszamla']) is defined in the document. */
export function findTable(stmts: readonly TomlStatement[], path: readonly string[]): TomlDefinitions {
  const d: TomlDefinitions = { table: null, subtables: [], elsewhere: [], closedParent: null };
  for (const s of stmts) {
    if (!s.path) continue;
    if (s.kind === 'table' || s.kind === 'array-table') {
      if (s.kind === 'table' && same(s.path, path)) d.table ??= s;
      else if (startsWith(s.path, path)) d.subtables.push(s);
      else if (s.kind === 'array-table' && s.path.length < path.length && startsWith(path, s.path)) d.closedParent ??= s;
      continue;
    }
    if (s.kind !== 'key') continue;
    const full = [...s.table, ...s.path];
    if (startsWith(full, path) && !startsWith(s.table, path)) d.elsewhere.push(s);
    else if (full.length < path.length && startsWith(path, full)) d.closedParent ??= s;
  }
  return d;
}

/** The key/value pairs directly in the table `path` (its own header section), by key. */
export function tableValues(stmts: readonly TomlStatement[], path: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of stmts) {
    if (s.kind === 'key' && s.path?.length === 1 && same(s.table, path) && s.value !== undefined) m.set(s.path[0] as string, s.value);
  }
  return m;
}

/**
 * The lines without the [table] `path`, its [subtables] and – directly above the header – the `marker` comment
 * line, each section up to the next table header. A blank line doubled by the removal is dropped; the rest of the
 * document stays as it is.
 */
export function removeTable(lines: readonly string[], stmts: readonly TomlStatement[], path: readonly string[], marker?: RegExp): string[] {
  const d = findTable(stmts, path);
  const headers = stmts.filter((s) => s.kind === 'table' || s.kind === 'array-table');
  const drop = new Set<number>();
  for (const h of [d.table, ...d.subtables]) {
    if (!h) continue;
    const next = headers.find((x) => x.start > h.start);
    let end = next ? next.start - 1 : lines.length - 1;
    // Comment lines just above the next header belong to that header.
    while (end > h.start && next && /^\s*#/.test(lines[end] ?? '')) end--;
    for (let n = h.start; n <= end; n++) drop.add(n);
    if (h === d.table && marker) {
      let above = h.start - 1;
      while (above >= 0 && (lines[above] ?? '').trim() === '') above--;
      if (above >= 0 && marker.test(lines[above] ?? '')) for (let n = above; n < h.start; n++) drop.add(n);
    }
  }
  const kept: string[] = [];
  let afterDrop = false;
  lines.forEach((l, n) => {
    if (drop.has(n)) {
      afterDrop = true;
      return;
    }
    const blank = l.trim() === '';
    if (!(afterDrop && blank && (kept.length === 0 || (kept[kept.length - 1] ?? '').trim() === ''))) kept.push(l);
    afterDrop = false;
  });
  return kept;
}
