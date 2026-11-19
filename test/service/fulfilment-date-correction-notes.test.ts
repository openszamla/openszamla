/**
 * report_summary / export_invoices after a modification that corrected an invoice's fulfilment date (T2.3):
 * every document counts in the period of its own fulfilment date – the original stays in its period, the
 * correcting modification and the later corrections and stornos count in the corrected one –, so a period
 * holding a document of such a chain gets a note (both date bases) naming the invoices and both dates;
 * whether the original period needs a self-revision is the accountant's call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const line = (description: string, quantity: string, unitPrice: string): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27' });

const NOTE =
  'Teljesítési dátum javítása: a(z) SZ-2026-00001 számla teljesítési dátumát a(z) SZ-2026-00002 módosító számla javította (2026.10.15. → 2026.11.03.). ' +
  'A teljesítés dátuma szerinti válogatásban minden bizonylat a saját teljesítési dátuma szerinti időszakba kerül: az eredeti számla az eredeti dátum időszakában marad, ' +
  'a dátumot javító módosító számla és az utána kiállított módosító és sztornó számlák a javított dátum időszakában számítanak. ' +
  'Hogy az eredeti időszakot önellenőrzéssel kell-e helyesbíteni, a könyvelő dönti el.';

/** SZ-2026-00001 (fulfilment 2026-10-15, VAT 54 000), its date corrected to 2026-11-03 by SZ-2026-00002, then cancelled (SZ-2026-00003). */
async function dateFixedChain() {
  t = makeTestApp({ now: () => new Date('2026-11-05T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const original = (await app.issue((await app.createDraft({ customerId, fulfillmentDate: '2026-10-15', lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
  const fix = (await app.issue((await app.createCorrectionDraft(original.id, { fulfillmentDate: '2026-11-03', lines: [line('Teljesítés dátuma helyesen: 2026.11.03.', '1', '0')], comment: 'Teljesítési dátum javítása' })).invoice.id)).invoice;
  const storno = (await app.cancel(original.id, { reason: 'Szerződés felbontva' })).invoice;
  expect([original.number, fix.number, storno.number, storno.fulfillmentDate]).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003', '2026-11-03']);
  return { app, customerId };
}

describe('a chain whose fulfilment date a modification corrected (T2.3)', () => {
  it('by fulfilment date: each document in its own period, and both periods carry the note', async () => {
    const { app } = await dateFixedChain();
    const october = app.report({ from: '2026-10-01', to: '2026-10-31', dateBasis: 'fulfillment' });
    expect([october.invoiceCount, october.totalsHuf.vat]).toEqual([1, '54000']);
    expect(october.notes).toEqual([NOTE]);
    const november = app.report({ from: '2026-11-01', to: '2026-11-30', dateBasis: 'fulfillment' });
    expect([november.invoiceCount, november.totalsHuf.vat]).toEqual([2, '-54000']);
    expect(november.notes).toEqual([NOTE]);
    expect(app.report({ from: '2026-12-01', to: '2026-12-31', dateBasis: 'fulfillment' }).notes).toEqual([]);
  });

  it('by issue date as well, and in the export (both bases)', async () => {
    const { app } = await dateFixedChain();
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).notes).toEqual([NOTE]);
    expect(app.report({ from: '2026-10-01', to: '2026-10-31' }).notes).toEqual([]);
    expect(app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'csv', dateBasis: 'fulfillment' }).notes).toEqual([NOTE]);
    expect(app.exportInvoices({ from: '2026-11-01', to: '2026-11-30', format: 'json' }).notes).toEqual([NOTE]);
  });

  it('no note when no modification moved the date, or one moved it back', async () => {
    const { app, customerId } = await dateFixedChain();
    const other = (await app.issue((await app.createDraft({ customerId, fulfillmentDate: '2026-11-04', lines: [line('Szerviz', '1', '100000')] })).invoice.id)).invoice;
    await app.issue((await app.createCorrectionDraft(other.id, { lines: [line('Árengedmény', '1', '-10000')], comment: 'Árengedmény' })).invoice.id);
    const back = (await app.issue((await app.createDraft({ customerId, fulfillmentDate: '2026-12-01', lines: [line('Szerviz', '1', '50000')] })).invoice.id)).invoice;
    await app.issue((await app.createCorrectionDraft(back.id, { fulfillmentDate: '2026-12-03', lines: [line('Teljesítés dátuma: 2026.12.03.', '1', '0')], comment: 'Dátum' })).invoice.id);
    await app.issue((await app.createCorrectionDraft(back.id, { fulfillmentDate: '2026-12-01', lines: [line('Teljesítés dátuma mégis: 2026.12.01.', '1', '0')], comment: 'Dátum vissza' })).invoice.id);
    // Only the date-fixed chain of SZ-2026-00001 is named.
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).notes).toEqual([NOTE]);
    expect(app.report({ from: '2026-12-01', to: '2026-12-31', dateBasis: 'fulfillment' }).notes).toEqual([]);
    expect(app.report({ from: '2026-11-04', to: '2026-11-04', dateBasis: 'fulfillment' }).notes).toEqual([]);
  });
});
