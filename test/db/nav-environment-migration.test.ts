/**
 * NAV-5, schema migration 2: invoices.nav_environment – the NAV environment the NAV state of an invoice belongs to.
 * A database of version 1 gets it from the submissions: the one with the invoice's transaction id, else the latest;
 * none without a submission. The column is mutable after issuance like the other NAV columns, and the
 * immutability and audit triggers stay as they are.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/db/schema.ts';
import { Store, type InvoiceMutablePatch } from '../../src/db/store.ts';
import { invoiceContentHash } from '../../src/service/app.ts';
import { INVOICE_DOMESTIC } from '../fixtures/invoices.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-mig-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'company.db');
}

function open(path: string): Store {
  const store = new Store({ path });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

function issued(store: Store, id: string, number: string, nav: InvoiceMutablePatch): void {
  const seriesId = store.listSeries('invoice')[0]?.id as string;
  const draft: Invoice = { ...INVOICE_DOMESTIC, id, seriesId, status: 'draft', number: null, issuedAt: null, contentHash: null, navStatus: 'not_applicable', navMessages: [], navTransactionId: null };
  store.insertDraft(draft);
  const inv: Invoice = { ...draft, status: 'issued', number, issuedAt: '2026-10-27T10:00:00.000Z', navStatus: 'pending' };
  store.markIssued({ ...inv, contentHash: invoiceContentHash(inv) });
  store.patchInvoice(id, nav);
}

function submission(store: Store, invoiceId: string, environment: 'test' | 'production', status: 'done' | 'processing' | 'sent', transactionId: string | null): void {
  store.insertNavSubmission({ invoiceId, operation: 'CREATE', environment, requestId: '', transactionId, status, invoiceDataBase64: 'QQ==', messages: [], lastResponseXml: null });
}

describe('NAV-5: migration 2 records the NAV environment of every invoice', () => {
  it('a version-1 database gets the environment of the submission behind the NAV state', () => {
    const path = tempDb();
    const store = open(path);
    store.insertSeries({ id: 'ser_1', kind: 'invoice', name: 'Számlák', pattern: 'SZ-{YYYY}-{SEQ:5}', yearlyReset: true, nextSeq: 1, seqYear: null, isDefault: true, archived: false, createdAt: '2026-10-27T08:00:00.000Z' });
    // A: reported in production; B: test only (an older production attempt too); C: processing at the test system;
    // D: not reported yet (no submission).
    issued(store, 'inv_000000000a', 'SZ-2026-00001', { navStatus: 'done', navTransactionId: 'TXPROD000000000A' });
    submission(store, 'inv_000000000a', 'production', 'done', 'TXPROD000000000A');
    issued(store, 'inv_000000000b', 'SZ-2026-00002', { navStatus: 'done', navTransactionId: 'TXTEST000000000B' });
    submission(store, 'inv_000000000b', 'test', 'done', 'TXTEST000000000B');
    submission(store, 'inv_000000000b', 'production', 'sent', null);
    issued(store, 'inv_000000000c', 'SZ-2026-00003', { navStatus: 'processing', navTransactionId: 'TXTEST000000000C' });
    submission(store, 'inv_000000000c', 'test', 'processing', 'TXTEST000000000C');
    issued(store, 'inv_000000000d', 'SZ-2026-00004', { navStatus: 'not_configured' });
    store.close();

    // As the 0.1.0 program left it: schema version 1, no nav_environment column (and none of the later tables).
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TABLE payment_allocations; DROP TABLE payments; DROP TABLE invoice_documents; DROP TABLE invoice_documents_legacy;`);
    raw.exec(`ALTER TABLE invoices DROP COLUMN nav_environment; UPDATE meta SET value = '1' WHERE key = 'schema_version';`);
    raw.close();

    const migrated = open(path);
    const env = (id: string): string | undefined => migrated.getInvoice(id)?.navEnvironment;
    expect([env('inv_000000000a'), env('inv_000000000b'), env('inv_000000000c'), env('inv_000000000d')]).toEqual(['production', 'test', 'test', undefined]);
    const meta = migrated.unsafeRawDatabaseForTests().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    expect(meta?.['value']).toBe(String(LATEST_SCHEMA_VERSION));
    expect(migrated.findAlteredTriggers()).toEqual([]);
    // Mutable after issuance like the other NAV columns; the content hash does not cover it.
    migrated.patchInvoice('inv_000000000b', { navEnvironment: 'production' });
    const b = migrated.getInvoice('inv_000000000b') as Invoice;
    expect(b.navEnvironment).toBe('production');
    expect(invoiceContentHash(b)).toBe(b.contentHash);
    migrated.patchInvoice('inv_000000000b', { navEnvironment: null });
    expect(migrated.getInvoice('inv_000000000b')?.navEnvironment).toBeUndefined();
  });

  it('only test and production are accepted', () => {
    const store = open(tempDb());
    const raw = store.unsafeRawDatabaseForTests();
    expect(() => raw.prepare(`UPDATE invoices SET nav_environment = 'staging'`).run()).not.toThrow(); // no rows yet
    store.insertSeries({ id: 'ser_1', kind: 'invoice', name: 'Számlák', pattern: 'SZ-{YYYY}-{SEQ:5}', yearlyReset: true, nextSeq: 1, seqYear: null, isDefault: true, archived: false, createdAt: '2026-10-27T08:00:00.000Z' });
    issued(store, 'inv_000000000e', 'SZ-2026-00001', { navStatus: 'pending' });
    expect(() => raw.prepare(`UPDATE invoices SET nav_environment = 'staging'`).run()).toThrow(/CHECK constraint failed/);
  });
});
