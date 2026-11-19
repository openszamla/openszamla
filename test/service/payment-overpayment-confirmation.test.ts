/**
 * A payment larger than what is still owed. 127 000 typed for 12 700 used to be recorded without a question: the invoice
 * showed "paid", and the slip was visible only to someone who compared the amounts. More than the invoice – with its
 * modifications – still owes is now an overpayment the caller has to confirm (allowOverpayment); what the chain owes in
 * total can still be recorded on any of its documents. A payment dated more than a year before the document (1900, a
 * mistyped year) is refused too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const LINE = (unitPrice: string) => [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice, vatCode: '27' as const }];

async function invoice(app: OpenSzamla, unitPrice: string): Promise<Invoice> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, lines: LINE(unitPrice) })).invoice.id)).invoice;
}

describe('an overpayment needs an explicit yes', () => {
  it('127 000 for an invoice of 12 700 is refused with both amounts; nothing is recorded', async () => {
    const app = setup();
    const inv = await invoice(app, '10000'); // 12 700 Ft
    let error: { code?: string; message?: string; hint?: string } | null = null;
    try {
      app.recordPayment(inv.id, { amount: '127000' });
    } catch (e) {
      error = e as { code?: string; message?: string; hint?: string };
    }
    expect(error?.code).toBe('OVERPAYMENT_NOT_CONFIRMED');
    expect(error?.message).toBe(`A megadott összeg (${ft('127000')}) nagyobb a hátraléknál (${ft('12700')}): a különbözet (${ft('114300')}) túlfizetés lenne.`);
    expect(error?.hint).toContain('allowOverpayment: true');
    expect(app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    expect(app.paymentHistory(inv.id)).toEqual([]);
    expect(app.recordedOn(app.getInvoice(inv.id))).toBe('0');

    // The amount owed, and less, need nothing; a confirmed overpayment is recorded.
    expect(app.recordPayment(inv.id, { amount: '2700' })).toMatchObject({ paymentStatus: 'partial', paidAmount: '2700' });
    expect(() => app.recordPayment(inv.id, { amount: '10001' })).toThrowError(expect.objectContaining({ code: 'OVERPAYMENT_NOT_CONFIRMED' }));
    expect(app.recordPayment(inv.id, { amount: '10000' })).toMatchObject({ paymentStatus: 'paid', paidAmount: '12700' });
    // A paid invoice owes nothing: any further payment is an overpayment.
    expect(() => app.recordPayment(inv.id, { amount: '1' })).toThrowError(expect.objectContaining({ code: 'OVERPAYMENT_NOT_CONFIRMED' }));
    expect(app.recordPayment(inv.id, { amount: '300', allowOverpayment: true })).toMatchObject({ paymentStatus: 'paid', paidAmount: '13000' });
    expect(app.recordedOn(app.getInvoice(inv.id))).toBe('13000');
  });

  it('what the invoice and its upward modification owe together can be paid on the original: not an overpayment', async () => {
    const app = setup();
    const original = await invoice(app, '100000'); // 127 000
    const upward = (await app.issue((await app.createCorrectionDraft(original.id, { lines: LINE('10000'), comment: 'Javítás' })).invoice.id)).invoice; // +12 700
    expect(() => app.recordPayment(original.id, { amount: '139701' })).toThrowError(expect.objectContaining({ code: 'OVERPAYMENT_NOT_CONFIRMED' }));
    expect(app.recordPayment(original.id, { amount: '139700' })).toMatchObject({ paymentStatus: 'paid' });
    expect(app.getInvoice(upward.id).paymentStatus).toBe('paid');
    // Recorded on the original only: that is what a reversal there can take back.
    expect(app.recordedOn(app.getInvoice(original.id))).toBe('139700');
    expect(app.recordedOn(app.getInvoice(upward.id))).toBe('0');
  });

  it('a reversal and a refund are not overpayments', async () => {
    const app = setup();
    const inv = await invoice(app, '10000');
    app.recordPayment(inv.id, {});
    expect(app.recordPayment(inv.id, { amount: '-12700' })).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    expect(app.recordedOn(app.getInvoice(inv.id))).toBe('0');
  });
});

describe('the payment date', () => {
  it('more than a year before the document is a mistyped year; an advance paid months earlier is fine', async () => {
    const app = setup();
    const inv = await invoice(app, '10000'); // issued 2026-11-14
    for (const date of ['1900-01-01', '2002-11-14', '2025-11-12']) {
      expect(() => app.recordPayment(inv.id, { date }), date).toThrow(`A befizetés dátuma (${formatDate(date)}) több mint egy évvel korábbi a bizonylat kelténél (${formatDate('2026-11-14')}).`);
    }
    expect(app.getInvoice(inv.id).paymentStatus).toBe('unpaid');
    expect(app.recordPayment(inv.id, { amount: '2700', date: '2026-03-01' })).toMatchObject({ paymentStatus: 'partial' });
    expect(app.recordPayment(inv.id, { date: '2026-11-14' })).toMatchObject({ paymentStatus: 'paid', paidDate: '2026-11-14' });
  });
});
