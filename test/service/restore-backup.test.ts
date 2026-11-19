/**
 * `openszamla restore`: a backup put in the place of the database by the program, not by copying files. Copied by hand
 * over the database of a running server, or beside the write-ahead log of the old database, the result was "database
 * disk image is malformed"; and an earlier state restored that way gave the numbers issued since the backup to new
 * invoices – two invoices under one number, a number collision at NAV. The restore refuses while the database is open
 * elsewhere, keeps the replaced database beside the new one, continues the numbering after the numbers already given
 * out, records what was lost in the audit log, and `verify` tells that gap from numbers that vanished without a trace.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, mapDbError, probeExclusive } from '../../src/db/store.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { RESTORE_AUDIT_ACTION, restoreDatabase, type RestoreRecord } from '../../src/service/restore.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';

const dirs: string[] = [];
const apps: OpenSzamla[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const NOW = new Date('2026-11-14T09:00:00.000Z');

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-restore-'));
  dirs.push(dir);
  return dir;
}

function open(dir: string): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } });
  const app = OpenSzamla.open({ config, now: () => NOW });
  apps.push(app);
  return app;
}

function close(app: OpenSzamla): void {
  app.close();
  apps.splice(apps.indexOf(app), 1);
}

async function issue(app: OpenSzamla, unitPrice: string): Promise<string> {
  const customerId = app.findCustomers({}).items[0]?.id ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
  return (await app.issue(d.invoice.id)).invoice.number as string;
}

/** A database with two invoices, a backup of it, then two more invoices: the backup is an earlier state. */
async function withBackup(): Promise<{ dir: string; db: string; backup: string; before: string[]; after: string[] }> {
  const dir = tempDir();
  const app = open(dir);
  app.updateSeller(SELLER_INPUT);
  const before = [await issue(app, '10000'), await issue(app, '20000')];
  const backup = join(tempDir(), 'mentes.db');
  app.store.backup(backup);
  const after = [await issue(app, '30000'), await issue(app, '40000')];
  close(app);
  return { dir, db: join(dir, 'openszamla.db'), backup, before, after };
}

describe('restore: a backup put in the place of the database', () => {
  it('the SQLite error "database disk image is malformed" is reported as a damaged file, with the way out', () => {
    for (const errcode of [11, 26, 11 | (1 << 8)]) {
      const e = mapDbError(Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode }));
      expect(e.code, String(errcode)).toBe('DB_DAMAGED');
      expect(e.message).toBe('Az adatbázisfájl sérült, vagy nem a hozzá tartozó naplófájlokkal (-wal, -shm) áll együtt.');
      expect(e.hint).toContain('openszamla restore <mentésfájl> --confirm');
    }
  });

  it('without confirm it only says what would happen; nothing is changed, no file is left behind', async () => {
    const s = await withBackup();
    const files = readdirSync(s.dir).sort();
    const r = restoreDatabase({ dbPath: s.db, backupPath: s.backup, confirm: false, now: () => NOW });
    expect(r).toMatchObject({ restored: false, asidePath: null });
    expect(r.plan.earlierState).toBe(true);
    expect(r.plan.backup.issued).toBe(2);
    expect(r.plan.current?.issued).toBe(4);
    expect(r.plan.lost.map((l) => l.number)).toEqual(s.after);
    expect(r.plan.lost[0]).toMatchObject({ documentType: 'invoice', seq: 3, year: 2026 });
    expect(r.plan.conflicting).toEqual([]);
    expect(r.plan.continued).toHaveLength(1);
    expect(r.plan.continued[0]).toMatchObject({ from: 'SZ-2026-00003', to: 'SZ-2026-00005', nextSeq: 5 });
    expect(readdirSync(s.dir).sort()).toEqual(files);
    const app = open(s.dir);
    expect(app.findInvoices({ status: ['issued'] }).total).toBe(4);
  });

  it('an earlier state: the replaced database is kept, the numbering continues after the lost numbers, verify explains the gap', async () => {
    const s = await withBackup();
    const r = restoreDatabase({ dbPath: s.db, backupPath: s.backup, confirm: true, now: () => NOW });
    expect(r.restored).toBe(true);
    expect(r.asidePath).toBe(`${s.db}.visszaallitas-elott-${r.asidePath?.split('visszaallitas-elott-')[1] ?? ''}`);
    expect(existsSync(r.asidePath as string)).toBe(true);
    // No temporary copy and no log file of the old database beside the restored one.
    expect(readdirSync(s.dir).filter((f) => f.endsWith('.tmp') || f === 'openszamla.db-wal')).toEqual([]);

    const app = open(s.dir);
    expect(app.findInvoices({ status: ['issued'] }).items.map((i) => i.number).sort()).toEqual(s.before);
    const entry = app.auditLog({ limit: 50 }).items.find((e) => e.action === RESTORE_AUDIT_ACTION);
    const record = entry?.details as unknown as RestoreRecord;
    expect(record).toMatchObject({ backupFile: 'mentes.db', earlierState: true, lostCount: 2, conflicting: [] });
    expect(record.lost.map((l) => l.number)).toEqual(s.after);
    expect(record.continued).toEqual([{ seriesId: record.continued[0]?.seriesId, from: 'SZ-2026-00003', to: 'SZ-2026-00005' }]);

    // The lost numbers are not given out again.
    expect(await issue(app, '50000')).toBe('SZ-2026-00005');
    const v = app.verifyIntegrity();
    expect(v.numberingGaps).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.restoreWarnings).toHaveLength(1);
    expect(v.restoreWarnings[0]).toContain('a mentés után kiállított 2 bizonylat (SZ-2026-00003 – SZ-2026-00004) nincs az adatbázisban');
    expect(v.restoreWarnings[0]).toContain('visszaallitas-elott-');

    // The replaced database is a whole database: its documents are still there.
    const aside = new Store({ path: r.asidePath as string });
    try {
      expect(aside.listNumberedDocuments().map((d) => d.number)).toEqual([...s.before, ...s.after]);
    } finally {
      aside.close();
    }
  });

  it('refuses while another connection has the database open; nothing is changed', async () => {
    const s = await withBackup();
    const running = open(s.dir); // e.g. `openszamla serve` or an MCP server of an AI client, idle
    expect(probeExclusive(s.db)).toBe('in-use');
    expect(() => restoreDatabase({ dbPath: s.db, backupPath: s.backup, confirm: true, now: () => NOW })).toThrowError(expect.objectContaining({ code: 'DB_IN_USE' }));
    expect(running.findInvoices({ status: ['issued'] }).total).toBe(4);
    expect(readdirSync(s.dir).filter((f) => f.includes('visszaallitas'))).toEqual([]);
    close(running);
    expect(probeExclusive(s.db)).toBe('free');
    expect(restoreDatabase({ dbPath: s.db, backupPath: s.backup, confirm: true, now: () => NOW }).restored).toBe(true);
  });

  it('into a data folder without a database (a new machine): the backup becomes the database', async () => {
    const s = await withBackup();
    const fresh = tempDir();
    const db = join(fresh, 'openszamla.db');
    const r = restoreDatabase({ dbPath: db, backupPath: s.backup, confirm: true, now: () => NOW });
    expect(r).toMatchObject({ restored: true, asidePath: null });
    expect(r.plan).toMatchObject({ current: null, currentProblem: null, earlierState: null, lost: [], continued: [] });
    const app = open(fresh);
    expect(app.findInvoices({ status: ['issued'] }).total).toBe(2);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, restoreWarnings: [] });
    expect(await issue(app, '50000')).toBe('SZ-2026-00003');
  });

  it('over an unrelated database: its documents are listed as lost, the numbering follows the backup', async () => {
    const s = await withBackup();
    const otherDir = tempDir();
    const other = open(otherDir);
    other.updateSeller({ ...SELLER_INPUT, name: 'Másik Kft.' });
    const theirs = [await issue(other, '11111'), await issue(other, '22222'), await issue(other, '33333')];
    close(other);
    const db = join(otherDir, 'openszamla.db');
    const r = restoreDatabase({ dbPath: db, backupPath: s.backup, confirm: true, now: () => NOW });
    expect(r.plan.earlierState).toBe(false);
    // The same numbers on both sides are different invoices; the third exists only in the replaced database.
    expect(r.plan.conflicting).toEqual(theirs.slice(0, 2));
    expect(r.plan.lost.map((l) => l.number)).toEqual(theirs.slice(2));
    expect(r.plan.continued).toEqual([]);
    const app = open(otherDir);
    expect(await issue(app, '50000')).toBe('SZ-2026-00003');
  });

  it('a damaged database is set aside without a comparison; a file that is not a backup is refused and nothing changes', async () => {
    const s = await withBackup();
    const notBackup = join(tempDir(), 'jegyzet.db');
    writeFileSync(notBackup, 'ez nem adatbázis '.repeat(400));
    expect(() => restoreDatabase({ dbPath: s.db, backupPath: notBackup, confirm: true, now: () => NOW })).toThrowError(expect.objectContaining({ code: 'BACKUP_UNUSABLE' }));
    expect(() => restoreDatabase({ dbPath: s.db, backupPath: join(s.dir, 'nincs-ilyen.db'), confirm: true, now: () => NOW })).toThrowError(expect.objectContaining({ code: 'BACKUP_NOT_FOUND' }));
    expect(() => restoreDatabase({ dbPath: s.db, backupPath: s.db, confirm: true, now: () => NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(readdirSync(s.dir).filter((f) => f.includes('visszaallitas'))).toEqual([]);

    // The database file overwritten with garbage (what a hand copy over a running program can leave).
    writeFileSync(s.db, 'sérült '.repeat(2000));
    const r = restoreDatabase({ dbPath: s.db, backupPath: s.backup, confirm: true, now: () => NOW });
    expect(r.restored).toBe(true);
    expect(r.plan.current).toBeNull();
    expect(r.plan.currentProblem).toMatch(/nem SQLite-adatbázis|sérült/);
    expect(existsSync(r.asidePath as string)).toBe(true);
    const app = open(s.dir);
    expect(app.findInvoices({ status: ['issued'] }).total).toBe(2);
    expect(app.verifyIntegrity().ok).toBe(true);
  });
});
