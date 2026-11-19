/**
 * MCP resources follow the protocol (MCP-14): an unknown id is "resource not found" (-32602 with
 * data.uri), the stdio server notifies resource list changes (2025 era: unsolicited, 2026-07-28:
 * on a subscriptions/listen stream), the HTTP endpoint does not advertise them, and invoice_get gives
 * the PDF reference in structuredContent too.
 */
import { existsSync } from 'node:fs';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(era: Era): Promise<Client> {
  const t = makeTestApp({ confirmMode: 'none' });
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

async function call(client: Client, name: string, args: Json = {}): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

const LINES = [{ description: 'Szoftverfejlesztés', quantity: 10, unit: 'óra', unitPrice: 15000, vatCode: '27' }];

describe.each<Era>(['legacy', 'modern'])('MCP resources (%s era)', (era) => {
  it('an unknown invoice, PDF or customer id is "resource not found", not an internal error', async () => {
    const client = await connect(era);
    for (const uri of ['openszamla://invoices/inv_doesnotexist', 'openszamla://invoices/inv_doesnotexist/pdf', 'openszamla://customers/cus_nope']) {
      const err = (await client.readResource({ uri }).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: number; data?: { uri?: string }; message?: string } | null;
      expect(err, uri).not.toBeNull();
      expect(err?.code, uri).toBe(-32602);
      expect(err?.data?.uri, uri).toBe(uri);
      expect(err?.message, uri).toMatch(/nem található/);
    }
  });

  it('notifies resource list changes after customer_save, invoice_issue and invoice_cancel', async () => {
    const client = await connect(era);
    expect(client.getServerCapabilities()?.resources?.listChanged).toBe(true);
    let changes = 0;
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      changes++;
    });
    const sub = era === 'modern' ? await client.listen({ resourcesListChanged: true }) : null;
    await call(client, 'seller_update', SELLER_INPUT);
    const cus = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
    const d = await call(client, 'invoice_draft', { customerId: cus.customer.id, lines: LINES });
    await call(client, 'invoice_issue', { draftId: d.invoice.id });
    await call(client, 'invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves számla' });
    for (let i = 0; i < 50 && changes < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(changes).toBe(3);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([`openszamla://customers/${cus.customer.id}`, `openszamla://invoices/${d.invoice.id}`]),
    );
    await sub?.close();
  });

  it('invoice_get of an issued invoice gives the PDF resource and file in structuredContent', async () => {
    const client = await connect(era);
    await call(client, 'seller_update', SELLER_INPUT);
    const cus = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
    const d = await call(client, 'invoice_draft', { customerId: cus.customer.id, lines: LINES });
    expect((await call(client, 'invoice_get', { invoice: d.invoice.id })).pdf).toBeUndefined();
    const issued = await call(client, 'invoice_issue', { draftId: d.invoice.id });
    const got = await call(client, 'invoice_get', { invoice: 'SZ-2026-00001' });
    expect(got.pdf).toEqual({ uri: `openszamla://invoices/${d.invoice.id}/pdf`, path: issued.pdfPath, kind: 'original', sha256: expect.stringMatching(/^[0-9A-F]{64}$/) });
    expect(existsSync(got.pdf.path)).toBe(true);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('a server per request cannot notify: resources.listChanged is not advertised (both eras)', async () => {
    const t = makeTestApp();
    const token = 'test-token-0123456789-0123456789-abc';
    const http = await startHttpServer(t.app, { port: 0, token, web: false });
    cleanups.push(async () => {
      await http.close();
      t.cleanup();
    });
    for (const mode of ['legacy', 'auto'] as const) {
      const client = new Client({ name: `vitest-http-${mode}`, version: '1.0.0' }, { versionNegotiation: { mode } });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      cleanups.push(() => client.close());
      expect(client.getServerCapabilities()?.resources?.listChanged, mode).toBeFalsy();
      const err = (await client.readResource({ uri: 'openszamla://invoices/inv_doesnotexist' }).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: number } | null;
      expect(err?.code, mode).toBe(-32602);
    }
  });
});
