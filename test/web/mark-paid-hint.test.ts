/**
 * One rule decides when a sale counts as paid on the spot (review R5): OpenSzamla.markPaidHint – a cash or
 * card document something is payable on, not a díjbekérő ('suggested'); another payable document
 * ('offered'); nothing payable or a díjbekérő (null), with the sign read by decimal.ts. The web issue form's
 * "A vevő kifizette" box (shown, ticked) and the MCP invoice_issue nextStep both follow it.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { formFields, startWeb, type WebEnv } from './helpers.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function env(): Promise<{ e: WebEnv; client: Client; customerId: string }> {
  const e = await startWeb({ now: () => new Date('2026-11-08T09:00:00.000Z') });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(e.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    await e.close();
  });
  e.app.updateSeller(SELLER_INPUT);
  return { e, client, customerId: e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

async function tool(client: Client, name: string, args: Json): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

const LINE = (unitPrice: number) => [{ description: 'Szerviz', quantity: 1, unit: 'db', unitPrice, vatCode: '27' }];

describe('paid on the spot: one service rule for the web form and the MCP nextStep (R5)', () => {
  it('cash and card sales are suggested, a transfer offered, a díjbekérő and a 0 Ft or crediting document not', async () => {
    const { e, client, customerId } = await env();
    const b = await e.loggedIn();
    const cases: Array<[string, Json, 'suggested' | 'offered' | null]> = [
      ['cash', { paymentMethod: 'CASH', lines: LINE(10000) }, 'suggested'],
      ['card', { paymentMethod: 'CARD', lines: LINE(10000) }, 'suggested'],
      ['transfer', { paymentMethod: 'TRANSFER', lines: LINE(10000) }, 'offered'],
      ['cash díjbekérő', { documentType: 'proforma', paymentMethod: 'CASH', lines: LINE(10000) }, null],
      ['cash, 0 Ft', { paymentMethod: 'CASH', lines: LINE(0) }, null],
    ];
    for (const [label, args, expected] of cases) {
      const draft = await tool(client, 'invoice_draft', { customerId, ...args });
      const preview = e.app.viewInvoice(draft.invoice.id).invoice;
      expect(e.app.markPaidHint(preview), label).toBe(expected);
      // The web issue form: offered → the box is there; suggested → it is ticked.
      const page = await b.get(`/invoices/${draft.invoice.id}`);
      expect(page.body.includes('name="markPaid"'), label).toBe(expected !== null);
      if (expected !== null) expect(formFields(page.body, `/invoices/${draft.invoice.id}/issue`).markPaid, label).toBe(expected === 'suggested' ? 'yes' : undefined);
      // MCP: issued without markPaid, only a suggested sale asks to record the payment.
      const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode });
      expect(issued.nextStep !== undefined, label).toBe(expected === 'suggested');
    }
  });

  it('a crediting cash document is not paid on the spot, and an issued paid sale gets no nextStep', async () => {
    const { e, client, customerId } = await env();
    const b = await e.loggedIn();
    const sale = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'CASH', lines: LINE(10000) });
    const issued = await tool(client, 'invoice_issue', { draftId: sale.invoice.id, confirmationCode: sale.confirmationCode, markPaid: true });
    expect(issued.nextStep).toBeUndefined();
    const credit = await tool(client, 'invoice_correct', { invoice: issued.invoice.number, lines: [{ description: 'Szerviz', quantity: -1, unit: 'db', unitPrice: 1000, vatCode: '27' }] });
    const preview: Invoice = e.app.viewInvoice(credit.invoice.id).invoice;
    expect(preview.paymentMethod).toBe('CASH');
    expect(e.app.markPaidHint(preview)).toBeNull();
    expect((await b.get(`/invoices/${credit.invoice.id}`)).body).not.toContain('name="markPaid"');
    expect((await tool(client, 'invoice_issue', { draftId: credit.invoice.id, confirmationCode: credit.confirmationCode })).nextStep).toBeUndefined();
  });
});
