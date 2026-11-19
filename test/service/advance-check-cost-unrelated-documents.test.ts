/**
 * EX3: the advance checks (advanceDeductionIssues of a végszámla draft, deductedAdvanceIssues of the storno or
 * modification of an előlegszámla) select in SQL only the documents whose lines name the advance – one query for all
 * the advances of a document –, instead of loading and parsing every document issued since the advance (once per
 * advance, with OFFSET pages). They run on every draft view and inside the issue transaction.
 *
 * Timing guards with generous ratios: with 10× more unrelated documents issued after the advance the check may grow
 * at most linearly (a quadratic growth – the paged load of every document – fails), and it costs well under reading
 * those documents once. The results stay the same: deductions by other issued documents are still counted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { bestOf, lowestRatios, writeIssuedCopies } from '../helpers/bulk-documents.ts';

const apps: TestApp[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.cleanup();
});

const line = (description: string, quantity: string, unitPrice: string, extra: Partial<LineInput> = {}): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27', ...extra });
const deduction = (advance: Invoice, net: string): LineInput =>
  line('Előleg levonása', '-1', net, { advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: advance.fulfillmentDate } });

/** An advance (300 000 Ft net), `unrelated` other issued documents after it, and a végszámla draft deducting the advance. */
async function setup(unrelated: number): Promise<{ app: OpenSzamla; advance: Invoice; final: Invoice; customerId: string }> {
  const t = makeTestApp({ confirmMode: 'none' });
  apps.push(t);
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const advance = (await app.issue((await app.createDraft({ customerId, documentType: 'advance', lines: [line('Előleg', '1', '300000')] })).invoice.id)).invoice;
  const template = (await app.issue((await app.createDraft({ customerId, lines: [line('Szerviz', '2', '15000'), line('Alkatrész', '1', '9990'), line('Kiszállás', '3', '1200')] })).invoice.id)).invoice;
  writeIssuedCopies(app, template, unrelated, 'U');
  const final = (await app.createDraft({ documentType: 'final', customerId, lines: [line('Gépsor', '1', '1000000'), deduction(advance, '300000')] })).invoice;
  return { app, advance, final, customerId };
}

/** Reading the issued documents since the advance once, in one query – what the check must stay well under. */
const readAll = (s: { app: OpenSzamla; advance: Invoice }): unknown =>
  s.app.store.findInvoices({ status: ['issued', 'cancelled'], issueDateFrom: s.advance.issueDate, sort: 'issued_asc', limit: 1_000_000, offset: 0 });

describe('the advance checks do not read the unrelated documents (EX3)', () => {
  it('a végszámla draft view and the storno preview of the advance: linear at most, far below a read of the documents', async () => {
    const small = await setup(300);
    const large = await setup(3000);
    const cost = async (s: Awaited<ReturnType<typeof setup>>) => ({
      view: await bestOf(5, () => s.app.viewInvoice(s.final.id)),
      preview: await bestOf(5, () => s.app.stornoPreview(s.advance.id, 'Téves előlegszámla')),
      read: await bestOf(3, () => readAll(s)),
    });
    // 10× the documents: linear growth is about 10×, the paged load of every document about 50× (quadratic).
    // The check is a text filter in SQL: well under parsing every document once (…OfRead: of one read of the large set).
    const LIMITS = { view: 30, preview: 30, viewOfRead: 0.6, previewOfRead: 0.6 };
    const { lowest, measured } = await lowestRatios(LIMITS, async () => {
      const a = await cost(small);
      const b = await cost(large);
      return { view: b.view / a.view, preview: b.preview / a.preview, viewOfRead: b.view / b.read, previewOfRead: b.preview / b.read };
    });
    for (const k of ['view', 'preview', 'viewOfRead', 'previewOfRead'] as const) expect(lowest[k], `${k}: ${JSON.stringify(measured)}`).toBeLessThan(LIMITS[k]);
  });

  it('still counts every issued document deducting the advance, with many unrelated ones among them', async () => {
    const s = await setup(400);
    const { app, advance, customerId } = s;
    // An issued végszámla deducting 200 000 of the 300 000 advance …
    const first = (await app.issue((await app.createDraft({ documentType: 'final', customerId, lines: [line('Első szakasz', '1', '700000'), deduction(advance, '200000')] })).invoice.id)).invoice;
    // … and a draft deducting 300 000 more: together over the advance.
    const view = app.viewInvoice(s.final.id);
    expect(view.issues.filter((i) => i.code === 'ADVANCE_DEDUCTION_EXCEEDS_ADVANCE').map((i) => i.message)).toEqual([
      `A(z) ${advance.number} előlegszámláról (27) összesen 500000 HUF nettó kerülne levonásra (a már kiállított végszámlákkal együtt), az előleg nettó összege viszont 300000 HUF. Ellenőrizd, nem vonod-e le kétszer.`,
    ]);
    // The advance it deducts cannot be cancelled; once that végszámla is cancelled, it can.
    expect(app.stornoPreview(advance.id, 'Téves előlegszámla').issues.filter((i) => i.code === 'ADVANCE_STILL_DEDUCTED').map((i) => i.message)).toEqual([
      expect.stringContaining(`A(z) ${advance.number} előlegszámlát a(z) ${first.number} végszámla levonja (27 ÁFA-kód, nettó 200000 HUF), ezért nem sztornózható`),
    ]);
    await app.cancel(first.id, { reason: 'Téves végszámla' });
    expect(app.stornoPreview(advance.id, 'Téves előlegszámla').issues.filter((i) => i.code === 'ADVANCE_STILL_DEDUCTED')).toEqual([]);
    expect(app.viewInvoice(s.final.id).issues.filter((i) => i.code === 'ADVANCE_DEDUCTION_EXCEEDS_ADVANCE')).toEqual([]);
  });

  it('one draft deducting several advances: each checked against its own deductions', async () => {
    const s = await setup(50);
    const { app, advance, customerId } = s;
    const second = (await app.issue((await app.createDraft({ documentType: 'advance', customerId, lines: [line('Előleg 2', '1', '100000')] })).invoice.id)).invoice;
    await app.issue((await app.createDraft({ documentType: 'final', customerId, lines: [line('Részteljesítés', '1', '500000'), deduction(second, '100000')] })).invoice.id);
    const both = (await app.createDraft({ documentType: 'final', customerId, lines: [line('Gépsor', '1', '2000000'), deduction(advance, '300000'), deduction(second, '50000')] })).invoice;
    const exceeds = app.viewInvoice(both.id).issues.filter((i) => i.code === 'ADVANCE_DEDUCTION_EXCEEDS_ADVANCE');
    expect(exceeds.map((i) => i.field)).toEqual(['lines[2].advanceDeduction.advanceInvoiceNumber']);
    expect(exceeds[0]?.message).toContain(`A(z) ${second.number} előlegszámláról (27) összesen 150000 HUF nettó kerülne levonásra`);
  });
});
