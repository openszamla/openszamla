/**
 * P1-1 in the web UI: "PDF letöltése" sends the kept original of an issued document – exactly its bytes, even after the
 * program changed and when the pdf/ file was altered – and a document issued before originals were kept downloads as
 * the regenerated file, named so (<number>_UJRAELOALLITOTT.pdf).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { legacyDataDir } from '../helpers/legacy-data.ts';
import { Browser, startWeb, TOKEN } from './helpers.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('the web PDF download sends the original (P1-1)', () => {
  it('an issued document: the kept bytes, not a new render, and not the altered file', async () => {
    const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
    cleanups.push(() => e.close());
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await e.app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '3', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const issued = await e.app.issue(d.invoice.id);
    const kept = e.app.store.getDocument(d.invoice.id)?.content as Buffer;
    e.app.config.software.softwareName = 'OpenSzámla Későbbi Változat';
    writeFileSync(issued.pdfPath as string, 'nem az eredeti');

    const b = await e.loggedIn();
    const r = await b.get(`/invoices/${d.invoice.id}.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('attachment; filename="SZ-2026-00001.pdf"');
    expect(r.buf.equals(kept)).toBe(true);
    expect(readFileSync(issued.pdfPath as string).equals(kept)).toBe(true);
    // A draft is still a TERVEZET render.
    const draft = await e.app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const t = await b.get(`/invoices/${draft.invoice.id}.pdf`);
    expect(t.headers['content-disposition']).toBe(`attachment; filename="TERVEZET_${draft.invoice.id}.pdf"`);
    expect(e.app.store.getDocument(draft.invoice.id)).toBeNull();
  });

  it('a document issued before originals were kept: the regenerated file, named so, logged as the web', async () => {
    const legacy = await legacyDataDir(() => {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
    });
    cleanups.push(() => legacy.cleanup());
    const app = legacy.open();
    const http = await startHttpServer(app, { port: 0, token: TOKEN });
    cleanups.push(() => http.close());
    const b = new Browser(http.url);
    await b.login();
    const r = await b.get(`/invoices/${legacy.invoice.id}.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="SZ-2026-00002_UJRAELOALLITOTT.pdf"');
    expect(r.buf.equals(readFileSync(join(legacy.config.pdfDir, 'SZ-2026-00002_UJRAELOALLITOTT.pdf')))).toBe(true);
    expect(r.buf.equals(legacy.files.get(legacy.invoice.id)?.bytes as Buffer)).toBe(false);
    expect(app.store.getDocument(legacy.invoice.id)).toBeNull();
    const logged = app.auditLog({ entityId: legacy.invoice.id }).items.find((x) => x.action === 'invoice.pdf_regenerated');
    expect(logged?.actor).toBe('web');
    // The invoice page names the entry.
    expect((await b.get(`/invoices/${legacy.invoice.id}`)).body).toContain('PDF újra előállítva (nem az eredeti)');
  });
});
