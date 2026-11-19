/**
 * MCP-5: a cash or card sale is paid on the spot. invoice_issue markPaid records the full amount still
 * open as paid on the issue date (logged; the content and its hash untouched; not part of the
 * confirmation code, but said in the confirmation dialog). Without it a CASH / CARD invoice gets a
 * nextStep telling the agent to record the payment.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { invoiceContentHash } from '../../src/service/app.ts';
import type { ConfirmMode } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connectMarkPaid(opts: { confirmMode?: ConfirmMode; elicit?: boolean } = {}): Promise<{ t: TestApp; client: Client; dialogs: string[]; customerId: string }> {
  const t = makeTestApp({ confirmMode: opts.confirmMode ?? 'code', now: () => new Date('2026-11-08T09:00:00.000Z') });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: opts.elicit ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: 'legacy' } });
  const dialogs: string[] = [];
  if (opts.elicit) {
    client.setRequestHandler('elicitation/create', async (request) => {
      dialogs.push(String((request.params as { message?: unknown }).message ?? ''));
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  t.app.updateSeller(SELLER_INPUT);
  return { t, client, dialogs, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

async function tool(client: Client, name: string, args: Json): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  return raw.structuredContent as Json;
}

const SALE = [{ description: 'Szerviz', quantity: 1, unitPrice: 12702, priceBasis: 'gross', vatCode: '27' }];
const NEXT_STEP = 'Készpénzes/kártyás számla: ha a vevő már fizetett, rögzítsd a befizetést (invoice_record_payment), vagy add meg a markPaid: true-t a kiállításkor.';

describe('invoice_issue markPaid (MCP-5)', () => {
  it('records the full (cash-rounded) amount as paid on the issue date – the confirmation code is the same with or without it', async () => {
    const { t, client, customerId } = await connectMarkPaid();
    const draft = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'CASH', lines: SALE });
    const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode, markPaid: true });
    expect(issued.invoice).toMatchObject({ paymentStatus: 'paid', payable: '12700', dueDate: '2026-11-08' });
    expect(issued.nextStep).toBeUndefined();
    expect(issued.notes.join(' ')).toMatch(/Befizetés rögzítve a kiállítás napjával \(2026\.11\.08\.\)/);
    const inv = t.app.getInvoice(issued.invoice.id);
    expect([inv.paidAmount, inv.paidDate]).toEqual(['12700', '2026-11-08']);
    expect(inv.contentHash).toBe(invoiceContentHash(inv));
    const log = t.app.auditLog({ entityId: inv.id }).items;
    // The original PDF is kept after the issue transaction (invoice.document).
    expect(log.map((e) => e.action)).toEqual(['invoice.document', 'invoice.payment', 'invoice.issue', 'invoice.draft.create']);
    expect(log[1]?.details).toMatchObject({ amount: '12700', date: '2026-11-08', paymentStatus: 'paid', markPaid: true });
    // The next day it is no overdue receivable.
    expect(t.app.findInvoices({ overdueOn: '2026-11-09' }).total).toBe(0);
    expect(t.app.status().counts.unpaid).toBe(0);
  });

  it('a cash or card invoice issued without it says how to record the payment; a transfer does not', async () => {
    const { client, customerId } = await connectMarkPaid({ confirmMode: 'none' });
    for (const paymentMethod of ['CASH', 'CARD']) {
      const draft = await tool(client, 'invoice_draft', { customerId, paymentMethod, lines: SALE });
      const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id });
      expect(issued.invoice.paymentStatus).toBe('unpaid');
      expect(issued.nextStep).toBe(NEXT_STEP);
    }
    const transfer = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'TRANSFER', lines: SALE });
    expect((await tool(client, 'invoice_issue', { draftId: transfer.invoice.id })).nextStep).toBeUndefined();
    const proforma = await tool(client, 'invoice_draft', { customerId, documentType: 'proforma', paymentMethod: 'CASH', lines: SALE });
    expect((await tool(client, 'invoice_issue', { draftId: proforma.invoice.id })).nextStep).toBeUndefined();
  });

  it('the confirmation dialog says the payment is recorded', async () => {
    const { client, dialogs, customerId } = await connectMarkPaid({ confirmMode: 'elicit', elicit: true });
    const draft = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'CARD', lines: SALE });
    const issued = await tool(client, 'invoice_issue', { draftId: draft.invoice.id, confirmationCode: draft.confirmationCode, markPaid: true });
    expect(issued.invoice.paymentStatus).toBe('paid');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('A vevő kifizette: a befizetés a kiállítás napjával rögzítésre kerül.');
    const other = await tool(client, 'invoice_draft', { customerId, paymentMethod: 'TRANSFER', lines: SALE });
    await tool(client, 'invoice_issue', { draftId: other.invoice.id, confirmationCode: other.confirmationCode });
    expect(dialogs[1]).not.toContain('A vevő kifizette');
  });

  it('records only what is still open: after a carried díjbekérő payment, or nothing on a settled credit note', async () => {
    const { t, customerId } = await connectMarkPaid();
    const app = t.app;
    const p = (await app.issue((await app.createDraft({ documentType: 'proforma', customerId, lines: [{ description: 'Licenc', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] })).invoice.id)).invoice;
    app.recordPayment(p.id, { amount: '27000', date: '2026-11-08' });
    const converted = await app.issue((await app.createDraft({ copyFromId: p.id })).invoice.id, { markPaid: true });
    expect(converted.invoice).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
    expect(app.auditLog({ entityId: converted.invoice.id }).items.filter((e) => e.action === 'invoice.payment').map((e) => e.details.amount)).toEqual(['100000', '27000']);
    // A credit note of the (unpaid) invoice is set off against it: nothing to refund, nothing recorded.
    const unpaid = (await app.issue((await app.createDraft({ customerId, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] })).invoice.id)).invoice;
    const credit = await app.issue((await app.createCorrectionDraft(unpaid.id, { lines: [{ description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] })).invoice.id, { markPaid: true });
    expect(credit.invoice).toMatchObject({ paymentStatus: 'paid', paidAmount: '0' });
    expect(credit.notes.join(' ')).toMatch(/nincs nyitott összeg/);
  });
});
