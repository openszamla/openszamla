/**
 * NV3: a settled reconciliation is not asked about again by every run. Once an original has a recorded number
 * collision, neither a plain nav_sync nor a resubmission of all (resubmitFailed without invoice) queries NAV for it or
 * for its pending corrections – before, every plain run sent one queryInvoiceData per pending correction, forever.
 * Only nav_sync of the original itself ({ invoice, resubmitFailed: true }) checks it again. The same holds for an
 * original whose check a permanent NAV error (no query permission) blocks: the plain runs leave it alone, and
 * nav_sync resubmitFailed: true after the fix settles it and lets its storno follow.
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

function setup(): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date() });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function issueSimple(app: OpenSzamla, unitPrice: string, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

/** Another installation reports its own invoice under the number of `inv` (another amount: another invoice). */
async function takenElsewhere(inv: Invoice): Promise<void> {
  const other = { ...inv, totals: { ...inv.totals, netAmountHuf: '1000', vatAmountHuf: '270', grossAmountHuf: '1270' } };
  const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  await client.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(buildInvoiceDataXml(other)).toString('base64') }]);
}

const NOT_UNIQUE = { severity: 'ERROR' as const, code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.' };
const since = (from: number, operation?: string): number => nav.requests.slice(from).filter((r) => operation === undefined || r.operation === operation).length;

describe('NV3: a recorded number collision is not queried again by every run', () => {
  it('plain runs and a resubmission of all send no request for the original or its corrections; nav_sync of the original checks again', async () => {
    const app = setup();
    const original = await issueSimple(app, '3000000', { submitToNav: false });
    await takenElsewhere(original.invoice);
    expect((await app.navSync({ invoiceId: original.invoice.id, waitSeconds: 3 }))[0]?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    const mod = await app.issue((await app.createCorrectionDraft(original.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-100000', vatCode: '27' }], comment: 'Engedmény' })).invoice.id);
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves sorszám' });
    expect([mod.invoice.navStatus, storno.invoice.navStatus]).toEqual(['pending', 'pending']);

    const start = nav.requests.length;
    for (let k = 0; k < 3; k++) {
      const plain = await app.navSync({ waitSeconds: 0 });
      expect(plain.map((r) => [r.number, r.navStatus])).toEqual([
        [mod.invoice.number, 'pending'],
        [storno.invoice.number, 'pending'],
      ]);
      for (const r of plain) expect(r.note).toMatch(/sorszáma a NAV-nál egy másik számláé \(sorszám-ütközés\)/);
    }
    expect(since(start)).toBe(0);

    // A resubmission of all leaves the collision as it is – and says how to have it checked again.
    const all = await app.navSync({ resubmitFailed: true, waitSeconds: 0 });
    const kept = all.find((r) => r.invoiceId === original.invoice.id);
    expect(kept?.navStatus).toBe('aborted');
    expect(kept?.note).toMatch(/^Sorszám-ütközés: .*A program ezt nem kérdezi le újra a NAV-tól minden futásban/);
    expect(kept?.note).toContain(`nav_sync { invoice: "${original.invoice.number}", resubmitFailed: true }`);
    // …and so does nav_sync of one of its corrections.
    expect((await app.navSync({ invoiceId: storno.invoice.id, resubmitFailed: true, waitSeconds: 0 }))[0]?.navStatus).toBe('pending');
    expect(since(start)).toBe(0);

    // nav_sync of the original itself asks NAV again (once); the other invoice is still there.
    const checked = await app.navSync({ invoiceId: original.invoice.id, resubmitFailed: true, waitSeconds: 0 });
    expect(checked[0]?.navStatus).toBe('aborted');
    expect(since(start, 'queryInvoiceData')).toBe(1);
    expect(since(start, 'manageInvoice')).toBe(0);
    expect(app.getInvoice(original.invoice.id).navMessages.filter((m) => m.code === 'OPENSZAMLA_NUMBER_COLLISION')).toHaveLength(1);
  });

  it('an original whose check a permanent NAV error blocks: plain runs do not ask through its storno; after the fix resubmitFailed settles both', async () => {
    const app = setup();
    const original = await issueSimple(app, '30000', { submitToNav: false });
    app.store.patchInvoice(original.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'FORBIDDEN', httpStatus: 403, message: 'Nincs jogosultság.' }, { operation: 'queryInvoiceData', times: 100 });
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'FORBIDDEN', 'OPENSZAMLA_RECONCILE_BLOCKED']);
    const start = nav.requests.length;
    const storno = await app.cancel(original.invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus).toBe('pending');
    expect(storno.nav?.note).toMatch(/nem tudja egyeztetni a NAV-val.*nav_sync \{ invoice: ".*", resubmitFailed: true \}/);
    for (let k = 0; k < 3; k++) expect((await app.navSync({ waitSeconds: 0 })).map((r) => r.navStatus)).toEqual(['pending']);
    expect(since(start)).toBe(0);

    // The permission is granted: NAV holds nothing under the number – the original is sent, then its storno, in one run.
    nav.reset();
    const fixed = await app.navSync({ resubmitFailed: true, waitSeconds: 5 });
    expect(fixed.map((r) => [r.number, r.navStatus])).toEqual([
      [original.invoice.number, 'done'],
      [storno.invoice.number, 'done'],
    ]);
    expect(nav.invoices.map((i) => `${i.operation} ${i.invoiceStatus}`)).toEqual(['CREATE DONE', 'STORNO DONE']);
  });
});
