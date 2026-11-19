/**
 * The draft form's line rows offer the saved products (U5): each row has a product list; the script fills the row from
 * the chosen product (name, unit, price in the document's currency, price basis, VAT code), and without it the service
 * does – a row with a product and an empty unit price takes the price, its basis and the VAT code from the product.
 * The product page starts a new invoice with the product ("Új számla ezzel a termékkel", /invoices/new?productId=…).
 * One empty row is shown at first: the spare rows are hidden by the script, visible without it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, scriptsHaveNonce, startWeb, type Fields, type WebEnv } from './helpers.ts';

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

/** The <tr> of line row `index` of the form. */
function rowOf(body: string, index: number): string {
  const at = body.indexOf(`name="lines[${index}].description"`);
  if (at < 0) return '';
  return body.slice(body.lastIndexOf('<tr', at), body.indexOf('</tr>', at));
}

describe('the product list of a line row', () => {
  it('offers every saved product with what the script fills in, and none when there is no product', async () => {
    const e = await env();
    const b = await e.loggedIn();
    // No product saved: no list, the product link stays a hidden field.
    const plain = (await b.get('/invoices/new')).body;
    expect(rowOf(plain, 0)).toContain('<input type="hidden" name="lines[0].productId" value="">');
    expect(plain).not.toContain('<select name="lines[0].productId"');

    const book = e.app.saveProduct({ name: 'Szakkönyv', unit: 'db', unitPrice: '4990', priceBasis: 'gross', vatCode: '5' });
    const page = await b.get('/invoices/new');
    const row = rowOf(page.body, 0);
    expect(row).toContain('<select name="lines[0].productId" data-pick aria-label="1. tétel – termék a listából"><option value="" selected>Válassz terméket…</option>');
    expect(row).toContain(`<option value="${book.id}" data-name="Szakkönyv" data-unit="db" data-price="4990" data-basis="gross" data-vat="5" data-currency="HUF">Szakkönyv – ${formatMoney('4990', 'HUF', 'hu')} / db (bruttó)</option>`);
    expect(page.body).toContain('<th scope="col">Termék / megnevezés</th>');
    // The script fills the row from the option (by the select's data-pick), with the page's nonce.
    expect(page.body).toContain("sel.matches('select[data-pick]')");
    expect(page.body).toContain("set('vatCode', o.getAttribute('data-vat') || '');");
    expect(scriptsHaveNonce(page)).toBe(true);
  });

  it('without JavaScript: a row with a product and a quantity takes the name, unit, price, its basis and VAT from the product', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const book = e.app.saveProduct({ name: 'Szakkönyv', unit: 'db', unitPrice: '4990', priceBasis: 'gross', vatCode: '5' });
    const dev = e.app.saveProduct({ name: 'Fejlesztés', unit: 'óra', unitPrice: '15000', vatCode: '27' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/new');
    const fields: Fields = {
      ...formFields(page.body, '/invoices/new'),
      customerId: customer.id,
      // Only the product and the quantity; the basis and VAT selects keep their defaults (nettó, 27%).
      'lines[0].productId': book.id,
      'lines[0].quantity': '2',
      // Own description and price: those stay, with the basis and VAT of the form.
      'lines[1].productId': dev.id,
      'lines[1].description': 'Fejlesztés – november',
      'lines[1].quantity': '3',
      'lines[1].unitPrice': '16000',
    };
    const r = await b.post('/invoices/new', fields);
    expect(r.status, flashesOf(r.body)).toBe(303);
    const id = /\/invoices\/(inv_[0-9a-f]+)$/.exec(r.headers.location ?? '')?.[1] ?? '';
    const [first, second] = e.app.getInvoice(id).lines;
    expect(first).toMatchObject({ description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '4990', priceBasis: 'gross', vatCode: '5', productId: book.id });
    expect(second).toMatchObject({ description: 'Fejlesztés – november', quantity: '3', unit: 'óra', unitPrice: '16000', priceBasis: 'net', vatCode: '27', productId: dev.id });
  });

  it('a product priced in another currency: the price must be typed, the web hint says so', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const eur = e.app.saveProduct({ name: 'Licenc', unit: 'db', unitPrice: '50', currency: 'EUR', vatCode: '27' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/new');
    const r = await b.post('/invoices/new', { ...formFields(page.body, '/invoices/new'), customerId: customer.id, 'lines[0].productId': eur.id, 'lines[0].quantity': '1' });
    expect(r.status).toBe(422);
    expect(flashesOf(r.body)).toContain('a számla pénzneme HUF');
    expect(r.body).toContain('Írd be az egységárat a tétel sorába, a bizonylat pénznemében');
    expect(r.body).not.toContain('(unitPrice)');
  });

  it('an archived product of an existing line stays in its row, so saving the draft keeps the link', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const old = e.app.saveProduct({ name: 'Régi licenc', unit: 'db', unitPrice: '1000', vatCode: '27' });
    const view = await e.app.createDraft({ customerId: customer.id, lines: [{ productId: old.id, quantity: '1' }] });
    e.app.saveProduct({ ...e.app.getProduct(old.id), id: old.id, archived: true });
    const b = await e.loggedIn();
    const edit = (await b.get(`/invoices/${view.invoice.id}/edit`)).body;
    expect(rowOf(edit, 0)).toContain(`<option value="${old.id}" selected`);
    expect(rowOf(edit, 0)).toContain(`Régi licenc – ${formatMoney('1000', 'HUF', 'hu')} / db – archivált</option>`);
  });
});

describe('a new invoice from a product', () => {
  it('the product page offers it, and the form opens with the product in the first row, in its currency', async () => {
    const e = await env();
    const eur = e.app.saveProduct({ name: 'Licenc', unit: 'db', unitPrice: '50', currency: 'EUR', priceBasis: 'net', vatCode: '27' });
    const b = await e.loggedIn();
    const product = (await b.get(`/products/${eur.id}`)).body;
    expect(product).toContain(`href="/invoices/new?productId=${eur.id}"`);
    expect(product).toContain('Új számla ezzel a termékkel</a>');
    const form = (await b.get(`/invoices/new?productId=${eur.id}`)).body;
    const row = rowOf(form, 0);
    expect(row).toContain(`<option value="${eur.id}" selected`);
    expect(row).toContain('name="lines[0].description" value="Licenc"');
    expect(row).toContain('name="lines[0].quantity" value="1"');
    expect(row).toContain('name="lines[0].unitPrice" value="50"');
    expect(form).toContain('name="currency" type="text" value="EUR"');
    // An archived product is not offered for a new invoice.
    e.app.saveProduct({ ...e.app.getProduct(eur.id), id: eur.id, archived: true });
    expect((await b.get(`/products/${eur.id}`)).body).not.toContain('Új számla ezzel a termékkel');
  });
});

describe('one empty line row at first', () => {
  it('a new form: the first row, then spare rows the script hides – all five there without JavaScript', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/new')).body;
    expect(rowOf(page, 0)).toMatch(/^<tr>/);
    for (const i of [1, 2, 3, 4]) expect(rowOf(page, i), `row ${i}`).toMatch(/^<tr class="spare">/);
    expect(page).not.toMatch(/<tr class="spare" hidden/);
    // The script: empty spare rows hidden, "Új tételsor hozzáadása" shows the next one before adding a new row.
    expect(page).toContain("body.querySelectorAll('tr.spare').forEach(function (row) { if (empty(row)) row.hidden = true; });");
    expect(page).toContain("var row = body.querySelector('tr.spare[hidden]');");
  });

  it('editing a draft of two lines: the two rows, then spare rows; a form shown again keeps every typed row', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const view = await e.app.createDraft({
      customerId: customer.id,
      lines: [
        { description: 'A', quantity: '1', unit: 'db', unitPrice: '100', vatCode: '27' },
        { description: 'B', quantity: '1', unit: 'db', unitPrice: '200', vatCode: '27' },
      ],
    });
    const b = await e.loggedIn();
    const edit = (await b.get(`/invoices/${view.invoice.id}/edit`)).body;
    expect(rowOf(edit, 0)).toMatch(/^<tr>/);
    expect(rowOf(edit, 1)).toMatch(/^<tr>/);
    expect(rowOf(edit, 2)).toMatch(/^<tr class="spare">/);
    // A row typed after an empty one is no spare row when the form comes back with an error.
    const page = await b.get('/invoices/new');
    const r = await b.post('/invoices/new', { ...formFields(page.body, '/invoices/new'), 'lines[2].description': 'C', 'lines[2].quantity': '1', 'lines[2].unitPrice': '300' });
    expect(r.status).toBe(422);
    expect(rowOf(r.body, 1)).toMatch(/^<tr>/);
    expect(rowOf(r.body, 2)).toMatch(/^<tr>/);
    expect(rowOf(r.body, 3)).toMatch(/^<tr class="spare">/);
  });
});
