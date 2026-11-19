/**
 * NV2: setup_status names the corrections held up by an unreported original with the remedy of WHY the original is
 * not reported. Resending helps only an original NAV rejected or that failed; for a number collision it says that
 * resending does not help and points to the collision's own remedy; for an original whose check a permanent NAV
 * error blocks (no query permission …) it names that error and its fix.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
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

const NOT_UNIQUE = { severity: 'ERROR' as const, code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.' };

async function issueSimple(app: OpenSzamla, unitPrice: string, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

async function takenElsewhere(inv: Invoice): Promise<void> {
  const other = { ...inv, totals: { ...inv.totals, netAmountHuf: '1000', vatAmountHuf: '270', grossAmountHuf: '1270' } };
  const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  await client.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(buildInvoiceDataXml(other)).toString('base64') }]);
}

describe('NV2: the held-up corrections step is worded by the cause', () => {
  it('rejected, number collision, blocked check: one step each, each with its own remedy', async () => {
    t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date() });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const year = new Date().getFullYear();

    // 1. NAV rejected it (a fixable cause).
    nav.addBusinessMessage(`SZ-${year}-00001`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    const rejected = await issueSimple(app, '10000');
    expect(rejected.invoice.navStatus).toBe('aborted');
    // 2. Its number belongs to another invoice at NAV.
    const collision = await issueSimple(app, '20000', { submitToNav: false });
    await takenElsewhere(collision.invoice);
    expect((await app.navSync({ invoiceId: collision.invoice.id, waitSeconds: 3 }))[0]?.messages.map((m) => m.code)).toContain('OPENSZAMLA_NUMBER_COLLISION');
    // 3. A duplicate whose check NAV refuses (no query permission).
    const blocked = await issueSimple(app, '30000', { submitToNav: false });
    app.store.patchInvoice(blocked.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'FORBIDDEN', httpStatus: 403, message: 'Nincs jogosultság.' }, { operation: 'queryInvoiceData', times: 10 });
    expect((await app.navSync({ invoiceId: blocked.invoice.id, waitSeconds: 0 }))[0]?.messages.map((m) => m.code)).toContain('OPENSZAMLA_RECONCILE_BLOCKED');

    const stornos = [];
    for (const original of [rejected, collision, blocked]) stornos.push((await app.cancel(original.invoice.id, { reason: 'Téves számla' })).invoice);
    expect(stornos.map((s) => s.navStatus)).toEqual(['pending', 'pending', 'pending']);

    const steps = app.status().nextSteps;
    const held = steps.filter((s) => /módosító\/sztornó számla nem jelenthető/.test(s));
    expect(held).toHaveLength(3);
    const [forRejected, forCollision, forBlocked] = held as [string, string, string];
    expect(forRejected).toMatch(new RegExp(`^1 módosító/sztornó számla nem jelenthető, mert az eredeti számla \\(${rejected.invoice.number}\\) NAV-jelentése elutasítva vagy hibás`));
    expect(forRejected).toContain('nav_sync { invoice: "<az eredeti sorszáma>", resubmitFailed: true }');

    expect(forCollision).toMatch(new RegExp(`^1 módosító/sztornó számla nem jelenthető, mert az eredeti számla \\(${collision.invoice.number}\\) sorszáma a NAV-nál egy másik számláé \\(sorszám-ütközés\\)`));
    expect(forCollision).toMatch(/Az újraküldés nem segít/);
    expect(forCollision).toContain('OPENSZAMLA_NUMBER_COLLISION');
    expect(forCollision).not.toMatch(/resubmitFailed/);

    expect(forBlocked).toMatch(new RegExp(`^1 módosító/sztornó számla nem jelenthető, mert az eredeti számla \\(${blocked.invoice.number}\\) NAV-jelentését a program nem tudja egyeztetni a NAV-val \\(a technikai felhasználónak nincs lekérdezési jogosultsága`));
    expect(forBlocked).toMatch(/majd futtasd: nav_sync resubmitFailed: true/);
    expect(forBlocked).not.toMatch(/elutasítva vagy hibás/);

    // Held-up corrections are not counted as plainly pending.
    expect(steps.some((s) => /NAV-jelentése függőben/.test(s))).toBe(false);
    // The storno of the blocked original says the same.
    expect(app.navWaitReason(stornos[2]?.id as string)).toMatch(/nem tudja egyeztetni a NAV-val \(a NAV lekérdezése végleges hibát ad\)/);
    expect(app.navWaitReason(stornos[1]?.id as string)).toMatch(/sorszám-ütközés/);
    expect(app.navWaitReason(stornos[0]?.id as string)).toMatch(/elutasítva \(ABORTED\)/);
  });
});
