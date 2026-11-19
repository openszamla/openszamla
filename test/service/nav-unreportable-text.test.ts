/**
 * NAV-8 through the service: text made only of characters XML cannot carry is caught at draft time (no
 * confirmation, no number); and an issued document whose report still cannot be built (issued by an older
 * version) is an error whose hint asks for help instead of recommending a correction or a storno.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
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

function setup() {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date() });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

describe('NAV-8: unreportable text', () => {
  it('a line description or buyer name of only XML-invalid characters is refused before issuing', async () => {
    const app = setup();
    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const view = await app.createDraft({ customerId: customer.id, lines: [{ description: '￾', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    expect(view.readyToIssue).toBe(false);
    // Nothing to report to NAV – and nothing the PDF could print either.
    expect(view.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual(['LINE_DESCRIPTION_REQUIRED', 'PDF_UNPRINTABLE_CHARACTERS']);
    await expect(app.issue(view.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(app.findInvoices({ status: ['issued'] }).total).toBe(0);
    expect(() => app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, taxNumber: '11223346-1-06', name: '\u0002\u0003' })).toThrow(/A vevő neve kötelező/);
    expect(nav.requests).toEqual([]);
  });

  it('an issued invoice the report cannot be built of: error, and the hint does not send the user to a correction or storno', async () => {
    const app = setup();
    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const base = (await app.issue(view.invoice.id, { submitToNav: false })).invoice;
    // As an older version issued it, without today's check.
    const draft: Invoice = { ...base, id: 'inv_old0000000001', number: null, status: 'draft', issuedAt: null, contentHash: null, navStatus: 'not_applicable', navMessages: [], lines: base.lines.map((l) => ({ ...l, description: '￾' })) };
    app.store.insertDraft(draft);
    app.store.markIssued({ ...draft, status: 'issued', number: 'REGI-1', issuedAt: base.issuedAt, contentHash: 'test', navStatus: 'pending' });
    const res = (await app.navSync({ invoiceId: 'inv_old0000000001', waitSeconds: 0 }))[0];
    expect(res?.navStatus).toBe('error');
    const message = res?.messages[0]?.message ?? '';
    expect(res?.messages[0]?.code).toBe('NAV_DATA_INVALID');
    expect(message).toMatch(/tétel megnevezése.*programhiba/);
    expect(message).toMatch(/Ne állíts ki rá módosító vagy sztornó számlát/);
    expect(message).not.toMatch(/helyesbítő vagy sztornó számlával/);
    expect(nav.requests.filter((r) => r.operation === 'manageInvoice')).toEqual([]);
  });
});
