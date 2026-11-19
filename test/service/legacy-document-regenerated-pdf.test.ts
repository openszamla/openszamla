/**
 * P1-1: a document issued before originals were kept (0.1.0 data) has no original. Its PDF is rendered with the running
 * version into pdf/<name>_UJRAELOALLITOTT.pdf (kind 'regenerated', with a note that it is not the PDF handed over),
 * logged when that file is written, and never stored as its original; the pdf/<name>.pdf 0.1.0 wrote stays untouched.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { REGENERATED_PDF_SUFFIX } from '../../src/service/app.ts';
import { VERSION } from '../../src/version.ts';
import { LEGACY_SOFTWARE, legacyDataDir, type LegacyData } from '../helpers/legacy-data.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const failRender = (): void => {
  vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
};

let legacy: LegacyData | null = null;
afterEach(() => {
  legacy?.cleanup();
  legacy = null;
});

describe('a document issued before originals were kept (P1-1)', () => {
  it('gets a regenerated file of its own, logged, never kept as its original; the 0.1.0 file is left alone', async () => {
    legacy = await legacyDataDir(failRender);
    const app = legacy.open();
    const inv = legacy.invoice;
    const old = legacy.files.get(inv.id);
    expect(old && readFileSync(old.path).equals(old.bytes)).toBe(true);

    const r = await app.pdf(inv.number as string);
    expect(r.kind).toBe('regenerated');
    expect(r.sha256).toBeNull();
    expect(basename(r.path)).toBe(`SZ-2026-00002${REGENERATED_PDF_SUFFIX}.pdf`);
    expect(r.note).toBe(
      'Ez a bizonylat az eredeti PDF megőrzése előtt készült, ezért a program a jelenlegi változattal újra előállította: nem bájtra azonos a vevőnek átadott PDF-fel. ' +
        'A korábban kiírt SZ-2026-00002.pdf fájlt a program nem módosítja.',
    );
    // Rendered by the running version, not the 0.1.0 one.
    const now = await renderInvoicePdf(app.getInvoice(inv.id), { softwareName: `${app.config.software.softwareName} ${VERSION}` });
    expect(readFileSync(r.path).equals(now)).toBe(true);
    expect(now.equals(old?.bytes as Buffer)).toBe(false);
    expect(readFileSync(old?.path as string).equals(old?.bytes as Buffer)).toBe(true);
    // Never its original, not even through the store.
    expect(app.store.getDocument(inv.id)).toBeNull();
    expect(() => app.store.insertDocument({ invoiceId: inv.id, content: now, software: LEGACY_SOFTWARE })).toThrow(expect.objectContaining({ code: 'IMMUTABLE_DOCUMENT' }));

    const logged = () => app.auditLog({ entityId: inv.id }).items.filter((e) => e.action === 'invoice.pdf_regenerated');
    expect(logged()).toHaveLength(1);
    expect(logged()[0]?.details).toMatchObject({ number: 'SZ-2026-00002', file: basename(r.path), size: now.length, software: `${app.config.software.softwareName} ${VERSION}` });
    expect(logged()[0]?.details.sha256).toMatch(/^[0-9A-F]{64}$/);
    // Asked again: the same file, nothing new to log.
    const again = await app.pdf(inv.id, { base64: true });
    expect(again).toMatchObject({ kind: 'regenerated', path: r.path });
    expect(Buffer.from(again.base64 as string, 'base64').equals(now)).toBe(true);
    expect(logged()).toHaveLength(1);
    expect(app.auditLog({ entityId: inv.id }).items.some((e) => e.action === 'invoice.document')).toBe(false);

    // A MÁSOLAT is rendered as before; the cancelled invoice and its storno are regenerated too.
    expect((await app.pdf(inv.id, { copy: true })).kind).toBe('copy');
    for (const doc of [legacy.cancelled, legacy.storno]) {
      const x = await app.pdf(doc.id);
      expect(x.kind, doc.number as string).toBe('regenerated');
      expect(existsSync(x.path)).toBe(true);
      expect(app.store.getDocument(doc.id)).toBeNull();
    }
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, legacyDocuments: 3, documentsChecked: 0, documentMismatches: [], documentWarnings: [] });
  });

  it('without a file from 0.1.0 the note does not name one', async () => {
    legacy = await legacyDataDir(failRender);
    rmSync(legacy.files.get(legacy.invoice.id)?.path as string);
    const r = await legacy.open().pdf(legacy.invoice.id);
    expect(r.kind).toBe('regenerated');
    expect(r.note).not.toMatch(/korábban kiírt/);
    expect(existsSync(legacy.files.get(legacy.invoice.id)?.path as string)).toBe(false);
  });
});
