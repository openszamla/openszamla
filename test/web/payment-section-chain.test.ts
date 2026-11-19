/**
 * The web Fizetés section on an invoice chain (review C3/N5, C2/N4):
 * - a modification of a cancelled invoice (its storno negated it) shows no „Hátralék” or „Visszafizetendő a
 *   vevőnek” line and no payment form, but says why nothing can be paid on it;
 * - when an empty amount records more than the document's own Hátralék (what the whole chain still owes),
 *   the amount field says how much, and the empty form records exactly that.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const HOURS = (quantity: string) => [{ description: 'Fejlesztés', quantity, unit: 'óra', unitPrice: '15000', vatCode: '27' as const }]; // 19 050 Ft / óra
const NEGATED = 'Az eredeti számlát sztornózták: a sztornó számla ezt a módosító számlát is semlegesítette, ezért rá fizetés nem rögzíthető.';

async function chain(app: OpenSzamla, hours: string): Promise<{ original: Invoice; modification: Invoice }> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const original = (await app.issue((await app.createDraft({ customerId, lines: HOURS('10') })).invoice.id)).invoice;
  const modification = (await app.issue((await app.createCorrectionDraft(original.id, { lines: HOURS(hours), comment: 'Javítás' })).invoice.id)).invoice;
  return { original, modification };
}

describe('web Fizetés section of a cancelled chain (C3)', () => {
  it('a credit note of a cancelled invoice: no refund line, no form, the reason', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const { original, modification: credit } = await chain(e.app, '-2');
    const before = await b.get(`/invoices/${credit.id}`);
    expect(before.body).not.toContain(NEGATED);
    await e.app.cancel(original.id, { reason: 'Téves számla' });
    const page = await b.get(`/invoices/${credit.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(NEGATED);
    expect(page.body).not.toContain('Visszafizetendő a vevőnek');
    expect(page.body).not.toContain('<dt>Hátralék</dt>');
    expect(page.body).not.toContain(`action="/invoices/${credit.id}/payment"`);
  });

  it('an unpaid upward modification of a cancelled invoice: no Hátralék, no form', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const { original, modification: upward } = await chain(e.app, '2');
    expect((await b.get(`/invoices/${upward.id}`)).body).toContain(`action="/invoices/${upward.id}/payment"`);
    await e.app.cancel(original.id, { reason: 'Téves számla' });
    const page = await b.get(`/invoices/${upward.id}`);
    expect(page.body).toContain(NEGATED);
    expect(page.body).not.toContain('<dt>Hátralék</dt>');
    expect(page.body).not.toContain(`action="/invoices/${upward.id}/payment"`);
  });
});

describe('web payment form: the default amount of a chain (C2)', () => {
  it('names what an empty amount records when the chain owes more than the document, and records it', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const { original, modification: upward } = await chain(e.app, '1'); // 190 500 + 19 050
    const page = await b.get(`/invoices/${original.id}`);
    expect(page.body).toContain(`<dt>Hátralék</dt><dd>${ft('190500')}</dd>`);
    expect(page.body).toContain(`Üresen hagyva a teljes hátralék kerül rögzítésre – a számla és módosító számlái együtt: ${ft('209550')}.`);
    const fields = formFields(page.body, `/invoices/${original.id}/payment`);
    await b.post(`/invoices/${original.id}/payment`, { ...fields, amount: '' });
    // Recorded on the original; the part that pays the modification is allocated to it.
    expect(e.app.getInvoice(original.id)).toMatchObject({ paidAmount: '190500', paymentStatus: 'paid' });
    expect(e.app.getInvoice(upward.id)).toMatchObject({ paidAmount: '19050', paymentStatus: 'paid' });
  });

  it('a plain invoice keeps the plain hint', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const plain = (await e.app.issue((await e.app.createDraft({ customerId, lines: HOURS('1') })).invoice.id)).invoice;
    const body = (await b.get(`/invoices/${plain.id}`)).body;
    expect(body).toContain('Üresen hagyva a teljes hátralék kerül rögzítésre.');
    expect(body).not.toContain('a számla és módosító számlái együtt');
  });
});
