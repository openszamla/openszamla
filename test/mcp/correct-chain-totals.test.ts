/**
 * invoice_correct shows what the modification does to the invoice: structuredContent.chain (the totals of the invoice
 * with its modifications before and with this one), the same in the summary and in the issue dialog, and a flagged line
 * when the corrected line was given instead of the difference. The web page of the draft says the same.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';
import { startWeb } from '../web/helpers.ts';

type Json = Record<string, any>;
const ft = (v: string): string => formatMoney(v, 'HUF');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('invoice_correct: the totals of the invoice before and with the modification', () => {
  it('chain, summary, the flagged line and the issue dialog', async () => {
    const t = makeTestApp({ confirmMode: 'elicit' });
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
    const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await t.app.issue((await t.app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] })).invoice.id)).invoice;

    const call = async (name: string, args: Json): Promise<Json> => {
      const raw = (await client.callTool({ name, arguments: args })) as Json;
      expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
      return raw.structuredContent as Json;
    };
    // The corrected line instead of the difference.
    const wrong = await call('invoice_correct', { invoice: original.number, comment: 'Mennyiség javítása', lines: [{ description: 'Szoftverfejlesztés', quantity: 12, unit: 'óra', unitPrice: 15000, vatCode: '27' }] });
    expect(wrong.chain).toMatchObject({ originalNumber: original.number, modifications: 0, before: { grossAmount: '190500' }, after: { grossAmount: '419100' } });
    expect(wrong.summary).toContain(`A(z) ${original.number} számla a módosításaival együtt: eddig bruttó ${ft('190500')}, ezzel a módosítással bruttó ${ft('419100')}.`);
    expect(wrong.issues.map((i: Json) => i.code)).toContain('CORRECTION_LINE_REPEATS_ORIGINAL');
    expect(wrong.nextStep).toContain('chain: before → after');
    await call('invoice_delete_draft', { draftId: wrong.invoice.id });

    const right = await call('invoice_correct', { invoice: original.number, comment: 'Mennyiség javítása', lines: [{ description: 'Szoftverfejlesztés', quantity: 2, unit: 'óra', unitPrice: 15000, vatCode: '27' }] });
    expect(right.chain.after.grossAmount).toBe('228600');
    expect(right.issues.map((i: Json) => i.code)).not.toContain('CORRECTION_LINE_REPEATS_ORIGINAL');
    // invoice_get of the draft carries it too; the dialog of issuing names both totals.
    expect((await call('invoice_get', { invoice: right.invoice.id })).chain).toEqual(right.chain);
    await call('invoice_issue', { draftId: right.invoice.id, confirmationCode: right.confirmationCode });
    expect(dialogs.at(-1)).toContain(`eddig bruttó ${ft('190500')}, ezzel a módosítással bruttó ${ft('228600')}.`);
  });

  it('the web page of a modification draft says it in the issue confirmation', async () => {
    const e = await startWeb();
    cleanups.push(() => e.close());
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await e.app.issue((await e.app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] })).invoice.id)).invoice;
    const draft = await e.app.createCorrectionDraft(original.id, { lines: [{ description: 'Szoftverfejlesztés', quantity: '12', unit: 'óra', unitPrice: '15000', vatCode: '27' }], comment: 'Mennyiség javítása' });
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${draft.invoice.id}`)).body;
    expect(page).toContain(`a(z) ${original.number} számla a módosításaival együtt eddig bruttó <strong>${ft('190500')}</strong>, ezzel a módosítással bruttó <strong>${ft('419100')}</strong> lesz.`);
    expect(page).toContain('megismétlésének látszik');
  });
});
