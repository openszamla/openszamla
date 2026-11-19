/**
 * U6: from the web, a díjbekérő becomes an invoice draft ("Számla készítése ebből a díjbekérőből") and an invoice is copied
 * into a new draft ("Új számla ennek mintájára") – createDraft copyFromId –, each opening the new draft in the draft form;
 * issuing it still needs the usual confirmation, and the converted invoice carries the díjbekérő's payment. A double
 * submit makes one draft. A módosító számla is not made on the web: the storno part says where it is made.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, hiddenValue, startWeb, type WebEnv } from './helpers.ts';

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

const LINE = { description: 'Rendszergazdai átalánydíj', quantity: '1', unit: 'hó', unitPrice: '85000', vatCode: '27' } as const;

async function issued(app: OpenSzamla, documentType: 'invoice' | 'proforma'): Promise<string> {
  const customer = app.findCustomers({ limit: 1 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const d = await app.createDraft({ customerId: customer.id, documentType, lines: [LINE] });
  return (await app.issue(d.invoice.id)).invoice.id;
}

describe('a díjbekérő becomes an invoice draft', () => {
  it('one click opens the invoice draft in the form; issuing it (confirmed) carries the payment; the díjbekérő names the invoice', async () => {
    const e = await env();
    const proforma = await issued(e.app, 'proforma');
    e.app.recordPayment(proforma, {});
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${proforma}`)).body;
    expect(page).toContain(`action="/invoices/${proforma}/copy"`);
    expect(page).toContain('Számla készítése ebből a díjbekérőből</button>');
    expect(page).toContain('Fizetés után készíts belőle számlát');

    const fields = formFields(page, `/invoices/${proforma}/copy`);
    const r = await b.post(`/invoices/${proforma}/copy`, fields);
    expect(r.status, flashesOf(r.body)).toBe(303);
    const draftId = /^\/invoices\/(inv_[0-9a-f]+)\/edit$/.exec(r.headers.location ?? '')?.[1] ?? '';
    expect(draftId).not.toBe('');
    const form = await b.follow(r);
    expect(flashesOf(form.body)).toContain('Számlapiszkozat készült a(z) DB-2026-00001 díjbekérőből – még nem számla.');
    expect(form.body).toContain('A teljesítés dátuma a mai nap lett: ha a teljesítés máskor történt (vagy még nem történt meg), írd át.');
    expect(form.body).toContain('előlegszámla kellhet');
    const draft = e.app.getInvoice(draftId);
    expect(draft).toMatchObject({ status: 'draft', documentType: 'invoice', proformaId: proforma });
    expect(draft.lines[0]).toMatchObject({ description: LINE.description, unitPrice: LINE.unitPrice });

    // The same form sent twice (double click): one draft.
    const again = await b.post(`/invoices/${proforma}/copy`, fields);
    expect(again.headers.location).toBe('/invoices?status=draft');
    expect(e.app.findInvoices({ status: ['draft'] }).total).toBe(1);

    // Issuing it is the usual confirmed step, and the payment recorded on the díjbekérő comes over.
    const draftPage = (await b.get(`/invoices/${draftId}`)).body;
    expect(draftPage).toContain('DB-2026-00001 díjbekérőre');
    const done = await b.post(`/invoices/${draftId}/issue`, { confirmation: hiddenValue(draftPage, 'confirmation') ?? '', confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(e.app.getInvoice(draftId)).toMatchObject({ status: 'issued', paymentStatus: 'paid' });
    const after = (await b.get(`/invoices/${proforma}`)).body;
    expect(after).toContain(`Számla készült belőle: <a href="/invoices/${draftId}">SZ-2026-00001</a>`);
  });

  it('a withdrawn díjbekérő offers no conversion', async () => {
    const e = await env();
    const proforma = await issued(e.app, 'proforma');
    const b = await e.loggedIn();
    expect((await b.get(`/invoices/${proforma}`)).body).toContain(`action="/invoices/${proforma}/copy"`);
    await e.app.cancel(proforma, { reason: 'A megrendelő visszalépett' });
    expect((await b.get(`/invoices/${proforma}`)).body).not.toContain(`action="/invoices/${proforma}/copy"`);
  });
});

describe('a new invoice on the pattern of an issued one', () => {
  it('an issued and a cancelled invoice offer it; the copy opens in the form with the buyer and lines', async () => {
    const e = await env();
    const inv = await issued(e.app, 'invoice');
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${inv}`)).body;
    expect(page).toContain('Új számla ennek mintájára</button>');
    const r = await b.post(`/invoices/${inv}/copy`, formFields(page, `/invoices/${inv}/copy`));
    const copyId = /^\/invoices\/(inv_[0-9a-f]+)\/edit$/.exec(r.headers.location ?? '')?.[1] ?? '';
    const form = await b.follow(r);
    expect(flashesOf(form.body)).toContain('Új piszkozat készült a(z) SZ-2026-00001 mintájára – még nem számla.');
    const copy = e.app.getInvoice(copyId);
    expect(copy).toMatchObject({ status: 'draft', documentType: 'invoice', customerId: e.app.getInvoice(inv).customerId });
    expect(copy.proformaId).toBeUndefined();
    expect(e.app.getInvoice(inv).status).toBe('issued');

    // After a storno the same invoice can be issued again correctly: its page still offers the copy.
    const storno = (await e.app.cancel(inv, { reason: 'Hibás ár' })).invoice;
    expect((await b.get(`/invoices/${inv}`)).body).toContain(`action="/invoices/${inv}/copy"`);
    // A storno is not copied: no button, and the action is refused.
    const stornoPage = (await b.get(`/invoices/${storno.id}`)).body;
    expect(stornoPage).not.toContain(`action="/invoices/${storno.id}/copy"`);
    const refused = await b.follow(await b.post(`/invoices/${storno.id}/copy`, {}));
    expect(flashesOf(refused.body)).toContain('Ebből a bizonylatból a webes felületen nem készíthető új piszkozat.');
  });

  it('the storno part says where a módosító számla is made, and calls the storno one name', async () => {
    const e = await env();
    const inv = await issued(e.app, 'invoice');
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${inv}`)).body;
    expect(page).toContain('Kisebb hibát (ár, mennyiség, engedmény) módosító számlával is javíthatsz: ezt az AI-asszisztens készíti el (pl. „Az SZ-2026-00001 számlán adj 10% engedményt.”)');
    expect(page).toContain('Sztornó számla készítése…</summary>');
    expect(page).not.toContain('érvénytelenítő) számla készítése');
  });
});
