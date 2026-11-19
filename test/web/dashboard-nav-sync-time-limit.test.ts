/**
 * NV5c on the web: the dashboard's "Függő számlák beküldése a NAV-nak" runs with a time limit of about a minute
 * (NavRunOptions.budgetMs 60 000), and when the run did not get to some invoices the result says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavRunOptions } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';
import { flashesOf, startWeb, type WebEnv } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('NV5c: the dashboard NAV sync has a time limit', () => {
  it('passes 60 s, and names the invoices the run did not get to', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    const e: WebEnv = await startWeb({ nav: nav.runtimeConfig(), now: () => new Date() });
    cleanups.push(async () => {
      await e.close();
      await nav.stop();
    });
    e.app.updateSeller(SELLER_INPUT);
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    for (const price of ['1000', '2000']) {
      const view = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: price, vatCode: '27' }] });
      await e.app.issue(view.invoice.id, { submitToNav: false });
    }
    // The limit the page passes is recorded; the run itself gets none left, so it contacts NAV no more.
    const real = e.app.navSync.bind(e.app);
    const limits: Array<number | undefined> = [];
    vi.spyOn(e.app, 'navSync').mockImplementation((opts: NavRunOptions = {}, actor) => {
      limits.push(opts.budgetMs);
      return real({ ...opts, budgetMs: 1 }, actor);
    });
    const b = await e.loggedIn();
    const page = await b.follow(await b.post('/nav-sync', {}));
    expect(limits).toEqual([60_000]);
    expect(flashesOf(page.body)).toContain(
      '2 számla feldolgozva, ebből 0 sikeresen jelentve a NAV TESZT rendszerébe (éles adatszolgáltatás NEM történt). 2 számlához ez a futás nem fordult a NAV-hoz (lásd a megjegyzéseket) – később kattints újra a „Függő számlák beküldése a NAV-nak” gombra.',
    );
    expect(page.body).toContain('A rendelkezésre álló idő letelt, mielőtt a program ennél a számlánál a NAV-hoz fordult volna');
    expect(page.body).not.toContain('nav_sync');
    expect(nav.requests).toHaveLength(0);
  });
});
