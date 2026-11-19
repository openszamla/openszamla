/**
 * A payment the document could not hold is refused: more decimals than its amounts have (100.123456 Ft would leave a
 * hátralék of 31 650.876544 Ft that no payment can settle; EUR amounts have two), and a payment date after today (it would
 * put the payment – with cash accounting its VAT too – into a later period). Nothing is recorded; the hint says what to do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function issued(currency: 'HUF' | 'EUR'): Promise<{ app: OpenSzamla; inv: Invoice }> {
  t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-14T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const lines = [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: currency === 'HUF' ? '25000' : '100', vatCode: '27' as const }];
  const draft = await app.createDraft({ customerId, lines, currency, ...(currency === 'EUR' ? { exchangeRate: '390' } : {}) });
  return { app, inv: (await app.issue(draft.invoice.id)).invoice };
}

const refused = (fn: () => unknown): { code?: string; message?: string; hint?: string } => {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message?: string; hint?: string };
  }
  throw new Error('not refused');
};

describe('payment amount and date checks', () => {
  it('HUF: a payment with fillér is refused – the amounts of the document are whole forints', async () => {
    const { app, inv } = await issued('HUF');
    const e = refused(() => app.recordPayment(inv.id, { amount: '100.123456', date: '2026-11-14' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toBe('A befizetés összege egész szám legyen – a bizonylat összegei is egész forintok: 100.123456.');
    expect(e.hint).toBe('Pl. 12500 – fillér nélkül.');
    expect(app.getInvoice(inv.id)).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    // A whole amount, also written with trailing zeros, is taken.
    expect(app.recordPayment(inv.id, { amount: '10000.00', date: '2026-11-14' })).toMatchObject({ paymentStatus: 'partial', paidAmount: '10000' });
  });

  it('EUR: at most two decimals', async () => {
    const { app, inv } = await issued('EUR');
    const e = refused(() => app.recordPayment(inv.id, { amount: '10.125', date: '2026-11-13' }));
    expect(e.message).toBe('A befizetés összege legfeljebb 2 tizedesjegyű lehet (EUR), mint a bizonylat összegei: 10.125.');
    expect(app.recordPayment(inv.id, { amount: '10.12', date: '2026-11-13' })).toMatchObject({ paymentStatus: 'partial', paidAmount: '10.12' });
  });

  it('a payment date after today is refused; today and earlier days are taken', async () => {
    const { app, inv } = await issued('HUF');
    const e = refused(() => app.recordPayment(inv.id, { amount: '1000', date: '2026-11-15' }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toBe('A befizetés dátuma (2026.11.15.) későbbi a mai napnál (2026.11.14.).');
    expect(e.hint).toContain('pénzforgalmi elszámolásnál ez dönti el az ÁFA időszakát');
    expect(refused(() => app.recordPayment(inv.id, { amount: '1000', date: '2027-11-14' })).code).toBe('INVALID_INPUT');
    app.recordPayment(inv.id, { amount: '1000', date: '2026-11-14' });
    app.recordPayment(inv.id, { amount: '1000', date: '2026-10-01' });
    expect(app.getInvoice(inv.id).paidAmount).toBe('2000');
    expect(app.paymentHistory(inv.id).map((p) => p.date)).toEqual(['2026-10-01', '2026-11-14']);
  });
});
