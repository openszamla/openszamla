/**
 * invoice_cancel checks the storno preview before its confirmation code and dialog (PC3): when the storno
 * cannot be issued (here: a végszámla issued after a clean preview deducts the advance), it is refused with
 * VALIDATION_FAILED, the storno hint and the issues, and the user is never asked to approve it – in elicit
 * mode, in both protocol eras. A storno that can be issued, and a díjbekérő withdrawal, still get their dialog.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const STORNO_HINT = 'A sztornó nem állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), majd próbáld újra.';
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

const line = (description: string, quantity: string, unitPrice: string, extra: Partial<LineInput> = {}): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27', ...extra });

describe.each<Era>(['legacy', 'modern'])('invoice_cancel refuses a storno its preview refuses before the dialog (%s era)', (era) => {
  it('a clean preview, then a végszámla deducts the advance: VALIDATION_FAILED, no dialog, nothing cancelled', async () => {
    const m = await connect(era);
    const customerId = m.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const advance = (await m.app.issue((await m.app.createDraft({ customerId, documentType: 'advance', lines: [line('Előleg', '1', '300000')] })).invoice.id)).invoice;
    const preview = await m.call('invoice_cancel_preview', { invoice: advance.number, reason: 'Téves előlegszámla' });
    expect(preview.isError).toBe(false);
    expect(preview.sc.issues).toBeUndefined();
    expect(preview.sc.confirmationCode).toEqual(expect.any(String));
    await m.app.issue((await m.app.createDraft({
      customerId,
      documentType: 'final',
      lines: [line('Gépsor', '1', '1000000'), line('Előleg levonása', '-1', '300000', { advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: advance.fulfillmentDate } })],
    })).invoice.id);

    const r = await m.call('invoice_cancel', { invoice: advance.number, reason: 'Téves előlegszámla', confirmationCode: preview.sc.confirmationCode });
    expect(r.isError).toBe(true);
    expect(r.sc.error).toMatchObject({ code: 'VALIDATION_FAILED', hint: STORNO_HINT, details: { issues: [expect.objectContaining({ code: 'ADVANCE_STILL_DEDUCTED', severity: 'error' })] } });
    expect(r.sc.error.message).toMatch(/^A sztornó számla nem állítható ki: A\(z\) SZ-2026-00001 előlegszámlát a\(z\) SZ-2026-00002 végszámla levonja/);
    expect(m.dialogs).toEqual([]);
    expect(m.app.getInvoice(advance.id).status).toBe('issued');
    expect(m.app.findInvoices({ status: ['draft'] }).total).toBe(0);
    // The preview is checked before the code: a wrong code gets the same refusal, not a request for a new code.
    const wrong = await m.call('invoice_cancel', { invoice: advance.number, reason: 'Téves előlegszámla', confirmationCode: 'nem-jo-kod' });
    expect(wrong.sc.error).toMatchObject({ code: 'VALIDATION_FAILED', hint: STORNO_HINT });
    expect(m.dialogs).toEqual([]);
  });

  it('a storno that can be issued, and a díjbekérő withdrawal, are still confirmed in the dialog', async () => {
    const m = await connect(era);
    const customerId = m.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const invoice = (await m.app.issue((await m.app.createDraft({ customerId, lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
    const preview = await m.call('invoice_cancel_preview', { invoice: invoice.number, reason: 'Téves számla' });
    const done = await m.call('invoice_cancel', { invoice: invoice.number, reason: 'Téves számla', confirmationCode: preview.sc.confirmationCode });
    expect(done.isError).toBe(false);
    expect(m.dialogs).toHaveLength(1);
    expect(m.dialogs[0]).toMatch(/^Sztornózod a\(z\) SZ-2026-00001 számlát\? A sztornó számla: bruttó -254 000 Ft – az eredeti számla ellentéte, teljesítés: 2026-11-14\. .* Vevő: „Árvíztűrő Tükörfúrógép Zrt\.”; ok: „Téves számla”\.$/);
    expect(done.sc.invoice).toMatchObject({ documentType: 'storno' });

    const proforma = (await m.app.issue((await m.app.createDraft({ customerId, documentType: 'proforma', lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
    const p = await m.call('invoice_cancel_preview', { invoice: proforma.number, reason: 'Elállt a vevő' });
    const withdrawn = await m.call('invoice_cancel', { invoice: proforma.number, reason: 'Elállt a vevő', confirmationCode: p.sc.confirmationCode });
    expect(withdrawn.isError).toBe(false);
    expect(m.dialogs.at(-1)).toBe(`Visszavonod a(z) ${proforma.number} díjbekérőt?`);
    expect(m.app.getInvoice(proforma.id).status).toBe('cancelled');
  });
});
