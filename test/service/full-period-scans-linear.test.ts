/**
 * EX4: the full-period scans – the documents of a period for report_summary, export_invoices and the tax-audit export
 * (allIssuedBetween), and verifyIntegrity over every issued document – read with one statement
 * (StatementSync#iterate), one document at a time. LIMIT/OFFSET pages sorted every matching row again for each page, so
 * a year of documents cost quadratically.
 *
 * Timing guard with a generous ratio: each scan is measured against one plain read of the same documents (one query,
 * every row parsed) at 500 and at 5 000 documents. With one statement the scan stays the same multiple of that read;
 * with pages its multiple grows with the number of documents. A ratio over the limit is measured again before the guard
 * fails (lowestRatios): a busy machine distorts one measurement, a paged scan is slow in every one.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { bestOf, lowestRatios, writeIssuedCopies } from '../helpers/bulk-documents.ts';

const apps: TestApp[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.cleanup();
});

const line = (description: string, quantity: string, unitPrice: string): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27' });
const dayOfYear = (n: number): string => new Date(Date.UTC(2026, 0, 2 + (n % 300))).toISOString().slice(0, 10);

/** `count` issued documents, spread over 2026 (and paid, so the receivables stay out of the way). */
async function yearOf(count: number): Promise<OpenSzamla> {
  const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-12-30T09:00:00.000Z') });
  apps.push(t);
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const template = (await app.issue((await app.createDraft({ customerId, lines: [line('Szerviz', '2', '15000'), line('Alkatrész', '1', '9990'), line('Kiszállás', '3', '1200')] })).invoice.id)).invoice;
  writeIssuedCopies(app, template, count - 1, 'Y', (inv, n) => {
    inv.issueDate = dayOfYear(n);
    inv.fulfillmentDate = inv.issueDate;
    inv.dueDate = inv.issueDate;
  });
  app.store.tx(() => {
    for (const inv of app.store.findInvoices({ status: ['issued'], limit: 1_000_000, offset: 0 }).items) app.store.patchInvoice(inv.id, { paymentStatus: 'paid', paidAmount: inv.totals.payableAmount });
  });
  return app;
}

/** The scans, each as a multiple of one plain read of all the documents. */
async function multiples(app: OpenSzamla): Promise<{ report: number; fulfilment: number; csv: number; verify: number }> {
  const read = await bestOf(3, () => app.store.findInvoices({ status: ['issued', 'cancelled'], sort: 'issued_asc', limit: 1_000_000, offset: 0 }));
  const of = async (fn: () => unknown): Promise<number> => (await bestOf(3, fn)) / read;
  return {
    report: await of(() => app.report({ from: '2026-01-01', to: '2026-12-31' })),
    fulfilment: await of(() => app.report({ from: '2026-01-01', to: '2026-12-31', dateBasis: 'fulfillment' })),
    csv: await of(() => app.exportInvoices({ from: '2026-01-01', to: '2026-12-31', format: 'csv' })),
    verify: await of(() => app.verifyIntegrity()),
  };
}

describe('the full-period scans cost linearly (EX4)', () => {
  it('report, export and verifyIntegrity stay the same multiple of one read from 500 to 5 000 documents', async () => {
    const small = await yearOf(500);
    const large = await yearOf(5000);
    // One statement: about the same multiple (measured ≈ 1.0–1.15); OFFSET pages: 2–3.6 times it at 5 000 documents.
    const LIMITS = { report: 1.6, fulfilment: 1.6, csv: 1.6, verify: 1.6 };
    const { lowest, measured } = await lowestRatios(LIMITS, async () => {
      const s = await multiples(small);
      const l = await multiples(large);
      return { report: l.report / s.report, fulfilment: l.fulfilment / s.fulfilment, csv: l.csv / s.csv, verify: l.verify / s.verify };
    });
    for (const k of ['report', 'fulfilment', 'csv', 'verify'] as const) expect(lowest[k], `${k}: ${JSON.stringify(measured)}`).toBeLessThan(LIMITS[k]);
  });

  it('a period of 5 000 documents is complete and in issue order', async () => {
    const app = await yearOf(5000);
    const r = app.report({ from: '2026-01-01', to: '2026-12-31' });
    expect(r.invoiceCount).toBe(5000);
    expect(r.byMonth.reduce((n, m) => n + m.count, 0)).toBe(5000);
    const v = app.verifyIntegrity();
    expect(v.invoicesChecked).toBe(5000);
    expect(v.invoiceMismatches).toEqual([]);
    const exp = app.exportInvoices({ from: '2026-01-01', to: '2026-12-31', format: 'json' });
    expect(exp.count).toBe(5000);
    const exported = JSON.parse(readFileSync(exp.path, 'utf8')) as Array<{ id: string; issueDate: string }>;
    expect(new Set(exported.map((i) => i.id)).size).toBe(5000);
    expect(exported.map((i) => i.issueDate)).toEqual(exported.map((i) => i.issueDate).sort());
  });
});
