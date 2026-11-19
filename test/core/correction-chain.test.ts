/**
 * validateInvoice with the issued correction chain of the original (InvoiceValidationContext.chain):
 * the invoice's current fulfilment date (TAX-2) and MODIFICATION_NEGATIVE_RESULT over the original and
 * all its modifications (TAX-4).
 */
import { describe, expect, it } from 'vitest';
import { computeLines, computeTotals } from '../../src/core/calc.ts';
import type { Invoice, InvoiceLineInput, ValidationIssue } from '../../src/core/types.ts';
import { chainFulfillmentDate, validateInvoice } from '../../src/core/validate.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO } from '../fixtures/invoices.ts';

const REF = { originalInvoiceId: INVOICE_DOMESTIC.id, originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false };
const TODAY = '2026-11-08';

const diff = (unitPrice: string, vatCode: '27' | '5' = '27'): InvoiceLineInput => ({ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice, priceBasis: 'net', vatCode, nature: 'OTHER' });

/** A modification draft of INVOICE_DOMESTIC (fulfilment 2026-10-27, 27%: 150 000 + 5%: 4 000 net). */
function modification(inputs: InvoiceLineInput[], over: Partial<Invoice> = {}): Invoice {
  const lines = computeLines(inputs, { currency: 'HUF', exchangeRate: '1' });
  return {
    ...INVOICE_DOMESTIC,
    id: 'inv_moddraft01',
    documentType: 'modification',
    status: 'draft',
    number: null,
    issuedAt: null,
    issueDate: '2026-11-05',
    dueDate: '2026-11-05',
    orderNumber: null,
    comment: 'Utólagos árengedmény',
    reference: REF,
    lines,
    totals: computeTotals(lines, { currency: 'HUF', exchangeRate: '1', paymentMethod: 'TRANSFER' }),
    notations: [],
    ...over,
  };
}

/** The same as an issued member of the chain. */
const issued = (inv: Invoice, number: string, modificationIndex: number): Invoice => ({
  ...inv,
  id: `inv_${number.replace(/\W/g, '')}`,
  status: 'issued',
  number,
  issuedAt: '2026-11-05T09:00:00.000Z',
  reference: { ...REF, modificationIndex },
});

const check = (inv: Invoice, chain: Invoice[]): ValidationIssue[] => validateInvoice(inv, { today: TODAY, original: INVOICE_DOMESTIC, chain });
const issueOf = (issues: ValidationIssue[], code: string): ValidationIssue | undefined => issues.find((i) => i.code === code);

const dateFix = issued(modification([diff('0')], { fulfillmentDate: '2026-11-03' }), 'SZ-2026-00002', 1);

describe('chainFulfillmentDate', () => {
  it('the latest modification holds the current date; the source is the document that set it', () => {
    expect(chainFulfillmentDate(INVOICE_DOMESTIC, [])).toEqual({ date: '2026-10-27', source: INVOICE_DOMESTIC });
    const price = issued(modification([diff('-1000')], { fulfillmentDate: '2026-11-03' }), 'SZ-2026-00003', 2);
    expect(chainFulfillmentDate(INVOICE_DOMESTIC, [price, dateFix])).toEqual({ date: '2026-11-03', source: dateFix });
    // A later modification that went back to the old date (made by an older version) wins: NAV compares with it.
    const back = issued(modification([diff('-1000')]), 'SZ-2026-00003', 2);
    expect(chainFulfillmentDate(INVOICE_DOMESTIC, [dateFix, back])).toEqual({ date: '2026-10-27', source: back });
    // A modification that kept the original date changes nothing.
    const kept = issued(modification([diff('-1000')]), 'SZ-2026-00002', 1);
    expect(chainFulfillmentDate(INVOICE_DOMESTIC, [kept]).source).toBe(INVOICE_DOMESTIC);
    // Stornos and drafts do not count.
    expect(chainFulfillmentDate(INVOICE_DOMESTIC, [{ ...INVOICE_STORNO, fulfillmentDate: '2026-11-03' }, modification([diff('0')], { fulfillmentDate: '2026-11-04' })]).date).toBe('2026-10-27');
  });
});

describe('fulfilment-date warnings compare with the current date of the chain', () => {
  it('STORNO_FULFILLMENT_DATE', () => {
    const storno = (fulfillmentDate: string): Invoice => ({ ...INVOICE_STORNO, issueDate: '2026-11-05', dueDate: '2026-11-05', fulfillmentDate, reference: { ...REF, modificationIndex: 2 } });
    expect(issueOf(check(storno('2026-11-03'), [dateFix]), 'STORNO_FULFILLMENT_DATE')).toBeUndefined();
    expect(issueOf(check(storno('2026-10-27'), [dateFix]), 'STORNO_FULFILLMENT_DATE')?.message).toBe(
      'A sztornó számla teljesítési dátuma a számla aktuális teljesítési dátuma legyen: 2026-11-03 (a(z) SZ-2026-00002 módosító számla szerint); különben a NAV a teljesítési dátumot módosítottnak tekinti (WARN 11401).',
    );
    expect(issueOf(check(storno('2026-10-27'), []), 'STORNO_FULFILLMENT_DATE')).toBeUndefined();
    expect(issueOf(check(storno('2026-10-28'), []), 'STORNO_FULFILLMENT_DATE')?.message).toContain('2026-10-27 (az eredeti számla szerint)');
  });

  it('MODIFICATION_FULFILLMENT_DATE', () => {
    const next = (fulfillmentDate: string): Invoice => modification([diff('-1000')], { fulfillmentDate, reference: { ...REF, modificationIndex: 2 } });
    expect(issueOf(check(next('2026-11-03'), [dateFix]), 'MODIFICATION_FULFILLMENT_DATE')).toBeUndefined();
    expect(issueOf(check(next('2026-10-27'), [dateFix]), 'MODIFICATION_FULFILLMENT_DATE')?.message).toContain('mint a számla aktuális teljesítési dátuma: 2026-11-03 (a(z) SZ-2026-00002 módosító számla szerint)');
    expect(issueOf(check(next('2026-11-03'), []), 'MODIFICATION_FULFILLMENT_DATE')?.message).toContain('mint a számla aktuális teljesítési dátuma: 2026-10-27 (az eredeti számla szerint)');
  });
});

describe('MODIFICATION_NEGATIVE_RESULT adds up the original and every issued modification', () => {
  it('per VAT code, net and VAT, as a warning', () => {
    const earlier = issued(modification([diff('-100000')]), 'SZ-2026-00002', 1);
    const draft = modification([diff('-60000')], { reference: { ...REF, modificationIndex: 2 } });
    expect(issueOf(check(draft, []), 'MODIFICATION_NEGATIVE_RESULT')).toBeUndefined();
    const warning = issueOf(check(draft, [earlier]), 'MODIFICATION_NEGATIVE_RESULT');
    expect(warning).toMatchObject({ severity: 'warning', field: 'totals.byVat[0].netAmount' });
    expect(warning?.message).toContain('27 ÁFA-kódú adóalapja és adója – a korábbi módosításaival együtt – negatív lenne (nettó -10000, ÁFA -2700 HUF)');
    // The 5% base of 4 000 Ft goes below zero although the invoice total stays positive.
    const five = check(modification([diff('-5000', '5')]), []);
    expect(issueOf(five, 'MODIFICATION_NEGATIVE_RESULT')?.message).toContain('5 ÁFA-kódú adóalapja és adója negatív lenne (nettó -1000, ÁFA -50 HUF)');
    // An earlier increase is counted as well.
    const raise = issued(modification([diff('100000')]), 'SZ-2026-00002', 1);
    expect(issueOf(check(modification([diff('-200000')], { reference: { ...REF, modificationIndex: 2 } }), [raise]), 'MODIFICATION_NEGATIVE_RESULT')).toBeUndefined();
  });
});
