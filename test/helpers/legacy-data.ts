/**
 * A data folder as OpenSzámla 0.1.0 left it (schema version 2, before the original PDFs were kept): issued documents
 * whose PDF exists only as the file that version wrote into pdf/, and a draft. Built with this version and taken back
 * to schema 2: `failRender` must make the next PDF render fail (a vi.mock of renderInvoicePdf in the calling test
 * file), so no original is kept while "0.1.0" issues them; then the schema-3 tables are dropped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Invoice } from '../../src/core/types.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type AppConfig } from '../../src/service/config.ts';
import type { DraftInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from './app.ts';

/** 2026-11-14 10:00 Budapest time. */
export const LEGACY_NOW = new Date('2026-11-14T09:00:00.000Z');

/** What 0.1.0 printed in the footer and metadata of those PDFs. */
export const LEGACY_SOFTWARE = 'OpenSzámla 0.1.0 (korábbi változat)';

export const LEGACY_LINES: DraftInput['lines'] = [{ description: 'Tanácsadás', quantity: '2', unit: 'óra', unitPrice: '15000', vatCode: '27' }];

export interface LegacyData {
  dir: string;
  config: AppConfig;
  /** SZ-2026-00001, cancelled by `storno` (SZ-2026-00003). */
  cancelled: Invoice;
  /** SZ-2026-00002. */
  invoice: Invoice;
  storno: Invoice;
  /** A draft of that time: issued later, it gets an original like any other document. */
  draft: Invoice;
  /** pdf/<number>.pdf of each issued document as 0.1.0 wrote it, by invoice id. */
  files: Map<string, { path: string; bytes: Buffer }>;
  /** Opens the folder with this version (the first open migrates it to schema 3). */
  open(): OpenSzamla;
  cleanup(): void;
}

export function legacyConfig(dir: string): AppConfig {
  return loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } });
}

export async function legacyDataDir(failRender: () => void): Promise<LegacyData> {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-legacy-'));
  const config = legacyConfig(dir);
  const app = OpenSzamla.open({ config, now: () => LEGACY_NOW });
  const files = new Map<string, { path: string; bytes: Buffer }>();
  let docs: Pick<LegacyData, 'cancelled' | 'invoice' | 'storno' | 'draft'>;
  try {
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const issue = async (): Promise<Invoice> => {
      const d = await app.createDraft({ customerId, lines: LEGACY_LINES });
      failRender();
      const r = await app.issue(d.invoice.id);
      if (r.pdfError === null) throw new Error('the PDF was kept: failRender did not make the render fail');
      return r.invoice;
    };
    const first = await issue();
    const invoice = await issue();
    failRender();
    const storno = (await app.cancel(first.id, { reason: 'Téves számla' })).invoice;
    const draft = (await app.createDraft({ customerId, lines: LEGACY_LINES })).invoice;
    docs = { cancelled: app.getInvoice(first.id), invoice, storno, draft };
    mkdirSync(config.pdfDir, { recursive: true });
    for (const inv of [docs.cancelled, invoice, storno]) {
      const path = join(config.pdfDir, `${inv.number}.pdf`);
      const bytes = await renderInvoicePdf(inv, { softwareName: LEGACY_SOFTWARE });
      writeFileSync(path, bytes);
      files.set(inv.id, { path, bytes });
    }
  } finally {
    app.close();
  }
  // Back to schema 2: the tables of schemas 3 and 4 did not exist yet.
  const raw = new DatabaseSync(config.dbPath);
  raw.exec(`DROP TABLE payment_allocations; DROP TABLE payments; DROP TABLE invoice_documents; DROP TABLE invoice_documents_legacy; UPDATE meta SET value = '2' WHERE key = 'schema_version';`);
  raw.close();
  const opened: OpenSzamla[] = [];
  return {
    dir,
    config,
    ...docs,
    files,
    open() {
      const a = OpenSzamla.open({ config, now: () => LEGACY_NOW });
      opened.push(a);
      return a;
    },
    cleanup() {
      for (const a of opened) {
        try {
          a.close();
        } catch {
          // already closed
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
