/**
 * C5: invoice_get's pdf names what invoice_pdf serves – the same file, its kind and SHA-256. For a document issued before
 * originals were kept that is the regenerated pdf/<name>_UJRAELOALLITOTT.pdf (null until it is written), never the file
 * an earlier version wrote; for an original, pdf/<name>.pdf only while it holds the kept bytes; for an original not kept
 * yet, no file.
 */
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';
import { legacyDataDir } from '../helpers/legacy-data.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

type Json = Record<string, any>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function connect(app: OpenSzamla): Promise<(name: string, args: Json) => Promise<Json>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return async (name, args) => {
    const r = (await client.callTool({ name, arguments: args })) as Json;
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    return r.structuredContent as Json;
  };
}

describe('invoice_get names the PDF invoice_pdf serves (C5)', () => {
  it('a document issued before originals were kept: the regenerated file once written, never the earlier one', async () => {
    const legacy = await legacyDataDir(() => {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
    });
    cleanups.push(() => legacy.cleanup());
    const app = legacy.open();
    cleanups.push(() => app.close());
    const call = await connect(app);
    const number = legacy.invoice.number as string;
    // The file 0.1.0 wrote is there, but invoice_pdf never serves it.
    expect(legacy.files.get(legacy.invoice.id)?.path).toMatch(/SZ-2026-00002\.pdf$/);
    const before = (await call('invoice_get', { invoice: number })).pdf;
    expect(before).toEqual({ uri: `openszamla://invoices/${legacy.invoice.id}/pdf`, path: null, kind: 'regenerated', sha256: null });
    const served = await call('invoice_pdf', { invoice: number });
    expect(served.kind).toBe('regenerated');
    expect(basename(served.path)).toBe('SZ-2026-00002_UJRAELOALLITOTT.pdf');
    const after = (await call('invoice_get', { invoice: number })).pdf;
    expect(after).toEqual({ uri: `openszamla://invoices/${legacy.invoice.id}/pdf`, path: served.path, kind: 'regenerated', sha256: null });
  });

  it('an original: the file while it holds the kept bytes, with the same SHA-256 as invoice_pdf', async () => {
    const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => t.cleanup());
    const call = await connect(t.app);
    await call('seller_update', SELLER_INPUT);
    const customer = await call('customer_save', DOMESTIC_CUSTOMER_INPUT);
    const d = await call('invoice_draft', { customerId: customer.customer.id, lines: [{ description: 'Tanácsadás', quantity: 2, unit: 'óra', unitPrice: 15000, vatCode: '27' }] });
    const issued = await call('invoice_issue', { draftId: d.invoice.id });
    const served = await call('invoice_pdf', { invoice: 'SZ-2026-00001' });
    const got = (await call('invoice_get', { invoice: 'SZ-2026-00001' })).pdf;
    expect(got).toEqual({ uri: `openszamla://invoices/${d.invoice.id}/pdf`, path: issued.pdfPath, kind: 'original', sha256: served.sha256 });
    expect(got.sha256).toMatch(/^[0-9A-F]{64}$/);
    // Changed outside the program: not what invoice_pdf serves, until invoice_pdf writes the original again.
    writeFileSync(issued.pdfPath, 'kézzel átírva');
    expect((await call('invoice_get', { invoice: 'SZ-2026-00001' })).pdf.path).toBeNull();
    await call('invoice_pdf', { invoice: 'SZ-2026-00001' });
    expect((await call('invoice_get', { invoice: 'SZ-2026-00001' })).pdf.path).toBe(issued.pdfPath);
  });

  it('an original not kept yet (the PDF failed at issue): no file, kind original without a fingerprint', async () => {
    const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => t.cleanup());
    const call = await connect(t.app);
    await call('seller_update', SELLER_INPUT);
    const customer = await call('customer_save', DOMESTIC_CUSTOMER_INPUT);
    const d = await call('invoice_draft', { customerId: customer.customer.id, lines: [{ description: 'Tanácsadás', quantity: 1, unit: 'óra', unitPrice: 15000, vatCode: '27' }] });
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('a PDF most nem készült el'));
    const issued = await call('invoice_issue', { draftId: d.invoice.id });
    expect(issued.pdfPath).toBeNull();
    expect((await call('invoice_get', { invoice: 'SZ-2026-00001' })).pdf).toEqual({ uri: `openszamla://invoices/${d.invoice.id}/pdf`, path: null, kind: 'original', sha256: null });
    const served = await call('invoice_pdf', { invoice: 'SZ-2026-00001' });
    expect((await call('invoice_get', { invoice: 'SZ-2026-00001' })).pdf).toMatchObject({ path: served.path, kind: 'original', sha256: served.sha256 });
  });
});
