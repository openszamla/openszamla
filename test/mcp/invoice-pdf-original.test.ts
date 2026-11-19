/**
 * P1-1 over MCP, in both protocol eras: invoice_pdf returns the kept original of an issued document – its kind and
 * sha256 in structuredContent (and in the summary) – and the openszamla://invoices/{id}/pdf resource returns exactly
 * its bytes, even after the program that renders PDFs changed. A MÁSOLAT and a draft are named as what they are.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(era: Era): Promise<{ t: TestApp; client: Client }> {
  const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-14T09:00:00.000Z') });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  return { t, client };
}

async function call(client: Client, name: string, args: Json = {}): Promise<Json> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
  expect(JSON.parse(raw.content[0].text)).toEqual(raw.structuredContent);
  return raw.structuredContent as Json;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').toUpperCase();
const LINES = [{ description: 'Szoftverfejlesztés', quantity: 10, unit: 'óra', unitPrice: 15000, vatCode: '27' }];

describe.each<Era>(['legacy', 'modern'])('invoice_pdf and the PDF resource serve the original (%s era)', (era) => {
  it('kind, sha256 and the exact bytes of the kept original', async () => {
    const { t, client } = await connect(era);
    await call(client, 'seller_update', SELLER_INPUT);
    const cus = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
    const d = await call(client, 'invoice_draft', { customerId: cus.customer.id, lines: LINES });
    const draftPdf = await call(client, 'invoice_pdf', { invoice: d.invoice.id });
    expect(draftPdf).toMatchObject({ kind: 'draft', sha256: null });
    const issued = await call(client, 'invoice_issue', { draftId: d.invoice.id });
    const kept = t.app.store.getDocument(d.invoice.id);
    expect(kept?.content.equals(readFileSync(issued.pdfPath))).toBe(true);

    // The program that renders PDFs changes (an update): nothing is rendered again.
    t.app.config.software.softwareName = 'OpenSzámla Későbbi Változat';
    const r = await call(client, 'invoice_pdf', { invoice: 'SZ-2026-00001' });
    expect(r).toEqual({
      summary: `A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF. Fájl: ${issued.pdfPath} (SHA-256: ${kept?.sha256})`,
      kind: 'original',
      sha256: kept?.sha256,
      note: 'A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.',
      path: issued.pdfPath,
      bytes: kept?.size,
      copiedTo: null,
    });
    expect(r.sha256).toBe(sha256(kept?.content as Buffer));

    const res = await client.readResource({ uri: `openszamla://invoices/${d.invoice.id}/pdf` });
    const content = res.contents[0] as { mimeType?: string; blob?: string };
    expect(content.mimeType).toBe('application/pdf');
    const bytes = Buffer.from(content.blob ?? '', 'base64');
    expect(bytes.equals(kept?.content as Buffer)).toBe(true);
    expect(sha256(bytes)).toBe(r.sha256);

    const copy = await call(client, 'invoice_pdf', { invoice: 'SZ-2026-00001', copy: true });
    expect(copy).toMatchObject({ kind: 'copy', sha256: null, note: 'MÁSOLAT jelölésű példány, most előállítva – nem az eredeti PDF.' });
    expect(copy.summary).toMatch(/^MÁSOLAT jelölésű példány, most előállítva – nem az eredeti PDF\. Fájl: .*SZ-2026-00001_MASOLAT\.pdf$/);
    expect(readFileSync(copy.path).equals(kept?.content as Buffer)).toBe(false);
  });
});
