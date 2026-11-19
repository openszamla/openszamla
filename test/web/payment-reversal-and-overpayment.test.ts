/**
 * The web UI and a payment recorded by mistake. Once an invoice was paid its page had no payment form at all, so a wrong
 * payment (a slipped digit, the wrong invoice) could only be taken back through an AI client; and the form recorded any
 * amount, however far above what was owed. The page now has "Téves befizetés visszavonása" on every document that has
 * payments of its own – paid ones too –, and an amount above the hátralék is recorded only with the "Túlfizetést
 * rögzítek" box ticked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const ft = (v: string): string => formatMoney(v, 'HUF');

async function invoice(app: OpenSzamla, unitPrice: string): Promise<Invoice> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, lines: [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice, vatCode: '27' }] })).invoice.id)).invoice;
}

describe('taking back a payment recorded by mistake', () => {
  it('a paid invoice has the reversal form; left empty it takes back everything recorded on it', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '10000'); // 12 700 Ft
    const unpaid = (await b.get(`/invoices/${inv.id}`)).body;
    expect(unpaid).not.toContain('Téves befizetés visszavonása');
    e.app.recordPayment(inv.id, {});

    const page = (await b.get(`/invoices/${inv.id}`)).body;
    // Paid: no payment form, but the way back is there.
    expect(page).not.toContain(`action="/invoices/${inv.id}/payment"`);
    expect(page).toContain('Téves befizetés visszavonása…');
    expect(page).toContain(`Ezen a bizonylaton rögzítve: ${ft('12700')}.`);
    const action = `/invoices/${inv.id}/payment-reversal`;
    const done = await b.follow(await b.post(action, formFields(page, action)));
    expect(flashesOf(done.body)).toBe(`Visszavonás rögzítve: fizetetlen (${ft('0')} / ${ft('12700')}).`);
    expect(e.app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0', paidDate: null });
    // Both stay in the history; the payment form is back.
    expect(e.app.paymentHistory(inv.id).map((p) => [p.kind, p.paymentAmount])).toEqual([['payment', '12700'], ['reversal', '-12700']]);
    expect(done.body).toContain(`action="/invoices/${inv.id}/payment"`);
    expect(done.body).toContain('visszavonás');
    expect(done.body).not.toContain('Téves befizetés visszavonása');
  });

  it('a part can be taken back; a negative or too large amount is refused', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '10000');
    e.app.recordPayment(inv.id, {});
    const action = `/invoices/${inv.id}/payment-reversal`;
    const form = async () => formFields((await b.get(`/invoices/${inv.id}`)).body, action);

    const negative = await b.follow(await b.post(action, { ...(await form()), amount: '-2700' }));
    expect(flashesOf(negative.body)).toBe('A visszavont összeget pozitív számként add meg.');
    const tooMuch = await b.follow(await b.post(action, { ...(await form()), amount: '12701' }));
    expect(flashesOf(tooMuch.body)).toContain('A visszavont összeg nem lehet nagyobb a befizetettnél');
    expect(e.app.getInvoice(inv.id).paidAmount).toBe('12700');

    const part = await b.follow(await b.post(action, { ...(await form()), amount: '2 700' }));
    expect(flashesOf(part.body)).toBe(`Visszavonás rögzítve: részben fizetve (${ft('10000')} / ${ft('12700')}).`);
    expect(part.body).toContain(`Ezen a bizonylaton rögzítve: ${ft('10000')}.`);
  });

  it('the same form sent twice takes the payment back once', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '10000');
    e.app.recordPayment(inv.id, { amount: '5000' });
    e.app.recordPayment(inv.id, { amount: '5000' });
    const action = `/invoices/${inv.id}/payment-reversal`;
    const fields = { ...formFields((await b.get(`/invoices/${inv.id}`)).body, action), amount: '5000' };
    await b.follow(await b.post(action, fields));
    const again = await b.follow(await b.post(action, fields));
    expect(flashesOf(again.body)).toBe('Ezt a befizetést már rögzítettük, nem rögzítjük még egyszer.');
    expect(e.app.getInvoice(inv.id).paidAmount).toBe('5000');
  });
});

describe('an amount above the hátralék in the payment form', () => {
  it('is refused with the amounts and the way to confirm; with the box ticked it is recorded', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '10000'); // 12 700 Ft
    const action = `/invoices/${inv.id}/payment`;
    const page = (await b.get(`/invoices/${inv.id}`)).body;
    expect(page).toContain('Túlfizetést rögzítek');
    const fields = formFields(page, action);
    expect(fields.overpay).toBeUndefined(); // not ticked by default

    const refused = await b.follow(await b.post(action, { ...fields, amount: '127000' }));
    expect(flashesOf(refused.body)).toBe(`A megadott összeg (${ft('127000')}) nagyobb a hátraléknál (${ft('12700')}): a különbözet (${ft('114300')}) túlfizetés lenne.`);
    expect(refused.body).toContain('jelöld be a „Túlfizetést rögzítek” jelölőt a befizetés űrlapján');
    expect(refused.body).not.toContain('allowOverpayment');
    expect(e.app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });

    const confirmed = await b.follow(await b.post(action, { ...formFields(refused.body, action), amount: '13000', overpay: '1' }));
    expect(flashesOf(confirmed.body)).toBe(`Befizetés rögzítve: fizetve (${ft('13000')} / ${ft('12700')}).`);
    expect(e.app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'paid', paidAmount: '13000' });
  });
});
