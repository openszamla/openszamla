/**
 * verify and the paid amount of a document. The payment ledger is append-only (triggers), but a document's paid amount
 * and payment status are plain columns – not part of the content hash, since payments change them –, so a database tool
 * could mark an unpaid invoice paid without a trace. verify now compares every document's paid amount with what the
 * ledger allocated to it.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const ft = (v: string): string => formatMoney(v, 'HUF');

describe('verify: the paid amount against the payment ledger', () => {
  it('payments, a reversal, a modification and a storno keep it in agreement; a paid amount written from outside is found', async () => {
    t = makeTestApp();
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const invoice = async (unitPrice: string) => (await app.issue((await app.createDraft({ customerId, lines: [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice, vatCode: '27' }] })).invoice.id)).invoice;
    const paid = await invoice('10000'); // 12 700
    app.recordPayment(paid.id, { amount: '5000' });
    app.recordPayment(paid.id, { amount: '-2000' });
    app.recordPayment(paid.id, {});
    const corrected = await invoice('100000'); // 127 000
    await app.issue((await app.createCorrectionDraft(corrected.id, { lines: [{ description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }], comment: 'Engedmény' })).invoice.id);
    app.recordPayment(corrected.id, {});
    const cancelled = await invoice('20000'); // 25 400
    app.recordPayment(cancelled.id, {});
    await app.cancel(cancelled.id, { reason: 'Téves számla' });
    const unpaid = await invoice('30000'); // 38 100

    expect(app.verifyIntegrity()).toMatchObject({ ok: true, paymentMismatches: [] });

    // Marked paid with a database tool: no payment behind it.
    const raw = new DatabaseSync(app.config.dbPath);
    raw.prepare(`UPDATE invoices SET paid_amount = '38100', payment_status = 'paid' WHERE id = ?`).run(unpaid.id);
    raw.close();
    const v = app.verifyIntegrity();
    expect(v.ok).toBe(false);
    expect(v.paymentMismatches).toEqual([`${unpaid.number}: a bizonylat befizetett összege (${ft('38100')}) eltér a befizetési naplóban rá jutó összegtől (${ft('0')}).`]);
    // Nothing else is wrong with the database.
    expect(v).toMatchObject({ invoiceMismatches: [], auditMismatches: [], unauditedInvoices: [], numberingGaps: [], alteredTriggers: [], documentMismatches: [], audit: { ok: true } });
  });
});
