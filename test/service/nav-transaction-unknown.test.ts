/**
 * "processing" is not a dead end. NAV accepted a submission for processing, and later has no result for its transaction
 * (queryTransactionStatus comes back without one): NAV does not know it any more – an emptied NAV test system, a changed
 * technical user or tax number. Every sync used to answer "még feldolgozza" for ever, a resend included. Now, 5 minutes
 * after the attempt, what NAV holds under the invoice number decides: nothing – the attempt is closed and the invoice is
 * sent again; this invoice (reported another way) – done; another invoice – a number collision. Within the 5 minutes
 * nothing changes, and neither while NAV cannot be asked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FAKE_NAV_SOFTWARE, FakeNavServer } from '../helpers/fake-nav.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The program and NAV on one clock the test moves. NAV keeps a submission "in processing" until told otherwise. */
async function setup(): Promise<{ app: OpenSzamla; nav: FakeNavServer; t: TestApp; waitMinutes(m: number): void }> {
  let at = Date.now();
  const now = (): Date => new Date(at);
  const nav = await FakeNavServer.start({ receivedPolls: 1000, now });
  const t = makeTestApp({ nav: nav.runtimeConfig(), now });
  cleanups.push(async () => {
    t.cleanup();
    await nav.stop();
  });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, nav, t, waitMinutes: (m) => (at += m * 60_000) };
}

async function issueOne(app: OpenSzamla): Promise<Invoice> {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const draft = await app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  // Sent by a sync that does not wait for the result (issuing would wait for NAV for seconds).
  const issued = await app.issue(draft.invoice.id, { submitToNav: false });
  await app.navSync({ waitSeconds: 0 });
  const inv = app.getInvoice(issued.invoice.id);
  expect(inv.navStatus).toBe('processing');
  return inv;
}

/** NAV forgets everything (an emptied test system), and from now on processes at once. */
function forget(nav: FakeNavServer): void {
  nav.reset();
  nav.setReceivedPolls(0);
}

const codes = (inv: Invoice): string[] => inv.navMessages.map((m) => m.code);

describe('a transaction NAV does not know any more', () => {
  it('nothing at NAV under the number: after 5 minutes the attempt is closed, the invoice is pending and the next sync sends it', async () => {
    const { app, nav, waitMinutes } = await setup();
    const inv = await issueOne(app);
    const lostTransaction = inv.navTransactionId;
    forget(nav);

    // Within 5 minutes of the attempt: a fresh transaction may not show yet – nothing changes.
    waitMinutes(2);
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.navStatus).toBe('processing');
    expect(app.store.listNavSubmissions(inv.id).map((s) => s.status)).toEqual(['processing']);

    waitMinutes(4);
    const [settled] = await app.navSync({ waitSeconds: 0 });
    expect(settled?.navStatus).toBe('pending');
    expect(settled?.note).toBe('A NAV TESZT rendszere nem ismeri a korábbi beküldés tranzakcióját, és ezzel a sorszámmal sincs nála számla: a következő nav_sync újra beküldi.');
    const pending = app.getInvoice(inv.id);
    expect(codes(pending)).toEqual(['OPENSZAMLA_TRANSACTION_UNKNOWN', 'OPENSZAMLA_HINT']);
    expect(pending.navMessages[0]?.message).toContain(`nem ismeri ennek a beküldésnek a tranzakcióját (${lostTransaction})`);
    expect(pending.navTransactionId).toBeNull();
    expect(app.store.listNavSubmissions(inv.id).map((s) => s.status)).toEqual(['error']);
    expect(app.auditLog({ entityId: inv.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ via: 'queryInvoiceData', match: 'none', unknownTransaction: lostTransaction });

    // The next sync sends it again: reported.
    const [resent] = await app.navSync({ waitSeconds: 3 });
    expect(resent?.navStatus).toBe('done');
    expect(nav.invoices.map((i) => `${i.operation}:${i.invoiceNumber}:${i.invoiceStatus}`)).toEqual([`CREATE:${inv.number}:DONE`]);
    expect(app.store.listNavSubmissions(inv.id).map((s) => s.status)).toEqual(['error', 'done']);
  });

  it('NAV holds this invoice under another transaction: reported – nothing is sent again', async () => {
    const { app, nav, waitMinutes } = await setup();
    const inv = await issueOne(app);
    forget(nav);
    // The same data reached NAV another way (e.g. another installation sent it).
    const other = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
    const sent = await other.manageInvoice([{ index: 1, operation: navOperationFor(inv), invoiceDataBase64: Buffer.from(buildInvoiceDataXml(inv), 'utf8').toString('base64') }]);
    waitMinutes(6);
    const [res] = await app.navSync({ waitSeconds: 0 });
    expect(res?.navStatus).toBe('done');
    expect(app.getInvoice(inv.id).navTransactionId).toBe(sent.transactionId);
    expect(nav.requests.filter((q) => q.operation === 'manageInvoice')).toHaveLength(1); // the other installation's only
    expect(app.auditLog({ entityId: inv.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ match: 'same', unknownTransaction: inv.navTransactionId });
  });

  it('NAV cannot be asked about the number now: the invoice stays in processing, a later sync settles it', async () => {
    const { app, nav, waitMinutes } = await setup();
    const inv = await issueOne(app);
    forget(nav);
    waitMinutes(6);
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryInvoiceData' });
    await app.navSync({ waitSeconds: 0 });
    expect(app.getInvoice(inv.id).navStatus).toBe('processing');
    expect(app.store.listNavSubmissions(inv.id).map((s) => s.status)).toEqual(['processing']);
    waitMinutes(30);
    await app.navSync({ waitSeconds: 0 });
    expect(app.getInvoice(inv.id).navStatus).toBe('pending');
  });
});
