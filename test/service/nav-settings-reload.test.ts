/**
 * WEB-1: a running program (MCP server, `openszamla serve`) picks up what `openszamla nav-setup` saves to
 * <dataDir>/nav-credentials.json – no restart. The file is read again when it changes, with the start-up precedence
 * (OPENSZAMLA_NAV_LOGIN … win, OPENSZAMLA_NAV_ENV overrides the environment); NAV settings fixed by the caller
 * (overrides.nav) are never replaced; a half-written or broken file is a navProblem, never an error – above all not
 * while issuing. The web UI's mask follows the new credentials. NAV is the fake server (fetch redirected).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { NAV_BASE_URLS } from '../../src/nav/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { NAV_CREDENTIALS_FILE } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';
import { FAKE_NAV_CREDENTIALS, FakeNavServer } from '../helpers/fake-nav.ts';
import { Browser, TOKEN } from '../web/helpers.ts';

let nav: FakeNavServer;
const cleanups: Array<() => unknown> = [];

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await nav.stop();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  nav.reset();
});

/** NAV test API calls go to the fake server – the file cannot name another endpoint, and tests never touch the network. */
const toFake: typeof fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(NAV_BASE_URLS.test)) throw new TypeError(`unexpected request: ${url}`);
  return fetch(nav.url + url.slice(NAV_BASE_URLS.test.length), init);
};

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-reload-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Opened the way `openszamla mcp` / `serve` open it: settings from the data directory and the environment. */
function openDir(dir: string, env: Record<string, string> = {}): OpenSzamla {
  const app = OpenSzamla.open({ dataDir: dir, env, fetch: toFake, now: () => new Date() });
  cleanups.push(() => app.close());
  return app;
}

/** What `openszamla nav-setup` writes. */
function saveCredentials(dir: string, over: Record<string, unknown> = {}): void {
  const { login, password, signingKey, exchangeKey } = FAKE_NAV_CREDENTIALS;
  writeFileSync(join(dir, NAV_CREDENTIALS_FILE), JSON.stringify({ environment: 'test', login, password, signingKey, exchangeKey, ...over }, null, 2));
}

async function issueSimple(app: OpenSzamla) {
  const customer = app.findCustomers({ text: DOMESTIC_CUSTOMER_INPUT.name, limit: 1, offset: 0 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '10000', vatCode: '27' }] });
  return app.issue(view.invoice.id);
}

describe('WEB-1: NAV settings saved while the program runs take effect at once', () => {
  it('nav-setup after start: setup_status shows the connection, nav_sync reports what was issued before, issuing reports at once', async () => {
    const dir = dataDir();
    const app = openDir(dir);
    app.updateSeller(SELLER_INPUT);
    const before = await issueSimple(app);
    expect(before.invoice.navStatus).toBe('not_configured');
    expect(app.status().nav).toMatchObject({ configured: false, environment: null, source: null });

    saveCredentials(dir);
    expect(app.status().nav).toMatchObject({ configured: true, environment: 'test', source: 'file', problem: null });
    expect(app.status().nextSteps.join('\n')).not.toMatch(/nincs beállítva/);
    const sync = await app.navSync({ waitSeconds: 3 });
    expect(sync.map((r) => [r.number, r.navStatus])).toEqual([[before.invoice.number, 'done']]);
    const after = await issueSimple(app);
    expect(after.invoice.navStatus).toBe('done');
    expect(nav.invoices.map((i) => i.invoiceNumber)).toEqual([before.invoice.number, after.invoice.number]);
  });

  it('a wrong setting fixed while running, and a half-written file: a problem until complete, never an error when issuing', async () => {
    const dir = dataDir();
    saveCredentials(dir, { exchangeKey: FAKE_NAV_CREDENTIALS.exchangeKey.slice(0, 15) });
    const app = openDir(dir);
    app.updateSeller(SELLER_INPUT);
    expect(app.status().nav.problem).toBe('A NAV technikai felhasználó adatai hibásak: az XML cserekulcs nem 16 karakteres.');

    // A save cut short (or caught half-way): a problem, and issuing still succeeds.
    writeFileSync(join(dir, NAV_CREDENTIALS_FILE), '{"environment": "test", "login": "fakeus');
    expect(app.status().nav).toMatchObject({ configured: false, source: 'file', problem: expect.stringMatching(/nem érvényes JSON/) });
    const r = await issueSimple(app);
    expect(r.invoice).toMatchObject({ status: 'issued', navStatus: 'not_configured' });
    expect(r.notes.join(' ')).toMatch(/beállítása hibás.*nem érvényes JSON.*nav-setup --data-dir/);
    await expect(app.navSync()).rejects.toMatchObject({ code: 'NAV_INVALID_CONFIG' });

    saveCredentials(dir);
    expect(app.status().nav).toMatchObject({ configured: true, problem: null });
    expect((await app.navSync({ waitSeconds: 3 })).map((x) => x.navStatus)).toEqual(['done']);
  });

  it('keeps the precedence: OPENSZAMLA_NAV_ENV overrides the saved environment, OPENSZAMLA_NAV_LOGIN … win over the file', async () => {
    const dir = dataDir();
    const overridden = openDir(dir, { OPENSZAMLA_NAV_ENV: 'production' });
    saveCredentials(dir, { environment: 'test' });
    expect(overridden.config.nav).toMatchObject({ environment: 'production', source: 'file' });

    const fromEnv = openDir(dataDir(), { OPENSZAMLA_NAV_LOGIN: 'envlogin2026', OPENSZAMLA_NAV_PASSWORD: 'pw', OPENSZAMLA_NAV_SIGNING_KEY: 'sign', OPENSZAMLA_NAV_EXCHANGE_KEY: 'cserekulcs123456' });
    saveCredentials(fromEnv.config.dataDir);
    expect(fromEnv.config.nav).toMatchObject({ source: 'env', credentials: { login: 'envlogin2026' } });
  });

  it('an unknown OPENSZAMLA_NAV_ENV, harmless while there was no file, becomes a problem – it is never thrown', async () => {
    const dir = dataDir();
    const app = openDir(dir, { OPENSZAMLA_NAV_ENV: 'staging' });
    app.updateSeller(SELLER_INPUT);
    expect(app.status().nav.configured).toBe(false);
    saveCredentials(dir);
    expect(app.status().nav).toMatchObject({ configured: false, problem: 'Ismeretlen NAV környezet: staging' });
    expect((await issueSimple(app)).invoice.navStatus).toBe('not_configured');
  });

  it('NAV settings fixed by the caller (overrides.nav – the fake NAV of the tests) are never replaced by the file', () => {
    const t = makeTestApp({ nav: nav.runtimeConfig() });
    cleanups.push(() => t.cleanup());
    saveCredentials(t.dir, { environment: 'production' });
    expect(t.app.config.nav).toMatchObject({ environment: 'test', baseUrl: nav.url });
  });

  it('the web UI follows the saved settings, and masks the new credentials on every page', async () => {
    const dir = dataDir();
    const app = openDir(dir);
    app.updateSeller(SELLER_INPUT);
    const secret = 'Uj-Jelszo#2026-from-nav-setup';
    // A secret that ended up in stored data (e.g. pasted into a customer note) must never be rendered.
    app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, note: `jelszó: ${secret}` });
    const http = await startHttpServer(app, { port: 0, token: TOKEN });
    cleanups.push(() => http.close());
    const b = new Browser(http.url);
    await b.login();
    // The badge text follows the icon that marks its tone (an inline SVG).
    const badge = async (): Promise<string> => /<h2 id="h-nav">NAV Online Számla<\/h2><p><span class="badge [^"]*">(?:<svg[\s\S]*?<\/svg>)?([^<]*)/.exec((await b.get('/')).body)?.[1] ?? '?';
    expect(await badge()).toBe('nincs beállítva');

    saveCredentials(dir, { password: secret });
    expect(await badge()).toBe('TESZT környezet');
    const customers = await b.get('/customers');
    const id = /href="\/customers\/(cus_[0-9a-f]+)"/.exec(customers.body)?.[1];
    const page = await b.get(`/customers/${id}`);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(secret);
    expect(page.body).toContain('jelszó: [rejtett]');
  });
});
