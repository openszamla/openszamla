/**
 * MCP-4: an invoice converted from a paid díjbekérő (invoice_draft copyFromId) takes the payment over
 * when it is issued – amount, date and status (mutable data: the content and its hash stay as issued),
 * logged, never counted twice; the preview and the issue result name it, and a payment made before the
 * fulfilment date (an advance) is flagged. The document type is never changed automatically.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { invoiceContentHash, type OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(now: string): { app: OpenSzamla; clock: { now: Date } } {
  const clock = { now: new Date(now) };
  t = makeTestApp({ now: () => clock.now });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, clock };
}

const LICENCE = [{ description: 'Licenc', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' as const }]; // 127 000 Ft

async function paidProforma(app: OpenSzamla, amount?: string): Promise<Invoice> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const d = await app.createDraft({ documentType: 'proforma', customerId, lines: LICENCE });
  const p = (await app.issue(d.invoice.id)).invoice;
  if (amount !== '0') app.recordPayment(p.id, { ...(amount ? { amount } : {}), date: '2026-11-05' });
  return app.getInvoice(p.id);
}

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);
const ft = (v: string): string => formatMoney(v, 'HUF');

describe('converting a paid díjbekérő carries its payment over (MCP-4)', () => {
  it('the preview names the payment and asks about the fulfilment date; issuing takes it over, logged', async () => {
    const { app } = setup('2026-11-08T09:00:00.000Z');
    const proforma = await paidProforma(app);
    expect(proforma.paymentStatus).toBe('paid');
    const draft = await app.createDraft({ copyFromId: proforma.id });
    expect(draft.invoice).toMatchObject({ documentType: 'invoice', fulfillmentDate: '2026-11-08', proformaId: proforma.id });
    const carried = draft.issues.find((i) => i.code === 'PROFORMA_PAYMENT_CARRIED');
    expect(carried).toMatchObject({ severity: 'warning' });
    expect(carried?.message).toContain('DB-2026-00001');
    expect(carried?.message).toContain(ft('127000'));
    expect(carried?.message).toContain('ne rögzítsd újra');
    const early = draft.issues.find((i) => i.code === 'PROFORMA_PAID_BEFORE_FULFILLMENT');
    expect(early).toMatchObject({ severity: 'warning', field: 'fulfillmentDate' });
    expect(early?.message).toMatch(/előlegszámla/);
    expect(draft.readyToIssue).toBe(true);

    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ documentType: 'invoice', paymentStatus: 'paid', paidAmount: '127000', paidDate: '2026-11-05' });
    expect(r.notes.join(' ')).toContain(`A(z) DB-2026-00001 díjbekérőre rögzített befizetés (${ft('127000')}, 2026.11.05.) átkerült erre a számlára`);
    expect(r.notes.join(' ')).toContain('Ne rögzítsd újra.');
    // Mutable data only: the content (and its hash) are as issued.
    expect(r.invoice.contentHash).toBe(invoiceContentHash(r.invoice));
    expect(app.verifyIntegrity().ok).toBe(true);
    const entry = app.auditLog({ entityId: r.invoice.id }).items.find((e) => e.action === 'invoice.payment');
    expect(entry?.details).toMatchObject({ amount: '127000', date: '2026-11-05', paymentStatus: 'paid', proforma: 'DB-2026-00001', proformaId: proforma.id });
    // Not a receivable; recording it again is refused (the default and the same amount alike).
    expect(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total).toBe(0);
    expect(() => app.recordPayment(r.invoice.id, {})).toThrow(/teljesen ki van fizetve/);
    expect(() => app.recordPayment(r.invoice.id, { amount: '127000', date: '2026-11-05' })).toThrow(/kétszer számolná/);
    // A carried payment can be taken back like any other.
    expect(app.recordPayment(r.invoice.id, { amount: '-127000' })).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
  });

  it('a partly paid díjbekérő: the invoice is partial, the rest can be paid, more than that cannot', async () => {
    const { app } = setup('2026-11-05T09:00:00.000Z');
    const proforma = await paidProforma(app, '50000');
    const draft = await app.createDraft({ copyFromId: proforma.number as string });
    // Paid the same day as the fulfilment: no question about an advance.
    expect(codes(draft.issues)).toContain('PROFORMA_PAYMENT_CARRIED');
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAID_BEFORE_FULFILLMENT');
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ paymentStatus: 'partial', paidAmount: '50000' });
    // The full price on top of the carried payment – more than is owed – would count the same money twice.
    expect(() => app.recordPayment(r.invoice.id, { amount: '127000' })).toThrow(`hátralék: ${ft('77000')}`);
    // A payment within what is owed is accepted; the carried amount once more, now over what is owed, is not.
    expect(app.recordPayment(r.invoice.id, { amount: '30000' })).toMatchObject({ paymentStatus: 'partial', paidAmount: '80000' });
    expect(() => app.recordPayment(r.invoice.id, { amount: '50000' })).toThrow(`hátralék: ${ft('47000')}`);
    expect(app.recordPayment(r.invoice.id, {})).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
  });

  it('the fulfilment date given as the payment day silences the question; an advance invoice is checked against it', async () => {
    const { app } = setup('2026-11-08T09:00:00.000Z');
    const proforma = await paidProforma(app);
    const onTime = await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-05' });
    expect(codes(onTime.issues)).not.toContain('PROFORMA_PAID_BEFORE_FULFILLMENT');
    const advance = await app.createDraft({ copyFromId: proforma.id, documentType: 'advance' });
    expect(advance.invoice.documentType).toBe('advance');
    expect(advance.issues.find((i) => i.code === 'PROFORMA_PAID_BEFORE_FULFILLMENT')?.message).toMatch(/Előlegszámlán a teljesítés dátuma az előleg kézhezvételének/);
    const fixed = await app.updateDraft(advance.invoice.id, { fulfillmentDate: '2026-11-05' });
    expect(codes(fixed.issues)).not.toContain('PROFORMA_PAID_BEFORE_FULFILLMENT');
    expect(fixed.invoice.documentType).toBe('advance');
  });

  it('a díjbekérő invoiced a second time: a warning, and its payment is not carried again', async () => {
    const { app } = setup('2026-11-05T09:00:00.000Z');
    const proforma = await paidProforma(app);
    const first = await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id);
    expect(first.invoice.paymentStatus).toBe('paid');
    const second = await app.createDraft({ copyFromId: proforma.id });
    expect(second.issues.find((i) => i.code === 'PROFORMA_ALREADY_INVOICED')?.message).toContain(first.invoice.number as string);
    expect(codes(second.issues)).not.toContain('PROFORMA_PAYMENT_CARRIED');
    const r = await app.issue(second.invoice.id);
    expect(r.invoice).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    expect(r.notes.join(' ')).toMatch(/már kiállítottak bizonylatot \(SZ-2026-00001\)/);
    // Once the first invoice is cancelled, a new conversion takes the payment over.
    await app.cancel(first.invoice.id, { reason: 'Téves számla' });
    await app.cancel(r.invoice.id, { reason: 'Téves számla' });
    const third = await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id);
    expect(third.invoice.paymentStatus).toBe('paid');
  });

  it('nothing is carried from an unpaid díjbekérő, from a copied invoice, or in another currency', async () => {
    const { app } = setup('2026-11-05T09:00:00.000Z');
    const unpaid = await paidProforma(app, '0');
    const fromUnpaid = await app.createDraft({ copyFromId: unpaid.id });
    expect(codes(fromUnpaid.issues).filter((c) => c.startsWith('PROFORMA_'))).toEqual([]);
    expect((await app.issue(fromUnpaid.invoice.id)).invoice.paymentStatus).toBe('unpaid');

    // Paid on the díjbekérő after it was invoiced: the invoice keeps its own payment data.
    app.recordPayment(unpaid.id, { date: '2026-11-05' });
    expect(app.getInvoice(fromUnpaid.invoice.id).paymentStatus).toBe('unpaid');
    const paid = await paidProforma(app);
    const invoice = (await app.issue((await app.createDraft({ copyFromId: paid.id })).invoice.id)).invoice;
    expect(invoice.paymentStatus).toBe('paid');
    // A copy of that invoice is not made from the díjbekérő.
    const copy = await app.createDraft({ copyFromId: invoice.id });
    expect(copy.invoice.proformaId).toBeUndefined();
    expect((await app.issue(copy.invoice.id)).invoice.paymentStatus).toBe('unpaid');
  });

  it('a payment in another currency than the invoice is named, not carried', async () => {
    const { app } = setup('2026-11-05T09:00:00.000Z');
    const proforma = await paidProforma(app);
    const draft = await app.createDraft({ copyFromId: proforma.id, currency: 'EUR', exchangeRate: '400' });
    expect(draft.issues.find((i) => i.code === 'PROFORMA_PAYMENT_NOT_CARRIED')?.message).toMatch(/pénzneme eltér/);
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice.paymentStatus).toBe('unpaid');
    expect(r.notes.join(' ')).toMatch(/nem került át/);
  });
});
