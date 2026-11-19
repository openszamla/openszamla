import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { el, escapeXmlAttr, escapeXmlText, leaf, normalizeXmlText, opt, serializeXml, stripInvalidXmlChars } from '../../src/nav/xml.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: false, ignoreDeclaration: true });

describe('XML writer', () => {
  it('escapes & < > " \' in text and attributes', () => {
    expect(escapeXmlText(`Kft & Tsa <"Bt"> 'x'`)).toBe('Kft &amp; Tsa &lt;&quot;Bt&quot;&gt; &apos;x&apos;');
    expect(escapeXmlAttr('a"b\'c&d<e>\tf\ng\rh')).toBe('a&quot;b&apos;c&amp;d&lt;e&gt;&#9;f&#10;g&#13;h');
  });

  it('does not double-escape and round-trips through a parser', () => {
    const value = `Tom & Jerry <kft> "idézet" 'aposztróf' &amp; Ő`;
    const xml = serializeXml(el('root', [leaf('a', value, { note: value })]));
    const parsed = parser.parse(xml) as { root: { a: { '#text': string; '@_note': string } } };
    expect(parsed.root.a['#text']).toBe(value);
    expect(parsed.root.a['@_note']).toBe(value);
  });

  it('drops characters that are invalid in XML 1.0', () => {
    expect(stripInvalidXmlChars('a\u0000b\u0008c\u000Bd￾e\uD800f😀g')).toBe('abcdef😀g');
  });

  it('keeps element order, skips empty optional children, flattens nested lists', () => {
    const xml = serializeXml(
      el('r', [leaf('a', 1), null, undefined, false, opt('b', ''), opt('c', null), [leaf('d', true), [leaf('e', 'x')]], opt('f', 0)]),
      { declaration: false, pretty: false },
    );
    expect(xml).toBe('<r><a>1</a><d>true</d><e>x</e><f>0</f></r>');
  });

  it('writes the XML declaration and indentation by default', () => {
    const xml = serializeXml(el('r', [leaf('a', 'x')]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<r>\n  <a>x</a>\n</r>')).toBe(true);
  });

  it('writes empty containers as self-closing elements and namespace attributes in order', () => {
    expect(serializeXml(el('p:r', [], { 'xmlns:p': 'urn:x', xmlns: 'urn:y', skipped: null }), { declaration: false, pretty: false })).toBe(
      '<p:r xmlns:p="urn:x" xmlns="urn:y"/>',
    );
  });

  it('rejects invalid element / attribute names (no injection through names)', () => {
    expect(() => el('a b')).toThrow();
    expect(() => leaf('a><b', 'x')).toThrow();
    expect(() => leaf('a', 'x', { 'x="1" y': 'z' })).toThrow();
  });

  it('normalizeXmlText: newlines/tabs → space, trims, truncates by code points, blank → null', () => {
    expect(normalizeXmlText('  első sor\r\n\tmásodik sor  ', 100)).toBe('első sor második sor');
    expect(normalizeXmlText('   \n ', 10)).toBeNull();
    expect(normalizeXmlText(undefined, 10)).toBeNull();
    expect(normalizeXmlText('😀😀😀😀', 3)).toBe('😀😀😀');
    expect(normalizeXmlText('abc def', 4)).toBe('abc');
  });
});
