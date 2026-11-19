/**
 * P1-1: a PDF that cannot be rendered at issue never fails the issue (the note says it can be asked for later). Such a
 * document has no original yet: verify warns about it – with the remedy – without reporting a failure, and the first
 * later successful request (invoice_pdf, openszamla pdf, the web download, the tax-audit export) keeps it as the original.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function issuedWithoutPdf(): Promise<{ app: OpenSzamla; id: string }> {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
  vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('nincs elég memória'));
  const r = await app.issue(d.invoice.id);
  expect(r.invoice.status).toBe('issued');
  expect(r.pdfPath).toBeNull();
  expect(r.pdfError).toBe('nincs elég memória');
  expect(r.notes).toContain('A PDF előállítása nem sikerült; a következő PDF-kérés (letöltés) újra megpróbálja, és az így elkészülő PDF lesz az eredeti.');
  expect(app.store.getDocument(r.invoice.id)).toBeNull();
  return { app, id: r.invoice.id };
}

const WARNING =
  'SZ-2026-00001: nincs megőrzött eredeti PDF-je (a kiállításkor nem készült el, és azóta nem kérték le). Kérd le a PDF-jét (invoice_pdf, openszamla pdf vagy a webes „PDF letöltése”): a program akkor elkészíti és megőrzi.';

describe('a PDF that failed at issue (P1-1)', () => {
  it('verify warns – no failure – and the next request keeps it as the original', async () => {
    const { app, id } = await issuedWithoutPdf();
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 0, documentMismatches: [], documentWarnings: [WARNING] });

    const r = await app.pdf(id, {}, 'web');
    expect(r.kind).toBe('original');
    const kept = app.store.getDocument(id);
    expect(kept?.sha256).toBe(r.sha256);
    expect(readFileSync(r.path).equals(kept?.content as Buffer)).toBe(true);
    const entry = app.auditLog({ entityId: id }).items.find((e) => e.action === 'invoice.document');
    expect([entry?.actor, entry?.details.sha256]).toEqual(['web', kept?.sha256]);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 1, documentWarnings: [] });
  });

  it('a render that fails again keeps nothing; the tax-audit export keeps it once it renders', async () => {
    const { app, id } = await issuedWithoutPdf();
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('megint nem'));
    await expect(app.pdf(id)).rejects.toThrow('megint nem');
    expect(app.store.getDocument(id)).toBeNull();
    expect(app.auditLog({ entityId: id }).items.some((e) => e.action === 'invoice.document')).toBe(false);

    const exp = await app.taxAuditExport({ from: '2026-11-01', to: '2026-11-30' });
    const kept = app.store.getDocument(id);
    expect(kept).not.toBeNull();
    expect(readFileSync(join(exp.path, 'pdf', 'SZ-2026-00001.pdf')).equals(kept?.content as Buffer)).toBe(true);
    expect(exp.warnings.filter((w) => w.field === 'pdf')).toEqual([]);
    // The data folder's file is written by the next PDF request (a note until then).
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentWarnings: [], documentNotes: [expect.stringMatching(/^SZ-2026-00001: a pdf\/SZ-2026-00001\.pdf fájl hiányzik/)] });
    expect((await app.pdf(id)).sha256).toBe(kept?.sha256);
    expect(app.verifyIntegrity().documentNotes).toEqual([]);
  });
});
