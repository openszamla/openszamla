/**
 * Validates XML against the official NAV Online Számla v3.0 XSDs (vendor/nav-online-invoice/schemas)
 * with libxml2 compiled to WebAssembly (xmllint-wasm) – no native tools needed.
 *
 * The NAV schemas use <xs:import namespace="…"/> without schemaLocation (they rely on an XML catalog),
 * so we add the schemaLocation attributes in memory before handing the files to xmllint.
 */
import { readFileSync } from 'node:fs';
import { memoryPages, validateXML } from 'xmllint-wasm';

const SCHEMA_DIR = new URL('../../vendor/nav-online-invoice/schemas/', import.meta.url);

const LOCATIONS: Record<string, string> = {
  'http://schemas.nav.gov.hu/NTCA/1.0/common': 'common.xsd',
  'http://schemas.nav.gov.hu/OSA/3.0/base': 'invoiceBase.xsd',
  'http://schemas.nav.gov.hu/OSA/3.0/data': 'invoiceData.xsd',
};

function loadSchema(fileName: string): { fileName: string; contents: string } {
  const raw = readFileSync(new URL(fileName, SCHEMA_DIR), 'utf8');
  const contents = raw.replace(/<xs:import namespace="([^"]+)"\s*\/>/g, (whole, ns: string) => {
    const loc = LOCATIONS[ns];
    return loc ? `<xs:import namespace="${ns}" schemaLocation="${loc}"/>` : whole;
  });
  return { fileName, contents };
}

export type NavSchemaKind = 'data' | 'api' | 'annul';

const MAIN: Record<NavSchemaKind, string> = {
  data: 'invoiceData.xsd',
  api: 'invoiceApi.xsd',
  annul: 'invoiceAnnulment.xsd',
};

export interface XsdResult {
  valid: boolean;
  errors: string[];
}

export async function validateNavXml(xml: string, kind: NavSchemaKind = 'data'): Promise<XsdResult> {
  const main = MAIN[kind];
  const preload = ['common.xsd', 'invoiceBase.xsd', 'invoiceData.xsd']
    .filter((f) => f !== main)
    .map(loadSchema);
  const result = await validateXML({
    xml: [{ fileName: 'document.xml', contents: xml }],
    schema: [loadSchema(main)],
    preload,
    // The default 32 MiB of WebAssembly memory is not enough for the DOM of a report of several MB
    // (NAV accepts up to 15 MB per invoice).
    ...(xml.length > 1_000_000 ? { maxMemoryPages: memoryPages.GiB } : {}),
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}
