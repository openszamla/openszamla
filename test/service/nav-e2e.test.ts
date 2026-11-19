/**
 * Service ↔ NAV end-to-end: the real OpenSzamla service (store, calc, XML builder, NAV client) against
 * the fake NAV server, which verifies signatures exactly like NAV and validates every invoiceData
 * against the official XSD.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice } from '../../src/core/types.ts';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { navSetupCommandLine, type AppConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FAKE_NAV_SOFTWARE, FakeNavServer } from '../helpers/fake-nav.ts';

let nav: FakeNavServer;
let t: TestApp | null = null;
/** NAV's clock while a test moves time (clock()): the same clock – time passes for NAV too; otherwise the real one. */
let navNow: (() => Date) | null = null;

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0, now: () => (navNow ? navNow() : new Date()) });
});
afterAll(async () => {
  await nav.stop();
});
afterEach(() => {
  t?.cleanup();
  t = null;
  nav.reset();
  nav.setReceivedPolls(0);
  navNow = null;
});

function setup(opts: { now?: () => Date; fetch?: typeof fetch; nav?: AppConfig['nav'] } = {}): OpenSzamla {
  t = makeTestApp({ nav: opts.nav === undefined ? nav.runtimeConfig() : opts.nav, now: opts.now ?? (() => new Date()), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  return app;
}

/** A clock the test moves forward (NAV's reconciliation waits 5 minutes after an unclear submission); NAV's clock follows it. */
function clock(): { now: () => Date; advanceMinutes(m: number): void } {
  let at = Date.now();
  navNow = () => new Date(at);
  return {
    now: () => new Date(at),
    advanceMinutes(m: number) {
      at += m * 60_000;
    },
  };
}

/** Reports `inv` to the fake NAV directly – another program, the NAV web form, or an attempt whose answer was lost. */
async function reportElsewhere(inv: Invoice): Promise<void> {
  const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  const { transactionId } = await client.manageInvoice([{ index: 1, operation: navOperationFor(inv), invoiceDataBase64: Buffer.from(buildInvoiceDataXml(inv), 'utf8').toString('base64') }]);
  expect((await client.queryTransactionStatus(transactionId)).results[0]?.invoiceStatus).toBe('DONE');
}

const operations = (): string[] => nav.invoices.map((i) => `${i.operation} ${i.invoiceStatus}`);
const manageCalls = (): number => nav.requests.filter((r) => r.operation === 'manageInvoice').length;

async function issueSimple(app: OpenSzamla, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({
    customerId: customer.id,
    lines: [
      { description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' },
      { description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '2000', vatCode: '5' },
    ],
  });
  expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return app.issue(view.invoice.id, opts);
}

describe('NAV end-to-end through the service', () => {
  it('issues and reports an invoice (CREATE → DONE)', async () => {
    const app = setup();
    const r = await issueSimple(app);
    expect(r.invoice.number).toBe(`SZ-${new Date().getFullYear()}-00001`);
    expect(r.nav?.navStatus, JSON.stringify(r.nav)).toBe('done');
    expect(r.invoice.navStatus).toBe('done');
    expect(r.invoice.navTransactionId).toBeTruthy();
    expect(nav.invoices).toHaveLength(1);
    expect(nav.invoices[0]?.operation).toBe('CREATE');
    expect(nav.invoices[0]?.invoiceNumber).toBe(r.invoice.number);
    expect(nav.invoices[0]?.invoiceStatus).toBe('DONE');
    const subs = app.store.listNavSubmissions(r.invoice.id);
    expect(subs.at(-1)?.status).toBe('done');
  });

  it('reports a storno after its original, and a modification', async () => {
    const app = setup();
    const original = await issueSimple(app);
    expect(original.invoice.navStatus).toBe('done');
    const corr = await app.createCorrectionDraft(original.invoice.id, {
      lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }],
      comment: 'Utólagos árengedmény',
    });
    const mod = await app.issue(corr.invoice.id);
    expect(mod.invoice.navStatus, JSON.stringify(mod.invoice.navMessages)).toBe('done');
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus, JSON.stringify(storno.invoice.navMessages)).toBe('done');
    expect(nav.invoices.map((i) => i.operation)).toEqual(['CREATE', 'MODIFY', 'STORNO']);
    // Storno negates original + modification: lines continue the chain numbering (2 + 1 → 4, 5, 6).
    expect(storno.invoice.lines.map((l) => l.modificationRef?.lineNumberReference)).toEqual([4, 5, 6]);
    expect(storno.invoice.totals.grossAmount).toBe('-182000');
  });

  it('keeps an invoice pending on NAV maintenance and reports it with nav_sync later', async () => {
    const app = setup();
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.status).toBe('issued');
    expect(r.invoice.navStatus).toBe('pending');
    expect(r.invoice.navMessages[0]?.code).toBeTruthy();
    const sync = await app.navSync({ waitSeconds: 10 });
    expect(sync.find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
  });

  it('marks a permanent error and resubmits after the cause is fixed', async () => {
    const app = setup();
    nav.failNext({ kind: 'INVALID_REQUEST_SIGNATURE' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('error');
    expect(JSON.stringify(r.invoice.navMessages)).not.toContain(nav.credentials.signingKey);
    // A plain sync leaves permanent errors alone (they need a fix first) …
    const plain = await app.navSync({ waitSeconds: 5 });
    expect(plain.find((s) => s.invoiceId === r.invoice.id)).toBeUndefined();
    expect(app.getInvoice(r.invoice.id).navStatus).toBe('error');
    const again = await app.navSync({ resubmitFailed: true, waitSeconds: 10 });
    expect(again.find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
  });

  it('surfaces NAV business validation errors (ABORTED)', async () => {
    const app = setup();
    nav.addBusinessMessage(`SZ-${new Date().getFullYear()}-00001`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('aborted');
    expect(r.invoice.navMessages.some((m) => m.code === 'INCORRECT_TEST_DATA')).toBe(true);
  });

  it('waits for the original before reporting its correction – and sends it in the run that sees the original accepted (NAV-11)', async () => {
    const app = setup();
    nav.setReceivedPolls(1000);
    const original = await issueSimple(app);
    expect(original.invoice.navStatus).toBe('processing');
    const storno = await app.cancel(original.invoice.id, { reason: 'Teszt' });
    expect(storno.invoice.navStatus).toBe('pending');
    expect(storno.nav?.note).toMatch(/eredeti/);
    expect(nav.invoices.map((i) => i.operation)).toEqual(['CREATE']);
    nav.setReceivedPolls(0);
    const sync = await app.navSync({ waitSeconds: 10 });
    expect(sync.map((s) => s.navStatus)).toEqual(['done', 'done']);
    expect(nav.invoices.map((i) => i.operation)).toEqual(['CREATE', 'STORNO']);
    expect(await app.navSync({ waitSeconds: 10 })).toEqual([]);
  });

  it('looks up a taxpayer and saves it as a customer', async () => {
    const app = setup();
    const r = await app.lookupTaxpayer('87654323', { saveAsCustomer: true });
    expect(r.taxpayer?.name).toContain('Árvíztűrő');
    expect(r.customer?.vatStatus).toBe('DOMESTIC');
    expect(r.customer?.taxNumber).toBe('87654323-2-13');
    const missing = await app.lookupTaxpayer('22222222');
    expect(missing.taxpayer).toBeNull();
  });

  it('does not report proformas and reports nothing without credentials', async () => {
    const app = setup();
    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const pro = await app.createDraft({ documentType: 'proforma', customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unitPrice: '100000', vatCode: '27' }] });
    const issued = await app.issue(pro.invoice.id);
    expect(issued.invoice.number).toMatch(/^DB-/);
    expect(issued.invoice.navStatus).toBe('not_applicable');
    expect(nav.invoices).toHaveLength(0);
  });
});

const NOT_UNIQUE = { severity: 'ERROR' as const, code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.' };

describe('NAV: overlapping runs never send an invoice twice (BIZ-1)', () => {
  it('two nav_sync runs at the same time send it once, and it ends done', async () => {
    const app = setup();
    const r = await issueSimple(app, { submitToNav: false });
    const runs = await Promise.all([app.navSync({ waitSeconds: 5 }), app.navSync({ waitSeconds: 5 })]);
    expect(operations()).toEqual(['CREATE DONE']);
    expect(app.getInvoice(r.invoice.id).navStatus).toBe('done');
    expect(runs.flat().filter((x) => x.invoiceId === r.invoice.id).map((x) => x.navStatus)).toEqual(['done']);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['done']);
  });

  it('issuing with automatic reporting while a nav_sync runs sends it once (issuing does not wait for the sync, NAV-3)', async () => {
    const app = setup();
    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const draft = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const [issued] = await Promise.all([app.issue(draft.invoice.id), app.navSync({ waitSeconds: 5 })]);
    expect(operations()).toEqual(['CREATE DONE']);
    expect(issued.nav).toMatchObject({ navStatus: 'pending', note: expect.stringMatching(/NAV-szinkron éppen fut.*nav_sync/) });
    expect(app.getInvoice(issued.invoice.id).navStatus).toBe('done');
  });

  it('a second process on the same database does not send it again (the claim is a database transaction)', async () => {
    const app = setup();
    const r = await issueSimple(app, { submitToNav: false });
    const other = OpenSzamla.open({ config: app.config, now: () => new Date() });
    try {
      await Promise.all([app.navSync({ waitSeconds: 5 }), other.navSync({ waitSeconds: 5 })]);
    } finally {
      other.close();
    }
    expect(operations()).toEqual(['CREATE DONE']);
    expect(app.getInvoice(r.invoice.id).navStatus).toBe('done');
  });

  it('an accepted invoice stored as a rejected duplicate (older version) becomes done from its own accepted submission', async () => {
    const app = setup();
    const r = await issueSimple(app);
    app.store.patchInvoice(r.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    const sync = await app.navSync({ waitSeconds: 5 });
    expect(sync.find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
    expect(app.getInvoice(r.invoice.id).navTransactionId).toBe(r.invoice.navTransactionId);
    expect(manageCalls()).toBe(1);
    expect(nav.requests.some((q) => q.operation === 'queryInvoiceCheck')).toBe(false);
    expect(app.auditLog({ entityId: r.invoice.id }).items.map((e) => e.action)).toContain('nav.reconcile');
  });
});

describe('NAV: a submission with an unknown outcome is reconciled, never sent blindly again (BIZ-4)', () => {
  it('lost answer: NAV got it – after 5 minutes the transaction list shows it, and nothing is sent again', async () => {
    const c = clock();
    const app = setup({ now: c.now });
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.status).toBe('issued');
    expect(r.invoice.navStatus).toBe('pending');
    expect(r.invoice.navMessages.map((m) => m.code)).toEqual(['NETWORK_ERROR', 'OPENSZAMLA_UNCERTAIN']);
    expect(r.nav?.note).toMatch(/bizonytalan/);
    expect(operations()).toEqual(['CREATE DONE']);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['sent']);

    // NAV's procedure: wait 5 minutes before looking – in the meantime nothing is sent.
    const early = await app.navSync({ waitSeconds: 0 });
    expect(early.find((s) => s.invoiceId === r.invoice.id)?.note).toMatch(/5 perc/);
    expect(manageCalls()).toBe(1);

    c.advanceMinutes(6);
    const later = await app.navSync({ waitSeconds: 5 });
    const res = later.find((s) => s.invoiceId === r.invoice.id);
    expect(res?.navStatus, JSON.stringify(res)).toBe('done');
    expect(manageCalls()).toBe(1);
    expect(nav.requests.map((q) => q.operation)).toContain('queryTransactionList');
    const txId = nav.invoices[0]?.transactionId;
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => [s.status, s.transactionId])).toEqual([['done', txId]]);
    expect(app.getInvoice(r.invoice.id).navTransactionId).toBe(txId);
    expect(app.auditLog({ entityId: r.invoice.id }).items.map((e) => e.action)).toContain('nav.reconcile');

    // The chain goes on: the storno is reported after the reconciled original.
    const storno = await app.cancel(r.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE DONE', 'STORNO DONE']);
  });

  it('unreadable HTTP 200 answer: reconciled the same way, no second CREATE', async () => {
    const c = clock();
    const app = setup({ now: c.now });
    nav.failNext({ kind: 'GARBLED_RESPONSE' }, { operation: 'manageInvoice' });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('pending');
    expect(r.invoice.navMessages[0]).toMatchObject({ severity: 'WARN', code: 'INVALID_RESPONSE' });
    c.advanceMinutes(6);
    expect((await app.navSync({ waitSeconds: 5 })).find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE DONE']);
    expect(manageCalls()).toBe(1);
  });

  it('the request never reached NAV: after 5 minutes it is sent again, once', async () => {
    const c = clock();
    let drop = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (drop && String(input).endsWith('/manageInvoice')) {
        drop = false;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return fetch(input, init);
    };
    const app = setup({ now: c.now, fetch: fetchImpl });
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('pending');
    expect(nav.invoices).toHaveLength(0);
    c.advanceMinutes(6);
    const sync = await app.navSync({ waitSeconds: 5 });
    expect(sync.find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE DONE']);
    const subs = app.store.listNavSubmissions(r.invoice.id);
    expect(subs.map((s) => s.status)).toEqual(['error', 'done']);
    expect(subs[0]?.messages.map((m) => m.code)).toContain('OPENSZAMLA_NOT_RECEIVED');
  });

  it('a crash in the middle of sending: the attempt left "sending" is reconciled before anything is sent', async () => {
    const c = clock();
    const app = setup({ now: c.now });
    const r = await issueSimple(app, { submitToNav: false });
    // The crashed run had recorded its attempt, and NAV had received the request.
    const invoiceDataBase64 = Buffer.from(buildInvoiceDataXml(r.invoice), 'utf8').toString('base64');
    app.store.insertNavSubmission({ invoiceId: r.invoice.id, operation: 'CREATE', environment: 'test', requestId: '', transactionId: null, status: 'sending', invoiceDataBase64, messages: [], lastResponseXml: null });
    await reportElsewhere(r.invoice);
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.note).toMatch(/éppen beküldi/);
    c.advanceMinutes(4);
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.note).toMatch(/5 perc/);
    c.advanceMinutes(4);
    expect((await app.navSync({ waitSeconds: 5 }))[0]?.navStatus).toBe('done');
    expect(manageCalls()).toBe(1);
    expect(operations()).toEqual(['CREATE DONE']);
  });
});

describe('NAV: a rejected original and its corrections (BIZ-2)', () => {
  it('a genuinely rejected original holds its storno up with the real remedy, and the storno follows once it is fixed', async () => {
    const app = setup();
    nav.addBusinessMessage(`SZ-${new Date().getFullYear()}-00001`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    const original = await issueSimple(app);
    expect(original.invoice.navStatus).toBe('aborted');
    expect(original.nav?.note).toMatch(/resubmitFailed/);
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus).toBe('pending');
    expect(storno.nav?.note).toMatch(/elutasítva/);
    expect(storno.nav?.note).toContain(`nav_sync { invoice: "${original.invoice.number}", resubmitFailed: true }`);
    expect(app.navWaitReason(storno.invoice.id)).toMatch(/elutasítva/);
    const steps = app.status().nextSteps.join('\n');
    expect(steps).toMatch(/1 módosító\/sztornó számla nem jelenthető/);
    expect(steps).not.toMatch(/folyamatban|függőben/);
    const plain = await app.navSync({ waitSeconds: 2 });
    expect(plain.find((s) => s.invoiceId === storno.invoice.id)?.note).toMatch(/elutasítva/);
    expect(operations()).toEqual(['CREATE ABORTED']);

    nav.clearBusinessMessages(); // the cause is fixed
    expect((await app.navSync({ invoiceId: original.invoice.id, resubmitFailed: true, waitSeconds: 5 }))[0]?.navStatus).toBe('done');
    expect((await app.navSync({ waitSeconds: 5 })).find((s) => s.invoiceId === storno.invoice.id)?.navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE ABORTED', 'CREATE DONE', 'STORNO DONE']);
  });

  it('an original NAV already has comes back as a duplicate: NAV\'s data of the number (queryInvoiceData) reconciles it, and its modification goes out', async () => {
    const app = setup();
    const original = await issueSimple(app, { submitToNav: false });
    await reportElsewhere(original.invoice); // e.g. an earlier attempt whose answer was lost, or a manual entry at NAV
    const sync = await app.navSync({ waitSeconds: 5 });
    const res = sync.find((s) => s.invoiceId === original.invoice.id);
    expect(res?.navStatus, JSON.stringify(res)).toBe('done');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_RECONCILED']);
    expect(nav.requests.map((q) => q.operation)).toContain('queryInvoiceData');
    expect(app.auditLog({ entityId: original.invoice.id }).items.map((e) => e.action)).toContain('nav.reconcile');
    const corr = await app.createCorrectionDraft(original.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }] });
    const mod = await app.issue(corr.invoice.id);
    expect(mod.invoice.navStatus, JSON.stringify(mod.invoice.navMessages)).toBe('done');
    expect(operations()).toEqual(['CREATE DONE', 'CREATE ABORTED', 'MODIFY DONE']);
  });

  it('a duplicate NAV does not hold any more stays aborted, with an accurate explanation instead of "no action needed"', async () => {
    const app = setup();
    const r = await issueSimple(app, { submitToNav: false });
    app.store.patchInvoice(r.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    const sync = await app.navSync({ waitSeconds: 2 });
    expect(sync.find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('aborted');
    const hint = app.getInvoice(r.invoice.id).navMessages.find((m) => m.code === 'OPENSZAMLA_HINT')?.message ?? '';
    expect(hint).toMatch(/nincs érvényes számla a NAV-nál/);
    expect(hint).not.toMatch(/nincs további teendő/);
    expect(manageCalls()).toBe(0);
    // resubmitFailed sends it again then
    expect((await app.navSync({ resubmitFailed: true, waitSeconds: 5 })).find((s) => s.invoiceId === r.invoice.id)?.navStatus).toBe('done');
  });

  it('a correction is not held up by an original an older version left "aborted" as a duplicate', async () => {
    const app = setup();
    const original = await issueSimple(app);
    app.store.patchInvoice(original.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus, JSON.stringify(storno.nav)).toBe('done');
    expect(app.getInvoice(original.invoice.id).navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE DONE', 'STORNO DONE']);
  });
});

describe('NAV: the environment is in every result (MCP-UX-5)', () => {
  it('test environment: the result, its note and the notes say that nothing was reported for real', async () => {
    const app = setup();
    const r = await issueSimple(app);
    expect(r.nav?.environment).toBe('test');
    expect(r.nav?.note).toMatch(/TESZT rendszere befogadta – éles adatszolgáltatás NEM történt/);
    expect(r.notes.join(' ')).toMatch(/TESZT környezet/);
    expect((await app.navSync({ invoiceId: r.invoice.id }))[0]?.environment).toBe('test');
    expect(app.status().nextSteps.join(' ')).toMatch(/TESZT környezetre mutat.*éles adatszolgáltatás NEM történik/);
  });

  it('production environment: no test warning', async () => {
    const app = setup({ nav: { ...nav.runtimeConfig(), environment: 'production' } });
    const r = await issueSimple(app);
    expect(r.nav).toMatchObject({ environment: 'production', navStatus: 'done', note: 'A NAV sikeresen befogadta.' });
    expect(r.notes.join(' ')).not.toMatch(/TESZT/);
  });
});

describe('NAV settings checked when loaded; issuing never fails after numbering (BIZ-5, MCP-UX-10)', () => {
  it('unusable credentials: status shows the problem, issuing and cancelling succeed and say what to do', async () => {
    const config = nav.runtimeConfig();
    const app = setup({ nav: { ...config, credentials: { ...config.credentials, exchangeKey: 'FAKEEXCHANGEK3Y' } } });
    const status = app.status();
    expect(status.nav).toMatchObject({ configured: false, environment: 'test', problem: expect.stringMatching(/cserekulcs nem 16 karakteres/) });
    expect(status.nextSteps.join(' ')).toMatch(/beállítása hibás/);
    expect(JSON.stringify(status)).not.toContain('FAKEEXCHANGEK3Y');
    const r = await issueSimple(app);
    expect(r.invoice).toMatchObject({ status: 'issued', number: `SZ-${new Date().getFullYear()}-00001`, navStatus: 'not_configured' });
    expect(r.nav).toBeNull();
    expect(r.notes.join(' ')).toMatch(/beállítása hibás.*cserekulcs/);
    await expect(app.navSync()).rejects.toMatchObject({ code: 'NAV_INVALID_CONFIG' });
    const storno = await app.cancel(r.invoice.id, { reason: 'Teszt' });
    expect(storno.invoice.status).toBe('issued');
    expect(app.getInvoice(r.invoice.id).status).toBe('cancelled');
    expect(nav.requests).toHaveLength(0);
  });

  it('a NAV failure after the invoice got its number is reported in the result, never thrown', async () => {
    const app = setup();
    vi.spyOn(app, 'navSync').mockRejectedValue(new AppError('NAV_BOOM', 'Váratlan hiba a NAV-beküldésben.', { hint: 'Próbáld újra.' }));
    const r = await issueSimple(app);
    expect(r.invoice).toMatchObject({ status: 'issued', navStatus: 'pending' });
    expect(r.notes.join(' ')).toMatch(/A számla kiállítva, de a NAV-beküldés nem indult el: Váratlan hiba a NAV-beküldésben\. Próbáld újra\./);
  });

  it('the setup hints name the data directory this program reads (MCP-UX-10)', async () => {
    const app = setup({ nav: null });
    const cmd = navSetupCommandLine(app.config.dataDir);
    expect(app.status().nextSteps.join(' ')).toContain(cmd);
    await expect(app.navSync()).rejects.toMatchObject({ code: 'NAV_NOT_CONFIGURED', hint: expect.stringContaining(cmd) });
    const r = await issueSimple(app);
    expect(r.notes.join(' ')).toContain(cmd);
  });
});
