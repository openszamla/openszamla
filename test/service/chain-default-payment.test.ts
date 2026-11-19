/**
 * Payments on an invoice chain that is not cancelled (review C2, N4): without an amount, a document with a
 * positive total – the original or a modification – gets what the whole chain still owes, as the
 * settlement computes it (after an upward modification of a paid invoice: the open difference, also on
 * the original); a crediting document still gets its own refund. An explicit amount is accepted as on a
 * plain invoice (overpayment too) – except on an invoice that received its díjbekérő's payment at issue:
 * there an amount over what the chain still owes is refused (it would count that payment twice, PC2).
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

function setup(): OpenSzamla {
  t = makeTestApp({ now: () => new Date('2026-11-09T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const HOURS = (quantity: string) => [{ description: 'Fejlesztés', quantity, unit: 'óra', unitPrice: '15000', vatCode: '27' as const }]; // 19 050 Ft / óra

function customerId(app: OpenSzamla): string {
  return (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
}

async function invoice(app: OpenSzamla, hours = '10'): Promise<Invoice> {
  return (await app.issue((await app.createDraft({ customerId: customerId(app), lines: HOURS(hours) })).invoice.id)).invoice;
}

async function correct(app: OpenSzamla, original: Invoice, hours: string): Promise<Invoice> {
  return (await app.issue((await app.createCorrectionDraft(original.id, { lines: HOURS(hours), comment: 'Javítás' })).invoice.id)).invoice;
}

const status = (app: OpenSzamla, ...docs: Invoice[]): string[] => docs.map((d) => app.getInvoice(d.id).paymentStatus);
const lastPayment = (app: OpenSzamla, id: string): unknown => app.auditLog({ entityId: id }).items.find((e) => e.action === 'invoice.payment')?.details.amount;

describe('the default payment is what the chain still owes (N4)', () => {
  it('a paid invoice modified upwards: the default payment on the original records the open difference', async () => {
    const app = setup();
    const original = await invoice(app); // 190 500
    app.recordPayment(original.id, {});
    const upward = await correct(app, original, '2'); // +38 100
    expect(status(app, original, upward)).toEqual(['paid', 'unpaid']);
    expect(app.openAmount(app.getInvoice(original.id))).toBe('0');
    expect(app.defaultPaymentAmount(app.getInvoice(original.id))).toBe('38100');

    const paid = app.recordPayment(original.id, {});
    // Recorded on the original, the open difference is allocated to the modification it pays.
    expect([paid.paidAmount, app.getInvoice(upward.id).paidAmount]).toEqual(['190500', '38100']);
    expect(lastPayment(app, original.id)).toBe('38100');
    expect(status(app, original, upward)).toEqual(['paid', 'paid']);
    // Nothing is owed any more – on either document.
    expect(() => app.recordPayment(upward.id, {})).toThrow(/teljesen ki van fizetve/);
    expect(() => app.recordPayment(original.id, {})).toThrow(/teljesen ki van fizetve/);
  });

  it('an unpaid invoice with an open upward modification: one default payment settles both, from either document', async () => {
    const app = setup();
    const a = await invoice(app);
    const aUp = await correct(app, a, '1'); // +19 050
    expect(app.recordPayment(a.id, {}).paidAmount).toBe('190500');
    expect(app.getInvoice(aUp.id).paidAmount).toBe('19050');
    expect(status(app, a, aUp)).toEqual(['paid', 'paid']);

    const b = await invoice(app);
    const bUp = await correct(app, b, '1');
    expect(app.defaultPaymentAmount(app.getInvoice(bUp.id))).toBe('209550');
    expect(app.recordPayment(bUp.id, {}).paidAmount).toBe('19050');
    expect(app.getInvoice(b.id).paidAmount).toBe('190500');
    expect(status(app, b, bUp)).toEqual(['paid', 'paid']);
  });

  it('credits and increases together: the default payment is the corrected total, and settles every document', async () => {
    const app = setup();
    const o = await invoice(app); // 190 500
    const c1 = await correct(app, o, '-2'); // −38 100
    const up = await correct(app, o, '3'); // +57 150
    const c2 = await correct(app, o, '-1'); // −19 050
    expect(app.recordPayment(o.id, {}).paidAmount).toBe('190500');
    expect(status(app, o, c1, up, c2)).toEqual(['paid', 'paid', 'paid', 'paid']);
  });

  it('a credit note still gets its own refund; a chain owing a refund has no default payment on the original', async () => {
    const app = setup();
    const o = await invoice(app);
    app.recordPayment(o.id, { amount: '170000' });
    const credit = await correct(app, o, '-2'); // −38 100: 17 600 to refund
    expect(app.openAmount(app.getInvoice(credit.id))).toBe('-17600');
    expect(() => app.recordPayment(o.id, {})).toThrow(/teljesen ki van fizetve/);
    expect(app.recordPayment(credit.id, {})).toMatchObject({ paidAmount: '-17600', paymentStatus: 'paid' });
  });
});

describe('a converted invoice with an upward modification (C2)', () => {
  async function converted(app: OpenSzamla): Promise<{ original: Invoice; upward: Invoice }> {
    const d = await app.createDraft({ documentType: 'proforma', customerId: customerId(app), lines: [{ description: 'Licenc', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
    const proforma = (await app.issue(d.invoice.id)).invoice;
    app.recordPayment(proforma.id, { date: '2026-11-09' });
    const original = (await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id)).invoice;
    expect(original).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
    const upward = (await app.issue((await app.createCorrectionDraft(original.id, { lines: [{ description: 'Licenc bővítés', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }], comment: 'Bővítés' })).invoice.id)).invoice;
    return { original, upward }; // +12 700 open
  }

  it('the difference paid on the original is accepted, as on any invoice – also as the default amount', async () => {
    const app = setup();
    const a = await converted(app);
    expect(app.recordPayment(a.original.id, { amount: '12700' }).paidAmount).toBe('127000');
    expect(app.getInvoice(a.upward.id).paidAmount).toBe('12700');
    expect(status(app, a.original, a.upward)).toEqual(['paid', 'paid']);

    const b = await converted(app);
    expect(app.recordPayment(b.original.id, {}).paidAmount).toBe('127000');
    expect(app.getInvoice(b.upward.id).paidAmount).toBe('12700');
    expect(lastPayment(app, b.original.id)).toBe('12700');
    expect(status(app, b.original, b.upward)).toEqual(['paid', 'paid']);
  });

  it('more than the chain owes is refused on it – the carried amount and any other overpayment; up to the open total is accepted', async () => {
    const app = setup();
    const { original, upward } = await converted(app);
    expect(() => app.recordPayment(original.id, { amount: '127000' })).toThrow(
      `A(z) ${original.number} számlára a(z) DB-2026-00001 díjbekérő befizetése (${ft('127000')}, 2026.11.09.) a kiállításkor már átkerült; ez a befizetés ugyanazt a pénzt kétszer számolná (hátralék: ${ft('12700')}).`,
    );
    expect(() => app.recordPayment(original.id, { amount: '20000' })).toThrow(`(hátralék: ${ft('12700')})`);
    expect(status(app, original, upward)).toEqual(['paid', 'unpaid']);
    // Taken back: now the chain owes 139 700 – the same amount again is a payment like any other.
    app.recordPayment(original.id, { amount: '-127000' });
    expect(app.recordPayment(original.id, { amount: '127000' })).toMatchObject({ paidAmount: '127000', paymentStatus: 'paid' });
    expect(status(app, original, upward)).toEqual(['paid', 'unpaid']);
  });
});
