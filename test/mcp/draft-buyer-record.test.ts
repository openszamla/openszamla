/**
 * MCP: a buyer fixed with customer_save reaches the open draft – invoice_get shows the corrected buyer and
 * the confirmation code given before stops matching (MCP-1); customerId and customer together are refused
 * (MCP-13). Both protocol eras.
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

async function connect(era: Era): Promise<Client> {
  const t = makeTestApp({ confirmMode: 'code' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  return client;
}

async function call(client: Client, name: string, args: Json = {}): Promise<{ data: Json; isError: boolean }> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  return { data: raw.structuredContent ?? JSON.parse(raw.content?.[0]?.text ?? '{}'), isError: raw.isError === true };
}

const LINES = [{ description: 'Szoftverfejlesztés', quantity: 10, unit: 'óra', unitPrice: 15000, vatCode: '27' }];
const TYPO = { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 11.' };
const FIXED = { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' };

describe.each<Era>(['legacy', 'modern'])('buyer of a draft from the customer record (%s era)', (era) => {
  it('customer_save after the preview: the preview shows the fix, the old code is refused, the invoice has the fix (MCP-1)', async () => {
    const client = await connect(era);
    expect((await call(client, 'seller_update', SELLER_INPUT)).isError).toBe(false);
    const cus = await call(client, 'customer_save', { ...DOMESTIC_CUSTOMER_INPUT, address: TYPO });
    const d = await call(client, 'invoice_draft', { customerId: cus.data.customer.id, lines: LINES });
    expect(d.data.invoice.buyer.address).toBe('2000 Szentendre, Fő tér 11. (HU)');
    const oldCode = d.data.confirmationCode as string;

    expect((await call(client, 'customer_save', { id: cus.data.customer.id, address: FIXED, taxNumber: '11111111-2-41' })).isError).toBe(false);
    const got = await call(client, 'invoice_get', { invoice: d.data.invoice.id });
    expect(got.data.invoice.buyer).toMatchObject({ address: '2000 Szentendre, Fő tér 1. (HU)', taxNumber: '11111111-2-41' });
    expect(got.data.confirmationCode).not.toBe(oldCode);

    const stale = await call(client, 'invoice_issue', { draftId: d.data.invoice.id, confirmationCode: oldCode });
    expect(stale.data.error.code).toBe('CONFIRMATION_INVALID');
    const issued = await call(client, 'invoice_issue', { draftId: d.data.invoice.id, confirmationCode: got.data.confirmationCode });
    expect(issued.isError, JSON.stringify(issued.data)).toBe(false);
    const final = await call(client, 'invoice_get', { invoice: issued.data.invoice.number });
    expect(final.data.invoice.buyer).toMatchObject({ address: '2000 Szentendre, Fő tér 1. (HU)', taxNumber: '11111111-2-41' });
  });

  it('customerId together with customer is refused on create and on update (MCP-13)', async () => {
    const client = await connect(era);
    await call(client, 'seller_update', SELLER_INPUT);
    const cus = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
    const other = { vatStatus: 'PRIVATE_PERSON', name: 'Másik Ember', address: FIXED };
    const both = await call(client, 'invoice_draft', { customerId: cus.data.customer.id, customer: other, lines: LINES });
    expect(both.isError).toBe(true);
    expect(both.data.error).toMatchObject({ code: 'INVALID_INPUT', message: 'customerId és customer egyszerre nem adható meg.' });
    expect(both.data.error.hint).toMatch(/saveCustomer/);
    const d = await call(client, 'invoice_draft', { customerId: cus.data.customer.id, lines: LINES });
    const upd = await call(client, 'invoice_draft', { draftId: d.data.invoice.id, customerId: cus.data.customer.id, customer: other });
    expect(upd.data.error.code).toBe('INVALID_INPUT');
    expect((await call(client, 'invoice_get', { invoice: d.data.invoice.id })).data.invoice.buyer.name).toBe(DOMESTIC_CUSTOMER_INPUT.name);
  });

  it('the invoice_draft description tells how the buyer is taken', async () => {
    const client = await connect(era);
    const tool = (await client.listTools()).tools.find((x) => x.name === 'invoice_draft');
    expect(tool?.description).toMatch(/CURRENT data/);
    expect(tool?.description).toMatch(/customerId and customer together are rejected/);
  });
});
