/**
 * A modification lowering an előlegszámla as a whole is checked against everything the issued végszámlák
 * deduct from it, on all VAT codes together (T2.1, ADVANCE_STILL_DEDUCTED): also a deduction under a VAT
 * code the modification does not reduce, or the advance does not have (ADVANCE_DEDUCTION_VAT_CODE is only a
 * warning on the végszámla). Otherwise the advance could be reduced to nothing while a végszámla still
 * deducts it – the deal's VAT would be under-declared. Moving the advance between VAT codes and increasing
 * it stay possible; the per-code check on the codes a modification reduces is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sumDec, toDec } from '../../src/core/decimal.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { DraftInput, LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const errorCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);
const stillDeducted = (issues: ValidationIssue[]): string => issues.find((i) => i.code === 'ADVANCE_STILL_DEDUCTED')?.message ?? '';

/** Advance SZ-2026-00001: 300 000 Ft net at 27%. */
async function withAdvance() {
  t = makeTestApp({ now: () => new Date('2026-11-08T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const issue = async (input: DraftInput): Promise<Invoice> => {
    const d = await app.createDraft({ customerId, ...input });
    expect(errorCodes(d.issues), JSON.stringify(d.issues)).toEqual([]);
    return (await app.issue(d.invoice.id)).invoice;
  };
  const advance = await issue({ documentType: 'advance', fulfillmentDate: '2026-11-02', lines: [{ description: 'Előleg', quantity: '1', unit: 'db', unitPrice: '300000', vatCode: '27' }] });
  expect(advance.number).toBe('SZ-2026-00001');
  return { app, issue, advance };
}

const deduction = (unitPrice: string, vatCode: '27' | '5'): LineInput => ({
  description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice, vatCode, advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00001', advancePaymentDate: '2026-11-02' },
});

/** A végszámla of 1 000 000 Ft net at 27% with the given deduction lines. */
const finalWith = (...deductions: LineInput[]): DraftInput => ({
  documentType: 'final',
  lines: [{ description: 'Gépsor szállítása', quantity: '1', unit: 'db', unitPrice: '1000000', vatCode: '27' }, ...deductions],
});

const advanceLine = (unitPrice: string, vatCode: '27' | '5' = '27'): LineInput => ({ description: 'Előleg módosítása', quantity: '1', unit: 'db', unitPrice, vatCode });

describe('a modification lowering an advance: the deduction on all VAT codes together (T2.1)', () => {
  it('cannot reduce the advance to nothing while a végszámla deducts it under a VAT code the advance does not have', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue(finalWith(deduction('300000', '5')));
    // The storno was refused already (every code is checked); the modification must be as well.
    expect(errorCodes(app.stornoPreview(advance.id, 'Téves előlegszámla').issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);

    const m = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-300000')], comment: 'Az előleg nem érkezett meg' });
    expect(errorCodes(m.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    expect(m.readyToIssue).toBe(false);
    const message = stillDeducted(m.issues);
    expect(message).toContain(`A(z) SZ-2026-00001 előlegszámlát a(z) ${final.number} végszámla levonja (összesen nettó 300000 HUF, ebből 5 ÁFA-kóddal 300000 HUF)`);
    expect(message).toContain('a módosítás után viszont az előlegből összesen csak nettó 0 HUF maradna');
    expect(message).toMatch(/Előbb a végszámlát sztornózd vagy módosítsd/);

    await expect(app.issue(m.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [expect.objectContaining({ code: 'ADVANCE_STILL_DEDUCTED' })] } });
    // Nothing issued, no number used: the deal still nets to the sale.
    const issued = app.findInvoices({ status: ['issued'] }).items;
    expect(issued.map((i) => i.number).sort()).toEqual(['SZ-2026-00001', 'SZ-2026-00002']);
    expect(toDec(sumDec(issued.map((i) => i.totals.netAmount)))).toBe('1000000');
  });

  it('catches the total even when the reduced VAT code itself still covers its own deduction', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue(finalWith(deduction('200000', '27'), deduction('100000', '5')));
    // 27%: 300 000 − 100 000 = 200 000 left, exactly the 200 000 deducted there; all codes: 300 000 deducted, 200 000 left.
    const m = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-100000')], comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(m.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    expect(stillDeducted(m.issues)).toContain(`a(z) ${final.number} végszámla levonja (összesen nettó 300000 HUF, ebből 27 ÁFA-kóddal 200000 HUF, 5 ÁFA-kóddal 100000 HUF)`);
    expect(stillDeducted(m.issues)).toContain('összesen csak nettó 200000 HUF maradna');
  });

  it('a reduction the rest still covers, a move between VAT codes and an increase can be issued', async () => {
    const { app, issue, advance } = await withAdvance();
    await issue(finalWith(deduction('200000', '5')));

    const fits = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-100000')], comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(fits.issues)).toEqual([]);
    const reduced = (await app.issue(fits.invoice.id)).invoice;
    expect((await validateNavXml(buildInvoiceDataXml(reduced), 'data')).errors).toEqual([]);

    // Now the 200 000 deducted uses up what is left (200 000): one forint less is refused.
    const more = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-1')], comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(more.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    expect(stillDeducted(more.issues)).toContain('összesen csak nettó 199999 HUF maradna');
    app.deleteDraft(more.invoice.id);

    // The total does not go down: moving the advance to the VAT code the végszámla deducts it with is allowed.
    const move = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-200000'), advanceLine('200000', '5')], comment: 'Az előleg 5%-os kulccsal számlázandó' });
    expect(errorCodes(move.issues)).toEqual([]);
    app.deleteDraft(move.invoice.id);

    const increase = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('50000')], comment: 'Több előleg érkezett' });
    expect(errorCodes(increase.issues)).toEqual([]);
    expect((await app.issue(increase.invoice.id)).invoice.number).toBe('SZ-2026-00004');
  });

  it('once the végszámla no longer deducts it (cancelled), the advance can be reduced to nothing', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue(finalWith(deduction('300000', '5')));
    await app.cancel(final.id, { reason: 'Hibás végszámla' });
    const m = await app.createCorrectionDraft(advance.id, { lines: [advanceLine('-300000')], comment: 'Az előleg nem érkezett meg' });
    expect(errorCodes(m.issues)).toEqual([]);
  });
});
