/**
 * EX7: the receivables of report_summary in HUF. A foreign-currency document nothing of which is settled counts with
 * its own HUF gross (totals.grossAmountHuf: the sum of its lines' HUF values, 5.2) – not gross × rate, which differs by
 * a few fillér and has up to 4–8 decimals; a partly paid one with its open part at its rate, rounded to 0.01 Ft. A
 * forint document counts with what is open on it (a cash invoice: its rounded payable amount). The sums have at most
 * 2 decimals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { dec, roundDec, sumDec, toDec } from '../../src/core/decimal.ts';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const line = (description: string, quantity: string, unitPrice: string): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27' });

async function issue(app: OpenSzamla, customerId: string, input: { currency: string; exchangeRate?: string; paymentMethod?: 'TRANSFER' | 'CASH'; lines: LineInput[] }): Promise<Invoice> {
  return (await app.issue((await app.createDraft({ customerId, ...input })).invoice.id)).invoice;
}

describe('receivables in HUF with foreign-currency documents (EX7)', () => {
  it('EUR and JPY: the HUF gross of an unpaid document, the rounded open part of a partly paid one', async () => {
    let now = new Date('2026-11-12T09:00:00.000Z');
    t = makeTestApp({ confirmMode: 'none', now: () => now });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    // JPY (0 decimals): 3 × 3 333.5 → 10 001 JPY a line; 1 JPY = 2.3657 HUF.
    const jpy = await issue(app, customerId, { currency: 'JPY', exchangeRate: '2.3657', lines: [line('Service', '3', '3333.5'), line('Goods', '1', '10001')] });
    expect(jpy.totals.grossAmount).toBe('25402');
    expect(jpy.totals.grossAmountHuf).toBe('60093.52');
    // gross × rate would be 60093.5114: not the document's HUF gross.
    expect(toDec(dec(jpy.totals.grossAmount).times(jpy.exchangeRate))).toBe('60093.5114');
    // EUR, partly paid: 50 of 126.99 EUR.
    const eur = await issue(app, customerId, { currency: 'EUR', exchangeRate: '391.2345', lines: [line('Tanácsadás', '3', '33.33')] });
    expect(eur.totals.grossAmount).toBe('126.99');
    app.recordPayment(eur.id, { amount: '50' });
    // A forint cash invoice: what is open is its payable amount, rounded to 0/5 Ft.
    const cash = await issue(app, customerId, { currency: 'HUF', paymentMethod: 'CASH', lines: [line('Alkatrész', '1', '999')] });
    expect([cash.totals.grossAmount, cash.totals.payableAmount]).toEqual(['1269', '1270']);

    const eurOpen = toDec(roundDec(dec('76.99').times('391.2345'), 2));
    expect(eurOpen).toBe('30121.14');
    const expected = toDec(sumDec([jpy.totals.grossAmountHuf, eurOpen, '1270']));
    const today = app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables;
    expect(today).toEqual({ unpaidCount: 3, unpaidGrossHuf: expected, overdueCount: 0, overdueGrossHuf: '0' });
    expect(expected).toBe('91484.66');

    // Overdue later: the same amounts.
    now = new Date('2026-12-15T09:00:00.000Z');
    expect(app.report({ from: '2026-12-01', to: '2026-12-31' }).receivables).toEqual({ unpaidCount: 3, unpaidGrossHuf: expected, overdueCount: 3, overdueGrossHuf: expected });
  });

  it('every HUF amount has at most 2 decimals', async () => {
    t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-12T09:00:00.000Z') });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    for (const [rate, price] of [['391.234567', '19.99'], ['387.1', '0.07'], ['402.55555', '1234.56']] as const) {
      const inv = await issue(app, customerId, { currency: 'EUR', exchangeRate: rate, lines: [line('Tétel', '7', price)] });
      app.recordPayment(inv.id, { amount: '0.03' });
    }
    const r = app.report({ from: '2026-11-01', to: '2026-11-30' }).receivables;
    expect(r.unpaidCount).toBe(3);
    expect(r.unpaidGrossHuf).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});
