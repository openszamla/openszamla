/**
 * "1.000" in a web form: a Hungarian means one thousand (a dot grouping the thousands), the program read one (a decimal
 * point) – a price typed as 10.000 Ft became 10 Ft, visible only in the preview's total. The web forms now refuse that
 * form with the field's name and the two ways to write it, keep what was typed, and store nothing; "1.000,50" (dots
 * grouping the thousands, a decimal comma) is read as 1000.50.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type Fields, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

async function newDraftFields(b: Awaited<ReturnType<WebEnv['loggedIn']>>, unitPrice: string): Promise<Fields> {
  const page = await b.get('/invoices/new');
  const a = DOMESTIC_CUSTOMER_INPUT.address;
  return {
    ...formFields(page.body, '/invoices/new'),
    c_vatStatus: 'DOMESTIC',
    c_name: DOMESTIC_CUSTOMER_INPUT.name,
    c_taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber,
    c_postalCode: a.postalCode,
    c_city: a.city,
    c_addressLine: a.addressLine,
    'lines[0].description': 'Tanácsadás',
    'lines[0].quantity': '1',
    'lines[0].unit': 'óra',
    'lines[0].unitPrice': unitPrice,
    'lines[0].vatCode': '27',
  };
}

describe('the ambiguous "1.000" in the web forms', () => {
  it('a draft with unit price "10.000" is refused with the field and the fix; nothing is stored', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const r = await b.post('/invoices/new', await newDraftFields(b, '10.000'));
    expect(r.status).toBe(422);
    expect(r.body).toContain('A(z) „10.000” nem egyértelmű a(z) „1. tétel – egységár” mezőben: a pont ezres tagolás és tizedesjel is lehet.');
    expect(r.body).toContain('Tizedes törtként vesszővel írd: 10,000. Ezresként pont nélkül: 10000 (vagy szóközzel: 10 000).');
    // What was typed stays in the form.
    expect(r.body).toContain('value="10.000"');
    expect(e.app.findInvoices({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it('"10 000", "10.000,00" and "10.000.000" have one reading', async () => {
    const e = await env();
    const b = await e.loggedIn();
    for (const typed of ['10 000', '10.000,00', '10.000.000']) {
      const r = await b.follow(await b.post('/invoices/new', await newDraftFields(b, typed)));
      expect(r.status, typed).toBe(200);
    }
    const drafts = e.app.findInvoices({ limit: 10, offset: 0 }).items;
    expect(drafts.map((d) => d.lines[0]?.unitPrice).sort()).toEqual(['10000', '10000', '10000000']);
  });

  it('a payment of "1.000" is refused on the invoice page; nothing is recorded', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const draft = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const inv = (await e.app.issue(draft.invoice.id)).invoice;
    const page = await b.get(`/invoices/${inv.id}`);
    const done = await b.follow(await b.post(`/invoices/${inv.id}/payment`, { ...formFields(page.body, `/invoices/${inv.id}/payment`), amount: '1.000' }));
    expect(flashesOf(done.body)).toContain('A(z) „1.000” nem egyértelmű a(z) „Összeg” mezőben');
    expect(e.app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
  });
});
