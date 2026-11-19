/**
 * C3: the guard against counting a carried díjbekérő payment twice (PC2) covers the whole chain. A díjbekérő of 127 000 Ft
 * is paid 50 000 Ft, the invoice made from it carries that over (77 000 Ft open), and a +12 700 Ft modification is issued:
 * the full price recorded on the modification would count the 50 000 Ft twice, so it is refused with the same message as on
 * the invoice itself – naming the invoice the payment was carried to. What the chain still owes is accepted on either
 * document, and the reversal of a refund on a crediting modification is not a payment the guard is about.
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

const ft = (v: string): string => formatMoney(v, 'HUF');
const line = (description: string, quantity: string, unitPrice: string) => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27' as const });

async function chain(paid: string): Promise<{ app: OpenSzamla; invoice: Invoice; modification: (q: string, p: string) => Promise<Invoice> }> {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: [line('Licenc', '1', '100000')] })).invoice.id)).invoice;
  app.recordPayment(proforma.id, { amount: paid, date: '2026-11-10' });
  const invoice = (await app.issue((await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-10' })).invoice.id)).invoice;
  const modification = async (q: string, p: string): Promise<Invoice> =>
    (await app.issue((await app.createCorrectionDraft(invoice.id, { lines: [line('Licenc bővítés', q, p)], comment: 'Javítás' })).invoice.id)).invoice;
  return { app, invoice, modification };
}

describe('the carried díjbekérő payment is guarded on every document of the chain (C3)', () => {
  it('the full price on the modification is refused like on the invoice; what the chain owes is accepted', async () => {
    const { app, invoice, modification } = await chain('50000');
    const upward = await modification('1', '10000'); // +12 700
    const message = `A(z) ${invoice.number} számlára a(z) DB-2026-00001 díjbekérő befizetése (${ft('50000')}, 2026.11.10.) a kiállításkor már átkerült; ez a befizetés ugyanazt a pénzt kétszer számolná (hátralék: ${ft('89700')}).`;
    expect(() => app.recordPayment(upward.id, { amount: '127000' })).toThrow(message);
    expect(() => app.recordPayment(invoice.id, { amount: '127000' })).toThrow(message);
    expect(() => app.recordPayment(upward.number as string, { amount: '89701' })).toThrow(`(hátralék: ${ft('89700')})`);
    expect(app.auditLog({ entityId: upward.id }).items.filter((e) => e.action === 'invoice.payment')).toEqual([]);

    // What the chain owes, recorded on the modification, settles both.
    const paid = app.recordPayment(upward.id, { amount: '89700' });
    expect(paid.paymentStatus).toBe('paid');
    expect([app.getInvoice(invoice.id).paidAmount, app.getInvoice(upward.id).paidAmount]).toEqual(['127000', '12700']);
    expect(() => app.recordPayment(upward.id, { amount: '1' })).toThrow(`(hátralék: ${ft('0')})`);
  });

  it('when the chain is paid, the hint of the default payment names the invoice the díjbekérő payment went to', async () => {
    const { app, invoice, modification } = await chain('127000');
    const upward = await modification('1', '10000');
    app.recordPayment(invoice.id, {}); // the 12 700 difference
    let hint: string | undefined;
    try {
      app.recordPayment(upward.id, {});
    } catch (e) {
      hint = (e as { hint?: string }).hint;
    }
    expect(hint).toContain(`A(z) DB-2026-00001 díjbekérőre rögzített befizetés a kiállításkor átkerült a(z) ${invoice.number} számlára – ne rögzítsd újra.`);
  });

  it('a refund taken back on a crediting modification is not refused', async () => {
    const { app, modification } = await chain('127000');
    const credit = await modification('-1', '10000'); // −12 700 to refund
    expect(app.recordPayment(credit.id, {})).toMatchObject({ paidAmount: '-12700', paymentStatus: 'paid' });
    expect(app.recordPayment(credit.id, { amount: '12700' })).toMatchObject({ paidAmount: '0', paymentStatus: 'unpaid' });
  });
});
