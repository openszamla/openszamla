/**
 * C2: the first keep of a document's original never overwrites another pdf/<name>.pdf. After an older backup is
 * restored, the next invoice gets a number already issued after the backup; that invoice's PDF – handed to the buyer,
 * reported to NAV, and no longer in the restored database – is in pdf/<number>.pdf. Issuing (or the first PDF request
 * after a failed render, or the tax-audit export) keeps it as pdf/<number>_KORABBI_<ééééhhnn-óóppmm>.pdf (never over
 * another file), logs it and says so; later requests rewrite only the program's own copy.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const dirs: string[] = [];
const apps: OpenSzamla[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** 2026-11-19 10:00:00 Budapest time: the file name stamp is 20261119-100000. */
const NOW = new Date('2026-11-19T09:00:00.000Z');
const STAMP = '20261119-100000';

function open(dir: string): OpenSzamla {
  const app = OpenSzamla.open({ config: loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } }), now: () => NOW });
  apps.push(app);
  return app;
}

const LINE = (description: string, unitPrice: string) => [{ description, quantity: '1', unit: 'db', unitPrice, vatCode: '27' as const }];

/**
 * SZ-2026-00001 issued and backed up, then SZ-2026-00002 (the "lost" sale) issued, then the backup restored: the
 * restored database does not know SZ-2026-00002, its PDF is still in pdf/.
 */
async function restoredAfterLostSale(): Promise<{ app: OpenSzamla; dir: string; customerId: string; lostPdf: Buffer; lostPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-restore-'));
  dirs.push(dir);
  const backupDir = mkdtempSync(join(tmpdir(), 'openszamla-restore-backup-'));
  dirs.push(backupDir);
  const backup = join(backupDir, 'mentes.db');
  let app = open(dir);
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  await app.issue((await app.createDraft({ customerId, lines: LINE('Tanácsadás', '10000') })).invoice.id);
  app.store.backup(backup);
  const lost = await app.issue((await app.createDraft({ customerId, lines: LINE('Elveszett eladás', '99000') })).invoice.id);
  expect(lost.invoice.number).toBe('SZ-2026-00002');
  const lostPath = lost.pdfPath as string;
  const lostPdf = readFileSync(lostPath);
  apps.pop()?.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `openszamla.db${suffix}`), { force: true });
  copyFileSync(backup, join(dir, 'openszamla.db'));
  app = open(dir);
  return { app, dir, customerId, lostPdf, lostPath };
}

const kept = (app: OpenSzamla, id: string) => app.auditLog({ entityId: id }).items.filter((e) => e.action === 'invoice.pdf_file_kept');

describe('the first keep never overwrites another pdf/<name>.pdf (C2)', () => {
  it('issuing after a restored backup keeps the lost sale’s PDF under a name of its own, logs it and says so', async () => {
    const { app, dir, customerId, lostPdf, lostPath } = await restoredAfterLostSale();
    const again = await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    expect(again.invoice.number).toBe('SZ-2026-00002');
    const aside = join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`);
    expect(readFileSync(aside).equals(lostPdf)).toBe(true);
    // pdf/SZ-2026-00002.pdf is now the new invoice's original.
    expect(again.pdfPath).toBe(lostPath);
    expect(readFileSync(lostPath).equals(app.store.getDocument(again.invoice.id)?.content as Buffer)).toBe(true);
    expect(again.notes).toContain(
      `A pdf/SZ-2026-00002.pdf fájl már létezett, és nem ennek a bizonylatnak a PDF-je (pl. egy régebbi mentés visszaállítása előtt ugyanezzel a sorszámmal kiállított bizonylaté): a program nem írta felül, hanem pdf/SZ-2026-00002_KORABBI_${STAMP}.pdf néven megőrizte. Őrizd meg, és vizsgáld meg a könyvelőddel.`,
    );
    const logged = kept(app, again.invoice.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.details).toMatchObject({ number: 'SZ-2026-00002', file: `SZ-2026-00002_KORABBI_${STAMP}.pdf`, size: lostPdf.length });
    expect(logged[0]?.details.sha256).toMatch(/^[0-9A-F]{64}$/);
    // Later requests are not a first keep: they rewrite only the program's own copy, and nothing more is set aside.
    writeFileSync(lostPath, 'kézzel átírt másolat');
    const r = await app.pdf(again.invoice.id);
    expect(r.previousFile).toBeNull();
    expect(r.note).toBe('A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.');
    expect(readFileSync(lostPath).equals(app.store.getDocument(again.invoice.id)?.content as Buffer)).toBe(true);
    expect(kept(app, again.invoice.id)).toHaveLength(1);
    expect(readFileSync(aside).equals(lostPdf)).toBe(true);
  });

  it('a kept file never overwrites another one: a second name gets _2', async () => {
    const { app, dir, customerId, lostPdf } = await restoredAfterLostSale();
    const taken = join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`);
    writeFileSync(taken, 'egy még korábbi fájl');
    const again = await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    expect(readFileSync(taken, 'utf8')).toBe('egy még korábbi fájl');
    expect(readFileSync(join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}_2.pdf`)).equals(lostPdf)).toBe(true);
    expect(again.notes.join('\n')).toContain(`pdf/SZ-2026-00002_KORABBI_${STAMP}_2.pdf néven megőrizte`);
  });

  it('the PDF failed at issue: the first PDF request keeps the other file and names it (previousFile, note)', async () => {
    const { app, dir, customerId, lostPdf, lostPath } = await restoredAfterLostSale();
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('a PDF most nem készült el'));
    const again = await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    expect(again.pdfPath).toBeNull();
    // Nothing was written over the lost sale's file at issue.
    expect(readFileSync(lostPath).equals(lostPdf)).toBe(true);
    const r = await app.pdf(again.invoice.id);
    const aside = join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`);
    expect(r).toMatchObject({ kind: 'original', previousFile: aside });
    expect(r.note).toBe(
      'A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF. ' +
        `A pdf/SZ-2026-00002.pdf fájl már létezett, és nem ennek a bizonylatnak a PDF-je (pl. egy régebbi mentés visszaállítása előtt ugyanezzel a sorszámmal kiállított bizonylaté): a program nem írta felül, hanem pdf/SZ-2026-00002_KORABBI_${STAMP}.pdf néven megőrizte. Őrizd meg, és vizsgáld meg a könyvelőddel.`,
    );
    expect(readFileSync(aside).equals(lostPdf)).toBe(true);
    expect(kept(app, again.invoice.id)).toHaveLength(1);
  });

  it('MCP: invoice_pdf names the kept file (previousFile) when it keeps the original', async () => {
    const { app, dir, customerId, lostPdf } = await restoredAfterLostSale();
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('a PDF most nem készült el'));
    await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientT);
    try {
      const r = (await client.callTool({ name: 'invoice_pdf', arguments: { invoice: 'SZ-2026-00002' } })) as { structuredContent: Record<string, unknown> };
      const aside = join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`);
      expect(r.structuredContent).toMatchObject({ kind: 'original', previousFile: aside, note: expect.stringContaining(`pdf/SZ-2026-00002_KORABBI_${STAMP}.pdf néven megőrizte`) });
      expect(readFileSync(aside).equals(lostPdf)).toBe(true);
      const again = (await client.callTool({ name: 'invoice_pdf', arguments: { invoice: 'SZ-2026-00002' } })) as { structuredContent: Record<string, unknown> };
      expect(again.structuredContent.previousFile).toBeUndefined();
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('the PDF failed at issue and the tax-audit export keeps the original first: the other file is kept and named in the warnings', async () => {
    const { app, dir, customerId, lostPdf, lostPath } = await restoredAfterLostSale();
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('a PDF most nem készült el'));
    const again = await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    const r = await app.taxAuditExport({ fromNumber: 'SZ-2026-00002', toNumber: 'SZ-2026-00002' });
    const aside = join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`);
    expect(readFileSync(aside).equals(lostPdf)).toBe(true);
    expect(r.warnings).toEqual([expect.objectContaining({ invoiceNumber: 'SZ-2026-00002', field: 'pdf', message: expect.stringContaining(`pdf/SZ-2026-00002_KORABBI_${STAMP}.pdf néven megőrizte`) })]);
    // The next PDF request rewrites pdf/SZ-2026-00002.pdf from the original: the lost sale's PDF is safe in the kept file.
    expect((await app.pdf(again.invoice.id)).previousFile).toBeNull();
    expect(readFileSync(lostPath).equals(app.store.getDocument(again.invoice.id)?.content as Buffer)).toBe(true);
    expect(existsSync(aside)).toBe(true);
  });

  it('nothing is set aside when the file is missing or already holds the original', async () => {
    const { app, dir, customerId, lostPath } = await restoredAfterLostSale();
    rmSync(lostPath);
    const again = await app.issue((await app.createDraft({ customerId, lines: LINE('Új eladás', '5000') })).invoice.id);
    expect(again.notes.join('\n')).not.toContain('KORABBI');
    expect(kept(app, again.invoice.id)).toEqual([]);
    expect(existsSync(join(dir, 'pdf', `SZ-2026-00002_KORABBI_${STAMP}.pdf`))).toBe(false);
  });
});
