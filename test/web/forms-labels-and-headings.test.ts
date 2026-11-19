/**
 * Labels, hints and headings of the forms (U7, U9, U13, U16, U17, U18): the draft form says up front that the seller
 * data come first (and cannot be saved without them); the settings page shows the NAV command once and no MCP tool
 * name; a wrong number gets the hint of the web form (decimal comma allowed); one name per action across the pages
 * ("Szűrők törlése", "Mégsem, vissza a díjbekérőhöz", the reason errors); the buyer type select is a wide field, the
 * tax-number examples do not break inside the number; the new-record parts and the lists are headings.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}, seller = true): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  if (seller) e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

const NAV_TEST: AppConfig['nav'] = {
  environment: 'test',
  credentials: { login: 'FORMLOGIN7f3a', password: 'form-password-1', signingKey: 'FORM-SIGNING-KEY-55e0', exchangeKey: 'FORMEXCHd00d42ab' },
  source: 'env',
  baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
};

describe('U7: the draft form before the seller exists', () => {
  it('says so at the top with the way to the seller data, and the save button is disabled', async () => {
    const e = await env({}, false);
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/new')).body;
    expect(flashesOf(page)).toContain('Számlát csak az eladó (saját céged) adatainak megadása után készíthetsz.');
    expect(page).toContain('<a href="/settings#h-seller">Eladó adatainak megadása</a>');
    expect(page).toMatch(/<button class="btn btn-primary" type="submit" disabled aria-describedby="no-seller">/);
    expect(page).toContain('<p class="hint" id="no-seller">Mentés előtt add meg az eladó (saját céged) adatait a Beállítások oldalon.</p>');
    e.app.store.setSetting('seller', SELLER_NORMAL);
    expect((await b.get('/invoices/new')).body).not.toContain('disabled aria-describedby="no-seller"');
  });
});

describe('U9: the NAV part and the series of the settings page', () => {
  it('without NAV the command is shown once, in the setup steps; the series hint names no tool', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const page = (await b.get('/settings')).body;
    expect(page).not.toContain('Beállításuk és módosításuk');
    expect(page.split('class="cmd" id="settings-nav-cmd"').length).toBe(2);
    expect(page).toContain('Új sorszámtartományt (pl. külön előtaggal) az AI-asszisztenssel hozhatsz létre – kérd meg rá.');
    expect(page).not.toContain('series_manage');
  });

  it('with NAV (TEST): where the credentials come from in plain words, how to change them, the switch to production', async () => {
    const e = await env({ nav: NAV_TEST });
    const b = await e.loggedIn();
    const page = (await b.get('/settings')).body;
    expect(page).toContain('<dd>a program indításakor megadott beállítások (környezeti változók)</dd>');
    expect(page).not.toContain('OPENSZAMLA_NAV_*');
    expect(page).toContain('Beállításuk és módosításuk – azon a gépen, ahol a program fut: <code>');
    // TEST: the switch to production, to copy (the dashboard's TEST to-do sends here).
    expect(page).toContain('Valódi számlázás előtt állítsd éles környezetre – egy új terminálablakban, az éles technikai felhasználó adataival:');
    expect(page).toContain('<code class="cmd" id="settings-prod-cmd">openszamla nav-setup --env production');
    expect(page).toContain('data-copy="settings-prod-cmd"');
  });
});

describe('U13: a wrong number in the draft form', () => {
  it('gets the hint of the form: the decimal comma is allowed', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const b = await e.loggedIn();
    const page = await b.get('/invoices/new');
    const r = await b.post('/invoices/new', { ...formFields(page.body, '/invoices/new'), customerId: customer.id, 'lines[0].description': 'Munka', 'lines[0].quantity': 'három', 'lines[0].unitPrice': '15000' });
    expect(r.status).toBe(422);
    expect(r.body).toContain('Számot írj be, ezres elválasztó nélkül; a tizedesjel vessző vagy pont lehet (pl. 12500 vagy 1,5).');
    expect(r.body).not.toContain('Pont legyen a tizedesjel');
  });
});

describe('U16: one name per action', () => {
  it('"Szűrők törlése" on every list, the díjbekérő withdrawal returns "a díjbekérőhöz", the reason errors say what they are about', async () => {
    const e = await env();
    e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT);
    e.app.saveProduct({ name: 'Munka', unit: 'óra', unitPrice: '1000', vatCode: '27' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f9', number: 'DB-2026-00001', documentType: 'proforma', navStatus: 'not_applicable' });
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    for (const path of ['/customers?q=x', '/products?q=x', '/invoices?q=x']) {
      const body = (await b.get(path)).body;
      expect(body, path).toContain('Szűrők törlése</a>');
      expect(body, path).not.toContain('Szűrés törlése');
    }
    await b.get('/invoices/inv_00000000f9');
    const preview = (await b.post('/invoices/inv_00000000f9/cancel-preview', { reason: 'A megrendelő visszalépett' })).body;
    expect(preview).toContain('<a class="btn btn-quiet" href="/invoices/inv_00000000f9">Mégsem, vissza a díjbekérőhöz</a>');
    const withdrawal = await b.follow(await b.post('/invoices/inv_00000000f9/cancel-preview', { reason: ' ' }));
    expect(flashesOf(withdrawal.body)).toContain('Add meg a visszavonás okát (3–200 karakter).');
    const storno = await b.follow(await b.post('/invoices/inv_00000000a1/cancel-preview', { reason: ' ' }));
    expect(flashesOf(storno.body)).toContain('Add meg a sztornó okát (3–200 karakter).');
  });
});

describe('U17 / U18: field widths, examples, headings', () => {
  it('the buyer type is a wide field, the tax-number examples keep together, the new-record parts and lists are headings', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const customers = (await b.get('/customers')).body;
    expect(customers).toContain('<div class="field wide"><label for="f-vatStatus">Vevő típusa');
    expect(customers).toContain('pl. 12345676‑1‑23.');
    expect(customers).toContain('<summary id="h-new"><h2>Új vevő felvétele</h2></summary>');
    expect(customers).toContain('<h2 class="sr-only" id="h-list">Vevőlista</h2>');
    const products = (await b.get('/products')).body;
    expect(products).toContain('<summary id="h-new"><h2>Új termék / szolgáltatás felvétele</h2></summary>');
    expect(products).toContain('<h2 class="sr-only" id="h-list">Terméklista</h2>');
    const form = (await b.get('/invoices/new')).body;
    expect(form).toContain('<div class="field wide"><label for="f-c_vatStatus">Vevő típusa');
    expect(form).toContain('Belföldi áfaalanynál kötelező, pl. 12345676‑1‑23.');
    expect((await b.get('/settings')).body).toContain('Teljes formában: 12345676‑1‑23.');
  });
});
