/**
 * invoice_record_payment and an amount above what is owed: an agent that passes 127000 for 12700 gets
 * OVERPAYMENT_NOT_CONFIRMED with both amounts – a structured error it can show the user – instead of an invoice
 * silently marked paid; allowOverpayment: true records a real overpayment.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('invoice_record_payment: an overpayment needs allowOverpayment', () => {
  it('refuses 127000 on an invoice of 12 700 Ft, records it when confirmed', async () => {
    const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-14T09:00:00.000Z') });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
      t.cleanup();
    });
    t.app.updateSeller(SELLER_INPUT);
    const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const draft = await t.app.createDraft({ customerId, lines: [{ description: 'Gép', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const inv = (await t.app.issue(draft.invoice.id)).invoice;

    const tools = await client.listTools();
    const schema = tools.tools.find((x) => x.name === 'invoice_record_payment')?.inputSchema as Json;
    expect(Object.keys(schema.properties)).toContain('allowOverpayment');

    const refused = (await client.callTool({ name: 'invoice_record_payment', arguments: { invoice: inv.number, amount: '127000' } })) as Json;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.code).toBe('OVERPAYMENT_NOT_CONFIRMED');
    expect(refused.structuredContent.error.hint).toContain('allowOverpayment: true');
    expect(t.app.getInvoice(inv.id).paymentStatus).toBe('unpaid');

    const ok = (await client.callTool({ name: 'invoice_record_payment', arguments: { invoice: inv.number, amount: '13000', allowOverpayment: true } })) as Json;
    expect(ok.isError, JSON.stringify(ok.structuredContent)).toBeFalsy();
    expect(ok.structuredContent.invoice.paymentStatus).toBe('paid');
    expect(t.app.getInvoice(inv.id).paidAmount).toBe('13000');
  });
});
