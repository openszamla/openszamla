/**
 * R1: an invoice whose NAV state belongs to the other NAV system (e.g. reported only to the TEST one) is sent to the
 * configured one only with the user's confirmation – the rule is the service's: nav_sync { invoice, resubmitFailed }
 * without it sends nothing and says why; navForeignResend tells what would happen (which system it belongs to,
 * where it would go, whether that is a real report) and the fingerprint a confirmation is bound to (the invoice,
 * its content, both systems). Taking over an earlier report of this system needs no confirmation: nothing is sent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type NavRuntimeConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

let prod: FakeNavServer;
let test: FakeNavServer;
let dir = '';
const open: OpenSzamla[] = [];

beforeAll(async () => {
  prod = await FakeNavServer.start({ receivedPolls: 0 });
  test = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await prod.stop();
  await test.stop();
});
afterEach(() => {
  while (open.length) open.pop()?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  prod.reset();
  test.reset();
});

const prodNav = (): NavRuntimeConfig => ({ ...prod.runtimeConfig(), environment: 'production' });
const testNav = (): NavRuntimeConfig => ({ ...test.runtimeConfig(), environment: 'test' });

function openWith(nav: NavRuntimeConfig): OpenSzamla {
  while (open.length) open.pop()?.close();
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav, confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: () => new Date() });
  open.push(app);
  return app;
}

async function issue(app: OpenSzamla, net: string) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: net, vatCode: '27' }] });
  return (await app.issue(view.invoice.id)).invoice;
}

const sent = (nav: FakeNavServer): number => nav.requests.filter((r) => r.operation === 'manageInvoice').length;

describe('R1: a report to the other NAV system needs the user\'s confirmation', () => {
  it('without it nothing is sent; navForeignResend says what would happen; only the confirmed fingerprint sends it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-r1-'));
    let app = openWith(testNav());
    app.updateSeller(SELLER_INPUT);
    const b = await issue(app, '2000');
    expect(b).toMatchObject({ navStatus: 'done', navEnvironment: 'test' });
    app = openWith(prodNav());

    const preview = app.navForeignResend(b.id);
    expect(preview).toMatchObject({ invoiceId: b.id, number: b.number, reportedTo: 'test', navStatus: 'done', sendTo: 'production', realReport: true });
    expect(preview?.summary).toBe(
      `A(z) ${b.number} számla NAV-állapota a TESZT rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve. ` +
        'Most az ÉLES NAV-rendszerbe kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás a NAV felé, és nem vonható vissza. Csak akkor küldd be, ha ez valódi számla.',
    );
    expect(preview?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The service rule: asked for, but not confirmed – nothing goes to production.
    for (const confirmedForeign of [undefined, 'not-the-fingerprint']) {
      const [res] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 1, ...(confirmedForeign ? { confirmedForeign } : {}) });
      expect(res).toMatchObject({ navStatus: 'done', environment: 'test' });
      expect(res?.note).toBe(`Nem küldtük be (megerősítés nélkül): ${preview?.summary} A másik NAV-rendszerbe küldést a felhasználónak kell jóváhagynia.`);
    }
    expect(sent(prod)).toBe(0);
    expect(app.getInvoice(b.id)).toMatchObject({ navStatus: 'done', navEnvironment: 'test' });

    // Confirmed: sent as a new submission.
    const [reported] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: preview?.fingerprint as string });
    expect(reported).toMatchObject({ navStatus: 'done', environment: 'production', note: 'A NAV sikeresen befogadta.' });
    expect(sent(prod)).toBe(1);
    expect(app.navForeignResend(b.id)).toBeNull(); // it belongs here now

    // Back in the test system: an earlier report of that system is taken over – nothing to confirm, nothing sent.
    app = openWith(testNav());
    expect(app.navForeignResend(b.id)).toBeNull();
    const before = sent(test);
    const [adopted] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 1 });
    expect(adopted).toMatchObject({ navStatus: 'done', environment: 'test' });
    expect(adopted?.note).toMatch(/^Ebbe a NAV-rendszerbe egy korábbi beküldését a NAV már befogadta/);
    expect(sent(test)).toBe(before);
  });

  it('the confirmation is bound to the invoice, its NAV system and the target; to the test system it is no real report', async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-r1-'));
    let app = openWith(prodNav());
    app.updateSeller(SELLER_INPUT);
    const a = await issue(app, '1000');
    app = openWith(testNav());
    const b = await issue(app, '2000');
    const toTest = app.navForeignResend(a.id);
    expect(toTest).toMatchObject({ reportedTo: 'production', sendTo: 'test', realReport: false });
    expect(toTest?.summary).toMatch(/az ÉLES rendszerhez tartozik \(ott: jelentve\)\. Most a NAV TESZT rendszerébe kerülne beküldésre, új beküldésként: ez nem adatszolgáltatás/);
    expect(app.navForeignResend(b.id)).toBeNull(); // this system's own invoice

    app = openWith(prodNav());
    const toProd = app.navForeignResend(b.id);
    expect(toProd?.fingerprint).not.toBe(toTest?.fingerprint);
    // A's confirmation (another invoice, another direction) does not send B.
    const [res] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 1, confirmedForeign: toTest?.fingerprint as string });
    expect(res?.note).toMatch(/^Nem küldtük be \(megerősítés nélkül\)/);
    expect(prod.invoices.map((i) => i.invoiceNumber)).toEqual([a.number]);
    // A plain run, a resubmission of all and nav_sync { invoice } without resubmitFailed never send it either.
    await app.navSync({ waitSeconds: 1 });
    await app.navSync({ resubmitFailed: true, waitSeconds: 1 });
    expect((await app.navSync({ invoiceId: b.id, waitSeconds: 1 }))[0]?.note).toMatch(/^A számla NAV-állapota a TESZT rendszerhez tartozik/);
    expect(prod.invoices.map((i) => i.invoiceNumber)).toEqual([a.number]);
  });
});
