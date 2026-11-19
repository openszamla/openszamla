/**
 * A PC clock some minutes off NAV's. NAV accepts requests whose time is within a day of its own, so a fast or slow PC
 * clock goes unnoticed – until a time NAV recorded is compared with ours. With the PC 10 minutes fast and the answer to
 * the submission lost, NAV received our report "10 minutes before" the invoice was issued by the PC clock: the program
 * used to list the transactions in the wrong window, send the invoice again, and then call NAV's copy – our own report –
 * another invoice (OPENSZAMLA_NUMBER_COLLISION, "not reported", corrections held). The clock difference is now measured
 * on NAV's answers (HTTP Date header) and both comparisons are made in NAV time: the lost report is found and adopted,
 * nothing is sent twice. A report NAV really received before the invoice existed is still a collision.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { navReceivedBeforeIssue } from '../../src/service/nav-match.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

const MINUTE = 60_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** NAV's clock and the PC's, `pcAheadMs` apart; `wait` moves both. */
function clocks(pcAheadMs: number): { nav: () => Date; pc: () => Date; wait(ms: number): void } {
  let t = Date.now();
  return { nav: () => new Date(t), pc: () => new Date(t + pcAheadMs), wait: (ms) => (t += ms) };
}

async function setup(pcAheadMs: number): Promise<{ app: OpenSzamla; nav: FakeNavServer; wait(ms: number): void }> {
  const c = clocks(pcAheadMs);
  const nav = await FakeNavServer.start({ receivedPolls: 0, now: c.nav });
  const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-pcclock-'));
  const app = OpenSzamla.open({ config: loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 2 } }), now: c.pc });
  cleanups.push(async () => {
    app.close();
    await nav.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  app.updateSeller(SELLER_INPUT);
  return { app, nav, wait: c.wait };
}

async function issueOne(app: OpenSzamla) {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const draft = await app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return app.issue(draft.invoice.id);
}

describe('a PC clock off NAV\'s', () => {
  it('10 minutes fast, the answer lost: the report is found in NAV time and adopted – no resend, no collision', async () => {
    const { app, nav, wait } = await setup(10 * MINUTE);
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const issued = await issueOne(app);
    expect(issued.nav?.navStatus).toBe('pending');
    wait(6 * MINUTE); // past NAV's 5-minute wait before an unknown outcome is looked up
    const [r] = await app.navSync({ waitSeconds: 2 });
    expect(r?.navStatus).toBe('done');
    expect(r?.messages.map((m) => m.code)).not.toContain('OPENSZAMLA_NUMBER_COLLISION');
    expect(app.getInvoice(issued.invoice.id).navStatus).toBe('done');
    // Sent once: NAV holds one report of the number, and no rejected duplicate.
    expect(nav.invoices.filter((i) => i.invoiceNumber === issued.invoice.number).map((i) => `${i.operation}:${i.invoiceStatus}`)).toEqual(['CREATE:DONE']);
  });

  it('10 minutes slow, the answer lost: the same', async () => {
    const { app, nav, wait } = await setup(-10 * MINUTE);
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const issued = await issueOne(app);
    wait(6 * MINUTE);
    const [r] = await app.navSync({ waitSeconds: 2 });
    expect(r?.navStatus).toBe('done');
    expect(nav.invoices.filter((i) => i.invoiceNumber === issued.invoice.number).map((i) => `${i.operation}:${i.invoiceStatus}`)).toEqual(['CREATE:DONE']);
  });

  it('the received-before-issue test works in NAV time: what NAV received before the invoice existed is still another invoice', () => {
    const issuedAt = '2026-11-19T10:10:00.000Z'; // by a PC clock 10 minutes fast: 10:00 in NAV time
    // Our own report, received a few seconds after the issue in NAV time.
    expect(navReceivedBeforeIssue({ issuedAt }, '2026-11-19T10:00:05.000Z', 5 * MINUTE, 10 * MINUTE)).toBe(false);
    // Without the correction it looked 10 minutes older than the invoice.
    expect(navReceivedBeforeIssue({ issuedAt }, '2026-11-19T10:00:05.000Z', 5 * MINUTE)).toBe(true);
    // A report NAV received an hour before the invoice (a restored backup re-used the number): still a collision.
    expect(navReceivedBeforeIssue({ issuedAt }, '2026-11-19T09:00:00.000Z', 5 * MINUTE, 10 * MINUTE)).toBe(true);
  });
});
