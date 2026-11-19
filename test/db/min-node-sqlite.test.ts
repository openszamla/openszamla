/**
 * The declared minimum runtime (Node.js 22.13.0) has node:sqlite without the DatabaseSync#isOpen
 * (22.15.0) and #isTransaction (22.16.0) getters. The store must not depend on them: this file runs the
 * store and the service against a node:sqlite whose DatabaseSync hides both getters.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/db/store.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>();
  const hidden = new Set<PropertyKey>(['isOpen', 'isTransaction']);
  /** DatabaseSync as on Node 22.13/22.14 (and, for isTransaction, 22.15). */
  class DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      const db = new real.DatabaseSync(...args);
      return new Proxy(db, {
        get(target, key) {
          if (hidden.has(key)) return undefined;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
        has(target, key) {
          return hidden.has(key) ? false : Reflect.has(target, key);
        },
      });
    }
  }
  return { ...real, DatabaseSync, default: { ...real, DatabaseSync } };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-min-node-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fails when the connection still has a transaction open (every later BEGIN would fail). */
function expectNoOpenTransaction(store: Store): void {
  const raw = store.unsafeRawDatabaseForTests();
  expect(() => {
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('ROLLBACK');
  }).not.toThrow();
}

describe('store without DatabaseSync#isOpen / #isTransaction (Node.js 22.13–22.15)', () => {
  it('runs reads, transactions, savepoints, backup and close', () => {
    const dir = tempDir();
    const store = new Store({ path: join(dir, 'company.db') });
    cleanups.push(() => store.close()); // LIFO: closed before the directory is removed
    const raw = store.unsafeRawDatabaseForTests() as unknown as Record<string, unknown>;
    expect(raw['isTransaction']).toBeUndefined(); // the stand-in is active
    expect(raw['isOpen']).toBeUndefined();

    store.setSetting('a', 1);
    expect(store.findInvoices({ limit: 10, offset: 0 }).total).toBe(0); // read snapshot (count + page)
    expectNoOpenTransaction(store);
    expect(store.verifyAuditChain().ok).toBe(true);
    expectNoOpenTransaction(store);

    store.tx(() => {
      store.setSetting('kept', true);
      expect(() =>
        store.tx(() => {
          store.setSetting('undone', true);
          throw new Error('inner fails');
        }),
      ).toThrow('inner fails');
    });
    expect(store.getSetting('kept')).toBe(true);
    expect(store.getSetting('undone')).toBeNull();
    expect(() =>
      store.tx(() => {
        store.setSetting('lost', 1);
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(store.getSetting('lost')).toBeNull();
    expectNoOpenTransaction(store);

    store.backup(join(dir, 'backup.db'));
    expect(existsSync(join(dir, 'backup.db'))).toBe(true);
    expect(() => store.tx(() => store.backup(join(dir, 'inside.db')))).toThrow(expect.objectContaining({ code: 'TX_NOT_ALLOWED' }));

    store.close();
    store.close();
    rmSync(dir, { recursive: true }); // the connection is really closed (Windows refuses to delete an open file)
    expect(existsSync(dir)).toBe(false);
  });

  it('close() inside a tx() callback still ends in STORE_CLOSED', () => {
    const store = new Store({ path: ':memory:' });
    expect(() => store.tx(() => store.close())).toThrow(expect.objectContaining({ code: 'STORE_CLOSED' }));
    const nested = new Store({ path: ':memory:' });
    expect(() => nested.tx(() => nested.tx(() => nested.close()))).toThrow(expect.objectContaining({ code: 'STORE_CLOSED' }));
  });
});

describe('service without DatabaseSync#isOpen / #isTransaction', () => {
  let t: TestApp | undefined;
  afterEach(() => {
    t?.cleanup();
    t = undefined;
  });

  it('sets up, reads, issues, and finds the invoice again after reopening', async () => {
    t = makeTestApp();
    const { app, dir } = t;
    app.updateSeller(SELLER_INPUT);
    expect(app.status().seller?.name).toBe(SELLER_INPUT.name);
    expect(app.findInvoices({}).total).toBe(0);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const draft = await app.createDraft({
      customerId,
      lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }],
    });
    const issued = await app.issue(draft.invoice.id, { submitToNav: false });
    expect(issued.invoice.status).toBe('issued');
    expect(app.status().counts.issued).toBe(1);
    app.close();

    const again = OpenSzamla.open({ dataDir: dir, env: {}, overrides: { nav: null } });
    try {
      expect(again.findInvoices({}).total).toBe(1);
      expect(again.verifyIntegrity().audit.ok).toBe(true);
    } finally {
      again.close();
    }
  });
});
