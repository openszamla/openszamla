/**
 * On a document that received its díjbekérő's payment at issue, recordPayment refuses a positive amount
 * larger than what its chain still owes in total (PC2): recording the full price on top of a partly carried
 * payment would count the carried money twice. The default payment and a payment up to the open total are
 * accepted, a reversal (negative amount) too, and an overpayment on a document without a carried payment
 * stays allowed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const LICENCE = [{ description: 'Licenc', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' as const }]; // 127 000 Ft
const paymentEntries = (app: OpenSzamla, id: string): number => app.auditLog({ entityId: id }).items.filter((e) => e.action === 'invoice.payment').length;

/** A díjbekérő of 127 000 Ft paid `amount` on 2026-11-10, converted and issued: the payment is carried over. */
async function converted(app: OpenSzamla, customerId: string, amount: string): Promise<Invoice> {
  const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: LICENCE })).invoice.id)).invoice;
  app.recordPayment(proforma.id, { amount, date: '2026-11-10' });
  const inv = (await app.issue((await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-10' })).invoice.id)).invoice;
  expect(inv.paidAmount).toBe(amount);
  return inv;
}

const doubleCount = (inv: Invoice, proforma: string, carried: string, open: string): string =>
  `A(z) ${inv.number} számlára a(z) ${proforma} díjbekérő befizetése (${ft(carried)}, 2026.11.10.) a kiállításkor már átkerült; ` +
  `ez a befizetés ugyanazt a pénzt kétszer számolná (hátralék: ${ft(open)}).`;

describe('more than the chain owes is refused on a document holding a carried díjbekérő payment (PC2)', () => {
  it('a partly carried payment: the full price is refused, the open total is accepted', async () => {
    const { app, customerId } = setup();
    const inv = await converted(app, customerId, '50000');
    expect(inv.paymentStatus).toBe('partial');
    expect(app.openAmount(app.getInvoice(inv.id))).toBe('77000');

    expect(() => app.recordPayment(inv.id, { amount: '127000' })).toThrow(doubleCount(inv, 'DB-2026-00001', '50000', '77000'));
    expect(() => app.recordPayment(inv.id, { amount: '77001' })).toThrow(`(hátralék: ${ft('77000')})`);
    // Nothing was recorded by the refused calls.
    expect(app.getInvoice(inv.id)).toMatchObject({ paidAmount: '50000', paymentStatus: 'partial' });
    expect(paymentEntries(app, inv.id)).toBe(1);

    // A difference payment up to the open total is a payment like any other.
    expect(app.recordPayment(inv.id, { amount: '77000' })).toMatchObject({ paidAmount: '127000', paymentStatus: 'paid' });
    // Now nothing is owed: any further positive amount is refused (hátralék 0); a reversal is not.
    expect(() => app.recordPayment(inv.id, { amount: '1' })).toThrow(`(hátralék: ${ft('0')})`);
    expect(app.recordPayment(inv.id, { amount: '-77000' })).toMatchObject({ paidAmount: '50000', paymentStatus: 'partial' });
  });

  it('the default payment records the open total', async () => {
    const { app, customerId } = setup();
    const inv = await converted(app, customerId, '50000');
    expect(app.recordPayment(inv.id, {})).toMatchObject({ paidAmount: '127000', paymentStatus: 'paid' });
  });

  it('a chain that owes a refund (a credit note after a fully carried payment): a positive amount is refused, with no arrears', async () => {
    const { app, customerId } = setup();
    const inv = await converted(app, customerId, '127000');
    const credit = (await app.issue((await app.createCorrectionDraft(inv.id, { lines: [{ description: 'Licenc', quantity: '-1', unit: 'db', unitPrice: '30000', vatCode: '27' }], comment: 'Árengedmény' })).invoice.id)).invoice;
    expect(app.openAmount(app.getInvoice(credit.id))).toBe('-38100');
    expect(() => app.recordPayment(inv.id, { amount: '10000' })).toThrow(doubleCount(inv, 'DB-2026-00001', '127000', '0'));
    // The refund itself is recorded on the credit note as before.
    expect(app.recordPayment(credit.id, {})).toMatchObject({ paidAmount: '-38100', paymentStatus: 'paid' });
  });

  it('an overpayment on a document without a carried payment is still accepted – when confirmed', async () => {
    const { app, customerId } = setup();
    const plain = (await app.issue((await app.createDraft({ customerId, lines: LICENCE })).invoice.id)).invoice;
    expect(app.recordPayment(plain.id, { amount: '200000', allowOverpayment: true })).toMatchObject({ paidAmount: '200000', paymentStatus: 'paid' });
    // A conversion of an unpaid díjbekérő carries nothing: no guard there either.
    const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: LICENCE })).invoice.id)).invoice;
    const fromUnpaid = (await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id)).invoice;
    expect(app.recordPayment(fromUnpaid.id, { amount: '130000', allowOverpayment: true })).toMatchObject({ paidAmount: '130000', paymentStatus: 'paid' });
  });
});
