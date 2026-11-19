import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts';
import { AppError } from '../../src/core/errors.ts';
import type { Customer, Product, Series } from '../../src/core/types.ts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/schema.ts';
import { Store, mapDbError } from '../../src/db/store.ts';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  // LIFO: connections are closed before their temp directories are removed.
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Deterministic clock: every call advances one second. */
function clock(start = '2026-10-27T08:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => {
    t += 1000;
    return new Date(t);
  };
}

function openStore(path = ':memory:', now: () => Date = clock()): Store {
  const store = new Store({ path, now });
  cleanups.push(() => store.close());
  return store;
}

function openRaw(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw new Error(`expected an AppError, got: ${String(e)}`);
  }
  throw new Error('expected an AppError, but the call succeeded');
}

function codeOf(fn: () => unknown): string {
  return errorOf(fn).code;
}

function rawError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the raw statement to fail');
}

const T0 = '2026-10-27T08:00:00.000Z';

function makeCustomer(over: Partial<Customer> = {}): Customer {
  return {
    id: 'cus_0001',
    vatStatus: 'DOMESTIC',
    name: 'Árvíztűrő Kft.',
    taxNumber: '12345676-2-42',
    address: { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Fő utca 1.' },
    email: 'info@arvizturo.hu',
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function makeProduct(over: Partial<Product> = {}): Product {
  return {
    id: 'prd_0001',
    name: 'Tükörfúrógép bérlés',
    unit: 'óra',
    unitPrice: '12500',
    priceBasis: 'net',
    currency: 'HUF',
    vatCode: '27',
    nature: 'SERVICE',
    sku: 'TFG-01',
    description: 'Óradíjas gépbérlés kezelővel',
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function makeSeries(over: Partial<Series> = {}): Series {
  return {
    id: 'ser_inv',
    kind: 'invoice',
    name: 'Számlák',
    pattern: 'SZ-{YYYY}-{SEQ:5}',
    yearlyReset: true,
    nextSeq: 1,
    seqYear: null,
    isDefault: true,
    archived: false,
    createdAt: T0,
    ...over,
  };
}

const page = { limit: 50, offset: 0 };

// ---------------------------------------------------------------------------------------------
// opening & schema
// ---------------------------------------------------------------------------------------------

describe('opening, schema and migrations', () => {
  it('has a sequential migration list and applies it to a fresh database', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    const raw = openStore().unsafeRawDatabaseForTests();
    expect(raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({
      value: String(LATEST_SCHEMA_VERSION),
    });
    const tables = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r['name']);
    expect(tables).toEqual([
      'audit_log',
      'customers',
      'exchange_rates',
      'invoice_documents',
      'invoice_documents_legacy',
      'invoices',
      'meta',
      'nav_submissions',
      'payment_allocations',
      'payments',
      'products',
      'series',
      'settings',
    ]);
  });

  it('sets the connection pragmas (WAL only for file databases)', () => {
    const fileDb = openStore(join(tempDir(), 'company.db')).unsafeRawDatabaseForTests();
    expect(fileDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(fileDb.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(fileDb.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(fileDb.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 1 });
    const memDb = openStore(':memory:').unsafeRawDatabaseForTests();
    expect(memDb.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'memory' });
    expect(memDb.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('reopening a file database keeps the data and does not re-run migrations', () => {
    const path = join(tempDir(), 'company.db');
    const first = openStore(path, () => new Date(T0));
    first.setSetting('greeting', { text: 'szia' });
    first.insertCustomer(makeCustomer());
    first.close();

    const second = openStore(path, () => new Date('2027-01-05T09:00:00.000Z'));
    expect(second.getSetting('greeting')).toEqual({ text: 'szia' });
    expect(second.getCustomer('cus_0001')?.name).toBe('Árvíztűrő Kft.');
    const meta = Object.fromEntries(
      second
        .unsafeRawDatabaseForTests()
        .prepare('SELECT key, value FROM meta ORDER BY key')
        .all()
        .map((r) => [r['key'], r['value']]),
    );
    // Timestamps from the first open prove that migrations were not applied again.
    expect(meta).toEqual({
      created_at: T0,
      schema_updated_at: T0,
      schema_version: String(LATEST_SCHEMA_VERSION),
    });
  });

  it('refuses a database written by a newer program version', () => {
    const path = join(tempDir(), 'company.db');
    openStore(path).close();
    const raw = openRaw(path);
    raw.exec(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`);
    raw.close();
    expect(codeOf(() => openStore(path))).toBe('SCHEMA_TOO_NEW');
  });

  it('refuses a foreign SQLite file', () => {
    const path = join(tempDir(), 'other.db');
    const raw = openRaw(path);
    raw.exec('CREATE TABLE stuff (x INTEGER)');
    raw.close();
    expect(codeOf(() => openStore(path))).toBe('NOT_AN_OPENSZAMLA_DB');
  });

  it('leaves a refused foreign database byte-for-byte untouched (no switch to WAL, no side files)', () => {
    const dir = tempDir();
    const path = join(dir, 'other.db');
    const raw = openRaw(path);
    raw.exec('CREATE TABLE stuff (x INTEGER)');
    raw.close();
    const before = readFileSync(path);
    expect(before[18]).toBe(1); // rollback-journal file format (2 would be WAL)
    expect(codeOf(() => openStore(path))).toBe('NOT_AN_OPENSZAMLA_DB');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['other.db']);
    // the failed open released the file handle (Windows would refuse to delete an open file)
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a file that is not an SQLite database at all, without changing it', () => {
    const dir = tempDir();
    const path = join(dir, 'jegyzet.txt');
    const text = 'Ez nem adatbázis, csak egy szöveges fájl. '.repeat(30);
    writeFileSync(path, text);
    const err = errorOf(() => openStore(path));
    expect(err.code).toBe('NOT_AN_OPENSZAMLA_DB');
    expect(err.hint).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(readdirSync(dir)).toEqual(['jegyzet.txt']);
  });

  it('re-checks the schema under the write lock and leaves a database migrated meanwhile alone', () => {
    const path = join(tempDir(), 'company.db');
    openStore(path, () => new Date(T0)).close();
    // Simulates the race: the unlocked check of this process still saw an empty file, and another
    // process finished the migration before BEGIN IMMEDIATE was granted.
    const spy = vi.spyOn(Store.prototype as unknown as { checkSchema(): number }, 'checkSchema').mockReturnValueOnce(0);
    try {
      const second = openStore(path, () => new Date('2027-01-05T09:00:00.000Z'));
      expect(spy).toHaveBeenCalledTimes(2);
      const meta = Object.fromEntries(
        second
          .unsafeRawDatabaseForTests()
          .prepare('SELECT key, value FROM meta ORDER BY key')
          .all()
          .map((r) => [r['key'], r['value']]),
      );
      expect(meta).toEqual({ created_at: T0, schema_updated_at: T0, schema_version: String(LATEST_SCHEMA_VERSION) });
    } finally {
      spy.mockRestore();
    }
  });

  it('several processes opening the same new database at once all succeed (first start of MCP server + serve)', async () => {
    // Without the fix: DB_BUSY from the switch to WAL, or a false NOT_AN_OPENSZAMLA_DB when the schema
    // version and the object count were read on both sides of another process's migration.
    const storeUrl = new URL('../../src/db/store.ts', import.meta.url).href;
    const child = `
      const [path, startAt] = process.argv.slice(1);
      const { Store } = await import(${JSON.stringify(storeUrl)});
      await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now() - 20)));
      while (Date.now() < Number(startAt)) {} // start together
      try {
        const s = new Store({ path });
        s.setSetting('opened', true);
        s.close();
        console.log('OK');
      } catch (e) {
        console.log('ERR', e.code, e.message);
      }`;
    const open = (path: string, startAt: number): Promise<string> =>
      new Promise((resolve) => {
        execFile(process.execPath, ['--no-warnings', '--input-type=module', '-e', child, path, String(startAt)], (_err, stdout, stderr) =>
          resolve(stdout.trim() || stderr.trim()),
        );
      });
    const startAt = Date.now() + 2500;
    const rounds = Array.from({ length: 5 }, () => join(tempDir(), 'company.db'));
    const results = await Promise.all(rounds.map((path) => Promise.all([open(path, startAt), open(path, startAt), open(path, startAt)])));
    expect(results).toEqual(rounds.map(() => ['OK', 'OK', 'OK']));
    for (const path of rounds) {
      const store = openStore(path);
      expect(store.getSetting('opened')).toBe(true);
      store.close();
    }
  }, 60_000);

  it('works under a non-ASCII path with spaces, and close() removes the WAL/SHM side files', () => {
    const dir = join(tempDir(), 'Árvíztűrő tükörfúrógép – cégadatok');
    mkdirSync(dir);
    const store = new Store({ path: join(dir, 'cég adatai.db'), now: clock() });
    store.setSetting('seller', { name: 'Őrült Ügyek Kft.' });
    expect(readdirSync(dir).sort()).toEqual(['cég adatai.db', 'cég adatai.db-shm', 'cég adatai.db-wal']);
    store.backup(join(dir, 'mentés 2026-10-27.db'));
    store.close();
    expect(readdirSync(dir).sort()).toEqual(['cég adatai.db', 'mentés 2026-10-27.db']);
    const copy = new Store({ path: join(dir, 'mentés 2026-10-27.db') });
    expect(copy.getSetting('seller')).toEqual({ name: 'Őrült Ügyek Kft.' });
    copy.close();
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('close() releases every handle, also after statement-cache eviction and a chain verification', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openszamla-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store({ path: join(dir, 'company.db'), now: clock() });
    for (let i = 0; i < 3; i++) store.audit({ actor: 'cli', action: `a${i}`, entityType: 'settings', entityId: null, details: { i } });
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 3 });
    // more distinct statements than the cache keeps (evicted statements are not finalized eagerly)
    for (let i = 0; i < 300; i++) store.findInvoices({ customerId: `cus_${i}`, status: Array.from({ length: (i % 30) + 1 }, () => 'draft'), limit: 1, offset: 0 });
    store.close();
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a missing parent directory', () => {
    expect(codeOf(() => openStore(join(tempDir(), 'missing', 'company.db')))).toBe('DB_OPEN_FAILED');
  });

  it('close() releases the file handle (the temp dir can be deleted) and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openszamla-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store({ path: join(dir, 'company.db') });
    store.setSetting('x', 1);
    expect(store.getSetting('x')).toBe(1);
    store.audit({ actor: 'cli', action: 'test', entityType: 'settings', entityId: 'x', details: {} });
    store.close();
    store.close();
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
    expect(codeOf(() => store.getSetting('x'))).toBe('STORE_CLOSED');
    expect(codeOf(() => store.tx(() => 1))).toBe('STORE_CLOSED');
  });
});

// ---------------------------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------------------------

describe('tx()', () => {
  it('commits on success and returns the callback value', () => {
    const store = openStore();
    const result = store.tx(() => {
      store.setSetting('a', 1);
      return 'kész';
    });
    expect(result).toBe('kész');
    expect(store.getSetting('a')).toBe(1);
    expect(store.unsafeRawDatabaseForTests().isTransaction).toBe(false);
  });

  it('rolls back on error and rethrows the original error', () => {
    const store = openStore();
    const boom = new Error('boom');
    expect(() =>
      store.tx(() => {
        store.setSetting('a', 1);
        throw boom;
      }),
    ).toThrow(boom);
    expect(store.getSetting('a')).toBeNull();
    expect(store.unsafeRawDatabaseForTests().isTransaction).toBe(false);
  });

  it('nested calls join the outer transaction', () => {
    const store = openStore();
    store.tx(() => {
      store.setSetting('outer', 1);
      store.tx(() => store.setSetting('inner', 2));
    });
    expect(store.getSetting('outer')).toBe(1);
    expect(store.getSetting('inner')).toBe(2);

    expect(() =>
      store.tx(() => {
        store.tx(() => store.setSetting('lost', 3));
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(store.getSetting('lost')).toBeNull();
  });

  it('a failing nested call is undone even when the outer code catches its error', () => {
    const store = openStore();
    store.tx(() => {
      store.setSetting('kept', true);
      try {
        store.tx(() => {
          store.setSetting('undone', true);
          throw new Error('inner fails');
        });
      } catch {
        // handled by the caller
      }
    });
    expect(store.getSetting('kept')).toBe(true);
    expect(store.getSetting('undone')).toBeNull();
  });

  it('rejects async callbacks (they would outlive the transaction)', () => {
    const store = openStore();
    expect(
      codeOf(() =>
        store.tx(async () => {
          store.setSetting('async', 1);
        }),
      ),
    ).toBe('TX_ASYNC');
    expect(store.getSetting('async')).toBeNull();
    expect(store.unsafeRawDatabaseForTests().isTransaction).toBe(false);
  });

  it('close() inside a callback ends in STORE_CLOSED (an AppError), not a raw SQLite error', () => {
    const a = openStore();
    expect(
      codeOf(() =>
        a.tx(() => {
          a.close();
          return a.getSetting('x');
        }),
      ),
    ).toBe('STORE_CLOSED');
    const b = openStore();
    expect(codeOf(() => b.tx(() => b.close()))).toBe('STORE_CLOSED');
    const c = openStore();
    expect(codeOf(() => c.tx(() => c.tx(() => c.close())))).toBe('STORE_CLOSED');
  });
});

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

describe('settings', () => {
  it('round-trips arbitrary JSON values', () => {
    const store = openStore();
    const seller = {
      name: 'Teszt Kft.',
      address: { countryCode: 'HU', city: 'Győr' },
      flags: [true, false],
      count: 3,
      vatRate: '0.27',
      missing: null,
    };
    store.setSetting('seller', seller);
    expect(store.getSetting<typeof seller>('seller')).toEqual(seller);
    store.setSetting('number', 42);
    store.setSetting('text', 'árvíztűrő');
    store.setSetting('bool', false);
    store.setSetting('list', [1, 'két', { három: 3 }]);
    expect(store.getSetting<number>('number')).toBe(42);
    expect(store.getSetting<string>('text')).toBe('árvíztűrő');
    expect(store.getSetting<boolean>('bool')).toBe(false);
    expect(store.getSetting('list')).toEqual([1, 'két', { három: 3 }]);
  });

  it('returns null for unknown keys, overwrites, and removes on null', () => {
    const store = openStore();
    expect(store.getSetting('nope')).toBeNull();
    store.setSetting('k', { v: 1 });
    store.setSetting('k', { v: 2 });
    expect(store.getSetting('k')).toEqual({ v: 2 });
    store.setSetting('k', null);
    expect(store.getSetting('k')).toBeNull();
    expect(codeOf(() => store.setSetting('', 1))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => store.setSetting('fn', () => 1))).toBe('INVALID_ARGUMENT');
  });

  it('stamps updated_at with the store clock', () => {
    const store = openStore(':memory:', () => new Date('2026-10-27T12:34:56.000Z'));
    store.setSetting('k', 1);
    expect(store.unsafeRawDatabaseForTests().prepare(`SELECT updated_at FROM settings WHERE key = 'k'`).get()).toEqual({
      updated_at: '2026-10-27T12:34:56.000Z',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// customers
// ---------------------------------------------------------------------------------------------

describe('customers', () => {
  it('inserts, reads and updates a customer', () => {
    const store = openStore();
    const c = makeCustomer({ note: 'VIP', groupMemberTaxNumber: '87654328-2-41' });
    store.insertCustomer(c);
    expect(store.getCustomer(c.id)).toEqual(c);
    const updated = { ...c, name: 'Árvíztűrő Zrt.', archived: true, updatedAt: '2026-10-28T08:00:00.000Z' };
    store.updateCustomer(updated);
    expect(store.getCustomer(c.id)).toEqual(updated);
    expect(store.getCustomer('cus_unknown')).toBeNull();
  });

  it('rejects duplicate ids and updates of unknown customers', () => {
    const store = openStore();
    store.insertCustomer(makeCustomer());
    expect(codeOf(() => store.insertCustomer(makeCustomer()))).toBe('ALREADY_EXISTS');
    expect(codeOf(() => store.updateCustomer(makeCustomer({ id: 'cus_unknown' })))).toBe('NOT_FOUND');
    expect(codeOf(() => store.insertCustomer(makeCustomer({ id: 'cus_x', name: '' })))).toBe('INVALID_ARGUMENT');
  });

  it('searches accent- and case-insensitively on name, tax numbers, email and city', () => {
    const store = openStore();
    store.insertCustomer(makeCustomer());
    store.insertCustomer(
      makeCustomer({
        id: 'cus_0002',
        name: 'Tükörfúrógép Bt.',
        vatStatus: 'OTHER',
        taxNumber: undefined,
        euVatNumber: 'DE123456789',
        email: 'beszerzes@tukor.de',
        address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Hauptstraße 1' },
      }),
    );
    store.insertCustomer(
      makeCustomer({
        id: 'cus_0003',
        name: 'Kovács János',
        vatStatus: 'PRIVATE_PERSON',
        taxNumber: undefined,
        email: undefined,
        address: { countryCode: 'HU', postalCode: '7621', city: 'Pécs', addressLine: 'Király utca 2.' },
      }),
    );
    const names = (text: string): string[] => store.findCustomers({ text, ...page }).items.map((c) => c.name);
    expect(names('arvizturo')).toEqual(['Árvíztűrő Kft.']);
    expect(names('ÁRVÍZTŰRŐ KFT')).toEqual(['Árvíztűrő Kft.']);
    expect(names('tukorfurogep')).toEqual(['Tükörfúrógép Bt.']);
    expect(names('pecs')).toEqual(['Kovács János']);
    expect(names('berlin')).toEqual(['Tükörfúrógép Bt.']);
    expect(names('beszerzes@')).toEqual(['Tükörfúrógép Bt.']);
    expect(names('de1234')).toEqual(['Tükörfúrógép Bt.']);
    expect(names('12345676-2')).toEqual(['Árvíztűrő Kft.']);
    expect(names('12345676242')).toEqual(['Árvíztűrő Kft.']);
    expect(names('kft')).toEqual(['Árvíztűrő Kft.']);
    expect(names('nincs ilyen')).toEqual([]);
    expect(names('   ')).toHaveLength(3);
  });

  it('treats LIKE wildcards in the query literally', () => {
    const store = openStore();
    store.insertCustomer(makeCustomer({ id: 'cus_a', name: '100% Bio Kft.' }));
    store.insertCustomer(makeCustomer({ id: 'cus_b', name: 'Bio_Termék Kft.' }));
    // An unescaped "_" would match the "-" here.
    store.insertCustomer(makeCustomer({ id: 'cus_c', name: 'Bio-Termék Kft.' }));
    const names = (text: string): string[] => store.findCustomers({ text, ...page }).items.map((c) => c.name);
    expect(names('100%')).toEqual(['100% Bio Kft.']);
    expect(names('%')).toEqual(['100% Bio Kft.']);
    expect(names('bio_term')).toEqual(['Bio_Termék Kft.']);
    expect(names('!')).toEqual([]);
  });

  it('matches the 8-digit törzsszám given in any format', () => {
    const store = openStore();
    store.insertCustomer(makeCustomer());
    store.insertCustomer(
      makeCustomer({ id: 'cus_member', name: 'Csoporttag Kft.', taxNumber: '17781799-5-44', groupMemberTaxNumber: '24366183-2-13' }),
    );
    store.insertCustomer(makeCustomer({ id: 'cus_eu', name: 'Közösségi Kft.', taxNumber: undefined, euVatNumber: 'HU11111111' }));
    const ids = (taxNumber: string): string[] => store.findCustomers({ taxNumber, ...page }).items.map((c) => c.id);
    for (const format of ['12345676', '12345676-2-42', '12345676242', 'HU12345676', 'hu 12345676', ' 12345676-2 ']) {
      expect(ids(format)).toEqual(['cus_0001']);
    }
    expect(ids('24366183')).toEqual(['cus_member']);
    expect(ids('17781799-5-44')).toEqual(['cus_member']);
    expect(ids('11111111-2-43')).toEqual(['cus_eu']);
    expect(ids('87654321')).toEqual([]);
    expect(store.findCustomers({ taxNumber: '12345676', text: 'nem egyezik', ...page }).total).toBe(0);
    expect(codeOf(() => store.findCustomers({ taxNumber: 'abc', ...page }))).toBe('INVALID_TAX_NUMBER');
    expect(codeOf(() => store.findCustomers({ taxNumber: '1234567', ...page }))).toBe('INVALID_TAX_NUMBER');
    expect(codeOf(() => store.findCustomers({ taxNumber: 'DE123456789', ...page }))).toBe('INVALID_TAX_NUMBER');
  });

  it('hides archived customers unless asked, and paginates with totals', () => {
    const store = openStore();
    for (let i = 1; i <= 7; i++) {
      store.insertCustomer(makeCustomer({ id: `cus_${i}`, name: `Ügyfél ${i} Kft.`, archived: i === 7 }));
    }
    const first = store.findCustomers({ limit: 3, offset: 0 });
    expect(first.total).toBe(6);
    expect(first.limit).toBe(3);
    expect(first.offset).toBe(0);
    expect(first.items.map((c) => c.id)).toEqual(['cus_1', 'cus_2', 'cus_3']);
    const last = store.findCustomers({ limit: 3, offset: 5 });
    expect(last.items.map((c) => c.id)).toEqual(['cus_6']);
    expect(last.total).toBe(6);
    expect(store.findCustomers({ limit: 3, offset: 99 })).toEqual({ items: [], total: 6, limit: 3, offset: 99 });
    expect(store.findCustomers({ includeArchived: true, ...page }).total).toBe(7);
    expect(store.findCustomers({ limit: 0, offset: 0 })).toEqual({ items: [], total: 6, limit: 0, offset: 0 });
    expect(codeOf(() => store.findCustomers({ limit: -1, offset: 0 }))).toBe('INVALID_PAGINATION');
    expect(codeOf(() => store.findCustomers({ limit: 10, offset: 1.5 }))).toBe('INVALID_PAGINATION');
    // integers beyond 2^53 cannot be bound to LIMIT / OFFSET exactly
    expect(codeOf(() => store.findCustomers({ limit: 2 ** 70, offset: 0 }))).toBe('INVALID_PAGINATION');
    expect(codeOf(() => store.findProducts({ limit: 10, offset: Number.MAX_SAFE_INTEGER + 1 }))).toBe('INVALID_PAGINATION');
    expect(store.findCustomers({ limit: Number.MAX_SAFE_INTEGER, offset: 0 }).total).toBe(6);
  });

  it('round-trips optional fields exactly: null stays null, "" stays "", undefined members are dropped', () => {
    const store = openStore();
    const c = makeCustomer({
      name: '  „Idéző” \\ Kft.   😀 ',
      groupMemberTaxNumber: null as unknown as string,
      phone: '',
      email: undefined,
      address: { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Fő utca 1.', region: 'Pest' },
    });
    store.insertCustomer(c);
    const back = store.getCustomer(c.id);
    expect(back).toEqual(c);
    expect(back?.name).toBe(c.name);
    expect(back?.groupMemberTaxNumber).toBeNull();
    expect(back?.phone).toBe('');
    expect(back !== null && 'email' in back).toBe(false);
    expect(back?.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------------------------

describe('products', () => {
  it('inserts, reads and updates a product', () => {
    const store = openStore();
    const p = makeProduct();
    store.insertProduct(p);
    expect(store.getProduct(p.id)).toEqual(p);
    const updated = { ...p, unitPrice: '13000', sku: undefined, updatedAt: '2026-11-01T08:00:00.000Z' };
    store.updateProduct(updated);
    expect(store.getProduct(p.id)).toEqual(updated);
    expect(store.getProduct('prd_unknown')).toBeNull();
    expect(codeOf(() => store.insertProduct(p))).toBe('ALREADY_EXISTS');
    expect(codeOf(() => store.updateProduct(makeProduct({ id: 'prd_unknown' })))).toBe('NOT_FOUND');
  });

  it('searches name, sku and description accent-insensitively; hides archived; paginates', () => {
    const store = openStore();
    store.insertProduct(makeProduct());
    store.insertProduct(makeProduct({ id: 'prd_0002', name: 'Csavarhúzó', sku: 'CSH-9', description: 'Kézi szerszám' }));
    store.insertProduct(makeProduct({ id: 'prd_0003', name: 'Régi gép', sku: 'OLD-1', description: undefined, archived: true }));
    const ids = (text: string, includeArchived = false): string[] =>
      store.findProducts({ text, includeArchived, ...page }).items.map((p) => p.id);
    expect(ids('tukorfurogep')).toEqual(['prd_0001']);
    expect(ids('csh-9')).toEqual(['prd_0002']);
    expect(ids('KEZI SZERSZAM')).toEqual(['prd_0002']);
    expect(ids('oradijas')).toEqual(['prd_0001']);
    expect(ids('regi')).toEqual([]);
    expect(ids('regi', true)).toEqual(['prd_0003']);
    const p1 = store.findProducts({ limit: 1, offset: 1 });
    expect(p1.total).toBe(2);
    expect(p1.items.map((p) => p.id)).toEqual(['prd_0001']);
  });

  it('validates unitPrice and stores it as a canonical decimal string', () => {
    const store = openStore();
    store.insertProduct(makeProduct({ unitPrice: '12500.50' }));
    expect(store.getProduct('prd_0001')?.unitPrice).toBe('12500.5');
    store.updateProduct(makeProduct({ unitPrice: '-0.000' }));
    expect(store.getProduct('prd_0001')?.unitPrice).toBe('0');
    expect(codeOf(() => store.insertProduct(makeProduct({ id: 'prd_bad', unitPrice: '1,5' })))).toBe('INVALID_NUMBER');
    expect(codeOf(() => store.updateProduct(makeProduct({ unitPrice: '1e3' })))).toBe('INVALID_NUMBER');
    expect(store.getProduct('prd_bad')).toBeNull();
    expect(store.getProduct('prd_0001')?.unitPrice).toBe('0');
    const raw = store.unsafeRawDatabaseForTests().prepare(`SELECT json_extract(data, '$.unitPrice') AS p FROM products`).get();
    expect(raw).toEqual({ p: '0' });
  });
});

// ---------------------------------------------------------------------------------------------
// series & sequence allocation
// ---------------------------------------------------------------------------------------------

describe('series', () => {
  it('inserts, reads and lists series with kind and archived filters', () => {
    const store = openStore();
    const inv = makeSeries();
    const pro = makeSeries({ id: 'ser_pro', kind: 'proforma', name: 'Díjbekérők', pattern: 'DB-{YYYY}-{SEQ:5}' });
    const old = makeSeries({ id: 'ser_old', name: 'Régi tömb', isDefault: false, archived: true, createdAt: '2025-01-01T00:00:00.000Z' });
    store.insertSeries(inv);
    store.insertSeries(pro);
    store.insertSeries(old);
    expect(store.getSeries('ser_inv')).toEqual(inv);
    expect(store.getSeries('ser_unknown')).toBeNull();
    expect(store.listSeries().map((s) => s.id)).toEqual(['ser_inv', 'ser_pro']);
    expect(store.listSeries('invoice').map((s) => s.id)).toEqual(['ser_inv']);
    expect(store.listSeries('invoice', true).map((s) => s.id)).toEqual(['ser_old', 'ser_inv']);
    expect(store.listSeries(undefined, true)).toHaveLength(3);
    expect(codeOf(() => store.insertSeries(inv))).toBe('ALREADY_EXISTS');
  });

  it('keeps a single default per kind', () => {
    const store = openStore();
    store.insertSeries(makeSeries({ id: 'ser_a' }));
    store.insertSeries(makeSeries({ id: 'ser_p', kind: 'proforma', pattern: 'DB-{SEQ}' }));
    store.insertSeries(makeSeries({ id: 'ser_b' }));
    expect(store.getDefaultSeries('invoice')?.id).toBe('ser_b');
    expect(store.getSeries('ser_a')?.isDefault).toBe(false);
    const a = store.getSeries('ser_a');
    if (!a) throw new Error('missing series');
    store.updateSeries({ ...a, isDefault: true });
    expect(store.getDefaultSeries('invoice')?.id).toBe('ser_a');
    expect(store.getSeries('ser_b')?.isDefault).toBe(false);
    expect(store.getDefaultSeries('proforma')?.id).toBe('ser_p');
  });

  it('updateSeries changes only name/pattern/yearlyReset/isDefault/archived', () => {
    const store = openStore();
    store.insertSeries(makeSeries({ nextSeq: 42, seqYear: 2026 }));
    store.updateSeries(
      makeSeries({
        name: 'Átnevezett',
        pattern: 'A-{YY}-{SEQ:4}',
        yearlyReset: false,
        isDefault: false,
        archived: true,
        kind: 'proforma',
        nextSeq: 1,
        seqYear: null,
        createdAt: '2030-01-01T00:00:00.000Z',
      }),
    );
    expect(store.getSeries('ser_inv')).toEqual(
      makeSeries({
        name: 'Átnevezett',
        pattern: 'A-{YY}-{SEQ:4}',
        yearlyReset: false,
        isDefault: false,
        archived: true,
        nextSeq: 42,
        seqYear: 2026,
      }),
    );
    expect(codeOf(() => store.updateSeries(makeSeries({ id: 'ser_unknown' })))).toBe('NOT_FOUND');
  });

  it('getDefaultSeries ignores archived series', () => {
    const store = openStore();
    store.insertSeries(makeSeries({ archived: true }));
    expect(store.getDefaultSeries('invoice')).toBeNull();
    expect(store.getDefaultSeries('proforma')).toBeNull();
  });
});

describe('allocateSequence', () => {
  function seriesStore(over: Partial<Series> = {}): Store {
    const store = openStore();
    store.insertSeries(makeSeries(over));
    return store;
  }

  it('must be called inside tx()', () => {
    const store = seriesStore();
    const err = errorOf(() => store.allocateSequence('ser_inv', '2026-10-27'));
    expect(err.code).toBe('TX_REQUIRED');
    expect(err.hint).toBeTruthy();
    expect(store.getSeries('ser_inv')?.nextSeq).toBe(1);
  });

  it('hands out sequential numbers and advances the series', () => {
    const store = seriesStore();
    const got = [1, 2, 3].map(() => store.tx(() => store.allocateSequence('ser_inv', '2026-10-27')));
    expect(got).toEqual([
      { seq: 1, year: 2026 },
      { seq: 2, year: 2026 },
      { seq: 3, year: 2026 },
    ]);
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 4, seqYear: 2026 });
    expect(store.tx(() => [store.allocateSequence('ser_inv', '2026-12-31'), store.allocateSequence('ser_inv', '2026-12-31')])).toEqual([
      { seq: 4, year: 2026 },
      { seq: 5, year: 2026 },
    ]);
  });

  it('restarts at 1 when the year changes (yearlyReset)', () => {
    const store = seriesStore({ nextSeq: 17, seqYear: 2026 });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2026-12-31'))).toEqual({ seq: 17, year: 2026 });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2027-01-02'))).toEqual({ seq: 1, year: 2027 });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2027-01-02'))).toEqual({ seq: 2, year: 2027 });
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 3, seqYear: 2027 });
  });

  it('continues the sequence across years without yearlyReset', () => {
    const store = seriesStore({ yearlyReset: false, pattern: 'SZ-{SEQ:6}', nextSeq: 9, seqYear: 2026 });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2027-01-02'))).toEqual({ seq: 9, year: 2027 });
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 10, seqYear: 2027 });
  });

  it('rejects issuing into a past year once the series moved on', () => {
    for (const yearlyReset of [true, false]) {
      const store = seriesStore({ yearlyReset, nextSeq: 5, seqYear: 2027 });
      const err = errorOf(() => store.tx(() => store.allocateSequence('ser_inv', '2026-12-31')));
      expect(err.code).toBe('SERIES_YEAR_CLOSED');
      expect(err.details).toMatchObject({ seqYear: 2027, issueYear: 2026 });
      expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 5, seqYear: 2027 });
    }
  });

  it('a rolled back transaction leaves nextSeq unchanged', () => {
    const store = seriesStore({ nextSeq: 7, seqYear: 2026 });
    expect(() =>
      store.tx(() => {
        expect(store.allocateSequence('ser_inv', '2026-10-27')).toEqual({ seq: 7, year: 2026 });
        throw new Error('issuing failed');
      }),
    ).toThrow('issuing failed');
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 7, seqYear: 2026 });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2026-10-27'))).toEqual({ seq: 7, year: 2026 });
  });

  it('a failed nested step that the caller catches does not burn a number', () => {
    const store = seriesStore({ nextSeq: 3, seqYear: 2026 });
    const got = store.tx(() => {
      try {
        store.tx(() => {
          expect(store.allocateSequence('ser_inv', '2026-10-27')).toEqual({ seq: 3, year: 2026 });
          throw new Error('markIssued failed');
        });
      } catch {
        // the issuing code handles the failure and tries again within the same transaction
      }
      return store.allocateSequence('ser_inv', '2026-10-27');
    });
    expect(got).toEqual({ seq: 3, year: 2026 });
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 4, seqYear: 2026 });
  });

  it('two connections (e.g. the MCP server and the CLI) share one sequence without gaps or duplicates', () => {
    const path = join(tempDir(), 'company.db');
    const a = openStore(path);
    a.insertSeries(makeSeries());
    const b = openStore(path);
    const seqs = [a, b, a, b, b].map((s) => s.tx(() => s.allocateSequence('ser_inv', '2026-10-27').seq));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(a.getSeries('ser_inv')).toMatchObject({ nextSeq: 6, seqYear: 2026 });
    // the year moves on in one process; the other cannot go back
    expect(b.tx(() => b.allocateSequence('ser_inv', '2027-01-02'))).toEqual({ seq: 1, year: 2027 });
    expect(codeOf(() => a.tx(() => a.allocateSequence('ser_inv', '2026-12-31')))).toBe('SERIES_YEAR_CLOSED');
  });

  it('starts from a custom start sequence', () => {
    const store = seriesStore({ nextSeq: 500, seqYear: null });
    expect(store.tx(() => store.allocateSequence('ser_inv', '2026-10-27'))).toEqual({ seq: 500, year: 2026 });
  });

  it('validates its input', () => {
    const store = seriesStore();
    expect(codeOf(() => store.tx(() => store.allocateSequence('ser_unknown', '2026-10-27')))).toBe('NOT_FOUND');
    expect(codeOf(() => store.tx(() => store.allocateSequence('ser_inv', '2026-02-30')))).toBe('INVALID_DATE');
  });
});

// ---------------------------------------------------------------------------------------------
// exchange-rate cache
// ---------------------------------------------------------------------------------------------

describe('exchange-rate cache', () => {
  it('caches a rate under the requested date', () => {
    const store = openStore();
    expect(store.getCachedRate('EUR', '2026-10-25')).toBeNull();
    // Sunday: the last published rate is from Thursday (23 October is a public holiday).
    const rate = { currency: 'EUR', date: '2026-10-22', rate: '391.25', unit: 1, source: 'MNB' as const };
    store.putCachedRate('2026-10-25', rate);
    expect(store.getCachedRate('EUR', '2026-10-25')).toEqual(rate);
    expect(store.getCachedRate('eur', '2026-10-25')).toEqual(rate);
    expect(store.getCachedRate('EUR', '2026-10-22')).toBeNull();
    expect(store.getCachedRate('USD', '2026-10-25')).toBeNull();
  });

  it('normalises currency and rate, and overwrites an existing entry', () => {
    const store = openStore();
    store.putCachedRate('2026-10-27', { currency: 'jpy', date: '2026-10-27', rate: '245.10', unit: 100, source: 'MNB' });
    expect(store.getCachedRate('JPY', '2026-10-27')).toEqual({
      currency: 'JPY',
      date: '2026-10-27',
      rate: '245.1',
      unit: 100,
      source: 'MNB',
    });
    store.putCachedRate('2026-10-27', { currency: 'JPY', date: '2026-10-27', rate: '246', unit: 100, source: 'MNB' });
    expect(store.getCachedRate('JPY', '2026-10-27')?.rate).toBe('246');
  });

  it('rejects invalid rates', () => {
    const store = openStore();
    const base = { currency: 'EUR', date: '2026-10-27', rate: '390', unit: 1, source: 'MNB' as const };
    expect(codeOf(() => store.putCachedRate('2026-10-27', { ...base, rate: '0' }))).toBe('INVALID_NUMBER');
    expect(codeOf(() => store.putCachedRate('2026-10-27', { ...base, rate: '1,5' }))).toBe('INVALID_NUMBER');
    expect(codeOf(() => store.putCachedRate('2026-10-27', { ...base, unit: 0 }))).toBe('INVALID_DATA');
    expect(codeOf(() => store.putCachedRate('2026-10-26', base))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => store.putCachedRate('2026-13-01', base))).toBe('INVALID_DATE');
  });
});

// ---------------------------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------------------------

describe('audit log', () => {
  function seeded(store: Store): void {
    store.audit({ actor: 'mcp', action: 'invoice.issue', entityType: 'invoice', entityId: 'inv_1', details: { number: 'SZ-2026-00001' } });
    store.audit({ actor: 'cli', action: 'customer.update', entityType: 'customer', entityId: 'cus_1', details: { amount: '12700' } });
    store.audit({ actor: 'system', action: 'settings.update', entityType: 'settings', entityId: null, details: { keys: ['seller'] } });
  }

  it('appends entries stamped by the clock and returns them', () => {
    const store = openStore(':memory:', () => new Date('2026-10-27T09:15:00.000Z'));
    const e = store.audit({
      actor: 'mcp',
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: 'inv_1',
      details: { lines: 2, total: '12700', nested: { b: 1, a: [1, 2] } },
    });
    expect(e).toEqual({
      id: 1,
      at: '2026-10-27T09:15:00.000Z',
      actor: 'mcp',
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: 'inv_1',
      details: { lines: 2, total: '12700', nested: { b: 1, a: [1, 2] } },
    });
    expect(store.listAudit({ ...page }).items).toEqual([e]);
  });

  it('chains the hashes exactly as specified in the contract', () => {
    const store = openStore();
    seeded(store);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 3 });
    const rows = store.unsafeRawDatabaseForTests().prepare('SELECT * FROM audit_log ORDER BY id').all();
    let prev = '0'.repeat(64);
    for (const r of rows) {
      const payload = canonicalJson({
        at: r['at'],
        actor: r['actor'],
        action: r['action'],
        entityType: r['entity_type'],
        entityId: r['entity_id'],
        details: JSON.parse(String(r['details'])) as unknown,
      });
      const expected = sha256Hex(`${prev}\n${payload}`);
      expect(r['prev_hash']).toBe(prev);
      expect(r['hash']).toBe(expected);
      prev = expected;
    }
  });

  it('verifies an empty log', () => {
    expect(openStore().verifyAuditChain()).toEqual({ ok: true, entries: 0 });
  });

  it('stores exactly what the hash covers (undefined members dropped, entityId null)', () => {
    const store = openStore();
    const e = store.audit({
      actor: 'web',
      action: 'x',
      entityType: 'nav',
      entityId: null,
      details: { keep: 1, drop: undefined, list: [1, 2] },
    });
    expect(e.details).toEqual({ keep: 1, list: [1, 2] });
    expect(Object.keys(e.details)).toEqual(['keep', 'list']);
    expect(store.listAudit({ ...page }).items[0]).toEqual(e);
    expect(store.verifyAuditChain().ok).toBe(true);
  });

  it('lists newest first, filters by entity and paginates', () => {
    const store = openStore();
    seeded(store);
    store.audit({ actor: 'mcp', action: 'invoice.paid', entityType: 'invoice', entityId: 'inv_1', details: {} });
    const all = store.listAudit({ limit: 2, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.items.map((e) => e.id)).toEqual([4, 3]);
    expect(store.listAudit({ limit: 2, offset: 2 }).items.map((e) => e.id)).toEqual([2, 1]);
    const inv = store.listAudit({ entityId: 'inv_1', ...page });
    expect(inv.total).toBe(2);
    expect(inv.items.map((e) => e.action)).toEqual(['invoice.paid', 'invoice.issue']);
  });

  it('is append-only: triggers reject UPDATE, DELETE, REPLACE and out-of-chain inserts', () => {
    const store = openStore();
    seeded(store);
    const raw = store.unsafeRawDatabaseForTests();
    const attempts = [
      () => raw.exec(`UPDATE audit_log SET action = 'hamis' WHERE id = 2`),
      () => raw.exec('DELETE FROM audit_log WHERE id = 3'),
      () => raw.exec('DELETE FROM audit_log'),
      () =>
        raw.exec(
          `INSERT OR REPLACE INTO audit_log (id, at, actor, action, entity_type, entity_id, details, prev_hash, hash)
           SELECT id, at, actor, 'hamis', entity_type, entity_id, details, prev_hash, '${'f'.repeat(64)}' FROM audit_log WHERE id = 3`,
        ),
      () =>
        raw.exec(
          `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, details, prev_hash, hash)
           VALUES ('2026-10-27T09:00:00.000Z', 'cli', 'x', 'invoice', NULL, '{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}')`,
        ),
    ];
    for (const attempt of attempts) {
      const err = rawError(attempt);
      expect(String((err as Error).message)).toMatch(/^AUDIT_APPEND_ONLY/);
      expect(mapDbError(err).code).toBe('AUDIT_APPEND_ONLY');
    }
    expect(store.listAudit({ ...page }).total).toBe(3);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 3 });
  });

  it('an external connection (recursive_triggers OFF) cannot delete an entry via INSERT OR REPLACE on its hash', () => {
    const path = join(tempDir(), 'company.db');
    const store = openStore(path);
    seeded(store);
    const hashes = store
      .unsafeRawDatabaseForTests()
      .prepare('SELECT hash FROM audit_log ORDER BY id')
      .all()
      .map((r) => String(r['hash']));
    const other = openRaw(path);
    expect(other.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
    // prev_hash continues the chain, but the hash collides with entry 2: REPLACE would delete entry 2
    const err = rawError(() =>
      other
        .prepare(
          `INSERT OR REPLACE INTO audit_log (at, actor, action, entity_type, entity_id, details, prev_hash, hash)
           VALUES ('2026-10-27T09:00:00.000Z', 'cli', 'hamis', 'invoice', NULL, '{}', ?, ?)`,
        )
        .run(hashes[2] ?? '', hashes[1] ?? ''),
    );
    expect(String((err as Error).message)).toMatch(/^AUDIT_APPEND_ONLY/);
    expect(store.listAudit({ ...page }).items.map((e) => e.action)).toEqual(['settings.update', 'customer.update', 'invoice.issue']);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 3 });
  });

  it('refuses an entry with an explicit id before the end of the chain', () => {
    const store = openStore();
    seeded(store);
    const raw = store.unsafeRawDatabaseForTests();
    const last = String(raw.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.['hash']);
    const insert = (id: number): unknown =>
      raw
        .prepare(
          `INSERT INTO audit_log (id, at, actor, action, entity_type, entity_id, details, prev_hash, hash)
           VALUES (?, '2026-10-27T09:00:00.000Z', 'cli', 'korai', 'invoice', NULL, '{}', ?, ?)`,
        )
        .run(id, last, sha256Hex(`${last}-${id}`));
    for (const id of [0, -5]) {
      const err = rawError(() => insert(id));
      expect(String((err as Error).message)).toMatch(/^AUDIT_APPEND_ONLY/);
      expect(mapDbError(err).code).toBe('AUDIT_APPEND_ONLY');
    }
    expect(store.listAudit({ ...page }).total).toBe(3);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 3 });
    // the store keeps appending normally afterwards
    expect(store.audit({ actor: 'cli', action: 'utána', entityType: 'settings', entityId: null, details: {} }).id).toBe(4);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 4 });
  });

  it('detects tampering that bypasses the triggers', () => {
    const store = openStore();
    seeded(store);
    const raw = store.unsafeRawDatabaseForTests();
    raw.exec('DROP TRIGGER audit_log_update_guard');
    raw.exec(`UPDATE audit_log SET details = '{"amount":"1"}' WHERE id = 2`);
    expect(store.verifyAuditChain()).toEqual({ ok: false, entries: 3, brokenAtId: 2 });
  });

  it('detects a removed entry in the middle of the chain', () => {
    const store = openStore();
    seeded(store);
    const raw = store.unsafeRawDatabaseForTests();
    raw.exec('DROP TRIGGER audit_log_delete_guard');
    raw.exec('DELETE FROM audit_log WHERE id = 2');
    expect(store.verifyAuditChain()).toEqual({ ok: false, entries: 2, brokenAtId: 3 });
  });

  it('an entry written in a rolled back transaction disappears and the chain stays valid', () => {
    const store = openStore();
    seeded(store);
    expect(() =>
      store.tx(() => {
        store.audit({ actor: 'mcp', action: 'doomed', entityType: 'invoice', entityId: 'inv_9', details: {} });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    const next = store.audit({ actor: 'mcp', action: 'after', entityType: 'invoice', entityId: 'inv_9', details: {} });
    expect(next.id).toBe(4);
    expect(store.verifyAuditChain()).toEqual({ ok: true, entries: 4 });
  });
});

// ---------------------------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------------------------

describe('backup', () => {
  it('writes a consistent, readable copy', () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'company.db'));
    store.setSetting('seller', { name: 'Teszt Kft.' });
    store.insertCustomer(makeCustomer());
    store.audit({ actor: 'cli', action: 'backup.test', entityType: 'settings', entityId: null, details: {} });
    const target = join(dir, 'backup-2026-10-27.db');
    store.backup(target);
    expect(existsSync(target)).toBe(true);

    const copy = openStore(target);
    expect(copy.getSetting('seller')).toEqual({ name: 'Teszt Kft.' });
    expect(copy.getCustomer('cus_0001')).toEqual(makeCustomer());
    expect(copy.verifyAuditChain()).toEqual({ ok: true, entries: 1 });
    // the original keeps working
    store.setSetting('after', true);
    expect(copy.getSetting('after')).toBeNull();
  });

  it('refuses to overwrite an existing file and to run inside a transaction', () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'company.db'));
    const target = join(dir, 'backup.db');
    store.backup(target);
    expect(codeOf(() => store.backup(target))).toBe('BACKUP_EXISTS');
    expect(codeOf(() => store.tx(() => store.backup(join(dir, 'other.db'))))).toBe('TX_NOT_ALLOWED');
    expect(existsSync(join(dir, 'other.db'))).toBe(false);
    expect(codeOf(() => store.backup(join(dir, 'missing', 'b.db')))).toBe('BACKUP_FAILED');
  });

  it('can back up an in-memory database', () => {
    const dir = tempDir();
    const store = openStore();
    store.insertProduct(makeProduct());
    store.backup(join(dir, 'mem.db'));
    expect(openStore(join(dir, 'mem.db')).getProduct('prd_0001')).toEqual(makeProduct());
  });
});

// ---------------------------------------------------------------------------------------------
// error mapping
// ---------------------------------------------------------------------------------------------

describe('mapDbError', () => {
  it('passes AppErrors through and maps SQLite errors to stable codes', () => {
    const app = new AppError('SOMETHING', 'valami');
    expect(mapDbError(app)).toBe(app);

    const db = openRaw(':memory:');
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n > 0), p TEXT REFERENCES t (id)) STRICT`);
    db.exec(`INSERT INTO t (id, n) VALUES ('a', 1)`);
    expect(mapDbError(rawError(() => db.exec(`INSERT INTO t (id, n) VALUES ('a', 2)`))).code).toBe('ALREADY_EXISTS');
    expect(mapDbError(rawError(() => db.exec(`INSERT INTO t (id, n) VALUES ('b', 0)`))).code).toBe('INVALID_DATA');
    expect(mapDbError(rawError(() => db.exec(`INSERT INTO t (id, n) VALUES ('c', 'x')`))).code).toBe('INVALID_DATA');
    expect(mapDbError(rawError(() => db.exec(`INSERT INTO t (id, n, p) VALUES ('d', 1, 'zz')`))).code).toBe('INVALID_REFERENCE');
    expect(mapDbError(rawError(() => db.exec('SELEKT 1'))).code).toBe('DB_ERROR');

    const locked = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    expect(mapDbError(locked).code).toBe('DB_BUSY');
    expect(mapDbError(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(mapDbError('not even an error').code).toBe('INTERNAL_ERROR');
  });
});
