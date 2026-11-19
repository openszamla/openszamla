/**
 * NAV-11: a modification/storno issued while its original is still being processed is sent in the very run that
 * sees the original accepted (after it, as NAV requires), and polled within the remaining wait. Every returned note
 * is built from the final state: a correction never says "a NAV még feldolgozza" once its original is done.
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
  nav.setReceivedPolls(0);
});

function setup(): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date() });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function issueSimple(app: OpenSzamla, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ text: DOMESTIC_CUSTOMER_INPUT.name, limit: 1, offset: 0 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

const operations = (): string[] => nav.invoices.map((i) => `${i.operation} ${i.invoiceStatus}`);

describe('NAV-11: a correction follows its original in the same run', () => {
  it('a plain nav_sync that sees the original accepted sends the waiting storno too, with notes of the final state', async () => {
    const app = setup();
    nav.setReceivedPolls(2);
    const original = await issueSimple(app, { submitToNav: false });
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.navStatus).toBe('processing');
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla', submitToNav: false });
    expect(app.navWaitReason(storno.invoice.id)).toMatch(/a NAV még feldolgozza/);

    const res = await app.navSync({ waitSeconds: 10 });
    expect(res.map((r) => [r.number, r.navStatus, r.note])).toEqual([
      [original.invoice.number, 'done', 'A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.'],
      [storno.invoice.number, 'done', 'A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.'],
    ]);
    expect(operations()).toEqual(['CREATE DONE', 'STORNO DONE']);
    expect(await app.navSync({ waitSeconds: 1 })).toEqual([]);
  });

  it('a storno issued right after its original: the submission when issuing waits for the original and sends the storno', async () => {
    const app = setup();
    nav.setReceivedPolls(1000);
    const original = await issueSimple(app);
    expect(original.invoice.navStatus).toBe('processing');
    nav.setReceivedPolls(0);
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus).toBe('done');
    expect(storno.nav?.note).toBe('A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.');
    expect(app.getInvoice(original.invoice.id).navStatus).toBe('done');
    expect(operations()).toEqual(['CREATE DONE', 'STORNO DONE']);
  });

  it('a correction that still waits says why from the final state: the original still in processing, or rejected meanwhile', async () => {
    const app = setup();
    nav.setReceivedPolls(1000);
    const original = await issueSimple(app);
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla', submitToNav: false });
    const still = await app.navSync({ waitSeconds: 0 });
    expect(still.find((r) => r.invoiceId === storno.invoice.id)?.note).toBe(
      `Várakozik: az eredeti számlát (${original.invoice.number}) a NAV még feldolgozza; utána ez is beküldésre kerül (nav_sync).`,
    );

    // The original is rejected while the run polls it: the storno's note is not the stale "még feldolgozza".
    const second = await issueSimple(app, { submitToNav: false });
    nav.addBusinessMessage(second.invoice.number as string, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    nav.setReceivedPolls(1);
    expect((await app.navSync({ invoiceId: second.invoice.id, waitSeconds: 0 }))[0]?.navStatus).toBe('processing');
    const stornoOfSecond = await app.cancel(second.invoice.id, { reason: 'Téves számla', submitToNav: false });
    const res = await app.navSync({ waitSeconds: 5 });
    expect(res.find((r) => r.invoiceId === second.invoice.id)?.navStatus).toBe('aborted');
    const note = res.find((r) => r.invoiceId === stornoOfSecond.invoice.id)?.note;
    expect(note).toMatch(new RegExp(`^Nem küldhető be: az eredeti számla \\(${second.invoice.number}\\) NAV-jelentése elutasítva \\(ABORTED\\)`));
    // Only the first storno followed its (meanwhile accepted) original; the rejected one's storno was not sent.
    expect(nav.invoices.filter((i) => i.operation === 'STORNO').map((i) => i.invoiceNumber)).toEqual([storno.invoice.number]);
  });
});
