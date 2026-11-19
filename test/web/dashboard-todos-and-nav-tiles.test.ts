/**
 * The dashboard words the service's to-dos itself (status().todos) – Hungarian texts with the link or button that does
 * them, never an MCP tool or field name, and no note about tool names. Invoices issued without a NAV connection are
 * counted in a neutral tile that leads to the NAV setup step; "NAV-probléma" (red) counts only the rejected and failed
 * reports, and the NAV filters select the configured NAV system's documents; the other system's ones have a tile and a
 * filter of their own. The send button is offered only when it can send something. A first run shows only the guide and
 * the seller / NAV cards; the tables show 5 documents.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

const CREDENTIALS = { login: 'DASHLOGIN7f3a', password: 'dash-password-1', signingKey: 'DASH-SIGNING-KEY-55e0', exchangeKey: 'DASHEXCHd00d42ab' };
const nav = (environment: 'test' | 'production'): AppConfig['nav'] => ({ environment, credentials: CREDENTIALS, source: 'env', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' });

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

/** MCP tool and parameter names that must never reach a web user. */
const AGENT_WORDS = ['nav_sync', 'invoice_list', 'invoice_get', 'nav_send_to_configured_environment', 'resubmitFailed', 'seller_update', 'sellerIssues', 'OPENSZAMLA_NAV_ENV', 'navMessages', 'eszközneveket'];

/** What a user reads on the page: the text without tags, attributes, scripts and styles. */
function visibleText(body: string): string {
  return body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}

function statOf(body: string, label: string): string {
  const end = body.indexOf(`<span class="k">${label}</span>`);
  if (end < 0) return '';
  return body.slice(body.lastIndexOf('<a class="stat', end), end);
}

function stepsOf(body: string): string {
  const start = body.indexOf('aria-labelledby="h-steps"');
  return start < 0 ? '' : body.slice(start, body.indexOf('</section>', start));
}

describe('NAV not set up, invoices issued', () => {
  it('a neutral tile leads to the NAV setup step; NAV-probléma stays 0; the to-do in web words', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'not_configured' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', navStatus: 'not_configured' });
    const b = await e.loggedIn();
    const body = (await b.get('/')).body;
    const waiting = statOf(body, 'NAV-ra vár – a kapcsolat még nincs beállítva');
    expect(waiting).toContain('<a class="stat" href="#guide-nav"><span class="v">2</span>');
    expect(statOf(body, 'NAV-probléma')).toContain('<a class="stat" href="/invoices?nav=problem"><span class="v">0</span>');
    expect(body).toMatch(/<li class="step[^"]*" id="guide-nav">/);
    const steps = stepsOf(body);
    expect(steps).toContain('2 kiállított számla még nincs jelentve a NAV-nak, mert nincs NAV-kapcsolat. A beállítás után (Első lépések, 2. lépés) a „Függő számlák beküldése a NAV-nak” gomb mindet beküldi.');
    expect(steps).toContain('<a href="#guide-nav">NAV-kapcsolat beállítása…</a>');
    for (const w of AGENT_WORDS) expect(visibleText(body), w).not.toContain(w);
  });
});

describe('a usable NAV connection', () => {
  it('TEST: a rejected report is the only red problem; rejected and pending to-dos link to the list and the send button', async () => {
    const e = await env({ nav: nav('test') });
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'aborted', navEnvironment: 'test' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', navStatus: 'pending', navEnvironment: 'test' });
    const b = await e.loggedIn();
    const body = (await b.get('/')).body;
    expect(statOf(body, 'NAV-probléma')).toContain('<a class="stat err" href="/invoices?nav=problem"><span class="v">1</span>');
    expect(body).not.toContain('NAV-ra vár');
    const steps = stepsOf(body);
    expect(steps).toContain('1 számla jelentését a NAV elutasította, vagy végleges hibával zárult: nyisd meg, olvasd el a NAV üzenetét, hárítsd el az okát, majd a számla oldalán küldd újra. <a href="/invoices?nav=problem">NAV-problémás számlák</a>');
    expect(steps).toContain('1 számla jelentésre vár: küldd be a „Függő számlák beküldése a NAV-nak” gombbal. <a href="#h-nav">Függő számlák beküldése a NAV-nak…</a>');
    expect(body).toContain('action="/nav-sync"');
    for (const w of AGENT_WORDS) expect(visibleText(body), w).not.toContain(w);
    // The problem filter: rejected and failed reports only.
    const list = (await b.get('/invoices?nav=problem')).body;
    expect(list).toContain('href="/invoices/inv_00000000a1"');
    expect(list).not.toContain('href="/invoices/inv_00000000b1"');
  });

  it('issued before the setup: a warning tile to the list, the to-do says the button sends them, the button is there', async () => {
    const e = await env({ nav: nav('test') });
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'not_configured' });
    const b = await e.loggedIn();
    const body = (await b.get('/')).body;
    expect(statOf(body, 'NAV-ra vár – a kapcsolat beállítása előtt kiállítva')).toContain('<a class="stat warn" href="/invoices?nav=not_configured"><span class="v">1</span>');
    expect(stepsOf(body)).toContain('1 kiállított számla még nincs jelentve a NAV-nak, mert kiállításakor nem volt használható NAV-kapcsolat: a „Függő számlák beküldése a NAV-nak” gomb mindet beküldi.');
    expect(body).toContain('action="/nav-sync"');
  });

  it('production, an invoice only in TEST and its storno waiting: the other system has a tile and a filter, no send button, the held storno apart', async () => {
    const e = await env({ nav: nav('production') });
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    insertIssued(e.app, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'production' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b2', number: 'SZ-2026-00011', navStatus: 'aborted', navEnvironment: 'test' });
    const b = await e.loggedIn();
    const body = (await b.get('/')).body;
    expect(statOf(body, 'csak a TESZT rendszerben jelentve')).toContain('<a class="stat warn" href="/invoices?nav=other"><span class="v">2</span>');
    // The rejection in TEST is not a problem of production.
    expect(statOf(body, 'NAV-probléma')).toContain('<span class="v">0</span>');
    expect(body).not.toContain('action="/nav-sync"');
    expect(body).toContain('2 számla csak a NAV TESZT rendszerébe került – az éles rendszerbe nincs jelentve. A számla oldalán olvasható, hogyan küldheted be.');
    const steps = stepsOf(body);
    // The numbers never break at their hyphens.
    expect(steps).toContain('2 számla csak a NAV TESZT rendszerébe került, az éles rendszerbe nincs jelentve (<span class="nowrap">SZ-2026-00001</span>, <span class="nowrap">SZ-2026-00011</span>).');
    expect(steps).toContain('1 sztornó/módosító számla az eredeti számla éles beküldésére vár');
    for (const w of AGENT_WORDS) expect(visibleText(body), w).not.toContain(w);
    // The filter of the other system, and its badge in the list naming the system.
    const other = (await b.get('/invoices?nav=other')).body;
    expect(other).toContain('href="/invoices/inv_00000000a1"');
    expect(other).toContain('href="/invoices/inv_00000000b2"');
    expect(other).not.toContain('href="/invoices/inv_00000000a4"');
    expect(other).toContain('title="Az éles rendszerbe nincs jelentve"');
    expect(other).toContain('NAV (TESZT): rendben</span>');
    expect((await b.get('/invoices?nav=problem')).body).not.toContain('href="/invoices/inv_00000000b2"');
  });
});

describe('the result of "Függő számlák beküldése a NAV-nak"', () => {
  it('names the button to press again, in web words', async () => {
    const e = await env({ nav: nav('test') });
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'pending', navEnvironment: 'test' });
    const b = await e.loggedIn();
    await b.get('/');
    // No time at all for the run: it contacts NAV no more, and says what to do.
    const real = e.app.navSync.bind(e.app);
    e.app.navSync = (opts = {}, actor) => real({ ...opts, budgetMs: 1 }, actor);
    const page = await b.follow(await b.post('/nav-sync', {}));
    expect(page.body).toContain('1 számlához ez a futás nem fordult a NAV-hoz (lásd a megjegyzéseket) – később kattints újra a „Függő számlák beküldése a NAV-nak” gombra.');
    expect(page.body).toContain('SZ-2026-00001: függő – A rendelkezésre álló idő letelt');
    for (const w of AGENT_WORDS) expect(visibleText(page.body), w).not.toContain(w);
  });
});

describe('the parts of the dashboard', () => {
  it('a first run shows the guide and the seller / NAV cards only; with documents the tables show 5 and link to all', async () => {
    const e = await startWeb();
    envs.push(e);
    const b = await e.loggedIn();
    const first = (await b.get('/')).body;
    expect(first).toContain('aria-labelledby="h-guide"');
    expect(first).toContain('aria-labelledby="h-nav"');
    for (const part of ['class="stats"', 'h-month', 'h-recv', 'h-latest', 'h-overdue']) expect(first, part).not.toContain(part);

    e.app.store.setSetting('seller', SELLER_NORMAL);
    for (let i = 0; i < 7; i++) {
      insertIssued(e.app, INVOICE_DOMESTIC, { id: `inv_00000000c${i}`, number: `SZ-2026-0002${i}`, navStatus: 'not_configured', dueDate: '2026-10-01', issueDate: '2026-09-20', fulfillmentDate: '2026-09-20' });
    }
    const full = (await b.get('/')).body;
    expect(full).toContain('class="stats"');
    const latest = full.slice(full.indexOf('aria-labelledby="h-latest"'));
    expect(latest.match(/<tr>/g)?.length).toBe(1 + 5);
    expect(latest).toContain('<a href="/invoices">Mind a(z) 7 bizonylat</a>');
    expect(full).toContain('<a href="/invoices?overdue=1">Mind a(z) 7 lejárt számla</a>');
  });
});
