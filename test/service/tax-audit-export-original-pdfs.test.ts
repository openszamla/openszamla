/**
 * P1-1: the tax-audit export (adóhatósági ellenőrzési adatszolgáltatás) puts the kept originals into pdf/, byte for
 * byte – not a render of the running program. A document issued before originals were kept gets a regenerated PDF
 * named as such (<name>_UJRAELOALLITOTT.pdf), named in the warnings and in OLVASSEL.txt, and logged with the export.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DEFAULT_SOFTWARE, loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { legacyDataDir, type LegacyData } from '../helpers/legacy-data.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function open(dir: string, softwareName = DEFAULT_SOFTWARE.softwareName): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none', software: { ...DEFAULT_SOFTWARE, softwareName } } });
  const app = OpenSzamla.open({ config, now: () => new Date('2026-11-14T09:00:00.000Z') });
  cleanups.push(() => app.close());
  return app;
}

describe('the tax-audit export holds the original PDFs (P1-1)', () => {
  it('after the program changed, pdf/ holds the kept originals, not new renders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openszamla-taxaudit-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const app = open(dir);
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const ids: string[] = [];
    for (const unitPrice of ['10000', '20000']) {
      const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
      ids.push((await app.issue(d.invoice.id)).invoice.id);
    }
    app.close();
    cleanups.pop();

    const later = open(dir, 'OpenSzámla Későbbi Változat');
    const exp = await later.taxAuditExport({ from: '2026-11-01', to: '2026-11-30' });
    expect(readdirSync(join(exp.path, 'pdf')).sort()).toEqual(['SZ-2026-00001.pdf', 'SZ-2026-00002.pdf']);
    for (const id of ids) {
      const inv = later.getInvoice(id);
      const file = readFileSync(join(exp.path, 'pdf', `${inv.number}.pdf`));
      expect(file.equals(later.store.getDocument(id)?.content as Buffer), inv.number as string).toBe(true);
      expect(file.equals(await renderInvoicePdf(inv, { softwareName: `OpenSzámla Későbbi Változat ${later.status().version}` }))).toBe(false);
    }
    expect(exp.warnings).toEqual([]);
    const readme = readFileSync(join(exp.path, 'OLVASSEL.txt'), 'utf8');
    expect(readme).toContain('pdf/          – a számlák PDF-je: a kiállításkor készült, bájtra pontosan megőrzött eredeti');
    expect(readme).not.toContain('UJRAELOALLITOTT');
  });

  it('a document issued before originals were kept: a regenerated PDF, named, listed and logged', async () => {
    const legacy: LegacyData = await legacyDataDir(() => {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
    });
    cleanups.push(() => legacy.cleanup());
    const app = legacy.open();
    // The draft of 0.1.0, issued now, has its original.
    const issued = await app.issue(legacy.draft.id);
    const exp = await app.taxAuditExport({ from: '2026-11-01', to: '2026-11-30' });
    expect(exp.count).toBe(4);
    expect(readdirSync(join(exp.path, 'pdf')).sort()).toEqual([
      'SZ-2026-00001_UJRAELOALLITOTT.pdf',
      'SZ-2026-00002_UJRAELOALLITOTT.pdf',
      'SZ-2026-00003_UJRAELOALLITOTT.pdf',
      'SZ-2026-00004.pdf',
    ]);
    expect(readFileSync(join(exp.path, 'pdf', 'SZ-2026-00004.pdf')).equals(app.store.getDocument(issued.invoice.id)?.content as Buffer)).toBe(true);
    const message = (n: string): string =>
      `Az eredeti PDF nincs megőrizve, mert a bizonylat az eredeti PDF-ek megőrzése előtt készült: a pdf/${n}_UJRAELOALLITOTT.pdf a program jelenlegi változatával újra előállított kép, nem bájtra azonos a vevőnek átadott PDF-fel.`;
    expect(exp.warnings).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003'].map((n) => ({ invoiceNumber: n, field: 'pdf', message: message(n) })));
    const readme = readFileSync(join(exp.path, 'OLVASSEL.txt'), 'utf8');
    expect(readme).toContain('(_UJRAELOALLITOTT.pdf végű fájl: az eredeti PDF-ek megőrzése előtt kiállított bizonylat újra előállított képe, lásd a megjegyzéseket)');
    expect(readme).toContain(`  SZ-2026-00002 (pdf): ${message('SZ-2026-00002')}`);
    // Never kept as originals; the export is logged with them.
    for (const doc of [legacy.cancelled, legacy.invoice, legacy.storno]) expect(app.store.getDocument(doc.id)).toBeNull();
    const logged = app.auditLog({ limit: 5 }).items.find((e) => e.action === 'export.tax_audit');
    expect(logged?.details.regeneratedPdf).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003']);
  });
});
