/**
 * What invoice_draft tells a model about its defaults (MCP-7, TAX-3, MCP-9): currency, language and
 * appearance come from the seller's defaults – not a fixed HUF / ELECTRONIC –, the creation result warns
 * when a non-HUF default currency was applied, and the exchangeRate description no longer asks for the
 * rate again on correction drafts.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** MNB: EUR 390,12 published on 2026-10-26. */
const mnb = (async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="2026-10-26"&gt;&lt;Rate unit="1" curr="EUR"&gt;390,12&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
  return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}) as unknown as typeof fetch;

async function connect(era: Era): Promise<Client> {
  const t = makeTestApp({ confirmMode: 'code', fetch: mnb });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  return client;
}

async function call(client: Client, name: string, args: Json = {}): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

describe('invoice_draft defaults', () => {
  for (const era of ['legacy', 'modern'] as const) {
    it(`${era}: the description and the field descriptions name the seller's defaults, not HUF / ELECTRONIC`, async () => {
      const client = await connect(era);
      const tool = (await client.listTools()).tools.find((x) => x.name === 'invoice_draft');
      const props = (tool?.inputSchema as Json).properties as Record<string, { description?: string }>;
      expect(tool?.description).not.toMatch(/currency HUF/);
      expect(tool?.description).toContain("currency, payment method, language and appearance are the seller's defaults (setup_status → defaults");
      expect(props.currency?.description).toContain("Default: the seller's default currency (setup_status → defaults.currency), not necessarily HUF");
      expect(props.currency?.description).not.toMatch(/default HUF/);
      expect(props.appearance?.description).toContain("Default: the seller's default (setup_status → defaults.appearance)");
      expect(props.appearance?.description).not.toMatch(/\(default\)/);
      expect(props.language?.description).toContain("Default: the seller's default (setup_status → defaults.language)");
      expect(props.exchangeRate?.description).not.toMatch(/Give it again after changing fulfillmentDate/);
      expect(props.exchangeRate?.description).toContain('Never on a correction (módosító számla) draft');
      expect(props.exchangeRate?.description).toContain('CORRECTION_EXCHANGE_RATE_FIXED');
    });
  }

  it('a draft without currency under an EUR default: the result says so (DEFAULT_CURRENCY_APPLIED)', async () => {
    const client = await connect('modern');
    await call(client, 'seller_update', { ...SELLER_INPUT, defaults: { currency: 'EUR', appearance: 'PAPER', language: 'hu-en' } });
    const customerId = (await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT)).customer.id as string;
    const lines = [{ description: 'Szoftverfejlesztés', quantity: 10, unit: 'óra', unitPrice: 15000, vatCode: '27' }];
    const d = await call(client, 'invoice_draft', { customerId, lines });
    expect(d.invoice.currency).toBe('EUR');
    expect(d.issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'DEFAULT_CURRENCY_APPLIED', field: 'currency' })]);
    expect(d.issues[0].message).toMatch(/^A pénznem az eladó alapértelmezése: EUR\./);
    expect(d.readyToIssue).toBe(true);
    const shown = await call(client, 'invoice_get', { invoice: d.invoice.id });
    expect(shown.issues).toEqual([]);
    const huf = await call(client, 'invoice_draft', { draftId: d.invoice.id, currency: 'HUF' });
    expect([huf.invoice.currency, huf.issues]).toEqual(['HUF', []]);
  });
});
