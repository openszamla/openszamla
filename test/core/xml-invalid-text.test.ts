/**
 * NAV-8: validation reads text the way the NAV report builder writes it (normalizeXmlText): characters XML
 * cannot carry are dropped, so a field made only of them fails as missing before issuing. Every field the
 * report requires (requiredText / identifier in src/nav/invoice-data.ts) has a validation rule that fails
 * whenever the builder would; text with an invalid character inside stays valid and is reported without it.
 * For an issued document the builder's hint never recommends a correction or a storno.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice, InvoiceLine } from '../../src/core/types.ts';
import { validateInvoice } from '../../src/core/validate.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

/** Nothing of it survives in XML: a noncharacter (a pasted UTF-16 byte order mark) and C0 controls. */
const INVALID_ONLY = '￾\u0002\u0003';
const TODAY = '2026-10-28';

const firstLine = (patch: Partial<InvoiceLine>): Invoice => ({ ...INVOICE_DOMESTIC, lines: INVOICE_DOMESTIC.lines.map((l, i) => (i === 0 ? { ...l, ...patch } : l)) });
const errorCodes = (inv: Invoice): string[] => validateInvoice(inv, { today: TODAY, original: null }).filter((i) => i.severity === 'error').map((i) => i.code);

const FIELDS: Array<[string, Invoice, string]> = [
  ['line description', firstLine({ description: INVALID_ONLY }), 'LINE_DESCRIPTION_REQUIRED'],
  ['seller name', { ...INVOICE_DOMESTIC, seller: { ...SELLER_NORMAL, name: INVALID_ONLY } }, 'SELLER_NAME_REQUIRED'],
  ['seller city', { ...INVOICE_DOMESTIC, seller: { ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, city: INVALID_ONLY } } }, 'SELLER_CITY_REQUIRED'],
  ['seller street', { ...INVOICE_DOMESTIC, seller: { ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, addressLine: INVALID_ONLY } } }, 'SELLER_ADDRESS_LINE_REQUIRED'],
  ['customer name', { ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, name: INVALID_ONLY } }, 'CUSTOMER_NAME_REQUIRED'],
  ['customer city', { ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, address: { ...CUSTOMER_DOMESTIC.address, city: INVALID_ONLY } } }, 'CUSTOMER_CITY_REQUIRED'],
  ['customer street', { ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, address: { ...CUSTOMER_DOMESTIC.address, addressLine: `\t${INVALID_ONLY} ` } } }, 'CUSTOMER_ADDRESS_LINE_REQUIRED'],
  ['invoice number', { ...INVOICE_DOMESTIC, number: INVALID_ONLY }, 'NUMBER_EMPTY'],
  ['original invoice number', { ...INVOICE_STORNO, reference: { ...(INVOICE_STORNO.reference as NonNullable<Invoice['reference']>), originalInvoiceNumber: INVALID_ONLY } }, 'REFERENCE_NUMBER_REQUIRED'],
  [
    'advance invoice number',
    {
      ...INVOICE_DOMESTIC,
      documentType: 'final',
      lines: INVOICE_DOMESTIC.lines.map((l, i) => (i === 1 ? { ...l, advanceDeduction: { advanceInvoiceNumber: INVALID_ONLY, advancePaymentDate: '2026-10-05', advanceExchangeRate: '1' } } : l)),
    },
    'LINE_ADVANCE_NUMBER_REQUIRED',
  ],
];

describe('NAV-8: a field that the report would leave empty fails validation', () => {
  it.each(FIELDS)('%s', (_name, inv, code) => {
    let built: unknown = null;
    try {
      buildInvoiceDataXml(inv);
    } catch (e) {
      built = e;
    }
    expect(built).toBeInstanceOf(AppError);
    expect((built as AppError).code).toBe('NAV_DATA_INVALID');
    expect(errorCodes(inv)).toContain(code);
  });

  it('text with an invalid character inside stays valid, and NAV gets it without that character – as schema-valid invoiceData', async () => {
    const inv = firstLine({ description: 'Tan\u0001ácsadás￾' });
    expect(errorCodes(inv)).toEqual([]);
    const xml = buildInvoiceDataXml(inv);
    expect(xml).toContain('<lineDescription>Tanácsadás</lineDescription>');
    expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
  });

  it.each([
    ['buyer name and address with C0/C1 controls', { ...INVOICE_DOMESTIC, customer: { ...CUSTOMER_DOMESTIC, name: 'Árvíztűrő Kft.\u0085', address: { ...CUSTOMER_DOMESTIC.address, addressLine: 'Fő\u0007 utca 1.' } } }],
    ['a storno comment with a noncharacter', { ...INVOICE_STORNO, comment: 'Téves\u0002 számla\uffff' }],
  ] as Array<[string, Invoice]>)('%s: the invoiceData is schema-valid', async (_name, inv) => {
    expect((await validateNavXml(buildInvoiceDataXml(inv), 'data')).errors).toEqual([]);
  });

  it('the hint for an issued document that cannot be reported: a program error – no correction, no storno', () => {
    let hint = '';
    try {
      buildInvoiceDataXml(firstLine({ description: INVALID_ONLY }));
    } catch (e) {
      hint = (e as AppError).hint ?? '';
    }
    expect(hint).toMatch(/programhiba/);
    expect(hint).toMatch(/Ne állíts ki rá módosító vagy sztornó számlát/);
    expect(hint).toMatch(/kérj segítséget/);
    expect(hint).not.toMatch(/helyesbítő vagy sztornó számlával/);
  });
});
