/**
 * P1-1, migration 3 on a database of schema 2 (exactly what the V1 + V2 SQL builds, with the data 0.1.0 left in it):
 * it adds invoice_documents and records which documents were already issued (invoice_documents_legacy) – the issued,
 * the cancelled and the storno, not the draft of that time. Those never get an original: their PDF is regenerated on
 * request into a file of its own; the draft, issued after the migration, gets its original like any other document.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { legacyDataDir, type LegacyData } from '../helpers/legacy-data.ts';

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

type SchemaRow = { type: unknown; name: unknown; tbl_name: unknown; sql: unknown };

function schemaOf(db: DatabaseSync): SchemaRow[] {
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY type, name`).all() as SchemaRow[];
}

describe('migration 3 keeps the documents of an existing database apart (P1-1)', () => {
  it('a schema-2 database: the documents issued by then are listed as legacy, the draft is not', async () => {
    legacy = await legacyDataDir(failRender);
    // The folder holds exactly the schema the V1 and V2 SQL build.
    const v2 = new DatabaseSync(':memory:');
    v2.exec(MIGRATIONS[0]?.sql ?? '');
    v2.exec(MIGRATIONS[1]?.sql ?? '');
    const raw = new DatabaseSync(legacy.config.dbPath);
    expect(schemaOf(raw)).toEqual(schemaOf(v2));
    expect(raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value).toBe('2');
    raw.close();
    v2.close();

    const app = legacy.open();
    const db = app.store.unsafeRawDatabaseForTests();
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value).toBe(String(LATEST_SCHEMA_VERSION));
    expect(app.store.findAlteredTriggers()).toEqual([]);
    expect(db.prepare('SELECT invoice_id FROM invoice_documents_legacy ORDER BY invoice_id').all().map((r) => r.invoice_id)).toEqual(
      [legacy.cancelled.id, legacy.invoice.id, legacy.storno.id].sort(),
    );
    expect(app.getInvoice(legacy.cancelled.id).status).toBe('cancelled');
    expect([legacy.cancelled, legacy.invoice, legacy.storno, legacy.draft].map((i) => app.store.isLegacyDocument(i.id))).toEqual([true, true, true, false]);
    expect(app.store.countLegacyDocuments()).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_documents').get()?.n).toBe(0);

    // verify: the legacy documents are counted, neither a failure nor a warning; the chain and the rest are intact.
    const r = app.verifyIntegrity();
    expect(r).toMatchObject({ ok: true, legacyDocuments: 3, documentsChecked: 0, documentMismatches: [], documentWarnings: [], documentNotes: [] });

    // The draft of that time, issued now, gets its original.
    const issued = await app.issue(legacy.draft.id);
    expect(issued.pdfError).toBeNull();
    expect(app.store.isLegacyDocument(legacy.draft.id)).toBe(false);
    const kept = app.store.getDocument(legacy.draft.id);
    expect(kept?.content.equals(readFileSync(issued.pdfPath as string))).toBe(true);
    expect((await app.pdf(legacy.draft.id)).kind).toBe('original');
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, legacyDocuments: 3, documentsChecked: 1, documentMismatches: [], documentWarnings: [] });
  });
});
