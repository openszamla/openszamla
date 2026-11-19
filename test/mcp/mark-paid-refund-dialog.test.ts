/**
 * The invoice_issue confirmation dialog with markPaid says what will be recorded (review N3): a payment
 * from the buyer, a refund to the buyer on a crediting document (visszatérítés a vevőnek), or – when
 * nothing will be open on the new document (a credit note set off against an unpaid invoice, a díjbekérő
 * payment covering it all) – no markPaid sentence, and the result says nothing was recorded.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(): Promise<{ app: OpenSzamla; client: Client; dialogs: string[]; customerId: string }> {
  const t = makeTestApp({ confirmMode: 'elicit', now: () => new Date('2026-11-08T09:00:00.000Z') });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'legacy' } });
  const dialogs: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    dialogs.push(String((request.params as { message?: unknown }).message ?? ''));
    return { action: 'accept', content: { confirm: true } };
  });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, client, dialogs, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

async function tool(client: Client, name: string, args: Json): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

const PAYMENT = 'A vevő kifizette: a befizetés a kiállítás napjával rögzítésre kerül.';
const REFUND = 'Visszatérítés a vevőnek: a visszafizetés a kiállítás napjával rögzítésre kerül.';
const NOTHING = 'A bizonylaton nincs nyitott összeg, ezért befizetés nem lett rögzítve.';
const LICENCE = [{ description: 'Licenc', quantity: 1, unit: 'db', unitPrice: 100000, vatCode: '27' }]; // 127 000 Ft
const CREDIT = [{ description: 'Licenc', quantity: -1, unit: 'db', unitPrice: 30000, vatCode: '27' }]; // −38 100 Ft

async function issue(client: Client, draft: Json, markPaid = true): Promise<Json> {
  return tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode, ...(markPaid ? { markPaid } : {}) });
}

describe('invoice_issue markPaid dialog follows what will be recorded (N3)', () => {
  it('a credit note of a paid invoice: a refund to the buyer', async () => {
    const { app, client, dialogs, customerId } = await connect();
    const original = await issue(client, await tool(client, 'invoice_draft', { customerId, lines: LICENCE }));
    expect(dialogs.at(-1)).toContain(PAYMENT);
    const credit = await tool(client, 'invoice_correct', { invoice: original.invoice.number, lines: CREDIT });
    const r = await issue(client, credit);
    expect(dialogs.at(-1)).toContain(REFUND);
    expect(dialogs.at(-1)).not.toContain('A vevő kifizette');
    expect(r.notes.join(' ')).toMatch(/Visszafizetés rögzítve a kiállítás napjával/);
    expect(app.getInvoice(r.invoice.id).paidAmount).toBe('-38100');
  });

  it('a credit note set off against an unpaid invoice: no markPaid sentence, nothing recorded', async () => {
    const { app, client, dialogs, customerId } = await connect();
    const original = await issue(client, await tool(client, 'invoice_draft', { customerId, lines: LICENCE }), false);
    const credit = await tool(client, 'invoice_correct', { invoice: original.invoice.number, lines: CREDIT });
    const r = await issue(client, credit);
    expect(dialogs.at(-1)).not.toContain('A vevő kifizette');
    expect(dialogs.at(-1)).not.toContain('Visszatérítés');
    expect(r.notes).toContain(NOTHING);
    expect(app.getInvoice(r.invoice.id).paidAmount).toBe('0');
  });

  it('a díjbekérő payment covering the invoice: no sentence; a partial one: the rest is a payment', async () => {
    const { app, client, dialogs, customerId } = await connect();
    const proforma = async (amount: number): Promise<string> => {
      const p = await issue(client, await tool(client, 'invoice_draft', { documentType: 'proforma', customerId, lines: LICENCE }), false);
      await tool(client, 'invoice_record_payment', { invoice: p.invoice.number, amount, date: '2026-11-08', allowOverpayment: true });
      return p.invoice.number as string;
    };
    const overpaid = await tool(client, 'invoice_draft', { copyFromId: await proforma(150000) });
    const r = await issue(client, overpaid);
    expect(dialogs.at(-1)).not.toContain('A vevő kifizette');
    expect(r.notes).toContain(NOTHING);

    const partial = await tool(client, 'invoice_draft', { copyFromId: await proforma(50000) });
    const p = await issue(client, partial);
    expect(dialogs.at(-1)).toContain(PAYMENT);
    expect(p.invoice.paymentStatus).toBe('paid');
    expect(app.getInvoice(p.invoice.id).paidAmount).toBe('127000');
  });

  it('the service says beforehand what markPaid would record (markPaidAmount)', async () => {
    const { app, client, customerId } = await connect();
    const paid = await issue(client, await tool(client, 'invoice_draft', { customerId, lines: LICENCE }));
    const unpaid = await issue(client, await tool(client, 'invoice_draft', { customerId, lines: LICENCE }), false);
    const sale = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'CASH', lines: [{ description: 'Szerviz', quantity: 1, unit: 'db', unitPrice: 12702, priceBasis: 'gross', vatCode: '27' }] });
    expect(app.markPaidAmount(sale.invoice.id)).toBe('12700'); // the cash-rounded payable
    expect(app.markPaidAmount((await tool(client, 'invoice_correct', { invoice: paid.invoice.number, lines: CREDIT })).invoice.id)).toBe('-38100');
    expect(app.markPaidAmount((await tool(client, 'invoice_correct', { invoice: unpaid.invoice.number, lines: CREDIT })).invoice.id)).toBe('0');
    const free = await tool(client, 'invoice_draft', { customerId, lines: [{ description: 'Ingyenes', quantity: 1, unit: 'db', unitPrice: 0, vatCode: '27' }] });
    expect(app.markPaidAmount(free.invoice.id)).toBe('0');
    expect(() => app.markPaidAmount(paid.invoice.id)).toThrow(/már ki van állítva/);
  });
});
