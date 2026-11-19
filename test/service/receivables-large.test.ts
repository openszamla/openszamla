/**
 * NAV-7: the receivables of report_summary (and the web dashboard) count and sum every open document –
 * more than 10 000 of them, and more than 10 000 crediting modifications – exactly as invoice_list and
 * setup_status count them. The bulk documents go straight through the store (insertDraft + markIssued,
 * as issue() writes them), without PDFs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.ts';
import type { Invoice } from '../../src/core/types.ts';
import { invoiceContentHash, type OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const addDays = (iso: string, d: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

/** Writes a copy of `template` as an issued document (store level, like issue() does). */
function writeIssued(app: OpenSzamla, template: Invoice, number: string, change: (inv: Invoice) => void): Invoice {
  const inv: Invoice = structuredClone(template);
  inv.id = newId('inv');
  change(inv);
  inv.number = null;
  inv.status = 'draft';
  inv.issuedAt = null;
  inv.contentHash = null;
  app.store.insertDraft(inv);
  inv.number = number;
  inv.status = 'issued';
  inv.issuedAt = `${inv.issueDate}T10:00:00.000Z`;
  inv.contentHash = invoiceContentHash(inv);
  app.store.markIssued(inv);
  return inv;
}

describe('receivables over more than 10 000 documents (NAV-7)', () => {
  it('counts and sums every unpaid invoice and nets every credit note, like invoice_list and setup_status', async () => {
    t = makeTestApp({ now: () => new Date('2026-12-30T09:00:00.000Z') });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const draft = await app.createDraft({ customerId, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const first = (await app.issue(draft.invoice.id)).invoice; // 12 700 Ft
    const credit = (await app.issue((await app.createCorrectionDraft(first.id, { lines: [{ description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] })).invoice.id)).invoice; // −1 270 Ft

    const TOTAL = 10_020;
    app.store.tx(() => {
      for (let n = 2; n <= TOTAL; n++) {
        // The oldest first: ~30 a day from 2026-01-02, each due 8 days later (all overdue on 2026-12-30).
        const issueDate = addDays('2026-01-02', Math.floor(n / 30));
        const original = writeIssued(app, first, `T-${n}`, (inv) => {
          inv.issueDate = issueDate;
          inv.fulfillmentDate = issueDate;
          inv.dueDate = addDays(issueDate, 8);
        });
        writeIssued(app, credit, `TJ-${n}`, (inv) => {
          inv.issueDate = issueDate;
          inv.fulfillmentDate = issueDate;
          inv.dueDate = issueDate;
          inv.reference = { ...(inv.reference as NonNullable<Invoice['reference']>), originalInvoiceId: original.id, originalInvoiceNumber: `T-${n}` };
        });
      }
    });
    // A few of them partly paid, the oldest one among them.
    const oldest = app.findInvoices({ receivable: true, sort: 'issued_asc', limit: 3, offset: 0 }).items;
    for (const inv of oldest) app.recordPayment(inv.id, { amount: '1000' });

    const today = app.today();
    const listed = app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'], limit: 1, offset: 0 }).total;
    const overdue = app.findInvoices({ overdueOn: today, limit: 1, offset: 0 }).total;
    // Every one is open; all but the first (issued today, due in 8 days) are overdue.
    expect([listed, overdue]).toEqual([TOTAL, TOTAL - 1]);
    const r = app.report({ from: '2026-12-01', to: '2026-12-30' }).receivables;
    expect(r.unpaidCount).toBe(listed);
    expect(r.overdueCount).toBe(overdue);
    expect(app.status().counts.unpaid).toBe(listed);
    // Each 12 700 Ft invoice less its 1 270 Ft credit, less the three 1 000 Ft payments.
    expect(r.unpaidGrossHuf).toBe(String(TOTAL * 11_430 - 3 * 1_000));
    expect(r.overdueGrossHuf).toBe(String((TOTAL - 1) * 11_430 - 3 * 1_000));
  });
});
