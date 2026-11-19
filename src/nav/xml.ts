/**
 * Minimal XML writer used for every document we send to NAV (invoiceData and the API requests).
 *
 * Why hand-written: the NAV schemas are strict `xs:sequence`s, so element ORDER must be explicit and
 * reviewable in code. Elements are built as a small immutable tree (`el`, `leaf`, `opt`) and then
 * serialised with correct escaping. `null` / `undefined` / `false` children are skipped, which makes
 * optional elements concise. fast-xml-parser is only used for parsing responses.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly children: readonly XmlElement[];
  /** Text content of a leaf element (null for container elements). */
  readonly text: string | null;
}

/** A child slot: an element, nothing (skipped) or a nested list of children. */
export type XmlChild = XmlElement | null | undefined | false | readonly XmlChild[];

export type XmlAttrs = Readonly<Record<string, string | null | undefined>>;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

/** Characters that are not allowed anywhere in an XML 1.0 document (C0 controls, lone surrogates, U+FFFE/FFFF). */
// Built from a string: the TypeScript regex checker rejects the (valid) `u`-mode literal.
const INVALID_XML_CHARS = new RegExp('[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]', 'gu');

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid XML name: ${JSON.stringify(name)}`);
}

/** Removes characters that cannot be represented in XML 1.0 at all. */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(INVALID_XML_CHARS, '');
}

/**
 * Normalises free text for NAV's SimpleTextNNNotBlankType family: control whitespace (newline,
 * tab …) becomes a space (the XSD pattern `.*[^\s].*` cannot match line breaks), characters that are
 * invalid in XML are dropped, the value is trimmed and cut to `maxLen` characters (code points, as
 * XSD counts them). Blank → null.
 */
export function normalizeXmlText(value: string | null | undefined, maxLen: number): string | null {
  if (value === null || value === undefined) return null;
  let s = stripInvalidXmlChars(String(value).replace(/[\t\n\r\f\v]+/g, ' ')).trim();
  if (!s) return null;
  const cps = Array.from(s);
  if (cps.length > maxLen) s = cps.slice(0, maxLen).join('').trimEnd();
  return s || null;
}

/** Escapes text content: & < > " ' (quotes too, so the output is safe in any context) and CR. */
export function escapeXmlText(text: string): string {
  return stripInvalidXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;');
}

/** Escapes an attribute value; tab/newline/CR are written as character references (attribute normalisation). */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}

function flatten(children: readonly XmlChild[], out: XmlElement[]): XmlElement[] {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) flatten(c as readonly XmlChild[], out);
    else out.push(c as XmlElement);
  }
  return out;
}

function attrList(attrs: XmlAttrs | undefined): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    assertName(k);
    out.push([k, v]);
  }
  return out;
}

/** Container element; children are emitted in the given order, empty slots are skipped. */
export function el(name: string, children: XmlChild = [], attrs?: XmlAttrs): XmlElement {
  assertName(name);
  const list = Array.isArray(children) ? (children as readonly XmlChild[]) : [children as XmlChild];
  return { name, attrs: attrList(attrs), children: flatten(list, []), text: null };
}

/** Leaf element with text content (booleans/numbers are stringified). */
export function leaf(name: string, value: string | number | boolean, attrs?: XmlAttrs): XmlElement {
  assertName(name);
  return { name, attrs: attrList(attrs), children: [], text: String(value) };
}

/** Optional leaf: null/undefined/'' → no element. */
export function opt(name: string, value: string | number | boolean | null | undefined, attrs?: XmlAttrs): XmlElement | null {
  if (value === null || value === undefined || value === '') return null;
  return leaf(name, value, attrs);
}

export interface SerializeOptions {
  /** Prepend `<?xml version="1.0" encoding="UTF-8"?>` (default true). */
  declaration?: boolean;
  /** Indent with two spaces and newlines (default true). Safe because we never write mixed content. */
  pretty?: boolean;
}

/** Serialises the tree. Leaves with empty text are written as `<a></a>`. */
export function serializeXml(root: XmlElement, opts: SerializeOptions = {}): string {
  const pretty = opts.pretty ?? true;
  const parts: string[] = [];
  if (opts.declaration ?? true) parts.push('<?xml version="1.0" encoding="UTF-8"?>', pretty ? '\n' : '');
  const write = (node: XmlElement, depth: number): void => {
    const pad = pretty ? '  '.repeat(depth) : '';
    const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join('');
    if (node.text !== null) {
      parts.push(`${pad}<${node.name}${attrs}>${escapeXmlText(node.text)}</${node.name}>`, pretty ? '\n' : '');
      return;
    }
    if (node.children.length === 0) {
      parts.push(`${pad}<${node.name}${attrs}/>`, pretty ? '\n' : '');
      return;
    }
    parts.push(`${pad}<${node.name}${attrs}>`, pretty ? '\n' : '');
    for (const c of node.children) write(c, depth + 1);
    parts.push(`${pad}</${node.name}>`, pretty ? '\n' : '');
  };
  write(root, 0);
  return parts.join('');
}
