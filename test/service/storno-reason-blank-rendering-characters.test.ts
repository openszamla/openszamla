/**
 * C4: characters that render blank – the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0, the blank Braille pattern
 * U+2800 and the other default-ignorable code points (variation selectors, U+034F, the soft hyphen) – are not visible
 * characters. A storno or díjbekérő withdrawal reason made of them is refused like three spaces (before a preview, a
 * confirmation code or the web's confirmation step), and so is a buyer or seller name made only of them: it would print
 * as an empty "Sztornó oka:" or a blank name.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { visibleLength } from '../../src/core/format.ts';
import { validateCustomer } from '../../src/core/validate.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { flashesOf, startWeb, type WebEnv } from '../web/helpers.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const LINES = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' as const }];
const STORNO_TOO_SHORT = { code: 'INVALID_INPUT', message: 'A sztornó oka legalább 3 látható karakterből álljon.' };
const WITHDRAWAL_TOO_SHORT = { code: 'INVALID_INPUT', message: 'A visszavonás oka legalább 3 látható karakterből álljon.' };

const BLANK: ReadonlyArray<[string, string]> = [
  ['three Hangul fillers (U+3164)', 'ㅤㅤㅤ'],
  ['Hangul choseong filler (U+115F)', 'ᅟᅟᅟ'],
  ['Hangul jungseong filler (U+1160)', 'ᅠᅠᅠ'],
  ['halfwidth Hangul filler (U+FFA0)', 'ﾠﾠﾠ'],
  ['blank Braille pattern (U+2800)', '⠀⠀⠀'],
  ['variation selectors, U+034F and soft hyphens', '️͏­︎'],
  ['two letters and fillers', 'ㅤaㅤbㅤ'],
];

async function app(): Promise<{ app: OpenSzamla; invoice: string; proforma: string }> {
  const t: TestApp = makeTestApp({ now: () => new Date('2026-11-19T09:00:00.000Z') });
  cleanups.push(() => t.cleanup());
  t.app.updateSeller(SELLER_INPUT);
  const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const issue = async (documentType: 'invoice' | 'proforma'): Promise<string> =>
    (await t.app.issue((await t.app.createDraft({ customerId, documentType, lines: LINES })).invoice.id)).invoice.id;
  return { app: t.app, invoice: await issue('invoice'), proforma: await issue('proforma') };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('nothing thrown');
}

describe('blank-rendering characters are not visible characters (C4)', () => {
  it('visibleLength counts only what shows', () => {
    for (const [label, text] of BLANK) expect(visibleLength(text), label).toBeLessThan(3);
    expect(visibleLength('Téves vevő')).toBe(9);
    expect(visibleLength('ábc')).toBe(4); // a combining mark on a letter is part of what shows
    expect(visibleLength('👍👍👍')).toBe(3);
  });

  it.each(BLANK)('a storno and a withdrawal reason of %s are refused before anything is made', async (_label, reason) => {
    const { app: a, invoice, proforma } = await app();
    expect(thrown(() => a.stornoPreview(invoice, reason))).toMatchObject(STORNO_TOO_SHORT);
    expect(thrown(() => a.cancelReason(invoice, reason))).toMatchObject(STORNO_TOO_SHORT);
    expect(thrown(() => a.cancelFingerprint(invoice, reason))).toMatchObject(STORNO_TOO_SHORT);
    await expect(a.cancel(invoice, { reason })).rejects.toMatchObject(STORNO_TOO_SHORT);
    await expect(a.cancel(proforma, { reason })).rejects.toMatchObject(WITHDRAWAL_TOO_SHORT);
    expect(a.getInvoice(invoice).status).toBe('issued');
    expect(a.getInvoice(proforma).status).toBe('issued');
    expect(a.findInvoices({ documentType: ['storno'], status: ['draft', 'issued'] }).total).toBe(0);
  });

  it('a reason with three visible characters next to fillers is accepted and kept as given', async () => {
    const { app: a, invoice } = await app();
    expect(a.stornoPreview(invoice, 'Hibaㅤ').reason).toBe('Hibaㅤ');
  });

  it('MCP: invoice_cancel_preview refuses a filler-only reason without a confirmation code', async () => {
    const { app: a, invoice } = await app();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(a), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    const r = (await client.callTool({ name: 'invoice_cancel_preview', arguments: { invoice, reason: 'ㅤㅤㅤ' } })) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject(STORNO_TOO_SHORT);
    expect(JSON.stringify(r.structuredContent)).not.toContain('confirmationCode');
  });

  it('the web: the preview refuses it with the service message and offers no confirmation', async () => {
    const e: WebEnv = await startWeb({ now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => e.close());
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const id = (await e.app.issue((await e.app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice.id;
    const b = await e.loggedIn();
    const page = await b.follow(await b.post(`/invoices/${id}/cancel-preview`, { reason: 'ㅤㅤㅤ' }));
    expect(flashesOf(page.body)).toContain(STORNO_TOO_SHORT.message);
    expect(page.body).not.toContain('name="confirmation"');
    expect(e.app.getInvoice(id).status).toBe('issued');
  });

  it('a buyer or seller name made only of fillers counts as missing', async () => {
    const { app: a } = await app();
    expect(validateCustomer({ ...DOMESTIC_CUSTOMER_INPUT, name: 'ㅤㅤ' }).map((i) => i.code)).toContain('CUSTOMER_NAME_REQUIRED');
    expect(() => a.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, taxNumber: '11111111-2-41', name: '⠀ㅤ' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED', message: expect.stringContaining('A vevő neve kötelező') }),
    );
    expect(a.updateSeller({ name: 'ﾠ' }).issues.map((i) => i.code)).toContain('SELLER_NAME_REQUIRED');
    expect(validateCustomer({ ...DOMESTIC_CUSTOMER_INPUT, name: 'Kftㅤ' }).map((i) => i.code)).not.toContain('CUSTOMER_NAME_REQUIRED');
  });
});
