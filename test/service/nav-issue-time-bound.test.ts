/**
 * NAV-3: the NAV part of issuing is bounded (about 20 s end to end, a short timeout per request), it never waits
 * behind a running nav_sync, and a nav_sync stops contacting NAV after the first outage (circuit breaker) – so a
 * hanging NAV cannot keep an MCP call past the client's 60 s, where an error would read as "not issued". A
 * manageInvoice timeout stays uncertain: it is reconciled, never sent again blindly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

let nav: FakeNavServer;
let t: TestApp | null = null;

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await nav.stop();
});
afterEach(() => {
  t?.cleanup();
  t = null;
  nav.reset();
});

function setup(opts: { fetch?: typeof fetch } = {}): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date(), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function issueSimple(app: OpenSzamla, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ text: DOMESTIC_CUSTOMER_INPUT.name, limit: 1, offset: 0 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szoftverfejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

const calls = (operation: string): number => nav.requests.filter((r) => r.operation === operation).length;

describe('NAV-3: issuing is never held up by NAV', () => {
  it('NAV does not answer: the issue returns within the bound, issued and pending, and nav_sync reports it later', async () => {
    const app = setup();
    nav.failNext({ kind: 'TIMEOUT' }, { operation: 'tokenExchange' });
    const t0 = Date.now();
    const r = await issueSimple(app);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.invoice).toMatchObject({ status: 'issued', navStatus: 'pending' });
    expect(r.nav?.messages[0]).toMatchObject({ code: 'TIMEOUT', message: expect.stringMatching(/6000 ms alatt \(tokenExchange\)/) });
    expect(calls('manageInvoice')).toBe(0);
    expect((await app.navSync({ waitSeconds: 3 }))[0]?.navStatus).toBe('done');
    expect(calls('manageInvoice')).toBe(1);
  }, 30_000);

  it('a manageInvoice timeout when issuing stays uncertain: reconciled, never sent again blindly', async () => {
    const app = setup();
    nav.failNext({ kind: 'TIMEOUT' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('pending');
    expect(r.invoice.navMessages.map((m) => m.code)).toEqual(['TIMEOUT', 'OPENSZAMLA_UNCERTAIN']);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['sent']);
    const [again] = await app.navSync({ waitSeconds: 0 });
    expect(again?.note).toMatch(/bizonytalan.*5 perccel/);
    expect(calls('manageInvoice')).toBe(1);
  }, 30_000);

  it('issuing while a nav_sync runs does not wait for it: pending at once, and it is reported once, later', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    // The sync's first request hangs until the test lets it go.
    const app = setup({
      fetch: async (input, init) => {
        if (!held && String(input).endsWith('/tokenExchange')) {
          held = true;
          await gate;
        }
        return fetch(input, init);
      },
    });
    const waiting = await issueSimple(app, { submitToNav: false });
    const sync = app.navSync({ waitSeconds: 3 });
    const t0 = Date.now();
    const r = await issueSimple(app);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.invoice).toMatchObject({ status: 'issued', navStatus: 'pending' });
    expect(r.nav).toMatchObject({ navStatus: 'pending', note: 'Egy NAV-szinkron éppen fut, ezért a kiállítás nem várt rá: a számla NAV-jelentése függőben van (pending) – a következő nav_sync beküldi (futtasd: nav_sync).' });
    expect(r.notes).toContain(r.nav?.note);
    release();
    expect((await sync).map((x) => [x.number, x.navStatus])).toEqual([[waiting.invoice.number, 'done']]);
    expect((await app.navSync({ waitSeconds: 3 })).map((x) => [x.number, x.navStatus])).toEqual([[r.invoice.number, 'done']]);
    expect(calls('manageInvoice')).toBe(2);
  });

  it('a nav_sync stops after the first outage: the rest stays pending with one note, nothing more is sent', async () => {
    let attempts = 0;
    const app = setup({
      fetch: async (input, init) => {
        attempts++;
        // NAV out of reach: refused before anything was sent.
        if (String(input).includes('/invoiceService/')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
        return fetch(input, init);
      },
    });
    for (let i = 0; i < 4; i++) await issueSimple(app, { submitToNav: false });
    const res = await app.navSync({ waitSeconds: 0 });
    expect(attempts).toBe(1);
    expect(res.map((r) => r.navStatus)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(res[0]?.messages[0]?.code).toBe('NETWORK_ERROR');
    expect(new Set(res.slice(1).map((r) => r.note))).toEqual(
      new Set(['A NAV ebben a futásban nem érhető el (NETWORK_ERROR), ezért a program ennél a számlánál nem fordult a NAV-hoz – a számla állapota nem változott. Futtasd később újra a nav_sync-et.']),
    );
    expect(res.slice(1).every((r) => r.messages.length === 0)).toBe(true);
    // Nothing is recorded as a pause: the next run tries again.
    expect(app.store.getSetting('navPause')).toBeNull();
  });

  it('a quick "unavailable" answer (maintenance) stops the run after the invoice in hand', async () => {
    const app = setup();
    for (let i = 0; i < 3; i++) await issueSimple(app, { submitToNav: false });
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'manageInvoice', times: 10 });
    const res = await app.navSync({ waitSeconds: 0 });
    expect(calls('manageInvoice')).toBe(1);
    expect(res.map((r) => r.navStatus)).toEqual(['pending', 'pending', 'pending']);
    expect(res[2]?.note).toMatch(/^A NAV ebben a futásban nem érhető el \(MAINTENANCE_MODE\)/);
  });
});
