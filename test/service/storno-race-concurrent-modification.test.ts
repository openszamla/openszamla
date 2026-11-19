/**
 * EX1: a storno is made from the invoice chain as it is inside its issuing transaction. Two processes share one data
 * folder (e.g. `openszamla serve` and an MCP agent): B cancels SZ-2026-00001 while A issues a modification of it. B
 * made its storno draft from the chain without the modification; A's modification commits before B's issue
 * transaction. The storno must still negate the original AND the modification (the chain totals 0), or – when B's
 * confirmation was made for the earlier chain – be refused (STORNO_CHAIN_CHANGED) so it can be confirmed anew.
 *
 * Deterministic: two connections in one process (two OpenSzamla instances on one database file); A's issue runs
 * synchronously up to its commit, started from B's insertDraft of the storno draft – exactly between B's read of the
 * chain and B's issue transaction.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { sumDec, toDec } from '../../src/core/decimal.ts';
import type { Invoice, InvoiceLine } from '../../src/core/types.ts';
import { validateInvoice } from '../../src/core/validate.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT, FIXED_NOW, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { flashesOf, hiddenValue, startWeb, type WebEnv } from '../web/helpers.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const line = (description: string, unitPrice: string): LineInput => ({ description, quantity: '1', unit: 'db', unitPrice, vatCode: '27' });

/** Another process on the same data folder: its own connection to the same database file. */
function otherProcess(dir: string): OpenSzamla {
  const app = OpenSzamla.open({ config: loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'code', navWaitSeconds: 3 } }), now: () => FIXED_NOW });
  cleanups.push(() => app.close());
  return app;
}

/** The original (Gép, 127 000 Ft gross) and a modification draft of it (Pótdíj, +25 400 Ft), made in `app`. */
async function invoiceWithModificationDraft(app: OpenSzamla): Promise<{ original: Invoice; modification: string }> {
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const original = (await app.issue((await app.createDraft({ customerId, lines: [line('Gép', '100000')] })).invoice.id)).invoice;
  const modification = (await app.createCorrectionDraft(original.id, { lines: [line('Pótdíj', '20000')], comment: 'pótdíj' })).invoice.id;
  return { original, modification };
}

/**
 * Makes `other` issue the modification right after `app` stored its storno draft – after `app` read the chain for
 * it, before its issue transaction. Returns the pending rest of that issue (PDF), to be awaited.
 */
function issueBetweenDraftAndIssue(app: OpenSzamla, other: OpenSzamla, modificationId: string): { done(): Promise<unknown> } {
  let pending: Promise<unknown> | null = null;
  const insertDraft = app.store.insertDraft.bind(app.store);
  app.store.insertDraft = (inv: Invoice): void => {
    insertDraft(inv);
    if (inv.documentType === 'storno' && pending === null) pending = other.issue(modificationId);
  };
  return { done: async () => pending };
}

const chainOf = (app: OpenSzamla, original: Invoice): Invoice[] => app.findInvoices({ originalInvoiceId: original.id, status: ['issued', 'cancelled'], sort: 'issued_asc', limit: 50 }).items;
const descriptions = (lines: InvoiceLine[]): string[] => lines.map((l) => `${l.description}:${l.grossAmount}`);

describe('a storno negates the chain as it is when it is issued (EX1)', () => {
  it('a modification another process issued after the storno draft was made is negated too', async () => {
    const t: TestApp = makeTestApp();
    cleanups.push(() => t.cleanup());
    const { original, modification } = await invoiceWithModificationDraft(t.app);
    const b = otherProcess(t.dir);
    const race = issueBetweenDraftAndIssue(b, t.app, modification);

    const r = await b.cancel(original.id, { reason: 'hibás számla' });
    await race.done();

    const mod = t.app.getInvoice(modification);
    expect(mod.status).toBe('issued');
    expect(mod.reference?.modificationIndex).toBe(1);
    const storno = r.invoice;
    expect(storno.documentType).toBe('storno');
    expect(storno.reference?.modificationIndex).toBe(2);
    expect(descriptions(storno.lines)).toEqual(['Gép:-127000', 'Pótdíj:-25400']);
    expect(storno.totals.grossAmount).toBe('-152400');
    // NAV line numbers continue after the modification's line (3).
    expect(storno.lines.map((l) => l.modificationRef?.lineNumberReference)).toEqual([3, 4]);
    const docs = [b.getInvoice(original.id), ...chainOf(b, original)];
    expect(docs.map((d) => `${d.number} ${d.documentType} ${d.status}`)).toEqual([
      'SZ-2026-00001 invoice cancelled',
      'SZ-2026-00002 modification issued',
      'SZ-2026-00003 storno issued',
    ]);
    expect(toDec(sumDec(docs.map((d) => d.totals.grossAmount)))).toBe('0');
    const report = b.report({ from: b.today(), to: b.today() });
    expect(report.totalsHuf).toEqual({ net: '0', vat: '0', gross: '0' });
  });

  it('a storno confirmed for the earlier chain is refused (STORNO_CHAIN_CHANGED), and goes through confirmed anew', async () => {
    const t: TestApp = makeTestApp();
    cleanups.push(() => t.cleanup());
    const { original, modification } = await invoiceWithModificationDraft(t.app);
    const b = otherProcess(t.dir);
    const reason = b.cancelReason(original.id, 'hibás számla');
    const confirmed = b.cancelFingerprint(original.id, reason);
    const race = issueBetweenDraftAndIssue(b, t.app, modification);

    const refused = await b.cancel(original.id, { reason, confirmedFingerprint: confirmed }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string; hint?: string },
    );
    await race.done();
    expect(refused?.code).toBe('STORNO_CHAIN_CHANGED');
    expect(refused?.message).toBe(
      'A(z) SZ-2026-00001 számla sztornója nem készült el: a jóváhagyott előnézet óta megváltozott, amit a sztornó semlegesít – közben módosító számla készült a számlához, megváltoztak az eladó adatai, vagy új nap kezdődött.',
    );
    expect(refused?.hint).toBe('Kérj új sztornó-előnézetet, ellenőrizd az új összeget, és a jóváhagyás után próbáld újra az új megerősítéssel.');
    // Nothing was issued, and the storno draft is gone: the invoice is in force with its modification.
    expect(b.getInvoice(original.id).status).toBe('issued');
    expect(chainOf(b, original).map((d) => d.documentType)).toEqual(['modification']);
    expect(b.findInvoices({ status: ['draft'], documentType: ['storno'], limit: 10 }).total).toBe(0);

    // The new preview shows the storno of the whole chain; confirmed for it, it is issued.
    const preview = b.stornoPreview(original.id, reason);
    expect(preview.storno.totals.grossAmount).toBe('-152400');
    const r = await b.cancel(original.id, { reason, confirmedFingerprint: b.cancelFingerprint(original.id, reason) });
    expect(r.invoice.totals.grossAmount).toBe('-152400');
    expect(b.getInvoice(original.id).status).toBe('cancelled');
  });

  it('invoice_cancel with a confirmation code: refused when the chain changed after the code was checked', async () => {
    const t: TestApp = makeTestApp({ confirmMode: 'code' });
    cleanups.push(() => t.cleanup());
    const { original, modification } = await invoiceWithModificationDraft(t.app);
    const b = otherProcess(t.dir);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(b, { confirmMode: 'code' }), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: Record<string, any> }> => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
      return { isError: res.isError === true, data: res.structuredContent ?? {} };
    };

    const preview = await call('invoice_cancel_preview', { invoice: original.number, reason: 'hibás számla' });
    expect(preview.data.storno.gross).toBe('-127000');
    const race = issueBetweenDraftAndIssue(b, t.app, modification);
    const refused = await call('invoice_cancel', { invoice: original.number, reason: 'hibás számla', confirmationCode: preview.data.confirmationCode });
    await race.done();
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe('STORNO_CHAIN_CHANGED');
    expect(b.getInvoice(original.id).status).toBe('issued');

    const again = await call('invoice_cancel_preview', { invoice: original.number, reason: 'hibás számla' });
    expect(again.data.storno.gross).toBe('-152400');
    expect(again.data.storno.negates.map((m: { number: string }) => m.number)).toEqual(['SZ-2026-00002']);
    const done = await call('invoice_cancel', { invoice: original.number, reason: 'hibás számla', confirmationCode: again.data.confirmationCode });
    expect(done.isError).toBe(false);
    expect(done.data.invoice.gross).toBe('-152400');
  });

  it('the web storno: refused with the reason when the chain changed after its confirmation', async () => {
    const e: WebEnv = await startWeb({ now: () => FIXED_NOW });
    cleanups.push(() => e.close());
    const { original, modification } = await invoiceWithModificationDraft(e.app);
    const a = otherProcess(e.t.dir);
    const browser = await e.loggedIn();
    const preview = await browser.post(`/invoices/${original.id}/cancel-preview`, { reason: 'hibás számla' });
    const confirmation = hiddenValue(preview.body, 'confirmation') ?? '';
    expect(confirmation).not.toBe('');
    // The modification draft was made by the web's process; another process issues it.
    const race = issueBetweenDraftAndIssue(e.app, a, modification);
    const r = await browser.post(`/invoices/${original.id}/cancel`, { reason: 'hibás számla', confirmation, confirm: 'yes' });
    await race.done();
    expect(r.status).toBe(303);
    const page = await browser.follow(r);
    expect(flashesOf(page.body)).toContain('A(z) SZ-2026-00001 számla sztornója nem készült el: a jóváhagyott előnézet óta megváltozott, amit a sztornó semlegesít');
    expect(e.app.getInvoice(original.id).status).toBe('issued');
    expect(a.getInvoice(modification).status).toBe('issued');
  });
});

describe('STORNO_CHAIN_MISMATCH: a storno must negate the original and its issued modifications (EX1)', () => {
  /** An issued modification of INVOICE_DOMESTIC with one 27% difference: net, VAT, gross. */
  const issuedModification = (net: string, vat: string, gross: string): Invoice => {
    return {
      ...INVOICE_DOMESTIC,
      id: 'inv_mod0000001',
      documentType: 'modification',
      number: 'SZ-2026-00002',
      reference: { originalInvoiceId: INVOICE_DOMESTIC.id, originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false },
      totals: {
        ...INVOICE_DOMESTIC.totals,
        netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross,
        byVat: [{ vatCode: '27', netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross }],
        payableAmount: gross,
      },
    };
  };
  const storno: Invoice = { ...INVOICE_STORNO, reference: { ...(INVOICE_STORNO.reference as NonNullable<Invoice['reference']>), modificationIndex: 2 } };
  const codes = (chain: Invoice[] | undefined): string[] =>
    validateInvoice(storno, { today: '2026-10-28', original: INVOICE_DOMESTIC, ...(chain ? { chain } : {}) }).filter((i) => i.severity === 'error').map((i) => i.code);

  it('is an error when a modification of the chain is not negated', () => {
    expect(codes([])).toEqual([]);
    expect(codes([issuedModification('0', '0', '0')])).toEqual([]);
    expect(codes([issuedModification('20000', '5400', '25400')])).toEqual(['STORNO_CHAIN_MISMATCH']);
    const issue = validateInvoice(storno, { today: '2026-10-28', original: INVOICE_DOMESTIC, chain: [issuedModification('20000', '5400', '25400')] }).find((i) => i.code === 'STORNO_CHAIN_MISMATCH');
    expect(issue?.message).toBe(
      'A sztornó számla 27 ÁFA-kódú nettó összege (-150000 HUF) nem ellentéte az eredeti számla és kiállított módosító számlái együttes összegének (170000 HUF): a sztornónak az egész számlát semlegesítenie kell. Kérj új sztornó-előnézetet, és sztornózd újra.',
    );
    // Without the chain (not known) nothing is checked.
    expect(codes(undefined)).toEqual([]);
  });
});
