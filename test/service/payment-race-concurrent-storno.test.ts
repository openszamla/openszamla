/**
 * EX2: recordPayment checks the document again inside its transaction. Process A cancels SZ-2026-00001 while process
 * B records a 127 000 Ft payment on it: B read the invoice before A's storno committed, and its transaction starts
 * after it. The payment must be refused as on any cancelled invoice ("Sztornózott számlára nem rögzíthető fizetés."),
 * not recorded on the cancelled invoice (where it could never be reversed).
 *
 * Deterministic: two connections in one process; A's cancel runs synchronously up to its commit, started from B's
 * transaction call – after B's first read, before B's transaction.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors.ts';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, FIXED_NOW, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function otherProcess(dir: string): OpenSzamla {
  const app = OpenSzamla.open({ config: loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'code', navWaitSeconds: 3 } }), now: () => FIXED_NOW });
  cleanups.push(() => app.close());
  return app;
}

/** Runs `between` once, when `app` opens its next transaction (after its reads before it). */
function beforeNextTransaction(app: OpenSzamla, between: () => void): void {
  const tx = app.store.tx.bind(app.store);
  let fired = false;
  app.store.tx = <T>(fn: () => T): T => {
    if (!fired) {
      fired = true;
      between();
    }
    return tx(fn);
  };
}

async function issuedInvoice(app: OpenSzamla): Promise<Invoice> {
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
  return (await app.issue(d.invoice.id)).invoice;
}

describe('a payment racing a storno (EX2)', () => {
  it('is refused when the storno commits between the first check and the payment transaction', async () => {
    const t: TestApp = makeTestApp();
    cleanups.push(() => t.cleanup());
    const original = await issuedInvoice(t.app);
    const b = otherProcess(t.dir);
    let cancelling: Promise<unknown> | null = null;
    beforeNextTransaction(b, () => {
      cancelling = t.app.cancel(original.id, { reason: 'hibás számla' });
    });

    let refused: unknown = null;
    try {
      b.recordPayment(original.id, { amount: '127000' });
    } catch (e) {
      refused = e;
    }
    await cancelling;
    expect(isAppError(refused) ? `${refused.code}: ${refused.message}` : refused).toBe('INVALID_INPUT: Sztornózott számlára nem rögzíthető fizetés.');
    const now = b.getInvoice(original.id);
    expect(`${now.status} ${now.paymentStatus} ${now.paidAmount} ${now.paidDate}`).toBe('cancelled unpaid 0 null');
    expect(b.auditLog({ entityId: original.id }).items.filter((e) => e.action === 'invoice.payment')).toEqual([]);
  });

  it('a storno racing a payment on itself: refused the same way', async () => {
    const t: TestApp = makeTestApp();
    cleanups.push(() => t.cleanup());
    const original = await issuedInvoice(t.app);
    const storno = (await t.app.cancel(original.id, { reason: 'hibás számla' })).invoice;
    // The storno is read as a storno already; checked again inside the transaction with the same message.
    expect(() => t.app.recordPayment(storno.id, { amount: '-127000' })).toThrow('Sztornó számlára nem rögzíthető fizetés.');
  });
});
