/**
 * A cancelled invoice's storno negates its modifications too (review C3, N5): nothing is open on any
 * document of that chain – openAmount is null for each of them, as the receivables (InvoiceFilter.receivable)
 * already treat them – and no payment can be recorded on them, neither the default nor a given amount.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

const HOURS = (quantity: string) => [{ description: 'Fejlesztés', quantity, unit: 'óra', unitPrice: '15000', vatCode: '27' as const }]; // 19 050 Ft / óra

async function chain(app: OpenSzamla, hours: string): Promise<{ original: Invoice; modification: Invoice; storno: Invoice }> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const original = (await app.issue((await app.createDraft({ customerId, lines: HOURS('10') })).invoice.id)).invoice;
  const modification = (await app.issue((await app.createCorrectionDraft(original.id, { lines: HOURS(hours), comment: 'Javítás' })).invoice.id)).invoice;
  const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
  return { original: app.getInvoice(original.id), modification: app.getInvoice(modification.id), storno };
}

function refusal(fn: () => unknown): { code?: string; message?: string } | null {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message?: string };
  }
  return null;
}

describe('the documents of a cancelled invoice: nothing open, nothing to pay (C3, N5)', () => {
  it('a credit note of a cancelled invoice: no refund is due, none can be recorded', async () => {
    const app = setup();
    const { original, modification: credit } = await chain(app, '-2'); // −38 100, set off before the storno
    expect(original.status).toBe('cancelled');
    expect(credit.status).toBe('issued');
    expect(app.openAmount(credit)).toBeNull();
    expect(app.defaultPaymentAmount(credit)).toBeNull();
    const message = `A(z) ${credit.number} a sztornózott ${original.number} számla módosító számlája: a sztornó számla ezt is semlegesítette, ezért rá fizetés nem rögzíthető.`;
    expect(refusal(() => app.recordPayment(credit.id, {}))).toMatchObject({ code: 'INVALID_INPUT', message });
    expect(refusal(() => app.recordPayment(credit.id, { amount: '-38100' }))).toMatchObject({ code: 'INVALID_INPUT', message });
    expect(app.getInvoice(credit.id)).toMatchObject({ paidAmount: '0', paidDate: null });
    expect(app.auditLog({ entityId: credit.id }).items.some((e) => e.action === 'invoice.payment')).toBe(false);
  });

  it('an upward modification of a cancelled invoice: nothing owed, no payment', async () => {
    const app = setup();
    const { modification: upward } = await chain(app, '2'); // +38 100
    expect(app.openAmount(upward)).toBeNull();
    expect(refusal(() => app.recordPayment(upward.id, {}))?.message).toMatch(/sztornó számla ezt is semlegesítette/);
    expect(refusal(() => app.recordPayment(upward.number as string, { amount: '38100' }))?.message).toMatch(/sztornó számla ezt is semlegesítette/);
    expect(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total).toBe(0);
  });

  it('the cancelled original and its storno stay refused as before', async () => {
    const app = setup();
    const { original, storno } = await chain(app, '1');
    expect([app.openAmount(original), app.openAmount(storno)]).toEqual([null, null]);
    expect(refusal(() => app.recordPayment(original.id, {}))?.message).toBe('Sztornózott számlára nem rögzíthető fizetés.');
    expect(refusal(() => app.recordPayment(storno.id, { amount: '1' }))?.message).toBe('Sztornó számlára nem rögzíthető fizetés.');
  });
});
