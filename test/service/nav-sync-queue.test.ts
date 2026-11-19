/**
 * NAV-4: nav_sync picks its (at most 200) invoices in SQL among the ones there is something to do with, so
 * older rejected invoices a plain run leaves alone cannot crowd out a pending one; status().nextSteps counts
 * in SQL too. Issue order (originals before their corrections) and the claim stay as they were.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice, NavMessage } from '../../src/core/types.ts';
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
});

function setup(): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date() });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function issueSimple(app: OpenSzamla, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

/** `n` issued copies of `inv`, issued a day before it, in the given NAV state (fast: straight into the store). */
function olderCopies(app: OpenSzamla, inv: Invoice, n: number, prefix: string, navMessages: NavMessage[]): void {
  const issuedAt = new Date(Date.parse(inv.issuedAt as string) - 86_400_000).toISOString();
  app.store.tx(() => {
    for (let i = 1; i <= n; i++) {
      const draft: Invoice = { ...inv, id: `inv_${prefix}${String(i).padStart(6, '0')}`, number: null, status: 'draft', issuedAt: null, contentHash: null, navStatus: 'not_applicable', navTransactionId: null, navMessages: [] };
      app.store.insertDraft(draft);
      app.store.markIssued({ ...draft, status: 'issued', number: `${prefix}-${i}`, issuedAt, contentHash: 'test', navStatus: 'aborted', navMessages });
    }
  });
}

const REJECTED: NavMessage[] = [{ severity: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' }];
const manageCalls = (): number => nav.requests.filter((r) => r.operation === 'manageInvoice').length;

describe('NAV-4: the 200 invoices of a run are the actionable ones', () => {
  it('a pending invoice behind 205 older rejected ones is reported by the first plain nav_sync; the next steps count all of them', async () => {
    const app = setup();
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'manageInvoice' });
    const pending = await issueSimple(app);
    expect(pending.invoice.navStatus).toBe('pending');
    olderCopies(app, pending.invoice, 205, 'REJ', REJECTED);
    expect(app.status().nextSteps.join('\n')).toMatch(/205 számla NAV-jelentését a NAV elutasította/);
    expect(app.status().nextSteps.join('\n')).toMatch(/1 számla NAV-jelentése függőben/);

    const res = await app.navSync({ waitSeconds: 3 });
    expect(res.map((r) => [r.number, r.navStatus])).toEqual([[pending.invoice.number, 'done']]);
    expect(manageCalls()).toBe(2); // the maintenance answer and this one
    expect(app.status().nextSteps.join('\n')).not.toMatch(/függőben/);
  });

  it('more than 200 duplicates and held-up corrections are counted exactly', async () => {
    const app = setup();
    const original = await issueSimple(app, { submitToNav: false });
    olderCopies(app, original.invoice, 201, 'DUP', [{ severity: 'ERROR', code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.' }]);
    expect(app.status().nextSteps.join('\n')).toMatch(/201 számla beküldését a NAV ismétlésként utasította el/);

    // 201 corrections waiting for an original NAV rejected
    app.store.patchInvoice(original.invoice.id, { navStatus: 'aborted', navMessages: REJECTED });
    const storno = await app.cancel(original.invoice.id, { reason: 'Teszt', submitToNav: false });
    const s = storno.invoice;
    app.store.tx(() => {
      for (let i = 1; i <= 200; i++) {
        const draft: Invoice = { ...s, id: `inv_COR${String(i).padStart(6, '0')}`, number: null, status: 'draft', issuedAt: null, contentHash: null, navStatus: 'not_applicable', navMessages: [] };
        app.store.insertDraft(draft);
        app.store.markIssued({ ...draft, status: 'issued', number: `COR-${i}`, issuedAt: s.issuedAt, contentHash: 'test', navStatus: 'pending' });
      }
    });
    const steps = app.status().nextSteps.join('\n');
    expect(steps).toMatch(new RegExp(`201 módosító/sztornó számla nem jelenthető, mert az eredeti számla \\(${original.invoice.number}\\)`));
    expect(steps).not.toMatch(/függőben/);
  });
});
