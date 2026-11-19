/**
 * MCP-2: for a cash-accounting seller (pénzforgalmi elszámolás) the VAT is due when the payment is
 * received (Áfa tv. 196/B. §), so neither the issue-date nor the fulfilment-date figure is the VAT to
 * declare. report_summary and export_invoices warn (notes) when the seller – or the seller snapshot of
 * any selected invoice – is cash-accounting, setup_status notes it, and the guidance states the rule
 * conditionally (dateBasis description, server instructions, havi_zaras prompt). The CLI prints the notes.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { CASH_ACCOUNTING_VAT_NOTE } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connectCash(cashAccounting: boolean): Promise<{ t: TestApp; client: Client }> {
  const clock = { now: new Date('2026-10-20T09:00:00.000Z') };
  const t = makeTestApp({ confirmMode: 'none', now: () => clock.now });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  t.app.updateSeller({ ...SELLER_INPUT, cashAccounting });
  const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  // October work, invoiced on 10-20, paid on 11-05.
  const d = await t.app.createDraft({ customerId, lines: [{ description: 'Októberi fejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  const inv = (await t.app.issue(d.invoice.id)).invoice;
  clock.now = new Date('2026-11-08T09:00:00.000Z');
  t.app.recordPayment(inv.id, { date: '2026-11-05' });
  return { t, client };
}

async function tool(client: Client, name: string, args: Json = {}): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31', dateBasis: 'fulfillment' };
const NOVEMBER = { from: '2026-11-01', to: '2026-11-30', dateBasis: 'fulfillment' };

describe('cash accounting: the report figures are not the VAT to declare (MCP-2)', () => {
  it('report_summary, export_invoices and setup_status carry the note for a cash-accounting seller', async () => {
    const { client } = await connectCash(true);
    const oct = await tool(client, 'report_summary', OCTOBER);
    expect(oct.totalsHuf.vat).toBe('40500');
    expect(oct.notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
    expect(oct.notes[0]).toMatch(/Áfa tv\. 196\/B\. §/);
    // Also for a month without invoices: the payment received in November is its VAT.
    expect((await tool(client, 'report_summary', NOVEMBER)).notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
    expect((await tool(client, 'report_summary', { ...OCTOBER, dateBasis: 'issue' })).notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
    for (const format of ['csv', 'json', 'xml']) {
      const exp = await tool(client, 'export_invoices', { ...OCTOBER, format });
      expect(exp.notes, format).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
      expect(exp.warnings, format).toEqual([]);
    }
    const status = await tool(client, 'setup_status');
    expect(status.notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
  });

  it('no note for a seller with the general rules – unless an invoice of the period was issued under cash accounting', async () => {
    const { t, client } = await connectCash(false);
    expect((await tool(client, 'report_summary', OCTOBER)).notes).toEqual([]);
    expect((await tool(client, 'export_invoices', OCTOBER)).notes).toEqual([]);
    expect((await tool(client, 'setup_status')).notes).toEqual([]);
    // Cash accounting for a while: the invoices issued then carry it in their seller data.
    t.app.updateSeller({ cashAccounting: true });
    const customerId = t.app.findCustomers({}).items[0]?.id as string;
    await t.app.issue((await t.app.createDraft({ customerId, lines: [{ description: 'Novemberi munka', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }] })).invoice.id);
    t.app.updateSeller({ cashAccounting: false });
    expect((await tool(client, 'report_summary', NOVEMBER)).notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
    expect((await tool(client, 'export_invoices', NOVEMBER)).notes).toEqual([CASH_ACCOUNTING_VAT_NOTE]);
    expect((await tool(client, 'report_summary', OCTOBER)).notes).toEqual([]);
    expect((await tool(client, 'setup_status')).notes).toEqual([]);
  });

  it('the guidance states the fulfilment rule as the general one, with the cash-accounting exception', async () => {
    const { client } = await connectCash(true);
    const rs = (await client.listTools()).tools.find((x) => x.name === 'report_summary');
    const description = String((rs?.inputSchema as Json).properties.dateBasis.description);
    expect(description).toMatch(/general VAT tax point/);
    expect(description).toMatch(/cash-accounting seller \(pénzforgalmi elszámolás\).*196\/B/);
    expect(SERVER_INSTRUCTIONS).toMatch(/cash-accounting seller \(pénzforgalmi elszámolás, seller\.cashAccounting\) owes the VAT when the payment is received \(Áfa tv\. 196\/B\. §\)/);
    const prompt = await client.getPrompt({ name: 'havi_zaras', arguments: { honap: '2026-10' } });
    const text = prompt.messages[0]?.content.type === 'text' ? prompt.messages[0].content.text : '';
    expect(text).toContain('az ÁFA főszabály szerint a teljesítés napján keletkezik');
    expect(text).toContain('Ha az eladó pénzforgalmi elszámolású');
  });

  it('the CLI prints the note with status and export', async () => {
    const { t } = await connectCash(true);
    const dir = t.dir;
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENSZAMLA_')) env[k] = v;
        const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)), ...args, '--data-dir', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });
    expect(await run(['status'])).toContain(`  Megjegyzés: ${CASH_ACCOUNTING_VAT_NOTE}`);
    expect(await run(['export', '--from', '2026-10-01', '--to', '2026-10-31', '--date-basis', 'fulfillment'])).toContain(`  figyelem – ${CASH_ACCOUNTING_VAT_NOTE}`);
  });
});
