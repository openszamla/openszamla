/**
 * P1-1, schema 3: the kept original PDF of an issued document (invoice_documents) is append-only like the issued
 * invoice. The SQLite triggers on their own refuse every UPDATE and DELETE, an original for a draft or for a document
 * issued before originals were kept (invoice_documents_legacy, itself unchangeable), a second original for the same
 * document, and "INSERT OR REPLACE" over a kept one; the store maps the refusal to IMMUTABLE_DOCUMENT.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { mapDbError, Store } from '../../src/db/store.ts';
import { invoiceContentHash } from '../../src/service/app.ts';
import { INVOICE_DOMESTIC } from '../fixtures/invoices.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const T0 = '2026-11-14T09:00:00.000Z';

function openStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-docs-'));
  const store = new Store({ path: join(dir, 'company.db'), now: () => new Date(T0) });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.insertSeries({ id: 'ser_1', kind: 'invoice', name: 'Számlák', pattern: 'SZ-{YYYY}-{SEQ:5}', yearlyReset: true, nextSeq: 1, seqYear: null, isDefault: true, archived: false, createdAt: T0 });
  return store;
}

function draft(store: Store, id: string): Invoice {
  const d: Invoice = { ...INVOICE_DOMESTIC, id, seriesId: 'ser_1', customerId: null, status: 'draft', number: null, issuedAt: null, contentHash: null, navStatus: 'not_applicable', navMessages: [], navTransactionId: null, cancelledById: null };
  store.insertDraft(d);
  return d;
}

function issued(store: Store, id: string, number: string): Invoice {
  const inv: Invoice = { ...draft(store, id), status: 'issued', number, issuedAt: T0 };
  store.markIssued({ ...inv, contentHash: invoiceContentHash(inv) });
  return inv;
}

const PDF = Buffer.from('%PDF-1.3 eredeti példány\n%%EOF\n', 'latin1');
const hex = (alg: string, b: Uint8Array): string => createHash(alg).update(b).digest('hex').toUpperCase();

/** The trigger error of `sql`, or null when it ran. */
function refusal(db: DatabaseSync, sql: string, ...params: Array<string | number | Uint8Array | null>): string | null {
  try {
    db.prepare(sql).run(...params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const INSERT = `INSERT INTO invoice_documents (invoice_id, kind, sha256, sha3_512, size, content, software, created_at) VALUES (?, 'original', ?, ?, ?, ?, 'x', '${T0}')`;

describe('invoice_documents keeps the original PDF unchangeable (P1-1)', () => {
  it('the store keeps it once, with its fingerprints, for an issued document only', () => {
    const store = openStore();
    issued(store, 'inv_00000000a1', 'SZ-2026-00001');
    const d = draft(store, 'inv_00000000d1');
    const kept = store.insertDocument({ invoiceId: 'inv_00000000a1', content: PDF, software: 'OpenSzámla 0.1.0' });
    expect(kept).toMatchObject({ invoiceId: 'inv_00000000a1', kind: 'original', sha256: hex('sha256', PDF), sha3_512: hex('sha3-512', PDF), size: PDF.length, software: 'OpenSzámla 0.1.0', createdAt: T0 });
    expect(kept.sha256).toMatch(/^[0-9A-F]{64}$/);
    expect(kept.sha3_512).toMatch(/^[0-9A-F]{128}$/);
    expect(store.getDocument('inv_00000000a1')?.content.equals(PDF)).toBe(true);
    expect(store.getDocument(d.id)).toBeNull();
    // A second original, or one for a draft, is refused.
    expect(() => store.insertDocument({ invoiceId: 'inv_00000000a1', content: Buffer.from('%PDF-más'), software: 'OpenSzámla 0.2.0' })).toThrow(expect.objectContaining({ code: 'IMMUTABLE_DOCUMENT' }));
    expect(() => store.insertDocument({ invoiceId: d.id, content: PDF, software: 'OpenSzámla 0.1.0' })).toThrow(expect.objectContaining({ code: 'IMMUTABLE_DOCUMENT' }));
    expect(store.getDocument('inv_00000000a1')?.content.equals(PDF)).toBe(true);
    // The draft stays deletable.
    store.deleteDraft(d.id);
  });

  it('the triggers refuse UPDATE, DELETE, a draft, a second original and INSERT OR REPLACE on their own', () => {
    const store = openStore();
    issued(store, 'inv_00000000a1', 'SZ-2026-00001');
    draft(store, 'inv_00000000d1');
    const kept = store.insertDocument({ invoiceId: 'inv_00000000a1', content: PDF, software: 'OpenSzámla 0.1.0' });
    const db = store.unsafeRawDatabaseForTests();
    const tampered = Buffer.from(PDF);
    tampered[10] = 0x41;
    expect(refusal(db, 'UPDATE invoice_documents SET content = ? WHERE id = ?', tampered, kept.id)).toMatch(/^IMMUTABLE_DOCUMENT: a megőrzött eredeti PDF nem módosítható/);
    expect(refusal(db, `UPDATE invoice_documents SET software = 'OpenSzámla 9.9.9'`)).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(refusal(db, 'UPDATE OR REPLACE invoice_documents SET id = id + 1')).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(refusal(db, 'DELETE FROM invoice_documents')).toMatch(/^IMMUTABLE_DOCUMENT: a megőrzött eredeti PDF nem törölhető/);
    const f = [hex('sha256', tampered), hex('sha3-512', tampered), tampered.length, tampered] as const;
    expect(refusal(db, INSERT, 'inv_00000000d1', ...f)).toMatch(/^IMMUTABLE_DOCUMENT: eredeti PDF csak kiállított bizonylathoz/);
    expect(refusal(db, INSERT, 'inv_00000000a1', ...f)).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(refusal(db, INSERT, 'inv_nincsilyen', ...f)).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(refusal(db, `INSERT OR REPLACE INTO invoice_documents (id, invoice_id, kind, sha256, sha3_512, size, content, software, created_at) VALUES (?, 'inv_00000000a1', 'original', ?, ?, ?, ?, 'x', '${T0}')`, kept.id, ...f)).toMatch(/^IMMUTABLE_DOCUMENT/);
    // The fingerprint columns hold uppercase hex, and the size is the size of the content.
    db.exec('DROP TRIGGER invoice_documents_insert_guard');
    expect(refusal(db, INSERT, 'inv_00000000d1', hex('sha256', PDF).toLowerCase(), hex('sha3-512', PDF), PDF.length, PDF)).toMatch(/CHECK constraint failed/);
    expect(refusal(db, INSERT, 'inv_00000000d1', hex('sha256', PDF), hex('sha3-512', PDF), PDF.length + 1, PDF)).toMatch(/CHECK constraint failed/);
    expect(store.findAlteredTriggers()).toEqual(['invoice_documents_insert_guard']);
    expect(store.getDocument('inv_00000000a1')?.content.equals(PDF)).toBe(true);
    expect(mapDbError(new Error('IMMUTABLE_DOCUMENT: a megőrzött eredeti PDF nem törölhető'))).toMatchObject({ code: 'IMMUTABLE_DOCUMENT', message: 'A megőrzött eredeti PDF nem törölhető.' });
  });

  it('the list of documents issued before originals were kept cannot be changed', () => {
    const store = openStore();
    issued(store, 'inv_00000000a1', 'SZ-2026-00001');
    const db = store.unsafeRawDatabaseForTests();
    expect(store.isLegacyDocument('inv_00000000a1')).toBe(false);
    expect(refusal(db, 'INSERT INTO invoice_documents_legacy (invoice_id) VALUES (?)', 'inv_00000000a1')).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(store.countLegacyDocuments()).toBe(0);
    // Put there with the guard dropped: it never gets an original (the insert trigger refuses it).
    db.exec('DROP TRIGGER invoice_documents_legacy_insert_guard');
    db.prepare('INSERT INTO invoice_documents_legacy (invoice_id) VALUES (?)').run('inv_00000000a1');
    expect(store.isLegacyDocument('inv_00000000a1')).toBe(true);
    expect(() => store.insertDocument({ invoiceId: 'inv_00000000a1', content: PDF, software: 'OpenSzámla 0.1.0' })).toThrow(
      expect.objectContaining({ code: 'IMMUTABLE_DOCUMENT', message: 'A(z) inv_00000000a1 bizonylat az eredeti PDF-ek megőrzése előtt készült: eredeti PDF utólag nem menthető hozzá.' }),
    );
    expect(refusal(db, INSERT, 'inv_00000000a1', hex('sha256', PDF), hex('sha3-512', PDF), PDF.length, PDF)).toMatch(/^IMMUTABLE_DOCUMENT: eredeti PDF csak kiállított bizonylathoz/);
    expect(refusal(db, `UPDATE invoice_documents_legacy SET invoice_id = 'inv_x'`)).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(refusal(db, 'DELETE FROM invoice_documents_legacy')).toMatch(/^IMMUTABLE_DOCUMENT/);
    expect(store.findAlteredTriggers()).toEqual(['invoice_documents_legacy_insert_guard']);
  });
});
