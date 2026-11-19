/**
 * A storno refused by validation (cancel(), T2.2) says so and gets its own hint: there is no draft to fix
 * (cancel() makes the storno draft and removes it again), the cause named in the message is – e.g. the
 * végszámla still deducting an előlegszámla. A draft refused at issue keeps the draft hint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const STORNO_HINT = 'A sztornó nem állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), majd próbáld újra.';

async function refusal(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('not refused');
}

describe('a storno refused by validation (T2.2)', () => {
  it('names the storno and hints at the cause, never at a draft', async () => {
    t = makeTestApp({ now: () => new Date('2026-11-08T09:00:00.000Z') });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const advance = (await app.issue((await app.createDraft({ customerId, documentType: 'advance', lines: [{ description: 'Előleg', quantity: '1', unit: 'db', unitPrice: '300000', vatCode: '27' }] })).invoice.id)).invoice;
    await app.issue((await app.createDraft({
      customerId,
      documentType: 'final',
      lines: [
        { description: 'Gépsor', quantity: '1', unit: 'db', unitPrice: '1000000', vatCode: '27' },
        { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: '300000', vatCode: '27', advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: advance.fulfillmentDate } },
      ],
    })).invoice.id);

    const e = await refusal(() => app.cancel(advance.id, { reason: 'Téves előlegszámla' }));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.message).toMatch(/^A sztornó számla nem állítható ki: A\(z\) SZ-2026-00001 előlegszámlát a\(z\) SZ-2026-00002 végszámla levonja/);
    expect(e.hint).toBe(STORNO_HINT);
    expect(e.hint).not.toMatch(/invoice_draft|piszkozat/i);
    expect(e.details).toMatchObject({ issues: [expect.objectContaining({ code: 'ADVANCE_STILL_DEDUCTED' })] });
    // Nothing was issued and no storno draft is left behind.
    expect(app.getInvoice(advance.id).status).toBe('issued');
    expect(app.findInvoices({ status: ['draft'] }).total).toBe(0);
  });

  it('a draft refused at issue keeps the draft hint', async () => {
    t = makeTestApp();
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, documentType: 'final', lines: [{ description: 'Gépsor', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }] });
    expect(d.readyToIssue).toBe(false);
    const e = await refusal(() => app.issue(d.invoice.id));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.message).toMatch(/^A számla nem állítható ki: /);
    expect(e.hint).toBe('Javítsd a hibákat a piszkozatban, majd próbáld újra.');
  });
});
