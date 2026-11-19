/**
 * NAV-2: reconciling a submission with an unknown outcome can always finish. Every page of the transaction
 * list is searched, other technical users' transactions are skipped, and when the list cannot be searched
 * the invoice number is looked up directly (queryInvoiceData with the NAV-1 comparison). A permanent NAV
 * error (no query permission …) is a configuration problem with its remedy – in the note, the messages,
 * navProblems and nextSteps –, never "try later". The 5-minute rule stays, and nothing uncertain is sent
 * again without reconciliation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FAKE_NAV_SOFTWARE, FakeNavServer } from '../helpers/fake-nav.ts';

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

/** The program's clock and NAV's: time passes for both. */
function clock(): { now: () => Date; advanceMinutes(m: number): void } {
  let at = Date.now();
  const now = (): Date => new Date(at);
  nav.setNow(now);
  return {
    now,
    advanceMinutes(m: number) {
      at += m * 60_000;
    },
  };
}

/** The first manageInvoice dies after connecting (ECONNRESET): NAV never got it (the fake does not see it), the outcome is uncertain. */
function resetOnce(): typeof fetch {
  let drop = true;
  return async (input, init) => {
    if (drop && String(input).endsWith('/manageInvoice')) {
      drop = false;
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    }
    return fetch(input, init);
  };
}

function setup(opts: { now: () => Date; fetch?: typeof fetch }): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: opts.now, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function issueSimple(app: OpenSzamla) {
  const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return app.issue(view.invoice.id);
}

const manageCalls = (): number => nav.requests.filter((r) => r.operation === 'manageInvoice').length;
const lookups = (): number => nav.requests.filter((r) => r.operation === 'queryTransactionStatus' && r.requestXml.includes('<returnOriginalRequest>true</returnOriginalRequest>')).length;
const FORBIDDEN = { kind: 'GENERAL_ERROR' as const, errorCode: 'FORBIDDEN', httpStatus: 403, message: 'Nincs jogosultság a lekérdezéshez.' };

describe('NAV-2: an uncertain submission is always settled', () => {
  it('no query permission (FORBIDDEN): a configuration problem with its remedy, never "later"; after the fix it is reconciled and sent once', async () => {
    const c = clock();
    const app = setup({ now: c.now, fetch: resetOnce() });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('pending');
    nav.failNext(FORBIDDEN, { operation: 'queryTransactionList', times: 1 });
    nav.failNext(FORBIDDEN, { operation: 'queryInvoiceData', times: 1 });
    c.advanceMinutes(6);
    const res = (await app.navSync({ waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('error');
    expect(res?.note).toMatch(/nincs lekérdezési jogosultsága.*„Számlák lekérdezése”/);
    expect(res?.note).not.toMatch(/később/);
    expect(res?.messages.map((m) => m.code)).toEqual(['NETWORK_ERROR', 'OPENSZAMLA_UNCERTAIN', 'FORBIDDEN', 'OPENSZAMLA_RECONCILE_BLOCKED']);
    expect(manageCalls()).toBe(0);
    const status = app.status();
    expect(status.counts).toMatchObject({ navPending: 0, navProblems: 1 });
    const steps = status.nextSteps.join('\n');
    expect(steps).toMatch(/1 számla NAV-jelentését a program nem tudja egyeztetni a NAV-val.*nincs lekérdezési jogosultsága/);
    expect(steps).not.toMatch(/függőben/);

    // Later plain runs do not ask again (nothing changes until someone fixes the permission) …
    c.advanceMinutes(60);
    expect(await app.navSync({ waitSeconds: 1 })).toEqual([]);
    // … and after the fix the explicit resubmission reconciles first: NAV never got it, so it is sent – once.
    const fixed = (await app.navSync({ resubmitFailed: true, waitSeconds: 3 }))[0];
    expect(fixed?.navStatus).toBe('done');
    expect(manageCalls()).toBe(1);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['error', 'done']);
  });

  it('every page is searched and other technical users are skipped: 150 transactions of a webshop and 101 unknown own ones do not block it', async () => {
    const c = clock();
    const app = setup({ now: c.now, fetch: resetOnce() });
    const r = await issueSimple(app);
    nav.addTransactions(150, { user: 'webshopuser1', prefix: 'WEB-' });
    nav.addTransactions(101, { user: nav.credentials.login, prefix: 'MASIK-' });
    c.advanceMinutes(6);
    const res = (await app.navSync({ waitSeconds: 3 }))[0];
    expect(res?.navStatus, JSON.stringify(res)).toBe('done');
    expect(lookups()).toBe(101); // the webshop's transactions are not looked into
    expect(nav.requests.filter((q) => q.operation === 'queryTransactionList').length).toBe(3); // 251 transactions, 100 per page
    expect(manageCalls()).toBe(1);
    expect(app.store.listNavSubmissions(r.invoice.id)[0]?.messages.map((m) => m.code)).toContain('OPENSZAMLA_NOT_RECEIVED');
  });

  it('the list cannot be searched, but NAV holds the invoice under its number: settled without sending it again', async () => {
    const c = clock();
    const app = setup({ now: c.now });
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('pending');
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    c.advanceMinutes(6);
    const res = (await app.navSync({ waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('done');
    expect(res?.note).toMatch(/a NAV-nál a számla szerepel \(azonos adattartalommal\), ezért nem küldtük újra/);
    expect(manageCalls()).toBe(1);
    const txId = nav.invoices[0]?.transactionId;
    expect(app.getInvoice(r.invoice.id).navTransactionId).toBe(txId);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => [s.status, s.transactionId])).toEqual([['done', txId]]);
  });

  it('the list cannot be searched and NAV does not hold the number: nothing is sent, a later run settles it', async () => {
    const c = clock();
    const app = setup({ now: c.now, fetch: resetOnce() });
    const r = await issueSimple(app);
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    c.advanceMinutes(6);
    const res = (await app.navSync({ waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('pending');
    expect(res?.note).toMatch(/most nem sikerült.*később/);
    expect(manageCalls()).toBe(0);
    expect((await app.navSync({ waitSeconds: 3 }))[0]?.navStatus).toBe('done');
    expect(manageCalls()).toBe(1);
    expect(app.getInvoice(r.invoice.id).navStatus).toBe('done');
  });

  it('the list cannot be searched and NAV holds ANOTHER invoice under the number: a number collision, nothing is sent', async () => {
    const c = clock();
    const app = setup({ now: c.now, fetch: resetOnce() });
    const r = await issueSimple(app);
    // Meanwhile another installation reported its own invoice with this number.
    const other = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
    const foreign = { ...r.invoice, lines: r.invoice.lines.map((l) => ({ ...l, description: 'Más számla' })), totals: { ...r.invoice.totals, netAmountHuf: '1000', vatAmountHuf: '270', grossAmountHuf: '1270' } };
    await other.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(buildInvoiceDataXml(foreign)).toString('base64') }]);
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    c.advanceMinutes(6);
    const res = (await app.navSync({ waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('aborted');
    expect(res?.note).toMatch(/Sorszám-ütközés.*nettó összeg \(HUF\)/);
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_NUMBER_COLLISION']);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['error']);
    expect(manageCalls()).toBe(1); // only the other installation's
    expect(app.status().nextSteps.join('\n')).toMatch(/1 számla sorszáma a NAV-nál egy másik számláé/);
  });
});
