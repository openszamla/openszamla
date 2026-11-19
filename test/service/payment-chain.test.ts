/**
 * MCP-6: an invoice corrected by modifications is settled together with them – its open amount, payment
 * status, overdue flag and default payment amount come from the chain (original + issued modifications),
 * consistently in invoice_list, report_summary, setup_status (and the web dashboard, which shows these).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(now = '2026-11-09T09:00:00.000Z'): { app: OpenSzamla; clock: { now: Date } } {
  const clock = { now: new Date(now) };
  t = makeTestApp({ now: () => clock.now });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, clock };
}

const HOURS = (quantity: string) => [{ description: 'Fejlesztés', quantity, unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];

async function issueInvoice(app: OpenSzamla, lines = HOURS('10'), extra: Record<string, unknown> = {}): Promise<Invoice> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const d = await app.createDraft({ customerId, lines, ...extra });
  expect(d.issues.filter((i) => i.severity === 'error'), JSON.stringify(d.issues)).toEqual([]);
  return (await app.issue(d.invoice.id)).invoice;
}

async function correct(app: OpenSzamla, original: Invoice, lines: Parameters<OpenSzamla['createCorrectionDraft']>[1]['lines']): Promise<Invoice> {
  const d = await app.createCorrectionDraft(original.id, { lines, comment: 'Javítás' });
  expect(d.issues.filter((i) => i.severity === 'error'), JSON.stringify(d.issues)).toEqual([]);
  return (await app.issue(d.invoice.id)).invoice;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

/** Every surface counts the same documents. */
function expectConsistent(app: OpenSzamla): void {
  const r = app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables;
  expect(r.unpaidCount).toBe(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total);
  expect(r.unpaidCount).toBe(app.status().counts.unpaid);
  expect(r.overdueCount).toBe(app.findInvoices({ overdueOn: app.today() }).total);
}

describe('a corrected invoice is settled with its modifications (MCP-6)', () => {
  it('paying the corrected total settles the original and its credit note: not overdue, nothing left to pay', async () => {
    const { app, clock } = setup();
    const original = await issueInvoice(app); // 10 óra: 190 500 Ft, due 11-17
    const credit = await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(credit.totals.payableAmount).toBe('-38100');
    const paid = app.recordPayment(original.number as string, { amount: '152400' });
    expect([paid.paymentStatus, paid.paidAmount]).toEqual(['paid', '152400']);
    expect(app.getInvoice(credit.id).paymentStatus).toBe('paid'); // set off: no refund is due
    expect(app.openAmount(paid)).toBe('0');

    clock.now = new Date('2026-11-30T09:00:00.000Z'); // after the due date
    expect(app.findInvoices({ overdueOn: app.today() }).total).toBe(0);
    expect(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total).toBe(0);
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toEqual({ unpaidCount: 0, unpaidGrossHuf: '0', overdueCount: 0, overdueGrossHuf: '0' });
    expect(app.status().counts.unpaid).toBe(0);
    // The default payment has nothing left to book (no fictitious 38 100 Ft).
    expect(() => app.recordPayment(original.id, {})).toThrow(/teljesen ki van fizetve/);
    expect(() => app.recordPayment(credit.id, {})).toThrow(/rendezett/);
    expectConsistent(app);
  });

  it('before any payment the credit lowers what is owed, and the credit note needs no refund', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    const credit = await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(app.getInvoice(credit.id).paymentStatus).toBe('paid');
    expect(app.getInvoice(original.id).paymentStatus).toBe('unpaid');
    expect(app.recordPayment(original.id, {})).toMatchObject({ paymentStatus: 'paid', paidAmount: '152400' });
    expect(app.openAmount(app.getInvoice(original.id))).toBe('0');
  });

  it('a payment recorded before the credit note: issuing the credit note settles the original (logged)', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    expect(app.recordPayment(original.id, { amount: '152400' }).paymentStatus).toBe('partial');
    const credit = await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(app.getInvoice(original.id).paymentStatus).toBe('paid');
    const entry = app.auditLog({ entityId: original.id }).items.find((e) => e.action === 'invoice.payment.status');
    expect(entry?.details).toMatchObject({ paymentStatus: 'paid', previousPaymentStatus: 'partial', cause: credit.number });
    expectConsistent(app);
  });

  it('a partial credit and a partial payment: the default payment is the rest of the corrected total', async () => {
    const { app, clock } = setup();
    const original = await issueInvoice(app);
    await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(app.recordPayment(original.id, { amount: '100000' }).paymentStatus).toBe('partial');
    clock.now = new Date('2026-11-30T09:00:00.000Z');
    expect(app.findInvoices({ overdueOn: app.today() }).items.map((i) => i.id)).toEqual([original.id]);
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toEqual({ unpaidCount: 1, unpaidGrossHuf: '52400', overdueCount: 1, overdueGrossHuf: '52400' });
    expectConsistent(app);
    const rest = app.recordPayment(original.id, {});
    expect([rest.paymentStatus, rest.paidAmount]).toEqual(['paid', '152400']);
    const last = app.auditLog({ entityId: original.id }).items[0];
    expect(last).toMatchObject({ action: 'invoice.payment', details: { amount: '52400', paymentStatus: 'paid' } });
    expectConsistent(app);
  });

  it('paid in full before the credit: the credit note waits for the refund, which is its default amount', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    app.recordPayment(original.id, {});
    const credit = await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(app.getInvoice(credit.id).paymentStatus).toBe('unpaid');
    expect(app.openAmount(app.getInvoice(credit.id))).toBe('-38100');
    expect(app.getInvoice(original.id).paymentStatus).toBe('paid');
    const refund = app.recordPayment(credit.id, {});
    expect([refund.paymentStatus, refund.paidAmount]).toEqual(['paid', '-38100']);
    // Taking the refund back reopens it.
    expect(app.recordPayment(credit.id, { amount: '38100' }).paymentStatus).toBe('unpaid');
  });

  it('an upward modification: an overpayment of the original covers it; or it is paid on its own', async () => {
    const { app, clock } = setup();
    const original = await issueInvoice(app); // 190 500 Ft
    const upward = await correct(app, original, [{ description: 'Fejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    expect(upward.totals.payableAmount).toBe('19050');
    expect([app.getInvoice(original.id).paymentStatus, app.getInvoice(upward.id).paymentStatus]).toEqual(['unpaid', 'unpaid']);
    // The buyer pays the corrected total on the original: both are settled.
    app.recordPayment(original.id, { amount: '209550' });
    expect([app.getInvoice(original.id).paymentStatus, app.getInvoice(upward.id).paymentStatus]).toEqual(['paid', 'paid']);
    expect(() => app.recordPayment(upward.id, {})).toThrow(/teljesen ki van fizetve/);
    clock.now = new Date('2026-12-30T09:00:00.000Z');
    expect(app.findInvoices({ overdueOn: app.today() }).total).toBe(0);
    expectConsistentDecember(app);
    // Taking part of it back reopens the modification first (the original stays covered by its own payment).
    app.recordPayment(original.id, { amount: '-19050' });
    expect([app.getInvoice(original.id).paymentStatus, app.getInvoice(upward.id).paymentStatus]).toEqual(['paid', 'unpaid']);
    expect(app.report({ from: '2026-12-01', to: '2026-12-30' }).receivables).toMatchObject({ unpaidCount: 1, unpaidGrossHuf: '19050', overdueCount: 1 });
  });

  it('a cancelled invoice is out of the chain rules: its storno negates everything, nothing is owed', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    await correct(app, original, [{ description: 'Fejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    await app.cancel(original.id, { reason: 'Téves számla' });
    expect(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total).toBe(0);
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toEqual({ unpaidCount: 0, unpaidGrossHuf: '0', overdueCount: 0, overdueGrossHuf: '0' });
  });

  it('foreign currency: open amounts in the invoice currency, receivables in HUF at the document rate', async () => {
    const { app } = setup();
    const original = await issueInvoice(app, [{ description: 'Consulting', quantity: '1', unit: 'nap', unitPrice: '1000', vatCode: '27' }], { currency: 'EUR', exchangeRate: '400' });
    expect([original.totals.payableAmount, original.exchangeRate]).toEqual(['1270', '400']);
    await correct(app, original, [{ description: 'Discount', quantity: '1', unit: 'db', unitPrice: '-100.5', vatCode: '27' }]);
    app.recordPayment(original.id, { amount: '1000.25' });
    // 1270 − 127.64 (credit) − 1000.25 = 142.11 EUR open, 400 HUF/EUR.
    expect(app.openAmount(app.getInvoice(original.id))).toBe('142.11');
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toMatchObject({ unpaidCount: 1, unpaidGrossHuf: '56844' });
  });

  it('chains stored by an earlier version (each document on its own) are settled once at start, logged', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    const credit = await correct(app, original, [{ description: 'Fejlesztés', quantity: '-2', unit: 'óra', unitPrice: '15000', vatCode: '27' }]);
    app.recordPayment(original.id, { amount: '152400' });
    // What 0.1.0 stored: the original partial (152 400 / 190 500), the credit note unpaid.
    app.store.patchInvoice(original.id, { paymentStatus: 'partial' });
    app.store.patchInvoice(credit.id, { paymentStatus: 'unpaid' });
    app.store.setSetting('paymentChainsSettled', null);
    const reopened = new OpenSzamla(app.store, app.config, { now: () => new Date('2026-11-09T09:00:00.000Z') });
    expect([reopened.getInvoice(original.id).paymentStatus, reopened.getInvoice(credit.id).paymentStatus]).toEqual(['paid', 'paid']);
    const entries = reopened.auditLog({ limit: 10 }).items.filter((e) => e.action === 'invoice.payment.status');
    expect(entries.map((e) => [e.entityId, e.actor, e.details.paymentStatus])).toEqual(
      expect.arrayContaining([[original.id, 'system', 'paid'], [credit.id, 'system', 'paid']]),
    );
    // Once: a later start does not look again.
    const count = reopened.auditLog({ limit: 1 }).total;
    app.store.patchInvoice(original.id, { paymentStatus: 'partial' });
    const again = new OpenSzamla(app.store, app.config, {});
    expect(again.auditLog({ limit: 1 }).total).toBe(count);
    expect(again.getInvoice(original.id).paymentStatus).toBe('partial');
  });

  it('a 0 Ft correction (header data only) takes no part: it is only marked settled', async () => {
    const { app } = setup();
    const original = await issueInvoice(app);
    const zero = await correct(app, original, [{ description: 'Teljesítés dátuma helyesen: 2026.11.08.', quantity: '1', unit: 'db', unitPrice: '0', vatCode: '27' }]);
    expect([app.getInvoice(zero.id).paymentStatus, app.getInvoice(original.id).paymentStatus]).toEqual(['unpaid', 'unpaid']);
    expect(codeOf(() => app.recordPayment(zero.id, { amount: '10' }))).toBe('INVALID_INPUT');
    expect(app.recordPayment(zero.id, {}).paymentStatus).toBe('paid');
    expect(app.recordPayment(original.id, {})).toMatchObject({ paymentStatus: 'paid', paidAmount: '190500' });
  });
});

function expectConsistentDecember(app: OpenSzamla): void {
  const r = app.report({ from: '2026-12-01', to: '2026-12-30' }).receivables;
  expect(r.unpaidCount).toBe(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total);
  expect(r.unpaidCount).toBe(app.status().counts.unpaid);
  expect(r.overdueCount).toBe(app.findInvoices({ overdueOn: app.today() }).total);
}
