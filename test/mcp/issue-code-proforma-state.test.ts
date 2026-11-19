/**
 * The invoice_issue confirmation code of a document converted from a paid díjbekérő is bound to what
 * issuing does with that payment (review N1): the díjbekérő's paid amount (and date), another document
 * already made from it, and whether the payment is carried over. A code minted before any of these
 * changed is refused (CONFIRMATION_INVALID), and a fresh preview shows the current warnings – so a
 * second conversion cannot be issued blind as an unpaid duplicate, and a payment recorded after the
 * preview cannot raise the carried amount under the old code. markPaid stays outside the code.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(): Promise<{ t: TestApp; client: Client; customerId: string }> {
  const t = makeTestApp({ confirmMode: 'code', now: () => new Date('2026-11-08T09:00:00.000Z') });
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
  return { t, client, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

async function call(client: Client, name: string, args: Json): Promise<{ isError: boolean; sc: Json }> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  return { isError: !!raw.isError, sc: raw.structuredContent as Json };
}

async function tool(client: Client, name: string, args: Json): Promise<Json> {
  const r = await call(client, name, args);
  expect(r.isError, JSON.stringify(r.sc)).toBe(false);
  return r.sc;
}

const LICENCE = [{ description: 'Licenc', quantity: 1, unit: 'db', unitPrice: 100000, vatCode: '27' }]; // 127 000 Ft
const codes = (sc: Json): string[] => (sc.issues as Json[]).map((i) => i.code as string);

async function proforma(client: Client, customerId: string, amount?: number): Promise<string> {
  const d = await tool(client, 'invoice_draft', { documentType: 'proforma', customerId, lines: LICENCE });
  const number = (await tool(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode })).invoice.number as string;
  await tool(client, 'invoice_record_payment', { invoice: number, ...(amount === undefined ? {} : { amount }), date: '2026-11-05' });
  return number;
}

describe('the issue code of a conversion covers the díjbekérő payment state (N1)', () => {
  it('another conversion issued meanwhile: the old code is refused, the new preview says PROFORMA_ALREADY_INVOICED', async () => {
    const { t, client, customerId } = await connect();
    const p = await proforma(client, customerId);
    const first = await tool(client, 'invoice_draft', { copyFromId: p, fulfillmentDate: '2026-11-05' });
    const second = await tool(client, 'invoice_draft', { copyFromId: p, fulfillmentDate: '2026-11-05' });
    expect(codes(second)).toContain('PROFORMA_PAYMENT_CARRIED');
    const issued = await tool(client, 'invoice_issue', { draftId: first.invoice.id, confirmationCode: first.confirmationCode });
    expect(issued.invoice.paymentStatus).toBe('paid');

    const stale = await call(client, 'invoice_issue', { draftId: second.invoice.id, confirmationCode: second.confirmationCode });
    expect(stale.isError).toBe(true);
    expect(stale.sc.error.code).toBe('CONFIRMATION_INVALID');
    expect(t.app.getInvoice(second.invoice.id).status).toBe('draft');

    const fresh = await tool(client, 'invoice_get', { invoice: second.invoice.id });
    expect(codes(fresh)).toContain('PROFORMA_ALREADY_INVOICED');
    expect(fresh.confirmationCode).not.toBe(second.confirmationCode);
    // Issued knowingly with the fresh code: no second carry.
    const again = await tool(client, 'invoice_issue', { draftId: second.invoice.id, confirmationCode: fresh.confirmationCode });
    expect(again.invoice.paymentStatus).toBe('unpaid');
  });

  it('a payment recorded on the díjbekérő after the preview: the old code is refused, the new preview names the new amount', async () => {
    const { t, client, customerId } = await connect();
    const p = await proforma(client, customerId, 27000);
    const draft = await tool(client, 'invoice_draft', { copyFromId: p, fulfillmentDate: '2026-11-05' });
    await tool(client, 'invoice_record_payment', { invoice: p, amount: 100000, date: '2026-11-05' });

    const stale = await call(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode });
    expect(stale.sc.error?.code).toBe('CONFIRMATION_INVALID');
    expect(t.app.getInvoice(draft.invoice.id).status).toBe('draft');
    const fresh = await tool(client, 'invoice_get', { invoice: draft.invoice.id });
    expect((fresh.issues as Json[]).find((i) => i.code === 'PROFORMA_PAYMENT_CARRIED')?.message).toContain(`${formatMoney('127000', 'HUF')} befizetés van rögzítve`);
    const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: fresh.confirmationCode });
    expect(issued.invoice.paymentStatus).toBe('paid');
  });

  it('a payment taken back, or the díjbekérő withdrawn, after the preview changes the carry decision: the old code is refused', async () => {
    const { client, customerId } = await connect();
    const p = await proforma(client, customerId);
    const draft = await tool(client, 'invoice_draft', { copyFromId: p, fulfillmentDate: '2026-11-05' });
    await tool(client, 'invoice_record_payment', { invoice: p, amount: -127000 });
    expect((await call(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode })).sc.error?.code).toBe('CONFIRMATION_INVALID');
    const unpaid = await tool(client, 'invoice_get', { invoice: draft.invoice.id });
    expect(codes(unpaid).filter((c) => c.startsWith('PROFORMA_'))).toEqual([]);

    await tool(client, 'invoice_record_payment', { invoice: p, date: '2026-11-05' });
    const paid = await tool(client, 'invoice_get', { invoice: draft.invoice.id });
    const preview = await tool(client, 'invoice_cancel_preview', { invoice: p, reason: 'Visszavont ajánlat' });
    await tool(client, 'invoice_cancel', { invoice: p, reason: 'Visszavont ajánlat', confirmationCode: preview.confirmationCode });
    expect((await call(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: paid.confirmationCode })).sc.error?.code).toBe('CONFIRMATION_INVALID');
    expect(codes(await tool(client, 'invoice_get', { invoice: draft.invoice.id }))).toContain('PROFORMA_PAYMENT_NOT_CARRIED');
  });

  it('nothing changed: the code is valid, with or without markPaid', async () => {
    const { client, customerId } = await connect();
    const p = await proforma(client, customerId, 27000);
    const draft = await tool(client, 'invoice_draft', { copyFromId: p, fulfillmentDate: '2026-11-05' });
    expect((await tool(client, 'invoice_get', { invoice: draft.invoice.id })).confirmationCode).toBe(draft.confirmationCode);
    const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode, markPaid: true });
    expect(issued.invoice.paymentStatus).toBe('paid');
  });
});
