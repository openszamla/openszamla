/**
 * What an agent sees of a line's nature and price basis (MCP-3, TAX-6): the preview lines show the
 * nature, the schema says how nature and priceBasis default (a product's basis applies to an explicit
 * unitPrice too), and the draft summary names the lines priced gross.
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

async function connect(): Promise<Client> {
  const t = makeTestApp({ confirmMode: 'code' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
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

const plain = (s: string): string => s.replace(/\u00A0/g, ' ');
const EU = { vatStatus: 'OTHER', name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } };

describe('line nature in the preview and the schema (MCP-3)', () => {
  it('a consulting line without a unit is a SERVICE with EUFAD37, and the preview line shows it', async () => {
    const client = await connect();
    await call(client, 'seller_update', SELLER_INPUT);
    const d = await call(client, 'invoice_draft', { customer: EU, currency: 'HUF', lines: [{ description: 'Tanácsadás (október)', quantity: 1, unitPrice: 1000, vatCode: 'EUFAD37' }] });
    expect(d.invoice.lines[0]).toMatchObject({ unit: 'db', nature: 'SERVICE' });
    expect(d.issues.map((i: Json) => i.code)).not.toContain('LINE_NATURE_MISMATCH');
    const hu = await call(client, 'invoice_draft', { customer: EU, currency: 'HUF', lines: [{ description: 'Tanácsadás (október)', quantity: 1, unitPrice: 1000, vatCode: '27' }] });
    expect(hu.invoice.lines[0].nature).toBe('OTHER');
    expect(hu.issues.find((i: Json) => i.code === 'EU_B2B_OTHER_WITH_HU_VAT')).toMatchObject({ field: 'lines[0].nature' });
  });

  it('the unit and nature descriptions tell a service billed in db to pass nature SERVICE', async () => {
    const client = await connect();
    const schema = (await client.listTools()).tools.find((x) => x.name === 'invoice_draft')?.inputSchema as Json;
    const line = schema.properties.lines.items.properties;
    expect(line.unit.description).toMatch(/service billed in db .*nature SERVICE/);
    expect(line.nature.description).toMatch(/EUFAD37, HO → SERVICE/);
    expect(line.nature.description).toMatch(/OTHER without a unit/);
  });
});

describe('price basis with productId (TAX-6)', () => {
  it('the schema says a product\'s gross basis applies to an explicit unitPrice; the summary names the gross line', async () => {
    const client = await connect();
    const schema = (await client.listTools()).tools.find((x) => x.name === 'invoice_draft')?.inputSchema as Json;
    const line = schema.properties.lines.items.properties;
    expect(line.productId.description).toMatch(/price, priceBasis, VAT code and nature/);
    expect(line.unitPrice.description).toMatch(/With productId and no priceBasis, the product's price basis applies/);
    expect(line.priceBasis.description).toMatch(/Default: the product's price basis with productId, otherwise net/);

    await call(client, 'seller_update', SELLER_INPUT);
    const p = await call(client, 'product_save', { name: 'Kávé', unit: 'db', unitPrice: 1270, priceBasis: 'gross', vatCode: '27' });
    const d = await call(client, 'invoice_draft', {
      customer: DOMESTIC_CUSTOMER_INPUT,
      lines: [
        { description: 'Szállítás', quantity: 1, unit: 'alkalom', unitPrice: 5000, vatCode: '27' },
        { productId: p.product.id, quantity: 10, unitPrice: 1000 },
      ],
    });
    // Unchanged behaviour (docs 6.7): the product's basis is taken over – now visible to the agent.
    expect(d.invoice.lines[1]).toMatchObject({ priceBasis: 'gross', net: '7874', vat: '2126', gross: '10000' });
    expect(plain(d.summary)).toContain('A(z) 2. tétel egységára bruttó (az ÁFÁ-t tartalmazza).');
    const net = await call(client, 'invoice_draft', { customer: DOMESTIC_CUSTOMER_INPUT, lines: [{ productId: p.product.id, quantity: 10, unitPrice: 1000, priceBasis: 'net' }] });
    expect(net.invoice.lines[0]).toMatchObject({ priceBasis: 'net', net: '10000', vat: '2700', gross: '12700' });
    expect(net.summary).not.toMatch(/bruttó \(az ÁFÁ-t/);
  });
});
