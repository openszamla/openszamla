/**
 * What issuing and a storno say, in web words. U2: without a NAV connection the result is a warning with the way to the
 * NAV setup – no "FIGYELEM" note with commands, no MCP tool names –, and a moved issue date is given in Hungarian
 * dates. U8: in the TEST environment the issue and storno buttons name the test system. The known item "correction
 * waiting for the other system's original": a correction of an original that is not reported to the configured NAV
 * system (e.g. only to TEST) is not promised to go to NAV at issue, and its page has no NAV button that could not send
 * it, only why it waits and a link to the original.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, hiddenValue, insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

const CREDENTIALS = { login: 'WAITLOGIN7f3a', password: 'wait-password-1', signingKey: 'WAIT-SIGNING-KEY-55e0', exchangeKey: 'WAITEXCHd00d42ab' };
const nav = (environment: 'test' | 'production'): AppConfig['nav'] => ({ environment, credentials: CREDENTIALS, source: 'env', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' });

function navPartOf(body: string): string {
  const start = body.indexOf('<section class="card" aria-labelledby="h-nav">');
  return start < 0 ? '' : body.slice(start, body.indexOf('</section>', start));
}

function headOf(body: string): string {
  const start = body.indexOf('<div class="page-head">');
  return body.slice(start, body.indexOf('<section', start));
}

describe('U2: the result of issuing without NAV', () => {
  it('a warning with the way to the NAV setup, the moved dates in Hungarian, no agent words', async () => {
    let now = new Date('2026-10-20T09:00:00.000Z');
    const e = await startWeb({ now: () => now });
    envs.push(e);
    e.app.updateSeller(SELLER_INPUT);
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const d = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    now = new Date('2026-10-27T09:00:00.000Z');
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${d.invoice.id}`)).body;
    // The preview says the same in Hungarian dates.
    expect(page).toContain('A piszkozat kelte 2026.10.20.; kiállításkor a kelte a kiállítás napja (2026.10.27.) lesz, a fizetési határidő ugyanennyivel eltolódik: 2026.10.28. → 2026.11.04.');
    expect(page).not.toContain('2026-10-20');
    const r = await b.follow(await b.post(`/invoices/${d.invoice.id}/issue`, { confirmation: hiddenValue(page, 'confirmation') ?? '', confirm: 'yes' }));
    expect(r.body).toContain('<div class="flash flash-warn" role="status">');
    expect(flashesOf(r.body)).toContain('Kiállítva: SZ-2026-00001');
    expect(r.body).toContain('<li>A kelte a kiállítás napja (2026.10.27.) lett; a fizetési határidő ehhez igazodott: 2026.11.04.</li>');
    expect(r.body).toContain('Ez a bizonylat még nincs jelentve a NAV-nak, mert nincs beállítva a NAV-kapcsolat – a törvény szerint azonnal jelenteni kell.');
    expect(r.body).toContain('<a href="/#guide-nav">NAV-kapcsolat beállítása</a>');
    const flash = r.body.slice(r.body.indexOf('<div class="flash'), r.body.indexOf('</div></div>', r.body.indexOf('<div class="flash')));
    for (const w of ['FIGYELEM', 'nav_sync', 'nav-setup', 'npx', '2026-10-27']) expect(flash, w).not.toContain(w);
  });
});

describe('U8: the TEST system is named on the buttons', () => {
  it('issue and storno', async () => {
    const e = await startWeb({ nav: nav('test') });
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const d = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const b = await e.loggedIn();
    expect((await b.get(`/invoices/${d.invoice.id}`)).body).toContain('Számla kiállítása és beküldése a NAV TESZT rendszerébe</button>');
    await b.get('/invoices/inv_00000000a1');
    const preview = (await b.post('/invoices/inv_00000000a1/cancel-preview', { reason: 'Hibás összeg' })).body;
    expect(preview).toContain('Sztornó számla kiállítása és beküldése a NAV TESZT rendszerébe</button>');
  });
});

describe('a correction of an original only in the other NAV system', () => {
  it('production: the storno preview does not promise a report, the button says final; the storno page links the original instead of a NAV button', async () => {
    const e = await startWeb({ nav: nav('production') });
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    const b = await e.loggedIn();
    await b.get('/invoices/inv_00000000a1');
    const preview = (await b.post('/invoices/inv_00000000a1/cancel-preview', { reason: 'Hibás összeg' })).body;
    expect(preview).toContain('<li>A sztornó számla most nem kerül a NAV-hoz: az eredeti számla (SZ-2026-00001) csak a NAV TESZT rendszerében van, az éles rendszerbe nincs jelentve. A program az eredeti éles beküldése után küldi be.</li>');
    expect(preview).toContain('Sztornó számla kiállítása (végleges)</button>');
    expect(preview).not.toContain('beküldése a NAV-nak</button>');

    // The storno, issued: no NAV button and no shortcut to one, the reason and the original instead.
    insertIssued(e.app, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'production' });
    const page = (await b.get('/invoices/inv_00000000a4')).body;
    const navPart = navPartOf(page);
    expect(navPart).toContain('Ez a sztornó számla az eredeti számlára vár: a(z) SZ-2026-00001 csak a NAV TESZT rendszerében van, az éles rendszerbe nincs jelentve');
    expect(navPart).toContain('<a href="/invoices/inv_00000000a1">Az eredeti számla (SZ-2026-00001) megnyitása</a>');
    expect(navPart).not.toContain('action="/invoices/inv_00000000a4/nav-sync"');
    expect(headOf(page)).not.toContain('href="#h-nav"');
    for (const w of ['nav_send_to_configured_environment', 'nav_sync', 'invoice_get']) expect(page, w).not.toContain(w);
  });

  it('a rejected original: the waiting storno says to fix and resend the original, without a button of its own', async () => {
    const e = await startWeb({ nav: nav('test') });
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'aborted', navEnvironment: 'test' });
    insertIssued(e.app, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'test' });
    const b = await e.loggedIn();
    const navPart = navPartOf((await b.get('/invoices/inv_00000000a4')).body);
    expect(navPart).toContain('Ez a sztornó számla az eredeti számlára vár: a(z) SZ-2026-00001 NAV-jelentését a NAV elutasította, vagy hibával zárult. Nyisd meg az eredeti számlát, hárítsd el a hiba okát, és küldd újra');
    expect(navPart).not.toContain('/nav-sync"');
  });
});
