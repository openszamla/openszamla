/**
 * The small TOML reader behind `config codex --write` and `doctor` (src/cli/toml.ts): where a table is defined (also
 * as dotted keys or inline), what its keys hold, and removing it with its subtables – without being fooled by strings,
 * comments or multi-line values that look like headers.
 */
import { describe, expect, it } from 'vitest';
import { findTable, parseDottedKey, parseTomlValue, removeTable, tableValues, tomlStatements } from '../../src/cli/toml.ts';

const PATH = ['mcp_servers', 'openszamla'];
const lines = (s: string): string[] => s.split('\n');

describe('dotted keys and values', () => {
  it('reads bare, quoted and literal key parts', () => {
    expect(parseDottedKey('mcp_servers.openszamla')).toEqual(PATH);
    expect(parseDottedKey(' mcp_servers . "openszamla" ')).toEqual(PATH);
    expect(parseDottedKey("mcp_servers.'open szamla'")).toEqual(['mcp_servers', 'open szamla']);
    expect(parseDottedKey('1, 2')).toBeNull();
    expect(parseDottedKey('')).toBeNull();
  });

  it('reads strings, string arrays (multi-line, trailing comma, comments) and inline tables of strings', () => {
    expect(parseTomlValue(" 'C:\\Program Files\\nodejs\\node.exe' ")).toEqual({ ok: true, value: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(parseTomlValue(' "C:\\\\Users\\\\Anna \\u00e1" # comment')).toEqual({ ok: true, value: 'C:\\Users\\Anna á' });
    expect(parseTomlValue(" [\n  'a', # first\n  \"b\",\n]")).toEqual({ ok: true, value: ['a', 'b'] });
    expect(parseTomlValue(" { OPENSZAMLA_HOME = 'D:\\x', \"B\" = \"y\" }")).toEqual({ ok: true, value: { OPENSZAMLA_HOME: 'D:\\x', B: 'y' } });
    expect(parseTomlValue(' 30')).toEqual({ ok: false });
    expect(parseTomlValue(' "C:\\Users"')).toEqual({ ok: false }); // \U needs 8 hex digits: invalid TOML
    expect(parseTomlValue(" '''multi'''")).toEqual({ ok: false });
  });
});

describe('finding the table', () => {
  it('a [table] with [subtables]; its keys', () => {
    const doc = lines("[mcp_servers.openszamla]\ncommand = 'node'\nargs = ['x', 'mcp']\n\n[mcp_servers.openszamla.env]\nOPENSZAMLA_HOME = 'D:\\a'\n[other]\nk = 1");
    const st = tomlStatements(doc);
    const d = findTable(st, PATH);
    expect(d.table?.start).toBe(0);
    expect(d.subtables.map((s) => s.start)).toEqual([4]);
    expect(d.elsewhere).toEqual([]);
    expect(d.closedParent).toBeNull();
    expect([...tableValues(st, PATH).keys()]).toEqual(['command', 'args']);
    expect([...tableValues(st, [...PATH, 'env']).entries()]).toEqual([['OPENSZAMLA_HOME', " 'D:\\a'"]]);
  });

  it('dotted keys at the root or under [mcp_servers], and an inline mcp_servers table', () => {
    expect(findTable(tomlStatements(['mcp_servers.openszamla.command = "x"']), PATH).elsewhere).toHaveLength(1);
    expect(findTable(tomlStatements(['[mcp_servers]', 'openszamla = { command = "x" }']), PATH).elsewhere).toHaveLength(1);
    expect(findTable(tomlStatements(['mcp_servers = { other = { command = "x" } }']), PATH).closedParent?.start).toBe(0);
    expect(findTable(tomlStatements(['[[mcp_servers]]', 'name = "x"']), PATH).closedParent?.start).toBe(0);
    // A sibling table is no definition of it.
    const sibling = findTable(tomlStatements(['[mcp_servers.openszamla2]', 'command = "x"']), PATH);
    expect(sibling.table).toBeNull();
    expect(sibling.subtables).toEqual([]);
  });

  it('header-like lines inside multi-line strings and arrays, and in comments, are not headers', () => {
    const doc = lines([
      'notes = """',
      '[mcp_servers.openszamla]',
      '"""',
      "literal = '''",
      '[mcp_servers.openszamla]',
      "'''",
      'matrix = [',
      '  [1, 2],',
      '  [mcp_servers.openszamla]',
      ']',
      '# [mcp_servers.openszamla]',
      'url = "http://x/[mcp_servers.openszamla]"',
    ].join('\n'));
    const d = findTable(tomlStatements(doc), PATH);
    expect(d.table).toBeNull();
    expect(d.subtables).toEqual([]);
    expect(d.elsewhere).toEqual([]);
  });
});

describe('removing the table', () => {
  it('drops the table, its subtables and the marker comment; keeps comments that belong to the next table', () => {
    const doc = lines([
      'model = "x"',
      '',
      '# OpenSzámla – openszamla config codex --write, 2026-11-01',
      '[mcp_servers.openszamla]',
      "command = 'a'",
      '',
      '[mcp_servers.openszamla.tools.invoice_issue]',
      'approval_mode = "prompt"',
      '',
      '# keep me',
      '[mcp_servers.other]',
      'command = "o"',
    ].join('\n'));
    const out = removeTable(doc, tomlStatements(doc), PATH, /^\s*#\s*OpenSzámla – openszamla config codex --write/);
    expect(out).toEqual(['model = "x"', '', '# keep me', '[mcp_servers.other]', 'command = "o"']);
  });
});
