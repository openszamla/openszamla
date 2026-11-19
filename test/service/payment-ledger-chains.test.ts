/**
 * EX8: the payment ledger on invoice chains. Every payment is a row of payments; payment_allocations records how the chain's
 * settlement distributed it – appended to, never changed: a modification issued later that takes over an overpayment, or an
 * earlier-dated payment recorded later, adds rows that move the money. The paid amount of each document is what was
 * allocated to it; the payment history of a document lists the payments it received part of, also those recorded on
 * another document of the chain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, paymentClock, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  const clock = paymentClock('2026-11-14');
  t = makeTestApp({ confirmMode: 'none', now: clock.now });
  clock.follow(t.app);
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const HOURS = (quantity: string): LineInput[] => [{ description: 'Fejlesztés', quantity, unit: 'óra', unitPrice: '15000', vatCode: '27' }]; // 19 050 Ft / óra

async function invoice(app: OpenSzamla, hours: string): Promise<Invoice> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, lines: HOURS(hours) })).invoice.id)).invoice;
}

async function correct(app: OpenSzamla, original: Invoice, hours: string): Promise<Invoice> {
  return (await app.issue((await app.createCorrectionDraft(original.id, { lines: HOURS(hours), comment: 'Javítás' })).invoice.id)).invoice;
}

type Row = Record<string, unknown>;
const table = (app: OpenSzamla, sql: string): Row[] => app.store.unsafeRawDatabaseForTests().prepare(sql).all() as Row[];
const state = (app: OpenSzamla, inv: Invoice): string => {
  const i = app.getInvoice(inv.id);
  return `${i.paymentStatus} ${i.paidAmount} ${i.paidDate}`;
};

describe('the payment ledger of a chain (EX8)', () => {
  it('a payment is a row; its allocation follows the chain; a later modification takes over the overpayment with new rows', async () => {
    const app = setup();
    const original = await invoice(app, '10'); // 190 500
    app.recordPayment(original.id, { amount: '209550', date: '2026-11-16', allowOverpayment: true }); // 19 050 more than the total
    expect(state(app, original)).toBe('paid 209550 2026-11-16');
    const payments = table(app, 'SELECT invoice_id, payment_date, amount, source, reference FROM payments');
    expect(payments).toEqual([{ invoice_id: original.id, payment_date: '2026-11-16', amount: '209550', source: 'manual', reference: null }]);
    expect(table(app, 'SELECT invoice_id, amount FROM payment_allocations')).toEqual([{ invoice_id: original.id, amount: '209550' }]);

    // The upward modification issued later is paid by that overpayment – on the payment's date.
    const upward = await correct(app, original, '1'); // +19 050
    expect([state(app, original), state(app, upward)]).toEqual(['paid 190500 2026-11-16', 'paid 19050 2026-11-16']);
    expect(table(app, 'SELECT invoice_id, amount FROM payment_allocations ORDER BY id')).toEqual([
      { invoice_id: original.id, amount: '209550' },
      { invoice_id: original.id, amount: '-19050' },
      { invoice_id: upward.id, amount: '19050' },
    ]);
    // In the modification's history: the payment recorded on the original, with the part that came to it.
    expect(app.paymentHistory(upward.id).map((p) => [p.date, p.amount, p.paymentAmount, p.recordedOn.number, p.kind, p.source])).toEqual([
      ['2026-11-16', '19050', '209550', original.number, 'payment', 'manual'],
    ]);
    const status = app.auditLog({ entityId: upward.id }).items.find((e) => e.action === 'invoice.payment.status');
    expect(status?.details).toMatchObject({ paymentStatus: 'paid', previousPaymentStatus: 'unpaid', cause: upward.number });
  });

  it('a payment dated before one recorded earlier is allocated first: the money moves with new rows', async () => {
    const app = setup();
    const original = await invoice(app, '10'); // 190 500
    const upward = await correct(app, original, '1'); // +19 050
    app.recordPayment(original.id, { amount: '200000', date: '2026-12-05' });
    expect([state(app, original), state(app, upward)]).toEqual(['paid 190500 2026-12-05', 'partial 9500 null']);
    app.recordPayment(original.id, { amount: '9550', date: '2026-11-20' });
    // By payment date: 9 550 (11-20) on the original first, then 200 000 (12-05) pays the rest of both.
    expect([state(app, original), state(app, upward)]).toEqual(['paid 190500 2026-12-05', 'paid 19050 2026-12-05']);
    const ids = table(app, 'SELECT id FROM payments ORDER BY id').map((r) => r.id);
    const parts = (paymentId: unknown): Row[] => table(app, `SELECT invoice_id, amount FROM payment_allocations WHERE payment_id = ${String(paymentId)} ORDER BY id`);
    expect(parts(ids[0])).toEqual([
      { invoice_id: original.id, amount: '190500' },
      { invoice_id: upward.id, amount: '9500' },
      { invoice_id: original.id, amount: '-9550' },
      { invoice_id: upward.id, amount: '9550' },
    ]);
    expect(parts(ids[1])).toEqual([{ invoice_id: original.id, amount: '9550' }]);
    expect(app.paymentHistory(original.id).map((p) => [p.date, p.amount])).toEqual([
      ['2026-11-20', '9550'],
      ['2026-12-05', '180950'],
    ]);
  });

  it('a credit note: set off without a payment, refunded with its own; the storno refunds the whole chain', async () => {
    const app = setup();
    const original = await invoice(app, '10'); // 190 500
    app.recordPayment(original.id, { date: '2026-11-15' });
    const credit = await correct(app, original, '-2'); // −38 100 to refund
    expect(state(app, credit)).toBe('unpaid 0 null');
    app.recordPayment(credit.id, { date: '2026-11-18' });
    expect(state(app, credit)).toBe('paid -38100 2026-11-18');
    const upward = await correct(app, original, '1'); // +19 050, unpaid
    app.recordPayment(upward.id, { date: '2026-11-19' });
    // Cancelled: the chain received 190 500 − 38 100 + 19 050 = 171 450, which the storno refunds.
    const storno = (await app.cancel(original.id, { reason: 'téves számla' })).invoice;
    expect([state(app, original), state(app, credit), state(app, upward)]).toEqual(['paid 190500 2026-11-15', 'paid -38100 2026-11-18', 'paid 19050 2026-11-19']);
    expect(app.openAmount(storno)).toBe('-171450');
    app.recordPayment(storno.id, { date: '2026-11-25' });
    const sum = table(app, 'SELECT amount FROM payment_allocations').reduce((s, r) => s + Number(r.amount), 0);
    expect(sum).toBe(0);
    expect(state(app, storno)).toBe('paid -171450 2026-11-25');
  });

  it('markPaid and the díjbekérő payment are rows of the ledger with their source; each díjbekérő payment keeps its date', async () => {
    const app = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const cash = (await app.issue((await app.createDraft({ customerId, paymentMethod: 'CASH', lines: HOURS('1') })).invoice.id, { markPaid: true })).invoice;
    expect(app.paymentHistory(cash.id).map((p) => [p.date, p.amount, p.source])).toEqual([['2026-11-14', '19050', 'mark_paid']]);
    const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: HOURS('10') })).invoice.id)).invoice;
    app.recordPayment(proforma.id, { amount: '90500', date: '2026-11-10' });
    app.recordPayment(proforma.id, { amount: '100000', date: '2026-11-12' });
    const converted = (await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id)).invoice;
    expect([converted.paymentStatus, converted.paidAmount, converted.paidDate]).toEqual(['paid', '190500', '2026-11-12']);
    expect(app.paymentHistory(converted.id).map((p) => [p.date, p.amount, p.source, p.reference])).toEqual([
      ['2026-11-10', '90500', 'proforma', proforma.number],
      ['2026-11-12', '100000', 'proforma', proforma.number],
    ]);
    // One log entry carries them, with their total; the díjbekérő keeps its own payments.
    const carried = app.auditLog({ entityId: converted.id }).items.filter((e) => e.action === 'invoice.payment');
    expect(carried.map((e) => [e.details.amount, e.details.date, e.details.proforma])).toEqual([['190500', '2026-11-12', proforma.number]]);
    expect(app.paymentHistory(proforma.id).map((p) => p.amount)).toEqual(['90500', '100000']);
  });
});
