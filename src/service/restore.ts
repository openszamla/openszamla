/**
 * Restoring a backup (`openszamla restore <file>`): the backup replaces the database file, and the replaced database
 * is kept beside it – never deleted.
 *
 * Why a command and not a file copy: a database in use consists of three files (the database, its write-ahead log
 * "-wal" and the index "-shm"). Copying a backup over the database file while a server has it open, or beside a
 * write-ahead log left from the old database, mixes two databases – SQLite then reports "database disk image is
 * malformed". The restore
 *  1. works on a copy of the backup (the backup file itself is never opened for writing), and refuses a file that is
 *     not an OpenSzámla database, is newer than this program, or fails SQLite's own check;
 *  2. compares it with the database it would replace: which numbered documents the backup does not have;
 *  3. only with `confirm`: refuses while another program has the database open, moves the database (with its log
 *     files) aside, puts the copy in its place, and records the restore in the audit log of the restored database.
 *
 * A backup that is an earlier state of the same database (its last audit entry is in the replaced database's log
 * with the same hash) lost the documents issued since. Their numbers were given out – to the buyers and to NAV –, so
 * the numbering of each series continues after them: issuing the same number again would be a second invoice under
 * one number (and a number collision at NAV). The lost numbers are recorded in the audit entry, so `verify` can tell
 * this gap from numbers that vanished without a trace.
 */
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { AppError, isAppError } from '../core/errors.ts';
import { formatNumber } from '../core/numbering.ts';
import type { Actor, DocumentType, IsoDate, SellerProfile, Series } from '../core/types.ts';
import { Store, probeExclusive } from '../db/store.ts';
import { ensureDataDir } from './config.ts';

/** The audit action of a restore; its details: RestoreRecord. */
export const RESTORE_AUDIT_ACTION = 'database.restore';
/** At most this many lost documents are listed in the audit entry (the replaced database holds them all). */
const MAX_RECORDED_LOST = 5000;

export interface DatabaseSummary {
  seller: { name: string; taxNumber: string } | null;
  /** Numbered documents (issued or cancelled). */
  issued: number;
  drafts: number;
  customers: number;
  products: number;
  /** The document issued last. */
  lastIssued: { number: string; issueDate: IsoDate } | null;
  auditHead: { id: number; hash: string } | null;
}

export interface LostDocument {
  number: string;
  documentType: DocumentType;
  issueDate: IsoDate;
  /** Series and sequence number, as logged at issue (absent for issuances logged without them). */
  seriesId?: string;
  seq?: number;
  year?: number;
}

export interface ContinuedSeries {
  seriesId: string;
  name: string;
  /** The next number as the backup has it, and as it is after the restore. */
  from: string;
  to: string;
  nextSeq: number;
  seqYear: number | null;
}

export interface RestorePlan {
  backupPath: string;
  dbPath: string;
  backup: DatabaseSummary;
  /** The database the backup replaces; null: there is none yet, or it cannot be read (`currentProblem`). */
  current: DatabaseSummary | null;
  /** Why the database to replace cannot be read (damaged): it is set aside without a comparison. */
  currentProblem: string | null;
  /** The backup is an earlier state of the database it replaces (null: nothing to compare with). */
  earlierState: boolean | null;
  /** Numbered documents of the database to replace that the backup does not have. */
  lost: LostDocument[];
  /** Numbers both have, with different content: two different documents under one number. */
  conflicting: string[];
  /** Series whose numbering continues after the lost numbers (only for an earlier state). */
  continued: ContinuedSeries[];
  /** Series with lost documents that the backup does not have at all: "name (pattern), next number". */
  missingSeries: Array<{ name: string; pattern: string; next: string }>;
}

export interface RestoreResult {
  plan: RestorePlan;
  restored: boolean;
  /** Where the replaced database was moved (null: there was none, or nothing was restored). */
  asidePath: string | null;
}

/** What the audit entry of a restore records. */
export interface RestoreRecord {
  backupFile: string;
  backupHead: { id: number; hash: string } | null;
  replaced: { file: string; issued: number; auditHead: { id: number; hash: string } | null } | null;
  earlierState: boolean | null;
  lostCount: number;
  lost: LostDocument[];
  conflicting: string[];
  continued: Array<{ seriesId: string; from: string; to: string }>;
}

function summarize(store: Store): DatabaseSummary {
  const seller = store.getSetting<SellerProfile>('seller');
  const numbered = store.listNumberedDocuments();
  const last = numbered.at(-1);
  return {
    seller: seller ? { name: seller.name, taxNumber: seller.taxNumber } : null,
    issued: numbered.length,
    drafts: store.findInvoices({ status: ['draft'], limit: 1, offset: 0 }).total,
    customers: store.findCustomers({ limit: 1, offset: 0 }).total,
    products: store.findProducts({ limit: 1, offset: 0 }).total,
    lastIssued: last ? { number: last.number, issueDate: last.issueDate } : null,
    auditHead: store.auditHead(),
  };
}

function nextNumber(s: Pick<Series, 'pattern' | 'nextSeq' | 'seqYear'>, fallbackYear: number): string {
  try {
    return formatNumber(s.pattern, s.nextSeq, s.seqYear ?? fallbackYear);
  } catch {
    return `${s.nextSeq}.`;
  }
}

function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function removeQuietly(...paths: string[]): void {
  for (const p of paths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // a leftover temporary copy does no harm
    }
  }
}

function sameFile(a: string, b: string): boolean {
  if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) return true;
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

const IN_USE_HINT =
  'Állítsd le a webes felületet (az `openszamla serve` ablakában Ctrl+C), és lépj ki teljesen az AI-kliensekből, amelyek az OpenSzámlát használják ' +
  '(Claude Desktop: a tálcaikonról is; Claude Code, Codex, Cursor, VS Code: zárd be) – ezek a háttérben nyitva tartják az adatbázist. Utána futtasd újra a parancsot.';

function inUse(dbPath: string, cause?: unknown): AppError {
  return new AppError('DB_IN_USE', `Az adatbázist most egy másik program is használja, ezért nem cserélhető le: ${dbPath}`, { hint: IN_USE_HINT, ...(cause !== undefined ? { cause } : {}) });
}

function fsCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

/**
 * Plans (and with `confirm` carries out) the restore of `backupPath` over the database `dbPath`. Without `confirm`
 * nothing is changed: the plan says what the restore would do.
 */
export function restoreDatabase(opts: { dbPath: string; backupPath: string; confirm: boolean; now?: () => Date; actor?: Actor }): RestoreResult {
  const now = opts.now ?? (() => new Date());
  const dbPath = resolve(opts.dbPath);
  const backupPath = resolve(opts.backupPath);
  if (opts.dbPath === ':memory:') throw new AppError('INVALID_INPUT', 'Memóriában tartott adatbázisba nem lehet mentést visszaállítani.');
  let size: number;
  try {
    const st = statSync(backupPath);
    if (!st.isFile()) throw new AppError('BACKUP_NOT_FOUND', `A megadott mentés nem fájl: ${backupPath}`, { hint: 'A mentésfájl (az `openszamla backup <fájl>` eredménye) útvonalát add meg.' });
    size = st.size;
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError('BACKUP_NOT_FOUND', `A mentésfájl nem található: ${backupPath}`, { hint: 'Ellenőrizd az útvonalat; a szóközt tartalmazó útvonalat tedd idézőjelek közé.', cause: e });
  }
  if (size === 0) throw new AppError('BACKUP_UNUSABLE', `A mentésfájl üres: ${backupPath}`, { hint: 'Válassz egy másik (korábbi) mentést.' });
  if (sameFile(backupPath, dbPath)) {
    throw new AppError('INVALID_INPUT', `A megadott fájl maga a használatban lévő adatbázis: ${dbPath}`, { hint: 'A visszaállítandó mentésfájlt add meg (az `openszamla backup <fájl>` eredményét).' });
  }
  ensureDataDir(dirname(dbPath), 'Az adatbázis mappája');

  // 1. A working copy next to the database (same volume: putting it in place is one rename).
  const id = stamp(now());
  const tmp = `${dbPath}.visszaallitas-${id}.tmp`;
  const cleanup = (): void => removeQuietly(tmp, `${tmp}-wal`, `${tmp}-shm`);
  cleanup();
  try {
    copyFileSync(backupPath, tmp);
    // A backup copied by hand from a running program may have its write-ahead log beside it: it belongs to the file.
    if (existsSync(`${backupPath}-wal`)) copyFileSync(`${backupPath}-wal`, `${tmp}-wal`);
  } catch (e) {
    cleanup();
    throw new AppError('RESTORE_FAILED', `A mentésfájl nem másolható az adatbázis mellé: ${fsCode(e) ?? (e instanceof Error ? e.message : String(e))}`, {
      hint: 'Ellenőrizd, hogy a mentésfájl olvasható, és az adatkönyvtárban van elég szabad hely.',
      cause: e,
    });
  }

  let plan: RestorePlan;
  try {
    // 2. The copy as a database: schema checks and pending migrations (Store), then SQLite's own check.
    let backupStore: Store;
    try {
      backupStore = new Store({ path: tmp, now });
    } catch (e) {
      const why = isAppError(e) ? e.message : e instanceof Error ? e.message : String(e);
      throw new AppError('BACKUP_UNUSABLE', `A mentésfájl nem használható: ${why}`, {
        hint: isAppError(e) && e.code === 'SCHEMA_TOO_NEW' ? (e.hint ?? '') : 'Az `openszamla backup <fájl>` paranccsal készült mentést adj meg; ha ez az, a fájl megsérült – válassz egy másik mentést.',
        cause: e,
      });
    }
    let backup: DatabaseSummary;
    let backupDocs: ReturnType<Store['listNumberedDocuments']>;
    let backupSeries: Series[];
    try {
      const problems = backupStore.fileProblems();
      if (problems.length > 0) {
        throw new AppError('BACKUP_UNUSABLE', `A mentésfájl sérült (az SQLite ellenőrzése szerint): ${problems.slice(0, 3).join('; ')}`, { hint: 'Válassz egy másik (korábbi) mentést.' });
      }
      backup = summarize(backupStore);
      backupDocs = backupStore.listNumberedDocuments();
      backupSeries = backupStore.listSeries(undefined, true);
    } finally {
      backupStore.close();
    }

    // 3. The database it replaces.
    let current: DatabaseSummary | null = null;
    let currentProblem: string | null = null;
    let earlierState: boolean | null = null;
    const lost: LostDocument[] = [];
    const conflicting: string[] = [];
    const continued: ContinuedSeries[] = [];
    const missingSeries: RestorePlan['missingSeries'] = [];
    if (existsSync(dbPath)) {
      let cur: Store | null = null;
      try {
        cur = new Store({ path: dbPath, now });
        current = summarize(cur);
        const head = backup.auditHead;
        earlierState = head !== null && cur.auditHashAt(head.id) === head.hash;
        const inBackup = new Map(backupDocs.map((d) => [d.number, d.contentHash]));
        // Series and sequence number of each issuance, as logged.
        const logged = new Map<string, { seriesId: string; seq: number; year: number }>();
        for (const e of cur.listAuditByAction('invoice.issue')) {
          const { number, seriesId, seq, year } = e.details;
          if (typeof number === 'string' && typeof seriesId === 'string' && typeof seq === 'number' && typeof year === 'number') logged.set(number, { seriesId, seq, year });
        }
        for (const d of cur.listNumberedDocuments()) {
          if (!inBackup.has(d.number)) lost.push({ number: d.number, documentType: d.documentType, issueDate: d.issueDate, ...(logged.get(d.number) ?? { seriesId: d.seriesId }) });
          else if (inBackup.get(d.number) !== d.contentHash) conflicting.push(d.number);
        }
        const year = now().getFullYear();
        const curSeries = cur.listSeries(undefined, true);
        if (earlierState) {
          for (const c of curSeries) {
            const b = backupSeries.find((s) => s.id === c.id);
            if (!b || b.pattern !== c.pattern) continue;
            const ahead = (c.seqYear ?? -1) > (b.seqYear ?? -1) || ((c.seqYear ?? -1) === (b.seqYear ?? -1) && c.nextSeq > b.nextSeq);
            if (ahead) continued.push({ seriesId: c.id, name: b.name, from: nextNumber(b, year), to: nextNumber(c, year), nextSeq: c.nextSeq, seqYear: c.seqYear });
          }
        }
        for (const c of curSeries) {
          if (backupSeries.some((s) => s.id === c.id && s.pattern === c.pattern)) continue;
          if (lost.some((l) => l.seriesId === c.id)) missingSeries.push({ name: c.name, pattern: c.pattern, next: nextNumber(c, year) });
        }
      } catch (e) {
        current = null;
        earlierState = null;
        lost.length = 0;
        conflicting.length = 0;
        continued.length = 0;
        missingSeries.length = 0;
        currentProblem = isAppError(e) ? e.message : e instanceof Error ? e.message : String(e);
      } finally {
        cur?.close();
      }
    }
    plan = { backupPath, dbPath, backup, current, currentProblem, earlierState, lost, conflicting, continued, missingSeries };
  } catch (e) {
    cleanup();
    throw e;
  }
  if (!opts.confirm) {
    cleanup();
    return { plan, restored: false, asidePath: null };
  }

  // 4. Nobody else may have the database open; its write-ahead log is folded in, so the file is the whole database.
  let asidePath: string | null = null;
  const moved: Array<[string, string]> = [];
  const putBack = (): void => {
    for (const [from, to] of [...moved].reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // reported by the error that follows
      }
    }
  };
  try {
    // The copy was opened above: after its only connection closed, the copy is one file again.
    if (existsSync(`${tmp}-wal`) || existsSync(`${tmp}-shm`)) probeExclusive(tmp);
    if (existsSync(`${tmp}-wal`) || existsSync(`${tmp}-shm`)) removeQuietly(`${tmp}-shm`);
    if (existsSync(`${tmp}-wal`)) {
      throw new AppError('RESTORE_FAILED', 'A mentés másolatát nem sikerült egyetlen fájllá zárni.', { hint: 'Próbáld újra; ha ismétlődik, ellenőrizd, hogy víruskereső vagy szinkronizáló program nem fogja-e az adatkönyvtár fájljait.' });
    }
    if (existsSync(dbPath)) {
      if (probeExclusive(dbPath) === 'in-use') throw inUse(dbPath);
      let aside = `${dbPath}.visszaallitas-elott-${id}`;
      for (let n = 2; existsSync(aside); n++) aside = `${dbPath}.visszaallitas-elott-${id}-${n}`;
      for (const suffix of ['', '-wal', '-shm']) {
        if (!existsSync(dbPath + suffix)) continue;
        try {
          renameSync(dbPath + suffix, aside + suffix);
          moved.push([dbPath + suffix, aside + suffix]);
        } catch (e) {
          const code = fsCode(e);
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw inUse(dbPath, e);
          throw new AppError('RESTORE_FAILED', `A jelenlegi adatbázis nem tehető félre (${code ?? 'ismeretlen hiba'}): ${dbPath + suffix}`, { hint: 'Ellenőrizd az adatkönyvtár írási jogait.', cause: e });
        }
      }
      asidePath = aside;
    }
    // A log file left beside the database's name would be replayed into the restored file: none may remain.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) throw new AppError('RESTORE_FAILED', `A régi adatbázis naplófájlja a helyén maradt: ${dbPath + suffix}`, { hint: IN_USE_HINT });
    }
    try {
      renameSync(tmp, dbPath);
    } catch (e) {
      throw new AppError('RESTORE_FAILED', `A mentés nem tehető az adatbázis helyére (${fsCode(e) ?? 'ismeretlen hiba'}).`, { hint: 'A korábbi adatbázist visszatettem a helyére; ellenőrizd az adatkönyvtár írási jogait.', cause: e });
    }
  } catch (e) {
    putBack();
    cleanup();
    throw e;
  }

  // 5. The restored database: numbering continues after the lost numbers, and the restore is on record.
  const store = new Store({ path: dbPath, now });
  try {
    store.tx(() => {
      const applied: RestoreRecord['continued'] = [];
      for (const c of plan.continued) {
        if (store.raiseSequence(c.seriesId, c.nextSeq, c.seqYear)) applied.push({ seriesId: c.seriesId, from: c.from, to: c.to });
      }
      const record: RestoreRecord = {
        backupFile: basename(backupPath),
        backupHead: plan.backup.auditHead,
        replaced: plan.current && asidePath ? { file: basename(asidePath), issued: plan.current.issued, auditHead: plan.current.auditHead } : asidePath ? { file: basename(asidePath), issued: 0, auditHead: null } : null,
        earlierState: plan.earlierState,
        lostCount: plan.lost.length,
        lost: plan.lost.slice(0, MAX_RECORDED_LOST),
        conflicting: plan.conflicting.slice(0, MAX_RECORDED_LOST),
        continued: applied,
      };
      store.audit({ actor: opts.actor ?? 'cli', action: RESTORE_AUDIT_ACTION, entityType: 'settings', entityId: null, details: record as unknown as Record<string, unknown> });
    });
  } finally {
    store.close();
  }
  return { plan, restored: true, asidePath };
}

/** The lost documents every restore of this database recorded (verify: numbers missing for a known reason). */
export function recordedRestores(store: Store): Array<{ id: number; at: string; record: RestoreRecord }> {
  return store.listAuditByAction(RESTORE_AUDIT_ACTION).map((e) => ({ id: e.id, at: e.at, record: e.details as unknown as RestoreRecord }));
}
