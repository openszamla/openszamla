/**
 * The PC clock off NAV's, in the two cases the first fix (nav-pc-clock-ahead.test.ts) did not cover.
 *
 * 1. The process dies while the report is on its way (a crash, a power cut), and the clock is set right before the next
 *    sync. Nothing recorded how far the clock was off when the report went out, the clock difference measured at the
 *    next sync was zero – so the lost report was looked for in the wrong window, the invoice was sent again, and NAV's
 *    copy (our own report, received "10 minutes before" the invoice was issued by the old clock) was called another
 *    invoice: a number collision that never clears. The difference is now recorded before the report goes out.
 * 2. No HTTP Date header on NAV's answers (a proxy drops it): there was no clock reading at all. The time NAV stamps
 *    the exchange token with is one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NavClient } from '../../src/nav/client.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DEFAULT_SOFTWARE, loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FAKE_NAV_CREDENTIALS, FakeNavServer } from '../helpers/fake-nav.ts';

const MINUTE = 60_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** NAV's clock and the PC's; `wait` moves both, `setPcAhead` sets the PC's clock (as a user or a time sync does). */
function clocks(pcAheadMs: number): { nav: () => Date; pc: () => Date; wait(ms: number): void; setPcAhead(ms: number): void } {
  let t = Date.now();
  let ahead = pcAheadMs;
  return { nav: () => new Date(t), pc: () => new Date(t + ahead), wait: (ms) => (t += ms), setPcAhead: (ms) => (ahead = ms) };
}

async function draftOf(app: OpenSzamla): Promise<string> {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const draft = await app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return draft.invoice.id;
}

describe('the clock difference is known when it is needed', () => {
  it('10 minutes fast, the process dies while the report is on its way, the clock is set right before the next sync: found and adopted', async () => {
    const c = clocks(10 * MINUTE);
    const nav = await FakeNavServer.start({ receivedPolls: 0, now: c.nav });
    const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-clockcrash-'));
    const config = loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 2 } });
    const apps: OpenSzamla[] = [];
    cleanups.push(async () => {
      for (const a of apps) a.close();
      await nav.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    // The report reaches NAV, then the process is gone: nothing after the request is written.
    let first: OpenSzamla | null = null;
    const dying: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/manageInvoice')) {
        first?.close();
        throw new Error('the process died');
      }
      return res;
    };
    first = OpenSzamla.open({ config, now: c.pc, fetch: dying });
    apps.push(first);
    first.updateSeller(SELLER_INPUT);
    const id = await draftOf(first);
    await first.issue(id).catch(() => undefined);

    // Restarted, with the clock set right in the meantime.
    c.setPcAhead(0);
    c.wait(8 * MINUTE); // an attempt left "being sent" is looked up 7 minutes after it began (2 for the request, 5 as NAV asks)
    const app = OpenSzamla.open({ config, now: c.pc });
    apps.push(app);
    const inv = app.getInvoice(id);
    expect(inv.status).toBe('issued');
    expect(app.store.listNavSubmissions(id).map((s) => s.status)).toEqual(['sending']);
    // On record from before the send: the clock was 10 minutes ahead.
    const recorded = app.auditLog({ entityId: id, limit: 50 }).items.find((e) => e.action === 'nav.clock');
    expect(recorded?.details.clockOffsetMs).toBeGreaterThan(9 * MINUTE);

    const [r] = await app.navSync({ waitSeconds: 2 });
    expect(r?.messages.map((m) => m.code)).not.toContain('OPENSZAMLA_NUMBER_COLLISION');
    expect(r?.navStatus, r?.note).toBe('done');
    // Sent once: NAV holds one report of the number, and no rejected duplicate.
    expect(nav.invoices.filter((i) => i.invoiceNumber === inv.number).map((i) => `${i.operation}:${i.invoiceStatus}`)).toEqual(['CREATE:DONE']);
  });

  it('no HTTP Date header on the answers, 10 minutes fast, the answer lost: the token time gives the clock – found and adopted', async () => {
    const c = clocks(10 * MINUTE);
    const nav = await FakeNavServer.start({ receivedPolls: 0, now: c.nav, dateHeader: false });
    const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-nodate-'));
    const app = OpenSzamla.open({ config: loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 2 } }), now: c.pc });
    cleanups.push(async () => {
      app.close();
      await nav.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    app.updateSeller(SELLER_INPUT);
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const issued = await app.issue(await draftOf(app));
    expect(issued.nav?.navStatus).toBe('pending');
    c.wait(6 * MINUTE);
    const [r] = await app.navSync({ waitSeconds: 2 });
    expect(r?.messages.map((m) => m.code)).not.toContain('OPENSZAMLA_NUMBER_COLLISION');
    expect(r?.navStatus).toBe('done');
    expect(nav.invoices.filter((i) => i.invoiceNumber === issued.invoice.number).map((i) => `${i.operation}:${i.invoiceStatus}`)).toEqual(['CREATE:DONE']);
  });

  it('a clock less than a minute off leaves no entry in the log', async () => {
    const c = clocks(20_000);
    const nav = await FakeNavServer.start({ receivedPolls: 0, now: c.nav });
    const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-clocksmall-'));
    const app = OpenSzamla.open({ config: loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 2 } }), now: c.pc });
    cleanups.push(async () => {
      app.close();
      await nav.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    app.updateSeller(SELLER_INPUT);
    const issued = await app.issue(await draftOf(app));
    expect(issued.nav?.navStatus).toBe('done');
    expect(app.auditLog({ entityId: issued.invoice.id, limit: 50 }).items.map((e) => e.action)).not.toContain('nav.clock');
  });

  it('the client reads the clock from the exchange token when the answer has no Date header', async () => {
    const c = clocks(-7 * MINUTE);
    const nav = await FakeNavServer.start({ now: c.nav, dateHeader: false });
    cleanups.push(() => nav.stop());
    const { taxNumber, ...credentials } = FAKE_NAV_CREDENTIALS;
    const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: { ...credentials, taxNumber }, software: DEFAULT_SOFTWARE, now: c.pc });
    expect(client.clockOffsetMs).toBeNull();
    await client.tokenExchange();
    const offset = client.clockOffsetMs as number;
    expect(offset).toBeLessThanOrEqual(-7 * MINUTE + 5000);
    expect(offset).toBeGreaterThan(-7 * MINUTE - 5000);
  });
});
