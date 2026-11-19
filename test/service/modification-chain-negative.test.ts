/**
 * MODIFICATION_NEGATIVE_RESULT counts the whole correction chain (TAX-4): the tax base and the VAT must
 * not become negative after a modification (research 02 §7.2) – the original, its issued modifications
 * and the new one together, per VAT code. It stays a warning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const negative = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter((i) => i.code === 'MODIFICATION_NEGATIVE_RESULT');

async function setup(lines: LineInput[]): Promise<{ app: OpenSzamla; original: Invoice }> {
  t = makeTestApp({ now: () => new Date('2026-11-08T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines });
  return { app, original: (await app.issue(d.invoice.id)).invoice };
}

const diff = (unitPrice: string, vatCode: '27' | '5' = '27'): LineInput[] => [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice, vatCode }];
const correct = (app: OpenSzamla, original: Invoice, lines: LineInput[]) => app.createCorrectionDraft(original.id, { lines, comment: 'Utólagos árengedmény' });

describe('MODIFICATION_NEGATIVE_RESULT over the correction chain', () => {
  it('two reductions that together exceed the invoice: the second one is flagged, net and VAT', async () => {
    const { app, original } = await setup([{ description: 'Alkatrész', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }]);
    const first = await correct(app, original, diff('-800'));
    expect(negative(first.issues)).toEqual([]);
    await app.issue(first.invoice.id);
    const second = await correct(app, original, diff('-500'));
    const issues = negative(second.issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', field: 'totals.byVat[0].netAmount' });
    expect(issues[0]?.message).toContain('27 ÁFA-kódú adóalapja és adója – a korábbi módosításaival együtt – negatív lenne (nettó -300, ÁFA -81 HUF)');
    // Only a warning: the modification can still be issued, and the storno negates the whole chain.
    expect(second.readyToIssue).toBe(true);
    await app.issue(second.invoice.id);
    const storno = app.stornoPreview(original.id, 'Téves számla');
    expect(negative(storno.issues)).toEqual([]);
    expect([storno.storno.totals.netAmount, storno.storno.totals.vatAmount]).toEqual(['300', '81']);
  });

  it('per VAT code: a reduction below one rate’s base is flagged although the invoice total stays positive', async () => {
    const { app, original } = await setup([
      { description: 'Szerszám', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' },
      { description: 'Szakkönyv', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '5' },
    ]);
    const corr = await correct(app, original, diff('-1500'));
    expect(negative(corr.issues).map((i) => i.message)).toEqual([expect.stringContaining('27 ÁFA-kódú adóalapja és adója negatív lenne (nettó -500, ÁFA -135 HUF)')]);
    // The other rate is not touched by a modification of the 27% base.
    const other = await correct(app, original, diff('-900', '5'));
    expect(negative(other.issues)).toEqual([]);
  });

  it('an earlier increase counts too: no warning while the chain stays positive', async () => {
    const { app, original } = await setup([{ description: 'Alkatrész', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }]);
    await app.issue((await correct(app, original, diff('500'))).invoice.id);
    expect(negative((await correct(app, original, diff('-1200'))).issues)).toEqual([]);
    expect(negative((await correct(app, original, diff('-1600'))).issues)).toHaveLength(1);
  });
});
