/**
 * RU2: the confirmation of sending an invoice of the other NAV system to the configured one is bound to what its
 * preview showed – the invoice's NAV status there included. Previewed while its TEST report was rejected, then
 * reported in the TEST system (as a process configured for TEST would leave it): the old confirmation sends nothing,
 * the fresh preview says so and only its fingerprint sends it. And the operation that sends it says why there is
 * nothing to send (NOT_OTHER_NAV_SYSTEM, or nav_sync's error without a usable NAV connection).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors.ts';
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

function openWith(nav: NavRuntimeConfig | null): OpenSzamla {
  while (open.length) open.pop()?.close();
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav, confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: () => new Date() });
  open.push(app);
  return app;
}

const prodNav = (): NavRuntimeConfig => ({ ...prod.runtimeConfig(), environment: 'production' });
const testNav = (): NavRuntimeConfig => ({ ...test.runtimeConfig(), environment: 'test' });

async function issue(app: OpenSzamla, net: string) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: net, vatCode: '27' }] });
  return (await app.issue(view.invoice.id)).invoice;
}

function errorOf(fn: () => unknown): { code: string; message: string; hint: string | undefined } {
  try {
    fn();
  } catch (e) {
    if (isAppError(e)) return { code: e.code, message: e.message, hint: e.hint };
    throw e;
  }
  throw new Error('no error');
}

describe('RU2: a confirmation is bound to the NAV status its preview showed', () => {
  it('a status change since the preview needs a fresh one: the old fingerprint sends nothing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-ru2-'));
    let app = openWith(testNav());
    app.updateSeller(SELLER_INPUT);
    const inv = await issue(app, '2000');
    // Its TEST report was rejected.
    app.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [{ severity: 'ERROR', code: 'INVALID_INVOICE_REFERENCE', message: 'próba' }] });
    app = openWith(prodNav());
    const before = app.navForeignResend(inv.id);
    expect(before).toMatchObject({ navStatus: 'aborted', reportedTo: 'test', sendTo: 'production' });
    expect(before?.summary).toMatch(/\(ott: elutasítva vagy hibás\)/);

    // Reported in the TEST system meanwhile (by a process configured for it).
    app.store.patchInvoice(inv.id, { navStatus: 'done', navMessages: [] });
    const after = app.navForeignResend(inv.id);
    expect(after?.summary).toMatch(/\(ott: jelentve\)/);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);

    const [stale] = await app.navSync({ invoiceId: inv.id, resubmitFailed: true, waitSeconds: 1, confirmedForeign: before?.fingerprint as string });
    expect(stale).toMatchObject({ navStatus: 'done', environment: 'test' });
    expect(stale?.note).toBe(`Nem küldtük be (megerősítés nélkül): ${after?.summary} A másik NAV-rendszerbe küldést a felhasználónak kell jóváhagynia.`);
    expect(prod.invoices).toHaveLength(0);

    const [sent] = await app.navSync({ invoiceId: inv.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: after?.fingerprint as string });
    expect(sent).toMatchObject({ navStatus: 'done', environment: 'production', note: 'A NAV sikeresen befogadta.' });
    expect(prod.invoices.map((i) => i.invoiceNumber)).toEqual([inv.number]);
  });

  it('requireNavForeignResend: the preview of the sending operation, or why there is nothing to send', async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-ru2-'));
    let app = openWith(testNav());
    app.updateSeller(SELLER_INPUT);
    const foreign = await issue(app, '2000');
    app = openWith(prodNav());
    expect(app.requireNavForeignResend(foreign.number as string)).toEqual(app.navForeignResend(foreign.id));
    const own = await issue(app, '3000');
    expect(errorOf(() => app.requireNavForeignResend(own.id))).toMatchObject({
      code: 'NOT_OTHER_NAV_SYSTEM',
      message: `A(z) ${own.number} számla NAV-állapota nem a másik NAV-rendszerhez tartozik (az éles NAV-rendszerhez tartozik, állapota: done): nincs mit átküldeni.`,
      hint: `Részletek: invoice_get ${own.number}; a beállított NAV-rendszer számláit a nav_sync kezeli.`,
    });
    const customerId = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0]?.id as string;
    const draft = (await app.createDraft({ customerId, lines: [{ description: 'X', quantity: '1', unit: 'db', unitPrice: '100', vatCode: '27' }] })).invoice;
    expect(errorOf(() => app.requireNavForeignResend(draft.id)).message).toBe(`A(z) ${draft.id} nem jelentendő a NAV-nak (piszkozat vagy díjbekérő): nincs mit beküldeni.`);
    // Sent to production; back in the TEST system its earlier TEST report is taken over by nav_sync – nothing to send.
    const preview = app.requireNavForeignResend(foreign.id);
    await app.navSync({ invoiceId: foreign.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: preview.fingerprint });
    app = openWith(testNav());
    expect(errorOf(() => app.requireNavForeignResend(foreign.id))).toMatchObject({
      code: 'NOT_OTHER_NAV_SYSTEM',
      message: `A(z) ${foreign.number} számla egy korábbi beküldését a TESZT NAV-rendszer már befogadta: nincs mit beküldeni.`,
      hint: `A befogadott beküldést beküldés nélkül átveszi: nav_sync { invoice: "${foreign.number}", resubmitFailed: true }.`,
    });
    // Without a usable NAV connection: nav_sync's error.
    app = openWith(null);
    expect(errorOf(() => app.requireNavForeignResend(foreign.id)).code).toBe('NAV_NOT_CONFIGURED');
  });
});
