/**
 * An előlegszámla that an issued végszámla still deducts cannot be cancelled, or reduced below what is
 * deducted (TAX-1, ADVANCE_STILL_DEDUCTED): the végszámla deducts the advance actually invoiced (Áfa tv.
 * 10. melléklet 5. pont), so the advance's VAT would otherwise be reversed while the végszámla still
 * deducts it – the reverse order of ADVANCE_INVOICE_CANCELLED.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { DraftInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const errorCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);
const stillDeducted = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter((i) => i.code === 'ADVANCE_STILL_DEDUCTED');

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
  return { app, customerId, issue, advance };
}

/** A végszámla of 1 000 000 Ft net at 27% deducting `deducted` of the advance under `vatCode`. */
const finalLines = (advanceInvoiceNumber: string, deducted = '300000', vatCode: '27' | '5' = '27'): DraftInput['lines'] => [
  { description: 'Gépsor szállítása', quantity: '1', unit: 'db', unitPrice: '1000000', vatCode: '27' },
  { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: deducted, vatCode, advanceDeduction: { advanceInvoiceNumber, advancePaymentDate: '2026-11-02' } },
];

const advanceLine = (unitPrice: string) => [{ description: 'Előleg módosítása', quantity: '1', unit: 'db', unitPrice, vatCode: '27' as const }];

describe('an advance an issued végszámla deducts (ADVANCE_STILL_DEDUCTED)', () => {
  it('cannot be cancelled: the storno preview names the végszámla, cancel issues nothing and wastes no number', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001') });
    const preview = app.stornoPreview(advance.id, 'Téves előlegszámla');
    expect(errorCodes(preview.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    const message = stillDeducted(preview.issues)[0]?.message ?? '';
    expect(message).toContain(`a(z) ${final.number} végszámla levonja (27 ÁFA-kód, nettó 300000 HUF)`);
    expect(message).toMatch(/előbb azt sztornózd vagy módosítsd/);
    expect(message).toMatch(/az előlegszámlát nem kell sztornózni/);

    await expect(app.cancel(advance.id, { reason: 'Téves előlegszámla' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [expect.objectContaining({ code: 'ADVANCE_STILL_DEDUCTED' })] },
    });
    expect(app.getInvoice(advance.id).status).toBe('issued');
    expect(app.getInvoice(final.id).status).toBe('issued');
    expect(app.findInvoices({ status: ['draft'] }).total).toBe(0);
    expect((await issue({ lines: advanceLine('1000') })).number).toBe('SZ-2026-00003');
  });

  it('cannot be reduced below the deduction; a reduction it still covers and an increase can be issued', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001', '200000') });

    const tooMuch = await app.createCorrectionDraft(advance.id, { lines: advanceLine('-100001'), comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(tooMuch.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    expect(tooMuch.readyToIssue).toBe(false);
    const message = stillDeducted(tooMuch.issues)[0]?.message ?? '';
    expect(message).toContain(`a(z) ${final.number} végszámla levonja (27 ÁFA-kód, nettó 200000 HUF)`);
    expect(message).toContain('csak nettó 199999 HUF maradna');
    await expect(app.issue(tooMuch.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    app.deleteDraft(tooMuch.invoice.id);

    const increase = await app.createCorrectionDraft(advance.id, { lines: advanceLine('50000'), comment: 'Több előleg érkezett' });
    expect(stillDeducted(increase.issues)).toEqual([]);
    app.deleteDraft(increase.invoice.id);

    const fits = await app.createCorrectionDraft(advance.id, { lines: advanceLine('-100000'), comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(fits.issues)).toEqual([]);
    const mod = (await app.issue(fits.invoice.id)).invoice;
    expect((await validateNavXml(buildInvoiceDataXml(mod), 'data')).errors).toEqual([]);
    // Now the deduction uses up the advance: a further reduction and a storno are refused, an increase is not.
    const more = await app.createCorrectionDraft(advance.id, { lines: advanceLine('-1'), comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(more.issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    expect(errorCodes(app.stornoPreview(advance.id, 'Téves előlegszámla').issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    const later = await app.createCorrectionDraft(advance.id, { lines: advanceLine('10000'), comment: 'Több előleg érkezett' });
    expect(errorCodes(later.issues)).toEqual([]);
  });

  it('a végszámla that is only a draft does not count; after the végszámla is cancelled the advance can be', async () => {
    const { app, customerId, advance } = await withAdvance();
    const draftFinal = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001') });
    expect(errorCodes(app.stornoPreview(advance.id, 'Előleg visszafizetve').issues)).toEqual([]);
    const final = (await app.issue(draftFinal.invoice.id)).invoice;
    expect(errorCodes(app.stornoPreview(advance.id, 'Előleg visszafizetve').issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);

    await app.cancel(final.id, { reason: 'Hibás végszámla' });
    expect(app.stornoPreview(advance.id, 'Előleg visszafizetve').issues).toEqual([]);
    const storno = (await app.cancel(advance.id, { reason: 'Előleg visszafizetve' })).invoice;
    expect(storno.totals.netAmount).toBe('-300000');
    expect(app.getInvoice(advance.id).status).toBe('cancelled');
    expect((await validateNavXml(buildInvoiceDataXml(storno), 'data')).errors).toEqual([]);
  });

  it('names every végszámla still deducting it; a storno also catches a deduction under another VAT code', async () => {
    const { app, issue, advance } = await withAdvance();
    const first = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001', '100000') });
    const second = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001', '100000') });
    // Deducted under a VAT code the advance does not have (ADVANCE_DEDUCTION_VAT_CODE warning on it).
    const third = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001', '50000', '5') });
    const issues = stillDeducted(app.stornoPreview(advance.id, 'Téves előlegszámla').issues);
    expect(issues.map((i) => i.severity)).toEqual(['error', 'error']);
    expect(issues[0]?.message).toContain(`a(z) ${first.number}, ${second.number} végszámlák levonják (27 ÁFA-kód, nettó 200000 HUF)`);
    expect(issues[1]?.message).toContain(`a(z) ${third.number} végszámla levonja (5 ÁFA-kód, nettó 50000 HUF)`);
    // A cancelled végszámla is no longer named.
    await app.cancel(first.id, { reason: 'Hibás végszámla' });
    const after = stillDeducted(app.stornoPreview(advance.id, 'Téves előlegszámla').issues);
    expect(after[0]?.message).toContain(`a(z) ${second.number} végszámla levonja (27 ÁFA-kód, nettó 100000 HUF)`);
  });

  it('the way out the message gives: correcting the végszámla deduction first, then the advance', async () => {
    const { app, issue, advance } = await withAdvance();
    const final = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001') });
    expect(errorCodes((await app.createCorrectionDraft(advance.id, { lines: advanceLine('-100000'), comment: 'Kevesebb előleg érkezett' })).issues)).toEqual(['ADVANCE_STILL_DEDUCTED']);
    // The végszámla deducts 100 000 Ft less: a positive deduction difference line on its modification.
    const fix = await app.createCorrectionDraft(final.id, {
      lines: [{ description: 'Előleg levonásának csökkentése', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27', advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00001', advancePaymentDate: '2026-11-02' } }],
      comment: 'A levont előleg helyesen 200 000 Ft',
    });
    expect(errorCodes(fix.issues)).toEqual([]);
    await app.issue(fix.invoice.id);
    const reduce = await app.createCorrectionDraft(advance.id, { lines: advanceLine('-100000'), comment: 'Kevesebb előleg érkezett' });
    expect(errorCodes(reduce.issues)).toEqual([]);
    const mod = (await app.issue(reduce.invoice.id)).invoice;
    expect((await validateNavXml(buildInvoiceDataXml(mod), 'data')).errors).toEqual([]);
  });

  it('corrections of other invoices are not affected', async () => {
    const { app, issue } = await withAdvance();
    const invoice = await issue({ lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
    expect(stillDeducted(app.stornoPreview(invoice.id, 'Téves').issues)).toEqual([]);
    const final = await issue({ documentType: 'final', lines: finalLines('SZ-2026-00001') });
    // The végszámla itself can be cancelled (its storno reverses the deduction).
    expect(app.stornoPreview(final.id, 'Hibás végszámla').issues).toEqual([]);
  });
});
