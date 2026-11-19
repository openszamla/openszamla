/**
 * A storno or díjbekérő withdrawal reason that passes the schema's 3 characters but has fewer than 3 visible
 * ones once normalised – three spaces, bidi controls only – is refused with INVALID_INPUT by
 * invoice_cancel_preview (no confirmation code) and invoice_cancel (no dialog, nothing cancelled) (PC5). The
 * preview shows the reason as the service normalised it, and the storno carries the same text.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const plain = (s: string): string => s.replace(/ /g, ' ');

async function connect(era: Era): Promise<{ app: OpenSzamla; dialogs: string[]; call(name: string, args: Json): Promise<{ sc: Json; isError: boolean }> }> {
  const t = makeTestApp({ confirmMode: 'elicit', now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client(
    { name: 'vitest', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  const dialogs: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    dialogs.push(plain(String((request.params as { message?: unknown }).message ?? '')));
    return { action: 'accept', content: { confirm: true } };
  });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  return {
    app: t.app,
    dialogs,
    async call(name, args) {
      const raw = (await client.callTool({ name, arguments: args })) as Json;
      return { sc: raw.structuredContent as Json, isError: raw.isError === true };
    },
  };
}

const LINES = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' as const }];
const BLANK = [
  ['three spaces', '   '],
  ['bidi controls only', '‮‭‬'],
] as const;

async function issued(app: OpenSzamla, documentType: 'invoice' | 'proforma' = 'invoice'): Promise<string> {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  return (await app.issue((await app.createDraft({ customerId, documentType, lines: LINES })).invoice.id)).invoice.number as string;
}

describe.each<Era>(['legacy', 'modern'])('a blank storno reason (%s era)', (era) => {
  it.each(BLANK)('%s: the preview gives no code, the storno is refused without a dialog', async (_label, reason) => {
    const m = await connect(era);
    const number = await issued(m.app);
    const preview = await m.call('invoice_cancel_preview', { invoice: number, reason });
    expect(preview.isError).toBe(true);
    expect(preview.sc.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A sztornó oka legalább 3 látható karakterből álljon.' });
    expect(preview.sc.confirmationCode).toBeUndefined();

    // Even with a code from a preview with a real reason.
    const valid = await m.call('invoice_cancel_preview', { invoice: number, reason: 'Téves számla' });
    const r = await m.call('invoice_cancel', { invoice: number, reason, confirmationCode: valid.sc.confirmationCode });
    expect(r.sc.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A sztornó oka legalább 3 látható karakterből álljon.' });
    expect(m.dialogs).toEqual([]);
    expect(m.app.getInvoice(number).status).toBe('issued');
  });

  it.each(BLANK)('%s: a díjbekérő withdrawal is refused the same way', async (_label, reason) => {
    const m = await connect(era);
    const number = await issued(m.app, 'proforma');
    const preview = await m.call('invoice_cancel_preview', { invoice: number, reason });
    expect(preview.sc.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A visszavonás oka legalább 3 látható karakterből álljon.' });
    expect(preview.sc.confirmationCode).toBeUndefined();
    const valid = await m.call('invoice_cancel_preview', { invoice: number, reason: 'Elállt a vevő' });
    const r = await m.call('invoice_cancel', { invoice: number, reason, confirmationCode: valid.sc.confirmationCode });
    expect(r.sc.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A visszavonás oka legalább 3 látható karakterből álljon.' });
    expect(m.dialogs).toEqual([]);
    expect(m.app.getInvoice(number).status).toBe('issued');
  });

  it('the preview shows the normalised reason, and the storno carries the same', async () => {
    const m = await connect(era);
    const number = await issued(m.app);
    const given = ' Téves ‮  számla \r\n ';
    const preview = await m.call('invoice_cancel_preview', { invoice: number, reason: given });
    expect(preview.sc.reason).toBe('Téves számla');
    expect(plain(preview.sc.summary)).toMatch(/; ok: „Téves számla”\.$/);
    const done = await m.call('invoice_cancel', { invoice: number, reason: given, confirmationCode: preview.sc.confirmationCode });
    expect(done.isError).toBe(false);
    expect(m.dialogs.at(-1)).toMatch(/; ok: „Téves számla”\.$/);
    expect(m.app.getInvoice(done.sc.invoice.id).comment).toBe('Sztornó oka: Téves számla');
  });
});
