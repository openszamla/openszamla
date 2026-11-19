/**
 * The draft form: the order a first-time user fills it in (type, buyer, lines, dates, notes), the new-buyer
 * fields in a disclosure that is open only when they are used, a save row that stays at the bottom of the
 * window, and errors shown next to the part they are about – in web words (no MCP field names).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOMER_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { formFields, insertCustomer, scriptsHaveNonce, startWeb, type WebEnv } from './helpers.ts';

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

/** The markup of the card whose heading has this id. */
function card(body: string, headingId: string): string {
  const start = body.indexOf(`aria-labelledby="${headingId}"`);
  if (start < 0) throw new Error(`no card ${headingId}`);
  return body.slice(start, body.indexOf('</section>', start));
}

describe('the draft form', () => {
  it('cards in the order a buyer, the lines, then dates and payment are given; the save row sits at the end and stays in view', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const r = await b.get('/invoices/new');
    expect(r.status).toBe(200);
    const order = ['h-type', 'h-cust', 'h-lines', 'h-doc', 'h-notes'].map((id) => r.body.indexOf(`aria-labelledby="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(card(r.body, 'h-type')).toContain('name="documentType"');
    expect(card(r.body, 'h-doc')).toContain('name="fulfillmentDate"');
    expect(card(r.body, 'h-doc')).toContain('<h2 id="h-doc">Dátumok, fizetés, pénznem</h2>');
    const actions = r.body.slice(r.body.indexOf('<div class="form-actions">'), r.body.indexOf('</form>', r.body.indexOf('<div class="form-actions">')));
    expect(actions).toContain('Piszkozat mentése</button>');
    expect(actions).toContain('<a class="btn btn-quiet" href="/invoices">Mégsem</a>');
    expect(actions).toContain('A mentés még nem állít ki számlát');
    expect(r.body.indexOf('<div class="form-actions">')).toBeGreaterThan(order[4] ?? 0);
    // Works without JavaScript: 5 rows; the script only adds rows and opens / closes the new-buyer fields.
    for (let i = 0; i < 5; i++) expect(r.body).toContain(`name="lines[${i}].description"`);
    expect(r.body).toContain('<button class="btn" type="button" id="add-line" hidden>');
    expect(r.body).toContain('Új tételsor hozzáadása</button>');
    expect(r.body).toContain("pick.addEventListener('change', function () { inline.open = pick.value === ''; });");
    expect(scriptsHaveNonce(r)).toBe(true);
  });

  it('the new-buyer fields: open without a saved customer, closed when one is chosen, open again when they hold typed data', async () => {
    const e = await env();
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    const fresh = await b.get('/invoices/new');
    expect(fresh.body).toContain('<option value="" selected>— új vevő (az adatait lent add meg) —</option>');
    expect(fresh.body).toContain('<details id="new-buyer" open><summary>Új vevő adatai (ha nincs a listában)</summary>');
    const chosen = await b.get('/invoices/new?customerId=cus_00000000c1');
    expect(chosen.body).toContain('<details id="new-buyer"><summary>Új vevő adatai (ha nincs a listában)</summary>');
    // The inline fields are still part of the form (a closed disclosure is submitted as well).
    expect(Object.keys(formFields(chosen.body, '/invoices/new'))).toEqual(expect.arrayContaining(['c_name', 'c_taxNumber', 'c_addressLine', 'customerId']));
  });

  it('no buyer: "Hiányzik a vevő." in web words, next to the buyer fields too, with a link there; nothing is saved', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const fields = formFields((await b.get('/invoices/new')).body, '/invoices/new');
    const r = await b.post('/invoices/new', { ...fields, 'lines[0].description': 'Tanácsadás', 'lines[0].quantity': '2', 'lines[0].unitPrice': '15000' });
    expect(r.status).toBe(422);
    expect(r.body).toContain('<p class="flash-title">Hiányzik a vevő.</p>');
    expect(r.body).toContain('Válassz egy mentett vevőt a „Vevő a vevőlistából” mezőben, vagy add meg az új vevő adatait');
    expect(r.body).not.toContain('customerId-t');
    expect(r.body).not.toContain('customer_find');
    expect(r.body).toContain('<a href="#h-cust">Ugrás a Vevő részhez</a>');
    expect(card(r.body, 'h-cust')).toContain('<p class="field-error">');
    expect(card(r.body, 'h-cust')).toContain('Hiányzik a vevő.');
    expect(r.body).toContain('value="Tanácsadás"');
    expect(e.app.findInvoices({}).total).toBe(0);
  });

  it('a line error is shown in the lines card, with a link to it', async () => {
    const e = await env();
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    const fields = formFields((await b.get('/invoices/new?customerId=cus_00000000c1')).body, '/invoices/new');
    const r = await b.post('/invoices/new', { ...fields, 'lines[2].description': 'Félkész sor' });
    expect(r.status).toBe(422);
    expect(r.body).toContain('A(z) 3. tételből hiányzik a mennyiség.');
    expect(r.body).toContain('<a href="#h-lines">Ugrás a Tételek részhez</a>');
    expect(card(r.body, 'h-lines')).toContain('<p class="field-error">');
    expect(card(r.body, 'h-cust')).not.toContain('field-error');
  });
});
