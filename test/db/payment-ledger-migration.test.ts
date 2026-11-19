/**
 * EX8, migration 4 on a database of schema 3 made by OpenSzámla before the payment ledger (fixtures/schema3-payments:
 * built with the tree of commit 8e9ed09 – generate.mjs – and dumped as SQL). Opening it adds payments and
 * payment_allocations, and the program takes every logged payment ('invoice.payment') into the ledger, in its order –
 * markPaid and the carried díjbekérő payment with their source – and settles each chain from it once: the paid amounts are
 * the amounts allocated, the payment date the day a document became fully paid (by payment dates). Once per database,
 * safe with another process doing the same, and a payment an older process logs afterwards is taken over too.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/db/schema.ts';
import { Store } from '../../src/db/store.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type AppConfig } from '../../src/service/config.ts';

const DUMP = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'schema3-payments', 'database.sql'), 'utf8');
const NOW = new Date('2026-12-10T09:00:00.000Z');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A data folder holding the schema-3 database of the fixture, not opened by this version yet. */
function schema3(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-ledger-mig-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } });
  const raw = new DatabaseSync(config.dbPath);
  raw.exec(DUMP);
  raw.close();
  return config;
}

function open(config: AppConfig, store?: Store): OpenSzamla {
  const app = store ? new OpenSzamla(store, config, { now: () => NOW }) : OpenSzamla.open({ config, now: () => NOW });
  cleanups.push(() => {
    try {
      app.close();
    } catch {
      // already closed
    }
  });
  return app;
}

const byNumber = (app: OpenSzamla, n: number, kind = 'SZ'): Invoice => app.getInvoice(`${kind}-2026-${String(n).padStart(5, '0')}`);
const state = (inv: Invoice): string => `${inv.paymentStatus} ${inv.paidAmount} ${inv.paidDate}`;
type Row = Record<string, unknown>;
const rows = (app: OpenSzamla, sql: string): Row[] => app.store.unsafeRawDatabaseForTests().prepare(sql).all() as Row[];

describe('migration 4: the payments of a schema-3 database become the payment ledger (EX8)', () => {
  it('the fixture is what the 0.1.0 code stored: schema 3, payments only in the audit log, the last entry as payment date', () => {
    const raw = new DatabaseSync(schema3().dbPath);
    const one = (sql: string): Row => raw.prepare(sql).get() as Row;
    expect(one(`SELECT value FROM meta WHERE key = 'schema_version'`).value).toBe('3');
    expect(one(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('payments', 'payment_allocations')`).n).toBe(0);
    expect(one(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invoice.payment'`).n).toBe(17);
    // SZ-2026-00003: 27 000 dated 12-08 recorded first, then 100 000 dated 11-20 – the stored date is the last entry's.
    expect(one(`SELECT paid_amount, paid_date FROM invoices WHERE number = 'SZ-2026-00003'`)).toEqual({ paid_amount: '127000', paid_date: '2026-11-20' });
    // The modification of SZ-2026-00001 was paid by the payment on the original: paid, with nothing and no date of its own.
    expect(one(`SELECT payment_status, paid_amount, paid_date FROM invoices WHERE number = 'SZ-2026-00002'`)).toEqual({ payment_status: 'paid', paid_amount: '0', paid_date: null });
    raw.close();
  });

  it('takes every logged payment over in its order, with its source, and settles the chains from the ledger', () => {
    const app = open(schema3());
    const db = app.store.unsafeRawDatabaseForTests();
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value).toBe(String(LATEST_SCHEMA_VERSION));
    expect(app.store.findAlteredTriggers()).toEqual([]);

    const entries = app.store.listAuditByAction('invoice.payment');
    const payments = rows(app, 'SELECT * FROM payments ORDER BY id');
    expect(payments.map((p) => p.audit_id)).toEqual(entries.map((e) => e.id));
    expect(payments.map((p) => [p.invoice_id, p.amount, p.payment_date, p.created_at])).toEqual(entries.map((e) => [e.entityId, e.details.amount, e.details.date, e.at]));
    expect(payments.filter((p) => p.source !== 'manual').map((p) => [p.source, p.reference, p.invoice_id])).toEqual([
      ['mark_paid', null, byNumber(app, 6).id],
      ['proforma', 'DB-2026-00001', byNumber(app, 11).id],
    ]);

    // EX8 (a): the modification gets the part of the 12-05 payment that paid it, and that date.
    expect([state(byNumber(app, 1)), state(byNumber(app, 2))]).toEqual(['paid 137000 2026-12-05', 'paid 12700 2026-12-05']);
    // EX8 (b): fully paid on 12-08, the later payment date – not the date of the entry recorded last.
    expect(state(byNumber(app, 3))).toBe('paid 127000 2026-12-08');
    // EX8 (c): the cancelled invoice keeps what it received; its storno has it to refund.
    expect(state(byNumber(app, 14))).toBe('partial 100000 null');
    expect(app.openAmount(byNumber(app, 15))).toBe('-100000');
    // A credit note set off against what was owed: settled without a payment of its own, so without a date.
    expect([state(byNumber(app, 4)), state(byNumber(app, 5))]).toEqual(['paid 152400 2026-11-21', 'paid 0 null']);
    expect(state(byNumber(app, 6))).toBe('paid 12700 2026-11-14'); // markPaid at issue
    expect([state(byNumber(app, 7)), state(byNumber(app, 8))]).toEqual(['paid 38100 2026-11-25', 'paid 0 2026-11-25']); // + a 0 Ft modification marked settled
    expect(state(byNumber(app, 9))).toBe('paid 127000 2026-11-18'); // reversed, overpaid, surplus reversed: paid since 11-18
    expect(state(byNumber(app, 10))).toBe('partial 500 null'); // EUR, in part
    expect([state(byNumber(app, 11)), state(byNumber(app, 12))]).toEqual(['partial 50000 null', 'unpaid 0 null']);
    expect(state(app.getInvoice('DB-2026-00001'))).toBe('partial 50000 null');

    // The allocations add up to the payments, and to each document's paid amount.
    const allocations = rows(app, 'SELECT payment_id, invoice_id, amount FROM payment_allocations ORDER BY id');
    const sum = (xs: Row[], key: string, value: unknown): number => xs.filter((x) => x[key] === value).reduce((s, x) => s + Number(x.amount), 0);
    for (const p of payments) expect(sum(allocations, 'payment_id', p.id), `payment ${String(p.id)}`).toBe(Number(p.amount));
    for (const n of [1, 2, 3, 9, 14]) expect(sum(allocations, 'invoice_id', byNumber(app, n).id)).toBe(Number(byNumber(app, n).paidAmount));
    const lastOfA = payments.find((p) => p.invoice_id === byNumber(app, 1).id && p.payment_date === '2026-12-05');
    expect(allocations.filter((a) => a.payment_id === lastOfA?.id).map((a) => [a.invoice_id, a.amount])).toEqual([
      [byNumber(app, 1).id, '87000'],
      [byNumber(app, 2).id, '12700'],
    ]);

    // Logged once, by the system; the integrity check is clean.
    expect(app.auditLog({ limit: 500 }).items.filter((e) => e.action === 'payment.ledger').map((e) => [e.actor, e.details])).toEqual([['system', { payments: 17, chains: 11 }]]);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, alteredTriggers: [], auditMismatches: [] });
  });

  it('the refund on the migrated storno brings the cancelled chain to zero; the carried payment guard works on the modification (C3)', () => {
    const app = open(schema3());
    const storno = app.recordPayment('SZ-2026-00015', {});
    expect([storno.paymentStatus, storno.paidAmount, storno.paidDate]).toEqual(['paid', '-100000', '2026-12-10']);
    expect(Number(byNumber(app, 14).paidAmount) + Number(storno.paidAmount)).toBe(0);
    expect(() => app.recordPayment('SZ-2026-00012', { amount: '127000' })).toThrow(/^A\(z\) SZ-2026-00011 számlára a\(z\) DB-2026-00001 díjbekérő befizetése \(50\s000\sFt, 2026\.11\.16\.\) a kiállításkor már átkerült/);
    expect(app.recordPayment('SZ-2026-00012', { amount: '12700' }).paymentStatus).toBe('paid');
  });

  it('once per database: a second start takes nothing over again and logs nothing', () => {
    const config = schema3();
    const first = open(config);
    const count = (app: OpenSzamla): unknown[] => [rows(app, 'SELECT COUNT(*) AS n FROM payments')[0]?.n, rows(app, 'SELECT COUNT(*) AS n FROM payment_allocations')[0]?.n, app.auditLog({ limit: 1 }).total];
    const before = count(first);
    first.close();
    const second = open(config);
    expect(count(second)).toEqual(before);
  });

  it('another process finishing the pass meanwhile: nothing is taken over twice', () => {
    const config = schema3();
    // This process migrates the schema and reads the logged payments; the other one runs the whole pass right before
    // this one's first transaction of it.
    const store = new Store({ path: config.dbPath, now: () => NOW });
    const tx = store.tx.bind(store);
    let other = false;
    store.tx = <T>(fn: () => T): T => {
      if (!other) {
        other = true;
        open(config).close();
      }
      return tx(fn);
    };
    const app = open(config, store);
    expect(other).toBe(true);
    expect(rows(app, 'SELECT COUNT(*) AS n FROM payments')[0]?.n).toBe(17);
    expect(rows(app, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.ledger'`)[0]?.n).toBe(1);
    expect(state(byNumber(app, 2))).toBe('paid 12700 2026-12-05');
  });

  it('a payment an older version logs after the migration is taken over by the next payment of its chain', () => {
    const app = open(schema3());
    const b = byNumber(app, 10); // 1270 EUR, 500 paid
    // What 0.1.0 does: the entry and its own columns, no ledger row.
    app.store.tx(() => {
      app.store.patchInvoice(b.id, { paidAmount: '800', paymentStatus: 'partial', paidDate: '2026-12-01' });
      app.store.audit({ actor: 'mcp', action: 'invoice.payment', entityType: 'invoice', entityId: b.id, details: { number: b.number, amount: '300', date: '2026-12-01', paymentStatus: 'partial' } });
    });
    const paid = app.recordPayment(b.id, { date: '2026-12-09' });
    expect(state(paid)).toBe('paid 1270 2026-12-09');
    expect(app.paymentHistory(b.id).map((p) => [p.date, p.amount])).toEqual([
      ['2026-11-22', '500'],
      ['2026-12-01', '300'],
      ['2026-12-09', '470'],
    ]);
  });
});
