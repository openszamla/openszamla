/**
 * The NAV part of the invoice page for an invoice whose NAV state belongs to the other NAV system (e.g. reported only to
 * the TEST one while the program reports to production): the web UI never sends it there, so it offers no NAV button and
 * no NAV jump link, and says in plain words how it can be sent – only with the user's explicit confirmation, through the
 * AI client (nav_send_to_configured_environment) or the command line (openszamla nav-send-to-configured-environment …
 * --confirm, the service's own command line). The dashboard's to-do hint says the same. The per-invoice NAV button of an
 * invoice of this system runs with the time limit of the dashboard sync (60 s).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavRunOptions } from '../../src/service/app.ts';
import { navSendCommandLine, navSetupCommandLine, type AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { flashesOf, insertIssued, scriptsHaveNonce, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (envs.length > 0) await envs.pop()?.close();
});

const CREDENTIALS = { login: 'OTHERSYS7f3a', password: 'other-system-pw-1', signingKey: 'OTHER-SIGNING-KEY-55e0', exchangeKey: 'OTHEREXCH-d00d42' };
const PRODUCTION: AppConfig['nav'] = { environment: 'production', credentials: CREDENTIALS, source: 'env', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' };
const TEST: AppConfig['nav'] = { ...PRODUCTION, environment: 'test' } as AppConfig['nav'];

async function env(nav: AppConfig['nav']): Promise<WebEnv> {
  const e = await startWeb({ nav });
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

/** The page head (title, badges, key facts and the action links). */
function headOf(body: string): string {
  const start = body.indexOf('<div class="page-head">');
  return body.slice(start, body.indexOf('<section', start));
}

/** The NAV part of the invoice page. */
function navPartOf(body: string): string {
  const start = body.indexOf('<section class="card" aria-labelledby="h-nav">');
  return body.slice(start, body.indexOf('</section>', start));
}

describe('an invoice of the other NAV system on the invoice page', () => {
  it('production, reported only to TEST: no NAV button or shortcut, the two ways with confirmation, the CLI command to copy', async () => {
    const e = await env(PRODUCTION);
    const inv = insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000e1', number: 'SZ-2026-00031', navStatus: 'done', navEnvironment: 'test' });
    expect(e.app.navEnvironmentNote(inv)).not.toBeNull();
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000e1');
    const nav = navPartOf(page.body);
    expect(nav).toContain('Ez a számla a NAV <strong>TESZT</strong> rendszerébe került (ott az állapota: rendben), az éles rendszerbe nincs jelentve');
    expect(nav).toContain('A webes felület ilyen számlát nem küld be az éles rendszerbe: az valódi adatszolgáltatás a NAV felé, és nem vonható vissza, ezért csak kifejezett megerősítéssel történhet.');
    expect(nav).toContain('<strong>Az AI-asszisztensben</strong>');
    expect(nav).not.toContain('nav_send_to_configured_environment');
    const command = navSendCommandLine('SZ-2026-00031', e.app.config.dataDir);
    expect(nav).toContain(`<code class="cmd" id="nav-send-cmd">${command.replace(/"/g, '&quot;')}</code>`);
    expect(nav).toContain('data-copy="nav-send-cmd" hidden>');
    // No button that would only return the "not sent" note, and the head offers no NAV shortcut either.
    expect(nav).not.toContain('action="/invoices/inv_00000000e1/nav-sync"');
    expect(nav).not.toContain('NAV-állapot ellenőrzése');
    const head = headOf(page.body);
    expect(head).not.toContain('href="#h-nav"');
    expect(head).toContain('csak a TESZT rendszerben</span>');
    // The copy button's script comes with the page's nonce.
    expect(page.body).toContain('button[data-copy]');
    expect(scriptsHaveNonce(page)).toBe(true);
  });

  it('TEST, reported to production: nothing to do here, never sent to TEST; the production nav-setup command', async () => {
    const e = await env(TEST);
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000e2', number: 'SZ-2026-00032', navStatus: 'done', navEnvironment: 'production' });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000e2');
    const nav = navPartOf(page.body);
    expect(nav).toContain('Ez a számla az <strong>éles</strong> NAV-rendszerbe került (ott az állapota: rendben). A program most a NAV TESZT rendszerét használja: itt nincs vele teendő, és a webes felület a tesztrendszerbe sem küldi be.');
    expect(nav).toContain(navSetupCommandLine(e.app.config.dataDir, 'production').replace(/"/g, '&quot;'));
    expect(nav).not.toContain('action="/invoices/inv_00000000e2/nav-sync"');
    expect(headOf(page.body)).toContain('az éles rendszerben</span>');
  });

  it('an invoice of this NAV system keeps its NAV button, which runs with the 60 s time limit of the dashboard sync', async () => {
    const e = await env(TEST);
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000e3', number: 'SZ-2026-00033', navStatus: 'pending' });
    const real = e.app.navSync.bind(e.app);
    const limits: Array<number | undefined> = [];
    vi.spyOn(e.app, 'navSync').mockImplementation((opts: NavRunOptions = {}, actor) => {
      limits.push(opts.budgetMs);
      // No time left: the run contacts NAV no more (the fake address would not answer anyway).
      return real({ ...opts, budgetMs: 1 }, actor);
    });
    const b = await e.loggedIn();
    const page = await b.get('/invoices/inv_00000000e3');
    expect(navPartOf(page.body)).toContain('action="/invoices/inv_00000000e3/nav-sync"');
    expect(navPartOf(page.body)).toContain('Számla beküldése a NAV-nak</button>');
    expect(headOf(page.body)).toContain('href="#h-nav"');
    const done = await b.follow(await b.post('/invoices/inv_00000000e3/nav-sync', {}));
    expect(limits).toEqual([60_000]);
    expect(flashesOf(done.body)).toContain('A rendelkezésre álló idő letelt, mielőtt a program ennél a számlánál a NAV-hoz fordult volna');
  });

  it('the dashboard: a to-do about invoices of the other NAV system says the web UI does not send them, in web words', async () => {
    const e = await env(PRODUCTION);
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000e4', number: 'SZ-2026-00034', navStatus: 'done', navEnvironment: 'test' });
    const b = await e.loggedIn();
    const page = (await b.get('/')).body;
    expect(page).not.toContain('nav_send_to_configured_environment');
    expect(page).toContain('1 számla csak a NAV TESZT rendszerébe került, az éles rendszerbe nincs jelentve (<span class="nowrap">SZ-2026-00034</span>). Ha valamelyik valódi számla, a számla oldalán olvasható, hogyan küldheted be – a webes felület (a „Függő számlák beküldése a NAV-nak” gomb sem) nem teszi meg helyetted.');
    // No send button for them, and no meta note about tool names.
    expect(page).not.toContain('action="/nav-sync"');
    expect(page).not.toContain('eszközneveket');
  });
});
