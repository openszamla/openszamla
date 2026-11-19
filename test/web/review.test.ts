/**
 * Regression tests from the security / UX review of the web UI: login throttle abuse from other
 * sites, last-line secret redaction, lossless round trips of the edit forms (data the forms do not
 * show must survive a save), confirmation binding, double submits, and headers on every response.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { CUSTOMER_DOMESTIC, CUSTOMER_EU, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, SELLER_NORMAL } from '../fixtures/invoices.ts';
import {
  flashesOf,
  formFields,
  hiddenValue,
  insertCustomer,
  insertDraft,
  insertIssued,
  rawRequest,
  setCookies,
  startWeb,
  TOKEN,
  type Fields,
  type Res,
  type WebEnv,
} from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  return e;
}

const NAVIGATE = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

describe('login throttle cannot be exhausted from other sites', () => {
  it('refuses ?token= on sub-resource and frame requests unchecked and uncounted; the owner can still log in', async () => {
    const e = await env();
    const planted = [
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    ];
    for (let i = 0; i < 30; i++) {
      const headers = planted[i % planted.length] as Record<string, string>;
      const r = await rawRequest(e.base, 'GET', `/?token=wrong-${i}`, { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(setCookies(r)).toEqual([]);
    }
    // Even the right token is not accepted from an <img>/<iframe> (no cookie is ever set that way).
    const framed = await rawRequest(e.base, 'GET', `/?token=${encodeURIComponent(TOKEN)}`, { headers: planted[1] as Record<string, string> });
    expect(framed.status).toBe(403);
    expect(setCookies(framed)).toEqual([]);
    // The printed link (typed / pasted → Sec-Fetch-Site: none) and a link clicked in a webmail page still work.
    for (const site of ['none', 'cross-site']) {
      const r = await rawRequest(e.base, 'GET', `/invoices?token=${encodeURIComponent(TOKEN)}`, { headers: { 'sec-fetch-site': site, ...NAVIGATE } });
      expect(r.status, site).toBe(303);
      expect(r.headers.location).toBe('/invoices');
      expect(setCookies(r)[0]).toMatch(/^openszamla_session=/);
    }
  });
});

describe('secrets are never rendered', () => {
  const secrets = { login: 'NAVLOGIN-6b1f0c2d', password: 'p&ss"w<rd>-91c2e4', signingKey: 'SIGNKEY-55e0aa-77c1-4d2f', exchangeKey: 'XCHG-d00d42e1' };

  it('redacts NAV credentials and the access token even when they end up in stored data or messages', async () => {
    const e = await env({ nav: { environment: 'test', credentials: secrets, source: 'file', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' } });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC, {
      navStatus: 'error',
      navMessages: [{ severity: 'ERROR', code: 'INVALID_SECURITY_USER', message: `Hibás felhasználó: ${secrets.login} / ${secrets.password}` }],
      comment: `kulcsok: ${secrets.signingKey} ${secrets.exchangeKey}`,
      internalNote: `token: ${TOKEN}`,
    });
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1', note: `jelszó: ${secrets.password}` });
    const b = await e.loggedIn();
    for (const path of ['/invoices/inv_00000000a1', '/customers/cus_00000000c1', '/invoices', '/', '/settings']) {
      const r = await b.get(path);
      expect(r.status, path).toBe(200);
      for (const s of [...Object.values(secrets), TOKEN]) {
        expect(r.body.includes(s), `${path} shows ${s}`).toBe(false);
        expect(r.body.includes(s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), `${path} shows ${s} (escaped)`).toBe(false);
      }
    }
    const detail = await b.get('/invoices/inv_00000000a1');
    expect(detail.body).toContain('Hibás felhasználó: [rejtett] / [rejtett]');
    expect(detail.body).toContain('token: [rejtett]');
  });
});

describe('edit forms keep the data they do not show', () => {
  it('a draft made through MCP survives an unchanged save of the web form (buyer extras, line nature, MNB rate)', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const buyer = {
      ...CUSTOMER_DOMESTIC,
      taxNumber: '87654323-5-13',
      groupMemberTaxNumber: '12345676-4-42',
      phone: '+36 1 234 5678',
      bankAccount: '12345676-11111111',
      address: { ...CUSTOMER_DOMESTIC.address, region: 'Pest' },
    };
    // "db" would be inferred as PRODUCT – the agent explicitly said SERVICE for the second line.
    insertDraft(e.app, INVOICE_DOMESTIC, {
      id: 'inv_00000000f1',
      customer: buyer,
      lines: INVOICE_DOMESTIC.lines.map((l, i) => (i === 1 ? { ...l, nature: 'SERVICE' as const } : l)),
    });
    // MNB rate of the fulfilment day (same day → the service keeps it without contacting the MNB).
    insertDraft(e.app, INVOICE_EU_SERVICE, { id: 'inv_00000000f2', customer: { ...CUSTOMER_EU, phone: '+49 30 1234567' }, exchangeRateDate: INVOICE_EU_SERVICE.fulfillmentDate });
    const b = await e.loggedIn();
    const essentials = (inv: Invoice): unknown => ({
      customer: inv.customer,
      customerId: inv.customerId,
      lines: inv.lines.map((l) => [l.description, l.quantity, l.unit, l.unitPrice, l.priceBasis, l.vatCode, l.nature, l.productId ?? null]),
      rate: [inv.currency, inv.exchangeRate, inv.exchangeRateSource, inv.exchangeRateDate],
      dates: [inv.issueDate, inv.fulfillmentDate, inv.dueDate],
      other: [inv.documentType, inv.paymentMethod, inv.language, inv.appearance, inv.comment, inv.orderNumber, inv.internalNote, inv.seriesId],
    });
    for (const id of ['inv_00000000f1', 'inv_00000000f2']) {
      const before = e.app.getInvoice(id);
      const page = await b.get(`/invoices/${id}/edit`);
      expect(page.status, id).toBe(200);
      const saved = await b.post(`/invoices/${id}/edit`, formFields(page.body, `/invoices/${id}/edit`));
      expect(saved.status, `${id}: ${flashesOf(saved.body)}`).toBe(303);
      expect(essentials(e.app.getInvoice(id)), id).toEqual(essentials(before));
    }
  });

  it('changing the unit of a line lets the service infer its nature again', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f3' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000f3/edit');
    const fields = formFields(page.body, '/invoices/inv_00000000f3/edit');
    fields['lines[1].unit'] = 'óra';
    const saved = await b.post('/invoices/inv_00000000f3/edit', fields);
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    expect(e.app.getInvoice('inv_00000000f3').lines.map((l) => l.nature)).toEqual(['SERVICE', 'SERVICE']);
  });

  describe('pre-filled manual exchange rate (Áfa tv. 80. §: the rate of the fulfilment date)', () => {
    const manualDraft = (e: WebEnv, id: string): void => {
      e.app.store.setSetting('seller', SELLER_NORMAL);
      insertDraft(e.app, INVOICE_EU_SERVICE, { id, exchangeRate: '398.5', exchangeRateSource: 'manual', exchangeRateDate: INVOICE_EU_SERVICE.fulfillmentDate });
    };
    const rate = (e: WebEnv, id: string): unknown[] => {
      const inv = e.app.getInvoice(id);
      return [inv.fulfillmentDate, inv.currency, inv.exchangeRate, inv.exchangeRateSource, inv.exchangeRateDate];
    };
    /** Posts the form and returns the flash titles shown after the redirect. */
    const save = async (b: Awaited<ReturnType<WebEnv['loggedIn']>>, action: string, fields: Fields): Promise<string> => {
      const r = await b.post(action, fields);
      expect(r.status, flashesOf(r.body)).toBe(303);
      return flashesOf((await b.get(String(r.headers.location))).body);
    };

    it('kept on an unchanged save; left as it was for a new fulfilment date it is not carried over, and the user is told (manual policy)', async () => {
      const e = await env();
      e.app.updateDefaults({ exchangeRateSource: 'manual' });
      manualDraft(e, 'inv_00000000f4');
      const b = await e.loggedIn();
      const action = '/invoices/inv_00000000f4/edit';
      const page = await b.get(action);
      expect(page.body).toContain('Ez a kézi árfolyam a teljesítés napjáé');
      const unchanged = formFields(page.body, action);
      // Shown with a decimal comma – the notation the form reads back.
      expect(unchanged.exchangeRate).toBe('398,5');
      expect(await save(b, action, unchanged)).toBe('Piszkozat mentve.');
      expect(rate(e, 'inv_00000000f4')).toEqual(['2026-10-24', 'EUR', '398.5', 'manual', '2026-10-24']);

      const moved = formFields((await b.get(action)).body, action);
      moved.fulfillmentDate = '2026-10-21';
      expect(await save(b, action, moved)).toMatch(/^Piszkozat mentve; a korábbi kézi árfolyamot \(1 EUR = 398,5 Ft\) nem vettem át\. 1 hibát javítani kell/);
      expect(rate(e, 'inv_00000000f4')).toEqual(['2026-10-21', 'EUR', '0', null, null]);
      // The same form again (double click, back + resend): refused, the old rate does not come back.
      expect(await save(b, action, moved)).toBe('A piszkozat az űrlap megnyitása óta megváltozott, ezért ezt a mentést nem hajtottam végre.');
      expect(rate(e, 'inv_00000000f4')[2]).toBe('0');
    });

    it('a new date and a rate typed in the same save are both taken; a currency change drops the untouched rate too', async () => {
      const e = await env();
      e.app.updateDefaults({ exchangeRateSource: 'manual' });
      manualDraft(e, 'inv_00000000f6');
      const b = await e.loggedIn();
      const action = '/invoices/inv_00000000f6/edit';
      const both = formFields((await b.get(action)).body, action);
      both.fulfillmentDate = '2026-10-20';
      both.exchangeRate = '398,50'; // the same number, typed again in another notation: that is a given rate
      expect(await save(b, action, both)).toBe('Piszkozat mentve.');
      expect(rate(e, 'inv_00000000f6')).toEqual(['2026-10-20', 'EUR', '398.5', 'manual', '2026-10-20']);

      const usd = formFields((await b.get(action)).body, action);
      usd.currency = 'USD';
      expect(await save(b, action, usd)).toMatch(/a korábbi kézi árfolyamot \(1 EUR = 398,5 Ft\) nem vettem át/);
      expect(rate(e, 'inv_00000000f6')).toEqual(['2026-10-20', 'USD', '0', null, null]);
    });

    it('MNB policy: the untouched manual rate gives way to the MNB rate of the new day', async () => {
      const e = await env();
      manualDraft(e, 'inv_00000000f7');
      e.app.store.putCachedRate('2026-10-21', { currency: 'EUR', date: '2026-10-21', rate: '395.2', unit: 1, source: 'MNB' });
      const b = await e.loggedIn();
      const action = '/invoices/inv_00000000f7/edit';
      const moved = formFields((await b.get(action)).body, action);
      moved.fulfillmentDate = '2026-10-21';
      expect(await save(b, action, moved)).toMatch(/a korábbi kézi árfolyamot \(1 EUR = 398,5 Ft\) nem vettem át/);
      expect(rate(e, 'inv_00000000f7')).toEqual(['2026-10-21', 'EUR', '395.2', 'MNB', '2026-10-21']);
      expect(await save(b, action, moved)).toMatch(/megváltozott, ezért ezt a mentést nem hajtottam végre/);
      expect(rate(e, 'inv_00000000f7')).toEqual(['2026-10-21', 'EUR', '395.2', 'MNB', '2026-10-21']);
    });

    it('a form older than a change made elsewhere (MCP) does not overwrite it', async () => {
      const e = await env();
      manualDraft(e, 'inv_00000000f8');
      const b = await e.loggedIn();
      const action = '/invoices/inv_00000000f8/edit';
      const stale = formFields((await b.get(action)).body, action);
      await e.app.updateDraft('inv_00000000f8', { exchangeRate: '400' }, 'mcp');
      stale.fulfillmentDate = '2026-10-21';
      stale.comment = 'régi űrlapból';
      expect(await save(b, action, stale)).toMatch(/megváltozott, ezért ezt a mentést nem hajtottam végre/);
      const inv = e.app.getInvoice('inv_00000000f8');
      expect([inv.fulfillmentDate, inv.exchangeRate, inv.comment ?? null]).toEqual(['2026-10-24', '400', INVOICE_EU_SERVICE.comment ?? null]);
    });
  });

  it('a due date left as it was keeps moving with the issue date; one typed in stays fixed', async () => {
    // Two days after the draft's stored issue date: the preview (what issuing does today) shows the shift.
    const e = await env({ now: () => new Date('2026-10-29T09:00:00.000Z') });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f5' });
    const b = await e.loggedIn();
    const action = '/invoices/inv_00000000f5/edit';
    const before = e.app.getInvoice('inv_00000000f5');
    expect([before.issueDate, before.dueDate, before.dueDateExplicit === true]).toEqual(['2026-10-27', '2026-11-04', false]);
    const page = await b.get(action);
    expect(page.body).toContain('ha nem írod át (vagy kiüríted), a kiállítás napjával együtt eltolódik');
    expect((await b.post(action, formFields(page.body, action))).status).toBe(303);
    const preview = e.app.viewInvoice('inv_00000000f5').invoice;
    expect([preview.issueDate, preview.dueDate]).toEqual(['2026-10-29', '2026-11-06']);

    const typed = formFields((await b.get(action)).body, action);
    typed.dueDate = '2026-12-01';
    expect((await b.post(action, typed)).status).toBe(303);
    const fixed = e.app.getInvoice('inv_00000000f5');
    expect([fixed.dueDate, fixed.dueDateExplicit]).toEqual(['2026-12-01', true]);
    expect(e.app.viewInvoice('inv_00000000f5').invoice.dueDate).toBe('2026-12-01');
    expect((await b.get(action)).body).toContain('Megadott határidő: kiállításkor sem változik (üresen hagyva is megmarad).');
  });

  it('the customer form keeps the group member tax number and the region', async () => {
    const e = await env();
    insertCustomer(e.app, {
      ...CUSTOMER_DOMESTIC,
      id: 'cus_00000000c2',
      taxNumber: '87654323-5-13',
      groupMemberTaxNumber: '12345676-4-42',
      phone: '+36 1 234 5678',
      bankAccount: '12345676-11111111',
      address: { ...CUSTOMER_DOMESTIC.address, region: 'Pest' },
      note: 'Törzsvásárló',
    });
    const b = await e.loggedIn();
    const before = e.app.getCustomer('cus_00000000c2');
    const page = await b.get('/customers/cus_00000000c2');
    expect(page.body).toContain('12345676-4-42');
    const saved = await b.post('/customers/cus_00000000c2', formFields(page.body, '/customers/cus_00000000c2'));
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    const { updatedAt: _a, ...after } = e.app.getCustomer('cus_00000000c2');
    const { updatedAt: _b, ...expected } = before;
    expect(after).toEqual(expected);
  });

  it('the seller form keeps an address region set through MCP (and shows it only when there is one)', async () => {
    const e = await env();
    const b = await e.loggedIn();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    expect((await b.get('/settings')).body).not.toContain('name="region"');
    const seller = { ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, region: 'Pest' } };
    e.app.store.setSetting('seller', seller);
    const page = await b.get('/settings');
    const saved = await b.post('/settings/seller', formFields(page.body, '/settings/seller'));
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    expect(e.app.getSeller()).toEqual(seller);
  });
});

describe('issue confirmation is bound to what will be issued', () => {
  it('a confirmation shown before midnight does not issue with the next day’s date, and a seller change needs a new look', async () => {
    let clock = new Date('2026-10-27T22:55:00.000Z'); // 23:55 in Budapest
    const e = await env({ now: () => clock });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f4' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000f4');
    expect(page.body).toContain('(2026.10.27.) lesz');
    const stale = hiddenValue(page.body, 'confirmation') ?? '';
    clock = new Date('2026-10-27T23:05:00.000Z'); // 00:05 – the issue date would now be 10.28.
    const r = await b.follow(await b.post('/invoices/inv_00000000f4/issue', { confirmation: stale, confirm: 'yes' }));
    expect(r.body).toContain('A megerősítés lejárt, vagy a piszkozat időközben megváltozott.');
    expect(e.app.getInvoice('inv_00000000f4').status).toBe('draft');

    const fresh = hiddenValue((await b.get('/invoices/inv_00000000f4')).body, 'confirmation') ?? '';
    e.app.store.setSetting('seller', { ...SELLER_NORMAL, bankAccount: '11773016-11111018' });
    const changed = await b.follow(await b.post('/invoices/inv_00000000f4/issue', { confirmation: fresh, confirm: 'yes' }));
    expect(changed.body).toContain('A megerősítés lejárt, vagy a piszkozat időközben megváltozott.');
    expect(changed.body).toContain('Az eladó adatai a piszkozat mentése óta megváltoztak');
    expect(e.app.getInvoice('inv_00000000f4').status).toBe('draft');
  });
});

describe('double submits', () => {
  it('a payment form sent twice records the payment once', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000a1');
    const fields = { ...formFields(page.body, '/invoices/inv_00000000a1/payment'), amount: '50000' };
    const first = await b.post('/invoices/inv_00000000a1/payment', fields);
    const second = await b.post('/invoices/inv_00000000a1/payment', fields);
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(e.app.getInvoice('inv_00000000a1').paidAmount).toBe('50000');
    expect((await b.follow(second)).body).toContain('Ezt a befizetést már rögzítettük');
    // A new look at the page gives a new form: a second, deliberate payment is possible.
    const again = formFields((await b.get('/invoices/inv_00000000a1')).body, '/invoices/inv_00000000a1/payment');
    expect((await b.post('/invoices/inv_00000000a1/payment', { ...again, amount: '1000' })).status).toBe(303);
    expect(e.app.getInvoice('inv_00000000a1').paidAmount).toBe('51000');
  });
});

describe('responses', () => {
  function expectHardened(r: Res, what: string): void {
    expect(r.headers['x-content-type-options'], what).toBe('nosniff');
    expect(r.headers['cache-control'], what).toBe('no-store');
    expect(r.headers['x-frame-options'], what).toBe('DENY');
    expect(r.headers['referrer-policy'], what).toMatch(/^(same-origin|no-referrer)$/);
    if (String(r.headers['content-type']).startsWith('text/html')) {
      const csp = String(r.headers['content-security-policy']);
      expect(csp, what).toContain("default-src 'none'");
      expect(csp, what).toContain("frame-ancestors 'none'");
      expect(csp, what).not.toMatch(/unsafe-|https?:|\*/);
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
      const tags = r.body.match(/<(script|style)\b[^>]*>/gi) ?? [];
      expect(tags.length, what).toBeGreaterThan(0);
      for (const t of tags) expect(t, what).toContain(`nonce="${nonce}"`);
    }
  }

  it('every response – pages, errors, the login page, redirects, downloads – carries the security headers', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    const anon = e.browser();
    const b = await e.loggedIn();
    const responses: Array<[string, Res]> = [
      ['login page', await anon.get('/')],
      ['wrong token', await anon.get('/?token=nope')],
      ['login redirect', await e.browser().get(`/?token=${encodeURIComponent(TOKEN)}`)],
      ['page', await b.get('/invoices')],
      ['404', await b.get('/invoices/inv_ffffffffff')],
      ['unknown path', await b.get('/settings/nope')],
      ['405', await b.get('/invoices/inv_00000000a1/payment')],
      ['403 csrf', await b.post('/invoices/inv_00000000a1/payment', {}, { csrf: null })],
      // A loopback Origin on another port: http.ts refuses it, and the web UI would too – either way hardened.
      ['403 origin', await b.post('/invoices/inv_00000000a1/payment', {}, { headers: { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' } })],
      ['413', await b.post('/invoices/inv_00000000a1/payment', { x: 'y'.repeat(300 * 1024) })],
      ['415', await rawRequest(e.base, 'POST', '/invoices/inv_00000000a1/payment', { headers: { cookie: b.cookie ?? '', 'content-type': 'text/plain', origin: e.base }, body: 'x' })],
      ['405 method', await rawRequest(e.base, 'DELETE', '/invoices', { headers: { cookie: b.cookie ?? '' } })],
      ['post redirect', await b.post('/invoices/inv_00000000a1/payment', { amount: '1', date: '2026-10-27' })],
      ['export download', await b.post('/export', { from: '2026-10-01', to: '2026-10-31', format: 'csv' })],
    ];
    const nonces = new Set<string>();
    for (const [what, r] of responses) {
      expectHardened(r, what);
      const n = /'nonce-([^']+)'/.exec(String(r.headers['content-security-policy'] ?? ''))?.[1];
      if (n) {
        expect(nonces.has(n), `${what}: nonce reused`).toBe(false);
        nonces.add(n);
      }
    }
    expect(responses.find(([w]) => w === 'export download')?.[1].headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('logs unexpected failures to stderr with the path only – never the query, the token or the body', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    Object.assign(e.app, {
      findInvoices: () => {
        throw new Error('boom');
      },
    });
    const r = await b.get('/invoices?q=TITKOS-KERESES');
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('boom');
    const log = written.join('');
    expect(log).toContain('[openszamla web] GET /invoices: Error: boom');
    expect(log).not.toContain('TITKOS-KERESES');
    expect(log).not.toContain(TOKEN);
  });
});
