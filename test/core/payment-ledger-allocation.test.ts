/**
 * EX8: the payment ledger of an invoice chain (settleLedger). Every payment is allocated to the documents of the chain as
 * settleChain distributes the money, by payment date (then in recording order); a document's paid amount is what was
 * allocated to it, its payment date the date of the payment that made it fully paid. The storno of a cancelled chain
 * refunds what the other documents received.
 */
import { describe, expect, it } from 'vitest';
import { dec } from '../../src/core/decimal.ts';
import { settleChain, settleLedger, type LedgerDoc, type LedgerPayment } from '../../src/core/settlement.ts';

const pay = (id: number, doc: string, date: string, amount: string): LedgerPayment => ({ id, doc, date, amount });
const allocations = (l: ReturnType<typeof settleLedger>): Record<number, Record<string, string>> =>
  Object.fromEntries([...l.allocations].map(([id, parts]) => [id, Object.fromEntries(parts)]));
const docs = (l: ReturnType<typeof settleLedger>): Record<string, string> =>
  Object.fromEntries([...l.documents].map(([id, s]) => [id, `${s.status} ${s.paid} ${s.paidDate ?? '-'}`]));

describe('settleLedger: allocations, paid amounts and payment dates (EX8)', () => {
  it('a payment of the corrected total on the original also pays the modification, which gets its date', () => {
    // 137 000 + an upward modification of 12 700; 50 000 on 11-20 and the rest on 12-05, both on the original.
    const chain: LedgerDoc[] = [{ id: 'o', payable: '137000' }, { id: 'm', payable: '12700' }];
    const l = settleLedger(chain, [pay(1, 'o', '2026-11-20', '50000'), pay(2, 'o', '2026-12-05', '99700')]);
    expect(allocations(l)).toEqual({ 1: { o: '50000' }, 2: { o: '87000', m: '12700' } });
    expect(docs(l)).toEqual({ o: 'paid 137000 2026-12-05', m: 'paid 12700 2026-12-05' });
    expect(l.recorded.get('o')).toBe('149700');
  });

  it('by payment date, not by recording order: the later payment recorded first', () => {
    const l = settleLedger([{ id: 'o', payable: '127000' }], [pay(1, 'o', '2026-12-08', '27000'), pay(2, 'o', '2026-11-20', '100000')]);
    expect(docs(l)).toEqual({ o: 'paid 127000 2026-12-08' });
    // The same payments on a chain: the earlier-dated one is allocated first.
    const chain = settleLedger([{ id: 'o', payable: '137000' }, { id: 'm', payable: '12700' }], [pay(1, 'o', '2026-12-05', '99700'), pay(2, 'o', '2026-11-20', '50000')]);
    expect(allocations(chain)).toEqual({ 1: { o: '87000', m: '12700' }, 2: { o: '50000' } });
    expect(docs(chain)).toEqual({ o: 'paid 137000 2026-12-05', m: 'paid 12700 2026-12-05' });
  });

  it('a payment on the modification beyond it covers the original first; an overpayment of the whole chain stays where it was paid', () => {
    const chain: LedgerDoc[] = [{ id: 'o', payable: '100000' }, { id: 'm', payable: '20000' }];
    expect(allocations(settleLedger(chain, [pay(1, 'm', '2026-11-20', '50000')]))).toEqual({ 1: { m: '20000', o: '30000' } });
    const over = settleLedger(chain, [pay(1, 'o', '2026-11-20', '150000')]);
    expect(allocations(over)).toEqual({ 1: { o: '130000', m: '20000' } });
    expect(docs(over)).toEqual({ o: 'paid 130000 2026-11-20', m: 'paid 20000 2026-11-20' });
  });

  it('a reversal takes back what reached the other documents first; a refund beyond a credit reopens the original', () => {
    const chain: LedgerDoc[] = [{ id: 'o', payable: '137000' }, { id: 'm', payable: '12700' }];
    const l = settleLedger(chain, [pay(1, 'o', '2026-11-20', '149700'), pay(2, 'o', '2026-11-21', '-50000')]);
    expect(allocations(l)).toEqual({ 1: { o: '137000', m: '12700' }, 2: { m: '-12700', o: '-37300' } });
    expect(docs(l)).toEqual({ o: 'partial 99700 -', m: 'unpaid 0 -' });
    // Paid in full, then 50 000 refunded on a 38 100 credit note: 11 900 of the original's money went back too.
    const credit = settleLedger([{ id: 'o', payable: '190500' }, { id: 'c', payable: '-38100' }], [pay(1, 'o', '2026-11-20', '190500'), pay(2, 'c', '2026-11-25', '-50000')]);
    expect(allocations(credit)).toEqual({ 1: { o: '190500' }, 2: { o: '-11900', c: '-38100' } });
    expect(docs(credit)).toEqual({ o: 'partial 178600 -', c: 'paid -38100 2026-11-25' });
  });

  it('a credit note set off against what is owed is settled without a payment, so without a date; a refund gives it one', () => {
    const chain: LedgerDoc[] = [{ id: 'o', payable: '190500' }, { id: 'c', payable: '-38100' }];
    expect(docs(settleLedger(chain, [pay(1, 'o', '2026-11-21', '152400')]))).toEqual({ o: 'paid 152400 2026-11-21', c: 'paid 0 -' });
    expect(docs(settleLedger(chain, [pay(1, 'o', '2026-11-21', '190500'), pay(2, 'c', '2026-11-28', '-38100')]))).toEqual({ o: 'paid 190500 2026-11-21', c: 'paid -38100 2026-11-28' });
  });

  it('the date is when it became – and stayed – fully paid; reopened by a reversal, the date goes', () => {
    const one: LedgerDoc[] = [{ id: 'o', payable: '127000' }];
    expect(docs(settleLedger(one, [pay(1, 'o', '2026-11-18', '200000'), pay(2, 'o', '2026-11-19', '-73000')]))).toEqual({ o: 'paid 127000 2026-11-18' });
    expect(docs(settleLedger(one, [pay(1, 'o', '2026-11-18', '127000'), pay(2, 'o', '2026-11-19', '-7000'), pay(3, 'o', '2026-11-30', '7000')]))).toEqual({ o: 'paid 127000 2026-11-30' });
    expect(docs(settleLedger(one, [pay(1, 'o', '2026-11-18', '127000'), pay(2, 'o', '2026-11-19', '-7000')]))).toEqual({ o: 'partial 120000 -' });
  });

  it('a 0 Ft document is paid once marked; the storno refunds what its cancelled chain received', () => {
    expect(docs(settleLedger([{ id: 'o', payable: '100' }, { id: 'z', payable: '0' }], [pay(1, 'z', '2026-11-25', '0')]))).toEqual({ o: 'unpaid 0 -', z: 'paid 0 2026-11-25' });
    const chain: LedgerDoc[] = [{ id: 'o', payable: '254000' }, { id: 's', payable: '-254000', storno: true }];
    const before = settleLedger(chain, [pay(1, 'o', '2026-12-06', '100000')]);
    expect([docs(before), before.received, before.documents.get('s')?.open]).toEqual([{ o: 'partial 100000 -', s: 'unpaid 0 -' }, '100000', '-100000']);
    const part = settleLedger(chain, [pay(1, 'o', '2026-12-06', '100000'), pay(2, 's', '2026-12-08', '-40000')]);
    expect([docs(part).s, part.documents.get('s')?.open]).toEqual(['partial -40000 -', '-60000']);
    const after = settleLedger(chain, [pay(1, 'o', '2026-12-06', '100000'), pay(2, 's', '2026-12-08', '-40000'), pay(3, 's', '2026-12-10', '-60000')]);
    expect(allocations(after)).toEqual({ 1: { o: '100000' }, 2: { s: '-40000' }, 3: { s: '-60000' } });
    expect([docs(after), after.documents.get('s')?.open]).toEqual([{ o: 'partial 100000 -', s: 'paid -100000 2026-12-10' }, '0']);
    // Nothing received: nothing to refund.
    expect(docs(settleLedger(chain, []))).toEqual({ o: 'unpaid 0 -', s: 'unpaid 0 -' });
  });

  it('every payment is allocated in full, and the allocated amounts settle as the recorded ones (random chains)', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 3000; t++) {
      const n = 1 + rnd(4);
      const chain = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, payable: String((i > 0 && rnd(2) === 0 ? -1 : 1) * (1 + rnd(200))) }));
      const payments = Array.from({ length: rnd(6) }, (_, i) => pay(i + 1, `d${rnd(n)}`, `2026-11-${10 + rnd(10)}`, String((rnd(3) === 0 ? -1 : 1) * (1 + rnd(250)))));
      const l = settleLedger(chain, payments);
      for (const p of payments) {
        const parts = [...(l.allocations.get(p.id)?.values() ?? [])];
        expect(parts.reduce((s, a) => s.plus(a), dec(0)).eq(p.amount), JSON.stringify({ chain, payments, p })).toBe(true);
      }
      const byRecorded = settleChain(chain.map((d) => ({ ...d, paid: l.recorded.get(d.id) ?? '0' })));
      const byAllocated = settleChain(chain.map((d) => ({ ...d, paid: l.documents.get(d.id)?.paid ?? '0' })));
      expect([...byAllocated], JSON.stringify({ chain, payments })).toEqual([...byRecorded]);
    }
  });
});
