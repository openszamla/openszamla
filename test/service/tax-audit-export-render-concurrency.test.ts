/**
 * EX5: the tax-audit export copies the kept originals and renders only the PDFs it has to – the regenerated PDFs of
 * documents issued before originals were kept, and an original not kept yet (its PDF failed at issue) – a few at a
 * time (at most 4) while it goes on with the next documents. The warnings, OLVASSEL.txt and the audit entry still list
 * the documents in their order, and the progress reaches every document.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { legacyDataDir, LEGACY_LINES, type LegacyData } from '../helpers/legacy-data.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.mocked(renderInvoicePdf).mockReset();
});

describe('the tax-audit export renders the PDFs it has to a few at a time (EX5)', () => {
  it('overlapping renders, at most 4; warnings, OLVASSEL.txt and the log in document order; progress to the end', async () => {
    const real = await vi.importActual<typeof import('../../src/pdf/render.ts')>('../../src/pdf/render.ts');
    vi.mocked(renderInvoicePdf).mockImplementation(real.renderInvoicePdf);
    const legacy: LegacyData = await legacyDataDir(() => {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
    });
    cleanups.push(() => legacy.cleanup());
    const app = legacy.open();
    // Four documents of this version whose PDF failed at issue: the export renders and keeps their originals.
    const customerId = legacy.invoice.customerId as string;
    const notKept: Invoice[] = [];
    for (let i = 0; i < 4; i++) {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('ideiglenes hiba'));
      const r = await app.issue((await app.createDraft({ customerId, lines: LEGACY_LINES })).invoice.id);
      expect(r.pdfError).not.toBeNull();
      notKept.push(r.invoice);
    }

    let inFlight = 0;
    let most = 0;
    vi.mocked(renderInvoicePdf).mockImplementation(async (inv, opts) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await real.renderInvoicePdf(inv, opts);
      } finally {
        inFlight--;
      }
    });
    const progress: Array<[number, number]> = [];
    const exp = await app.taxAuditExport({ from: '2026-11-01', to: '2026-11-30' }, undefined, { onProgress: (done, total) => void progress.push([done, total]) });

    expect(exp.count).toBe(7);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    const regenerated = ['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003'];
    expect(exp.warnings.map((w) => `${w.invoiceNumber} ${w.field}`)).toEqual(regenerated.map((n) => `${n} pdf`));
    const readme = readFileSync(join(exp.path, 'OLVASSEL.txt'), 'utf8');
    expect(readme.indexOf('  SZ-2026-00001 (pdf)')).toBeLessThan(readme.indexOf('  SZ-2026-00002 (pdf)'));
    expect(readme.indexOf('  SZ-2026-00002 (pdf)')).toBeLessThan(readme.indexOf('  SZ-2026-00003 (pdf)'));
    expect(app.auditLog({ limit: 5 }).items.find((e) => e.action === 'export.tax_audit')?.details.regeneratedPdf).toEqual(regenerated);
    // The originals rendered now are kept, and the export holds exactly those bytes.
    for (const inv of notKept) {
      const kept = app.store.getDocument(inv.id);
      expect(kept, inv.number as string).not.toBeNull();
      expect(readFileSync(join(exp.path, 'pdf', `${inv.number}.pdf`)).equals(kept?.content as Buffer)).toBe(true);
    }
    expect(progress[0]).toEqual([0, 7]);
    expect(progress.at(-1)).toEqual([7, 7]);
    expect(progress.map(([done]) => done)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
