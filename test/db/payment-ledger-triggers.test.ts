/**
 * EX8, schema 4: the payment ledger (payments, payment_allocations) is append-only like the issued invoices. The SQLite
 * triggers on their own refuse every UPDATE and DELETE, a row for a draft, and "INSERT OR REPLACE" over a recorded row; the
 * store maps the refusal to IMMUTABLE_PAYMENT, and the integrity check names a trigger that was dropped.
 */
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
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-ledger-'));
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

function refusal(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): string | null {
  try {
    db.prepare(sql).run(...params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function payment(store: Store, invoiceId: string): number {
  const entry = store.audit({ actor: 'mcp', action: 'invoice.payment', entityType: 'invoice', entityId: invoiceId, details: { amount: '1000', date: '2026-11-14' } });
  return store.insertPayment({ invoiceId, date: '2026-11-14', amount: '1000', source: 'manual', reference: null, auditId: entry.id }).id;
}

describe('the payment ledger is append-only (EX8)', () => {
  it('the store records payments and allocations of issued documents only', () => {
    const store = openStore();
    issued(store, 'inv_00000000a1', 'SZ-2026-00001');
    draft(store, 'inv_00000000d1');
    const id = payment(store, 'inv_00000000a1');
    store.insertAllocations([{ paymentId: id, invoiceId: 'inv_00000000a1', amount: '1000' }]);
    expect(store.listPayments(['inv_00000000a1'])).toMatchObject([{ id, invoiceId: 'inv_00000000a1', date: '2026-11-14', amount: '1000', source: 'manual', reference: null, createdAt: T0 }]);
    expect(store.listAllocations(['inv_00000000a1'])).toMatchObject([{ paymentId: id, invoiceId: 'inv_00000000a1', amount: '1000' }]);
    const entry = store.audit({ actor: 'mcp', action: 'invoice.payment', entityType: 'invoice', entityId: 'inv_00000000d1', details: {} });
    let code: string | undefined;
    try {
      store.insertPayment({ invoiceId: 'inv_00000000d1', date: '2026-11-14', amount: '1000', source: 'manual', reference: null, auditId: entry.id });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('IMMUTABLE_PAYMENT');
    expect(() => store.insertAllocations([{ paymentId: id, invoiceId: 'inv_00000000d1', amount: '1' }])).toThrow(/kiállított bizonylatra/);
  });

  it('the triggers refuse every change and removal, and a replace over a recorded row', () => {
    const store = openStore();
    issued(store, 'inv_00000000a1', 'SZ-2026-00001');
    const id = payment(store, 'inv_00000000a1');
    store.insertAllocations([{ paymentId: id, invoiceId: 'inv_00000000a1', amount: '1000' }]);
    const db = store.unsafeRawDatabaseForTests();
    const audit = Number(db.prepare('SELECT audit_id FROM payments WHERE id = ?').get(id)?.audit_id);
    expect(refusal(db, `UPDATE payments SET amount = '2000' WHERE id = ?`, id)).toContain('IMMUTABLE_PAYMENT: a rögzített befizetés nem módosítható');
    expect(refusal(db, 'DELETE FROM payments WHERE id = ?', id)).toContain('IMMUTABLE_PAYMENT: a rögzített befizetés nem törölhető');
    expect(refusal(db, `INSERT OR REPLACE INTO payments (id, invoice_id, payment_date, amount, source, reference, audit_id, created_at) VALUES (?, 'inv_00000000a1', '2026-11-14', '1', 'manual', NULL, ?, '${T0}')`, id, audit)).toContain('IMMUTABLE_PAYMENT');
    expect(refusal(db, `UPDATE payment_allocations SET amount = '0'`)).toContain('IMMUTABLE_PAYMENT: a befizetés rögzített felosztása nem módosítható');
    expect(refusal(db, 'DELETE FROM payment_allocations')).toContain('IMMUTABLE_PAYMENT: a befizetés rögzített felosztása nem törölhető');
    const allocation = Number(db.prepare('SELECT id FROM payment_allocations').get()?.id);
    expect(refusal(db, `INSERT OR REPLACE INTO payment_allocations (id, payment_id, invoice_id, amount, created_at) VALUES (?, ?, 'inv_00000000a1', '5', '${T0}')`, allocation, id)).toContain('IMMUTABLE_PAYMENT');
    expect(refusal(db, `INSERT INTO payments (invoice_id, payment_date, amount, source, reference, audit_id, created_at) VALUES ('inv_00000000a1', '2026-11-14', '1', 'bank', NULL, ?, '${T0}')`, audit)).toContain('CHECK constraint failed');
    expect(store.listPayments(['inv_00000000a1']).map((p) => p.amount)).toEqual(['1000']);
    expect(mapDbError(new Error('IMMUTABLE_PAYMENT: a rögzített befizetés nem törölhető'))).toMatchObject({ code: 'IMMUTABLE_PAYMENT', message: 'A rögzített befizetés nem törölhető.' });
  });

  it('a dropped ledger trigger is named by the integrity check', () => {
    const store = openStore();
    expect(store.findAlteredTriggers()).toEqual([]);
    store.unsafeRawDatabaseForTests().exec('DROP TRIGGER payments_delete_guard; DROP TRIGGER payment_allocations_update_guard;');
    expect(store.findAlteredTriggers().sort()).toEqual(['payment_allocations_update_guard', 'payments_delete_guard']);
  });
});
