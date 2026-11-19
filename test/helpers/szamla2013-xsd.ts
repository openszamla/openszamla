/**
 * Validates XML against the XSD of the 23/2014. (VI. 30.) NGM rendelet 3. melléklet
 * (vendor/ngm-23-2014/szamla-2013.xsd, namespace http://schemas.nav.gov.hu/2013/szamla, root <szamlak>)
 * with libxml2 compiled to WebAssembly (xmllint-wasm) – no native tools needed.
 *
 * The schema is a single self-contained file (no imports), so it is passed to xmllint as is.
 */
import { readFileSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';
import type { XsdResult } from './nav-xsd.ts';

export type { XsdResult };

export const SZAMLA2013_XSD = new URL('../../vendor/ngm-23-2014/szamla-2013.xsd', import.meta.url);

let schemaText: string | null = null;

function schema(): string {
  schemaText ??= readFileSync(SZAMLA2013_XSD, 'utf8');
  return schemaText;
}

export async function validateSzamla2013Xml(xml: string): Promise<XsdResult> {
  const result = await validateXML({
    xml: [{ fileName: 'szamlak.xml', contents: xml }],
    schema: [{ fileName: 'szamla-2013.xsd', contents: schema() }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}
