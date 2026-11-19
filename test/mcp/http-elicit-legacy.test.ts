/**
 * MCP-10: confirm mode "elicit" over the stateless HTTP endpoint (openszamla serve). A 2025-era request
 * has no session there – no initialize capabilities, no way to send the client a dialog –, so issuing
 * and cancelling get a precise error instead of ELICITATION_UNSUPPORTED, and nothing happens without
 * the dialog. A 2026-07-28 client still gets the dialog (and stdio is unchanged: server.test.ts).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/mcp/http.ts';
import { DOMESTIC_CUSTOMER_INPUT, makeTestApp, SELLER_INPUT, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
const TOKEN = 'elicit-http-test-token-0123456789-abc';
const MESSAGE = 'A 2025-ös protokollú HTTP-kapcsolaton az elicit mód nem érhető el – használd a stdio módot, egy 2026-07-28-as protokollú klienst vagy a code módot.';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function server(): Promise<{ t: TestApp; http: RunningHttpServer }> {
  const t = makeTestApp({ confirmMode: 'elicit' });
  const http = await startHttpServer(t.app, { port: 0, token: TOKEN, web: false });
  cleanups.push(async () => {
    await http.close();
    t.cleanup();
  });
  return { t, http };
}

/** A client that declares form elicitation and accepts every dialog. */
async function client(http: RunningHttpServer, era: 'legacy' | 'modern'): Promise<{ c: Client; dialogs: string[] }> {
  const c = new Client(
    { name: `vitest-elicit-${era}`, version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  const dialogs: string[] = [];
  c.setRequestHandler('elicitation/create', async (request) => {
    dialogs.push(String((request.params as { message?: unknown }).message ?? ''));
    return { action: 'accept', content: { confirm: true } };
  });
  await c.connect(new StreamableHTTPClientTransport(new URL(http.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  cleanups.push(() => c.close());
  return { c, dialogs };
}

async function call(c: Client, name: string, args: Json): Promise<{ isError: boolean; data: Json }> {
  const raw = (await c.callTool({ name, arguments: args })) as Json;
  return { isError: raw.isError === true, data: (raw.structuredContent ?? {}) as Json };
}

async function readyDraft(c: Client, taxNumber: string): Promise<{ id: string; code: string }> {
  expect((await call(c, 'seller_update', SELLER_INPUT)).isError).toBe(false);
  const cus = await call(c, 'customer_save', { ...DOMESTIC_CUSTOMER_INPUT, taxNumber });
  expect(cus.isError, JSON.stringify(cus.data)).toBe(false);
  const d = await call(c, 'invoice_draft', { customerId: cus.data.customer.id, lines: [{ description: 'Fejlesztés', quantity: 1, unit: 'óra', unitPrice: 15000, vatCode: '27' }] });
  expect(d.isError, JSON.stringify(d.data)).toBe(false);
  return { id: d.data.invoice.id as string, code: d.data.confirmationCode as string };
}

describe('elicit mode over the stateless HTTP endpoint', () => {
  it('a 2025-era client cannot issue or cancel: precise error, no dialog, nothing changes', async () => {
    const { t, http } = await server();
    const { c, dialogs } = await client(http, 'legacy');
    const d = await readyDraft(c, '87654323-2-13');
    const issue = await call(c, 'invoice_issue', { draftId: d.id, confirmationCode: d.code });
    expect(issue.isError).toBe(true);
    expect(issue.data.error).toMatchObject({ code: 'ELICITATION_UNAVAILABLE_LEGACY_HTTP', message: MESSAGE });
    expect(issue.data.error.hint).toMatch(/OPENSZAMLA_CONFIRM_MODE=code/);
    expect(t.app.getInvoice(d.id).status).toBe('draft');

    // An invoice issued elsewhere cannot be cancelled from this client either.
    const issued = await t.app.issue(d.id);
    const preview = await call(c, 'invoice_cancel_preview', { invoice: issued.invoice.id, reason: 'Hibás tétel' });
    expect(preview.isError, JSON.stringify(preview.data)).toBe(false);
    const cancel = await call(c, 'invoice_cancel', { invoice: issued.invoice.id, reason: 'Hibás tétel', confirmationCode: preview.data.confirmationCode });
    expect(cancel.isError).toBe(true);
    expect(cancel.data.error.code).toBe('ELICITATION_UNAVAILABLE_LEGACY_HTTP');
    expect(t.app.getInvoice(issued.invoice.id).status).toBe('issued');
    expect(dialogs).toEqual([]);
  });

  it('a 2026-07-28 client still gets the dialog and the invoice is issued', async () => {
    const { t, http } = await server();
    const { c, dialogs } = await client(http, 'modern');
    const d = await readyDraft(c, '11111111-2-41');
    const issue = await call(c, 'invoice_issue', { draftId: d.id, confirmationCode: d.code });
    expect(issue.isError, JSON.stringify(issue.data)).toBe(false);
    expect(issue.data.summary).toMatch(/^Kiállítva: SZ-2026-00001/);
    expect(dialogs).toHaveLength(1);
    expect(t.app.getInvoice(d.id).status).toBe('issued');
  });
});
