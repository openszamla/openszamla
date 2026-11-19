/**
 * invoiceData builder: every scenario must validate against the official invoiceData.xsd, carry the
 * right semantics, and use the same structure as NAV's own sample XMLs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { D, dec, sumDec, toDec, type DecValue } from '../../src/core/decimal.ts';
import { AppError } from '../../src/core/errors.ts';
import type { CustomerData, Invoice, InvoiceLine, InvoiceTotals, SellerProfile, VatCode } from '../../src/core/types.ts';
import { getVatInfo } from '../../src/core/vat.ts';
import { buildInvoiceDataXml, navBankAccount, navOperationFor, splitHuTaxNumber } from '../../src/nav/invoice-data.ts';
import { CUSTOMER_DOMESTIC, CUSTOMER_PRIVATE, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

// ---------------------------------------------------------------------------------------------
// Extra fixtures (hand-computed, internally consistent)
// ---------------------------------------------------------------------------------------------

type LineSpec = Omit<InvoiceLine, 'netAmountHuf' | 'vatAmountHuf' | 'grossAmountHuf' | 'priceBasis' | 'unitPrice'> &
  Partial<Pick<InvoiceLine, 'netAmountHuf' | 'vatAmountHuf' | 'grossAmountHuf' | 'priceBasis' | 'unitPrice'>>;

/** HUF line: the *Huf amounts equal the invoice currency amounts unless given. */
function line(spec: LineSpec): InvoiceLine {
  return {
    priceBasis: 'net',
    unitPrice: spec.netUnitPrice,
    netAmountHuf: spec.netAmount,
    vatAmountHuf: spec.vatAmount,
    grossAmountHuf: spec.grossAmount,
    ...spec,
  };
}

/** Totals per VAT code in order of first appearance (what calc.ts produces). */
function totalsOf(lines: InvoiceLine[]): InvoiceTotals {
  const sum = (v: string[]): string => toDec(sumDec(v));
  const codes = [...new Set(lines.map((l) => l.vatCode))] as VatCode[];
  const byVat = codes.map((vatCode) => {
    const ls = lines.filter((l) => l.vatCode === vatCode);
    return {
      vatCode,
      netAmount: sum(ls.map((l) => l.netAmount)),
      vatAmount: sum(ls.map((l) => l.vatAmount)),
      grossAmount: sum(ls.map((l) => l.grossAmount)),
      netAmountHuf: sum(ls.map((l) => l.netAmountHuf)),
      vatAmountHuf: sum(ls.map((l) => l.vatAmountHuf)),
      grossAmountHuf: sum(ls.map((l) => l.grossAmountHuf)),
    };
  });
  const gross = sum(lines.map((l) => l.grossAmount));
  return {
    netAmount: sum(lines.map((l) => l.netAmount)),
    vatAmount: sum(lines.map((l) => l.vatAmount)),
    grossAmount: gross,
    netAmountHuf: sum(lines.map((l) => l.netAmountHuf)),
    vatAmountHuf: sum(lines.map((l) => l.vatAmountHuf)),
    grossAmountHuf: sum(lines.map((l) => l.grossAmountHuf)),
    byVat,
    payableAmount: gross,
    roundingDifference: '0',
  };
}

function invoice(over: Partial<Invoice> & { lines: InvoiceLine[] }): Invoice {
  return { ...INVOICE_DOMESTIC, orderNumber: null, notations: [], ...over, totals: over.totals ?? totalsOf(over.lines) };
}

const INVOICE_ADVANCE = invoice({
  id: 'inv_00000000b1',
  documentType: 'advance',
  number: 'SZ-2026-00010',
  issueDate: '2026-10-05',
  fulfillmentDate: '2026-10-05',
  dueDate: '2026-10-05',
  lines: [
    line({
      lineNo: 1, description: 'Előleg – konyhabútor gyártása', quantity: '1', unit: 'db', vatCode: '27', nature: 'PRODUCT',
      netUnitPrice: '500000', netAmount: '500000', vatAmount: '135000', grossAmount: '635000',
    }),
  ],
});

const INVOICE_FINAL = invoice({
  id: 'inv_00000000b2',
  documentType: 'final',
  number: 'SZ-2026-00011',
  lines: [
    line({
      lineNo: 1, description: 'Konyhabútor, beépítve', quantity: '1', unit: 'db', vatCode: '27', nature: 'PRODUCT',
      netUnitPrice: '600000', netAmount: '600000', vatAmount: '162000', grossAmount: '762000',
    }),
    line({
      lineNo: 2, description: 'Előleg levonása (SZ-2026-00010)', quantity: '-1', unit: 'db', vatCode: '27', nature: 'PRODUCT',
      netUnitPrice: '500000', netAmount: '-500000', vatAmount: '-135000', grossAmount: '-635000',
      advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00010', advancePaymentDate: '2026-10-05', advanceExchangeRate: '1' },
    }),
  ],
});

/**
 * Modification of INVOICE_DOMESTIC (2 lines): line 1 reduced by 2 hours and a new line. NAV accepts
 * only lineOperation=CREATE (ERROR 60 INVALID_LINE_OPERATION), so both are NEW lines continuing the
 * chain numbering: 3 (the −2 h delta of original line 1) and 4.
 */
const INVOICE_MODIFICATION = invoice({
  id: 'inv_00000000b3',
  documentType: 'modification',
  number: 'SZ-2026-00012',
  issueDate: '2026-10-29',
  dueDate: '2026-11-04',
  reference: { originalInvoiceId: 'inv_00000000a1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false },
  lines: [
    line({
      lineNo: 1, description: 'Szoftverfejlesztés – október (helyesbítés: -2 óra)', quantity: '-2', unit: 'óra', vatCode: '27', nature: 'SERVICE',
      netUnitPrice: '15000', netAmount: '-30000', vatAmount: '-8100', grossAmount: '-38100',
      modifiesLineNo: 1, modificationRef: { lineNumberReference: 3, lineOperation: 'CREATE' },
    }),
    line({
      lineNo: 2, description: 'Kiszállási díj', quantity: '1', unit: 'alkalom', vatCode: '27', nature: 'SERVICE',
      netUnitPrice: '10000', netAmount: '10000', vatAmount: '2700', grossAmount: '12700',
      modificationRef: { lineNumberReference: 4, lineOperation: 'CREATE' },
    }),
  ],
});

const CUSTOMER_THIRD_COUNTRY: CustomerData = {
  vatStatus: 'OTHER',
  name: 'Kupac d.o.o.',
  thirdStateTaxId: 'RS 101234567',
  address: { countryCode: 'rs', postalCode: '11000', city: 'Beograd', addressLine: 'Knez Mihailova 10' },
};

/** USD export of goods to Serbia (EAM), rate 365.5: 2 × 1250.5 USD = 2501 USD = 914 115.50 Ft. */
const INVOICE_THIRD_COUNTRY = invoice({
  id: 'inv_00000000b4',
  number: 'SZ-2026-00013',
  currency: 'USD',
  exchangeRate: '365.5',
  exchangeRateDate: '2026-10-26',
  exchangeRateSource: 'MNB',
  customer: CUSTOMER_THIRD_COUNTRY,
  lines: [
    line({
      lineNo: 1, description: 'Ipari szivattyú', quantity: '2', unit: 'db', vatCode: 'EAM', nature: 'PRODUCT',
      netUnitPrice: '1250.5', netAmount: '2501', vatAmount: '0', grossAmount: '2501',
      netAmountHuf: '914115.5', vatAmountHuf: '0', grossAmountHuf: '914115.5',
    }),
  ],
});

const SELLER_GROUP: SellerProfile = {
  ...SELLER_NORMAL,
  name: 'Példa Szoftver Kft. (Példa ÁFA-csoport tagja)',
  taxNumber: '17781781-5-44',
  groupMemberTaxNumber: '12345676-4-42',
  euVatNumber: 'HU17781781',
  bankAccount: 'HU42 1177 3016 1111 1018 0000 0000',
};

const CUSTOMER_GROUP: CustomerData = {
  ...CUSTOMER_DOMESTIC,
  taxNumber: '22223333-5-41',
  groupMemberTaxNumber: '87654323-4-13',
};

const INVOICE_GROUP_MEMBER = invoice({
  id: 'inv_00000000b5',
  number: 'SZ-2026-00014',
  seller: SELLER_GROUP,
  customer: CUSTOMER_GROUP,
  lines: [
    line({
      lineNo: 1, description: 'Üzemeltetési díj – október', quantity: '1', unit: 'hó', vatCode: '27', nature: 'SERVICE',
      netUnitPrice: '200000', netAmount: '200000', vatAmount: '54000', grossAmount: '254000',
    }),
  ],
});

const GROSS_NET_UNIT = toDec(dec('1000').div('1.27')); // 787.4015748031496…

/** Gross-priced lines: unitPrice in NAV is the derived NET unit price. */
const INVOICE_GROSS_PRICED = invoice({
  id: 'inv_00000000b6',
  number: 'SZ-2026-00015',
  lines: [
    line({
      lineNo: 1, description: 'Ajándékcsomag', quantity: '3', unit: 'db', unitPrice: '12700', priceBasis: 'gross', vatCode: '27', nature: 'PRODUCT',
      netUnitPrice: '10000', netAmount: '30000', vatAmount: '8100', grossAmount: '38100',
    }),
    line({
      lineNo: 2, description: 'Kerek bruttó árú termék', quantity: '1', unit: 'db', unitPrice: '1000', priceBasis: 'gross', vatCode: '27', nature: 'PRODUCT',
      netUnitPrice: GROSS_NET_UNIT, netAmount: '787', vatAmount: '213', grossAmount: '1000',
    }),
  ],
});

const TAM_REASON = 'Áfa tv. 85. § (1) e) – iskolarendszeren kívüli felnőttképzés';

const INVOICE_TAM = invoice({
  id: 'inv_00000000b7',
  number: 'SZ-2026-00016',
  lines: [
    line({
      lineNo: 1, description: 'Excel tanfolyam (8 óra)', quantity: '8', unit: 'óra', vatCode: 'TAM', vatReason: TAM_REASON, nature: 'SERVICE',
      netUnitPrice: '12500', netAmount: '100000', vatAmount: '0', grossAmount: '100000',
    }),
  ],
});

const INVOICE_FAD = invoice({
  id: 'inv_00000000b8',
  number: 'SZ-2026-00017',
  lines: [
    line({
      lineNo: 1, description: 'Építési-szerelési munka (Áfa tv. 142. § (1) b))', quantity: '5', unit: 'nap', vatCode: 'FAD', nature: 'SERVICE',
      netUnitPrice: '80000', netAmount: '400000', vatAmount: '0', grossAmount: '400000',
    }),
  ],
});

const INVOICE_MARGIN = invoice({
  id: 'inv_00000000b9',
  number: 'SZ-2026-00018',
  customer: CUSTOMER_PRIVATE,
  paymentMethod: 'CASH',
  dueDate: '2026-10-27',
  lines: [
    line({
      lineNo: 1, description: 'Használt kerékpár (Csepel, 2019)', quantity: '1', unit: 'db', vatCode: 'KUL_HASZNALT', nature: 'PRODUCT',
      netUnitPrice: '80000', netAmount: '80000', vatAmount: '0', grossAmount: '80000',
    }),
  ],
});

const INVOICE_SELLER_FLAGS = invoice({
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000c1',
  number: 'SZ-2026-00019',
  seller: { ...SELLER_NORMAL, cashAccounting: true, smallBusiness: true },
  appearance: 'PAPER',
  lines: INVOICE_DOMESTIC.lines,
});

const SCENARIOS: Record<string, Invoice> = {
  INVOICE_DOMESTIC,
  INVOICE_PRIVATE_AAM,
  INVOICE_EU_SERVICE,
  INVOICE_STORNO,
  INVOICE_ADVANCE,
  INVOICE_FINAL,
  INVOICE_MODIFICATION,
  INVOICE_THIRD_COUNTRY,
  INVOICE_GROUP_MEMBER,
  INVOICE_GROSS_PRICED,
  INVOICE_TAM,
  INVOICE_FAD,
  INVOICE_MARGIN,
  INVOICE_SELLER_FLAGS,
};

// ---------------------------------------------------------------------------------------------
// XML inspection helpers
// ---------------------------------------------------------------------------------------------

const valueParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true, ignoreDeclaration: true });
const orderedParser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, ignoreDeclaration: true });

type O = Record<string, unknown>;
type ONode = Record<string, unknown>;

/** Parsed InvoiceData (namespace prefixes removed, values as strings). */
function data(xml: string): O {
  return (valueParser.parse(xml) as { InvoiceData: O }).InvoiceData;
}

function get(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const idx = /^\d+$/.test(key) ? Number(key) : null;
    if (idx !== null) cur = (Array.isArray(cur) ? cur : [cur])[idx];
    else cur = (cur as O)[key];
  }
  return cur;
}

function list(o: unknown, path: string): O[] {
  const v = get(o, path);
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as O[];
}

function tagOf(n: ONode): string | null {
  const k = Object.keys(n).find((key) => key !== ':@');
  return k && k !== '#text' ? k : null;
}

function kids(n: ONode): ONode[] {
  const t = tagOf(n);
  return t ? (n[t] as ONode[]) : [];
}

function ordered(xml: string): ONode[] {
  return orderedParser.parse(xml) as ONode[];
}

/** Child element names of the first element at a slash path (prefixes removed). */
function childNames(xml: string, path: string): string[] {
  let nodes = ordered(xml);
  let node: ONode | null = null;
  for (const seg of path.split('/')) {
    node = nodes.find((n) => tagOf(n) === seg) ?? null;
    if (!node) return [];
    nodes = kids(node);
  }
  return node ? kids(node).map(tagOf).filter((t): t is string => t !== null) : [];
}

/** All element paths ("InvoiceData/invoiceMain/…") of a document. */
function elementPaths(xml: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: ONode[], prefix: string): void => {
    for (const n of nodes) {
      const t = tagOf(n);
      if (!t) continue;
      const p = prefix ? `${prefix}/${t}` : t;
      out.add(p);
      walk(kids(n), p);
    }
  };
  walk(ordered(xml), '');
  return out;
}

const SAMPLES = new URL('../../vendor/nav-online-invoice/samples/data/', import.meta.url);
const sample = (file: string): string => readFileSync(new URL(file, SAMPLES), 'utf8');

const HEAD = 'InvoiceData/invoiceMain/invoice/invoiceHead';
const LINE = 'InvoiceData/invoiceMain/invoice/invoiceLines/line';
const INV = 'invoiceMain.invoice';

/** VatRateType identity as NAV groups it (exemption / out-of-scope by case, not by reason text). */
function vatRateKey(rate: unknown): string {
  const r = (rate ?? {}) as O;
  if (r.vatPercentage !== undefined) return `pct:${dec(String(r.vatPercentage)).toString()}`;
  if (r.vatExemption !== undefined) return `ex:${String(get(r, 'vatExemption.case'))}`;
  if (r.vatOutOfScope !== undefined) return `oos:${String(get(r, 'vatOutOfScope.case'))}`;
  if (r.vatDomesticReverseCharge !== undefined) return 'fad';
  if (r.marginSchemeIndicator !== undefined) return `margin:${String(r.marginSchemeIndicator)}`;
  return JSON.stringify(r);
}

/**
 * NAV's arithmetic WARN validations (spec annex I.2 / I.4) re-implemented on a finished report:
 * per line 740 (qty × unit price ≈ net), 741/743/751 (× exchange rate ≈ HUF), 745 (unit price HUF),
 * 754 (net HUF + VAT HUF = gross HUF); per VAT rate 435/734 (rate present in lines and summary),
 * 820/821 (Σ lines = summary row), 890/891 (net × rate ≈ VAT); totals 840/841, 850/860, 880/881,
 * 1070/1071. Tolerance as NAV: 1% of the calculated HUF value, but at least 1 HUF and 0.01 unit
 * of the invoice currency, whichever is greater.
 */
function navArithmeticWarnings(xml: string): string[] {
  const d = data(xml);
  const n = (v: unknown): DecValue => dec(String(v ?? '0'));
  const rate = n(get(d, `${INV}.invoiceHead.invoiceDetail.exchangeRate`));
  const out: string[] = [];
  const huf = (id: string, calcHuf: DecValue, actualHuf: DecValue): void => {
    const tolerance = D.max(calcHuf.abs().times('0.01'), 1, rate.times('0.01'));
    if (calcHuf.minus(actualHuf).abs().gt(tolerance)) out.push(`${id}: expected ≈${calcHuf.toString()}, got ${actualHuf.toString()}`);
  };
  const cur = (id: string, calc: DecValue, actual: DecValue): void => huf(id, calc.times(rate), actual.times(rate));
  const zero = (): Record<'net' | 'netHuf' | 'vat' | 'vatHuf', DecValue> => ({ net: new D(0), netHuf: new D(0), vat: new D(0), vatHuf: new D(0) });

  const byRate = new Map<string, ReturnType<typeof zero>>();
  for (const l of list(d, `${INV}.invoiceLines.line`)) {
    const a = l.lineAmountsNormal as O;
    const net = n(get(a, 'lineNetAmountData.lineNetAmount'));
    const netHuf = n(get(a, 'lineNetAmountData.lineNetAmountHUF'));
    const vat = n(get(a, 'lineVatData.lineVatAmount'));
    const vatHuf = n(get(a, 'lineVatData.lineVatAmountHUF'));
    const grossHuf = n(get(a, 'lineGrossAmountData.lineGrossAmountNormalHUF'));
    if (l.quantity !== undefined && l.unitPrice !== undefined) cur('740', n(l.quantity).times(n(l.unitPrice)), net);
    huf('741', net.times(rate), netHuf);
    huf('743', vat.times(rate), vatHuf);
    if (l.unitPriceHUF !== undefined) huf('745', n(l.unitPrice).times(rate), n(l.unitPriceHUF));
    huf('751', n(get(a, 'lineGrossAmountData.lineGrossAmountNormal')).times(rate), grossHuf);
    huf('754', netHuf.plus(vatHuf), grossHuf);
    const key = vatRateKey(a.lineVatRate);
    const s = byRate.get(key) ?? zero();
    byRate.set(key, { net: s.net.plus(net), netHuf: s.netHuf.plus(netHuf), vat: s.vat.plus(vat), vatHuf: s.vatHuf.plus(vatHuf) });
  }

  const summary = get(d, `${INV}.invoiceSummary.summaryNormal`) as O;
  const total = zero();
  const seen = new Set<string>();
  for (const row of list(summary, 'summaryByVatRate')) {
    const key = vatRateKey(row.vatRate);
    seen.add(key);
    const s = byRate.get(key);
    if (!s) out.push(`734: summary rate ${key} has no line`);
    const net = n(get(row, 'vatRateNetData.vatRateNetAmount'));
    const netHuf = n(get(row, 'vatRateNetData.vatRateNetAmountHUF'));
    const vat = n(get(row, 'vatRateVatData.vatRateVatAmount'));
    const vatHuf = n(get(row, 'vatRateVatData.vatRateVatAmountHUF'));
    cur('820', (s ?? zero()).net, net);
    huf('821', (s ?? zero()).netHuf, netHuf);
    const pct = get(row, 'vatRate.vatPercentage');
    if (pct !== undefined) {
      cur('890', net.times(n(pct)), vat);
      huf('891', netHuf.times(n(pct)), vatHuf);
    }
    total.net = total.net.plus(net);
    total.netHuf = total.netHuf.plus(netHuf);
    total.vat = total.vat.plus(vat);
    total.vatHuf = total.vatHuf.plus(vatHuf);
  }
  for (const key of byRate.keys()) if (!seen.has(key)) out.push(`435: line rate ${key} missing from the summary`);
  const invNet = n(summary.invoiceNetAmount);
  const invNetHuf = n(summary.invoiceNetAmountHUF);
  const invVat = n(summary.invoiceVatAmount);
  const invVatHuf = n(summary.invoiceVatAmountHUF);
  cur('840', total.net, invNet);
  huf('841', total.netHuf, invNetHuf);
  cur('850', total.vat, invVat);
  huf('860', total.vatHuf, invVatHuf);
  cur('880', invNet.plus(invVat), n(get(d, `${INV}.invoiceSummary.summaryGrossData.invoiceGrossAmount`)));
  huf('881', invNetHuf.plus(invVatHuf), n(get(d, `${INV}.invoiceSummary.summaryGrossData.invoiceGrossAmountHUF`)));
  huf('1071', invNet.times(rate), invNetHuf);
  huf('1070', invVat.times(rate), invVatHuf);
  return out;
}

function expectDataError(fn: () => unknown, code = 'NAV_DATA_INVALID'): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error('expected an AppError');
}

// ---------------------------------------------------------------------------------------------

describe('buildInvoiceDataXml – XSD validity of every scenario', () => {
  it.each(Object.keys(SCENARIOS))('%s is valid against invoiceData.xsd', async (name) => {
    const xml = buildInvoiceDataXml(SCENARIOS[name] as Invoice);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const res = await validateNavXml(xml, 'data');
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('the official samples use only element paths we also know (structure sanity check)', () => {
    // Every element path we emit must also appear in at least one official NAV sample, except
    // individualExemption and base:simpleAddress (the samples only use detailedAddress; the spec,
    // chapter 2.1.3.1, explicitly allows simpleAddress when the address is not broken down).
    const known = new Set<string>();
    for (const f of readdirSync(SAMPLES).filter((x) => x.endsWith('.xml'))) for (const p of elementPaths(sample(f))) known.add(p);
    const ours = new Set<string>();
    for (const inv of Object.values(SCENARIOS)) for (const p of elementPaths(buildInvoiceDataXml(inv))) ours.add(p);
    const unknown = [...ours].filter((p) => !known.has(p)).sort();
    const simple = (party: string): string[] =>
      ['', '/additionalAddressDetail', '/city', '/countryCode', '/postalCode'].map((x) => `${HEAD}/${party}/simpleAddress${x}`);
    expect(unknown).toEqual([...simple('customerInfo/customerAddress'), `${HEAD}/supplierInfo/individualExemption`, ...simple('supplierInfo/supplierAddress')]);
  });

  it.each(Object.keys(SCENARIOS))('%s trips none of NAV’s arithmetic warnings (740–1071)', (name) => {
    expect(navArithmeticWarnings(buildInvoiceDataXml(SCENARIOS[name] as Invoice))).toEqual([]);
  });

  it('the arithmetic check itself catches inconsistent numbers', () => {
    const broken: Invoice = { ...INVOICE_EU_SERVICE, lines: INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, netAmountHuf: '300000' })) };
    expect(navArithmeticWarnings(buildInvoiceDataXml(broken)).map((w) => w.slice(0, 4))).toEqual(['741:', '754:', '821:']);
  });
});

describe('buildInvoiceDataXml – semantics', () => {
  it('domestic B2B invoice (INVOICE_DOMESTIC)', () => {
    const xml = buildInvoiceDataXml(INVOICE_DOMESTIC);
    const d = data(xml);
    expect(get(d, 'invoiceNumber')).toBe('SZ-2026-00001');
    expect(get(d, 'invoiceIssueDate')).toBe('2026-10-27');
    expect(get(d, 'completenessIndicator')).toBe('false');
    expect(get(d, `${INV}.invoiceReference`)).toBeUndefined();

    const supplier = get(d, `${INV}.invoiceHead.supplierInfo`);
    expect(get(supplier, 'supplierTaxNumber')).toEqual({ taxpayerId: '12345676', vatCode: '2', countyCode: '42' });
    expect(get(supplier, 'communityVatNumber')).toBe('HU12345676');
    expect(get(supplier, 'supplierName')).toBe('Példa Szoftver Kft.');
    expect(get(supplier, 'supplierAddress.simpleAddress')).toEqual({
      countryCode: 'HU', postalCode: '1117', city: 'Budapest', additionalAddressDetail: 'Irinyi József utca 4-20.',
    });
    expect(get(supplier, 'supplierBankAccountNumber')).toBe('12345676-11111111');
    expect(get(supplier, 'individualExemption')).toBeUndefined();

    const customer = get(d, `${INV}.invoiceHead.customerInfo`);
    expect(get(customer, 'customerVatStatus')).toBe('DOMESTIC');
    expect(get(customer, 'customerVatData.customerTaxNumber')).toEqual({ taxpayerId: '87654323', vatCode: '2', countyCode: '13' });
    expect(get(customer, 'customerName')).toBe('Árvíztűrő Tükörfúrógép Zrt.');
    expect(get(customer, 'customerAddress.simpleAddress.additionalAddressDetail')).toBe('Október huszonharmadika utca 18.');

    const detail = get(d, `${INV}.invoiceHead.invoiceDetail`);
    expect(detail).toMatchObject({
      invoiceCategory: 'NORMAL', invoiceDeliveryDate: '2026-10-27', currencyCode: 'HUF', exchangeRate: '1',
      paymentMethod: 'TRANSFER', paymentDate: '2026-11-04', invoiceAppearance: 'ELECTRONIC',
    });
    expect(get(detail, 'conventionalInvoiceInfo.orderNumbers.orderNumber')).toBe('PO-7781');
    expect(get(detail, 'smallBusinessIndicator')).toBeUndefined();
    expect(get(detail, 'cashAccountingIndicator')).toBeUndefined();

    expect(get(d, `${INV}.invoiceLines.mergedItemIndicator`)).toBe('false');
    const lines = list(d, `${INV}.invoiceLines.line`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      lineNumber: '1', lineExpressionIndicator: 'true', lineNatureIndicator: 'SERVICE', lineDescription: 'Szoftverfejlesztés – október',
      quantity: '10', unitOfMeasure: 'HOUR', unitPrice: '15000', unitPriceHUF: '15000',
    });
    expect(get(lines[0], 'lineAmountsNormal')).toEqual({
      lineNetAmountData: { lineNetAmount: '150000', lineNetAmountHUF: '150000' },
      lineVatRate: { vatPercentage: '0.27' },
      lineVatData: { lineVatAmount: '40500', lineVatAmountHUF: '40500' },
      lineGrossAmountData: { lineGrossAmountNormal: '190500', lineGrossAmountNormalHUF: '190500' },
    });
    expect(lines[1]).toMatchObject({ lineNatureIndicator: 'PRODUCT', unitOfMeasure: 'PIECE', quantity: '2' });
    expect(get(lines[1], 'lineAmountsNormal.lineVatRate.vatPercentage')).toBe('0.05');
    expect(get(lines[0], 'advanceData')).toBeUndefined();
    expect(get(lines[0], 'lineModificationReference')).toBeUndefined();

    const rows = list(d, `${INV}.invoiceSummary.summaryNormal.summaryByVatRate`);
    expect(rows.map((r) => get(r, 'vatRate.vatPercentage'))).toEqual(['0.27', '0.05']); // order of totals.byVat
    expect(get(rows[1], 'vatRateNetData')).toEqual({ vatRateNetAmount: '4000', vatRateNetAmountHUF: '4000' });
    expect(get(d, `${INV}.invoiceSummary.summaryNormal`)).toMatchObject({
      invoiceNetAmount: '154000', invoiceNetAmountHUF: '154000', invoiceVatAmount: '40700', invoiceVatAmountHUF: '40700',
    });
    expect(get(d, `${INV}.invoiceSummary.summaryGrossData`)).toEqual({ invoiceGrossAmount: '194700', invoiceGrossAmountHUF: '194700' });
    expect(navOperationFor(INVOICE_DOMESTIC)).toBe('CREATE');
  });

  it('private person: only customerVatStatus is reported (no name, address or tax data)', () => {
    const xml = buildInvoiceDataXml(INVOICE_PRIVATE_AAM);
    expect(childNames(xml, `${HEAD}/customerInfo`)).toEqual(['customerVatStatus']);
    expect(childNames(xml, `${HEAD}/customerInfo`)).toEqual(childNames(sample('belfoldi-termekertekesites-maganszemelynek.xml'), `${HEAD}/customerInfo`));
    expect(xml).not.toContain('customerName');
    expect(xml).not.toContain('customerAddress');
    expect(xml).not.toContain('Szőke Őrs');
    expect(xml).not.toContain('Debrecen');
    expect(xml).not.toContain('Piac utca');
    const d = data(xml);
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerVatStatus`)).toBe('PRIVATE_PERSON');
    // alanyi adómentes seller
    expect(get(d, `${INV}.invoiceHead.supplierInfo.individualExemption`)).toBe('true');
    expect(get(d, `${INV}.invoiceHead.supplierInfo.communityVatNumber`)).toBeUndefined();
    const lineRate = get(d, `${INV}.invoiceLines.line.lineAmountsNormal.lineVatRate`);
    expect(lineRate).toEqual({ vatExemption: { case: 'AAM', reason: getVatInfo('AAM').notationHu } });
    expect(get(d, `${INV}.invoiceSummary.summaryNormal.summaryByVatRate.vatRate`)).toEqual(lineRate);
    expect(get(d, `${INV}.invoiceHead.invoiceDetail.paymentMethod`)).toBe('CASH');
    // the gross total, not the 0/5 Ft rounded cash payable amount (25 000)
    expect(get(d, `${INV}.invoiceSummary.summaryGrossData.invoiceGrossAmount`)).toBe('24998');
    // fulfilment date ≠ issue date
    expect(get(d, `${INV}.invoiceHead.invoiceDetail.invoiceDeliveryDate`)).toBe('2026-10-25');
  });

  it('EU service: OTHER + communityVatNumber, EUR with exchange rate, EUFAD37 out of scope', () => {
    const xml = buildInvoiceDataXml(INVOICE_EU_SERVICE);
    const sampleXml = sample('tagorszagi-devizas-szamla.xml');
    expect(childNames(xml, `${HEAD}/customerInfo`)).toEqual(childNames(sampleXml, `${HEAD}/customerInfo`));
    expect(childNames(xml, `${HEAD}/customerInfo/customerVatData`)).toEqual(['communityVatNumber']);
    expect(childNames(xml, `${LINE}/lineAmountsNormal`)).toEqual(childNames(sampleXml, `${LINE}/lineAmountsNormal`));
    const d = data(xml);
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerVatData.communityVatNumber`)).toBe('DE123456789');
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerAddress.simpleAddress.countryCode`)).toBe('DE');
    expect(get(d, `${INV}.invoiceHead.invoiceDetail`)).toMatchObject({ currencyCode: 'EUR', exchangeRate: '390.12', invoiceDeliveryDate: '2026-10-24' });
    const l = list(d, `${INV}.invoiceLines.line`)[0];
    expect(l).toMatchObject({ unitPrice: '80', unitPriceHUF: '31209.6', quantity: '10', unitOfMeasure: 'HOUR' });
    expect(get(l, 'lineAmountsNormal.lineNetAmountData')).toEqual({ lineNetAmount: '800', lineNetAmountHUF: '312096' });
    // reason = the catalog notation (the printed one), as no line override is given
    expect(get(l, 'lineAmountsNormal.lineVatRate.vatOutOfScope')).toEqual({ case: 'EUFAD37', reason: getVatInfo('EUFAD37').notationHu });
  });

  it('storno: invoiceReference + CREATE line references continuing the original numbering, negated amounts', () => {
    const xml = buildInvoiceDataXml(INVOICE_STORNO);
    const sampleXml = sample('modositas-es-ervenytelenites-1.xml');
    expect(childNames(xml, 'InvoiceData/invoiceMain/invoice')[0]).toBe('invoiceReference');
    expect(childNames(xml, 'InvoiceData/invoiceMain/invoice/invoiceReference')).toEqual(childNames(sampleXml, 'InvoiceData/invoiceMain/invoice/invoiceReference'));
    expect(childNames(xml, `${LINE}/lineModificationReference`)).toEqual(childNames(sampleXml, `${LINE}/lineModificationReference`));
    const d = data(xml);
    expect(get(d, `${INV}.invoiceReference`)).toEqual({ originalInvoiceNumber: 'SZ-2026-00001', modifyWithoutMaster: 'false', modificationIndex: '1' });
    const lines = list(d, `${INV}.invoiceLines.line`);
    expect(lines.map((l) => get(l, 'lineNumber'))).toEqual(['1', '2']);
    expect(lines.map((l) => get(l, 'lineModificationReference'))).toEqual([
      { lineNumberReference: '3', lineOperation: 'CREATE' },
      { lineNumberReference: '4', lineOperation: 'CREATE' },
    ]);
    expect(lines.map((l) => get(l, 'quantity'))).toEqual(['-10', '-2']);
    expect(get(lines[0], 'unitPrice')).toBe('15000');
    expect(get(lines[0], 'lineAmountsNormal.lineGrossAmountData.lineGrossAmountNormal')).toBe('-190500');
    expect(get(d, `${INV}.invoiceSummary.summaryGrossData.invoiceGrossAmount`)).toBe('-194700');
    expect(navOperationFor(INVOICE_STORNO)).toBe('STORNO');
  });

  it('advance invoice: every line advanceIndicator=true without advancePaymentData', () => {
    const xml = buildInvoiceDataXml(INVOICE_ADVANCE);
    expect(childNames(xml, `${LINE}/advanceData`)).toEqual(childNames(sample('belfoldi-elolegszamla.xml'), `${LINE}/advanceData`));
    const lines = list(data(xml), `${INV}.invoiceLines.line`);
    for (const l of lines) expect(get(l, 'advanceData')).toEqual({ advanceIndicator: 'true' });
    expect(navOperationFor(INVOICE_ADVANCE)).toBe('CREATE');
  });

  it('final invoice: the deduction line carries advanceIndicator + advancePaymentData, others nothing', () => {
    const xml = buildInvoiceDataXml(INVOICE_FINAL);
    const lines = list(data(xml), `${INV}.invoiceLines.line`);
    expect(get(lines[0], 'advanceData')).toBeUndefined();
    expect(get(lines[1], 'advanceData')).toEqual({
      advanceIndicator: 'true',
      advancePaymentData: { advanceOriginalInvoice: 'SZ-2026-00010', advancePaymentDate: '2026-10-05', advanceExchangeRate: '1' },
    });
    expect(get(lines[1], 'quantity')).toBe('-1');
    expect(get(lines[1], 'lineAmountsNormal.lineNetAmountData.lineNetAmount')).toBe('-500000');
    expect(get(data(xml), `${INV}.invoiceSummary.summaryNormal.invoiceNetAmount`)).toBe('100000');
    expect(navOperationFor(INVOICE_FINAL)).toBe('CREATE');
  });

  it('final invoice advanceData has the same structure as the official final-invoice sample', () => {
    const deduction: InvoiceLine = { ...(INVOICE_FINAL.lines[1] as InvoiceLine), lineNo: 1 };
    const ours = buildInvoiceDataXml({ ...INVOICE_FINAL, lines: [deduction], totals: totalsOf([deduction]) });
    const theirs = sample('belfoldi-vegszamla.xml').replace(/<line>[\s\S]*?<\/line>/, ''); // drop the sample's 1st (normal) line
    expect(childNames(ours, `${LINE}/advanceData`)).toEqual(childNames(theirs, `${LINE}/advanceData`));
    expect(childNames(ours, `${LINE}/advanceData/advancePaymentData`)).toEqual(childNames(theirs, `${LINE}/advanceData/advancePaymentData`));
  });

  it('modification: invoiceReference, delta lines as CREATE lines continuing the chain, own unit of measure', () => {
    const xml = buildInvoiceDataXml(INVOICE_MODIFICATION);
    const d = data(xml);
    expect(get(d, `${INV}.invoiceReference.originalInvoiceNumber`)).toBe('SZ-2026-00001');
    const lines = list(d, `${INV}.invoiceLines.line`);
    expect(lines.map((l) => get(l, 'lineModificationReference'))).toEqual([
      { lineNumberReference: '3', lineOperation: 'CREATE' },
      { lineNumberReference: '4', lineOperation: 'CREATE' },
    ]);
    expect(lines[0]).toMatchObject({ quantity: '-2', unitOfMeasure: 'HOUR' });
    expect(lines[1]).toMatchObject({ unitOfMeasure: 'OWN', unitOfMeasureOwn: 'alkalom' });
    expect(get(d, `${INV}.invoiceSummary.summaryNormal.invoiceNetAmount`)).toBe('-20000');
    expect(navOperationFor(INVOICE_MODIFICATION)).toBe('MODIFY');
  });

  it('third-country customer: thirdStateTaxId, USD, unitPriceHUF = unitPrice × exchangeRate, EAM exemption', () => {
    const xml = buildInvoiceDataXml(INVOICE_THIRD_COUNTRY);
    expect(childNames(xml, `${HEAD}/customerInfo/customerVatData`)).toEqual(childNames(sample('harmadik-orszagbeli-devizas-szamla.xml'), `${HEAD}/customerInfo/customerVatData`));
    const d = data(xml);
    const customer = get(d, `${INV}.invoiceHead.customerInfo`);
    expect(get(customer, 'customerVatStatus')).toBe('OTHER');
    expect(get(customer, 'customerVatData')).toEqual({ thirdStateTaxId: 'RS 101234567' });
    expect(get(customer, 'customerAddress.simpleAddress.countryCode')).toBe('RS'); // upper-cased
    expect(get(d, `${INV}.invoiceHead.invoiceDetail`)).toMatchObject({ currencyCode: 'USD', exchangeRate: '365.5' });
    const l = list(d, `${INV}.invoiceLines.line`)[0];
    expect(l).toMatchObject({ unitPrice: '1250.5', unitPriceHUF: '457057.75' });
    expect(get(l, 'lineAmountsNormal.lineNetAmountData')).toEqual({ lineNetAmount: '2501', lineNetAmountHUF: '914115.5' });
    expect(get(l, 'lineAmountsNormal.lineVatRate.vatExemption.case')).toBe('EAM');
  });

  it('VAT group member supplier and customer', () => {
    const xml = buildInvoiceDataXml(INVOICE_GROUP_MEMBER);
    const sampleXml = sample('belfoldi-termekertekesites-afa-csoportok-kozott.xml');
    expect(childNames(xml, `${HEAD}/supplierInfo`).slice(0, 2)).toEqual(childNames(sampleXml, `${HEAD}/supplierInfo`).slice(0, 2));
    expect(childNames(xml, `${HEAD}/customerInfo/customerVatData/customerTaxNumber`)).toEqual(
      childNames(sampleXml, `${HEAD}/customerInfo/customerVatData/customerTaxNumber`),
    );
    const d = data(xml);
    const supplier = get(d, `${INV}.invoiceHead.supplierInfo`);
    expect(get(supplier, 'supplierTaxNumber')).toEqual({ taxpayerId: '17781781', vatCode: '5', countyCode: '44' });
    expect(get(supplier, 'groupMemberTaxNumber')).toEqual({ taxpayerId: '12345676', vatCode: '4', countyCode: '42' });
    expect(get(supplier, 'communityVatNumber')).toBe('HU17781781');
    expect(get(supplier, 'supplierBankAccountNumber')).toBe('HU42117730161111101800000000'); // IBAN without spaces
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerVatData.customerTaxNumber`)).toEqual({
      taxpayerId: '22223333', vatCode: '5', countyCode: '41',
      groupMemberTaxNumber: { taxpayerId: '87654323', vatCode: '4', countyCode: '13' },
    });
  });

  it('gross-priced lines report the derived net unit price (≤ 10 decimals)', () => {
    const d = data(buildInvoiceDataXml(INVOICE_GROSS_PRICED));
    const lines = list(d, `${INV}.invoiceLines.line`);
    expect(lines[0]).toMatchObject({ unitPrice: '10000', unitPriceHUF: '10000', quantity: '3' });
    expect(get(lines[0], 'lineAmountsNormal.lineGrossAmountData.lineGrossAmountNormal')).toBe('38100');
    expect(GROSS_NET_UNIT.length).toBeGreaterThan(20);
    expect(lines[1]).toMatchObject({ unitPrice: '787.4015748031', unitPriceHUF: '787.4015748031' });
    expect(get(lines[1], 'lineAmountsNormal.lineNetAmountData.lineNetAmount')).toBe('787');
  });

  it('TAM with a custom vatReason (line and summary), long reasons cut to 200 characters', () => {
    const d = data(buildInvoiceDataXml(INVOICE_TAM));
    const expected = { vatExemption: { case: 'TAM', reason: TAM_REASON } };
    expect(get(d, `${INV}.invoiceLines.line.lineAmountsNormal.lineVatRate`)).toEqual(expected);
    expect(get(d, `${INV}.invoiceSummary.summaryNormal.summaryByVatRate.vatRate`)).toEqual(expected);

    const long = `${'Áfa tv. 85. § (1) e) '.repeat(15)}\nvége`;
    const inv = { ...INVOICE_TAM, lines: INVOICE_TAM.lines.map((l) => ({ ...l, vatReason: long })) };
    const reason = get(data(buildInvoiceDataXml(inv)), `${INV}.invoiceLines.line.lineAmountsNormal.lineVatRate.vatExemption.reason`) as string;
    expect(Array.from(reason).length).toBeLessThanOrEqual(200);
    expect(reason.startsWith('Áfa tv. 85. § (1) e) Áfa tv.')).toBe(true);
    expect(reason).not.toMatch(/[\r\n]/);
  });

  it('domestic reverse charge (FAD): vatDomesticReverseCharge=true with zero VAT', () => {
    const d = data(buildInvoiceDataXml(INVOICE_FAD));
    const l = list(d, `${INV}.invoiceLines.line`)[0];
    expect(get(l, 'lineAmountsNormal.lineVatRate')).toEqual({ vatDomesticReverseCharge: 'true' });
    expect(get(l, 'lineAmountsNormal.lineVatData')).toEqual({ lineVatAmount: '0', lineVatAmountHUF: '0' });
    expect(get(d, `${INV}.invoiceSummary.summaryNormal.summaryByVatRate.vatRate`)).toEqual({ vatDomesticReverseCharge: 'true' });
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerVatData.customerTaxNumber.taxpayerId`)).toBe('87654323');
  });

  it('margin scheme (used goods) to a private person', () => {
    const xml = buildInvoiceDataXml(INVOICE_MARGIN);
    const d = data(xml);
    expect(get(d, `${INV}.invoiceLines.line.lineAmountsNormal.lineVatRate`)).toEqual({ marginSchemeIndicator: 'SECOND_HAND' });
    expect(get(d, `${INV}.invoiceSummary.summaryNormal.summaryByVatRate.vatRate`)).toEqual({ marginSchemeIndicator: 'SECOND_HAND' });
    expect(childNames(xml, `${HEAD}/customerInfo`)).toEqual(['customerVatStatus']);
  });

  it('seller flags: smallBusinessIndicator and cashAccountingIndicator only when true', () => {
    const detail = get(data(buildInvoiceDataXml(INVOICE_SELLER_FLAGS)), `${INV}.invoiceHead.invoiceDetail`);
    expect(detail).toMatchObject({ smallBusinessIndicator: 'true', cashAccountingIndicator: 'true', invoiceAppearance: 'PAPER' });
  });

  it('cashAccountingIndicator follows the printed notation: not for exempt / out-of-scope / reverse-charge only invoices', () => {
    const cashSeller = { ...SELLER_NORMAL, cashAccounting: true };
    const indicator = (inv: Invoice): unknown => get(data(buildInvoiceDataXml({ ...inv, seller: cashSeller })), `${INV}.invoiceHead.invoiceDetail.cashAccountingIndicator`);
    expect(indicator(INVOICE_DOMESTIC)).toBe('true');
    // „pénzforgalmi elszámolás” is not printed on these (core/calc.ts buildNotations) – the report must agree
    expect(indicator(INVOICE_TAM)).toBeUndefined();
    expect(indicator(INVOICE_EU_SERVICE)).toBeUndefined();
    expect(indicator(INVOICE_FAD)).toBeUndefined();
    expect(indicator(INVOICE_MARGIN)).toBeUndefined();
  });

  it('completenessIndicator option', () => {
    expect(get(data(buildInvoiceDataXml(INVOICE_DOMESTIC, { completenessIndicator: true })), 'completenessIndicator')).toBe('true');
  });
});

describe('buildInvoiceDataXml – escaping and normalisation', () => {
  it('special characters and line breaks in free text stay schema-valid', async () => {
    const description = `Kábel <3x2.5> & "dugó" 'bónusz'\nmásodik sor\ttabbal`;
    const inv: Invoice = {
      ...INVOICE_DOMESTIC,
      seller: { ...SELLER_NORMAL, name: 'Kovács & Fia <Bt.>' },
      customer: { ...CUSTOMER_DOMESTIC, name: 'A "Legjobb" Kft.', address: { ...CUSTOMER_DOMESTIC.address, addressLine: "O'Brien tér 1.\n2. em." } },
      lines: INVOICE_DOMESTIC.lines.map((l, i) => (i === 0 ? { ...l, description } : l)),
    };
    const xml = buildInvoiceDataXml(inv);
    expect(xml).toContain('Kovács &amp; Fia &lt;Bt.&gt;');
    const res = await validateNavXml(xml, 'data');
    expect(res.errors).toEqual([]);
    const d = data(xml);
    expect(get(d, `${INV}.invoiceHead.supplierInfo.supplierName`)).toBe('Kovács & Fia <Bt.>');
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerName`)).toBe('A "Legjobb" Kft.');
    expect(list(d, `${INV}.invoiceLines.line`)[0]?.lineDescription).toBe(`Kábel <3x2.5> & "dugó" 'bónusz' második sor tabbal`);
  });

  it('long descriptions are cut to 512 characters, postal codes normalised', async () => {
    const inv: Invoice = {
      ...INVOICE_EU_SERVICE,
      customer: { ...INVOICE_EU_SERVICE.customer, address: { ...INVOICE_EU_SERVICE.customer.address, countryCode: 'IE', postalCode: '' } },
      lines: INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, description: 'x'.repeat(600) })),
    };
    const xml = buildInvoiceDataXml(inv);
    expect((await validateNavXml(xml, 'data')).valid).toBe(true);
    const d = data(xml);
    expect((list(d, `${INV}.invoiceLines.line`)[0]?.lineDescription as string).length).toBe(512);
    expect(get(d, `${INV}.invoiceHead.customerInfo.customerAddress.simpleAddress.postalCode`)).toBe('0000');
  });

  it('amounts are rounded to the XSD fraction digits (money 2, quantity 10, rate 6)', async () => {
    const inv: Invoice = {
      ...INVOICE_EU_SERVICE,
      exchangeRate: '390.1234567',
      lines: INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, quantity: '0.123456789012', netAmount: '800.005' })),
    };
    const xml = buildInvoiceDataXml(inv);
    expect((await validateNavXml(xml, 'data')).valid).toBe(true);
    const d = data(xml);
    expect(get(d, `${INV}.invoiceHead.invoiceDetail.exchangeRate`)).toBe('390.123457');
    const l = list(d, `${INV}.invoiceLines.line`)[0];
    expect(get(l, 'quantity')).toBe('0.123456789');
    expect(get(l, 'lineAmountsNormal.lineNetAmountData.lineNetAmount')).toBe('800.01');
  });

  it('HUF invoices always report exchangeRate 1', () => {
    expect(get(data(buildInvoiceDataXml({ ...INVOICE_DOMESTIC, exchangeRate: '1.0' })), `${INV}.invoiceHead.invoiceDetail.exchangeRate`)).toBe('1');
  });

  it('supplier bank account is only sent when it matches BankAccountNumberType', () => {
    expect(navBankAccount('12345676-11111111')).toBe('12345676-11111111');
    expect(navBankAccount('1234567611111111')).toBe('12345676-11111111');
    expect(navBankAccount('12345676 11111111 22222222')).toBe('12345676-11111111-22222222');
    expect(navBankAccount('hu42 1177 3016 1111 1018 0000 0000')).toBe('HU42117730161111101800000000');
    expect(navBankAccount('123-456')).toBeNull();
    const xml = buildInvoiceDataXml({ ...INVOICE_DOMESTIC, seller: { ...SELLER_NORMAL, bankAccount: 'OTP 123' } });
    expect(xml).not.toContain('supplierBankAccountNumber');
  });

  it('splitHuTaxNumber', () => {
    expect(splitHuTaxNumber('12345676-2-42')).toEqual({ taxpayerId: '12345676', vatCode: '2', countyCode: '42' });
    expect(splitHuTaxNumber('12345676242')).toEqual({ taxpayerId: '12345676', vatCode: '2', countyCode: '42' });
    expect(splitHuTaxNumber('12345676')).toEqual({ taxpayerId: '12345676', vatCode: null, countyCode: null });
    expect(splitHuTaxNumber('HU12345676')).toEqual({ taxpayerId: '12345676', vatCode: null, countyCode: null });
    expect(splitHuTaxNumber('12345676-9-42')).toBeNull();
    expect(splitHuTaxNumber('1234')).toBeNull();
    expect(splitHuTaxNumber(undefined)).toBeNull();
  });
});

describe('buildInvoiceDataXml – refuses data NAV would reject', () => {
  it('proforma is not reportable', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, documentType: 'proforma' }), 'NAV_NOT_REPORTABLE');
    expectDataError(() => navOperationFor({ ...INVOICE_DOMESTIC, documentType: 'proforma' }), 'NAV_NOT_REPORTABLE');
  });

  it('missing invoice number', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, number: null }));
  });

  it('DOMESTIC customer without a Hungarian tax number', () => {
    const { taxNumber: _t, ...noTax } = CUSTOMER_DOMESTIC;
    void _t;
    const e = expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, customer: noTax }));
    expect(e.details).toEqual({ field: 'customer.taxNumber' });
  });

  it('invalid EU VAT number of an OTHER customer', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_EU_SERVICE, customer: { ...INVOICE_EU_SERVICE.customer, euVatNumber: '123456789' } }));
  });

  it('storno/modification line without lineModificationReference', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_STORNO, lines: INVOICE_STORNO.lines.map(({ modificationRef: _m, ...l }) => l) }));
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_STORNO, reference: null }));
  });

  it('a modifying document cannot reuse the original invoice number (NAV ERROR 66)', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_STORNO, number: 'SZ-2026-00001' }));
  });

  it('non-sequential line numbers', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, lines: INVOICE_DOMESTIC.lines.map((l, i) => ({ ...l, lineNo: i + 2 })) }));
  });

  it('invalid dates and exchange rates', () => {
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, fulfillmentDate: '2026-02-30' }));
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_EU_SERVICE, exchangeRate: '0' }));
  });
});

describe('buildInvoiceDataXml – NAV blocking validations (spec 3.3.2) are refused before sending', () => {
  /** Same invoice with recomputed totals (keeps every other check satisfied). */
  const withLines = (inv: Invoice, lines: InvoiceLine[]): Invoice => ({ ...inv, lines, totals: totalsOf(lines) });

  it('60 INVALID_LINE_OPERATION: a lineOperation=MODIFY reference is refused (NAV rejects every MODIFY line)', () => {
    const bad = withLines(
      INVOICE_MODIFICATION,
      INVOICE_MODIFICATION.lines.map((l, i) => (i === 0 ? { ...l, modificationRef: { lineNumberReference: 1, lineOperation: 'MODIFY' as const } } : l)),
    );
    const e = expectDataError(() => buildInvoiceDataXml(bad));
    expect(e.details).toEqual({ field: 'lines[0].modificationRef.lineOperation' });
    expect(e.message).toMatch(/INVALID_LINE_OPERATION/);
    expect(e.hint).toMatch(/CREATE/);
  });

  it('12 LINE_NUMBER_REFERENCE_NOT_UNIQUE: two lines of a correction may not reference the same line number', () => {
    const dup = withLines(INVOICE_STORNO, INVOICE_STORNO.lines.map((l) => ({ ...l, modificationRef: { lineNumberReference: 3, lineOperation: 'CREATE' as const } })));
    expect(expectDataError(() => buildInvoiceDataXml(dup)).details).toEqual({ field: 'lines[1].modificationRef' });
  });

  it('13 MANDATORY_LINE_CONTENT_MISSING: lineExpressionIndicator=true needs a description', () => {
    const blank = withLines(INVOICE_DOMESTIC, INVOICE_DOMESTIC.lines.map((l, i) => (i === 1 ? { ...l, description: ' \n ' } : l)));
    expect(expectDataError(() => buildInvoiceDataXml(blank)).details).toEqual({ field: 'lines[1].description' });
  });

  it('4 INVOICE_LINE_MISSING: an invoice or a storno without lines', () => {
    expect(expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, lines: [] })).details).toEqual({ field: 'lines' });
    expect(expectDataError(() => buildInvoiceDataXml({ ...INVOICE_STORNO, lines: [] })).details).toEqual({ field: 'lines' });
  });

  it('67–70, 73: the VAT case must fit the customer VAT status (CREATE, MODIFY), a storno is exempt', () => {
    const kbaet = (customer: CustomerData): Invoice =>
      withLines({ ...INVOICE_EU_SERVICE, customer }, INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, vatCode: 'KBAET' as const, nature: 'PRODUCT' as const })));
    expect(() => buildInvoiceDataXml(kbaet(INVOICE_EU_SERVICE.customer))).not.toThrow();
    expect(expectDataError(() => buildInvoiceDataXml(kbaet(CUSTOMER_DOMESTIC))).details).toEqual({ field: 'lines[0].vatCode' });
    expectDataError(() => buildInvoiceDataXml(kbaet(CUSTOMER_PRIVATE)));
    // KBAUK: a private person or OTHER, but not a domestic VAT payer
    const kbauk = withLines({ ...INVOICE_EU_SERVICE, customer: CUSTOMER_PRIVATE }, INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, vatCode: 'KBAUK' as const })));
    expect(() => buildInvoiceDataXml(kbauk)).not.toThrow();
    expectDataError(() => buildInvoiceDataXml({ ...kbauk, customer: CUSTOMER_DOMESTIC }));
    // EUFAD37 → OTHER only; FAD → DOMESTIC only
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_EU_SERVICE, customer: CUSTOMER_DOMESTIC }));
    expectDataError(() => buildInvoiceDataXml({ ...INVOICE_FAD, customer: INVOICE_EU_SERVICE.customer }));
    // NAV leaves STORNO out of these rules (old invoices must stay cancellable)
    const fadStorno = withLines(
      { ...INVOICE_STORNO, customer: INVOICE_EU_SERVICE.customer },
      INVOICE_STORNO.lines.map((l) => ({ ...l, vatCode: 'FAD' as const, vatAmount: '0', vatAmountHuf: '0', grossAmount: l.netAmount, grossAmountHuf: l.netAmountHuf })),
    );
    expect(() => buildInvoiceDataXml(fadStorno)).not.toThrow();
  });

  it('71/72/74/80: exempt and out-of-scope lines and summary rows may not carry VAT', () => {
    const tamWithVat = withLines(INVOICE_TAM, INVOICE_TAM.lines.map((l) => ({ ...l, vatAmount: '100', vatAmountHuf: '100', grossAmount: '100100', grossAmountHuf: '100100' })));
    expect(expectDataError(() => buildInvoiceDataXml(tamWithVat)).details).toEqual({ field: 'lines[0].vatAmount' });
    const summaryOnly: Invoice = { ...INVOICE_TAM, totals: { ...INVOICE_TAM.totals, byVat: INVOICE_TAM.totals.byVat.map((r) => ({ ...r, vatAmountHuf: '5' })) } };
    expect(expectDataError(() => buildInvoiceDataXml(summaryOnly)).details).toEqual({ field: 'totals.byVat[0].vatAmount' });
    // scope: 71/80 (exemption) do not run on STORNO, 72 (out-of-scope line) does
    expect(() => buildInvoiceDataXml({ ...tamWithVat, documentType: 'storno', number: 'SZ-2026-00099', reference: INVOICE_STORNO.reference, lines: tamWithVat.lines.map((l) => ({ ...l, modificationRef: { lineNumberReference: 3, lineOperation: 'CREATE' as const } })) })).not.toThrow();
    const outOfScopeStorno = withLines(
      { ...INVOICE_EU_SERVICE, documentType: 'storno', number: 'SZ-2026-00098', reference: { ...(INVOICE_STORNO.reference as NonNullable<Invoice['reference']>), originalInvoiceNumber: 'SZ-2026-00003' } },
      INVOICE_EU_SERVICE.lines.map((l) => ({ ...l, vatAmount: '1', vatAmountHuf: '390.12', modificationRef: { lineNumberReference: 2, lineOperation: 'CREATE' as const } })),
    );
    expect(expectDataError(() => buildInvoiceDataXml(outOfScopeStorno)).details).toEqual({ field: 'lines[0].vatAmount' });
  });

  it('14 INVALID_VAT_DATA: the 0% rate only for deliveries from 2024-01-01', () => {
    const zero = withLines(INVOICE_DOMESTIC, INVOICE_DOMESTIC.lines.map((l) => ({ ...l, vatCode: '0' as const, vatAmount: '0', vatAmountHuf: '0', grossAmount: l.netAmount, grossAmountHuf: l.netAmountHuf })));
    expect(() => buildInvoiceDataXml({ ...zero, fulfillmentDate: '2024-01-01' })).not.toThrow();
    expect(expectDataError(() => buildInvoiceDataXml({ ...zero, fulfillmentDate: '2023-12-31' })).details).toEqual({ field: 'lines[0].vatCode' });
  });

  it('54 INVOICE_DELIVERY_DATE_LATE: delivery at most 5 years after the issue date', () => {
    expect(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, fulfillmentDate: '2031-10-27' })).not.toThrow();
    expect(expectDataError(() => buildInvoiceDataXml({ ...INVOICE_DOMESTIC, fulfillmentDate: '2031-10-28' })).details).toEqual({ field: 'fulfillmentDate' });
  });

  it('76 MODIFICATIONINDEX_UNREAL: modificationIndex of a modification at most 1000', () => {
    const ref = INVOICE_MODIFICATION.reference as NonNullable<Invoice['reference']>;
    expect(() => buildInvoiceDataXml({ ...INVOICE_MODIFICATION, reference: { ...ref, modificationIndex: 1000 } })).not.toThrow();
    expect(expectDataError(() => buildInvoiceDataXml({ ...INVOICE_MODIFICATION, reference: { ...ref, modificationIndex: 1001 } })).details).toEqual({
      field: 'reference.modificationIndex',
    });
  });
});
