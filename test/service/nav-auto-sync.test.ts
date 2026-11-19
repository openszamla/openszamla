/**
 * The background NAV synchronisation of a running server (nav-auto.ts). An invoice whose report failed on a NAV outage
 * stayed "pending" until someone ran nav_sync – with a report due at once, a forgotten one is a fine waiting to happen.
 * The server now carries on with what was started: it retries and polls invoices that already have a submission
 * attempt, as the system. It never sends an invoice first (one held back with submitToNav: false stays as it is), and
 * does nothing when automatic reporting is off.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { startNavAutoSync } from '../../src/service/nav-auto.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(overrides: { navAutoSubmit?: boolean } = {}): Promise<{ app: OpenSzamla; nav: FakeNavServer; logs: string[] }> {
  const nav = await FakeNavServer.start({ receivedPolls: 0 });
  const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-navauto-'));
  const app = OpenSzamla.open({ config: loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 2, ...overrides } }) });
  cleanups.push(async () => {
    app.close();
    await nav.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  app.updateSeller(SELLER_INPUT);
  return { app, nav, logs: [] };
}

async function draft(app: OpenSzamla): Promise<string> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '10000', vatCode: '27' }] })).invoice.id;
}

describe('the background NAV synchronisation', () => {
  it('carries on a report that failed on an outage; an invoice never sent is left alone', async () => {
    const { app, nav, logs } = await setup();
    // NAV is down when the first invoice is issued: the attempt fails, the invoice stays pending.
    nav.failNext({ kind: 'HTTP_500' }, { times: 3 });
    const failed = await app.issue(await draft(app));
    expect(failed.invoice.navStatus).toBe('pending');
    expect(app.store.listNavSubmissions(failed.invoice.id).length).toBeGreaterThan(0);
    nav.clearFaults();
    // Held back on purpose: never sent.
    const held = await app.issue(await draft(app), { submitToNav: false });
    expect(held.invoice.navStatus).toBe('pending');
    expect(app.store.listNavSubmissions(held.invoice.id)).toEqual([]);

    const auto = startNavAutoSync(app, { firstDelayMs: 60_000, intervalMs: 60_000, log: (l) => logs.push(l) });
    cleanups.push(() => auto.stop());
    await auto.runOnce();

    expect(app.getInvoice(failed.invoice.id).navStatus).toBe('done');
    expect(app.getInvoice(held.invoice.id).navStatus).toBe('pending');
    expect(app.store.listNavSubmissions(held.invoice.id)).toEqual([]);
    expect(nav.invoices.map((i) => i.invoiceNumber)).toEqual([failed.invoice.number]);
    expect(logs).toEqual(['[openszamla] automatikus NAV-szinkron: 1 számla jelentése rendben lezárult.']);
    // Done by the system, on record.
    const submit = app.auditLog({ entityId: failed.invoice.id, limit: 50 }).items.find((e) => e.action === 'nav.submit');
    expect(submit?.actor).toBe('system');

    // Nothing left that it handles: the next look asks NAV nothing.
    const requests = nav.requests.length;
    await auto.runOnce();
    expect(nav.requests.length).toBe(requests);
    // A plain nav_sync still sends the held invoice.
    expect((await app.navSync({ waitSeconds: 2 })).find((r) => r.invoiceId === held.invoice.id)?.navStatus).toBe('done');
  });

  it('does nothing when automatic reporting is switched off, and stops with stop()', async () => {
    const { app, nav, logs } = await setup({ navAutoSubmit: false });
    nav.failNext({ kind: 'HTTP_500' }, { times: 3 });
    await app.navSync({ invoiceId: (await app.issue(await draft(app))).invoice.id, waitSeconds: 1 });
    nav.clearFaults();
    const pending = app.findInvoices({ status: ['issued'] }).items[0];
    expect(pending?.navStatus).toBe('pending');
    const requests = nav.requests.length;
    const auto = startNavAutoSync(app, { firstDelayMs: 5, intervalMs: 5, log: (l) => logs.push(l) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    auto.stop();
    await auto.runOnce();
    expect(nav.requests.length).toBe(requests);
    expect(app.getInvoice(pending?.id ?? '').navStatus).toBe('pending');
    expect(logs).toEqual([]);
  });
});
