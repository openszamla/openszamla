/**
 * The preview of a modification says what it does to its invoice. A modification's lines are differences; an agent (or a
 * person) who gives the corrected line instead – "12 hours" for "change 10 hours to 12", "14 000" for "the price should
 * be 14 000" – got a draft that looks fine on its own: positive lines, a sensible total. Issued, the invoice came to
 * 22 hours. The preview now carries the totals of the invoice with its modifications before and with this one, and a
 * line that repeats a line of the original is flagged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import type { InvoiceView, OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  t = makeTestApp();
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const line = (quantity: string, unitPrice: string, description = 'Szoftverfejlesztés') => ({ description, quantity, unit: 'óra', unitPrice, vatCode: '27' as const });

/** 10 hours × 15 000 Ft: net 150 000, gross 190 500. */
async function original(app: OpenSzamla): Promise<Invoice> {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  return (await app.issue((await app.createDraft({ customerId, lines: [line('10', '15000')] })).invoice.id)).invoice;
}

const repeats = (v: InvoiceView): string[] => v.issues.filter((i) => i.code === 'CORRECTION_LINE_REPEATS_ORIGINAL').map((i) => `${i.severity} ${i.field}`);

describe('the preview of a modification: what it does to the invoice', () => {
  it('the corrected line given instead of the difference: the totals show the invoice doubling, the line is flagged', async () => {
    const app = setup();
    const inv = await original(app);
    // "Change 10 hours to 12" given as the new line.
    const wrong = await app.createCorrectionDraft(inv.id, { lines: [line('12', '15000')], comment: 'Mennyiség javítása' });
    expect(wrong.chain).toEqual({
      originalNumber: inv.number,
      modifications: 0,
      currency: 'HUF',
      before: { netAmount: '150000', vatAmount: '40500', grossAmount: '190500' },
      after: { netAmount: '330000', vatAmount: '89100', grossAmount: '419100' },
    });
    expect(repeats(wrong)).toEqual(['warning lines[0]']);
    const message = wrong.issues.find((i) => i.code === 'CORRECTION_LINE_REPEATS_ORIGINAL')?.message ?? '';
    expect(message).toContain('az eredeti számla 1. tételének');
    expect(message).toContain('A módosító számla tételei különbözetek');
    // A warning: more of the same item can be billed too.
    expect(wrong.readyToIssue).toBe(true);
    app.deleteDraft(wrong.invoice.id);

    // The difference: 2 more hours.
    const right = await app.createCorrectionDraft(inv.id, { lines: [line('2', '15000')], comment: 'Mennyiség javítása' });
    expect(right.chain?.after).toEqual({ netAmount: '180000', vatAmount: '48600', grossAmount: '228600' });
    expect(repeats(right)).toEqual([]);
  });

  it('a new price given as the price: flagged; the price difference is not', async () => {
    const app = setup();
    const inv = await original(app);
    const wrong = await app.createCorrectionDraft(inv.id, { lines: [line('10', '14000')], comment: 'Ár javítása' });
    expect(repeats(wrong)).toEqual(['warning lines[0]']);
    expect(wrong.chain?.after.grossAmount).toBe('368300');
    app.deleteDraft(wrong.invoice.id);

    const right = await app.createCorrectionDraft(inv.id, { lines: [line('10', '-1000')], comment: 'Ár javítása' });
    expect(repeats(right)).toEqual([]);
    expect(right.chain?.after).toEqual({ netAmount: '140000', vatAmount: '37800', grossAmount: '177800' });
    // Another item, or the same one taken back, is no repetition either.
    app.deleteDraft(right.invoice.id);
    const other = await app.createCorrectionDraft(inv.id, { lines: [line('10', '15000', 'Betanítás'), line('-10', '15000')], comment: 'Csere' });
    expect(repeats(other)).toEqual([]);
  });

  it('counts the modifications already issued; viewInvoice gives the same; other drafts have no chain', async () => {
    const app = setup();
    const inv = await original(app);
    await app.issue((await app.createCorrectionDraft(inv.id, { lines: [line('2', '15000')], comment: 'Első' })).invoice.id);
    const second = await app.createCorrectionDraft(inv.id, { lines: [line('1', '-5000', 'Engedmény')], comment: 'Második' });
    expect(second.chain).toMatchObject({ modifications: 1, before: { grossAmount: '228600' }, after: { grossAmount: '222250' } });
    expect(app.viewInvoice(second.invoice.id).chain).toEqual(second.chain);
    const plain = await app.createDraft({ customerId: inv.customerId as string, lines: [line('1', '1000')] });
    expect(plain.chain).toBeUndefined();
    expect(app.viewInvoice(inv.id).chain).toBeUndefined();
  });
});
