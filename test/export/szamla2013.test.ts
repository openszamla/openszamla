import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { dec, toDec } from '../../src/core/decimal.ts';
import { isAppError, type AppError } from '../../src/core/errors.ts';
import type { Invoice, InvoiceLine, SellerProfile, VatCode } from '../../src/core/types.ts';
import {
  buildSzamla2013Export,
  buildSzamla2013Xml,
  selectSzamla2013Invoices,
  splitHuStreetLine,
  SZAMLA2013_NAMESPACE,
  type Szamla2013Export,
  type Szamla2013Meta,
} from '../../src/export/szamla2013.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import {
  ALL_FIXTURES,
  CUSTOMER_DOMESTIC,
  CUSTOMER_PRIVATE,
  INVOICE_DOMESTIC,
  INVOICE_EU_SERVICE,
  INVOICE_PRIVATE_AAM,
  INVOICE_STORNO,
} from '../fixtures/invoices.ts';
import { SZAMLA2013_XSD, validateSzamla2013Xml } from '../helpers/szamla2013-xsd.ts';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  ignoreDeclaration: true,
  isArray: (name) => ['szamla', 'termek_szolgaltatas_tetelek', 'afarovat', 'modosito_szla'].includes(name),
});

/** Value at a dotted path ("szamlak.szamla.0.fejlec.szlatipus"); undefined when absent. */
function get(node: unknown, path: string): unknown {
  let cur: unknown = node;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function list(node: unknown, path: string): unknown[] {
  const v = get(node, path);
  return Array.isArray(v) ? v : [];
}

interface Built extends Szamla2013Export {
  doc: unknown;
}

/** Builds the export, validates it against the 3. melléklet XSD and parses it. */
async function buildValid(invoices: Invoice[], meta: Partial<Szamla2013Meta> = {}): Promise<Built> {
  const result = buildSzamla2013Export(invoices, { exportDate: '2026-10-30', ...meta });
  const xsd = await validateSzamla2013Xml(result.xml);
  expect(xsd.errors).toEqual([]);
  expect(xsd.valid).toBe(true);
  return { ...result, doc: parser.parse(result.xml) as unknown };
}

function appError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (isAppError(e)) return e;
    throw e;
  }
  throw new Error('AppError expected');
}

/** A net-priced line whose HUF amounts equal the amounts (HUF invoices). */
function hufLine(
  lineNo: number,
  description: string,
  quantity: string,
  unit: string,
  unitPrice: string,
  vatCode: VatCode,
  net: string,
  vat: string,
  extra: Partial<InvoiceLine> = {},
): InvoiceLine {
  const gross = toDec(dec(net).plus(vat));
  return {
    lineNo, description, quantity, unit, unitPrice, priceBasis: 'net', vatCode, nature: 'SERVICE', netUnitPrice: unitPrice,
    netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross,
    ...extra,
  };
}

/** HUF totals with one VAT-summary row per code (amounts given explicitly, hand-computed). */
function hufTotals(rows: Array<[VatCode, string, string]>): Invoice['totals'] {
  const byVat = rows.map(([vatCode, net, vat]) => {
    const gross = toDec(dec(net).plus(vat));
    return { vatCode, netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross };
  });
  const net = toDec(byVat.reduce((s, r) => s.plus(r.netAmount), dec(0)));
  const vat = toDec(byVat.reduce((s, r) => s.plus(r.vatAmount), dec(0)));
  const gross = toDec(dec(net).plus(vat));
  return {
    netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross,
    byVat, payableAmount: gross, roundingDifference: '0',
  };
}

// ---------------------------------------------------------------------------------------------
// Additional scenarios (hand-computed, internally consistent)
// ---------------------------------------------------------------------------------------------

/** Modification of INVOICE_DOMESTIC: 2 hours less development (line 1 modified). */
const INVOICE_MODIFICATION: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b1',
  documentType: 'modification',
  number: 'SZ-2026-00005',
  issueDate: '2026-10-29',
  dueDate: '2026-11-06',
  orderNumber: null,
  comment: 'Helyesbítés: 2 órával kevesebb fejlesztés',
  reference: { originalInvoiceId: 'inv_00000000a1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false },
  lines: [
    hufLine(1, 'Szoftverfejlesztés – október (helyesbítés)', '-2', 'óra', '15000', '27', '-30000', '-8100', {
      modifiesLineNo: 1,
      modificationRef: { lineNumberReference: 1, lineOperation: 'MODIFY' },
    }),
  ],
  totals: hufTotals([['27', '-30000', '-8100']]),
  notations: ['Módosító (helyesbítő) számla – az eredeti számla sorszáma: SZ-2026-00001'],
};

/** EUR sale to a domestic business with 27% VAT, MNB rate 390.12 (HUF values rounded to 2 decimals). */
const INVOICE_EUR_DOMESTIC: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b2',
  number: 'SZ-2026-00006',
  dueDate: '2026-11-10',
  currency: 'EUR',
  exchangeRate: '390.12',
  exchangeRateDate: '2026-10-23',
  exchangeRateSource: 'MNB',
  orderNumber: null,
  lines: [
    {
      lineNo: 1, description: 'Szoftverlicenc – 2026. november', quantity: '1', unit: 'db', unitPrice: '100', priceBasis: 'net',
      vatCode: '27', nature: 'SERVICE', netUnitPrice: '100',
      netAmount: '100', vatAmount: '27', grossAmount: '127',
      netAmountHuf: '39012', vatAmountHuf: '10533.24', grossAmountHuf: '49545.24',
    },
    {
      lineNo: 2, description: 'Támogatás', quantity: '1.5', unit: 'óra', unitPrice: '80', priceBasis: 'net',
      vatCode: '27', nature: 'SERVICE', netUnitPrice: '80',
      netAmount: '120', vatAmount: '32.4', grossAmount: '152.4',
      netAmountHuf: '46814.4', vatAmountHuf: '12639.89', grossAmountHuf: '59454.29',
    },
  ],
  totals: {
    netAmount: '220', vatAmount: '59.4', grossAmount: '279.4',
    netAmountHuf: '85826.4', vatAmountHuf: '23173.13', grossAmountHuf: '108999.53',
    byVat: [
      { vatCode: '27', netAmount: '220', vatAmount: '59.4', grossAmount: '279.4', netAmountHuf: '85826.4', vatAmountHuf: '23173.13', grossAmountHuf: '108999.53' },
    ],
    payableAmount: '279.4',
    roundingDifference: '0',
  },
  notations: [],
};

/** Every percentage rate (27/18/5/0 %) plus a tárgyi adómentes line. */
const INVOICE_MULTI_VAT: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b3',
  number: 'SZ-2026-00007',
  orderNumber: null,
  lines: [
    hufLine(1, 'Tanácsadás', '2', 'óra', '20000', '27', '40000', '10800'),
    hufLine(2, 'Szállás', '1', 'éj', '30000', '18', '30000', '5400'),
    hufLine(3, 'Szakkönyv', '3', 'db', '4000', '5', '12000', '600'),
    hufLine(4, 'Vényköteles gyógyszer', '1', 'doboz', '2500', '0', '2500', '0', { nature: 'PRODUCT' }),
    hufLine(5, 'Felnőttképzési tanfolyam', '1', 'alkalom', '15000', 'TAM', '15000', '0', { vatReason: 'Áfa tv. 85. § (1) i) – felnőttképzés' }),
  ],
  totals: hufTotals([
    ['27', '40000', '10800'],
    ['18', '30000', '5400'],
    ['5', '12000', '600'],
    ['0', '2500', '0'],
    ['TAM', '15000', '0'],
  ]),
  notations: ['Áfa tv. 85. § (1) i) – felnőttképzés'],
};

const INVOICE_ADVANCE: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b4',
  documentType: 'advance',
  number: 'SZ-2026-00008',
  issueDate: '2026-10-05',
  fulfillmentDate: '2026-10-05',
  dueDate: '2026-10-05',
  orderNumber: null,
  lines: [hufLine(1, 'Előleg – webáruház fejlesztése', '1', 'db', '100000', '27', '100000', '27000')],
  totals: hufTotals([['27', '100000', '27000']]),
  notations: [],
};

const INVOICE_FINAL: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b5',
  documentType: 'final',
  number: 'SZ-2026-00009',
  issueDate: '2026-10-30',
  fulfillmentDate: '2026-10-30',
  dueDate: '2026-11-07',
  orderNumber: null,
  lines: [
    hufLine(1, 'Webáruház fejlesztése', '1', 'db', '300000', '27', '300000', '81000'),
    hufLine(2, 'Előleg levonása', '-1', 'db', '100000', '27', '-100000', '-27000', {
      advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00008', advancePaymentDate: '2026-10-05', advanceExchangeRate: '1' },
    }),
  ],
  totals: hufTotals([['27', '200000', '54000']]),
  notations: [],
};

/** Storno of INVOICE_ADVANCE: the original is an előlegszámla (reference.originalDocumentType). */
const INVOICE_ADVANCE_STORNO: Invoice = {
  ...INVOICE_ADVANCE,
  id: 'inv_00000000c1',
  documentType: 'storno',
  number: 'SZ-2026-00014',
  issueDate: '2026-10-29',
  dueDate: '2026-10-29',
  reference: { originalInvoiceId: 'inv_00000000b4', originalInvoiceNumber: 'SZ-2026-00008', modificationIndex: 1, modifyWithoutMaster: false, originalDocumentType: 'advance' },
  lines: [
    hufLine(1, 'Előleg – webáruház fejlesztése', '-1', 'db', '100000', '27', '-100000', '-27000', {
      modificationRef: { lineNumberReference: 2, lineOperation: 'CREATE' },
    }),
  ],
  totals: hufTotals([['27', '-100000', '-27000']]),
  notations: ['Érvénytelenítő (sztornó) számla – az eredeti számla sorszáma: SZ-2026-00008'],
};

/** Modification of INVOICE_ADVANCE (the advance was 20 000 Ft lower). */
const INVOICE_ADVANCE_MODIFICATION: Invoice = {
  ...INVOICE_ADVANCE_STORNO,
  id: 'inv_00000000c2',
  documentType: 'modification',
  number: 'SZ-2026-00015',
  lines: [
    hufLine(1, 'Előleg – webáruház fejlesztése (helyesbítés)', '-1', 'db', '20000', '27', '-20000', '-5400', {
      modificationRef: { lineNumberReference: 2, lineOperation: 'CREATE' },
    }),
  ],
  totals: hufTotals([['27', '-20000', '-5400']]),
  notations: ['Módosító számla – az eredeti számla sorszáma: SZ-2026-00008, módosítás sorszáma: 1'],
};

/** Storno of INVOICE_FINAL: every line negated, the advance deduction is reversed too. */
const INVOICE_FINAL_STORNO: Invoice = {
  ...INVOICE_FINAL,
  id: 'inv_00000000c3',
  documentType: 'storno',
  number: 'SZ-2026-00016',
  issueDate: '2026-10-31',
  dueDate: '2026-10-31',
  reference: { originalInvoiceId: 'inv_00000000b5', originalInvoiceNumber: 'SZ-2026-00009', modificationIndex: 1, modifyWithoutMaster: false, originalDocumentType: 'final' },
  lines: [
    hufLine(1, 'Webáruház fejlesztése', '-1', 'db', '300000', '27', '-300000', '-81000', { modificationRef: { lineNumberReference: 3, lineOperation: 'CREATE' } }),
    hufLine(2, 'Előleg levonása', '1', 'db', '100000', '27', '100000', '27000', {
      advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00008', advancePaymentDate: '2026-10-05', advanceExchangeRate: '1' },
      modificationRef: { lineNumberReference: 4, lineOperation: 'CREATE' },
    }),
  ],
  totals: hufTotals([['27', '-200000', '-54000']]),
  notations: ['Érvénytelenítő (sztornó) számla – az eredeti számla sorszáma: SZ-2026-00009'],
};

/** Egyéni vállalkozó, kisadózó, pénzforgalmi elszámolás. */
const SELLER_EV_CASH: SellerProfile = {
  name: 'Kiss Péter e.v.',
  taxNumber: '65432101-2-13',
  address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 3.' },
  bankAccount: '12345676-11111111',
  registrationNumber: '52184573',
  vatStatus: 'normal',
  cashAccounting: true,
  smallBusiness: true,
};

const INVOICE_EV_CASH: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b6',
  number: 'EV-2026-00001',
  paymentMethod: 'CARD',
  appearance: 'PAPER',
  orderNumber: null,
  seller: SELLER_EV_CASH,
  customer: CUSTOMER_PRIVATE,
  lines: [hufLine(1, 'Portréfotózás', '1', 'alkalom', '40000', '27', '40000', '10800')],
  totals: hufTotals([['27', '40000', '10800']]),
  notations: ['Pénzforgalmi elszámolás'],
};

/** Domestic reverse charge (Áfa tv. 142. §). */
const INVOICE_FAD: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b7',
  number: 'SZ-2026-00011',
  orderNumber: null,
  lines: [hufLine(1, 'Épületgépészeti szerelés', '1', 'tétel', '500000', 'FAD', '500000', '0')],
  totals: hufTotals([['FAD', '500000', '0']]),
  notations: ['Fordított adózás'],
};

/** Margin scheme – second-hand goods, private buyer. */
const INVOICE_MARGIN: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b8',
  number: 'SZ-2026-00012',
  paymentMethod: 'CASH',
  orderNumber: null,
  customer: CUSTOMER_PRIVATE,
  lines: [hufLine(1, 'Használt kerékpár', '1', 'db', '85000', 'KUL_HASZNALT', '85000', '0', { nature: 'PRODUCT' })],
  totals: hufTotals([['KUL_HASZNALT', '85000', '0']]),
  notations: ['Különbözet szerinti szabályozás – használt cikkek'],
};

const LONG_DESCRIPTION = `Egyedi fejlesztés ${'és karbantartás '.repeat(10)}`.trim();

/** Third-country buyer: XML-special characters, no postal code, odd tax id, long text, 3-decimal quantity. */
const INVOICE_EDGE: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000b9',
  number: 'SZ-2026-00013',
  orderNumber: null,
  customer: {
    vatStatus: 'OTHER',
    name: `Kovács & Társa <"Bt."> 'teszt'`,
    thirdStateTaxId: '123',
    address: { countryCode: 'AE', postalCode: '', city: 'Dubai', addressLine: 'Sheikh Zayed Road 1' },
  },
  lines: [
    hufLine(1, LONG_DESCRIPTION, '1.125', 'kg', '1000', 'HO', '1125', '0', { nature: 'PRODUCT' }),
    hufLine(2, 'Csomagolás', '3', 'db', '123.456', 'HO', '370', '0', { nature: 'PRODUCT' }),
  ],
  totals: hufTotals([['HO', '1495', '0']]),
  notations: ['A teljesítés helye harmadik ország, az ügylet az Áfa tv. területi hatályán kívül esik'],
};

const DRAFT: Invoice = { ...INVOICE_DOMESTIC, id: 'inv_draft00001', status: 'draft', number: null, issuedAt: null, navStatus: 'not_applicable' };
const PROFORMA: Invoice = { ...INVOICE_DOMESTIC, id: 'inv_proforma01', documentType: 'proforma', number: 'DB-2026-00001', navStatus: 'not_applicable' };

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('vendored 3. melléklet XSD', () => {
  it('is the verbatim njt text (unchanged bytes)', () => {
    const bytes = readFileSync(SZAMLA2013_XSD);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('c979ab420679ae9543c743c00a8b435a35d2b5eb815f72cfef73719bd1c2351a');
    const text = bytes.toString('utf8');
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<xs:schema xmlns="http://schemas.nav.gov.hu/2013/szamla"')).toBe(true);
    expect(text).toContain(`targetNamespace="${SZAMLA2013_NAMESPACE}"`);
    expect(text).toContain('<xs:element name="szamlak" type="szamlak_tipus">');
  });

  it('rejects documents that break the schema (missing teljdatum, 3 decimals)', async () => {
    const xml = buildSzamla2013Xml([INVOICE_DOMESTIC], { exportDate: '2026-10-30' });
    const noDelivery = xml.replace(/\s*<teljdatum>[^<]*<\/teljdatum>/, '');
    expect(noDelivery).not.toBe(xml);
    expect((await validateSzamla2013Xml(noDelivery)).valid).toBe(false);
    const threeDecimals = xml.replace('<menny>10</menny>', '<menny>10.125</menny>');
    expect(threeDecimals).not.toBe(xml);
    expect((await validateSzamla2013Xml(threeDecimals)).valid).toBe(false);
  });

  // Every test validates its output against the XSD; these prove that the validator enforces the
  // xs:sequence ORDER, i.e. a builder that emitted elements in the wrong order would fail the suite.
  it.each([
    ['header: zaro_ido before kezdo_ido', /(<kezdo_ido>[^<]*<\/kezdo_ido>)(\s*)(<zaro_ido>[^<]*<\/zaro_ido>)/],
    ['seller: nev before adoszam', /(<adoszam>12345676-2-42<\/adoszam>\s*<kozadoszam>[^<]*<\/kozadoszam>)(\s*)(<nev>[^<]*<\/nev>)/],
    ['address: telepules before iranyitoszam', /(<iranyitoszam>[^<]*<\/iranyitoszam>)(\s*)(<telepules>[^<]*<\/telepules>)/],
    ['line: mertekegys before menny', /(<menny>[^<]*<\/menny>)(\s*)(<mertekegys>[^<]*<\/mertekegys>)/],
    ['line: adoertek before adokulcs', /(<adokulcs>[^<]*<\/adokulcs>)(\s*)(<adoertek>[^<]*<\/adoertek>)/],
    ['invoice: osszesites before nem_kotelezo', /(<nem_kotelezo>[\s\S]*?<\/nem_kotelezo>)(\s*)(<osszesites>[\s\S]*?<\/osszesites>)/],
    ['totals: vegosszeg before afarovat', /(<afarovat>[\s\S]*?<\/afarovat>)(\s*)(<vegosszeg>[\s\S]*?<\/vegosszeg>)/],
  ])('rejects wrong element order (%s)', async (_name, pair) => {
    const xml = buildSzamla2013Xml([INVOICE_DOMESTIC], { exportDate: '2026-10-30' });
    const swapped = xml.replace(pair, '$3$2$1');
    expect(swapped).not.toBe(xml);
    expect((await validateSzamla2013Xml(swapped)).valid).toBe(false);
  });
});

describe('characters', () => {
  it('writes UTF-8 without BOM, keeps Hungarian letters, drops or flattens characters XML cannot hold', async () => {
    const description = 'Tűzőgép\tőszi\r\nÁRVÍZTŰRŐ\u000BTÜKÖRFÚRÓGÉP\u0000\u0007 ű\uD800ő￾ ÖÜÓŐÚÉÁŰÍ';
    const inv: Invoice = {
      ...INVOICE_DOMESTIC,
      customer: { ...CUSTOMER_DOMESTIC, name: 'Őrült Ügyvéd\nés Társa Kft.' },
      lines: [{ ...(INVOICE_DOMESTIC.lines[0] as InvoiceLine), description }, INVOICE_DOMESTIC.lines[1] as InvoiceLine],
    };
    const r = await buildValid([inv]);
    expect(r.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<szamlak ')).toBe(true);
    expect(r.xml.charCodeAt(0)).not.toBe(0xfeff);
    // Tab, CR/LF and VT become single spaces; NUL, BEL, a lone surrogate and U+FFFE are removed.
    expect(get(r.doc, 'szamlak.szamla.0.termek_szolgaltatas_tetelek.0.termeknev')).toBe('Tűzőgép őszi ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP űő ÖÜÓŐÚÉÁŰÍ');
    expect(get(r.doc, 'szamlak.szamla.0.vevo.nev')).toBe('Őrült Ügyvéd és Társa Kft.');
    // Nothing outside the XML 1.0 Char production is left in the document (no lone surrogate either).
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(r.xml)).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.xml)).toBe(false);
    expect(Buffer.from(r.xml, 'utf8').toString('utf8')).toBe(r.xml);
  });

  it('counts characters (code points) for the 100-character limit, as the XSD does', async () => {
    const astral100 = `${'😀'.repeat(60)}${'x'.repeat(40)}`; // 100 characters, 160 UTF-16 code units
    const fits = await buildValid([{ ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, name: astral100 } }]);
    expect(get(fits.doc, 'szamlak.szamla.0.vevo.nev')).toBe(astral100);
    expect(fits.warnings).toEqual([]);
    const tooLong = await buildValid([{ ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, name: `${astral100}y` } }]);
    expect(get(tooLong.doc, 'szamlak.szamla.0.vevo.nev')).toBe(astral100);
    expect(tooLong.warnings.map((w) => w.field)).toEqual(['customer.name']);
    // A surrogate pair is never split by the cut.
    const split = await buildValid([{ ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, name: `${'x'.repeat(99)}😀😀` } }]);
    expect(get(split.doc, 'szamlak.szamla.0.vevo.nev')).toBe(`${'x'.repeat(99)}😀`);
  });
});

describe('buildSzamla2013Xml – fixtures', () => {
  it.each(Object.entries(ALL_FIXTURES))('%s on its own is valid against the XSD', async (_name, invoice) => {
    const r = await buildValid([invoice]);
    expect(r.invoiceCount).toBe(1);
    expect(get(r.doc, 'szamlak.@_xmlns')).toBe(SZAMLA2013_NAMESPACE);
    expect(get(r.doc, 'szamlak.export_szla_db')).toBe('1');
    expect(get(r.doc, 'szamlak.szamla.0.fejlec.szlasorszam')).toBe(invoice.number);
    expect(get(r.doc, 'szamlak.kezdo_szla_szam')).toBe(invoice.number);
    expect(get(r.doc, 'szamlak.zaro_szla_szam')).toBe(invoice.number);
    expect(get(r.doc, 'szamlak.kezdo_ido')).toBe(invoice.issueDate);
    expect(get(r.doc, 'szamlak.zaro_ido')).toBe(invoice.issueDate);
    expect(r.warnings).toEqual([]);
  });

  it('exports all fixtures in one document with a consistent header', async () => {
    const r = await buildValid([INVOICE_STORNO, INVOICE_EU_SERVICE, INVOICE_DOMESTIC, INVOICE_PRIVATE_AAM], { rangeFrom: '2026-10-01', rangeTo: '2026-10-31' });
    expect(get(r.doc, 'szamlak.export_datuma')).toBe('2026-10-30');
    expect(get(r.doc, 'szamlak.export_szla_db')).toBe('4');
    expect(get(r.doc, 'szamlak.kezdo_ido')).toBe('2026-10-01');
    expect(get(r.doc, 'szamlak.zaro_ido')).toBe('2026-10-31');
    // Number range derived from the exported invoices (issuance order).
    expect(get(r.doc, 'szamlak.kezdo_szla_szam')).toBe('SZ-2026-00001');
    expect(get(r.doc, 'szamlak.zaro_szla_szam')).toBe('SZ-2026-00004');
    expect(list(r.doc, 'szamlak.szamla').map((s) => get(s, 'fejlec.szlasorszam'))).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003', 'SZ-2026-00004']);
    expect(r.invoiceNumbers).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003', 'SZ-2026-00004']);
    expect(r).toMatchObject({ invoiceCount: 4, rangeFrom: '2026-10-01', rangeTo: '2026-10-31', numberFrom: 'SZ-2026-00001', numberTo: 'SZ-2026-00004' });
  });

  it('domestic B2B: header, parties, lines, VAT summary and totals', async () => {
    const r = await buildValid([INVOICE_DOMESTIC]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'fejlec')).toEqual({ szlasorszam: 'SZ-2026-00001', szlatipus: '1', szladatum: '2026-10-27', teljdatum: '2026-10-27' });
    expect(get(s, 'szamlakibocsato')).toEqual({
      adoszam: '12345676-2-42',
      kozadoszam: 'HU12345676',
      nev: 'Példa Szoftver Kft.',
      cim: { iranyitoszam: '1117', telepules: 'Budapest', kozterulet_neve: 'Irinyi József', kozterulet_jellege: 'utca', hazszam: '4-20.' },
    });
    expect(get(s, 'vevo')).toEqual({
      adoszam: '87654323-2-13',
      nev: 'Árvíztűrő Tükörfúrógép Zrt.',
      cim: { iranyitoszam: '1117', telepules: 'Budapest', kozterulet_neve: 'Október huszonharmadika', kozterulet_jellege: 'utca', hazszam: '18.' },
    });
    expect(get(s, 'termek_szolgaltatas_tetelek.0')).toEqual({
      termeknev: 'Szoftverfejlesztés – október', menny: '10', mertekegys: 'óra',
      nettoar: '150000', nettoegysar: '15000', adokulcs: '27', adoertek: '40500', bruttoar: '190500',
    });
    expect(get(s, 'termek_szolgaltatas_tetelek.1.adokulcs')).toBe('5');
    expect(get(s, 'modosito_szla')).toBeUndefined();
    expect(get(s, 'zaradekok')).toBeUndefined();
    expect(get(s, 'nem_kotelezo')).toEqual({
      fiz_hatarido: '2026-11-04', fiz_mod: 'Átutalás', penznem: 'HUF', szla_forma: 'e-számla', kibocsato_bankszla: '12345676-11111111',
    });
    expect(get(s, 'osszesites')).toEqual({
      afarovat: [
        { nettoar: '150000', adokulcs: '27', adoertek: '40500', bruttoar: '190500' },
        { nettoar: '4000', adokulcs: '5', adoertek: '200', bruttoar: '4200' },
      ],
      vegosszeg: { nettoarossz: '154000', afaertekossz: '40700', bruttoarossz: '194700' },
    });
  });

  it('AAM seller to a private person: exemption notation, no VAT data, buyer name and address exported', async () => {
    const r = await buildValid([INVOICE_PRIVATE_AAM]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'szamlakibocsato.egyeni_vallalkozo')).toBe('true');
    expect(get(s, 'szamlakibocsato.ev_neve')).toBe('Kovács Anna');
    expect(get(s, 'szamlakibocsato.ev_nyilv_tart_szam')).toBeUndefined();
    // Private person: name and address are part of the audit export (unlike NAV Online Számla), no tax data.
    expect(get(s, 'vevo')).toEqual({
      nev: 'Szőke Őrs',
      cim: { iranyitoszam: '4025', telepules: 'Debrecen', kozterulet_neve: 'Piac', kozterulet_jellege: 'utca', hazszam: '20.' },
    });
    const line = get(s, 'termek_szolgaltatas_tetelek.0');
    expect(get(line, 'adokulcs')).toBeUndefined();
    expect(get(line, 'adoertek')).toBeUndefined();
    expect(get(line, 'nettoar')).toBe('24998');
    expect(get(s, 'zaradekok')).toEqual({ adoment_hiv: 'true' });
    expect(get(s, 'nem_kotelezo.fiz_mod')).toBe('Készpénz');
    // No VAT rate → no afarovat; AAM may not show VAT → no afaertekossz. Gross total unrounded (24 998).
    expect(get(s, 'osszesites')).toEqual({ vegosszeg: { nettoarossz: '24998', bruttoarossz: '24998' } });
  });

  it('EUR service to an EU business: community VAT number, reverse charge, EUR amounts', async () => {
    const r = await buildValid([INVOICE_EU_SERVICE]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'fejlec.teljdatum')).toBe('2026-10-24');
    expect(get(s, 'vevo')).toEqual({
      kozadoszam: 'DE123456789',
      nev: 'Beispiel GmbH',
      cim: { iranyitoszam: '10115', telepules: 'Berlin', kozterulet_neve: 'Invalidenstraße 1' },
    });
    expect(get(s, 'termek_szolgaltatas_tetelek.0.nettoar')).toBe('800');
    expect(get(s, 'termek_szolgaltatas_tetelek.0.adokulcs')).toBeUndefined();
    expect(get(s, 'zaradekok')).toEqual({ ford_ado: 'true' });
    expect(get(s, 'nem_kotelezo.penznem')).toBe('EUR');
    expect(get(s, 'osszesites.afarovat')).toBeUndefined();
    expect(get(s, 'osszesites.vegosszeg')).toEqual({ nettoarossz: '800', afaertekossz: '0', bruttoarossz: '800' });
  });

  it('storno: type 4, reference to the original, negated lines and totals', async () => {
    const r = await buildValid([INVOICE_STORNO]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'fejlec.szlatipus')).toBe('4');
    expect(get(s, 'fejlec.szladatum')).toBe('2026-10-28');
    expect(get(s, 'modosito_szla')).toEqual([{ eredeti_sorszam: 'SZ-2026-00001' }]);
    expect(list(s, 'termek_szolgaltatas_tetelek').map((l) => [get(l, 'menny'), get(l, 'nettoar'), get(l, 'adoertek')])).toEqual([
      ['-10', '-150000', '-40500'],
      ['-2', '-4000', '-200'],
    ]);
    expect(get(s, 'osszesites.vegosszeg')).toEqual({ nettoarossz: '-154000', afaertekossz: '-40700', bruttoarossz: '-194700' });
  });
});

describe('buildSzamla2013Xml – additional scenarios', () => {
  it('modification invoice: type 3 with the original number', async () => {
    const r = await buildValid([INVOICE_MODIFICATION]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'fejlec.szlatipus')).toBe('3');
    expect(get(s, 'modosito_szla')).toEqual([{ eredeti_sorszam: 'SZ-2026-00001' }]);
    expect(get(s, 'termek_szolgaltatas_tetelek.0')).toMatchObject({ menny: '-2', nettoar: '-30000', adokulcs: '27', adoertek: '-8100', bruttoar: '-38100' });
    expect(get(s, 'osszesites')).toEqual({
      afarovat: [{ nettoar: '-30000', adokulcs: '27', adoertek: '-8100', bruttoar: '-38100' }],
      vegosszeg: { nettoarossz: '-30000', afaertekossz: '-8100', bruttoarossz: '-38100' },
    });
  });

  it('foreign-currency domestic sale with 27%: amounts in EUR, VAT in HUF', async () => {
    const r = await buildValid([INVOICE_EUR_DOMESTIC]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(list(s, 'termek_szolgaltatas_tetelek').map((l) => [get(l, 'menny'), get(l, 'nettoar'), get(l, 'adokulcs'), get(l, 'adoertek'), get(l, 'bruttoar')])).toEqual([
      ['1', '100', '27', '10533.24', '127'],
      ['1.5', '120', '27', '12639.89', '152.4'],
    ]);
    expect(get(s, 'nem_kotelezo.penznem')).toBe('EUR');
    expect(get(s, 'osszesites')).toEqual({
      afarovat: [{ nettoar: '220', adokulcs: '27', adoertek: '23173.13', bruttoar: '279.4' }],
      vegosszeg: { nettoarossz: '220', afaertekossz: '23173.13', bruttoarossz: '279.4' },
    });
  });

  it('multiple VAT rates: one afarovat row per percentage rate, exempt line without rate', async () => {
    const r = await buildValid([INVOICE_MULTI_VAT]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(list(s, 'osszesites.afarovat')).toEqual([
      { nettoar: '40000', adokulcs: '27', adoertek: '10800', bruttoar: '50800' },
      { nettoar: '30000', adokulcs: '18', adoertek: '5400', bruttoar: '35400' },
      { nettoar: '12000', adokulcs: '5', adoertek: '600', bruttoar: '12600' },
      { nettoar: '2500', adokulcs: '0', adoertek: '0', bruttoar: '2500' },
    ]);
    expect(get(s, 'osszesites.vegosszeg')).toEqual({ nettoarossz: '99500', afaertekossz: '16800', bruttoarossz: '116300' });
    const tam = get(s, 'termek_szolgaltatas_tetelek.4');
    expect(get(tam, 'termeknev')).toBe('Felnőttképzési tanfolyam');
    expect(get(tam, 'adokulcs')).toBeUndefined();
    expect(get(tam, 'adoertek')).toBeUndefined();
    expect(get(s, 'termek_szolgaltatas_tetelek.3.adokulcs')).toBe('0');
    expect(get(s, 'zaradekok')).toEqual({ adoment_hiv: 'true' });
  });

  it('advance and final invoices: eloleg 1 on advance lines, 2 on the deducted advance', async () => {
    const r = await buildValid([INVOICE_FINAL, INVOICE_ADVANCE]);
    expect(r.invoiceNumbers).toEqual(['SZ-2026-00008', 'SZ-2026-00009']);
    const advance = get(r.doc, 'szamlak.szamla.0');
    expect(get(advance, 'fejlec.szlatipus')).toBe('1');
    expect(get(advance, 'termek_szolgaltatas_tetelek.0.eloleg')).toBe('1');
    const final = get(r.doc, 'szamlak.szamla.1');
    expect(get(final, 'fejlec.szlatipus')).toBe('1');
    expect(get(final, 'termek_szolgaltatas_tetelek.0.eloleg')).toBeUndefined();
    expect(get(final, 'termek_szolgaltatas_tetelek.1.eloleg')).toBe('2');
    expect(get(final, 'osszesites.vegosszeg')).toEqual({ nettoarossz: '200000', afaertekossz: '54000', bruttoarossz: '254000' });
  });

  it('corrections of an előlegszámla keep eloleg 1 on every line, like advanceIndicator in the NAV data', async () => {
    const r = await buildValid([INVOICE_ADVANCE_STORNO, INVOICE_ADVANCE_MODIFICATION]);
    const [storno, modification] = list(r.doc, 'szamlak.szamla');
    expect(get(storno, 'fejlec.szlatipus')).toBe('4');
    expect(get(storno, 'modosito_szla')).toEqual([{ eredeti_sorszam: 'SZ-2026-00008' }]);
    expect(list(storno, 'termek_szolgaltatas_tetelek').map((l) => get(l, 'eloleg'))).toEqual(['1']);
    expect(get(modification, 'fejlec.szlatipus')).toBe('3');
    expect(list(modification, 'termek_szolgaltatas_tetelek').map((l) => get(l, 'eloleg'))).toEqual(['1']);
    // Same rule as the NAV invoiceData (advanceIndicator on every line of a correction of an advance).
    for (const inv of [INVOICE_ADVANCE_STORNO, INVOICE_ADVANCE_MODIFICATION]) {
      expect(buildInvoiceDataXml(inv).match(/<advanceIndicator>true<\/advanceIndicator>/g)).toHaveLength(inv.lines.length);
    }
  });

  it('a storno of a végszámla marks only the reversed advance deduction (eloleg 2); other corrections have no eloleg', async () => {
    const r = await buildValid([INVOICE_FINAL_STORNO, INVOICE_STORNO, INVOICE_MODIFICATION]);
    const [storno, modification, finalStorno] = list(r.doc, 'szamlak.szamla');
    expect(list(finalStorno, 'termek_szolgaltatas_tetelek').map((l) => get(l, 'eloleg'))).toEqual([undefined, '2']);
    expect(get(finalStorno, 'osszesites.vegosszeg')).toEqual({ nettoarossz: '-200000', afaertekossz: '-54000', bruttoarossz: '-254000' });
    for (const s of [storno, modification]) {
      expect(list(s, 'termek_szolgaltatas_tetelek').every((l) => get(l, 'eloleg') === undefined)).toBe(true);
    }
  });

  it('egyéni vállalkozó, kisadózó and pénzforgalmi elszámolás seller', async () => {
    const r = await buildValid([INVOICE_EV_CASH]);
    const s = get(r.doc, 'szamlak.szamla.0');
    expect(get(s, 'szamlakibocsato')).toEqual({
      adoszam: '65432101-2-13',
      kisadozo: 'true',
      nev: 'Kiss Péter e.v.',
      cim: { iranyitoszam: '2000', telepules: 'Szentendre', kozterulet_neve: 'Fő', kozterulet_jellege: 'tér', hazszam: '3.' },
      egyeni_vallalkozo: 'true',
      ev_nyilv_tart_szam: '52184573',
      ev_neve: 'Kiss Péter',
    });
    expect(get(s, 'zaradekok')).toEqual({ penzforgelsz: 'true' });
    expect(get(s, 'nem_kotelezo')).toEqual({
      fiz_hatarido: '2026-11-04', fiz_mod: 'Bankkártya', penznem: 'HUF', szla_forma: 'papír alapon továbbított számla', kibocsato_bankszla: '12345676-11111111',
    });
  });

  it('pénzforgalmi elszámolás follows the printed notations, with the seller flag as fallback', async () => {
    const flagOnly = (await buildValid([{ ...INVOICE_EV_CASH, notations: [] }])).xml;
    expect(flagOnly).toContain('<penzforgelsz>true</penzforgelsz>');
    const notPrinted = (await buildValid([{ ...INVOICE_EV_CASH, notations: ['Egyéb megjegyzés'] }])).xml;
    expect(notPrinted).not.toContain('<penzforgelsz>');
    expect(notPrinted).not.toContain('<zaradekok>');
    // English invoices print the statutory expression in Hungarian too ("pénzforgalmi elszámolás / Cash accounting").
    const english = (await buildValid([{ ...INVOICE_EV_CASH, language: 'en', notations: ['pénzforgalmi elszámolás / Cash accounting'] }])).xml;
    expect(english).toContain('<penzforgelsz>true</penzforgelsz>');
    const selfBilled = (await buildValid([{ ...INVOICE_DOMESTIC, notations: ['Önszámlázás'] }])).xml;
    expect(selfBilled).toContain('<onszamla>true</onszamla>');
  });

  it('domestic reverse charge and margin scheme: notations, no VAT amounts', async () => {
    const r = await buildValid([INVOICE_FAD, INVOICE_MARGIN]);
    const [fad, margin] = list(r.doc, 'szamlak.szamla');
    expect(get(fad, 'zaradekok')).toEqual({ ford_ado: 'true' });
    expect(get(fad, 'termek_szolgaltatas_tetelek.0.adokulcs')).toBeUndefined();
    expect(get(fad, 'osszesites')).toEqual({ vegosszeg: { nettoarossz: '500000', bruttoarossz: '500000' } });
    expect(get(margin, 'zaradekok')).toEqual({ kulonb_szer_szab: '2' });
    expect(get(margin, 'vevo.adoszam')).toBeUndefined();
    expect(get(margin, 'osszesites')).toEqual({ vegosszeg: { nettoarossz: '85000', bruttoarossz: '85000' } });
  });

  it('margin schemes are coded 1–4; with two schemes the first one is exported and a warning is given', async () => {
    const twoSchemes: Invoice = {
      ...INVOICE_MARGIN,
      lines: [
        hufLine(1, 'Festmény', '1', 'db', '150000', 'KUL_MUALKOTAS', '150000', '0'),
        hufLine(2, 'Antik óra', '1', 'db', '50000', 'KUL_REGISEG', '50000', '0'),
      ],
      totals: hufTotals([['KUL_MUALKOTAS', '150000', '0'], ['KUL_REGISEG', '50000', '0']]),
    };
    const r = await buildValid([twoSchemes]);
    expect(get(r.doc, 'szamlak.szamla.0.zaradekok')).toEqual({ kulonb_szer_szab: '3' });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ invoiceNumber: 'SZ-2026-00012', field: 'lines' });
    const travel: Invoice = { ...INVOICE_MARGIN, lines: [hufLine(1, 'Társasutazás', '1', 'fő', '200000', 'KUL_UTAZAS', '200000', '0')], totals: hufTotals([['KUL_UTAZAS', '200000', '0']]) };
    expect((await buildValid([travel])).xml).toContain('<kulonb_szer_szab>1</kulonb_szer_szab>');
  });

  it('escapes XML characters and adapts data to the schema limits with warnings', async () => {
    const r = await buildValid([INVOICE_EDGE]);
    expect(r.xml).toContain('<nev>Kovács &amp; Társa &lt;&quot;Bt.&quot;&gt; &apos;teszt&apos;</nev>');
    const s = get(r.doc, 'szamlak.szamla.0');
    // Third-country buyer: "123" does not fit adoszam_tipus (8–20) → left out; no postal code → "0000".
    expect(get(s, 'vevo')).toEqual({
      nev: `Kovács & Társa <"Bt."> 'teszt'`,
      cim: { iranyitoszam: '0000', telepules: 'Dubai', kozterulet_neve: 'Sheikh Zayed Road 1' },
    });
    const [first, second] = list(s, 'termek_szolgaltatas_tetelek');
    expect(get(first, 'termeknev')).toBe(Array.from(LONG_DESCRIPTION).slice(0, 100).join('').trimEnd());
    expect(get(first, 'menny')).toBe('1.13');
    expect(get(second, 'nettoegysar')).toBe('123.46');
    // Out of scope (HO): no notation flag, no afarovat, but a (zero) VAT total is printed.
    expect(get(s, 'zaradekok')).toBeUndefined();
    expect(get(s, 'osszesites')).toEqual({ vegosszeg: { nettoarossz: '1495', afaertekossz: '0', bruttoarossz: '1495' } });
    expect(r.warnings.map((w) => w.field)).toEqual([
      'customer.thirdStateTaxId',
      'customer.address.postalCode',
      'lines[0].description',
      'lines[0].quantity',
    ]);
    expect(r.warnings.every((w) => w.invoiceNumber === 'SZ-2026-00013' && w.message.length > 0)).toBe(true);
  });

  it('pads a short postal code and keeps a Hungarian address line without street type whole', async () => {
    const inv: Invoice = {
      ...INVOICE_DOMESTIC,
      customer: { ...CUSTOMER_DOMESTIC, address: { countryCode: 'HU', postalCode: '123', city: 'Tanyaváros', addressLine: 'Hrsz. 0123/4' } },
    };
    const r = await buildValid([inv]);
    expect(get(r.doc, 'szamlak.szamla.0.vevo.cim')).toEqual({ iranyitoszam: '0123', telepules: 'Tanyaváros', kozterulet_neve: 'Hrsz. 0123/4' });
    expect(r.warnings.map((w) => w.field)).toEqual(['customer.address.postalCode']);
  });

  it('an unknown stored payment method is still string_tipus: cut to 100 characters with a warning', async () => {
    const r = await buildValid([{ ...INVOICE_DOMESTIC, paymentMethod: `Beszámítás ${'x'.repeat(120)}` as Invoice['paymentMethod'] }]);
    expect(Array.from(get(r.doc, 'szamlak.szamla.0.nem_kotelezo.fiz_mod') as string)).toHaveLength(100);
    expect(r.warnings.map((w) => w.field)).toEqual(['paymentMethod']);
    const short = await buildValid([{ ...INVOICE_DOMESTIC, paymentMethod: 'Beszámítás' as Invoice['paymentMethod'] }]);
    expect(get(short.doc, 'szamlak.szamla.0.nem_kotelezo.fiz_mod')).toBe('Beszámítás');
    expect(short.warnings).toEqual([]);
  });
});

describe('selection, order and header', () => {
  it('skips drafts, díjbekérők and duplicates; orders by issuance', async () => {
    const r = await buildValid([INVOICE_STORNO, DRAFT, PROFORMA, INVOICE_DOMESTIC, INVOICE_DOMESTIC]);
    expect(r.invoiceCount).toBe(2);
    expect(get(r.doc, 'szamlak.export_szla_db')).toBe('2');
    expect(r.invoiceNumbers).toEqual(['SZ-2026-00001', 'SZ-2026-00004']);
    expect(r.xml).not.toContain('DB-2026-00001');
    expect(selectSzamla2013Invoices([PROFORMA, DRAFT])).toEqual([]);
  });

  it('derives the date range for a number-range export', async () => {
    const r = await buildValid([INVOICE_STORNO, INVOICE_DOMESTIC], { numberFrom: 'SZ-2026-00001', numberTo: 'SZ-2026-00004' });
    expect(get(r.doc, 'szamlak.kezdo_szla_szam')).toBe('SZ-2026-00001');
    expect(get(r.doc, 'szamlak.zaro_szla_szam')).toBe('SZ-2026-00004');
    expect(get(r.doc, 'szamlak.kezdo_ido')).toBe('2026-10-27');
    expect(get(r.doc, 'szamlak.zaro_ido')).toBe('2026-10-28');
  });

  it('orders numbers naturally within a day', () => {
    const a = { ...INVOICE_DOMESTIC, id: 'inv_n10', number: 'A-10', issuedAt: '2026-10-27T08:00:00.000Z' };
    const b = { ...INVOICE_DOMESTIC, id: 'inv_n9', number: 'A-9', issuedAt: '2026-10-27T08:00:00.000Z' };
    expect(selectSzamla2013Invoices([a, b]).map((i) => i.number)).toEqual(['A-9', 'A-10']);
  });

  it('buildSzamla2013Xml returns the document of buildSzamla2013Export', () => {
    const meta = { exportDate: '2026-10-30' };
    expect(buildSzamla2013Xml([INVOICE_DOMESTIC], meta)).toBe(buildSzamla2013Export([INVOICE_DOMESTIC], meta).xml);
  });
});

describe('errors', () => {
  it('refuses an empty export (the schema needs at least one invoice)', () => {
    expect(appError(() => buildSzamla2013Export([DRAFT, PROFORMA], { exportDate: '2026-10-30' })).code).toBe('SZAMLA2013_NO_INVOICES');
  });

  it('validates the requested header values', () => {
    expect(appError(() => buildSzamla2013Export([INVOICE_DOMESTIC], { exportDate: '2026-13-01' })).code).toBe('INVALID_DATE');
    expect(appError(() => buildSzamla2013Export([INVOICE_DOMESTIC], { exportDate: '2026-10-30', rangeFrom: '2026-10-31', rangeTo: '2026-10-01' })).code).toBe('INVALID_INPUT');
    expect(appError(() => buildSzamla2013Export([INVOICE_DOMESTIC], { exportDate: '2026-10-30', numberFrom: 'X'.repeat(101) })).code).toBe('INVALID_INPUT');
  });

  it('one document that cannot be represented is left out with a warning – it never aborts the export', async () => {
    // A legacy header-only modification (no lines) and a number-less invoice next to valid ones.
    const lineless: Invoice = {
      ...INVOICE_STORNO, id: 'inv_lineless01', number: 'SZ-2026-00005', documentType: 'modification', lines: [],
      totals: { ...INVOICE_STORNO.totals, netAmount: '0', vatAmount: '0', grossAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0', byVat: [], payableAmount: '0', roundingDifference: '0' },
    };
    const numberless: Invoice = { ...INVOICE_DOMESTIC, id: 'inv_nonumber01', number: null };
    const r = await buildValid([INVOICE_DOMESTIC, lineless, INVOICE_STORNO, numberless]);
    expect(r.invoiceCount).toBe(2);
    expect(get(r.doc, 'szamlak.export_szla_db')).toBe('2');
    expect(r.invoiceNumbers).toEqual(['SZ-2026-00001', 'SZ-2026-00004']);
    expect(r.xml).not.toContain('SZ-2026-00005');
    // In export order (issue date, then number).
    expect(r.warnings.map((w) => [w.invoiceNumber, w.field])).toEqual([
      ['inv_nonumber01', 'number'],
      ['SZ-2026-00005', 'lines'],
    ]);
    expect(r.warnings[1]?.message).toMatch(/kimaradt.*nincs tétele/);
    // Nothing exportable at all: the (first) error is raised – the schema needs at least one invoice.
    expect(appError(() => buildSzamla2013Export([lineless], { exportDate: '2026-10-30' })).code).toBe('SZAMLA2013_DATA_INVALID');
  });

  it('does not paper over corrupt issued data', () => {
    const noReference = appError(() => buildSzamla2013Export([{ ...INVOICE_STORNO, reference: null }], { exportDate: '2026-10-30' }));
    expect(noReference.code).toBe('SZAMLA2013_DATA_INVALID');
    expect(noReference.details).toMatchObject({ invoiceNumber: 'SZ-2026-00004', field: 'reference.originalInvoiceNumber' });
    const noNumber = appError(() => buildSzamla2013Export([{ ...INVOICE_DOMESTIC, number: null }], { exportDate: '2026-10-30' }));
    expect(noNumber.code).toBe('SZAMLA2013_DATA_INVALID');
    const noCity = appError(() =>
      buildSzamla2013Export([{ ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, address: { ...CUSTOMER_DOMESTIC.address, city: ' ' } } }], { exportDate: '2026-10-30' }),
    );
    expect(noCity.details).toMatchObject({ field: 'customer.address.city' });
    const huge = appError(() =>
      buildSzamla2013Export([{ ...INVOICE_DOMESTIC, totals: { ...INVOICE_DOMESTIC.totals, grossAmount: '12345678901234' } }], { exportDate: '2026-10-30' }),
    );
    expect(huge.details).toMatchObject({ field: 'totals.grossAmount' });
  });
});

describe('splitHuStreetLine', () => {
  it.each([
    ['Irinyi József utca 4-20.', { name: 'Irinyi József', type: 'utca', rest: '4-20.' }],
    ['Fő tér', { name: 'Fő', type: 'tér', rest: null }],
    ['Ady Endre u. 5. 2/3.', { name: 'Ady Endre', type: 'u.', rest: '5. 2/3.' }],
    ['Váci út 1-3. B ép. 2. em. 5.', { name: 'Váci', type: 'út', rest: '1-3. B ép. 2. em. 5.' }],
    ['Kert utca 5', { name: 'Kert', type: 'utca', rest: '5' }],
    ['Szent István körút 12/A', { name: 'Szent István', type: 'körút', rest: '12/A' }],
    ['Hrsz. 0123/4', { name: 'Hrsz. 0123/4', type: null, rest: null }],
    ['Utca 5', { name: 'Utca 5', type: null, rest: null }],
    ['Fő utca B épület', { name: 'Fő utca B épület', type: null, rest: null }],
  ])('%s', (line, expected) => {
    expect(splitHuStreetLine(line)).toEqual(expected);
  });
});
