/**
 * Payment settlement of an invoice chain: an original invoice and its issued modifications (módosító
 * számlák) are settled together. Every document keeps the payments recorded on it (paidAmount: money
 * received – on a crediting document the refund paid to the buyer, negative); what is still open on
 * each of them comes from the whole chain:
 *  1. an overpayment of one document covers what is still owed on the others, the original first, then
 *     the modifications in issue order (the buyer paid the corrected total on the original);
 *  2. a refund beyond a credit (or beyond what was paid) is first set against credit not yet refunded;
 *  3. credit not refunded (a crediting modification, negative total) is set off against what is still
 *     owed (beszámítás), the original first: paying the corrected total settles the credit note too;
 *  4. whatever such a refund leaves over reopens what the buyer owes, the latest document first.
 * A document is paid when nothing is open on it (a crediting document: nothing left to refund), partial
 * when money moved on it but something is still open, unpaid otherwise. A 0 total takes no part.
 */
import { D, dec, toDec, type DecValue } from './decimal.ts';
import type { Dec, IsoDate, PaymentStatus } from './types.ts';

export interface SettlementDoc {
  id: string;
  /** totals.payableAmount – negative on a crediting document. */
  payable: Dec;
  /** paidAmount: what was recorded on the document itself. */
  paid: Dec;
}

export interface Settlement {
  status: PaymentStatus;
  /**
   * What is still open on the document, in its currency: owed by the buyer (> 0), or on a crediting
   * document still to be refunded to the buyer (< 0); "0" when it is settled.
   */
  open: Dec;
}

interface Owed {
  id: string;
  payable: DecValue;
  /** Money that covers it: its own payments, then overpayments of the chain. */
  money: DecValue;
  /** Credit set off against it. */
  credit: DecValue;
}

interface Credit {
  id: string;
  /** Negative. */
  payable: DecValue;
  /** Refund recorded on it, between payable and 0. */
  refund: DecValue;
  /** Credit used up otherwise: set off against what is owed, or against a refund paid beyond a credit. */
  used: DecValue;
}

const min = (a: DecValue, b: DecValue): DecValue => (a.lt(b) ? a : b);
const max = (a: DecValue, b: DecValue): DecValue => (a.gt(b) ? a : b);

/** Open amount and payment status of every document of a chain; `docs` start with the original, then issue order. */
export function settleChain(docs: readonly SettlementDoc[]): Map<string, Settlement> {
  const zero = new D(0);
  const owed: Owed[] = [];
  const credits: Credit[] = [];
  // Paid beyond the documents' own amounts (> 0), or refunded beyond the credits (< 0).
  let pool = zero;
  for (const d of docs) {
    const payable = dec(d.payable);
    const paid = dec(d.paid);
    if (payable.gt(0)) {
      const money = paid.lt(0) ? zero : min(paid, payable);
      owed.push({ id: d.id, payable, money, credit: zero });
      pool = pool.plus(paid.minus(money));
    } else if (payable.lt(0)) {
      const refund = paid.gt(0) ? zero : paid.lt(payable) ? payable : paid;
      credits.push({ id: d.id, payable, refund, used: zero });
      pool = pool.plus(paid.minus(refund));
    } else {
      pool = pool.plus(paid);
    }
  }
  const gap = (o: Owed): DecValue => o.payable.minus(o.money).minus(o.credit);
  const unrefunded = (c: Credit): DecValue => c.refund.minus(c.payable).minus(c.used);

  for (const o of owed) {
    if (!pool.gt(0)) break;
    const take = min(gap(o), pool);
    o.money = o.money.plus(take);
    pool = pool.minus(take);
  }
  for (const c of credits) {
    if (!pool.lt(0)) break;
    const take = min(unrefunded(c), pool.neg());
    c.used = c.used.plus(take);
    pool = pool.plus(take);
  }
  for (const c of credits) {
    for (const o of owed) {
      const take = min(gap(o), unrefunded(c));
      if (!take.gt(0)) continue;
      o.credit = o.credit.plus(take);
      c.used = c.used.plus(take);
    }
  }
  for (const o of [...owed].reverse()) {
    if (!pool.lt(0)) break;
    const take = min(o.money, pool.neg());
    o.money = o.money.minus(take);
    pool = pool.plus(take);
  }

  const out = new Map<string, Settlement>();
  for (const o of owed) {
    const open = gap(o);
    out.set(o.id, { status: open.gt(0) ? (o.money.gt(0) ? 'partial' : 'unpaid') : 'paid', open: open.gt(0) ? toDec(open) : '0' });
  }
  for (const c of credits) {
    const open = unrefunded(c);
    out.set(c.id, { status: open.gt(0) ? (c.refund.lt(0) ? 'partial' : 'unpaid') : 'paid', open: open.gt(0) ? toDec(open.neg()) : '0' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The payment ledger of a chain: what each payment brought to each document (allocation), the
// paid amount and the date each document became fully paid.
// ---------------------------------------------------------------------------------------------

/** A document of an invoice chain as settleLedger reads it: the original first, then its modifications in issue order. */
export interface LedgerDoc {
  id: string;
  /** totals.payableAmount – negative on a crediting document and on a storno. */
  payable: Dec;
  /**
   * The storno of a cancelled chain: what is recorded on it is the refund (< 0) – or the reversal of a refund (> 0) –
   * of what the other documents of the chain received. It takes no part in their settlement.
   */
  storno?: boolean;
}

/** One payment of the chain (a row of the payments table). */
export interface LedgerPayment {
  /** Recording order (payments.id); a payment not stored yet takes an id above every stored one. */
  id: number;
  /** The document it was recorded on. */
  doc: string;
  date: IsoDate;
  /** Signed, in the documents' currency: money received (> 0); a refund to the buyer or a reversal (< 0). */
  amount: Dec;
}

export interface LedgerDocState {
  /** The money allocated to the document (paidAmount): received – on a crediting document or a storno: refunded, negative. */
  paid: Dec;
  status: PaymentStatus;
  /** As Settlement.open: owed by the buyer (> 0), still to refund (< 0), "0". */
  open: Dec;
  /** The payment date on which the document became fully paid – by payment dates, not by recording order –; null while it is not. */
  paidDate: IsoDate | null;
}

export interface ChainLedger {
  /** By payment id: the part of it each document received (non-zero parts only); the parts add up to the payment. */
  allocations: Map<number, Map<string, Dec>>;
  documents: Map<string, LedgerDocState>;
  /** What is recorded on each document in total (the sum of its payments): the limit of a reversal on it. */
  recorded: Map<string, Dec>;
  /** What the documents of the chain other than its storno hold in total: on a cancelled chain the most its storno can refund. */
  received: Dec;
}

/** The order settleLedger applies payments in: by payment date, then by recording order. */
export function byPaymentDate(a: Pick<LedgerPayment, 'id' | 'date'>, b: Pick<LedgerPayment, 'id' | 'date'>): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id - b.id;
}

/**
 * The money each document holds for the amounts recorded on each, distributed as settleChain distributes them: a
 * document's own payments cover it up to its total; an overpayment covers what the others still owe (the original
 * first, then the modifications); a refund beyond a credit uses up credit not yet refunded, then takes money back from
 * the owed documents, the latest first. What is left over – an overpayment of the whole chain, or a refund beyond
 * everything – stays on the documents it came from (the earliest is used up first). The result adds up to the recorded total.
 */
function coverage(docs: ReadonlyArray<{ id: string; payable: DecValue }>, recorded: ReadonlyMap<string, DecValue>): Map<string, DecValue> {
  const zero = new D(0);
  const owed: Array<{ id: string; payable: DecValue; money: DecValue }> = [];
  const credits: Array<{ id: string; payable: DecValue; refund: DecValue; used: DecValue }> = [];
  const excess: Array<{ id: string; amount: DecValue }> = [];
  let pool = zero;
  for (const d of docs) {
    const r = recorded.get(d.id) ?? zero;
    let own: DecValue;
    if (d.payable.gt(0)) {
      own = r.lt(0) ? zero : min(r, d.payable);
      owed.push({ id: d.id, payable: d.payable, money: own });
    } else {
      own = r.gt(0) ? zero : r.lt(d.payable) ? d.payable : r;
      credits.push({ id: d.id, payable: d.payable, refund: own, used: zero });
    }
    excess.push({ id: d.id, amount: r.minus(own) });
    pool = pool.plus(r.minus(own));
  }
  for (const o of owed) {
    if (!pool.gt(0)) break;
    const take = min(o.payable.minus(o.money), pool);
    o.money = o.money.plus(take);
    pool = pool.minus(take);
  }
  for (const c of credits) {
    if (!pool.lt(0)) break;
    const take = min(c.refund.minus(c.payable).minus(c.used), pool.neg());
    c.used = c.used.plus(take);
    pool = pool.plus(take);
  }
  for (const o of [...owed].reverse()) {
    if (!pool.lt(0)) break;
    const take = min(o.money, pool.neg());
    o.money = o.money.minus(take);
    pool = pool.plus(take);
  }
  const out = new Map<string, DecValue>();
  for (const o of owed) out.set(o.id, o.money);
  for (const c of credits) out.set(c.id, c.refund.minus(c.used));
  for (const e of [...excess].reverse()) {
    if (pool.isZero()) break;
    if (e.amount.isZero() || e.amount.isNegative() !== pool.isNegative()) continue;
    const keep = pool.isNegative() ? max(e.amount, pool) : min(e.amount, pool);
    out.set(e.id, (out.get(e.id) ?? zero).plus(keep));
    pool = pool.minus(keep);
  }
  return out;
}

/**
 * The ledger of an invoice chain (`docs`: the original, its modifications in issue order and, when it is cancelled, its
 * storno) from its payments, applied by payment date (then in recording order):
 * - allocation: what each payment brought to each document – the change it made to the money each holds, distributed as
 *   settleChain does (a payment of the corrected total on the original also covers the modification). Every payment is
 *   allocated again against the chain as it is now: a modification issued later takes over the overpayment that covers it;
 * - paid (paidAmount): the money allocated to the document; status and open: settleChain over the amounts recorded on each;
 * - paidDate: the date of the payment after which the document became – and stayed – fully paid; null while it is not,
 *   and for a document settled without any payment (a credit note set off against an unpaid original).
 * A 0 Ft document takes no part: it is paid once a (0) payment is recorded on it. The storno of a cancelled chain refunds
 * what the other documents received (`received`): every payment on it is its own; it is paid once that is refunded in
 * full, partial while partly, unpaid otherwise (also when nothing was received).
 */
export function settleLedger(docs: readonly LedgerDoc[], payments: readonly LedgerPayment[]): ChainLedger {
  const zero = new D(0);
  const storno = docs.find((d) => d.storno === true) ?? null;
  const settled = docs.filter((d) => d.storno !== true && !dec(d.payable).isZero()).map((d) => ({ id: d.id, payable: dec(d.payable) }));
  const inSettlement = new Set(settled.map((d) => d.id));
  const zeroDocs = docs.filter((d) => d.storno !== true && dec(d.payable).isZero()).map((d) => d.id);
  const recorded = new Map<string, DecValue>(docs.map((d) => [d.id, zero] as const));
  const allocations = new Map<number, Map<string, Dec>>();
  const statuses = (): Map<string, Settlement> =>
    settleChain(settled.map((d) => ({ id: d.id, payable: toDec(d.payable), paid: toDec(recorded.get(d.id) ?? zero) })));

  let cover = new Map<string, DecValue>(settled.map((d) => [d.id, zero] as const));
  let before = statuses();
  // Since which payment date a document is paid (null: paid without a payment, e.g. set off by a credit note).
  const paidSince = new Map<string, IsoDate | null>();
  for (const [id, s] of before) if (s.status === 'paid') paidSince.set(id, null);
  const marked = new Map<string, IsoDate>();
  const refunds: LedgerPayment[] = [];
  for (const p of [...payments].sort(byPaymentDate)) {
    if (!recorded.has(p.doc)) continue; // not a document of this chain
    const amount = dec(p.amount);
    recorded.set(p.doc, (recorded.get(p.doc) ?? zero).plus(amount));
    if (storno && p.doc === storno.id) {
      refunds.push(p);
      continue;
    }
    if (!inSettlement.has(p.doc)) {
      if (!marked.has(p.doc)) marked.set(p.doc, p.date);
      continue;
    }
    const next = coverage(settled, recorded);
    const parts = new Map<string, Dec>();
    for (const d of settled) {
      const diff = (next.get(d.id) ?? zero).minus(cover.get(d.id) ?? zero);
      if (!diff.isZero()) parts.set(d.id, toDec(diff));
    }
    if (parts.size > 0) allocations.set(p.id, parts);
    cover = next;
    const after = statuses();
    for (const [id, s] of after) {
      if (s.status !== 'paid') paidSince.delete(id);
      else if (before.get(id)?.status !== 'paid') paidSince.set(id, p.date);
    }
    before = after;
  }

  const documents = new Map<string, LedgerDocState>();
  for (const d of settled) {
    const s = before.get(d.id) ?? { status: 'unpaid' as const, open: toDec(d.payable) };
    documents.set(d.id, { paid: toDec(cover.get(d.id) ?? zero), status: s.status, open: s.open, paidDate: s.status === 'paid' ? (paidSince.get(d.id) ?? null) : null });
  }
  for (const id of zeroDocs) {
    const on = marked.get(id) ?? null;
    documents.set(id, { paid: '0', status: on ? 'paid' : 'unpaid', open: '0', paidDate: on });
  }
  let received = zero;
  for (const d of settled) received = received.plus(cover.get(d.id) ?? zero);
  if (storno) {
    let refunded = zero;
    let wasSettled = false;
    let since: IsoDate | null = null;
    for (const p of refunds) {
      const amount = dec(p.amount);
      refunded = refunded.plus(amount);
      if (!amount.isZero()) allocations.set(p.id, new Map([[storno.id, toDec(amount)]]));
      const now = refunded.lt(0) && !received.plus(refunded).gt(0);
      if (now && !wasSettled) since = p.date;
      if (!now) since = null;
      wasSettled = now;
    }
    const left = received.plus(refunded);
    const status: PaymentStatus = left.gt(0) ? (refunded.lt(0) ? 'partial' : 'unpaid') : refunded.lt(0) ? 'paid' : 'unpaid';
    documents.set(storno.id, { paid: toDec(refunded), status, open: left.gt(0) ? toDec(left.neg()) : '0', paidDate: status === 'paid' ? since : null });
  }
  return {
    allocations,
    documents,
    recorded: new Map([...recorded].map(([id, v]) => [id, toDec(v)] as const)),
    received: toDec(received),
  };
}
