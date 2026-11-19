/**
 * MCP-12: a reversed period (from after to) is an input error – never an empty answer that reads as
 * "no turnover". report_summary, export_invoices, tax_audit_export and invoice_list (the issue-date
 * range of findInvoices); the same day as start and end stays a valid one-day period.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connectPeriods(): Promise<{ t: TestApp; client: Client }> {
  const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-30T09:00:00.000Z') });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  t.app.updateSeller(SELLER_INPUT);
  const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await t.app.createDraft({ customerId, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
  await t.app.issue(d.invoice.id);
  return { t, client };
}

async function tool(client: Client, name: string, args: Json): Promise<{ isError: boolean; data: Json }> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  return { isError: raw.isError === true, data: (raw.structuredContent ?? {}) as Json };
}

const REVERSED = { from: '2026-11-30', to: '2026-11-01' };

describe('a reversed period is refused (MCP-12)', () => {
  it('report_summary', async () => {
    const { client } = await connectPeriods();
    const r = await tool(client, 'report_summary', REVERSED);
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A kezdő dátum (2026-11-30) későbbi a záró dátumnál (2026-11-01).' });
    expect(r.data.error.hint).toMatch(/felcserélődött/);
    // A one-day period and the defaults (start of the month – today) still work.
    expect((await tool(client, 'report_summary', { from: '2026-11-30', to: '2026-11-30' })).data.invoiceCount).toBe(1);
    expect((await tool(client, 'report_summary', {})).data).toMatchObject({ from: '2026-11-01', to: '2026-11-30', invoiceCount: 1 });
    expect((await tool(client, 'report_summary', { from: '2026-12-01' })).data.error?.code).toBe('INVALID_INPUT'); // default to: today
  });

  it('export_invoices: no file is written', async () => {
    const { t, client } = await connectPeriods();
    for (const dateBasis of ['issue', 'fulfillment']) {
      const r = await tool(client, 'export_invoices', { ...REVERSED, dateBasis });
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('INVALID_INPUT');
    }
    expect(t.app.auditLog({}).items.some((e) => e.action === 'export')).toBe(false);
    expect((await tool(client, 'export_invoices', { from: '2026-11-30', to: '2026-11-30' })).data.count).toBe(1);
  });

  it('tax_audit_export: by dates, and by numbers (with a hint)', async () => {
    const { t, client } = await connectPeriods();
    const r = await tool(client, 'tax_audit_export', REVERSED);
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A kezdő dátum (2026-11-30) későbbi a záró dátumnál (2026-11-01).' });
    const customerId = t.app.findCustomers({}).items[0]?.id as string;
    const d = await t.app.createDraft({ customerId, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '5000', vatCode: '27' }] });
    await t.app.issue(d.invoice.id);
    const numbers = await tool(client, 'tax_audit_export', { fromNumber: 'SZ-2026-00002', toNumber: 'SZ-2026-00001' });
    expect(numbers.data.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A kezdő sorszám nem előzi meg a záró sorszámot.' });
    expect(numbers.data.error.hint).toMatch(/fromNumber/);
    expect((await tool(client, 'tax_audit_export', { from: '2026-11-30', to: '2026-11-30' })).data.count).toBe(2);
  });

  it('invoice_list (issue-date range) and the service filter behind the CLI and web lists', async () => {
    const { t, client } = await connectPeriods();
    const r = await tool(client, 'invoice_list', REVERSED);
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('INVALID_INPUT');
    expect((await tool(client, 'invoice_list', { from: '2026-11-30', to: '2026-11-30' })).data.total).toBe(1);
    expect(() => t.app.findInvoices({ issueDateFrom: '2026-11-30', issueDateTo: '2026-11-01' })).toThrow(/későbbi a záró dátumnál/);
    expect(() => t.app.report({ from: '2026-11-30', to: '2026-11-01' })).toThrow(/későbbi a záró dátumnál/);
    expect(() => t.app.exportInvoices({ from: '2026-11-30', to: '2026-11-01', format: 'csv' })).toThrow(/későbbi a záró dátumnál/);
    // An impossible date is still INVALID_DATE (checked first).
    expect(() => t.app.findInvoices({ issueDateFrom: '2026-13-01', issueDateTo: '2026-11-01' })).toThrow(/Érvénytelen dátum/);
  });
});
