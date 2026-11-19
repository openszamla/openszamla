/**
 * A díjbekérő payment is never carried onto a converted document that deducts an advance (PC1): the money
 * paid on the díjbekérő is probably the advance the document deducts, recorded on the előlegszámla –
 * carried, it would count twice (the végszámla's payable is already net of it). The preview warns
 * PROFORMA_PAYMENT_NOT_CARRIED with what to do, issuing records nothing and says so, and the question about
 * an advance (PROFORMA_PAID_BEFORE_FULFILLMENT) is not asked: the előlegszámla exists already. Covered with a
 * partial (30%) and a 50% deduction, and with the whole advance deducted (nothing payable).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const line = (description: string, quantity: string, unitPrice: string, extra: Partial<LineInput> = {}): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27', ...extra });
const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);
const notCarried = (issues: ValidationIssue[]): ValidationIssue | undefined => issues.find((i) => i.code === 'PROFORMA_PAYMENT_NOT_CARRIED');
const payments = (app: OpenSzamla, id: string): unknown[] => app.auditLog({ entityId: id }).items.filter((e) => e.action === 'invoice.payment').map((e) => e.details.amount);

/**
 * A díjbekérő of 127 000 Ft (net 100 000); the buyer pays `deposit` on 2026-11-03 (recorded on the díjbekérő); the
 * előlegszámla of the deposit (net `advanceNet`) is made by hand; the végszámla converted from the díjbekérő
 * deducts that advance.
 */
async function finalDeducting(app: OpenSzamla, customerId: string, deposit: string, advanceNet: string): Promise<{ proforma: Invoice; advance: Invoice; draft: Awaited<ReturnType<OpenSzamla['createDraft']>> }> {
  const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: [line('Gépsor', '1', '100000')] })).invoice.id)).invoice;
  app.recordPayment(proforma.id, { amount: deposit, date: '2026-11-03' });
  const advance = (await app.issue((await app.createDraft({ documentType: 'advance', customerId, fulfillmentDate: '2026-11-03', lines: [line('Előleg', '1', advanceNet)] })).invoice.id)).invoice;
  const draft = await app.createDraft({
    copyFromId: proforma.id,
    documentType: 'final',
    fulfillmentDate: '2026-11-14',
    lines: [line('Gépsor', '1', '100000'), line('Előleg levonása', '-1', advanceNet, { advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: '2026-11-03' } })],
  });
  return { proforma: app.getInvoice(proforma.id), advance, draft };
}

const previewMessage = (proforma: string, paid: string, advance: string): string =>
  `A(z) ${proforma} díjbekérőre ${ft(paid)} befizetés van rögzítve (2026.11.03.), de a bizonylat levonja a(z) ${advance} előlegszámlát, ezért kiállításkor nem kerül át: ` +
  'a díjbekérő befizetése valószínűleg ez az előleg, így az előlegszámlához tartozik – ha ott még nincs rögzítve, ott rögzítsd. ' +
  'Ha a vevő erre a bizonylatra is fizetett, azt a kiállítás után rögzítsd.';

const issueNote = (proforma: string, paid: string, advance: string): string =>
  `A(z) ${proforma} díjbekérőre rögzített befizetés (${ft(paid)}) nem került át: a számla levonja a(z) ${advance} előlegszámlát. ` +
  'A díjbekérő befizetése valószínűleg ez az előleg, így az előlegszámlához tartozik – ha ott még nincs rögzítve, ott rögzítsd. ' +
  'Ha a vevő erre a számlára is fizetett, azt ezen a számlán rögzítsd.';

describe('a végszámla deducting an advance gets no díjbekérő payment (PC1)', () => {
  it('a partial (30%) deduction: warned in the preview, issued without the payment, owed in full', async () => {
    const { app, customerId } = setup();
    const { proforma, advance, draft } = await finalDeducting(app, customerId, '38100', '30000');
    // The deposit is the előlegszámla's money: recorded there.
    expect(app.recordPayment(advance.id, { date: '2026-11-03' })).toMatchObject({ paymentStatus: 'paid', paidAmount: '38100' });
    expect(draft.invoice.totals.payableAmount).toBe('88900');
    expect(draft.readyToIssue).toBe(true);
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAYMENT_CARRIED');
    // The előlegszámla exists already: no question whether one is needed.
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAID_BEFORE_FULFILLMENT');
    expect(notCarried(draft.issues)).toEqual({
      severity: 'warning',
      code: 'PROFORMA_PAYMENT_NOT_CARRIED',
      message: previewMessage(proforma.number as string, '38100', advance.number as string),
      field: 'lines[1].advanceDeduction',
    });
    // markPaid would record the whole payable: nothing comes from the díjbekérő.
    expect(app.markPaidAmount(draft.invoice.id)).toBe('88900');

    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ status: 'issued', documentType: 'final', paidAmount: '0', paidDate: null, paymentStatus: 'unpaid' });
    expect(payments(app, r.invoice.id)).toEqual([]);
    expect(r.notes).toContain(issueNote(proforma.number as string, '38100', advance.number as string));
    expect(app.openAmount(app.getInvoice(r.invoice.id))).toBe('88900');
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toMatchObject({ unpaidCount: 1, unpaidGrossHuf: '88900' });
    // The díjbekérő keeps its payment; the rest the buyer pays is recorded on the végszámla.
    expect(app.getInvoice(proforma.id)).toMatchObject({ paidAmount: '38100' });
    expect(app.recordPayment(r.invoice.id, {})).toMatchObject({ paymentStatus: 'paid', paidAmount: '88900' });
  });

  it('a 50% deduction: the végszámla is not shown as paid, and the deposit can still go on the előlegszámla', async () => {
    const { app, customerId } = setup();
    const { proforma, advance, draft } = await finalDeducting(app, customerId, '63500', '50000');
    expect(draft.invoice.totals.payableAmount).toBe('63500');
    expect(notCarried(draft.issues)?.message).toBe(previewMessage(proforma.number as string, '63500', advance.number as string));
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAYMENT_CARRIED');

    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ paidAmount: '0', paymentStatus: 'unpaid' });
    expect(app.openAmount(app.getInvoice(r.invoice.id))).toBe('63500');
    // Both are owed until the deposit is recorded on the előlegszámla.
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toMatchObject({ unpaidCount: 2, unpaidGrossHuf: '127000' });
    // What the note says: record the deposit on the előlegszámla, where it has not been recorded yet.
    expect(app.recordPayment(advance.id, { date: '2026-11-03' })).toMatchObject({ paymentStatus: 'paid', paidAmount: '63500' });
    expect(app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables).toMatchObject({ unpaidCount: 1, unpaidGrossHuf: '63500' });
  });

  it('the whole advance deducted (nothing payable): the reason stays the payable, and no advance question either', async () => {
    const { app, customerId } = setup();
    const { proforma, draft } = await finalDeducting(app, customerId, '127000', '100000');
    expect(draft.invoice.totals.payableAmount).toBe('0');
    expect(notCarried(draft.issues)).toMatchObject({ field: 'totals.payableAmount' });
    expect(notCarried(draft.issues)?.message).toContain(`de a bizonylat fizetendő összege ${ft('0')}, ezért kiállításkor nem kerül át`);
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAID_BEFORE_FULFILLMENT');
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ paidAmount: '0' });
    expect(r.notes.join(' ')).toContain(`A(z) ${proforma.number} díjbekérőre rögzített befizetés (${ft('127000')}) nem került át: a számla fizetendő összege ${ft('0')}.`);
  });

  it('a conversion without a deduction still carries the payment and still asks about the advance', async () => {
    const { app, customerId } = setup();
    const proforma = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: [line('Gépsor', '1', '100000')] })).invoice.id)).invoice;
    app.recordPayment(proforma.id, { amount: '38100', date: '2026-11-03' });
    const draft = await app.createDraft({ copyFromId: proforma.id });
    expect(codes(draft.issues)).toEqual(expect.arrayContaining(['PROFORMA_PAYMENT_CARRIED', 'PROFORMA_PAID_BEFORE_FULFILLMENT']));
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAYMENT_NOT_CARRIED');
    expect((await app.issue(draft.invoice.id)).invoice).toMatchObject({ paidAmount: '38100', paymentStatus: 'partial' });
  });
});
