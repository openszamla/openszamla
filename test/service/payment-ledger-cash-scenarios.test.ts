/**
 * EX8, the explorer's cash-accounting scenarios (c01-cash.ts, c02-paid-date.ts): a cash-accounting seller owes the VAT when
 * the consideration is received (Áfa tv. 196/B. §), so the payments, their dates and the document each one paid must be
 * kept. (a) A payment on the original that also pays its modification: the modification shows the part it received and
 * the date it became paid – in invoice_get, the JSON export and the payment ledger. (b) Payments recorded out of order:
 * the payment date is the day the invoice became fully paid. (c) A storno after a partial payment: the refund is recorded
 * on the storno, so the cancelled chain ends at zero.
 */
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors.ts';
import type { Invoice } from '../../src/core/types.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function cashSeller(): { app: OpenSzamla; at: (iso: string) => void } {
  const clock = { now: new Date('2026-11-14T09:00:00.000Z') };
  const t = makeTestApp({ confirmMode: 'none', now: () => clock.now });
  cleanups.push(() => t.cleanup());
  t.app.updateSeller({ ...SELLER_INPUT, cashAccounting: true });
  return { app: t.app, at: (iso) => (clock.now = new Date(iso)) };
}

async function mcp(app: OpenSzamla): Promise<(name: string, args: Json) => Promise<Json>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(app, { confirmMode: 'none' }), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return async (name, args) => ((await client.callTool({ name, arguments: args })) as Json).structuredContent as Json;
}

const line = (description: string, unitPrice: string, vatCode = '27', extra: Partial<LineInput> = {}): LineInput => ({ description, quantity: '1', unit: 'db', unitPrice, vatCode, ...extra }) as LineInput;

async function invoice(app: OpenSzamla, lines: LineInput[]): Promise<Invoice> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, lines })).invoice.id)).invoice;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? `${e.code}: ${e.message} | ${e.hint ?? ''}` : String(e);
  }
  return 'accepted';
}

describe('cash accounting: payments with their dates and documents (EX8)', () => {
  it('(a) a payment on the original that pays the modification: the modification shows its part and its date everywhere', async () => {
    const { app, at } = cashSeller();
    const original = await invoice(app, [line('Szolgáltatás', '100000'), line('Oktatás', '10000', 'TAM', { vatReason: 'Áfa tv. 85. § (1) i)' })]); // 137 000
    const modification = (await app.issue((await app.createCorrectionDraft(original.id, { lines: [line('Pótdíj', '10000')], comment: 'pótdíj' })).invoice.id)).invoice; // +12 700
    at('2026-11-20T09:00:00.000Z');
    app.recordPayment(original.id, { amount: '50000', date: '2026-11-20' });
    at('2026-12-05T09:00:00.000Z');
    app.recordPayment(original.id, { date: '2026-12-05' }); // the rest of the chain: 99 700
    const o = app.getInvoice(original.id);
    const m = app.getInvoice(modification.id);
    expect([o.paymentStatus, o.paidAmount, o.paidDate]).toEqual(['paid', '137000', '2026-12-05']);
    expect([m.paymentStatus, m.paidAmount, m.paidDate]).toEqual(['paid', '12700', '2026-12-05']);

    const call = await mcp(app);
    const got = await call('invoice_get', { invoice: modification.number });
    expect([got.invoice.paymentStatus, got.invoice.paidAmount, got.invoice.paidDate]).toEqual(['paid', '12700', '2026-12-05']);
    const exported = await call('export_invoices', { from: '2026-11-01', to: '2026-12-31', format: 'json' });
    const docs = JSON.parse(readFileSync(exported.path, 'utf8')) as Invoice[];
    expect(docs.map((d) => [d.number, d.paymentStatus, d.paidAmount, d.paidDate])).toEqual([
      [original.number, 'paid', '137000', '2026-12-05'],
      [modification.number, 'paid', '12700', '2026-12-05'],
    ]);
    // The November receipt and the date the modification's VAT became due: in the payment ledger.
    const ledger = await call('export_invoices', { from: '2026-11-01', to: '2026-12-31', format: 'json', ledger: true });
    const entries = JSON.parse(readFileSync(ledger.path, 'utf8')) as Json[];
    expect(entries.map((e) => [e.date, e.amount, e.recordedOn.number, e.allocations.map((a: Json) => [a.invoice.number, a.amount])])).toEqual([
      ['2026-11-20', '50000', original.number, [[original.number, '50000']]],
      ['2026-12-05', '99700', original.number, [[original.number, '87000'], [modification.number, '12700']]],
    ]);
  });

  it('(b) payments recorded out of order: paid on the date the invoice became fully paid', async () => {
    const { app, at } = cashSeller();
    at('2026-12-10T09:00:00.000Z');
    const inv = await invoice(app, [line('Munka', '100000')]);
    app.recordPayment(inv.id, { amount: '27000', date: '2026-12-08' }); // the later payment, recorded first
    const r = app.recordPayment(inv.id, { date: '2026-11-20' }); // the rest, received earlier, recorded later
    expect([r.paymentStatus, r.paidAmount, r.paidDate]).toEqual(['paid', '127000', '2026-12-08']);
    expect(app.paymentHistory(inv.id).map((p) => [p.date, p.amount, p.kind])).toEqual([
      ['2026-11-20', '100000', 'payment'],
      ['2026-12-08', '27000', 'payment'],
    ]);
  });

  it('(c) a storno after a partial payment: the refund is recorded on the storno and the chain ends at zero', async () => {
    const { app, at } = cashSeller();
    at('2026-12-06T09:00:00.000Z');
    const inv = await invoice(app, [line('Gép', '200000')]); // 254 000
    app.recordPayment(inv.id, { amount: '100000', date: '2026-12-06' });
    const storno = (await app.cancel(inv.id, { reason: 'visszáru' })).invoice;
    expect(app.openAmount(storno)).toBe('-100000');
    expect(app.defaultPaymentAmount(storno)).toBe('-100000');
    // On the cancelled invoice itself nothing is recorded; the hint points to the storno.
    expect(refusal(() => app.recordPayment(inv.id, { amount: '-100000' }))).toBe(
      'INVALID_INPUT: Sztornózott számlára nem rögzíthető fizetés. | Ha a vevő befizetését visszafizették, a visszafizetést a számla sztornó számláján rögzítsd, negatív összeggel.',
    );
    // More than was paid cannot be refunded; a positive amount reverses only what was refunded.
    expect(refusal(() => app.recordPayment(storno.id, { amount: '-100001' }))).toMatch(/^INVALID_INPUT: A visszafizetés nem lehet nagyobb a visszafizetendő összegnél \(100\s000\sFt\)/);
    expect(refusal(() => app.recordPayment(storno.id, { amount: '1' }))).toMatch(/^INVALID_INPUT: A visszavont összeg nem lehet nagyobb a visszafizetettnél \(eddig rögzítve: 0 HUF\)/);

    at('2026-12-10T09:00:00.000Z');
    const part = app.recordPayment(storno.id, { amount: '-40000', date: '2026-12-09' });
    expect([part.paymentStatus, part.paidAmount, app.openAmount(part)]).toEqual(['partial', '-40000', '-60000']);
    const refunded = app.recordPayment(storno.id, { date: '2026-12-10' });
    expect([refunded.paymentStatus, refunded.paidAmount, refunded.paidDate, app.openAmount(refunded)]).toEqual(['paid', '-100000', '2026-12-10', '0']);
    expect(Number(app.getInvoice(inv.id).paidAmount) + Number(refunded.paidAmount)).toBe(0);
    expect(refusal(() => app.recordPayment(storno.id, {}))).toMatch(/^INVALID_INPUT: A sztornó számlán nincs visszafizetendő összeg/);
    expect(app.paymentHistory(storno.id).map((p) => [p.date, p.amount, p.kind])).toEqual([
      ['2026-12-09', '-40000', 'refund'],
      ['2026-12-10', '-60000', 'refund'],
    ]);
    // A refund recorded by mistake is taken back with a positive amount.
    expect(app.recordPayment(storno.id, { amount: '60000' }).paymentStatus).toBe('partial');
  });

  it('(c) a storno of an invoice nobody paid: nothing to refund, nothing recorded', async () => {
    const { app } = cashSeller();
    const inv = await invoice(app, [line('Gép', '200000')]);
    const storno = (await app.cancel(inv.id, { reason: 'téves számla' })).invoice;
    expect([app.openAmount(storno), app.defaultPaymentAmount(storno)]).toEqual([null, null]);
    expect(refusal(() => app.recordPayment(storno.id, { amount: '-1000' }))).toBe(
      `INVALID_INPUT: Sztornó számlára nem rögzíthető fizetés. | A sztornó számlán csak a sztornózott ${inv.number} számlára (és módosító számláira) befizetett összeg visszafizetése rögzíthető, negatív összeggel – azokra nem érkezett befizetés.`,
    );
    expect(app.paymentHistory(storno.id)).toEqual([]);
  });
});
