/**
 * NAV-10 through the service: a long invoice is reported gzip-compressed (compressedContent=true) – the data
 * signed, stored with the attempt and compared when reconciling are the same bytes –; an invoice whose report
 * would exceed NAV's limits cannot be issued; HTTP 413 is a permanent error, not an uncertain one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LineInput } from '../../src/service/inputs.ts';
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

function setup(opts: { now?: () => Date; fetch?: typeof fetch } = {}): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now: opts.now ?? (() => new Date()), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const lines = (n: number, description: (i: number) => string = (i) => `Napi szolgáltatás díja – ${i + 1}. tétel`): LineInput[] =>
  Array.from({ length: n }, (_, i) => ({ description: description(i), quantity: '1.5', unit: 'óra', unitPrice: '12345.67', vatCode: '27' }));

async function draftOf(app: OpenSzamla, n: number, description?: (i: number) => string) {
  const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  return app.createDraft({ customerId: customer.id, lines: lines(n, description) });
}

describe('NAV-10: long invoices', () => {
  it('a report over 1 MB goes out compressed, NAV validates it and accepts it; what is stored is what was sent', async () => {
    const app = setup();
    const view = await draftOf(app, 1000);
    expect(view.readyToIssue).toBe(true);
    const r = await app.issue(view.invoice.id);
    expect(r.invoice.navStatus, JSON.stringify(r.invoice.navMessages)).toBe('done');
    const received = nav.invoices[0];
    expect(received).toMatchObject({ compressed: true, invoiceStatus: 'DONE', technical: [] });
    expect(nav.requests.find((q) => q.operation === 'manageInvoice')?.requestXml).toContain('<compressedContent>true</compressedContent>');
    const sub = app.store.listNavSubmissions(r.invoice.id)[0];
    expect(sub?.invoiceDataBase64).toBe(received?.invoiceDataBase64);
    expect((sub?.invoiceDataBase64.length ?? 0) < 200_000).toBe(true);
  }, 60_000);

  it('a lost answer of a compressed submission is reconciled from the transaction list – nothing is sent again', async () => {
    let at = Date.now();
    nav.setNow(() => new Date(at)); // time passes for NAV too
    const app = setup({ now: () => new Date(at) });
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const r = await app.issue((await draftOf(app, 1000)).invoice.id);
    expect(r.invoice.navStatus).toBe('pending');
    at += 6 * 60_000;
    expect((await app.navSync({ waitSeconds: 1 }))[0]?.navStatus).toBe('done');
    expect(nav.requests.filter((q) => q.operation === 'manageInvoice')).toHaveLength(1);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['done']);
  }, 60_000);

  it('a draft whose report would exceed 15 MB cannot be issued (NAV_REPORT_TOO_LARGE)', async () => {
    const app = setup();
    const view = await draftOf(app, 4000, (i) => `${'"'.repeat(500)} ${i}`);
    expect(view.readyToIssue).toBe(false);
    const issue = view.issues.find((i) => i.code === 'NAV_REPORT_TOO_LARGE');
    expect(issue).toMatchObject({ severity: 'error', field: 'lines' });
    expect(issue?.message).toMatch(/legfeljebb 15,0 MB.*Ennyi tétellel \(4000\) a számla nem jelenthető a NAV-nak: oszd több számlára/);
    await expect(app.issue(view.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(app.findInvoices({ status: ['issued'] }).total).toBe(0);
  }, 60_000);

  it('HTTP 413 on reporting is a permanent error ("error"), not an uncertain submission', async () => {
    const tooLarge: typeof fetch = async (input, init) => (String(input).endsWith('/manageInvoice') ? new Response('Payload Too Large', { status: 413 }) : fetch(input, init));
    const app = setup({ fetch: tooLarge });
    const r = await app.issue((await draftOf(app, 2)).invoice.id);
    expect(r.invoice.navStatus).toBe('error');
    expect(r.invoice.navMessages.map((m) => m.code)).toEqual(['HTTP_413']);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => s.status)).toEqual(['error']);
  });
});
