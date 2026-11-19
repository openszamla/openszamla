/**
 * Persistence layer (SQLite via the built-in `node:sqlite` module – no native dependencies).
 *
 * CONTRACT FILE – the implementation must keep these signatures. Design rules:
 * - One database file per company (seller). ':memory:' is allowed (tests).
 * - PRAGMAs on open: journal_mode=WAL (file DBs only), foreign_keys=ON, busy_timeout=5000.
 * - Schema lives in ./schema.ts as numbered migrations; `meta.schema_version` tracks the applied one.
 * - Complex objects are stored as JSON TEXT columns; columns used for filtering/sorting are duplicated
 *   as plain columns. Decimal values are stored as canonical decimal strings (never REAL).
 * - Issued invoices are IMMUTABLE. This is enforced by SQLite TRIGGERS (not only by code):
 *   UPDATE of any immutable column or DELETE of a non-draft invoice raises "IMMUTABLE_INVOICE: …".
 *   Only the "mutable after issuance" fields of `Invoice` may change, and status may only go
 *   draft → issued (via markIssued) or issued → cancelled.
 * - The audit log is append-only (triggers forbid UPDATE/DELETE) and hash-chained:
 *   hash = sha256_hex(prevHash + "\n" + canonicalJson({at, actor, action, entityType, entityId, details})),
 *   prevHash of the first entry is 64 × "0".
 * - The kept original PDF of an issued document (invoice_documents) is append-only too: one per document,
 *   never for a draft or a document issued before the table existed, never changed or removed.
 * - The payment ledger (payments, payment_allocations) is append-only: rows only for issued documents, never
 *   changed or removed; a redistribution is recorded as new allocation rows.
 * - Every method throws AppError (../core/errors.ts) with a meaningful code on failure;
 *   SQLite trigger violations are mapped to AppError('IMMUTABLE_INVOICE', …).
 *
 * Implementation notes:
 * - Objects passed to insert/update methods are persisted as given (including their createdAt /
 *   updatedAt). The store generates timestamps (opts.now) only for data it creates itself:
 *   settings, audit entries, NAV submissions, exchange-rate cache rows and patchInvoice's updatedAt.
 * - Invoices: the `doc` column holds the immutable part of the Invoice (everything except status,
 *   paymentStatus, paidAmount, paidDate, navStatus, navTransactionId, navMessages, navEnvironment,
 *   cancelledById, updatedAt), which live in their own columns.
 * - tx() uses BEGIN IMMEDIATE at the outermost level; nested calls join that transaction through a
 *   SAVEPOINT, so a failing inner call is undone as a whole even if the outer code catches its error.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { canonicalJson, fileFingerprints, searchKey, sha256Hex } from '../core/canonical.ts';
import { assertIsoDate, yearOf } from '../core/dates.ts';
import { dec, normDec, toDec, type DecValue } from '../core/decimal.ts';
import { AppError, isAppError, notFound } from '../core/errors.ts';
import type {
  AuditEntry,
  Customer,
  DocumentType,
  Invoice,
  InvoiceStatus,
  IsoDate,
  IsoTimestamp,
  NavMessage,
  NavStatus,
  Page,
  Payment,
  PaymentAllocation,
  PaymentSource,
  PaymentStatus,
  Product,
  Series,
  SeriesKind,
} from '../core/types.ts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.ts';

export interface StoreOptions {
  /** File path or ':memory:'. Parent directory must exist. */
  path: string;
  /** Clock for timestamps (tests). Defaults to () => new Date(). */
  now?: () => Date;
}

export interface CustomerQuery {
  /** Case-insensitive substring match on name, tax number, EU VAT number, email, city. */
  text?: string;
  /** Exact match on the 8-digit törzsszám part of the tax number (any format accepted). */
  taxNumber?: string;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

export interface ProductQuery {
  /** Case-insensitive substring match on name, sku, description. */
  text?: string;
  includeArchived?: boolean;
  limit: number;
  offset: number;
}

export interface InvoiceFilter {
  status?: InvoiceStatus[];
  documentType?: DocumentType[];
  customerId?: string;
  /** Case-insensitive substring match on number, customer name, comment, order number. */
  text?: string;
  issueDateFrom?: IsoDate;
  issueDateTo?: IsoDate;
  /** Fulfilment date (teljesítés dátuma) range, inclusive. */
  fulfillmentDateFrom?: IsoDate;
  fulfillmentDateTo?: IsoDate;
  paymentStatus?: PaymentStatus[];
  navStatus?: NavStatus[];
  /**
   * Only documents something is owed on (receivables): issued, not cancelled invoices, advance, final
   * and modification invoices with a positive total that do not correct a cancelled invoice. Not
   * drafts, díjbekérők, stornos, crediting modifications or 0 Ft documents.
   */
  receivable?: boolean;
  /**
   * Only receivables (see `receivable`) not fully paid whose dueDate is before this date. Documents
   * with a zero or negative total (stornos, crediting modifications) are never overdue: nothing is
   * owed on them; nor are díjbekérők (not invoices).
   */
  overdueOn?: IsoDate;
  /** Only invoices referencing this original invoice (its modifications/stornos). */
  originalInvoiceId?: string;
  /**
   * Only documents whose NAV state matches at least one of these selectors – selected in SQL, so a limit
   * applies to the matching documents only (the nav_sync work queue, the counts of status().nextSteps).
   */
  navSelect?: readonly NavSelector[];
  /** Only documents whose ORIGINAL invoice (modifications/stornos) has a NAV state matching one of these. */
  originalNavSelect?: readonly NavSelector[];
  /** Only invoices with an issued modification/storno in one of these NAV statuses. */
  correctionNavStatus?: readonly NavStatus[];
  sort?: 'issued_desc' | 'issued_asc' | 'created_desc';
  limit: number;
  offset: number;
}

/** A NAV state for InvoiceFilter.navSelect: one of the statuses, with / without messages of the given codes. */
export interface NavSelector {
  navStatus: readonly NavStatus[];
  /** …with a NAV message of each of these codes, */
  withMessageCode?: readonly string[];
  /** …and with no NAV message of any of these codes. */
  withoutMessageCode?: readonly string[];
  /** …whose NAV state belongs to this NAV environment or to none yet (Invoice.navEnvironment), */
  environment?: 'test' | 'production';
  /** …whose NAV state belongs to a NAV environment other than this one. */
  otherEnvironment?: 'test' | 'production';
}

/** Fields of an issued invoice that may still change. */
export interface InvoiceMutablePatch {
  status?: 'cancelled';
  paymentStatus?: PaymentStatus;
  paidAmount?: string;
  paidDate?: IsoDate | null;
  navStatus?: NavStatus;
  navTransactionId?: string | null;
  navMessages?: NavMessage[];
  /** The NAV environment the NAV state belongs to; null: none. */
  navEnvironment?: 'test' | 'production' | null;
  cancelledById?: string | null;
}

export type NavOperation = 'CREATE' | 'MODIFY' | 'STORNO';

export interface NavSubmissionRecord {
  id: number;
  invoiceId: string;
  operation: NavOperation;
  environment: 'test' | 'production';
  /** NAV requestId of the call; may be '' when it is not known when the attempt is recorded. */
  requestId: string;
  transactionId: string | null;
  /** Result status of this attempt. */
  status: 'sending' | 'sent' | 'processing' | 'done' | 'done_with_warnings' | 'aborted' | 'error';
  /** Base64 invoiceData that was (or was to be) sent. */
  invoiceDataBase64: string;
  messages: NavMessage[];
  /** Raw (secret-free) response XML of the last call, for troubleshooting. */
  lastResponseXml: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** The kept original PDF of an issued document (invoice_documents): exactly the bytes handed over. */
export interface StoredDocument {
  id: number;
  invoiceId: string;
  kind: 'original';
  /** Uppercase hex SHA-256 and SHA3-512 of `content`, as stored with it. */
  sha256: string;
  sha3_512: string;
  /** Size of `content` in bytes, as stored with it. */
  size: number;
  content: Buffer;
  /** Name and version of the program that rendered it, e.g. "OpenSzámla 0.1.0". */
  software: string;
  createdAt: IsoTimestamp;
}

export interface CachedRate {
  currency: string;
  /** The date the rate is valid for (the MNB publication date actually used). */
  date: IsoDate;
  /** HUF per `unit` units of currency, as published. */
  rate: string;
  unit: number;
  source: 'MNB';
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'>;

// ---------------------------------------------------------------------------------------------
// Internal constants and helpers
// ---------------------------------------------------------------------------------------------

type Row = Record<string, SQLOutputValue>;

const ZERO_HASH = '0'.repeat(64);

const IMMUTABLE_HINT = 'A kiállított számla nem módosítható; használj sztornó vagy módosító számlát.';
const DUPLICATE_NUMBER_HINT =
  'A számlaszámnak egyedinek kell lennie. Ellenőrizd a számlatömb mintáját és következő sorszámát, majd próbáld újra.';

/** Invoice fields that may change after issuance – they live in plain columns, not in `doc`. */
const MUTABLE_INVOICE_FIELDS = [
  'status',
  'paymentStatus',
  'paidAmount',
  'paidDate',
  'navStatus',
  'navTransactionId',
  'navMessages',
  'navEnvironment',
  'cancelledById',
  'updatedAt',
] as const;
type MutableInvoiceField = (typeof MUTABLE_INVOICE_FIELDS)[number];
/** The immutable part of an invoice, stored as canonical JSON in `invoices.doc`. */
type InvoiceDoc = Omit<Invoice, MutableInvoiceField>;

const PATCHABLE_INVOICE_KEYS: ReadonlySet<string> = new Set([
  'status',
  'paymentStatus',
  'paidAmount',
  'paidDate',
  'navStatus',
  'navTransactionId',
  'navMessages',
  'navEnvironment',
  'cancelledById',
]);

const INVOICE_COLUMNS = [
  'id',
  'number',
  'series_id',
  'document_type',
  'status',
  'issue_date',
  'fulfillment_date',
  'due_date',
  'customer_id',
  'customer_name',
  'currency',
  'gross_amount',
  'gross_amount_huf',
  'original_invoice_id',
  'search_text',
  'doc',
  'content_hash',
  'payment_status',
  'paid_amount',
  'paid_date',
  'nav_status',
  'nav_transaction_id',
  'nav_messages',
  'cancelled_by_id',
  'created_at',
  'updated_at',
  'issued_at',
  'nav_environment',
] as const;
type InvoiceColumn = (typeof INVOICE_COLUMNS)[number];
const INVOICE_REWRITE_COLUMNS: readonly InvoiceColumn[] = INVOICE_COLUMNS.filter((c) => c !== 'id');

const SQL_INSERT_INVOICE = `INSERT INTO invoices (${INVOICE_COLUMNS.join(', ')}) VALUES (${INVOICE_COLUMNS.map(() => '?').join(', ')})`;
const SQL_REWRITE_DRAFT = `UPDATE invoices SET ${INVOICE_REWRITE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = 'draft'`;

const INVOICE_SORTS: Readonly<Record<NonNullable<InvoiceFilter['sort']>, string>> = {
  issued_desc: 'issue_date DESC, issued_at DESC, created_at DESC, number DESC, id DESC',
  issued_asc: 'issue_date ASC, issued_at ASC, created_at ASC, number ASC, id ASC',
  created_desc: 'created_at DESC, id DESC',
};

/**
 * InvoiceFilter.receivable: an issued (not cancelled) invoice-type document with a positive total that
 * does not correct a cancelled invoice (its storno negated the correction together with the original).
 */
const RECEIVABLE_SQL =
  `status = 'issued' AND document_type IN ('invoice', 'advance', 'final', 'modification')` +
  ` AND gross_amount <> '0' AND gross_amount NOT LIKE '-%'` +
  ` AND NOT EXISTS (SELECT 1 FROM invoices AS o WHERE o.id = invoices.original_invoice_id AND o.status = 'cancelled')`;

/** SQL of InvoiceFilter.navSelect on the invoices row `alias`: any of the selectors (none → nothing matches). */
function navSelectSql(alias: string, selectors: readonly NavSelector[], params: SQLInputValue[]): string {
  const code = (codes: readonly string[]): string => {
    params.push(...codes);
    return `EXISTS (SELECT 1 FROM json_each(${alias}.nav_messages) WHERE json_extract(value, '$.code') IN (${codes.map(() => '?').join(', ')}))`;
  };
  const any = selectors.map((s) => {
    const statuses = [...new Set(s.navStatus)];
    if (statuses.length === 0) return '0';
    params.push(...statuses);
    const parts = [`${alias}.nav_status IN (${statuses.map(() => '?').join(', ')})`];
    for (const c of new Set(s.withMessageCode ?? [])) parts.push(code([c]));
    const without = [...new Set(s.withoutMessageCode ?? [])];
    if (without.length > 0) parts.push(`NOT ${code(without)}`);
    if (s.environment !== undefined) {
      parts.push(`(${alias}.nav_environment IS NULL OR ${alias}.nav_environment = ?)`);
      params.push(s.environment);
    }
    if (s.otherEnvironment !== undefined) {
      parts.push(`(${alias}.nav_environment IS NOT NULL AND ${alias}.nav_environment <> ?)`);
      params.push(s.otherEnvironment);
    }
    return `(${parts.join(' AND ')})`;
  });
  return any.length > 0 ? `(${any.join(' OR ')})` : '0';
}

/** Hungarian tax number in any common notation → groups; törzsszám is group 1. */
const HU_TAX_NUMBER_RE = /^(?:HU)?(\d{8})(?:-?\d(?:-?\d{2})?)?$/i;

const MAX_CACHED_STATEMENTS = 256;

function corrupt(column: string): AppError {
  return new AppError('DB_CORRUPT', `Váratlan érték az adatbázisban (${column}).`, {
    hint: 'Az adatbázis sérült lehet; állítsd vissza a legutóbbi mentésből.',
  });
}

function str(row: Row, col: string): string {
  const v = row[col];
  if (typeof v !== 'string') throw corrupt(col);
  return v;
}

function strOrNull(row: Row, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw corrupt(col);
  return v;
}

function int(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  throw corrupt(col);
}

function intOrNull(row: Row, col: string): number | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  return int(row, col);
}

function bool(row: Row, col: string): boolean {
  return int(row, col) !== 0;
}

function json<T>(row: Row, col: string): T {
  const text = str(row, col);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw corrupt(col);
  }
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('INVALID_ARGUMENT', `Hiányzó vagy üres mező: ${field}.`, {
      hint: `Add meg a(z) "${field}" mező értékét.`,
    });
  }
  return value;
}

function optionalDate(value: IsoDate | null | undefined, field: string): IsoDate | null {
  return value === null || value === undefined ? null : assertIsoDate(value, field);
}

function checkPage(limit: number, offset: number): void {
  // Safe integers only: larger values cannot be bound to LIMIT/OFFSET as SQLite integers.
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError('INVALID_PAGINATION', `Érvénytelen lapozási paraméterek: limit=${limit}, offset=${offset}.`, {
      hint: 'A limit és az offset nemnegatív egész szám legyen (pl. limit: 20, offset: 0).',
    });
  }
}

function alreadyExists(entity: string, id: string): AppError {
  return new AppError('ALREADY_EXISTS', `${entity} már létezik ezzel az azonosítóval: ${id}`, {
    hint: 'Új rekordhoz új azonosítót használj; meglévő rekordot a módosító művelettel frissíts.',
  });
}

function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'piszkozat';
    case 'issued':
      return 'kiállított';
    case 'cancelled':
      return 'sztornózott';
    default:
      return status;
  }
}

function notADraft(id: string, status: string): AppError {
  return new AppError('NOT_A_DRAFT', `A(z) ${id} számla már nem piszkozat (állapota: ${statusLabel(status)}).`, {
    hint: IMMUTABLE_HINT,
    details: { invoiceId: id, status },
  });
}

/** Whitespace-normalised, accent-free, lower-case search text; fields are separated by "\n". */
function buildSearchText(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => searchKey(p.replace(/\s+/g, ' ').trim()))
    .filter((p) => p !== '')
    .join('\n');
}

/** The longest search text (after normalising) a query may carry. */
const MAX_SEARCH_TEXT = 200;

/** LIKE pattern ("contains") for a user query, with the wildcards of the query escaped (ESCAPE '!'). */
function containsPattern(text: string): string {
  const key = searchKey(text.replace(/\s+/g, ' ').trim());
  // A whole document pasted into the search box: SQLite would answer "LIKE or GLOB pattern too complex".
  if (key.length > MAX_SEARCH_TEXT) {
    throw new AppError('INVALID_INPUT', `A keresőszöveg túl hosszú (${key.length} karakter); legfeljebb ${MAX_SEARCH_TEXT} karakter lehet.`, {
      hint: 'Keress egy jellemző részletre: név, sorszám, adószám, megjegyzés.',
    });
  }
  return `%${key.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
}

function hasText(text: string | undefined): text is string {
  return typeof text === 'string' && text.trim() !== '';
}

/** 8-digit törzsszám of a Hungarian tax number in any common notation, or null. */
function taxpayerId8(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const m = HU_TAX_NUMBER_RE.exec(input.replace(/[\s.]/g, ''));
  return m?.[1] ?? null;
}

function digitsOnly(input: string | null | undefined): string | null {
  return typeof input === 'string' ? input.replace(/\D/g, '') : null;
}

function normCurrency(currency: string): string {
  return requireText(currency, 'currency').trim().toUpperCase();
}

function rejectAsync(value: unknown): void {
  if (typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function') {
    // Swallow the eventual rejection – the caller gets the synchronous error below instead.
    Promise.resolve(value).catch(() => undefined);
    throw new AppError('TX_ASYNC', 'A tx() csak szinkron függvényt fogad; Promise-t visszaadó függvény a tranzakción kívül futna tovább.', {
      hint: 'Az aszinkron lépéseket (pl. NAV- vagy MNB-hívás) a tranzakció előtt vagy után végezd, az adatbázis-műveleteket await nélkül.',
    });
  }
}

function triggerDetail(message: string): string {
  const i = message.indexOf(': ');
  const detail = (i >= 0 ? message.slice(i + 2) : message).trim();
  return detail.length > 0 ? detail.charAt(0).toUpperCase() + detail.slice(1) : detail;
}

/**
 * Maps any error raised while talking to SQLite to an AppError. AppErrors pass through unchanged;
 * trigger violations become IMMUTABLE_INVOICE / DUPLICATE_INVOICE_NUMBER / AUDIT_APPEND_ONLY /
 * IMMUTABLE_NAV_SUBMISSION, constraint violations get stable codes.
 */
/** What to do about a damaged database file (mapDbError). */
export const DB_DAMAGED_HINT =
  'Jellemző oka: az adatbázisfájlt kézzel másolták vagy cserélték, miközben egy program (a webes felület vagy egy AI-kliens MCP-szervere) használta. ' +
  'Állíts le minden OpenSzámla-folyamatot, és állíts vissza egy ép mentést: openszamla restore <mentésfájl> --confirm (a sérült fájlt a program félreteszi, nem törli).';

export function mapDbError(e: unknown): AppError {
  if (isAppError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes('IMMUTABLE_INVOICE')) {
    return new AppError('IMMUTABLE_INVOICE', `${triggerDetail(message)}.`, { hint: IMMUTABLE_HINT, cause: e });
  }
  if (message.includes('DUPLICATE_INVOICE_NUMBER') || message.includes('UNIQUE constraint failed: invoices.number')) {
    return new AppError('DUPLICATE_INVOICE_NUMBER', 'Ez a számlaszám már foglalt.', { hint: DUPLICATE_NUMBER_HINT, cause: e });
  }
  if (message.includes('AUDIT_APPEND_ONLY')) {
    return new AppError('AUDIT_APPEND_ONLY', `${triggerDetail(message)}.`, {
      hint: 'Az auditnapló csak bővíthető: a bejegyzések nem módosíthatók és nem törölhetők.',
      cause: e,
    });
  }
  if (message.includes('IMMUTABLE_NAV_SUBMISSION')) {
    return new AppError('IMMUTABLE_NAV_SUBMISSION', `${triggerDetail(message)}.`, {
      hint: 'Új beküldési kísérlethez új NAV-beküldési rekordot kell létrehozni.',
      cause: e,
    });
  }
  if (message.includes('IMMUTABLE_PAYMENT')) {
    return new AppError('IMMUTABLE_PAYMENT', `${triggerDetail(message)}.`, {
      hint: 'A rögzített befizetések naplója csak bővíthető: téves befizetést ellentétes előjelű összeggel lehet visszavonni.',
      cause: e,
    });
  }
  if (message.includes('IMMUTABLE_DOCUMENT')) {
    return new AppError('IMMUTABLE_DOCUMENT', `${triggerDetail(message)}.`, {
      hint: 'A kiállított bizonylat PDF-jét a program a kiállításkor egyszer, bájtra pontosan megőrzi; a megőrzött eredeti nem cserélhető, nem módosítható és nem törölhető.',
      cause: e,
    });
  }
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  if (code === 'ERR_SQLITE_ERROR') {
    const errcode = (e as { errcode?: unknown }).errcode;
    const primary = typeof errcode === 'number' ? errcode & 0xff : -1;
    if (primary === 11 || primary === 26) {
      return new AppError('DB_DAMAGED', 'Az adatbázisfájl sérült, vagy nem a hozzá tartozó naplófájlokkal (-wal, -shm) áll együtt.', {
        hint: DB_DAMAGED_HINT,
        cause: e,
      });
    }
    if (primary === 5 || primary === 6) {
      return new AppError('DB_BUSY', 'Az adatbázist egy másik folyamat zárolja.', {
        hint: 'Próbáld újra néhány másodperc múlva (lehet, hogy egy másik OpenSzámla-folyamat éppen ír).',
        cause: e,
      });
    }
    if (message.startsWith('UNIQUE constraint failed')) {
      return new AppError('ALREADY_EXISTS', `Már létezik ilyen rekord (${message.slice('UNIQUE constraint failed: '.length)}).`, {
        hint: 'Új rekordhoz új azonosítót használj; meglévő rekordot a módosító művelettel frissíts.',
        cause: e,
      });
    }
    if (message.startsWith('FOREIGN KEY constraint failed')) {
      return new AppError('INVALID_REFERENCE', 'A hivatkozott rekord nem létezik (vagy a rekordra még más adat hivatkozik).', {
        hint: 'Ellenőrizd a hivatkozott azonosítókat (számlatömb, ügyfél, számla).',
        cause: e,
      });
    }
    if (primary === 19) {
      return new AppError('INVALID_DATA', `Érvénytelen adat: ${message}`, {
        hint: 'Ellenőrizd a mezők értékeit (megengedett értékek, kötelező mezők, típusok).',
        cause: e,
      });
    }
    return new AppError('DB_ERROR', `Adatbázis-hiba: ${message}`, { cause: e });
  }
  if (code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE') {
    return new AppError('INVALID_DATA', `Érvénytelen adat: ${message}`, {
      hint: 'Valamelyik kötelező mező hiányzik vagy rossz típusú.',
      cause: e,
    });
  }
  return new AppError('INTERNAL_ERROR', `Váratlan hiba az adatbázis-műveletben: ${message}`, { cause: e });
}

// --- row mapping ------------------------------------------------------------------------------

function rowToSeries(row: Row): Series {
  return {
    id: str(row, 'id'),
    kind: str(row, 'kind') as SeriesKind,
    name: str(row, 'name'),
    pattern: str(row, 'pattern'),
    yearlyReset: bool(row, 'yearly_reset'),
    nextSeq: int(row, 'next_seq'),
    seqYear: intOrNull(row, 'seq_year'),
    isDefault: bool(row, 'is_default'),
    archived: bool(row, 'archived'),
    createdAt: str(row, 'created_at'),
  };
}

function rowToInvoice(row: Row): Invoice {
  const doc = json<InvoiceDoc>(row, 'doc');
  const navEnvironment = strOrNull(row, 'nav_environment');
  return {
    ...doc,
    status: str(row, 'status') as InvoiceStatus,
    paymentStatus: str(row, 'payment_status') as PaymentStatus,
    paidAmount: str(row, 'paid_amount'),
    paidDate: strOrNull(row, 'paid_date'),
    navStatus: str(row, 'nav_status') as NavStatus,
    navTransactionId: strOrNull(row, 'nav_transaction_id'),
    navMessages: json<NavMessage[]>(row, 'nav_messages'),
    ...(navEnvironment === 'test' || navEnvironment === 'production' ? { navEnvironment } : {}),
    cancelledById: strOrNull(row, 'cancelled_by_id'),
    updatedAt: str(row, 'updated_at'),
  };
}

function rowToNavSubmission(row: Row): NavSubmissionRecord {
  return {
    id: int(row, 'id'),
    invoiceId: str(row, 'invoice_id'),
    operation: str(row, 'operation') as NavOperation,
    environment: str(row, 'environment') as NavSubmissionRecord['environment'],
    requestId: str(row, 'request_id'),
    transactionId: strOrNull(row, 'transaction_id'),
    status: str(row, 'status') as NavSubmissionRecord['status'],
    invoiceDataBase64: str(row, 'invoice_data_base64'),
    messages: json<NavMessage[]>(row, 'messages'),
    lastResponseXml: strOrNull(row, 'last_response_xml'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function rowToDocument(row: Row): StoredDocument {
  const content = row['content'];
  if (!(content instanceof Uint8Array)) throw corrupt('invoice_documents.content');
  return {
    id: int(row, 'id'),
    invoiceId: str(row, 'invoice_id'),
    kind: str(row, 'kind') as StoredDocument['kind'],
    sha256: str(row, 'sha256'),
    sha3_512: str(row, 'sha3_512'),
    size: int(row, 'size'),
    content: Buffer.from(content.buffer, content.byteOffset, content.byteLength),
    software: str(row, 'software'),
    createdAt: str(row, 'created_at'),
  };
}

function rowToPayment(row: Row): Payment {
  return {
    id: int(row, 'id'),
    invoiceId: str(row, 'invoice_id'),
    date: str(row, 'payment_date'),
    amount: str(row, 'amount'),
    source: str(row, 'source') as PaymentSource,
    reference: strOrNull(row, 'reference'),
    auditId: int(row, 'audit_id'),
    createdAt: str(row, 'created_at'),
  };
}

function rowToAllocation(row: Row): PaymentAllocation {
  return { id: int(row, 'id'), paymentId: int(row, 'payment_id'), invoiceId: str(row, 'invoice_id'), amount: str(row, 'amount'), createdAt: str(row, 'created_at') };
}

/** SQL placeholders for an IN list of `n` values. */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function rowToAudit(row: Row): AuditEntry {
  return {
    id: int(row, 'id'),
    at: str(row, 'at'),
    actor: str(row, 'actor') as AuditEntry['actor'],
    action: str(row, 'action'),
    entityType: str(row, 'entity_type') as AuditEntry['entityType'],
    entityId: strOrNull(row, 'entity_id'),
    details: json<Record<string, unknown>>(row, 'details'),
  };
}

// --- value preparation ------------------------------------------------------------------------

function customerValues(c: Customer): SQLInputValue[] {
  return [
    requireText(c.name, 'name'),
    c.vatStatus,
    taxpayerId8(c.taxNumber) ?? taxpayerId8(c.euVatNumber),
    taxpayerId8(c.groupMemberTaxNumber),
    buildSearchText([
      c.name,
      c.taxNumber,
      digitsOnly(c.taxNumber),
      c.groupMemberTaxNumber,
      c.euVatNumber,
      c.thirdStateTaxId,
      c.email,
      c.address?.city,
    ]),
    canonicalJson(c),
    flag(c.archived),
    requireText(c.createdAt, 'createdAt'),
    requireText(c.updatedAt, 'updatedAt'),
  ];
}

function productValues(p: Product): SQLInputValue[] {
  return [
    requireText(p.name, 'name'),
    p.sku ?? null,
    buildSearchText([p.name, p.sku, p.description]),
    // Decimals are stored as canonical decimal strings (and rejected when they are not decimals).
    canonicalJson({ ...p, unitPrice: normDec(p.unitPrice, 'unitPrice') }),
    flag(p.archived),
    requireText(p.createdAt, 'createdAt'),
    requireText(p.updatedAt, 'updatedAt'),
  ];
}

function invoiceValues(inv: Invoice): Record<InvoiceColumn, SQLInputValue> {
  const doc: Record<string, unknown> = { ...inv };
  for (const field of MUTABLE_INVOICE_FIELDS) delete doc[field];
  return {
    id: requireText(inv.id, 'id'),
    number: inv.number ?? null,
    series_id: requireText(inv.seriesId, 'seriesId'),
    document_type: inv.documentType,
    status: inv.status,
    issue_date: assertIsoDate(inv.issueDate, 'issueDate'),
    fulfillment_date: assertIsoDate(inv.fulfillmentDate, 'fulfillmentDate'),
    due_date: optionalDate(inv.dueDate, 'dueDate'),
    customer_id: inv.customerId ?? null,
    customer_name: inv.customer?.name ?? '',
    currency: requireText(inv.currency, 'currency'),
    gross_amount: normDec(inv.totals.grossAmount, 'totals.grossAmount'),
    gross_amount_huf: normDec(inv.totals.grossAmountHuf, 'totals.grossAmountHuf'),
    original_invoice_id: inv.reference?.originalInvoiceId ?? null,
    search_text: buildSearchText([inv.number, inv.customer?.name, inv.comment, inv.orderNumber]),
    doc: canonicalJson(doc),
    content_hash: inv.contentHash ?? null,
    payment_status: inv.paymentStatus,
    paid_amount: normDec(inv.paidAmount, 'paidAmount'),
    paid_date: optionalDate(inv.paidDate, 'paidDate'),
    nav_status: inv.navStatus,
    nav_transaction_id: inv.navTransactionId ?? null,
    nav_messages: JSON.stringify(inv.navMessages ?? []),
    cancelled_by_id: inv.cancelledById ?? null,
    created_at: requireText(inv.createdAt, 'createdAt'),
    updated_at: requireText(inv.updatedAt, 'updatedAt'),
    issued_at: inv.issuedAt ?? null,
    nav_environment: inv.navEnvironment ?? null,
  };
}

interface AuditHashInput {
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
}

function auditHash(prevHash: string, e: AuditHashInput): string {
  const payload = canonicalJson({
    at: e.at,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    details: e.details,
  });
  return sha256Hex(`${prevHash}\n${payload}`);
}

/** How long a statement waits for another connection's lock (PRAGMA busy_timeout). */
const BUSY_TIMEOUT_MS = 5000;

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function isBusyError(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number') return (errcode & 0xff) === 5; // SQLITE_BUSY
  return e instanceof Error && e.message.includes('database is locked');
}

/**
 * Retries `fn` while SQLite reports SQLITE_BUSY, for up to BUSY_TIMEOUT_MS (synchronous sleep with
 * backoff). For statements the busy handler does not cover: switching a new database file to WAL fails
 * at once while another connection is opening the same file.
 */
function retryWhileBusy<T>(fn: () => T): T {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || Date.now() + delay > deadline) throw e;
      Atomics.wait(SLEEP_CELL, 0, 0, delay);
    }
  }
}

/**
 * Whether the database file can be replaced now. In WAL mode every connection keeps a shared lock on the file for as
 * long as it is open – also while it is idle –, so the exclusive lock asked for here is refused (SQLITE_BUSY) while
 * another program (an MCP server, `openszamla serve`) has the database open: 'in-use'. 'free': nobody else has it
 * open; the write-ahead log is folded into the file, so the file alone is the whole database. 'unreadable': not a
 * database, or damaged – it cannot tell. The file must exist (opening would create it).
 */
export function probeExclusive(path: string): 'free' | 'in-use' | 'unreadable' {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    return 'unreadable';
  }
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // not in WAL mode, or nothing to fold in
    }
    return 'free';
  } catch (e) {
    return isBusyError(e) ? 'in-use' : 'unreadable';
  } finally {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * The root of an absolute Windows path, where ':' and '?' belong: C:\, \\server\share\, \\?\C:\,
 * \\?\UNC\server\share\ (or \\.\…); empty for a relative path.
 */
const WINDOWS_ROOT = /^(?:[\\/]{2}[?.][\\/](?:UNC[\\/][^\\/]+[\\/][^\\/]+|[A-Za-z]:)?|[\\/]{2}[^\\/]+[\\/][^\\/]+|[A-Za-z]:)[\\/]?/i;

/**
 * What Windows cannot hold in `path` below its root – a ':' or one of * ? " < > | or a control
 * character –, in Hungarian; null when nothing. A ':' even "works": "mentes 14:30.db" writes an empty
 * file "mentes 14" with the data in an NTFS alternate data stream, which copying, zipping or uploading
 * the file leaves behind.
 */
export function windowsPathProblem(path: string): string | null {
  const bad = /[<>:"|?*\u0000-\u001f]/.exec(path.slice(WINDOWS_ROOT.exec(path)?.[0].length ?? 0))?.[0];
  if (bad === undefined) return null;
  return bad === ':' ? 'kettőspont (:)' : bad < ' ' ? 'vezérlőkarakter' : `„${bad}” jel`;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly path: string;
  private readonly statements = new Map<string, StatementSync>();
  /** Number of active tx() frames (0 = no transaction opened by tx()). */
  private depth = 0;
  /**
   * A read() snapshot is open. Transaction state is tracked here, not read from the connection:
   * DatabaseSync#isTransaction / #isOpen do not exist on Node.js 22.13–22.15.
   */
  private reading = false;
  private closed = false;

  constructor(opts: StoreOptions) {
    this.now = opts.now ?? (() => new Date());
    this.path = opts.path;
    const isMemory = opts.path === ':memory:';
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(opts.path);
    } catch (e) {
      throw new AppError('DB_OPEN_FAILED', `Az adatbázis nem nyitható meg: ${opts.path}`, {
        hint: 'Ellenőrizd, hogy a megadott könyvtár létezik, és van írási jogod hozzá.',
        cause: e,
      });
    }
    this.db = db;
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec('PRAGMA foreign_keys = ON');
      // REPLACE conflict resolution fires DELETE triggers only with recursive_triggers on.
      db.exec('PRAGMA recursive_triggers = ON');
      // Read-only checks first: a foreign or newer database is refused before anything is written to
      // it (switching to WAL would permanently change the file of another program). One snapshot, so
      // a migration committed meanwhile by another process is seen completely or not at all.
      const version = this.read(() => this.checkSchema());
      if (!isMemory) {
        retryWhileBusy(() => db.exec('PRAGMA journal_mode = WAL'));
        db.exec('PRAGMA synchronous = FULL');
      }
      if (version < LATEST_SCHEMA_VERSION) this.migrate();
    } catch (e) {
      this.closed = true;
      try {
        db.close();
      } catch {
        // already closed
      }
      throw this.openError(e);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      // already closed (e.g. through the test-only raw handle)
    }
  }

  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT (ROLLBACK on throw). Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    this.assertOpen();
    if (this.depth > 0) return this.savepoint(fn);
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (e) {
      throw mapDbError(e);
    }
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      rejectAsync(result);
      this.assertOpen(); // close() called inside the callback: the transaction is gone
    } catch (e) {
      this.rollback();
      this.depth = 0;
      throw e;
    }
    try {
      this.db.exec('COMMIT');
    } catch (e) {
      this.rollback();
      throw mapDbError(e);
    } finally {
      this.depth = 0;
    }
    return result;
  }

  /**
   * TEST-ONLY escape hatch: the underlying node:sqlite connection (used by the test suite to prove
   * that the SQLite triggers enforce the invariants on their own). Application code must never use
   * it – it bypasses the validation of this class.
   * @internal
   */
  unsafeRawDatabaseForTests(): DatabaseSync {
    this.assertOpen();
    return this.db;
  }

  // --- settings (arbitrary JSON values by key) ---------------------------------------------
  getSetting<T>(key: string): T | null {
    return this.op(() => {
      const row = this.one('SELECT value FROM settings WHERE key = ?', key);
      return row ? json<T>(row, 'value') : null;
    });
  }

  /** Stores `value` as JSON. `null`/`undefined` remove the setting (getSetting then returns null). */
  setSetting(key: string, value: unknown): void {
    this.op(() => {
      requireText(key, 'key');
      if (value === undefined || value === null) {
        this.exec('DELETE FROM settings WHERE key = ?', key);
        return;
      }
      const text = JSON.stringify(value) as string | undefined;
      if (text === undefined) {
        throw new AppError('INVALID_ARGUMENT', `A(z) "${key}" beállítás értéke nem menthető JSON-ként.`, {
          hint: 'Csak JSON-ként ábrázolható érték (objektum, tömb, szöveg, szám, logikai érték) menthető.',
        });
      }
      this.exec(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        text,
        this.timestamp(),
      );
    });
  }

  // --- customers ---------------------------------------------------------------------------
  insertCustomer(c: Customer): void {
    this.op(() => {
      const id = requireText(c.id, 'id');
      if (this.one('SELECT 1 AS present FROM customers WHERE id = ?', id)) throw alreadyExists('Ügyfél', id);
      this.exec(
        `INSERT INTO customers (name, vat_status, tax_id8, group_member_tax_id8, search_text, data, archived, created_at, updated_at, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...customerValues(c),
        id,
      );
    });
  }

  updateCustomer(c: Customer): void {
    this.op(() => {
      const id = requireText(c.id, 'id');
      const res = this.exec(
        `UPDATE customers SET name = ?, vat_status = ?, tax_id8 = ?, group_member_tax_id8 = ?, search_text = ?, data = ?,
         archived = ?, created_at = ?, updated_at = ? WHERE id = ?`,
        ...customerValues(c),
        id,
      );
      if (res.changes === 0) throw notFound('Ügyfél', id);
    });
  }

  getCustomer(id: string): Customer | null {
    return this.op(() => {
      const row = this.one('SELECT data FROM customers WHERE id = ?', id);
      return row ? json<Customer>(row, 'data') : null;
    });
  }

  findCustomers(q: CustomerQuery): Page<Customer> {
    return this.op(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (!q.includeArchived) where.push('archived = 0');
      if (hasText(q.text)) {
        where.push(`search_text LIKE ? ESCAPE '!'`);
        params.push(containsPattern(q.text));
      }
      if (hasText(q.taxNumber)) {
        const id8 = taxpayerId8(q.taxNumber);
        if (id8 === null) {
          throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen adószám a kereséshez: ${q.taxNumber}`, {
            hint: 'Adj meg 8 jegyű törzsszámot vagy teljes magyar adószámot, pl. 12345676, 12345676-1-23 vagy HU12345676.',
          });
        }
        where.push('(tax_id8 = ? OR group_member_tax_id8 = ?)');
        params.push(id8, id8);
      }
      return this.page('customers', where, params, 'search_text, id', q.limit, q.offset, (row) => json<Customer>(row, 'data'));
    });
  }

  // --- products ----------------------------------------------------------------------------
  insertProduct(p: Product): void {
    this.op(() => {
      const id = requireText(p.id, 'id');
      if (this.one('SELECT 1 AS present FROM products WHERE id = ?', id)) throw alreadyExists('Termék', id);
      this.exec(
        `INSERT INTO products (name, sku, search_text, data, archived, created_at, updated_at, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ...productValues(p),
        id,
      );
    });
  }

  updateProduct(p: Product): void {
    this.op(() => {
      const id = requireText(p.id, 'id');
      const res = this.exec(
        `UPDATE products SET name = ?, sku = ?, search_text = ?, data = ?, archived = ?, created_at = ?, updated_at = ?
         WHERE id = ?`,
        ...productValues(p),
        id,
      );
      if (res.changes === 0) throw notFound('Termék', id);
    });
  }

  getProduct(id: string): Product | null {
    return this.op(() => {
      const row = this.one('SELECT data FROM products WHERE id = ?', id);
      return row ? json<Product>(row, 'data') : null;
    });
  }

  findProducts(q: ProductQuery): Page<Product> {
    return this.op(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (!q.includeArchived) where.push('archived = 0');
      if (hasText(q.text)) {
        where.push(`search_text LIKE ? ESCAPE '!'`);
        params.push(containsPattern(q.text));
      }
      return this.page('products', where, params, 'search_text, id', q.limit, q.offset, (row) => json<Product>(row, 'data'));
    });
  }

  // --- series ------------------------------------------------------------------------------
  insertSeries(s: Series): void {
    this.op(() =>
      this.tx(() => {
        const id = requireText(s.id, 'id');
        if (this.one('SELECT 1 AS present FROM series WHERE id = ?', id)) throw alreadyExists('Számlatömb', id);
        if (s.isDefault) this.exec('UPDATE series SET is_default = 0 WHERE kind = ? AND is_default = 1', s.kind);
        this.exec(
          `INSERT INTO series (id, kind, name, pattern, yearly_reset, next_seq, seq_year, is_default, archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          s.kind,
          requireText(s.name, 'name'),
          requireText(s.pattern, 'pattern'),
          flag(s.yearlyReset),
          s.nextSeq,
          s.seqYear ?? null,
          flag(s.isDefault),
          flag(s.archived),
          requireText(s.createdAt, 'createdAt'),
        );
      }),
    );
  }

  /** Updates name/pattern/yearlyReset/isDefault/archived. Setting isDefault clears it on other series of the same kind. */
  updateSeries(s: Series): void {
    this.op(() =>
      this.tx(() => {
        const row = this.one('SELECT kind FROM series WHERE id = ?', s.id);
        if (!row) throw notFound('Számlatömb', s.id);
        const kind = str(row, 'kind');
        if (s.isDefault) {
          this.exec('UPDATE series SET is_default = 0 WHERE kind = ? AND id <> ? AND is_default = 1', kind, s.id);
        }
        this.exec(
          'UPDATE series SET name = ?, pattern = ?, yearly_reset = ?, is_default = ?, archived = ? WHERE id = ?',
          requireText(s.name, 'name'),
          requireText(s.pattern, 'pattern'),
          flag(s.yearlyReset),
          flag(s.isDefault),
          flag(s.archived),
          s.id,
        );
      }),
    );
  }

  getSeries(id: string): Series | null {
    return this.op(() => {
      const row = this.one('SELECT * FROM series WHERE id = ?', id);
      return row ? rowToSeries(row) : null;
    });
  }

  listSeries(kind?: SeriesKind, includeArchived?: boolean): Series[] {
    return this.op(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (kind !== undefined) {
        where.push('kind = ?');
        params.push(kind);
      }
      if (!includeArchived) where.push('archived = 0');
      const w = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      return this.many(`SELECT * FROM series${w} ORDER BY kind, created_at, id`, ...params).map(rowToSeries);
    });
  }

  getDefaultSeries(kind: SeriesKind): Series | null {
    return this.op(() => {
      const row = this.one('SELECT * FROM series WHERE kind = ? AND is_default = 1 AND archived = 0', kind);
      return row ? rowToSeries(row) : null;
    });
  }

  /**
   * Allocates the next sequence value of a series for an invoice issued on `issueDate` and
   * advances the series. MUST be called inside tx(). With yearlyReset, when the issue year
   * differs from seqYear the sequence restarts at 1. Issuing into a past year after the
   * series moved on is rejected (AppError 'SERIES_YEAR_CLOSED') to keep numbering monotonic.
   */
  allocateSequence(seriesId: string, issueDate: IsoDate): { seq: number; year: number } {
    return this.op(() => {
      if (this.depth === 0) {
        throw new AppError('TX_REQUIRED', 'A sorszám kiosztása (allocateSequence) csak tranzakción belül hívható.', {
          hint: 'Hívd store.tx(() => { … }) blokkban, a számla kiállításával (markIssued) együtt, hogy hiba esetén a sorszám se vesszen el.',
        });
      }
      const year = yearOf(assertIsoDate(issueDate, 'issueDate'));
      const row = this.one('SELECT * FROM series WHERE id = ?', seriesId);
      if (!row) throw notFound('Számlatömb', seriesId);
      const s = rowToSeries(row);
      if (s.seqYear !== null && year < s.seqYear) {
        throw new AppError(
          'SERIES_YEAR_CLOSED',
          `A(z) "${s.name}" számlatömb sorszámozása már a ${s.seqYear}. évnél tart, ${year}. évi kiállítási dátummal nem adható ki belőle sorszám.`,
          {
            hint: 'A sorszámozásnak időrendinek kell lennie: a kiállítás dátuma nem eshet a tömb legutóbb használt événél korábbi évre. Használd a mai dátumot.',
            details: { seriesId, seqYear: s.seqYear, issueYear: year },
          },
        );
      }
      const restart = s.yearlyReset && s.seqYear !== null && year > s.seqYear;
      const seq = restart ? 1 : s.nextSeq;
      this.exec('UPDATE series SET next_seq = ?, seq_year = ? WHERE id = ?', seq + 1, year, seriesId);
      return { seq, year };
    });
  }

  // --- invoices ----------------------------------------------------------------------------
  /** Inserts a new invoice in status 'draft'. */
  insertDraft(inv: Invoice): void {
    this.op(() =>
      this.tx(() => {
        if (inv.status !== 'draft') {
          throw new AppError('NOT_A_DRAFT', `Új számla csak piszkozat állapotban menthető (kapott állapot: ${statusLabel(inv.status)}).`, {
            hint: 'Mentsd piszkozatként, majd a markIssued művelettel állítsd ki.',
          });
        }
        const v = invoiceValues(inv);
        const id = inv.id;
        if (this.one('SELECT 1 AS present FROM invoices WHERE id = ?', id)) throw alreadyExists('Számla', id);
        if (inv.number !== null && inv.number !== undefined) this.assertNumberFree(inv.number, id);
        this.assertInvoiceReferences(inv);
        this.exec(SQL_INSERT_INVOICE, ...INVOICE_COLUMNS.map((c) => v[c]));
      }),
    );
  }

  /** Replaces a draft completely. Throws AppError('NOT_A_DRAFT') if it is not a draft any more. */
  updateDraft(inv: Invoice): void {
    this.op(() =>
      this.tx(() => {
        const current = this.invoiceStatus(inv.id);
        if (current !== 'draft') throw notADraft(inv.id, current);
        if (inv.status !== 'draft') {
          throw new AppError('NOT_A_DRAFT', `Az updateDraft csak piszkozatot ment (kapott állapot: ${statusLabel(inv.status)}).`, {
            hint: 'A kiállítás a markIssued művelettel történik.',
          });
        }
        const v = invoiceValues(inv);
        if (inv.number !== null && inv.number !== undefined) this.assertNumberFree(inv.number, inv.id);
        this.assertInvoiceReferences(inv);
        this.exec(SQL_REWRITE_DRAFT, ...INVOICE_REWRITE_COLUMNS.map((c) => v[c]), inv.id);
      }),
    );
  }

  /** Deletes a draft. Throws AppError('NOT_A_DRAFT') for issued/cancelled invoices. */
  deleteDraft(id: string): void {
    this.op(() =>
      this.tx(() => {
        const current = this.invoiceStatus(id);
        if (current !== 'draft') throw notADraft(id, current);
        this.exec(`DELETE FROM invoices WHERE id = ? AND status = 'draft'`, id);
      }),
    );
  }

  /**
   * Turns a draft into an issued invoice in ONE update: writes the final document (with number,
   * issuedAt, contentHash, status 'issued'). Throws AppError('NOT_A_DRAFT') if not a draft and
   * AppError('DUPLICATE_INVOICE_NUMBER') if the number already exists.
   */
  markIssued(inv: Invoice): void {
    this.op(() =>
      this.tx(() => {
        const current = this.invoiceStatus(inv.id);
        if (current !== 'draft') throw notADraft(inv.id, current);
        if (inv.status !== 'issued') {
          throw new AppError('INVALID_STATUS', `A markIssued 'issued' állapotú számlát vár (kapott: ${statusLabel(inv.status)}).`, {
            hint: "Állítsd a status mezőt 'issued' értékre, és add meg a sorszámot, az issuedAt időpontot és a contentHash értéket.",
          });
        }
        const number = requireText(inv.number, 'number');
        requireText(inv.issuedAt, 'issuedAt');
        requireText(inv.contentHash, 'contentHash');
        const v = invoiceValues(inv);
        this.assertNumberFree(number, inv.id);
        this.assertInvoiceReferences(inv);
        const res = this.exec(SQL_REWRITE_DRAFT, ...INVOICE_REWRITE_COLUMNS.map((c) => v[c]), inv.id);
        if (res.changes !== 1) throw notADraft(inv.id, this.invoiceStatus(inv.id));
      }),
    );
  }

  /** Updates only the mutable-after-issuance fields (and updatedAt). */
  patchInvoice(id: string, patch: InvoiceMutablePatch): void {
    this.op(() =>
      this.tx(() => {
        for (const key of Object.keys(patch)) {
          if (!PATCHABLE_INVOICE_KEYS.has(key)) {
            throw new AppError('INVALID_PATCH', `Ez a mező a patchInvoice művelettel nem módosítható: ${key}`, {
              hint: 'Kiállítás után csak a fizetési, NAV- és sztornó-adatok változhatnak; piszkozatot az updateDraft művelettel lehet módosítani.',
            });
          }
        }
        const current = this.invoiceStatus(id);
        const sets: string[] = [];
        const params: SQLInputValue[] = [];
        if (patch.status !== undefined) {
          if (patch.status !== 'cancelled' || current === 'draft') {
            throw new AppError(
              'INVALID_STATUS_TRANSITION',
              `A(z) ${id} számla állapota nem változtatható erre: ${String(patch.status)} (jelenlegi állapot: ${statusLabel(current)}).`,
              { hint: 'Csak kiállított számla jelölhető sztornózottnak; a piszkozat törölhető.' },
            );
          }
          sets.push('status = ?');
          params.push(patch.status);
        }
        if (patch.paymentStatus !== undefined) {
          sets.push('payment_status = ?');
          params.push(patch.paymentStatus);
        }
        if (patch.paidAmount !== undefined) {
          sets.push('paid_amount = ?');
          params.push(normDec(patch.paidAmount, 'paidAmount'));
        }
        if (patch.paidDate !== undefined) {
          sets.push('paid_date = ?');
          params.push(optionalDate(patch.paidDate, 'paidDate'));
        }
        if (patch.navStatus !== undefined) {
          sets.push('nav_status = ?');
          params.push(patch.navStatus);
        }
        if (patch.navTransactionId !== undefined) {
          sets.push('nav_transaction_id = ?');
          params.push(patch.navTransactionId);
        }
        if (patch.navMessages !== undefined) {
          sets.push('nav_messages = ?');
          params.push(JSON.stringify(patch.navMessages));
        }
        if (patch.navEnvironment !== undefined) {
          sets.push('nav_environment = ?');
          params.push(patch.navEnvironment);
        }
        if (patch.cancelledById !== undefined) {
          sets.push('cancelled_by_id = ?');
          params.push(patch.cancelledById);
        }
        if (sets.length === 0) return;
        sets.push('updated_at = ?');
        params.push(this.timestamp());
        this.exec(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      }),
    );
  }

  getInvoice(id: string): Invoice | null {
    return this.op(() => {
      const row = this.one('SELECT * FROM invoices WHERE id = ?', id);
      return row ? rowToInvoice(row) : null;
    });
  }

  getInvoiceByNumber(num: string): Invoice | null {
    return this.op(() => {
      const row = this.one('SELECT * FROM invoices WHERE number = ?', num);
      return row ? rowToInvoice(row) : null;
    });
  }

  findInvoices(f: InvoiceFilter): Page<Invoice> {
    return this.op(() => {
      const { where, params, orderBy } = this.invoiceQuery(f);
      return this.page('invoices', where, params, orderBy, f.limit, f.offset, rowToInvoice);
    });
  }

  /**
   * Calls `fn` with every invoice matching `f` (as findInvoices selects them, without paging), in the order of
   * `f.sort` (default issued_desc), one at a time: one statement (StatementSync#iterate) in one read snapshot. A full
   * scan therefore costs one query however many documents match – LIMIT/OFFSET pages would each sort every matching
   * row again – and holds one document at a time. `fn` must not write to the database.
   */
  forEachInvoice(f: Omit<InvoiceFilter, 'limit' | 'offset'>, fn: (inv: Invoice) => void): void {
    // An error of `fn` ends the iteration and reaches the caller as it was thrown (not as a database error).
    let failed = null as { error: unknown } | null;
    this.op(() => {
      const { where, params, orderBy } = this.invoiceQuery(f);
      const w = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      // A statement of its own (not the cache): a nested call of the same query cannot reset this iteration.
      const stmt = this.db.prepare(`SELECT * FROM invoices${w} ORDER BY ${orderBy}`);
      this.read(() => {
        for (const row of stmt.iterate(...params)) {
          const inv = rowToInvoice(row);
          try {
            fn(inv);
          } catch (error) {
            failed = { error };
            return;
          }
        }
      });
    });
    if (failed) throw failed.error;
  }

  /**
   * Issued (and cancelled) documents – no díjbekérő –, issued on or after `issuedFrom`, with a line deducting one of
   * the advance invoices `numbers` (lines[].advanceDeduction.advanceInvoiceNumber, compared without surrounding white
   * space), the first issued first (issued_asc). One statement for all the numbers: a text prefilter on the stored
   * document selects the candidates in SQL, their lines confirm them. The documents deducting none of them are only
   * searched by SQLite (a few µs each), never loaded and parsed – the cost of loading every document since the advance.
   */
  findAdvanceDeductions(numbers: readonly string[], issuedFrom: IsoDate): Invoice[] {
    return this.op(() => {
      const wanted = new Set(numbers.map((n) => n.trim()).filter((n) => n !== ''));
      if (wanted.size === 0) return [];
      // `doc` is canonical JSON: a number appears in it JSON-escaped (without its quotes, so that surrounding spaces
      // still match – the lines below compare it trimmed).
      const params: SQLInputValue[] = [assertIsoDate(issuedFrom, 'issuedFrom'), ...[...wanted].map((n) => JSON.stringify(n).slice(1, -1))];
      const sql =
        `SELECT * FROM invoices WHERE status IN ('issued', 'cancelled') AND document_type IN ('invoice', 'advance', 'final', 'modification', 'storno')` +
        ` AND issue_date >= ? AND instr(doc, '"advanceInvoiceNumber"') > 0 AND (${[...wanted].map(() => 'instr(doc, ?) > 0').join(' OR ')})` +
        ` ORDER BY ${INVOICE_SORTS.issued_asc}`;
      return this.many(sql, ...params)
        .map(rowToInvoice)
        .filter((inv) =>
          inv.lines.some((l) => {
            const n = l.advanceDeduction?.advanceInvoiceNumber;
            return typeof n === 'string' && wanted.has(n.trim());
          }),
        );
    });
  }

  /**
   * Id and number of the issued (or cancelled) documents whose number matches `likePattern` (SQL LIKE:
   * ASCII case-insensitive, "%" any run, "!" escapes), the first issued first (issuedAt, then number) –
   * who owns which per-invoice file name (OpenSzamla file stems).
   */
  findIssuedNumbers(likePattern: string): Array<{ id: string; number: string }> {
    return this.op(() =>
      this.many(`SELECT id, number FROM invoices WHERE status <> 'draft' AND number LIKE ? ESCAPE '!' ORDER BY issued_at, number`, likePattern).map((row) => ({
        id: str(row, 'id'),
        number: str(row, 'number'),
      })),
    );
  }

  /**
   * Issued, not cancelled documents other than díjbekérők converted from the díjbekérő `proformaId`
   * (Invoice.proformaId), the first issued first.
   */
  findConversionsOf(proformaId: string): Invoice[] {
    return this.op(() =>
      this.many(
        `SELECT * FROM invoices WHERE status = 'issued' AND document_type <> 'proforma' AND json_extract(doc, '$.proformaId') = ? ORDER BY issued_at, number`,
        proformaId,
      ).map(rowToInvoice),
    );
  }

  /** 1 + the number of issued modification/storno invoices referencing `originalInvoiceId`. */
  nextModificationIndex(originalInvoiceId: string): number {
    return this.op(() => {
      const row = this.one(
        `SELECT COUNT(*) AS n FROM invoices
         WHERE original_invoice_id = ? AND document_type IN ('modification', 'storno') AND status <> 'draft'`,
        originalInvoiceId,
      );
      return 1 + (row ? int(row, 'n') : 0);
    });
  }

  // --- NAV submissions ---------------------------------------------------------------------
  insertNavSubmission(s: Omit<NavSubmissionRecord, 'id' | 'createdAt' | 'updatedAt'>): number {
    return this.op(() =>
      this.tx(() => {
        if (!this.one('SELECT 1 AS present FROM invoices WHERE id = ?', s.invoiceId)) throw notFound('Számla', s.invoiceId);
        // '' is allowed: the service records the attempt before the NAV client generates the request id.
        if (typeof s.requestId !== 'string') {
          throw new AppError('INVALID_ARGUMENT', 'A requestId mező szöveg legyen.', {
            hint: "Add meg a NAV-kérés azonosítóját, vagy '' értéket, ha még nem ismert.",
          });
        }
        const ts = this.timestamp();
        const res = this.exec(
          `INSERT INTO nav_submissions (invoice_id, operation, environment, request_id, transaction_id, status,
             invoice_data_base64, messages, last_response_xml, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          s.invoiceId,
          s.operation,
          s.environment,
          s.requestId,
          s.transactionId ?? null,
          s.status,
          s.invoiceDataBase64,
          JSON.stringify(s.messages ?? []),
          s.lastResponseXml ?? null,
          ts,
          ts,
        );
        return res.lastInsertRowid;
      }),
    );
  }

  updateNavSubmission(
    id: number,
    patch: Partial<Pick<NavSubmissionRecord, 'transactionId' | 'status' | 'messages' | 'lastResponseXml'>>,
  ): void {
    this.op(() => {
      const sets: string[] = [];
      const params: SQLInputValue[] = [];
      if (patch.transactionId !== undefined) {
        sets.push('transaction_id = ?');
        params.push(patch.transactionId);
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.messages !== undefined) {
        sets.push('messages = ?');
        params.push(JSON.stringify(patch.messages));
      }
      if (patch.lastResponseXml !== undefined) {
        sets.push('last_response_xml = ?');
        params.push(patch.lastResponseXml);
      }
      sets.push('updated_at = ?');
      params.push(this.timestamp());
      const res = this.exec(`UPDATE nav_submissions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      if (res.changes === 0) throw notFound('NAV-beküldés', String(id));
    });
  }

  listNavSubmissions(invoiceId: string): NavSubmissionRecord[] {
    return this.op(() =>
      this.many('SELECT * FROM nav_submissions WHERE invoice_id = ? ORDER BY id', invoiceId).map(rowToNavSubmission),
    );
  }

  /** The submission NAV gave this transactionId, if it is recorded here (the latest one, should there be several). */
  findNavSubmissionByTransactionId(transactionId: string): NavSubmissionRecord | null {
    return this.op(() => {
      const row = this.one('SELECT * FROM nav_submissions WHERE transaction_id = ? ORDER BY id DESC LIMIT 1', transactionId);
      return row ? rowToNavSubmission(row) : null;
    });
  }

  // --- kept original PDFs ------------------------------------------------------------------
  /**
   * Keeps `content` as the original PDF of an issued document, with its fingerprints (computed here) and the
   * program that rendered it. Refused for a draft, for a document issued before originals were kept
   * (isLegacyDocument) and when the document already has one: AppError('IMMUTABLE_DOCUMENT').
   */
  insertDocument(d: { invoiceId: string; content: Uint8Array; software: string }): StoredDocument {
    return this.op(() =>
      this.tx(() => {
        const status = this.invoiceStatus(d.invoiceId);
        if (status === 'draft') {
          throw new AppError('IMMUTABLE_DOCUMENT', `A(z) ${d.invoiceId} piszkozat: eredeti PDF csak kiállított bizonylathoz menthető.`, {
            hint: 'A piszkozat PDF-je tervezet, nem eredeti.',
          });
        }
        if (!(d.content instanceof Uint8Array) || d.content.byteLength === 0) {
          throw new AppError('INVALID_ARGUMENT', 'Az eredeti PDF tartalma üres.', { hint: 'Csak elkészült PDF menthető eredetiként.' });
        }
        if (this.one(`SELECT 1 AS present FROM invoice_documents WHERE invoice_id = ? AND kind = 'original'`, d.invoiceId)) {
          throw new AppError('IMMUTABLE_DOCUMENT', `A(z) ${d.invoiceId} bizonylatnak már van megőrzött eredeti PDF-je; az nem cserélhető.`);
        }
        if (this.one('SELECT 1 AS present FROM invoice_documents_legacy WHERE invoice_id = ?', d.invoiceId)) {
          throw new AppError('IMMUTABLE_DOCUMENT', `A(z) ${d.invoiceId} bizonylat az eredeti PDF-ek megőrzése előtt készült: eredeti PDF utólag nem menthető hozzá.`, {
            hint: 'A PDF-je csak újra előállítva (…_UJRAELOALLITOTT.pdf) kérhető le.',
          });
        }
        const f = fileFingerprints(d.content);
        const res = this.exec(
          `INSERT INTO invoice_documents (invoice_id, kind, sha256, sha3_512, size, content, software, created_at)
           VALUES (?, 'original', ?, ?, ?, ?, ?, ?)`,
          d.invoiceId,
          f.sha256,
          f.sha3_512,
          f.size,
          d.content,
          requireText(d.software, 'software'),
          this.timestamp(),
        );
        const row = this.one('SELECT * FROM invoice_documents WHERE id = ?', res.lastInsertRowid);
        if (!row) throw corrupt('invoice_documents');
        return rowToDocument(row);
      }),
    );
  }

  /** The kept original PDF of a document, or null. */
  getDocument(invoiceId: string): StoredDocument | null {
    return this.op(() => {
      const row = this.one(`SELECT * FROM invoice_documents WHERE invoice_id = ? AND kind = 'original'`, invoiceId);
      return row ? rowToDocument(row) : null;
    });
  }

  /** The document was already issued when originals started to be kept (schema 3): it never gets one. */
  isLegacyDocument(invoiceId: string): boolean {
    return this.op(() => this.one('SELECT 1 AS present FROM invoice_documents_legacy WHERE invoice_id = ?', invoiceId) !== undefined);
  }

  /** Number of documents issued before originals were kept. */
  countLegacyDocuments(): number {
    return this.op(() => {
      const row = this.one('SELECT COUNT(*) AS n FROM invoice_documents_legacy');
      return row ? int(row, 'n') : 0;
    });
  }

  /** Calls `fn` with every kept original, oldest first, one at a time in one snapshot (integrity checks). */
  forEachDocument(fn: (d: StoredDocument) => void): void {
    this.op(() =>
      this.read(() => {
        for (const row of this.db.prepare('SELECT * FROM invoice_documents ORDER BY id').iterate()) fn(rowToDocument(row));
      }),
    );
  }

  // --- payment ledger ----------------------------------------------------------------------
  /**
   * Appends a payment to the ledger. Only for an issued (or cancelled) document: AppError('IMMUTABLE_PAYMENT')
   * otherwise. `createdAt` defaults to now (the one-time pass over an existing database passes the time of the audit
   * entry it takes the payment from).
   */
  insertPayment(p: Omit<Payment, 'id' | 'createdAt'> & { createdAt?: IsoTimestamp }): Payment {
    return this.op(() => {
      const res = this.exec(
        `INSERT INTO payments (invoice_id, payment_date, amount, source, reference, audit_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        requireText(p.invoiceId, 'invoiceId'),
        assertIsoDate(p.date, 'date'),
        normDec(p.amount, 'amount'),
        p.source,
        p.reference,
        p.auditId,
        p.createdAt ?? this.timestamp(),
      );
      const row = this.one('SELECT * FROM payments WHERE id = ?', res.lastInsertRowid);
      if (!row) throw corrupt('payments');
      return rowToPayment(row);
    });
  }

  /** Appends allocation rows (in one transaction): parts of payments allocated to documents, signed. */
  insertAllocations(rows: ReadonlyArray<{ paymentId: number; invoiceId: string; amount: string }>): void {
    if (rows.length === 0) return;
    this.op(() =>
      this.tx(() => {
        const at = this.timestamp();
        for (const r of rows) {
          this.exec('INSERT INTO payment_allocations (payment_id, invoice_id, amount, created_at) VALUES (?, ?, ?, ?)', r.paymentId, requireText(r.invoiceId, 'invoiceId'), normDec(r.amount, 'amount'), at);
        }
      }),
    );
  }

  /** The payments recorded on these documents, in recording order. */
  listPayments(invoiceIds: readonly string[]): Payment[] {
    if (invoiceIds.length === 0) return [];
    return this.op(() => this.many(`SELECT * FROM payments WHERE invoice_id IN (${placeholders(invoiceIds.length)}) ORDER BY id`, ...invoiceIds).map(rowToPayment));
  }

  /** The allocation rows of these documents, oldest first. */
  listAllocations(invoiceIds: readonly string[]): PaymentAllocation[] {
    if (invoiceIds.length === 0) return [];
    return this.op(() =>
      this.many(`SELECT * FROM payment_allocations WHERE invoice_id IN (${placeholders(invoiceIds.length)}) ORDER BY id`, ...invoiceIds).map(rowToAllocation),
    );
  }

  /** What the ledger allocated to each document in total, by document id (documents without allocations are absent). */
  allocationTotals(): Map<string, string> {
    return this.op(() => {
      const totals = new Map<string, DecValue>();
      for (const row of this.stmt('SELECT invoice_id, amount FROM payment_allocations').iterate()) {
        const id = str(row, 'invoice_id');
        totals.set(id, (totals.get(id) ?? dec(0)).plus(str(row, 'amount')));
      }
      return new Map([...totals].map(([id, v]) => [id, toDec(v)] as const));
    });
  }

  /**
   * The payments dated in [from, to] (both days inclusive), by payment date then recording order, and every allocation
   * row of them, oldest first – in one read snapshot.
   */
  paymentsBetween(from: IsoDate, to: IsoDate): { payments: Payment[]; allocations: PaymentAllocation[] } {
    return this.op(() =>
      this.read(() => ({
        payments: this.many('SELECT * FROM payments WHERE payment_date BETWEEN ? AND ? ORDER BY payment_date, id', from, to).map(rowToPayment),
        allocations: this.many(
          'SELECT a.* FROM payment_allocations AS a JOIN payments AS p ON p.id = a.payment_id WHERE p.payment_date BETWEEN ? AND ? ORDER BY a.id',
          from,
          to,
        ).map(rowToAllocation),
      })),
    );
  }

  /**
   * The 'invoice.payment' audit entries no payment of the ledger records yet (payments.audit_id), oldest first: of these
   * documents, or – `invoiceIds` omitted, the one-time pass over an existing database – of every document, those after
   * entry `afterId`, at most `limit` of them.
   */
  unledgeredPaymentEntries(invoiceIds?: readonly string[], page: { afterId?: number; limit?: number } = {}): AuditEntry[] {
    const missing = `action = 'invoice.payment' AND NOT EXISTS (SELECT 1 FROM payments WHERE payments.audit_id = audit_log.id)`;
    if (invoiceIds === undefined) {
      const limit = page.limit ?? -1;
      return this.op(() => this.read(() => this.many(`SELECT * FROM audit_log WHERE id > ? AND ${missing} ORDER BY id LIMIT ?`, page.afterId ?? 0, limit).map(rowToAudit)));
    }
    if (invoiceIds.length === 0) return [];
    return this.op(() =>
      this.many(`SELECT * FROM audit_log WHERE entity_id IS NOT NULL AND entity_id IN (${placeholders(invoiceIds.length)}) AND ${missing} ORDER BY id`, ...invoiceIds).map(rowToAudit),
    );
  }

  /**
   * The documents with a payment (not a 0 amount) that has no allocation row yet – their chains are not settled from the
   * ledger –, in the order of their first such payment.
   */
  unallocatedPaymentInvoices(): string[] {
    return this.op(() =>
      this.many(
        `SELECT invoice_id, MIN(id) AS first FROM payments WHERE amount <> '0' AND NOT EXISTS (SELECT 1 FROM payment_allocations AS a WHERE a.payment_id = payments.id)
         GROUP BY invoice_id ORDER BY first`,
      ).map((r) => str(r, 'invoice_id')),
    );
  }

  // --- exchange-rate cache -----------------------------------------------------------------
  getCachedRate(currency: string, date: IsoDate): CachedRate | null {
    return this.op(() => {
      const row = this.one(
        'SELECT currency, rate_date, rate, unit FROM exchange_rates WHERE currency = ? AND requested_date = ?',
        normCurrency(currency),
        date,
      );
      if (!row) return null;
      return {
        currency: str(row, 'currency'),
        date: str(row, 'rate_date'),
        rate: str(row, 'rate'),
        unit: int(row, 'unit'),
        source: 'MNB',
      };
    });
  }

  /** Caches `rate` under the requested date (which may differ from rate.date on weekends). */
  putCachedRate(requestedDate: IsoDate, rate: CachedRate): void {
    this.op(() => {
      assertIsoDate(requestedDate, 'requestedDate');
      assertIsoDate(rate.date, 'rate.date');
      if (rate.date > requestedDate) {
        throw new AppError('INVALID_ARGUMENT', `Az árfolyam dátuma (${rate.date}) későbbi, mint a kért nap (${requestedDate}).`, {
          hint: 'A kért napra a legutóbbi, azon a napon vagy korábban közzétett MNB-árfolyam érvényes.',
        });
      }
      if (!dec(rate.rate, 'rate').gt(0)) {
        throw new AppError('INVALID_NUMBER', `Az árfolyam csak pozitív szám lehet: ${rate.rate}`, {
          hint: 'Az MNB által közzétett árfolyamot add meg (HUF / unit egység).',
        });
      }
      this.exec(
        `INSERT INTO exchange_rates (currency, requested_date, rate_date, rate, unit, source, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (currency, requested_date) DO UPDATE SET
           rate_date = excluded.rate_date, rate = excluded.rate, unit = excluded.unit,
           source = excluded.source, fetched_at = excluded.fetched_at`,
        normCurrency(rate.currency),
        requestedDate,
        rate.date,
        normDec(rate.rate, 'rate'),
        rate.unit,
        rate.source,
        this.timestamp(),
      );
    });
  }

  // --- audit -------------------------------------------------------------------------------
  audit(entry: NewAuditEntry): AuditEntry {
    return this.op(() =>
      this.tx(() => {
        const at = this.timestamp();
        const entityId = entry.entityId ?? null;
        // Store exactly what the hash covers: canonical JSON, re-parsed (drops undefined members).
        const detailsJson = canonicalJson(entry.details ?? {});
        const details = JSON.parse(detailsJson) as Record<string, unknown>;
        const last = this.one('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
        const prevHash = last ? str(last, 'hash') : ZERO_HASH;
        const hash = auditHash(prevHash, {
          at,
          actor: entry.actor,
          action: entry.action,
          entityType: entry.entityType,
          entityId,
          details,
        });
        const res = this.exec(
          `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, details, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          at,
          entry.actor,
          requireText(entry.action, 'action'),
          entry.entityType,
          entityId,
          detailsJson,
          prevHash,
          hash,
        );
        return {
          id: res.lastInsertRowid,
          at,
          actor: entry.actor,
          action: entry.action,
          entityType: entry.entityType,
          entityId,
          details,
        };
      }),
    );
  }

  /** Newest entries first. */
  listAudit(q: { entityId?: string; limit: number; offset: number }): Page<AuditEntry> {
    return this.op(() => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.entityId !== undefined) {
        where.push('entity_id = ?');
        params.push(q.entityId);
      }
      return this.page('audit_log', where, params, 'id DESC', q.limit, q.offset, rowToAudit);
    });
  }

  /** Recomputes the hash chain. */
  verifyAuditChain(): { ok: boolean; entries: number; brokenAtId?: number } {
    return this.op(() =>
      this.read(() => {
        let prev = ZERO_HASH;
        let entries = 0;
        let brokenAtId: number | undefined;
        const rows = this.db
          .prepare('SELECT id, at, actor, action, entity_type, entity_id, details, prev_hash, hash FROM audit_log ORDER BY id')
          .iterate();
        for (const row of rows) {
          entries++;
          if (brokenAtId !== undefined) continue;
          let intact: boolean;
          let storedHash: string | null = null;
          try {
            storedHash = str(row, 'hash');
            const expected = auditHash(prev, {
              at: str(row, 'at'),
              actor: str(row, 'actor'),
              action: str(row, 'action'),
              entityType: str(row, 'entity_type'),
              entityId: strOrNull(row, 'entity_id'),
              details: json<unknown>(row, 'details'),
            });
            intact = str(row, 'prev_hash') === prev && storedHash === expected;
          } catch {
            intact = false;
          }
          if (!intact) brokenAtId = int(row, 'id');
          prev = storedHash ?? prev;
        }
        return brokenAtId === undefined ? { ok: true, entries } : { ok: false, entries, brokenAtId };
      }),
    );
  }

  /** Whether the audit log has an entry with this action for this entity. */
  hasAudit(entityId: string, action: string): boolean {
    return this.op(() => this.one('SELECT 1 AS present FROM audit_log WHERE entity_id = ? AND action = ? LIMIT 1', entityId, action) !== undefined);
  }

  /** The audit entries with this action for this entity, oldest first (e.g. the fingerprints logged when an original was kept). */
  auditEntries(entityId: string, action: string): AuditEntry[] {
    return this.op(() => this.read(() => this.many('SELECT * FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY id', entityId, action).map(rowToAudit)));
  }

  /** Every audit entry with this action, oldest first (integrity cross-checks). */
  listAuditByAction(action: string): AuditEntry[] {
    return this.op(() => this.read(() => this.many('SELECT * FROM audit_log WHERE action = ? ORDER BY id', action).map(rowToAudit)));
  }

  /**
   * The last entry of the audit chain, or null for an empty log. Kept with a backup, it shows later
   * whether entries were cut off the end of the chain (which leaves the remaining chain intact).
   */
  auditHead(): { id: number; hash: string } | null {
    return this.op(() => {
      const row = this.one('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
      return row ? { id: int(row, 'id'), hash: str(row, 'hash') } : null;
    });
  }

  /**
   * Names of the protective triggers of the schema (immutable invoices, append-only audit log and NAV
   * submissions) that are missing from the database or differ from their definition – an SQLite tool
   * can drop or replace them, e.g. to change an issued invoice and put them back afterwards.
   */
  findAlteredTriggers(): string[] {
    const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
    const expected = new Map<string, string>();
    for (const m of MIGRATIONS) {
      for (const [sql, name] of m.sql.matchAll(/CREATE TRIGGER\s+(\w+)[\s\S]*?\nEND;/g)) expected.set(name as string, norm(sql.slice(0, -1)));
      for (const [, name] of m.sql.matchAll(/DROP TRIGGER\s+(?:IF EXISTS\s+)?(\w+)/g)) expected.delete(name as string);
    }
    return this.op(() => {
      const actual = new Map(this.many(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`).map((r) => [str(r, 'name'), norm(strOrNull(r, 'sql') ?? '')]));
      return [...expected].filter(([name, sql]) => actual.get(name) !== sql).map(([name]) => name);
    });
  }

  // --- maintenance -------------------------------------------------------------------------
  /**
   * Number, type, issue date and content hash of every numbered document (issued or cancelled), in the order of
   * issue. What a restore compares: the documents a backup does not have.
   */
  listNumberedDocuments(): Array<{ id: string; number: string; seriesId: string; documentType: Invoice['documentType']; issueDate: IsoDate; contentHash: string | null }> {
    return this.op(() =>
      this.many(`SELECT id, number, series_id, document_type, issue_date, content_hash FROM invoices WHERE status <> 'draft' AND number IS NOT NULL ORDER BY rowid`).map((r) => ({
        id: str(r, 'id'),
        number: str(r, 'number'),
        seriesId: str(r, 'series_id'),
        documentType: str(r, 'document_type') as Invoice['documentType'],
        issueDate: str(r, 'issue_date'),
        contentHash: strOrNull(r, 'content_hash'),
      })),
    );
  }

  /** The hash of the audit entry `id`, or null when the log has no such entry. */
  auditHashAt(id: number): string | null {
    return this.op(() => {
      const row = this.one('SELECT hash FROM audit_log WHERE id = ?', id);
      return row ? str(row, 'hash') : null;
    });
  }

  /**
   * Moves the numbering of a series forward to `nextSeq` in `seqYear` – never backwards: numbers this database does
   * not know were given out (a restored backup of an earlier state). Returns false when the series is already there.
   */
  raiseSequence(seriesId: string, nextSeq: number, seqYear: number | null): boolean {
    return this.op(() =>
      this.tx(() => {
        const row = this.one('SELECT * FROM series WHERE id = ?', seriesId);
        if (!row) throw notFound('Számlatömb', seriesId);
        const s = rowToSeries(row);
        if (!Number.isInteger(nextSeq) || nextSeq < 1) throw new AppError('INVALID_DATA', `Érvénytelen sorszám: ${nextSeq}`);
        const ahead = (seqYear ?? -1) > (s.seqYear ?? -1) || ((seqYear ?? -1) === (s.seqYear ?? -1) && nextSeq > s.nextSeq);
        if (!ahead) return false;
        this.exec('UPDATE series SET next_seq = ?, seq_year = ? WHERE id = ?', nextSeq, seqYear, seriesId);
        return true;
      }),
    );
  }

  /** SQLite's own check of the file structure (PRAGMA quick_check): the problems found, none for a sound file. */
  fileProblems(): string[] {
    return this.op(() => {
      const rows = this.db.prepare('PRAGMA quick_check').all();
      const found = rows.map((r) => String(Object.values(r)[0] ?? '')).filter((s) => s !== '' && s !== 'ok');
      return found;
    });
  }

  /**
   * Writes a consistent copy of the database to `destPath` (VACUUM INTO). On Windows a name the file
   * system cannot hold is refused first, and the result is checked: a missing or empty file is not a backup.
   */
  backup(destPath: string): void {
    this.op(() => {
      requireText(destPath, 'destPath');
      if (this.depth > 0 || this.reading) {
        throw new AppError('TX_NOT_ALLOWED', 'Adatbázis-mentés tranzakción belül nem készíthető.', {
          hint: 'A backup() hívást a tx() blokkon kívül végezd.',
        });
      }
      const badName = process.platform === 'win32' ? windowsPathProblem(destPath) : null;
      if (badName) {
        throw new AppError('INVALID_INPUT', `A mentés útvonalában Windowson nem állhat ${badName}: ${destPath}`, {
          hint: 'Windowson a fájl- és mappanevekben nem lehet : * ? " < > | jel (a kettőspont utáni rész egy rejtett adatfolyamba kerülne, amit a fájl másolása vagy tömörítése elhagy). Adj meg más nevet, pl. mentes_2026-11-08_1430.db.',
        });
      }
      if (existsSync(destPath)) {
        throw new AppError('BACKUP_EXISTS', `A mentési fájl már létezik: ${destPath}`, {
          hint: 'Adj meg új fájlnevet (pl. dátummal); a meglévő mentést nem írjuk felül.',
        });
      }
      try {
        this.db.prepare('VACUUM INTO ?').run(destPath);
      } catch (e) {
        throw new AppError('BACKUP_FAILED', `Nem sikerült a mentés ide: ${destPath}`, {
          hint: 'Ellenőrizd, hogy a célkönyvtár létezik, írható, és van elég szabad hely.',
          cause: e,
        });
      }
      let size = 0;
      try {
        size = statSync(destPath).size;
      } catch {
        // missing: reported below
      }
      if (size === 0) {
        try {
          rmSync(destPath, { force: true }); // an empty stub left behind is not a backup
        } catch {
          // nothing to remove, or not removable: the error below says what happened
        }
        throw new AppError('BACKUP_FAILED', `A mentés nem jött létre, vagy üres maradt: ${destPath}`, {
          hint: 'Ments egy helyi mappába, közönséges fájlnévvel (pl. mentes_2026-11-08.db), és ellenőrizd, hogy van elég szabad hely.',
        });
      }
    });
  }

  // --- internals ---------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('STORE_CLOSED', `Az adatbázis-kapcsolat már le van zárva (${this.path}).`, {
        hint: 'Nyiss új Store példányt.',
      });
    }
  }

  /** Runs a public operation: checks the connection and maps every error to AppError. */
  private op<T>(fn: () => T): T {
    this.assertOpen();
    try {
      return fn();
    } catch (e) {
      throw mapDbError(e);
    }
  }

  /** Nested tx(): joins the open transaction through a savepoint. */
  private savepoint<T>(fn: () => T): T {
    const name = `osz_sp_${this.depth}`;
    try {
      this.db.exec(`SAVEPOINT ${name}`);
    } catch (e) {
      throw mapDbError(e);
    }
    this.depth++;
    try {
      const result = fn();
      rejectAsync(result);
      this.assertOpen();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      try {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      } catch {
        // SQLite already rolled back the whole transaction (or close() was called inside the callback);
        // the outer frame will notice.
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  private rollback(): void {
    if (this.closed) return; // close() inside a tx() callback: closing the connection rolled back
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // nothing left to roll back (SQLite may already have rolled back on its own)
    }
  }

  /** Read-only snapshot for multi-statement reads (count + page) outside tx(). */
  private read<T>(fn: () => T): T {
    if (this.depth > 0 || this.reading) return fn();
    this.db.exec('BEGIN');
    this.reading = true;
    try {
      return fn();
    } finally {
      this.reading = false;
      // Always ended: a snapshot left open would make every later BEGIN fail. Ending it must not
      // mask an error of fn (after which SQLite may already have ended the transaction itself).
      try {
        this.db.exec('COMMIT');
      } catch {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // no transaction left
        }
      }
    }
  }

  private timestamp(): IsoTimestamp {
    return this.now().toISOString();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (s === undefined) {
      if (this.statements.size >= MAX_CACHED_STATEMENTS) {
        const oldest = this.statements.keys().next();
        if (oldest.done !== true) this.statements.delete(oldest.value);
      }
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params);
  }

  private many(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params);
  }

  private exec(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const res = this.stmt(sql).run(...params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  private page<T>(
    table: string,
    where: readonly string[],
    params: readonly SQLInputValue[],
    orderBy: string,
    limit: number,
    offset: number,
    map: (row: Row) => T,
  ): Page<T> {
    checkPage(limit, offset);
    const w = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    return this.read(() => {
      const countRow = this.one(`SELECT COUNT(*) AS n FROM ${table}${w}`, ...params);
      const total = countRow ? int(countRow, 'n') : 0;
      const items =
        limit === 0 || offset >= total
          ? []
          : this.many(`SELECT * FROM ${table}${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, limit, offset).map(map);
      return { items, total, limit, offset };
    });
  }

  /** WHERE terms, parameters and ORDER BY of an invoice filter (findInvoices, forEachInvoice). */
  private invoiceQuery(f: Omit<InvoiceFilter, 'limit' | 'offset'>): { where: string[]; params: SQLInputValue[]; orderBy: string } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const inList = (column: string, values: readonly string[] | undefined): void => {
      if (values === undefined || values.length === 0) return;
      const unique = [...new Set(values)];
      where.push(`${column} IN (${unique.map(() => '?').join(', ')})`);
      params.push(...unique);
    };
    // The documents of one invoice chain (originalInvoiceId) are found through invoices_original: "+status" keeps a
    // status index from being chosen instead, which would walk every issued document (status is low-cardinality).
    inList(f.originalInvoiceId !== undefined ? '+status' : 'status', f.status);
    inList('document_type', f.documentType);
    inList('payment_status', f.paymentStatus);
    inList('nav_status', f.navStatus);
    if (f.customerId !== undefined) {
      where.push('customer_id = ?');
      params.push(f.customerId);
    }
    if (hasText(f.text)) {
      where.push(`search_text LIKE ? ESCAPE '!'`);
      params.push(containsPattern(f.text));
    }
    if (f.issueDateFrom !== undefined) {
      where.push('issue_date >= ?');
      params.push(assertIsoDate(f.issueDateFrom, 'issueDateFrom'));
    }
    if (f.issueDateTo !== undefined) {
      where.push('issue_date <= ?');
      params.push(assertIsoDate(f.issueDateTo, 'issueDateTo'));
    }
    if (f.fulfillmentDateFrom !== undefined) {
      where.push('fulfillment_date >= ?');
      params.push(assertIsoDate(f.fulfillmentDateFrom, 'fulfillmentDateFrom'));
    }
    if (f.fulfillmentDateTo !== undefined) {
      where.push('fulfillment_date <= ?');
      params.push(assertIsoDate(f.fulfillmentDateTo, 'fulfillmentDateTo'));
    }
    if (f.receivable === true) where.push(RECEIVABLE_SQL);
    if (f.overdueOn !== undefined) {
      // A receivable (credit notes / storno invoices with a zero or negative total are never overdue),
      // not fully paid, due before the date. IN ('unpaid', 'partial') rather than <> 'paid' so the
      // invoices_overdue index applies.
      where.push(`payment_status IN ('unpaid', 'partial') AND due_date IS NOT NULL AND due_date < ? AND ${RECEIVABLE_SQL}`);
      params.push(assertIsoDate(f.overdueOn, 'overdueOn'));
    }
    if (f.originalInvoiceId !== undefined) {
      where.push('original_invoice_id = ?');
      params.push(f.originalInvoiceId);
    }
    if (f.navSelect !== undefined) where.push(navSelectSql('invoices', f.navSelect, params));
    if (f.originalNavSelect !== undefined) {
      where.push(`EXISTS (SELECT 1 FROM invoices AS o WHERE o.id = invoices.original_invoice_id AND ${navSelectSql('o', f.originalNavSelect, params)})`);
    }
    if (f.correctionNavStatus !== undefined) {
      const statuses = [...new Set(f.correctionNavStatus)];
      where.push(
        `EXISTS (SELECT 1 FROM invoices AS c WHERE c.original_invoice_id = invoices.id AND c.status <> 'draft' AND c.document_type IN ('modification', 'storno') AND c.nav_status IN (${statuses.map(() => '?').join(', ') || 'NULL'}))`,
      );
      params.push(...statuses);
    }
    const sort = f.sort ?? 'issued_desc';
    if (!Object.hasOwn(INVOICE_SORTS, sort)) {
      throw new AppError('INVALID_ARGUMENT', `Ismeretlen rendezés: ${String(sort)}`, {
        hint: "Megengedett értékek: 'issued_desc', 'issued_asc', 'created_desc'.",
      });
    }
    return { where, params, orderBy: INVOICE_SORTS[sort] };
  }

  private invoiceStatus(id: string): InvoiceStatus {
    const row = this.one('SELECT status FROM invoices WHERE id = ?', id);
    if (!row) throw notFound('Számla', id);
    return str(row, 'status') as InvoiceStatus;
  }

  private assertNumberFree(number: string, invoiceId: string): void {
    const dup = this.one('SELECT id FROM invoices WHERE number = ? AND id <> ?', number, invoiceId);
    if (dup) {
      throw new AppError('DUPLICATE_INVOICE_NUMBER', `A(z) ${number} számlaszám már foglalt.`, {
        hint: DUPLICATE_NUMBER_HINT,
        details: { number, existingInvoiceId: str(dup, 'id') },
      });
    }
  }

  /** Friendly NOT_FOUND errors instead of a bare FOREIGN KEY failure. */
  private assertInvoiceReferences(inv: Invoice): void {
    if (!this.one('SELECT 1 AS present FROM series WHERE id = ?', inv.seriesId)) throw notFound('Számlatömb', inv.seriesId);
    if (inv.customerId !== null && inv.customerId !== undefined) {
      if (!this.one('SELECT 1 AS present FROM customers WHERE id = ?', inv.customerId)) throw notFound('Ügyfél', inv.customerId);
    }
    const originalId = inv.reference?.originalInvoiceId;
    if (originalId !== null && originalId !== undefined) {
      if (!this.one('SELECT 1 AS present FROM invoices WHERE id = ?', originalId)) throw notFound('Eredeti számla', originalId);
    }
    if (inv.cancelledById !== null && inv.cancelledById !== undefined) {
      if (!this.one('SELECT 1 AS present FROM invoices WHERE id = ?', inv.cancelledById)) {
        throw notFound('Sztornó számla', inv.cancelledById);
      }
    }
  }

  /**
   * Read-only schema checks (nothing is written): returns the applied schema version, or throws
   * SCHEMA_TOO_NEW / NOT_AN_OPENSZAMLA_DB.
   */
  private checkSchema(): number {
    MIGRATIONS.forEach((m, i) => {
      if (m.version !== i + 1) {
        throw new AppError('SCHEMA_INVALID', `Hibás migrációs lista: a(z) ${i + 1}. elem verziója ${m.version}.`);
      }
    });
    const version = this.schemaVersion();
    if (version > LATEST_SCHEMA_VERSION) throw this.schemaTooNew(version, LATEST_SCHEMA_VERSION);
    if (version === 0) {
      const objects = this.db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite!_%' ESCAPE '!'`)
        .get();
      if (objects && int(objects, 'n') > 0) {
        throw new AppError('NOT_AN_OPENSZAMLA_DB', `A(z) ${this.path} fájl nem OpenSzámla-adatbázis (más táblákat tartalmaz).`, {
          hint: 'Adj meg egy még nem létező fájlt (új adatbázis), vagy egy meglévő OpenSzámla-adatbázist.',
        });
      }
    }
    return version;
  }

  /** Applies the pending migrations in one BEGIN IMMEDIATE transaction. */
  private migrate(): void {
    const latest = LATEST_SCHEMA_VERSION;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check under the write lock: another process may have migrated in the meantime.
      const current = this.checkSchema();
      if (current < latest) {
        const ts = this.timestamp();
        // (meta itself is created by migration 1, so statements touching it are prepared afterwards)
        const setMeta = (key: string, value: string): void => {
          this.db
            .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
            .run(key, value);
        };
        for (const m of MIGRATIONS) {
          if (m.version <= current) continue;
          this.db.exec(m.sql);
          setMeta('schema_version', String(m.version));
        }
        this.db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', ?) ON CONFLICT (key) DO NOTHING`).run(ts);
        setMeta('schema_updated_at', ts);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  /** Error of a failed open: a file that is not an SQLite database at all gets its own message. */
  private openError(e: unknown): AppError {
    const errcode = isAppError(e) ? undefined : (e as { errcode?: unknown } | null)?.errcode;
    if (typeof errcode === 'number' && (errcode & 0xff) === 26 /* SQLITE_NOTADB */) {
      return new AppError('NOT_AN_OPENSZAMLA_DB', `A(z) ${this.path} fájl nem SQLite-adatbázis (vagy sérült / titkosított).`, {
        hint: 'Adj meg egy még nem létező fájlt (új adatbázis), vagy egy meglévő OpenSzámla-adatbázist. Ha ez a saját adatbázisod, és megsérült: állíts vissza egy mentést (openszamla restore <mentésfájl> --confirm) – a sérült fájlt a program félreteszi, nem törli.',
        cause: e,
      });
    }
    return mapDbError(e);
  }

  private schemaVersion(): number {
    const hasMeta = this.db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
    if (!hasMeta) return 0;
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    if (!row) return 0;
    const version = Number(row['value']);
    if (!Number.isInteger(version) || version < 0) throw corrupt('meta.schema_version');
    return version;
  }

  private schemaTooNew(found: number, latest: number): AppError {
    return new AppError(
      'SCHEMA_TOO_NEW',
      `Az adatbázis sémaverziója (${found}) újabb, mint amit ez a programverzió ismer (${latest}).`,
      { hint: 'Frissítsd az OpenSzámla programot a legújabb verzióra.' },
    );
  }
}
