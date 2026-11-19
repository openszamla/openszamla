/**
 * P1-4: VAT by payment date for a cash-accounting seller (pénzforgalmi elszámolás, Áfa tv. 196/B. §). report_summary and
 * export_invoices take dateBasis "payment": the payments and refunds dated in the period on the documents issued under cash
 * accounting, each part of a payment with its proportional HUF figures – part × the document's VAT (net, gross) ÷ its gross,
 * per VAT code, rounded to 0.01 Ft –, the part that paid a modification by the modification's VAT, a refund on a storno
 * negative. A document issued without cash accounting does not count (a note says how many). The issue and fulfilment
 * bases keep their caveat, which now points to the payment basis.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { CASH_ACCOUNTING_VAT_NOTE, PAYMENT_BASIS_NOTE, type OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const line = (description: string, unitPrice: string, vatCode = '27', extra: Partial<LineInput> = {}): LineInput => ({ description, quantity: '1', unit: 'db', unitPrice, vatCode, ...extra }) as LineInput;

/**
 * A cash-accounting seller's November and December:
 * - SZ-1: 137 000 (100 000 + 27 % and 10 000 TAM) and its +12 700 modification SZ-2; 50 000 paid on 11-20, the rest of
 *   both (99 700) on 12-05 – on the original;
 * - SZ-3: 1270 EUR at 400 HUF/EUR, half paid on 11-25;
 * - SZ-4: issued after the seller left cash accounting, 127 000 paid on 11-26 – it does not count;
 * - SZ-5: 254 000, 100 000 paid on 11-27, cancelled by SZ-6 and refunded on 12-03.
 */
async function year(): Promise<{ app: OpenSzamla; docs: Invoice[] }> {
  const clock = { now: new Date('2026-11-16T09:00:00.000Z') };
  const t = makeTestApp({ confirmMode: 'none', now: () => clock.now });
  cleanups.push(() => t.cleanup());
  const app = t.app;
  app.updateSeller({ ...SELLER_INPUT, cashAccounting: true });
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const issue = async (lines: LineInput[], extra: Record<string, unknown> = {}): Promise<Invoice> =>
    (await app.issue((await app.createDraft({ customerId, lines, ...extra })).invoice.id)).invoice;
  const a = await issue([line('Szolgáltatás', '100000'), line('Oktatás', '10000', 'TAM', { vatReason: 'Áfa tv. 85. § (1) i)' })]);
  const a1 = (await app.issue((await app.createCorrectionDraft(a.id, { lines: [line('Pótdíj', '10000')], comment: 'pótdíj' })).invoice.id)).invoice;
  const b = await issue([line('Consulting', '1000')], { currency: 'EUR', exchangeRate: '400' });
  app.updateSeller({ cashAccounting: false });
  const c = await issue([line('Szolgáltatás', '100000')]);
  app.updateSeller({ cashAccounting: true });
  const d = await issue([line('Gép', '200000')]);
  clock.now = new Date('2026-11-28T09:00:00.000Z');
  app.recordPayment(a.id, { amount: '50000', date: '2026-11-20' });
  app.recordPayment(b.id, { amount: '635', date: '2026-11-25' });
  app.recordPayment(c.id, { date: '2026-11-26' });
  app.recordPayment(d.id, { amount: '100000', date: '2026-11-27' });
  const storno = (await app.cancel(d.id, { reason: 'visszáru' })).invoice;
  clock.now = new Date('2026-12-06T09:00:00.000Z');
  app.recordPayment(storno.id, { date: '2026-12-03' });
  app.recordPayment(a.id, { date: '2026-12-05' });
  return { app, docs: [a, a1, b, c, d, storno].map((i) => app.getInvoice(i.id)) };
}

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30', dateBasis: 'payment' as const };
const DECEMBER = { from: '2026-12-01', to: '2026-12-31', dateBasis: 'payment' as const };
const LEFT_OUT = 'Az időszakban további 1 bizonylatra érkezett befizetés, de azokat nem pénzforgalmi elszámolással állították ki';

describe('VAT by payment date (P1-4)', () => {
  it('November: the parts of the payments on the cash-accounting documents, with their proportional VAT', async () => {
    const { app } = await year();
    const r = app.report(NOVEMBER);
    expect([r.dateBasis, r.invoiceCount, r.paymentCount]).toEqual(['payment', 3, 3]);
    // 50 000 of SZ-1: 27 % 36 496.35 + 9 854.01 (+ 46 350.36), TAM 3 649.64; 635 EUR of SZ-3: half of 400 000 / 108 000;
    // 100 000 of SZ-5: 78 740.16 + 21 259.84.
    expect(r.byVatCode).toEqual([
      { vatCode: '27', net: '315236.51', vat: '85113.85', gross: '400350.36' },
      { vatCode: 'TAM', net: '3649.64', vat: '0', gross: '3649.64' },
    ]);
    expect(r.totalsHuf).toEqual({ net: '318886.15', vat: '85113.85', gross: '404000' });
    expect(r.byMonth).toEqual([{ month: '2026-11', count: 3, net: '318886.15', vat: '85113.85', gross: '404000' }]);
    expect(r.notes[0]).toBe(PAYMENT_BASIS_NOTE);
    expect(r.notes[1]).toContain(LEFT_OUT);
    expect(r.notes).not.toContain(CASH_ACCOUNTING_VAT_NOTE);
  });

  it('December: the rest paid on the original covers the modification by its own VAT; the refund on the storno is negative', async () => {
    const { app } = await year();
    const r = app.report(DECEMBER);
    // 87 000 of SZ-1 (63 503.65 + 17 145.99, TAM 6 350.36), 12 700 of SZ-2 (10 000 + 2 700), −100 000 on SZ-6.
    expect(r.byVatCode).toEqual([
      { vatCode: '27', net: '-5236.51', vat: '-1413.85', gross: '-6650.36' },
      { vatCode: 'TAM', net: '6350.36', vat: '0', gross: '6350.36' },
    ]);
    expect([r.invoiceCount, r.paymentCount]).toEqual([3, 2]);
    expect(r.notes).toEqual([PAYMENT_BASIS_NOTE]);
    // Over both months the paid invoice's VAT adds up to its own: 9 854.01 + 17 145.99 = 27 000.
    const both = app.report({ from: '2026-11-01', to: '2026-12-31', dateBasis: 'payment' });
    const vat27 = both.byVatCode.find((v) => v.vatCode === '27');
    expect(vat27?.vat).toBe('83700'); // 27 000 + 2 700 + 54 000 (half of SZ-3) + 0 (SZ-5 refunded)
  });

  it('the issue and fulfilment bases are unchanged and keep the caveat, which names the payment basis', async () => {
    const { app } = await year();
    const r = app.report({ from: '2026-11-01', to: '2026-11-30', dateBasis: 'fulfillment' });
    expect(r.invoiceCount).toBe(6);
    expect(r.notes).toContain(CASH_ACCOUNTING_VAT_NOTE);
    expect(CASH_ACCOUNTING_VAT_NOTE).toContain('ezt a befizetés dátuma szerinti összesítés mutatja');
    expect(r.paymentCount).toBeUndefined();
  });

  it('export_invoices by payment date: the cash-accounting documents paid in the period; report_summary over MCP', async () => {
    const { app, docs } = await year();
    const csv = app.exportInvoices({ ...NOVEMBER, format: 'csv' });
    expect([basename(csv.path), csv.count, csv.dateBasis, csv.ledger]).toEqual(['szamlak_befizetes_2026-11-01_2026-11-30.csv', 3, 'payment', false]);
    const text = readFileSync(csv.path, 'utf8');
    for (const i of [docs[0], docs[2], docs[4]]) expect(text).toContain(`${i?.number};`);
    expect(text).not.toContain(`${docs[3]?.number};`);
    expect(csv.notes[0]).toBe(PAYMENT_BASIS_NOTE);
    const december = app.exportInvoices({ ...DECEMBER, format: 'json' });
    expect((JSON.parse(readFileSync(december.path, 'utf8')) as Invoice[]).map((i) => i.number)).toEqual([docs[0]?.number, docs[1]?.number, docs[5]?.number]);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(app, { confirmMode: 'none' }), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    const report = ((await client.callTool({ name: 'report_summary', arguments: NOVEMBER })) as Json).structuredContent as Json;
    expect([report.dateBasis, report.paymentCount, report.totalsHuf.vat]).toEqual(['payment', 3, '85113.85']);
    const schema = (await client.listTools()).tools.find((x) => x.name === 'report_summary')?.inputSchema as Json;
    expect(schema.properties.dateBasis.enum).toEqual(['issue', 'fulfillment', 'payment']);
    expect(String(schema.properties.dateBasis.description)).toMatch(/"payment" = the payment date/);
  });

  it('an unknown date basis names the three', async () => {
    const { app } = await year();
    expect(() => app.report({ from: '2026-11-01', to: '2026-11-30', dateBasis: 'befizetes' as never })).toThrow('Ismeretlen dátumalap: befizetes');
    try {
      app.report({ from: '2026-11-01', to: '2026-11-30', dateBasis: 'x' as never });
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain('"payment" (befizetés dátuma szerint, pénzforgalmi elszámolás)');
    }
  });
});
