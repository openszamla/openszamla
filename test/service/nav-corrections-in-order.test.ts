/**
 * The corrections of one invoice reach NAV in the order they were issued. A correction waited only for its original:
 * when NAV rejected the first modification, the second one – whose lines are numbered after the first one's – was
 * sent anyway, out of order. A correction now waits for every earlier correction of the same invoice too; once that
 * one is accepted, it follows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const LINE = (unitPrice: string, description = 'Tanácsadás') => ({ description, quantity: '1', unit: 'óra', unitPrice, vatCode: '27' as const });

describe('corrections of one invoice are reported in the order they were issued', () => {
  it('a modification waits while an earlier one is rejected, and follows once that one is accepted; so does the storno', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-navorder-'));
    const app = OpenSzamla.open({ config: loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), navWaitSeconds: 3 } }) });
    cleanups.push(async () => {
      app.close();
      await nav.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await app.issue((await app.createDraft({ customerId, lines: [LINE('100000')] })).invoice.id)).invoice;
    expect(original.navStatus).toBe('done');
    const modify = async (unitPrice: string, comment: string): Promise<Invoice> =>
      (await app.issue((await app.createCorrectionDraft(original.id, { lines: [LINE(unitPrice, 'Különbözet')], comment })).invoice.id)).invoice;

    // NAV rejects the first modification.
    const year = new Date().getFullYear();
    nav.addBusinessMessage(`SZ-${year}-00002`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    const first = await modify('10000', 'Első módosítás');
    expect(first.navStatus).toBe('aborted');

    // The second one is issued, but not sent before the first.
    const second = await modify('5000', 'Második módosítás');
    expect(second.navStatus).toBe('pending');
    expect(app.store.listNavSubmissions(second.id)).toEqual([]);
    const waits = (await app.navSync({ invoiceId: second.id, waitSeconds: 1 }))[0];
    expect(waits?.navStatus).toBe('pending');
    expect(waits?.note).toContain(`ugyanennek a számlának egy korábbi módosító számláját (${first.number}) a NAV még nem fogadta be`);
    expect(waits?.note).toContain(`nav_sync { invoice: "${first.number}", resubmitFailed: true }`);
    expect(nav.invoices.filter((i) => i.invoiceNumber === second.number)).toEqual([]);

    // The cause is fixed, the first one is sent again and accepted: the second follows in the same run.
    nav.clearBusinessMessages();
    const run = await app.navSync({ resubmitFailed: true, waitSeconds: 5 });
    expect(run.find((r) => r.invoiceId === first.id)?.navStatus).toBe('done');
    expect(app.getInvoice(second.id).navStatus).toBe('done');
    // In order at NAV: the original, the first modification (accepted on its second report), then the second.
    const accepted = nav.invoices.filter((i) => i.invoiceStatus === 'DONE').map((i) => i.invoiceNumber);
    expect(accepted).toEqual([original.number, first.number, second.number]);

    // A storno waits for a modification NAV has not accepted, the same way.
    nav.addBusinessMessage(`SZ-${year}-00004`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
    const third = await modify('1000', 'Harmadik módosítás');
    expect(third.navStatus).toBe('aborted');
    const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
    expect(storno.navStatus).toBe('pending');
    expect(app.store.listNavSubmissions(storno.id)).toEqual([]);
  });
});
