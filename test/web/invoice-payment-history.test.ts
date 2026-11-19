/**
 * EX8: the Fizetés part of the invoice page shows the document's payment history – date, the amount that came to this
 * document, the kind and the source (a payment recorded on another document of the chain names it) – and the day it became
 * fully paid. The storno of a paid invoice has a refund part: what is still to refund to the buyer, the refund form (an
 * empty amount refunds all of it) and the refunds; the storno of an unpaid invoice has none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, paymentClock } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const clock = paymentClock('2026-11-14');
  const e = await startWeb({ now: clock.now });
  clock.follow(e.app);
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const LINE = (unitPrice: string) => [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice, vatCode: '27' as const }];

async function invoice(app: OpenSzamla, unitPrice: string): Promise<Invoice> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, lines: LINE(unitPrice) })).invoice.id)).invoice;
}

describe('the payment history on the invoice page (EX8)', () => {
  it('lists the payments by date with the part of this document; a modification names the document the payment was recorded on', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const original = await invoice(e.app, '100000'); // 127 000
    const upward = (await e.app.issue((await e.app.createCorrectionDraft(original.id, { lines: LINE('10000'), comment: 'Javítás' })).invoice.id)).invoice; // +12 700
    e.app.recordPayment(original.id, { amount: '27000', date: '2026-12-08' });
    e.app.recordPayment(original.id, { date: '2026-11-20' }); // 112 700, received earlier
    const page = (await b.get(`/invoices/${original.id}`)).body;
    expect(page).toContain('<caption>Befizetések (a befizetés dátuma szerint)</caption>');
    // Fully paid on 12-08 – the later payment date –, though that payment was recorded first.
    expect(page).toContain('<dt>Teljes kifizetés napja</dt><dd>2026.12.08.</dd>');
    const rows = [...page.matchAll(/<td class="nowrap" data-label="Dátum"><span class="cv">([^<]*)<\/span><\/td><td class="num" data-label="Erre a bizonylatra"><span class="cv">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
    // By payment date: the 112 700 of 11-20 all goes to the invoice; of the 27 000 of 12-08, 14 300 to it and 12 700 to the modification.
    expect(rows).toEqual([
      ['2026.11.20.', ft('112700')],
      ['2026.12.08.', ft('14300')],
    ]);
    const mod = (await b.get(`/invoices/${upward.id}`)).body;
    expect(mod).toContain(`a(z) <a href="/invoices/${original.id}">${original.number}</a> bizonylaton (${ft('27000')})`);
    expect(mod).toContain(`<span class="cv">${ft('12700')}</span>`);
  });

  it('the storno of a paid invoice: the refund form records the refund; then nothing is left to refund', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '200000'); // 254 000
    e.app.recordPayment(inv.id, { amount: '100000', date: '2026-11-14' });
    const storno = (await e.app.cancel(inv.id, { reason: 'visszáru' })).invoice;
    const page = (await b.get(`/invoices/${storno.id}`)).body;
    expect(page).toContain('<h2 id="h-pay">Visszafizetés a vevőnek</h2>');
    expect(page).toContain(`<dt>Visszafizetendő a vevőnek</dt><dd>${ft('100000')}</dd>`);
    expect(page).toContain('Visszafizetés rögzítése…');
    const fields = formFields(page, `/invoices/${storno.id}/payment`);
    const done = await b.follow(await b.post(`/invoices/${storno.id}/payment`, { ...fields, amount: '' }));
    expect(flashesOf(done.body)).toContain(`Visszafizetés rögzítve: eddig visszafizetve ${ft('100000')}, még visszafizetendő ${ft('0')}.`);
    expect(e.app.getInvoice(storno.id)).toMatchObject({ paymentStatus: 'paid', paidAmount: '-100000', paidDate: '2026-11-14' });
    expect(done.body).toContain(`<dt>Visszafizetve</dt><dd>${ft('100000')}</dd>`);
    expect(done.body).not.toContain(`action="/invoices/${storno.id}/payment"`);
    expect(done.body).toContain('visszafizetés a vevőnek');
  });

  it('the storno of an unpaid invoice has no payment part', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '200000');
    const storno = (await e.app.cancel(inv.id, { reason: 'téves számla' })).invoice;
    const page = (await b.get(`/invoices/${storno.id}`)).body;
    expect(page).not.toContain('id="h-pay"');
    expect(page).not.toContain(`action="/invoices/${storno.id}/payment"`);
  });

  it('the paid, cancelled invoice points to its storno for the refund; once refunded there, its badge says so', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const inv = await invoice(e.app, '200000');
    e.app.recordPayment(inv.id, { amount: '100000', date: '2026-11-14' });
    const storno = (await e.app.cancel(inv.id, { reason: 'visszáru' })).invoice;
    const link = `<a href="/invoices/${storno.id}">${storno.number}</a>`;
    const before = (await b.get(`/invoices/${inv.id}`)).body;
    expect(before).toContain('befizetve – sztornózva, visszajár</span>');
    expect(before).toContain(`Mindkét esetben a(z) ${link} sztornó számlán rögzítsd visszafizetésként – beszámításnál az új számlán befizetésként is.`);
    e.app.recordPayment(storno.id, { date: '2026-11-15' }); // refunds all of it
    const after = (await b.get(`/invoices/${inv.id}`)).body;
    expect(after).toContain('befizetve – sztornózva, visszafizetve</span>');
    expect(after).not.toContain('visszajár</span>');
    expect(after).toContain(`A számlát sztornózták, a befizetett összeget a vevőnek visszafizették (rögzítve a(z) ${link} sztornó számlán).`);
    // The lists say the same.
    const list = (await b.get('/invoices')).body;
    const row = list.slice(list.lastIndexOf('<tr>', list.indexOf(`href="/invoices/${inv.id}"`)), list.indexOf('</tr>', list.indexOf(`href="/invoices/${inv.id}"`)));
    expect(row).toContain('befizetve – sztornózva, visszafizetve</span>');
    expect((await b.get('/')).body).not.toContain('visszajár</span>');
  });
});
