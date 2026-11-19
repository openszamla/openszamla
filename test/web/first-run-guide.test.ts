/**
 * The dashboard's first-run guide ("Első lépések"): seller, NAV connection (test first), first customer,
 * first invoice – each step's state from setup_status, the next open step as the page's primary action,
 * the nav-setup command for this data directory, and no duplicate of the service to-dos it explains.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { navSetupCommandLine, type AppConfig } from '../../src/service/config.ts';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertCustomer, insertDraft, insertIssued, scriptsHaveNonce, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  return e;
}

/** A usable NAV TEST connection (valid credential formats; nothing is sent in these tests). */
const esc = (s: string): string => s.replace(/"/g, '&quot;');

const NAV_TEST: AppConfig['nav'] = {
  environment: 'test',
  credentials: { login: 'GUIDELOGIN7f3a', password: 'guide-password-1', signingKey: 'GUIDE-SIGNING-KEY-55e0', exchangeKey: 'GUIDEEXCH-d00d42' },
  source: 'env',
  baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
};

/** The guide card's markup (empty when it is not on the page). */
function guideOf(body: string): string {
  const start = body.indexOf('aria-labelledby="h-guide"');
  return start < 0 ? '' : body.slice(start, body.indexOf('</section>', start));
}

/** The <li> of the n-th step (1-based) of the guide. */
function stepOf(guide: string, n: number): string {
  return guide.split('<li class="step').at(n) ?? '';
}

describe('first-run guide on the dashboard', () => {
  it('an empty data directory: four open steps, the seller step as the primary action, no new-invoice button yet', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const r = await b.get('/');
    expect(r.status).toBe(200);
    const guide = guideOf(r.body);
    expect(guide).toContain('<h2 id="h-guide">Első lépések</h2>');
    expect(guide).toContain('0 / 4 lépés kész');
    const [seller, nav, customer, invoice] = [1, 2, 3, 4].map((n) => stepOf(guide, n));
    expect(seller).toContain('Állítsd be az eladó adatait: név, adószám, cím, bankszámla és ÁFA-státusz.');
    expect(seller).toContain('teendő');
    expect(seller).toContain('<a class="btn btn-primary" href="/settings#h-seller">Eladó adatainak megadása</a>');
    expect(nav).toContain('NAV Online Számla kapcsolat – először a TESZT rendszerrel');
    expect(nav).toContain('technikai felhasználó');
    expect(nav).toContain('onlineszamla.nav.gov.hu');
    expect(nav).toContain(`<code class="cmd" id="guide-nav-cmd">${esc(navSetupCommandLine(e.app.config.dataDir))}</code>`);
    expect(nav).toContain(`<details class="cmd-alt"><summary>Ha az „openszamla” parancs nem található</summary>`);
    expect(nav).toContain(`npx -y ${esc(navSetupCommandLine(e.app.config.dataDir))}`);
    // The copy buttons are shown by the script only; the command stays selectable without it.
    expect(nav).toMatch(/<button class="btn btn-quiet" type="button" data-copy="guide-nav-cmd" hidden>/);
    expect(customer).toContain('<a class="btn" href="/customers?new=1#h-new">Első vevő felvétele</a>');
    expect(invoice).toContain('Előbb az eladó adatait add meg (1. lépés).');
    expect(invoice).not.toContain('href="/invoices/new"');
    expect(r.body).not.toContain('Új számla készítése');
    expect(scriptsHaveNonce(r)).toBe(true);
    expect(r.body).toContain("document.querySelectorAll('button[data-copy]')");
    // The service's two to-dos the guide explains in web terms are not repeated under "Teendők".
    expect(r.body).not.toContain('(seller_update)');
    expect(r.body).not.toContain('NAV Online Számla nincs beállítva: a kiállított számlákat');
  });

  it('seller and a customer given: those steps are done, the first invoice is the next step, the header offers a new invoice', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    const guide = guideOf((await b.get('/')).body);
    expect(guide).toContain('2 / 4 lépés kész');
    // The name ends with a period ("Kft."): it is not doubled.
    expect(stepOf(guide, 1)).toContain(`<p>Megadva: ${SELLER_NORMAL.name}</p>`);
    expect(stepOf(guide, 1)).toContain('kész');
    expect(stepOf(guide, 1)).not.toContain('class="btn');
    expect(stepOf(guide, 3)).toContain('Kész: 1 vevő elmentve.');
    // NAV is the next open step, but it is set up outside the web UI: the first step with a button is the primary one.
    expect(stepOf(guide, 2)).toContain(' next"');
    expect(stepOf(guide, 4)).toContain('<a class="btn btn-primary" href="/invoices/new">Első számla elkészítése</a>');
    const page = (await b.get('/')).body;
    expect(page).toMatch(/<a class="btn" href="\/invoices\/new"><svg[^>]*>.*?<\/svg>Új számla készítése<\/a>/);
  });

  it('a draft but nothing issued yet: the last step opens the drafts', async () => {
    const e = await env({ nav: NAV_TEST });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const guide = guideOf((await b.get('/')).body);
    expect(guide).toContain('Már van 1 piszkozatod');
    expect(guide).toContain('<a class="btn" href="/invoices?status=draft">Piszkozatok megnyitása</a>');
  });

  it('NAV in the TEST environment counts as done, with the command for production; everything done: no guide, a primary new-invoice button', async () => {
    const e = await env({ nav: NAV_TEST });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const b = await e.loggedIn();
    const guide = guideOf((await b.get('/')).body);
    expect(stepOf(guide, 2)).toContain('Beállítva: TESZT környezet');
    expect(stepOf(guide, 2)).toContain(esc(navSetupCommandLine(e.app.config.dataDir, 'production')));

    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    insertIssued(e.app, INVOICE_DOMESTIC);
    const done = await b.get('/');
    expect(guideOf(done.body)).toBe('');
    expect(done.body).toMatch(/<a class="btn btn-primary" href="\/invoices\/new"><svg[^>]*>.*?<\/svg>Új számla készítése<\/a>/);
  });

  it('unusable NAV settings: the NAV step is to be fixed, names the problem and the command', async () => {
    const nav = NAV_TEST as NonNullable<AppConfig['nav']>;
    const e = await env({ nav: { ...nav, credentials: { ...nav.credentials, exchangeKey: 'SHORT-KEY' } } });
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const b = await e.loggedIn();
    const r = await b.get('/');
    const step = stepOf(guideOf(r.body), 2);
    expect(step).toContain('javítandó');
    expect(step).toContain('A NAV-kapcsolat beállítása hibás, ezért a program egyetlen számlát sem tud jelenteni: A NAV technikai felhasználó adatai hibásak');
    expect(step).toContain(esc(navSetupCommandLine(e.app.config.dataDir)));
    expect(r.body).not.toContain('SHORT-KEY');
    // The service's "beállítás hibás" to-do is explained by the guide, not repeated.
    expect(r.body).not.toContain('Javítsd: openszamla nav-setup');
  });

  it('seller data with an error: the seller step is to be fixed, and the service to-do naming sellerIssues is not shown', async () => {
    const e = await env();
    e.app.store.setSetting('seller', { ...SELLER_NORMAL, taxNumber: '' });
    const b = await e.loggedIn();
    const r = await b.get('/');
    const step = stepOf(guideOf(r.body), 1);
    expect(step).toContain('javítandó');
    expect(step).toMatch(/Az eladói adatok között \d+ hibát javítani kell a számlázás előtt\./);
    expect(step).toContain('<a class="btn btn-primary" href="/settings#h-seller">Eladói adatok javítása</a>');
    expect(r.body).not.toContain('(sellerIssues)');
  });

  it('the "Első vevő felvétele" link opens the new-customer form without JavaScript', async () => {
    const e = await env();
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    expect((await b.get('/customers')).body).toContain('<details><summary id="h-new"><h2>Új vevő felvétele</h2></summary>');
    expect((await b.get('/customers?new=1')).body).toContain('<details open><summary id="h-new"><h2>Új vevő felvétele</h2></summary>');
  });
});
