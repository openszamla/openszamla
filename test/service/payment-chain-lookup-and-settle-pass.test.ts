/**
 * EX6: the payment chain of an invoice (its original and the original's issued modifications – recordPayment,
 * openAmount, settling after a modification) is found through the original_invoice_id index, not by walking every
 * issued document through the status index. The one-time pass that settles the chains stored by older versions
 * (settleStoredPaymentChains, on the first start of a database without its key) reads its key again inside each
 * transaction – a pass another process finished meanwhile is not repeated – and settles in short batches, so no
 * other process waits for the whole pass. Since the payment ledger (schema 4) the chains of an older database are
 * settled by the pass that takes its logged payments into the ledger (backfillPaymentLedger) – the same way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry, Invoice } from '../../src/core/types.ts';
import { Store, type NewAuditEntry } from '../../src/db/store.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type AppConfig } from '../../src/service/config.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, FIXED_NOW, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { bestOf, lowestRatios, writeIssuedCopies } from '../helpers/bulk-documents.ts';

const KEY = 'paymentChainsSettled';
/** The key of the one-time pass that takes the logged payments into the payment ledger (backfillPaymentLedger). */
const LEDGER_KEY = 'paymentLedger';
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const line = (description: string, unitPrice: string): LineInput => ({ description, quantity: '1', unit: 'db', unitPrice, vatCode: '27' });

/**
 * A database with `chains` invoice chains as an older version left them – the buyer paid the corrected total
 * (152 400 Ft) on the original, the modification (+25 400 Ft) still stored as unpaid: settled, it is paid – and
 * `unrelated` other issued documents. The pass has not run (its key is removed). Returns its folder and one chain.
 */
async function olderDatabase(chains: number, unrelated: number): Promise<{ t: TestApp; config: AppConfig; original: Invoice; modification: Invoice }> {
  const t = makeTestApp({ confirmMode: 'none' });
  cleanups.push(() => t.cleanup());
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const original = (await app.issue((await app.createDraft({ customerId, lines: [line('Gép', '100000')] })).invoice.id)).invoice;
  const modification = (await app.issue((await app.createCorrectionDraft(original.id, { lines: [line('Pótdíj', '20000')], comment: 'pótdíj' })).invoice.id)).invoice;
  writeIssuedCopies(app, original, unrelated, 'U');
  const originals = writeIssuedCopies(app, original, chains, 'O');
  for (const [n, o] of originals.entries()) {
    writeIssuedCopies(app, modification, 1, `M${n}`, (m) => {
      m.reference = { ...(m.reference as NonNullable<Invoice['reference']>), originalInvoiceId: o.id, originalInvoiceNumber: o.number as string };
    });
  }
  app.store.tx(() => {
    for (const o of originals) {
      app.store.patchInvoice(o.id, { paidAmount: '152400', paymentStatus: 'paid', paidDate: '2026-10-27' });
      // …with its log entry, as every version wrote it with the payment: the payment ledger takes the payment over from it.
      app.store.audit({ actor: 'mcp', action: 'invoice.payment', entityType: 'invoice', entityId: o.id, details: { number: o.number, amount: '152400', date: '2026-10-27', paymentStatus: 'paid' } });
    }
  });
  app.store.setSetting(KEY, null);
  app.store.setSetting(LEDGER_KEY, null);
  const config = app.config;
  app.close();
  return { t, config, original, modification };
}

/** The system's 'invoice.payment.status' entries: one per chain the pass settled. */
function settledEntries(app: OpenSzamla): AuditEntry[] {
  return app.auditLog({ limit: 100_000 }).items.filter((e) => e.action === 'invoice.payment.status' && e.actor === 'system');
}

describe('the payment chain is found through the original_invoice_id index (EX6)', () => {
  it('openAmount and the one-time pass cost the same with 10× the unrelated documents', async () => {
    /** A database with `unrelated` other documents; the returned function times openAmount and the pass on it. */
    const prepare = async (unrelated: number): Promise<() => Promise<{ open: number; pass: number }>> => {
      const db = await olderDatabase(30, unrelated);
      const opened = (): OpenSzamla => OpenSzamla.open({ config: db.config, now: () => FIXED_NOW });
      return async () => {
        const pass = await bestOf(3, () => {
          const store = new Store({ path: db.config.dbPath, now: () => FIXED_NOW });
          store.setSetting(KEY, null);
          store.close();
          opened().close();
        });
        const app = opened();
        try {
          const original = app.getInvoice(db.original.id);
          return { open: await bestOf(20, () => app.openAmount(original)), pass };
        } finally {
          app.close();
        }
      };
    };
    const small = await prepare(300);
    const large = await prepare(3000);
    // Through the index both stay flat; walking the issued documents makes them about 10× as costly.
    const LIMITS = { open: 4, pass: 4 };
    const { lowest, measured } = await lowestRatios(LIMITS, async () => {
      const s = await small();
      const l = await large();
      return { open: l.open / s.open, pass: l.pass / s.pass };
    });
    for (const k of ['open', 'pass'] as const) expect(lowest[k], `${k}: ${JSON.stringify(measured)}`).toBeLessThan(LIMITS[k]);
  });
});

describe('the one-time chain pass (EX6)', () => {
  it('settles every chain, in short transactions', async () => {
    const db = await olderDatabase(120, 0);
    const store = new Store({ path: db.config.dbPath, now: () => FIXED_NOW });
    // Which top-level transaction each settled status was logged in.
    let depth = 0;
    let transactions = 0;
    const loggedIn: number[] = [];
    const tx = store.tx.bind(store);
    store.tx = <T>(fn: () => T): T => {
      if (depth === 0) transactions++;
      depth++;
      try {
        return tx(fn);
      } finally {
        depth--;
      }
    };
    const audit = store.audit.bind(store);
    store.audit = (entry: NewAuditEntry): AuditEntry => {
      if (entry.action === 'invoice.payment.status') loggedIn.push(transactions);
      return audit(entry);
    };
    const app = new OpenSzamla(store, db.config, { now: () => FIXED_NOW });
    cleanups.push(() => app.close());

    expect(settledEntries(app)).toHaveLength(120);
    expect(app.store.getSetting(KEY)).toBe(1);
    const perTransaction = [...new Set(loggedIn)].map((n) => loggedIn.filter((m) => m === n).length);
    expect(perTransaction.length, JSON.stringify(perTransaction)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...perTransaction), JSON.stringify(perTransaction)).toBeLessThanOrEqual(50);
    // Settled as one chain: the overpayment on the original covers the modification.
    expect(app.getInvoice(db.modification.id).paymentStatus).toBe('unpaid'); // the template chain was not touched (paid nothing)
    expect(app.findInvoices({ documentType: ['modification'], paymentStatus: ['paid'], limit: 1 }).total).toBe(120);
  });

  it('a pass another process finished meanwhile is not repeated (the key is read again inside the transaction)', async () => {
    const db = await olderDatabase(5, 0);
    const store = new Store({ path: db.config.dbPath, now: () => FIXED_NOW });
    // Another process finishes the pass (here: sets its key) right before this one's first transaction.
    const tx = store.tx.bind(store);
    let first = true;
    store.tx = <T>(fn: () => T): T => {
      if (first) {
        first = false;
        const other = new Store({ path: db.config.dbPath, now: () => FIXED_NOW });
        other.setSetting(KEY, 1);
        other.setSetting(LEDGER_KEY, 1);
        other.close();
      }
      return tx(fn);
    };
    const app = new OpenSzamla(store, db.config, { now: () => FIXED_NOW });
    cleanups.push(() => app.close());
    expect(settledEntries(app)).toEqual([]);
    expect(app.findInvoices({ documentType: ['modification'], paymentStatus: ['paid'], limit: 1 }).total).toBe(0);
  });
});
