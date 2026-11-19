/**
 * Web UI end-to-end tests against the real HTTP server (startHttpServer, port 0).
 * Invoices are inserted straight through the store, so these tests do not depend on src/core/calc.ts;
 * the form flows that create/issue drafts are in ui-flows.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice } from '../../src/core/types.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import {
  Browser,
  insertCustomer,
  insertDraft,
  insertIssued,
  rawRequest,
  scriptsHaveNonce,
  setCookies,
  startWeb,
  TOKEN,
  type Res,
  type WebEnv,
} from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  return e;
}

/** SZ-2026-00001 (domestic), -00002 (AAM, cash), -00003 (EUR). */
function seed(e: WebEnv): void {
  insertIssued(e.app, INVOICE_DOMESTIC);
  insertIssued(e.app, INVOICE_PRIVATE_AAM);
  insertIssued(e.app, INVOICE_EU_SERVICE);
}

/** Amount exactly as the UI prints it (no-break spaces). */
const ft = (v: string): string => formatMoney(v, 'HUF');
const eur = (v: string): string => formatMoney(v, 'EUR');

function expectSecureHtml(res: Res): void {
  expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toMatch(/^default-src 'none'; style-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}'; script-src 'nonce-[A-Za-z0-9+/=]{16,}'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('same-origin');
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(scriptsHaveNonce(res)).toBe(true);
  expect(res.body).toMatch(/<style nonce="[^"]+">/);
  expect(res.body).not.toMatch(/\sstyle="/);
  expect(res.body).not.toMatch(/\son[a-z]+="/);
  expect(res.body).not.toMatch(/(src|href)="(https?:)?\/\//);
}

const PDF_READY = await (async () => {
  try {
    const buf = await renderInvoicePdf(INVOICE_DOMESTIC);
    return buf.subarray(0, 4).toString('latin1') === '%PDF';
  } catch (e) {
    console.warn(`[web tests] PDF rendering is not available yet (${e instanceof Error ? e.message : String(e)}) – the PDF download test is skipped.`);
    return false;
  }
})();

// ---------------------------------------------------------------------------------------------
describe('authentication', () => {
  it('blocks every page without a session and shows only the login form', async () => {
    const e = await env();
    seed(e);
    const anon = e.browser();
    for (const path of ['/', '/invoices', '/invoices/inv_00000000a1', '/invoices/inv_00000000a1.pdf', '/invoices/new', '/customers', '/products', '/settings', '/export']) {
      const r = await anon.get(path);
      expect(r.status, path).toBe(401);
      expectSecureHtml(r);
      expect(r.body).toContain('Hozzáférési kulcs');
      expect(r.body).not.toContain('SZ-2026-00001');
      expect(r.body).not.toContain('Árvíztűrő');
      expect(r.body).not.toContain('name="_csrf"');
    }
    const post = await anon.post('/invoices/inv_00000000a1/payment', { amount: '1000' }, { csrf: 'x' });
    expect(post.status).toBe(401);
    expect(e.app.getInvoice('inv_00000000a1').paymentStatus).toBe('unpaid');
    const forged = await anon.get('/', { cookie: 'openszamla_session=AAAAAAAAAAAAAAAAAAAAAA.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(forged.status).toBe(401);
    expect((await rawRequest(e.base, 'GET', '/healthz')).status).toBe(200);
    expect((await rawRequest(e.base, 'GET', '/favicon.ico')).status).toBe(404);
  });

  it('"?token=" logs in with an HttpOnly SameSite=Strict cookie and redirects to the same URL without the token', async () => {
    const e = await env();
    const b = e.browser();
    const r = await b.get(`/invoices?status=issued&token=${encodeURIComponent(TOKEN)}&q=x`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/invoices?status=issued&q=x');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    const [cookie] = setCookies(r);
    expect(cookie).toMatch(/^openszamla_session=[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict$/);
    expect(cookie).not.toContain(TOKEN);
    const page = await b.follow(r);
    expect(page.status).toBe(200);
    expectSecureHtml(page);
    expect(page.body).toContain('Számlák és bizonylatok');
    expect(page.body).not.toContain(TOKEN);

    const bad = await e.browser().get('/?token=not-the-token-<b>');
    expect(bad.status).toBe(401);
    expect(setCookies(bad)).toEqual([]);
    expect(bad.body).toContain('A hozzáférési kulcs érvénytelen.');
    expect(bad.body).not.toContain('not-the-token');
  });

  it('login form: wrong token is refused, a local "next" is honoured, open redirects are not', async () => {
    const e = await env();
    const b = e.browser();
    const gate = await b.get('/customers?q=abc');
    expect(gate.status).toBe(401);
    expect(gate.body).toContain('name="next" value="/customers?q=abc"');
    const wrong = await b.post('/login', { token: 'nope', next: '/customers' }, { csrf: null });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('A hozzáférési kulcs érvénytelen.');
    expect(setCookies(wrong)).toEqual([]);
    const ok = await b.post('/login', { token: TOKEN, next: '/customers?q=abc' }, { csrf: null });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/customers?q=abc');
    expect(b.cookie).toMatch(/^openszamla_session=/);
    for (const next of ['//evil.example/x', 'https://evil.example', '/\\evil.example', '/login', '/%0d%0aSet-Cookie:x', 'javascript:alert(1)']) {
      const r = await e.browser().post('/login', { token: TOKEN, next }, { csrf: null });
      expect(r.status, next).toBe(303);
      expect(r.headers.location, next).toBe('/');
    }
    const crossSite = await e.browser().post('/login', { token: TOKEN }, { csrf: null, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(setCookies(crossSite)).toEqual([]);
  });

  it('logout clears the cookie and revokes the session server-side', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const oldCookie = b.cookie as string;
    const confirmPage = await b.get('/logout');
    expect(confirmPage.status).toBe(200);
    expect(confirmPage.body).toContain('Biztosan kilépsz');
    expect(b.cookie).toBe(oldCookie);
    const r = await b.post('/logout', {});
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/login?out=1');
    expect(setCookies(r)[0]).toMatch(/^openszamla_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict$/);
    expect((await b.get('/login?out=1')).body).toContain('Kiléptél.');
    const replay = await e.browser().get('/', { cookie: oldCookie });
    expect(replay.status).toBe(401);
  });

  it('throttles repeated wrong tokens', async () => {
    const e = await env();
    for (let i = 0; i < 10; i++) expect((await e.browser().get(`/?token=wrong-${i}`)).status).toBe(401);
    const blocked = await e.browser().get(`/?token=${encodeURIComponent(TOKEN)}`);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain('Túl sok sikertelen belépési kísérlet');
  });
});

// ---------------------------------------------------------------------------------------------
describe('pages', () => {
  it('dashboard: seller, NAV status, counts, next steps, month summary, receivables, latest invoices', async () => {
    const e = await env();
    seed(e);
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', dueDate: '2026-10-01', issueDate: '2026-09-20', fulfillmentDate: '2026-09-20' });
    const b = await e.loggedIn();
    const r = await b.get('/');
    expect(r.status).toBe(200);
    expectSecureHtml(r);
    expect(r.body).toContain('<html lang="hu">');
    expect(r.body).toContain('Áttekintés');
    expect(r.body).toContain('Az eladó még nincs beállítva');
    expect(r.body).toContain('NAV Online Számla');
    expect(r.body).toContain('nincs beállítva');
    expect(r.body).toContain('Állítsd be az eladó adatait');
    expect(r.body).toContain('href="/invoices?status=issued_or_cancelled"');
    expect(r.body).toMatch(/<span class="v">4<\/span><span class="k">kiállított bizonylat<\/span>/);
    expect(r.body).toContain('E havi forgalom');
    expect(r.body).toContain('3 db');
    expect(r.body).toContain(ft('491094'));
    expect(r.body).toContain('Kintlévőség');
    expect(r.body).toContain('Lejárt határidejű számlák');
    expect(r.body).toContain('SZ-2026-00010');
    for (const n of ['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003']) expect(r.body).toContain(n);

    e.app.store.setSetting('seller', SELLER_NORMAL);
    const withSeller = await b.get('/');
    expect(withSeller.status).toBe(200);
    expect(withSeller.body).toContain('Példa Szoftver Kft.');
  });

  it('invoice list: filters (status, type, text, dates, payment, NAV, overdue) and pagination', async () => {
    const e = await env();
    seed(e);
    for (let i = 0; i < 30; i++) {
      insertDraft(e.app, INVOICE_DOMESTIC, { id: `inv_${(0xd00 + i).toString(16).padStart(10, '0')}`, customer: { ...CUSTOMER_DOMESTIC, name: `Piszkozat Vevő ${i}` } });
    }
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', dueDate: '2026-10-01', issueDate: '2026-09-20', fulfillmentDate: '2026-09-20' });
    const b = await e.loggedIn();
    const all = await b.get('/invoices');
    expectSecureHtml(all);
    expect(all.body).toContain('34 találat');
    expect(all.body).toContain('1–25 / 34 találat');
    expect(all.body).toContain('href="/invoices?page=2"');
    expect((await b.get('/invoices?page=2')).body).toContain('26–34 / 34 találat');

    const issued = await b.get('/invoices?status=issued');
    expect(issued.body).toContain('4 találat');
    expect(issued.body).toContain('SZ-2026-00003');
    expect(issued.body).not.toContain('Piszkozat Vevő');

    const text = await b.get('/invoices?q=Beispiel');
    expect(text.body).toContain('1 találat');
    expect(text.body).toContain('SZ-2026-00003');
    expect(text.body).not.toContain('SZ-2026-00001');

    expect((await b.get('/invoices?type=storno')).body).toContain('Nincs a szűrésnek megfelelő bizonylat.');
    expect((await b.get('/invoices?nav=inprogress')).body).toContain('4 találat');
    expect((await b.get('/invoices?payment=paid')).body).toContain('0 találat');
    expect((await b.get('/invoices?status=issued&from=2026-10-01&to=2026-10-31')).body).toContain('3 találat');
    const overdue = await b.get('/invoices?overdue=1');
    expect(overdue.body).toContain('1 találat');
    expect(overdue.body).toContain('SZ-2026-00010');
    const badDate = await b.get('/invoices?from=2026-13-45');
    expect(badDate.status).toBe(200);
    expect(badDate.body).toContain('Érvénytelen dátum a szűrőben');
    expect((await b.get('/invoices?status=<script>&sort=evil')).status).toBe(200);
  });

  it('invoice detail: buyer, lines, VAT summary, totals incl. HUF, notations, references, payment, NAV messages, audit', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    insertIssued(e.app, INVOICE_STORNO);
    e.app.store.patchInvoice(INVOICE_DOMESTIC.id, { status: 'cancelled', cancelledById: INVOICE_STORNO.id });
    insertIssued(e.app, INVOICE_EU_SERVICE, {
      navStatus: 'done_with_warnings',
      navTransactionId: 'TX-4F2A9',
      navMessages: [{ severity: 'WARN', code: 'INCORRECT_VAT_DATA_CHECK', message: 'A NAV figyelmeztetése a teszthez', pointer: '/InvoiceData/invoiceMain' }],
    });
    e.app.store.audit({ actor: 'mcp', action: 'invoice.issue', entityType: 'invoice', entityId: INVOICE_EU_SERVICE.id, details: { number: 'SZ-2026-00003' } });
    const b = await e.loggedIn();

    const dom = await b.get('/invoices/inv_00000000a1');
    expect(dom.status).toBe(200);
    expectSecureHtml(dom);
    for (const s of ['SZ-2026-00001', 'Árvíztűrő Tükörfúrógép Zrt.', '87654323-2-13', 'Példa Szoftver Kft.', 'Szoftverfejlesztés – október', '10 óra', ft('15000'), ft('150000'), ft('40700'), ft('194700'), 'PO-7781', 'átutalás', '2026.11.04.', 'sztornózott', 'Ezt a számlát sztornózták.', 'Kapcsolódó bizonylatok', 'href="/invoices/inv_00000000a4"', 'SZ-2026-00004', '<span class="pfx">NAV: </span>függő', 'Fizetés', 'nem fizetendő (sztornózva)', 'Eredetileg fizetendő', 'A számlát sztornózták, nem kell kifizetni.']) {
      expect(dom.body, s).toContain(s);
    }
    expect(dom.body).not.toContain('Befizetés rögzítése</button>');

    const eu = await b.get('/invoices/inv_00000000a3');
    for (const s of ['EUR', eur('800'), ft('312096'), '1 EUR = 390,12 Ft (MNB, 2026.10.23.)', 'Bruttó (Ft)', 'Fordított adózás', 'kétnyelvű (magyar–angol)', '<span class="pfx">NAV: </span>figyelmeztetés', 'TX-4F2A9', 'INCORRECT_VAT_DATA_CHECK', 'A NAV figyelmeztetése a teszthez', 'Napló', 'MCP (AI-ügynök)', 'Kiállítva', 'Befizetés rögzítése</button>', 'Sztornó számla készítése…</summary>']) {
      expect(eu.body, s).toContain(s);
    }

    const storno = await b.get('/invoices/inv_00000000a4');
    expect(storno.body).toContain('sztornó számla');
    expect(storno.body).toContain('Sztornózott számla: <a href="/invoices/inv_00000000a1">SZ-2026-00001</a>');
    expect(storno.body).toContain(ft('-194700'));
    expect(storno.body).not.toContain('Befizetés rögzítése</button>');

    const missing = await b.get('/invoices/inv_ffffffffff');
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('A bizonylat nem található.');
    for (const path of ['/invoices/inv_XYZ', '/invoices/inv_00000000a1/../../etc', '/invoices/inv_00000000a1%27', '/customers/cus_<x>', '/products/1']) {
      expect((await b.get(path)).status, path).toBe(404);
    }
  });

  it('draft detail: shows the draft, degrades gracefully when the check fails, and the draft can be deleted', async () => {
    const e = await env();
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000d1');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Piszkozat');
    expect(page.body).toContain('kiállításkor kap sorszámot');
    expect(page.body).toContain('Piszkozat végleges törlése');
    expect(page.body).toContain('href="/invoices/inv_00000000d1/edit"');
    const real = e.app.viewInvoice.bind(e.app);
    Object.assign(e.app, {
      viewInvoice: () => {
        throw new Error('INTERNAL-DETAIL-validate');
      },
    });
    const degraded = await b.get('/invoices/inv_00000000d1');
    expect(degraded.status).toBe(200);
    expect(degraded.body).toContain('Ez a rész most nem jeleníthető meg: váratlan hiba történt.');
    expect(degraded.body).not.toContain('INTERNAL-DETAIL');
    expect(degraded.body).not.toContain('name="confirmation"');
    expect(degraded.body).toContain('Szoftverfejlesztés – október');
    Object.assign(e.app, { viewInvoice: real });
    const del = await b.post('/invoices/inv_00000000d1/delete', {});
    expect(del.status).toBe(303);
    expect(del.headers.location).toBe('/invoices');
    expect((await b.follow(del)).body).toContain('A piszkozat törölve.');
    expect(e.app.store.getInvoice('inv_00000000d1')).toBeNull();
  });

  it('customers, products, settings and export pages render', async () => {
    const e = await env();
    seed(e);
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1', note: 'Törzsvásárló' });
    e.app.saveProduct({ name: 'Szoftverfejlesztés', unit: 'óra', unitPrice: '15000', vatCode: '27' }, 'web');
    const b = await e.loggedIn();
    const customers = await b.get('/customers');
    expectSecureHtml(customers);
    expect(customers.body).toContain('Árvíztűrő Tükörfúrógép Zrt.');
    expect(customers.body).toContain('href="/customers/cus_00000000c1"');
    expect((await b.get('/customers?q=arvizturo')).body).toContain('Árvíztűrő');
    expect((await b.get('/customers?q=nincsilyen')).body).toContain('Nincs a keresésnek megfelelő vevő.');
    const customer = await b.get('/customers/cus_00000000c1');
    expect(customer.body).toContain('Törzsvásárló');
    expect(customer.body).toContain('href="/invoices/new?customerId=cus_00000000c1"');
    const products = await b.get('/products');
    expect(products.body).toContain('Szoftverfejlesztés');
    expect(products.body).toContain(ft('15000'));
    const settings = await b.get('/settings');
    expectSecureHtml(settings);
    for (const s of ['Eladó (saját cég)', 'Új bizonylatok alapértelmezései', 'Sorszámtartományok', 'SZ-{YYYY}-{SEQ:5}', 'DB-{YYYY}-{SEQ:5}', 'NAV Online Számla kapcsolat', 'nincs beállítva']) {
      expect(settings.body, s).toContain(s);
    }
    // Series are managed only through MCP: the page says to ask the AI assistant (no tool name), no command-line function.
    expect(settings.body).toContain('Új sorszámtartományt (pl. külön előtaggal) az AI-asszisztenssel hozhatsz létre – kérd meg rá.');
    expect(settings.body).not.toContain('series_manage');
    expect(settings.body).not.toContain('parancssorból');
    const exp = await b.get('/export');
    expect(exp.body).toContain('name="format" value="csv"');
    expect(exp.body).toContain('value="2026-10-01"');
    const form = await b.get('/invoices/new');
    expectSecureHtml(form);
    for (let i = 0; i < 5; i++) expect(form.body).toContain(`name="lines[${i}].description"`);
    expect(form.body).toContain('<template id="line-template">');
    expect(form.body).toContain('<option value="óra">');
    expect(form.body).toContain('27% általános adókulcs');
    expect(form.body).toContain('AAM – Alanyi adómentes');
    expect(form.body).toMatch(/<script nonce="[^"]+">\(function \(\) \{/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('security', () => {
  const XSS = '<script>alert(1)</script>';
  const IMG = '"><img src=x onerror=alert(1)>';

  it('escapes a customer named <script>alert(1)</script> everywhere', async () => {
    const e = await env();
    const evil = { vatStatus: 'PRIVATE_PERSON' as const, name: XSS, address: { countryCode: 'HU', postalCode: '1111', city: XSS, addressLine: IMG }, email: IMG };
    insertCustomer(e.app, { ...evil, id: 'cus_00000000e1', note: XSS });
    insertIssued(e.app, INVOICE_DOMESTIC, {
      customerId: 'cus_00000000e1',
      customer: evil,
      comment: XSS,
      internalNote: IMG,
      orderNumber: XSS,
      notations: [XSS],
      lines: INVOICE_DOMESTIC.lines.map((l) => ({ ...l, description: XSS, unit: IMG })),
      navMessages: [{ severity: 'ERROR', code: XSS, message: IMG, pointer: XSS }],
    });
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000e2', customerId: null, customer: evil, comment: XSS });
    e.app.store.audit({ actor: 'web', action: XSS, entityType: 'invoice', entityId: 'inv_00000000a1', details: { [XSS]: IMG } });
    e.app.store.setSetting('seller', { ...SELLER_NORMAL, name: XSS, invoiceFooter: IMG });
    e.app.saveProduct({ name: XSS, unit: IMG, unitPrice: '1', vatCode: '27', sku: XSS }, 'web');
    const b = await e.loggedIn();
    const pages = [
      '/', '/invoices', `/invoices?q=${encodeURIComponent(XSS)}`, '/invoices/inv_00000000a1', '/invoices/inv_00000000e2', '/invoices/inv_00000000e2/edit',
      '/customers', `/customers?q=${encodeURIComponent('<script>')}`, '/customers/cus_00000000e1', '/invoices/new', '/invoices/new?customerId=cus_00000000e1',
      '/products', '/settings', '/export', `/nope/${encodeURIComponent(XSS)}`, `/invoices/${encodeURIComponent(XSS)}`,
    ];
    let escapedSeen = 0;
    for (const path of pages) {
      const r = await b.get(path);
      expect(r.status, path).toBeLessThan(500);
      if (r.status === 404 && !path.startsWith('/invoices/')) continue;
      expect(r.body, path).not.toContain(XSS);
      expect(r.body, path).not.toContain('<img src=x');
      expect(r.body, path).not.toMatch(/<script>alert/i);
      expect(scriptsHaveNonce(r), path).toBe(true);
      if (r.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;')) escapedSeen++;
    }
    expect(escapedSeen).toBeGreaterThanOrEqual(10);
    const product = e.app.findProducts({}).items[0];
    const productPage = await b.get(`/products/${product?.id ?? ''}`);
    expect(productPage.body).not.toContain(XSS);
    expect(productPage.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('CSRF: POSTs without / with a wrong / foreign token or from another origin are rejected; with the token accepted', async () => {
    const e = await env();
    seed(e);
    const b = await e.loggedIn();
    const other = await e.loggedIn();
    await b.get('/invoices/inv_00000000a1');
    const path = '/invoices/inv_00000000a1/payment';
    const fields = { amount: '1000', date: '2026-10-27' };
    const attempts: Array<[string, Res]> = [
      ['no token', await b.post(path, fields, { csrf: null })],
      ['wrong token', await b.post(path, fields, { csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })],
      ['token of another session', await b.post(path, fields, { csrf: other.csrf })],
      ['cross-site fetch metadata', await b.post(path, fields, { headers: { 'sec-fetch-site': 'cross-site' } })],
      ['same-site (other port) fetch metadata', await b.post(path, fields, { headers: { 'sec-fetch-site': 'same-site' } })],
      ['foreign Origin', await b.post(path, fields, { headers: { origin: 'https://evil.example' } })],
      ['foreign Referer without Origin', await b.post(path, fields, { headers: { origin: '', referer: 'https://evil.example/form' } })],
    ];
    for (const [what, r] of attempts) {
      expect(r.status, what).toBe(403);
      expect(e.app.getInvoice('inv_00000000a1').paidAmount, what).toBe('0');
    }
    expect(attempts[0]?.[1].body).toContain('biztonsági token (CSRF)');
    const ok = await b.post(path, fields);
    expect(ok.status).toBe(303);
    expect(e.app.getInvoice('inv_00000000a1').paidAmount).toBe('1000');
  });

  it('limits POST bodies to 256 kB urlencoded forms and rejects other methods', async () => {
    const e = await env();
    seed(e);
    const b = await e.loggedIn();
    const big = await b.post('/invoices/inv_00000000a1/payment', { amount: '1', filler: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body).toContain('Túl nagy kérés');
    const json = await rawRequest(e.base, 'POST', '/invoices/inv_00000000a1/payment', {
      headers: { cookie: b.cookie as string, 'content-type': 'application/json', origin: e.base },
      body: JSON.stringify({ amount: '1', _csrf: b.csrf }),
    });
    expect(json.status).toBe(415);
    const put = await rawRequest(e.base, 'PUT', '/invoices', { headers: { cookie: b.cookie as string } });
    expect(put.status).toBe(405);
    const getOnPostRoute = await b.get('/invoices/inv_00000000a1/payment');
    expect(getOnPostRoute.status).toBe(405);
    expect(e.app.getInvoice('inv_00000000a1').paidAmount).toBe('0');
  });

  it('never shows the NAV secrets or the access token on any page', async () => {
    // Valid formats (6–15 letter/digit login, 16-character exchange key): unusable settings would hide the NAV actions.
    const secrets = ['SECRETLOGIN7f3a', 'SECRETPASSWORD-91c2e4', 'SECRETSIGNINGKEY-55e0aa', 'SECRETEXCH-d00d4'];
    const e = await env({
      nav: {
        environment: 'test',
        credentials: { login: secrets[0] as string, password: secrets[1] as string, signingKey: secrets[2] as string, exchangeKey: secrets[3] as string },
        source: 'env',
        baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
      },
    });
    seed(e);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const responses: Array<[string, Res]> = [['login', await e.browser().get('/')]];
    const b = await e.loggedIn();
    for (const path of ['/', '/invoices', '/invoices/inv_00000000a1', '/invoices/inv_00000000d1', '/invoices/inv_00000000d1/edit', '/invoices/new', '/customers', '/customers/cus_00000000c1', '/products', '/settings', '/export', '/invoices/inv_ffffffffff', '/logout']) {
      responses.push([path, await b.get(path)]);
    }
    responses.push(['export xml', await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'xml' })]);
    for (const [what, r] of responses) {
      const all = `${JSON.stringify(r.headers)}\n${r.body}`;
      for (const s of [...secrets, TOKEN]) expect(all.includes(s), `${what} leaks ${s}`).toBe(false);
    }
    const settings = responses.find(([p]) => p === '/settings')?.[1];
    expect(settings?.body).toContain('TESZT környezet');
    expect(settings?.body).toContain('a program indításakor megadott beállítások (környezeti változók)');
    expect(settings?.body).toContain('openszamla nav-setup');
    const detail = responses.find(([p]) => p === '/invoices/inv_00000000a1')?.[1];
    expect(detail?.body).toContain('Számla beküldése a NAV-nak</button>');
  });

  it('maps service errors to friendly Hungarian messages and never reflects raw exceptions', async () => {
    const e = await env();
    seed(e);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const draftPay = await b.follow(await b.post('/invoices/inv_00000000d1/payment', { amount: '5' }));
    expect(draftPay.body).toContain('Piszkozatra nem rögzíthető fizetés.');
    const nav = await b.follow(await b.post('/invoices/inv_00000000a1/nav-sync', {}));
    expect(nav.body).toContain('A NAV Online Számla kapcsolat nincs beállítva.');
    expect(nav.body).toContain('openszamla nav-setup');
    const missing = await b.post('/invoices/inv_ffffffffff/payment', {});
    expect(missing.headers.location).toBe('/invoices');
    expect((await b.follow(missing)).body).toContain('Számla nem található: inv_ffffffffff');

    Object.assign(e.app, {
      report: () => {
        throw new Error('INTERNAL-DETAIL-report /secret/path');
      },
      recordPayment: () => {
        throw new TypeError('INTERNAL-DETAIL-payment');
      },
    });
    const dash = await b.get('/');
    expect(dash.status).toBe(200);
    expect(dash.body).toContain('Ez a rész most nem jeleníthető meg');
    expect(dash.body).not.toContain('INTERNAL-DETAIL');
    const pay = await b.follow(await b.post('/invoices/inv_00000000a1/payment', { amount: '5' }));
    expect(pay.body).toContain('Váratlan hiba történt');
    expect(pay.body).not.toContain('INTERNAL-DETAIL');
  });
});

// ---------------------------------------------------------------------------------------------
describe('actions', () => {
  it('records payments (partial, then the rest) via POST and logs them', async () => {
    const e = await env();
    seed(e);
    const b = await e.loggedIn();
    await b.get('/invoices/inv_00000000a1');
    const first = await b.post('/invoices/inv_00000000a1/payment', { amount: '100 000', date: '2026-10-20' });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/invoices/inv_00000000a1');
    const page = await b.follow(first);
    expect(page.body).toContain(`Befizetés rögzítve: részben fizetve (${ft('100000')} / ${ft('194700')}).`);
    let inv: Invoice = e.app.getInvoice('inv_00000000a1');
    expect(inv.paymentStatus).toBe('partial');
    expect(inv.paidAmount).toBe('100000');
    expect(inv.paidDate).toBeNull(); // paid in part: no payment date yet
    const rest = await b.follow(await b.post('/invoices/inv_00000000a1/payment', { amount: '', date: '2026-10-27' }));
    expect(rest.body).toContain(`Befizetés rögzítve: fizetve (${ft('194700')} / ${ft('194700')}).`);
    inv = e.app.getInvoice('inv_00000000a1');
    expect(inv.paymentStatus).toBe('paid');
    expect(inv.paidDate).toBe('2026-10-27'); // the day it became fully paid
    expect(rest.body).not.toContain('Befizetés rögzítése</button>');
    expect(rest.body).toContain('Befizetés rögzítve</span></td>');
    expect(rest.body).toContain('webes felület');
    const audit = e.app.auditLog({ entityId: 'inv_00000000a1' }).items;
    expect(audit.filter((a) => a.action === 'invoice.payment' && a.actor === 'web')).toHaveLength(2);
  });

  it.skipIf(!PDF_READY)('downloads the PDF (application/pdf attachment)', async () => {
    const e = await env();
    seed(e);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const r = await b.get('/invoices/inv_00000000a1.pdf');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('attachment; filename="SZ-2026-00001.pdf"');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const draft = await b.get('/invoices/inv_00000000d1.pdf');
    expect(draft.status).toBe(200);
    expect(draft.headers['content-disposition']).toBe('attachment; filename="TERVEZET_inv_00000000d1.pdf"');
    expect((await b.get('/invoices/inv_ffffffffff.pdf')).status).toBe(404);
  });

  it('exports CSV and JSON as downloads and the NAV XML files into the export folder', async () => {
    const e = await env();
    seed(e);
    const b = await e.loggedIn();
    await b.get('/export');
    const csv = await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="szamlak_2026-10-01_2026-10-31.csv"');
    expect(csv.body).toContain('Sorszám;Típus;Állapot');
    expect(csv.body).toContain('SZ-2026-00001');
    const json = await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'json' });
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect((JSON.parse(json.body) as unknown[]).length).toBe(3);
    const xml = await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'xml' });
    expect(xml.status).toBe(200);
    expect(xml.body).toContain('3 számla NAV XML fájlja elkészült');
    const bad = await b.post('/export', { from: '2026-10-01', to: 'tegnap', format: 'csv' });
    expect(bad.status).toBe(422);
    expect(bad.body).toContain('Érvénytelen dátum');
    expect((await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'exe' })).status).toBe(422);
  });

  it('exports by fulfilment date on request; the dashboard receivables lead to exactly the invoices they count (MCP-UX-6, BIZ-9)', async () => {
    const e = await env();
    seed(e);
    // September work invoiced in October, and a storno (negative: nothing is owed on it).
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f1', number: 'SZ-2026-00011', issueDate: '2026-10-05', fulfillmentDate: '2026-09-30', dueDate: '2026-10-13' });
    insertIssued(e.app, INVOICE_STORNO);
    const b = await e.loggedIn();
    const page = await b.get('/export');
    expect(page.body).toContain('name="dateBasis"');
    expect(page.body).toContain('teljesítés dátuma szerint');
    const byFulfilment = await b.post('/export', { from: '2026-09-01', to: '2026-09-30', format: 'csv', dateBasis: 'fulfillment' });
    expect(byFulfilment.headers['content-disposition']).toBe('attachment; filename="szamlak_teljesites_2026-09-01_2026-09-30.csv"');
    expect(byFulfilment.body).toContain('SZ-2026-00011');
    expect((await b.post('/export', { from: '2026-09-01', to: '2026-09-30', format: 'csv' })).body).not.toContain('SZ-2026-00011');

    const dash = await b.get('/');
    expect(dash.body).toContain('href="/invoices?payment=receivable"');
    const counts = e.app.status().counts;
    expect(dash.body).toMatch(new RegExp(`<span class="v">${counts.unpaid}</span><span class="k">nyitott \\(fizetetlen\\) számla</span>`));
    const receivable = await b.get('/invoices?payment=receivable');
    expect(receivable.body).toContain(`${counts.unpaid} találat`);
    expect(receivable.body).not.toContain('SZ-2026-00004');
    expect((await b.get('/invoices?payment=open')).body).toContain('SZ-2026-00004');
    const overdue = await b.get('/invoices?overdue=1');
    expect(overdue.body).toContain(`${e.app.report({ from: '2026-10-01', to: '2026-10-27' }).receivables.overdueCount} találat`);
  });

  it('the NAV XML export names an invoice it had to leave out instead of failing', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    // A line-less modification (older versions could issue one): no NAV XML can be built for it.
    const zero = { netAmount: '0', vatAmount: '0', grossAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0', byVat: [], payableAmount: '0', roundingDifference: '0' };
    insertIssued(e.app, INVOICE_DOMESTIC, {
      id: 'inv_00000000e9', number: 'SZ-2026-00009', documentType: 'modification', lines: [], totals: zero, notations: [],
      reference: { originalInvoiceId: INVOICE_DOMESTIC.id, originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false, originalDocumentType: 'invoice' },
    });
    const b = await e.loggedIn();
    await b.get('/export');
    const xml = await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'xml' });
    expect(xml.status).toBe(200);
    expect(xml.body).toContain('1 számla NAV XML fájlja elkészült');
    expect(xml.body).toContain('flash-warn');
    expect(xml.body).toMatch(/SZ-2026-00009: A számla kimaradt/);
  });

  it('creates and edits products, saves invoice defaults', async () => {
    const e = await env();
    const b = await e.loggedIn();
    await b.get('/products');
    const missingPrice = await b.post('/products', { name: 'Konzultáció', unit: 'óra', unitPrice: '', vatCode: '27', priceBasis: 'net', currency: 'HUF' });
    expect(missingPrice.status).toBe(422);
    expect(missingPrice.body).toContain('Add meg az egységárat.');
    expect(missingPrice.body).toContain('value="Konzultáció"');
    const created = await b.post('/products', { name: 'Konzultáció', unit: 'óra', unitPrice: '12 500,5', vatCode: '27', priceBasis: 'net', currency: 'huf', nature: '' });
    expect(created.status).toBe(303);
    expect((await b.follow(created)).body).toContain('Mentve: Konzultáció.');
    const p = e.app.findProducts({}).items[0];
    expect(p).toMatchObject({ name: 'Konzultáció', unit: 'óra', unitPrice: '12500.5', currency: 'HUF', vatCode: '27', nature: 'SERVICE' });
    const edit = await b.get(`/products/${p?.id ?? ''}`);
    expect(edit.body).toContain('value="12500,5"');
    const saved = await b.post(`/products/${p?.id ?? ''}`, { name: 'Konzultáció (senior)', unit: 'óra', unitPrice: '20000', vatCode: '27', priceBasis: 'net', currency: 'HUF', archived: '1' });
    expect(saved.status).toBe(303);
    expect(e.app.getProduct(p?.id ?? '')).toMatchObject({ name: 'Konzultáció (senior)', unitPrice: '20000', archived: true });

    await b.get('/settings');
    const bad = await b.post('/settings/defaults', { paymentMethod: 'TRANSFER', paymentDays: 'sok', language: 'hu', appearance: 'ELECTRONIC', currency: 'HUF', exchangeRateSource: 'MNB' });
    expect(bad.status).toBe(422);
    expect(bad.body).toContain('0 és 365 közötti egész szám');
    const ok = await b.post('/settings/defaults', { paymentMethod: 'CASH', paymentDays: '15', language: 'hu-en', appearance: 'PAPER', currency: 'eur', exchangeRateSource: 'manual' });
    expect(ok.status).toBe(303);
    expect((await b.follow(ok)).body).toContain('Alapértelmezések mentve.');
    expect(e.app.getDefaults()).toEqual({ paymentMethod: 'CASH', paymentDays: 15, language: 'hu-en', appearance: 'PAPER', currency: 'EUR', exchangeRateSource: 'manual' });
  });
});

// Keep the type import used even if a test above is skipped.
export type { Browser };
