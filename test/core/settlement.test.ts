/** Settling an invoice chain (an original and its issued modifications) together – MCP-6. */
import { describe, expect, it } from 'vitest';
import { settleChain, type SettlementDoc } from '../../src/core/settlement.ts';

const doc = (id: string, payable: string, paid = '0'): SettlementDoc => ({ id, payable, paid });
const of = (docs: SettlementDoc[]): Record<string, string> =>
  Object.fromEntries([...settleChain(docs)].map(([id, s]) => [id, `${s.status} ${s.open}`]));

describe('settleChain', () => {
  it('a single document is settled by its own payments (the per-document rule)', () => {
    expect(of([doc('o', '194700')])).toEqual({ o: 'unpaid 194700' });
    expect(of([doc('o', '194700', '4000')])).toEqual({ o: 'partial 190700' });
    expect(of([doc('o', '194700', '194700')])).toEqual({ o: 'paid 0' });
    expect(of([doc('o', '194700', '200000')])).toEqual({ o: 'paid 0' }); // overpaid
    expect(of([doc('c', '-12700', '-5000')])).toEqual({ c: 'partial -7700' }); // a refund in part
  });

  it('a credit note is set off against what is owed on its original: paying the corrected total settles both', () => {
    // 190 500 Ft, crediting modification −38 100 Ft, the buyer pays the corrected 152 400 Ft.
    expect(of([doc('o', '190500', '152400'), doc('c', '-38100')])).toEqual({ o: 'paid 0', c: 'paid 0' });
    // Nothing paid yet: the credit lowers what is owed; the credit note itself is settled by the set-off.
    expect(of([doc('o', '190500'), doc('c', '-38100')])).toEqual({ o: 'unpaid 152400', c: 'paid 0' });
    // A partial payment: the rest of the corrected total is open.
    expect(of([doc('o', '190500', '100000'), doc('c', '-38100')])).toEqual({ o: 'partial 52400', c: 'paid 0' });
    // A full credit: nothing is owed on the chain.
    expect(of([doc('o', '25400'), doc('c', '-25400')])).toEqual({ o: 'paid 0', c: 'paid 0' });
  });

  it('paid in full before the credit: the credit is a refund still owed to the buyer, until it is recorded', () => {
    expect(of([doc('o', '190500', '190500'), doc('c', '-38100')])).toEqual({ o: 'paid 0', c: 'unpaid -38100' });
    expect(of([doc('o', '190500', '190500'), doc('c', '-38100', '-38100')])).toEqual({ o: 'paid 0', c: 'paid 0' });
  });

  it('an overpayment of the original covers an upward modification; each document can also be paid on its own', () => {
    expect(of([doc('o', '100000', '120000'), doc('u', '20000')])).toEqual({ o: 'paid 0', u: 'paid 0' });
    expect(of([doc('o', '100000'), doc('u', '20000')])).toEqual({ o: 'unpaid 100000', u: 'unpaid 20000' });
    expect(of([doc('o', '100000', '100000'), doc('u', '20000')])).toEqual({ o: 'paid 0', u: 'unpaid 20000' });
    expect(of([doc('o', '100000'), doc('u', '20000', '20000')])).toEqual({ o: 'unpaid 100000', u: 'paid 0' });
    // A credit and an upward correction together: the credit lowers the original first.
    expect(of([doc('o', '100000'), doc('c', '-20000'), doc('u', '30000')])).toEqual({ o: 'unpaid 80000', c: 'paid 0', u: 'unpaid 30000' });
    expect(of([doc('o', '100000', '110000'), doc('c', '-20000'), doc('u', '30000')])).toEqual({ o: 'paid 0', c: 'paid 0', u: 'paid 0' });
  });

  it('a refund beyond the credit first uses up credit not yet refunded, then reopens what the buyer owes', () => {
    // Refunded 50 000 Ft on a 38 100 Ft credit after full payment: the buyer owes 11 900 Ft again.
    expect(of([doc('o', '190500', '190500'), doc('c', '-38100', '-50000')])).toEqual({ o: 'partial 11900', c: 'paid 0' });
    // Nothing paid, 30 000 Ft refunded on credits of 20 000 + 10 000: the whole original is owed.
    expect(of([doc('o', '100000'), doc('c1', '-20000', '-30000'), doc('c2', '-10000')])).toEqual({ o: 'unpaid 100000', c1: 'paid 0', c2: 'paid 0' });
  });

  it('decimals (foreign currency) stay exact; 0 Ft documents take no part', () => {
    expect(of([doc('o', '1000.5', '700.25'), doc('c', '-200.1')])).toEqual({ o: 'partial 100.15', c: 'paid 0' });
    expect(of([doc('o', '100', '100'), doc('z', '0')])).toEqual({ o: 'paid 0' });
  });
});
