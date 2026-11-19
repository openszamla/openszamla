/**
 * List pages put their main action first: one primary button in the page head ("Új számla készítése",
 * "Új vevő felvétele", "Új termék / szolgáltatás felvétele"), search and filter as secondary buttons, an
 * empty list offers the next step, and an overdue receivable is marked "lejárt" by the service's own rule.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertCustomer, insertDraft, insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  return e;
}

const primaries = (body: string): number => (body.match(/class="btn btn-primary"/g) ?? []).length;

/** The <tr> of the invoice table row that links to `id`. */
function rowOf(body: string, id: string): string {
  const at = body.indexOf(`href="/invoices/${id}"`);
  if (at < 0) return '';
  return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at));
}

describe('main actions of the list pages', () => {
  it('invoices: "Új számla készítése" is the one primary button; filtering is secondary; an empty list offers a new invoice', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const empty = await b.get('/invoices');
    expect(empty.body).toMatch(/<div class="action-bar"><a class="btn btn-primary" href="\/invoices\/new">.*Új számla készítése<\/a><\/div>/);
    expect(empty.body).toMatch(/<button class="btn" type="submit"><svg[^>]*>.*?<\/svg>Szűrés<\/button>/);
    expect(empty.body).toContain('<p class="empty">Még nincs bizonylat.</p><a class="btn" href="/invoices/new">');
    expect(primaries(empty.body)).toBe(1);
    const filtered = await b.get('/invoices?status=draft');
    expect(filtered.body).toContain('<a class="btn btn-quiet" href="/invoices">Szűrők törlése</a>');
    expect(filtered.body).toContain('Nincs a szűrésnek megfelelő bizonylat.');
  });

  it('customers: "Új vevő felvétele" opens the form at the bottom (?new=1); search is secondary; the detail page goes back quietly', async () => {
    const e = await env();
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    const list = await b.get('/customers');
    expect(list.body).toMatch(/<div class="action-bar"><a class="btn btn-primary" href="\/customers\?new=1#h-new">.*Új vevő felvétele<\/a><\/div>/);
    expect(list.body).toMatch(/<button class="btn" type="submit"><svg[^>]*>.*?<\/svg>Keresés<\/button>/);
    expect(list.body).toContain('<details><summary id="h-new">');
    expect((await b.get('/customers?new=1')).body).toContain('<details open><summary id="h-new">');
    expect(list.body).toContain('Vevő mentése</button>');
    const detail = await b.get('/customers/cus_00000000c1');
    expect(detail.body).toMatch(/<a class="btn btn-primary" href="\/invoices\/new\?customerId=cus_00000000c1">.*Új számla ennek a vevőnek<\/a>/);
    expect(detail.body).toMatch(/<a class="btn btn-quiet" href="\/customers">.*Vissza a vevőlistához<\/a>/);
    expect(detail.body).toContain('Vevő adatainak mentése</button>');
  });

  it('products: "Új termék / szolgáltatás felvétele"; an empty list says so and offers it', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const empty = await b.get('/products');
    expect(empty.body).toMatch(/<a class="btn btn-primary" href="\/products\?new=1#h-new">.*Új termék \/ szolgáltatás felvétele<\/a>/);
    expect(empty.body).toContain('<p class="empty">Még nincs elmentett termék vagy szolgáltatás.</p><a class="btn" href="/products?new=1#h-new">');
    expect(empty.body).toContain('Termék mentése</button>');
    e.app.saveProduct({ name: 'Szoftverfejlesztés', unit: 'óra', unitPrice: '15000', vatCode: '27' }, 'web');
    const p = e.app.findProducts({}).items[0];
    const detail = await b.get(`/products/${p?.id ?? ''}`);
    expect(detail.body).toMatch(/<a class="btn btn-quiet" href="\/products">.*Vissza a terméklistához<\/a>/);
    expect(detail.body).toContain('Termék adatainak mentése</button>');
  });
});

describe('"lejárt" marks an overdue receivable', () => {
  it('in the list, on the dashboard and on the customer page – not on a paid, a not yet due or a draft document', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const base = { customerId: 'cus_00000000c1', issueDate: '2026-09-20', fulfillmentDate: '2026-09-20', dueDate: '2026-10-01' };
    insertIssued(e.app, INVOICE_DOMESTIC, { ...base, id: 'inv_00000000b1', number: 'SZ-2026-00010' });
    insertIssued(e.app, INVOICE_DOMESTIC, { ...base, id: 'inv_00000000b2', number: 'SZ-2026-00011', paymentStatus: 'paid', paidAmount: INVOICE_DOMESTIC.totals.payableAmount, paidDate: '2026-09-25' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b3', number: 'SZ-2026-00012', customerId: 'cus_00000000c1' });
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1', dueDate: '2026-10-01' });
    const b = await e.loggedIn();
    for (const path of ['/invoices', '/', '/customers/cus_00000000c1']) {
      const body = (await b.get(path)).body;
      expect(rowOf(body, 'inv_00000000b1'), path).toContain('lejárt</span>');
      expect(rowOf(body, 'inv_00000000b2'), path).not.toContain('lejárt');
      expect(rowOf(body, 'inv_00000000b3'), path).not.toContain('lejárt');
      if (path !== '/customers/cus_00000000c1') expect(rowOf(body, 'inv_00000000d1'), path).not.toContain('lejárt');
    }
  });
});

describe('dashboard NAV sync', () => {
  it('says what it does: "Függő számlák beküldése a NAV-nak" with an explanation; the to-dos are in web words, with no MCP tool names', async () => {
    const nav: AppConfig['nav'] = {
      environment: 'test',
      credentials: { login: 'LISTLOGIN7f3a', password: 'list-password-1', signingKey: 'LIST-SIGNING-KEY-55e0', exchangeKey: 'LISTEXCH-d00d42a' },
      source: 'env',
      baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
    };
    const e = await env({ nav });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'aborted' });
    const b = await e.loggedIn();
    const r = await b.get('/');
    expect(r.body).toContain('Beküldi a még nem jelentett számlákat, és lekérdezi a feldolgozás alatt állók állapotát.');
    expect(r.body).toMatch(/<button class="btn" type="submit"><svg[^>]*>.*?<\/svg>Függő számlák beküldése a NAV-nak<\/button>/);
    expect(r.body).toContain('aria-label="Függő számlák beküldése a NAV-nak"');
    expect(r.body).not.toContain('nav_sync');
    expect(r.body).toContain('1 számla jelentését a NAV elutasította, vagy végleges hibával zárult');
    expect(r.body).toContain('<a href="/invoices?nav=problem">NAV-problémás számlák</a>');
  });
});
