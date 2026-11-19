/**
 * invoice_cancel_preview / invoice_cancel over MCP:
 * - a storno refused by validation gets the storno hint, never the draft one (T2.2): in confirm mode none,
 *   and with a code whose preview was fine but the state changed since (a végszámla now deducts the advance);
 * - the storno's fulfilment date – the invoice's current one, which after a date-correcting modification is
 *   not the original's – is in the preview's `storno` object, its summary and the elicit dialog (T2.3).
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { ConfirmMode } from '../../src/service/config.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const STORNO_HINT = 'A sztornó nem állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), majd próbáld újra.';
const plain = (s: string): string => s.replace(/ /g, ' ');

async function connect(confirmMode: ConfirmMode, now: string): Promise<{ app: OpenSzamla; dialogs: string[]; call(name: string, args: Json): Promise<{ sc: Json; isError: boolean }> }> {
  const t = makeTestApp({ confirmMode, now: () => new Date(now) });
  t.app.updateSeller(SELLER_INPUT);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
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

async function advanceOf(app: OpenSzamla): Promise<{ customerId: string; advanceId: string; deductFinal(): Promise<void> }> {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const advance = (await app.issue((await app.createDraft({ customerId, documentType: 'advance', lines: [line('Előleg', '1', '300000')] })).invoice.id)).invoice;
  return {
    customerId,
    advanceId: advance.id,
    async deductFinal() {
      await app.issue((await app.createDraft({
        customerId,
        documentType: 'final',
        lines: [line('Gépsor', '1', '1000000'), line('Előleg levonása', '-1', '300000', { advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: advance.fulfillmentDate } })],
      })).invoice.id);
    },
  };
}

describe('invoice_cancel refused by validation: the storno hint (T2.2)', () => {
  it('confirm mode none: the advance a végszámla deducts', async () => {
    const m = await connect('none', '2026-11-08T09:00:00.000Z');
    const a = await advanceOf(m.app);
    await a.deductFinal();
    const r = await m.call('invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves előlegszámla' });
    expect(r.isError).toBe(true);
    expect(r.sc.error).toMatchObject({ code: 'VALIDATION_FAILED', hint: STORNO_HINT });
    expect(r.sc.error.message).toMatch(/^A sztornó számla nem állítható ki: /);
    expect(JSON.stringify(r.sc.error)).not.toContain('invoice_draft');
    expect(m.app.getInvoice(a.advanceId).status).toBe('issued');
    expect(m.app.findInvoices({ status: ['draft'] }).total).toBe(0);
  });

  it('a code from a clean preview, used after a végszámla started deducting the advance', async () => {
    const m = await connect('code', '2026-11-08T09:00:00.000Z');
    const a = await advanceOf(m.app);
    const preview = await m.call('invoice_cancel_preview', { invoice: 'SZ-2026-00001', reason: 'Téves előlegszámla' });
    expect(preview.sc.issues).toBeUndefined();
    expect(preview.sc.confirmationCode).toEqual(expect.any(String));
    await a.deductFinal();
    const r = await m.call('invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves előlegszámla', confirmationCode: preview.sc.confirmationCode });
    expect(r.isError).toBe(true);
    expect(r.sc.error).toMatchObject({ code: 'VALIDATION_FAILED', hint: STORNO_HINT, details: { issues: [expect.objectContaining({ code: 'ADVANCE_STILL_DEDUCTED' })] } });
    expect(JSON.stringify(r.sc.error)).not.toContain('invoice_draft');
    // The fresh preview now shows the error and offers no code.
    const again = await m.call('invoice_cancel_preview', { invoice: 'SZ-2026-00001', reason: 'Téves előlegszámla' });
    expect(again.sc.confirmationCode).toBeUndefined();
    expect(again.sc.issues.map((i: Json) => i.code)).toEqual(['ADVANCE_STILL_DEDUCTED']);
  });
});

describe("the storno's fulfilment date in the preview, its summary and the dialog (T2.3)", () => {
  it('after a date-correcting modification: the corrected date, marked as such', async () => {
    const m = await connect('elicit', '2026-11-05T09:00:00.000Z');
    const customerId = m.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await m.app.issue((await m.app.createDraft({ customerId, fulfillmentDate: '2026-10-15', lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
    await m.app.issue((await m.app.createCorrectionDraft(original.id, { fulfillmentDate: '2026-11-03', lines: [line('Teljesítés dátuma helyesen: 2026.11.03.', '1', '0')], comment: 'Teljesítési dátum javítása' })).invoice.id);

    const preview = await m.call('invoice_cancel_preview', { invoice: original.number, reason: 'Szerződés felbontva' });
    expect(preview.isError).toBe(false);
    expect(preview.sc.storno).toMatchObject({ gross: '-254000', fulfillmentDate: '2026-11-03' });
    expect(plain(preview.sc.summary)).toContain('együttes ellentéte, teljesítés: 2026-11-03 (javított; az eredeti számláé: 2026-10-15), új sorszámmal.');

    const done = await m.call('invoice_cancel', { invoice: original.number, reason: 'Szerződés felbontva', confirmationCode: preview.sc.confirmationCode });
    expect(done.isError).toBe(false);
    expect(m.dialogs.at(-1)).toContain('teljesítés: 2026-11-03 (javított; az eredeti számláé: 2026-10-15).');
    expect(done.sc.invoice).toMatchObject({ documentType: 'storno', fulfillmentDate: '2026-11-03' });
  });

  it("without a date correction: the original's date", async () => {
    const m = await connect('code', '2026-11-05T09:00:00.000Z');
    const customerId = m.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await m.app.issue((await m.app.createDraft({ customerId, fulfillmentDate: '2026-11-02', lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
    const preview = await m.call('invoice_cancel_preview', { invoice: original.number, reason: 'Téves számla' });
    expect(preview.sc.storno.fulfillmentDate).toBe('2026-11-02');
    expect(plain(preview.sc.summary)).toContain('– az eredeti számla ellentéte, teljesítés: 2026-11-02, új sorszámmal.');
  });
});
