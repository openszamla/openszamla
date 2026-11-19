/**
 * Service layer: every business operation of OpenSzámla. MCP tools, the CLI and the web UI are thin
 * adapters over this class, so the rules (validation, numbering, immutability, NAV reporting) live in
 * exactly one place.
 */
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { amountDecimals, computeLines, computeTotals, buildNotations, stornoLineInputs } from '../core/calc.ts';
import { DOCUMENT_TYPE_NAME, NAV_STATUS_NAME, PAYMENT_METHOD_NAME, PAYMENT_STATUS_NAME, invoiceStatusName } from '../core/names.ts';
import { canonicalJson, fileFingerprints, sha256Hex } from '../core/canonical.ts';
import { addDays, assertIsoDate, daysBetween, formatHuDate, HU_TIME_ZONE, huDate } from '../core/dates.ts';
import { isIsoDate } from '../core/dates.ts';
import { dec, normDec, roundDec, sumDec, toDec, type DecValue } from '../core/decimal.ts';
import { AppError, isAppError, notFound } from '../core/errors.ts';
import { formatDate, formatMoney, formatQuantity, singleLine, visibleLength } from '../core/format.ts';
import { newId } from '../core/ids.ts';
import { DEFAULT_INVOICE_PATTERN, DEFAULT_PROFORMA_PATTERN, formatNumber, patternsOverlap, validatePattern } from '../core/numbering.ts';
import { settleChain, type Settlement } from '../core/settlement.ts';
import { settleLedger, type ChainLedger } from '../core/settlement.ts';
import type {
  Actor,
  Address,
  AuditEntry,
  Customer,
  CustomerData,
  DocumentType,
  Invoice,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceReference,
  IsoDate,
  LineNature,
  NavMessage,
  NavStatus,
  Page,
  Product,
  SellerProfile,
  Series,
  SeriesKind,
  ValidationIssue,
  VatCode,
} from '../core/types.ts';
import type { IsoTimestamp, Payment, PaymentSource } from '../core/types.ts';
import { chainFulfillmentDate, parseBankAccount, parseEuVatNumber, parseHuTaxNumber, sameCustomer, validateCustomer, validateInvoice, validateSeller } from '../core/validate.ts';
import { isVatCode, VAT_CODES } from '../core/vat.ts';
import { isPercentageCode } from '../core/vat.ts';
import { Store, type CustomerQuery, type InvoiceFilter, type NavSelector, type NavSubmissionRecord, type ProductQuery } from '../db/store.ts';
import type { InvoiceMutablePatch } from '../db/store.ts';
import { MnbClient } from '../mnb/rates.ts';
import { parseInvoiceDataKeys } from '../nav/api-xml.ts';
import { NavClient, NavError, type ManageInvoiceItem, type NavClientOptions } from '../nav/client.ts';
import { buildInvoiceDataXml, decodeInvoiceData, encodeInvoiceData, navOperationFor, navReportSizeProblem } from '../nav/invoice-data.ts';
import { buildSzamla2013Export, type Szamla2013Warning } from '../export/szamla2013.ts';
import type { NavEnvironment, NavProcessingResult, TaxpayerInfo } from '../nav/types.ts';
import { renderInvoicePdf } from '../pdf/render.ts';
import { VERSION } from '../version.ts';
import { ensureDataDir, followsNavCredentialsFile, loadConfig, NavSettingsWatch, navSetupCommand, navSetupCommandLine, type AppConfig, type LoadConfigOptions } from './config.ts';
import type { CustomerInput, DraftInput, DraftPatch, InvoiceDefaults, LineInput, ProductInput, SellerInput, SeriesInput, SeriesPatch } from './inputs.ts';
import { navManualSource, navOtherChannel, navReceivedBeforeIssue, navRecordDifferences } from './nav-match.ts';
import { recordedRestores, type RestoreRecord } from './restore.ts';
import { describeCharacter, missingGlyphs } from '../pdf/glyphs.ts';

/** The totals of an invoice with its issued modifications, before and with the modification being drafted. */
export interface CorrectionChainTotals {
  originalNumber: string;
  /** Issued modifications of the original counted in `before`. */
  modifications: number;
  currency: string;
  before: { netAmount: string; vatAmount: string; grossAmount: string };
  after: { netAmount: string; vatAmount: string; grossAmount: string };
}

export interface InvoiceView {
  invoice: Invoice;
  issues: ValidationIssue[];
  readyToIssue: boolean;
  /** The draft of a modification: what it does to its invoice (correctionChain). */
  chain?: CorrectionChainTotals;
}

export interface NavInvoiceResult {
  invoiceId: string;
  number: string | null;
  navStatus: NavStatus;
  transactionId: string | null;
  messages: NavMessage[];
  /**
   * The NAV system navStatus belongs to – the configured one, unless the invoice belongs to the other one (e.g. it
   * was reported only to the test system): in 'test' nothing was reported for real.
   */
  environment: NavEnvironment;
  /** Short explanation of what happened in this run. */
  note: string;
  /**
   * Set when the run stopped before it handled this invoice, which `note` explains: 'time' – the time limit of the
   * call (NavRunOptions.budgetMs) or of issuing ran out; 'outage' – NAV could not be reached in this run; 'pause' – NAV
   * asked for a pause (Retry-After). A later nav_sync handles it.
   */
  notProcessed?: 'time' | 'outage' | 'pause';
}

/**
 * Sending an invoice whose NAV state belongs to the other NAV system to the configured one (OpenSzamla.navForeignResend):
 * what the user confirms before nav_sync { invoice, resubmitFailed } does it.
 */
export interface NavForeignResend {
  invoiceId: string;
  number: string | null;
  /** The NAV system its NAV state belongs to now, and its status there. */
  reportedTo: NavEnvironment;
  navStatus: NavStatus;
  /** The configured NAV system it would be sent to, as a new submission. */
  sendTo: NavEnvironment;
  /** Sending it is a real report (the target is production). */
  realReport: boolean;
  /** All of this in Hungarian. */
  summary: string;
  /**
   * What a confirmation is bound to (NavRunOptions.confirmedForeign): the invoice, its content, its NAV status, the
   * system it belongs to and the target – exactly what the preview (`summary`) showed.
   */
  fingerprint: string;
}

export interface IssueResult {
  invoice: Invoice;
  pdfPath: string | null;
  pdfError: string | null;
  nav: NavInvoiceResult | null;
  notes: string[];
  /** The same notes with their codes (IssueNotice). */
  notices: IssueNotice[];
}

/**
 * What OpenSzamla.pdf returned. original: the PDF of an issued document as it was made when it was issued, kept in the
 * database byte for byte; regenerated: a document issued before originals were kept, rendered now with the running
 * program – not the original; copy: a "MÁSOLAT" render; draft: a "TERVEZET" render of a draft.
 */
export type PdfKind = 'original' | 'regenerated' | 'copy' | 'draft';

export interface PdfResult {
  kind: PdfKind;
  /** Uppercase hex SHA-256 of the kept original (its SHA3-512 is in the audit log); null for the other kinds. */
  sha256: string | null;
  /** What the file is, in Hungarian (for a regenerated one: that it is not the original). */
  note: string;
  path: string;
  bytes: number;
  copiedTo: string | null;
  base64: string | null;
  /**
   * Set when this request kept the original and found another file at `path` (e.g. the PDF of the invoice that had
   * this number before an older backup was restored): where that file was kept instead of being overwritten.
   * `note` says so too.
   */
  previousFile: string | null;
}

/** File-name ending of a regenerated PDF (pdf/<name>_UJRAELOALLITOTT.pdf): never the name of the original. */
export const REGENERATED_PDF_SUFFIX = '_UJRAELOALLITOTT';

const PDF_NOTES: Readonly<Record<PdfKind, string>> = {
  original: 'A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.',
  regenerated:
    'Ez a bizonylat az eredeti PDF megőrzése előtt készült, ezért a program a jelenlegi változattal újra előállította: nem bájtra azonos a vevőnek átadott PDF-fel.',
  copy: 'MÁSOLAT jelölésű példány, most előállítva – nem az eredeti PDF.',
  draft: 'Tervezet („TERVEZET – NEM SZÁMLA” vízjellel), most előállítva.',
};

/** pdfInfo of an issued document whose original is not kept yet: its PDF could not be made at issue. */
const PDF_NOT_KEPT_YET = 'Az eredeti PDF a kiállításkor nem készült el: az első PDF-kérés (letöltés) készíti el, és azt őrzi meg eredetiként.';

/** An original the audit log says was kept is not in the database (removed outside the program): never rendered anew. */
function documentMissing(inv: Pick<Invoice, 'number'>): AppError {
  return new AppError('DOCUMENT_MISSING', `A(z) ${inv.number} megőrzött eredeti PDF-je hiányzik az adatbázisból, pedig a napló szerint a program megőrizte; helyette újat nem állít elő.`, {
    hint: 'Az adatbázist a programon kívül módosíthatták: futtasd az openszamla verify parancsot, és állítsd vissza az adatbázist a legutóbbi mentésből (a mentés a megőrzött PDF-eket is tartalmazza).',
  });
}

/** The kept original PDF of an issued document (invoice_documents), as the store returns it. */
type KeptDocument = NonNullable<ReturnType<Store['getDocument']>>;

/**
 * A kept original whose bytes no longer match the fingerprints stored with it, or those logged when it was kept (changed
 * outside the program, or a damaged disk – SQLite keeps no page checksums): never served or written as the original.
 */
function documentAltered(inv: Pick<Invoice, 'number'>): AppError {
  return new AppError(
    'DOCUMENT_INTEGRITY_FAILED',
    `A(z) ${inv.number} megőrzött eredeti PDF-je sérült vagy módosult: nem egyezik a kiállításkor rögzített lenyomatával, ezért a program nem adja ki eredetiként, és a pdf/ mappában lévő fájlt sem írja felül vele.`,
    { hint: 'Futtasd az openszamla verify parancsot, és állítsd vissza az adatbázist a legutóbbi ép mentésből (a mentés a megőrzött PDF-eket is tartalmazza).' },
  );
}

/** What issuing (or the first PDF request) says when it kept another file found at the document's pdf/<name>.pdf. */
function previousPdfNote(own: string, kept: string): string {
  return (
    `A pdf/${basename(own)} fájl már létezett, és nem ennek a bizonylatnak a PDF-je (pl. egy régebbi mentés visszaállítása előtt ugyanezzel a sorszámmal kiállított bizonylaté): ` +
    `a program nem írta felül, hanem pdf/${basename(kept)} néven megőrizte. Őrizd meg, és vizsgáld meg a könyvelőddel.`
  );
}

/** "20261119-104512": a moment as a Hungarian local date and time, for file names. */
function huFileStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: HU_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const p = (type: Intl.DateTimeFormatPartTypes): string => parts.find((x) => x.type === type)?.value ?? '00';
  return `${p('year')}${p('month')}${p('day')}-${p('hour')}${p('minute')}${p('second')}`;
}

/** What cancel() would issue now, without storing anything (OpenSzamla.stornoPreview). */
export interface StornoPreview {
  original: Invoice;
  /** The storno document as cancel() would issue it today (no number yet). */
  storno: Invoice;
  /** Issued modifications of the original: the storno negates them together with the original. */
  negates: Invoice[];
  /** The reason as the storno carries it ("Sztornó oka: …"): normalised as cancel() stores it. */
  reason: string;
  /** Validation issues of the storno (errors mean cancel() would fail). */
  issues: ValidationIssue[];
}

export interface SetupStatus {
  version: string;
  dataDir: string;
  dbPath: string;
  seller: SellerProfile | null;
  sellerIssues: ValidationIssue[];
  defaults: InvoiceDefaults;
  series: Series[];
  /** configured: usable (credentials given and valid); problem: why the given settings cannot be used. */
  nav: { configured: boolean; environment: 'test' | 'production' | null; source: 'env' | 'file' | null; autoSubmit: boolean; problem: string | null };
  /**
   * navPending / navProblems: invoices of the configured NAV environment (or of none yet); navNotConfigured: those of them
   * issued without a usable NAV connection (counted in navProblems too); navOtherEnvironment: those whose NAV state belongs
   * to the other NAV system (e.g. reported only to the test one) – not reported here.
   */
  counts: { customers: number; products: number; drafts: number; issued: number; unpaid: number; navPending: number; navProblems: number; navNotConfigured: number; navOtherEnvironment: number };
  nextSteps: string[];
  /** The same to-dos, structured: a stable code, the number of documents and the details (every surface words them itself). */
  todos: SetupTodo[];
  /** Things to keep in mind (not to do), e.g. the VAT figures of a cash-accounting seller. */
  notes: string[];
}

/**
 * What a to-do of setup_status is about. SELLER_*: the seller data; NAV_NOT_CONFIGURED / NAV_INVALID_CONFIG /
 * NAV_TEST_ENVIRONMENT / NAV_PAUSE: the NAV connection; the others: documents in a NAV state that needs something done –
 * rejected or failed (NAV_REJECTED), a check NAV refuses for good (NAV_CHECK_BLOCKED), a number collision, corrections held
 * by their original (NAV_HELD_BY_*), the other NAV system's invoices and the corrections waiting for them, duplicates to
 * reconcile, invoices issued without a connection (NAV_NOT_REPORTED), pending and processing reports.
 */
export type SetupTodoCode =
  | 'SELLER_MISSING'
  | 'SELLER_INVALID'
  | 'NAV_NOT_CONFIGURED'
  | 'NAV_INVALID_CONFIG'
  | 'NAV_TEST_ENVIRONMENT'
  | 'NAV_PAUSE'
  | 'NAV_REJECTED'
  | 'NAV_CHECK_BLOCKED'
  | 'NAV_NUMBER_COLLISION'
  | 'NAV_HELD_BY_REJECTED_ORIGINAL'
  | 'NAV_HELD_BY_COLLISION_ORIGINAL'
  | 'NAV_HELD_BY_BLOCKED_ORIGINAL'
  | 'NAV_OTHER_ENVIRONMENT'
  | 'NAV_HELD_BY_OTHER_ENVIRONMENT'
  | 'NAV_DUPLICATE'
  | 'NAV_NOT_REPORTED'
  | 'NAV_PENDING'
  | 'NAV_PROCESSING';

/** A to-do of setup_status (SetupStatus.todos); the same as one of nextSteps, without the wording. */
export interface SetupTodo {
  code: SetupTodoCode;
  /** The documents it concerns (SELLER_INVALID: the errors of the seller data; 0 for the other settings to-dos). */
  count: number;
  /** Numbers of the documents it names (at most 10; `more`: how many more): the originals of NAV_HELD_BY_*, the invoices of NAV_OTHER_ENVIRONMENT. */
  numbers?: string[];
  more?: number;
  /** NAV_INVALID_CONFIG: why the settings cannot be used. */
  problem?: string;
  /** NAV_CHECK_BLOCKED, NAV_HELD_BY_BLOCKED_ORIGINAL: why NAV cannot be asked, in short Hungarian phrases. */
  reasons?: string[];
  /** NAV_NUMBER_COLLISION: the numbers the series concerned give next. */
  nextNumbers?: string[];
  /** NAV_OTHER_ENVIRONMENT, NAV_HELD_BY_OTHER_ENVIRONMENT: the NAV system the invoices' (originals') NAV state belongs to. */
  environment?: NavEnvironment;
  /** NAV_PAUSE: until when NAV asked not to be contacted (ISO timestamp), and why (NAV's code). */
  until?: string;
  pauseCode?: string;
}

/**
 * Why an issued correction (modification / storno) waits for its original (OpenSzamla.navWait) – or would wait, for one
 * not issued yet (navCorrectionWait): NAV accepts it only after its original. other_environment: the original's NAV state
 * belongs to the other NAV system (`environment`); rejected: NAV rejected the original or its report failed; collision:
 * the original's number belongs to another invoice at NAV; blocked: NAV refuses for good to be asked about the original;
 * processing: NAV is still processing it; pending: it is not reported yet.
 */
export interface NavWait {
  originalId: string;
  originalNumber: string | null;
  reason: 'other_environment' | 'rejected' | 'collision' | 'blocked' | 'processing' | 'pending';
  environment?: NavEnvironment;
}

/** A note of IssueResult with a stable code (IssueResult.notices), so a surface can word it itself. */
export interface IssueNotice {
  /**
   * ISSUE_DATE_CHANGED, a series code (e.g. CORRECTION_SERIES_ARCHIVED), PROFORMA_PAYMENT, MARK_PAID, PDF_FAILED, PDF_PREVIOUS_KEPT,
   * NAV_NOT_CONFIGURED, NAV_INVALID_CONFIG, NAV_TEST_ENVIRONMENT, NAV_BUSY, NAV_NOT_STARTED (`detail`: the error),
   * NAV_NOT_SUBMITTED (automatic submission off), PROFORMA_WITHDRAWN.
   */
  code: string;
  text: string;
  detail?: string;
}

/**
 * Which date puts an invoice into a period of a report or export: 'issue' = kelte (the invoice register
 * view), 'fulfillment' = teljesítés dátuma – the VAT tax point in general (Áfa tv. 55. § (1)), so the
 * basis of a period's VAT figures: an invoice for September work issued on 5 October belongs to September.
 * Not for a cash-accounting seller (pénzforgalmi elszámolás): its VAT is due when the consideration is
 * received (Áfa tv. 196/B. §), which neither basis follows (CASH_ACCOUNTING_VAT_NOTE) – 'payment' = the payment
 * date: the payments of the period, each with its proportional VAT, of the documents issued under cash
 * accounting (PAYMENT_BASIS_NOTE).
 */
export type DateBasis = 'issue' | 'fulfillment' | 'payment';

/** report / exportInvoices / status note for a cash-accounting seller (or invoices issued as one). */
export const CASH_ACCOUNTING_VAT_NOTE =
  'Pénzforgalmi elszámolás: az itt összesített ÁFA a kelte vagy a teljesítés dátuma szerinti, NEM a bevallandó adó. ' +
  'Pénzforgalmi elszámolásnál az adót abban az időszakban kell megállapítani, amelyben az ellenérték megtérül (jóváírják vagy kézhez veszik – Áfa tv. 196/B. §), ' +
  'részfizetésnél arányosan; ezt a befizetés dátuma szerinti összesítés mutatja. A bevalláshoz a befizetések alapján a könyvelő számol.';

/** report / exportInvoices note on the payment date basis ('payment'). */
export const PAYMENT_BASIS_NOTE =
  'Befizetés dátuma szerinti összesítés (pénzforgalmi elszámolás, Áfa tv. 196/B. §): csak a pénzforgalmi elszámolással kiállított bizonylatok befizetései és visszafizetései számítanak, ' +
  'a befizetés dátuma szerint. Egy befizetés ÁFA-ja a bizonylat ÁFA-jának a befizetéssel arányos része (befizetés × ÁFA ÷ bruttó végösszeg, forintban, a bizonylat árfolyamán, ' +
  'befizetésenként és ÁFA-kódonként 0,01 forintra kerekítve); a módosító számlára jutó részt a módosító számla ÁFA-ja szerint. ' +
  'Hogy a részfizetés adóját így kell-e megállapítani, és mi a bevallandó adó, a könyvelő dönti el.';

export interface ReportResult {
  from: IsoDate;
  to: IsoDate;
  dateBasis: DateBasis;
  /** The documents counted ('payment': the documents issued under cash accounting a counted payment went to). */
  invoiceCount: number;
  /** 'payment' only: the payments counted (each payment once, however many documents it went to). */
  paymentCount?: number;
  /** 'payment': the proportional HUF figures of the counted payments (PAYMENT_BASIS_NOTE). */
  totalsHuf: { net: string; vat: string; gross: string };
  byVatCode: Array<{ vatCode: VatCode; net: string; vat: string; gross: string }>;
  /** Months of the date chosen by dateBasis ('payment': the payment date; count: the documents). */
  byMonth: Array<{ month: string; count: number; net: string; vat: string; gross: string }>;
  topCustomers: Array<{ name: string; taxNumber: string | null; count: number; gross: string }>;
  /**
   * Receivables today, independent of the period. Counts: documents something is owed on (positive
   * totals – the same documents invoice_list lists as unpaid / overdue); amounts: what is outstanding on
   * them, settled with their invoice chain (credit notes set off, overpayments carried – settleChain), in
   * HUF at each document's own rate.
   */
  receivables: { unpaidCount: number; unpaidGrossHuf: string; overdueCount: number; overdueGrossHuf: string };
  /** Warnings about the figures, e.g. CASH_ACCOUNTING_VAT_NOTE. */
  notes: string[];
}

/** Result of verifyIntegrity: what `openszamla verify` reports. */
export interface IntegrityReport {
  /** True when none of the checks below found a problem. */
  ok: boolean;
  invoicesChecked: number;
  /** Issued documents whose content no longer matches their own content hash. */
  invoiceMismatches: string[];
  /**
   * Issuances recorded in the audit log that the invoice table contradicts: the document is missing,
   * or its number or content hash differs from the one recorded when it was issued.
   */
  auditMismatches: string[];
  /** Issued documents without an issuance entry in the audit log (inserted outside the program). */
  unauditedInvoices: string[];
  /** Sequence numbers missing from a number series (an issued document removed, with its log entry). */
  numberingGaps: string[];
  /** Protective database triggers that are missing or altered. */
  alteredTriggers: string[];
  /**
   * Documents whose paid amount differs from what the payment ledger allocated to them: the ledger is append-only
   * (triggers), the paid amount of a document is a plain column a database tool can overwrite.
   */
  paymentMismatches: string[];
  /** Kept original PDFs checked (their bytes against their fingerprints and the audit log). */
  documentsChecked: number;
  /**
   * Kept original PDFs the database contradicts: bytes that no longer match their SHA-256, SHA3-512 or size; an original
   * without its 'invoice.document' audit entry, or with other fingerprints there; an entry whose original is missing.
   */
  documentMismatches: string[];
  /** Not a failure: documents issued since originals are kept that have none yet (the PDF failed at issue), with the remedy. */
  documentWarnings: string[];
  /** Not a failure: the pdf/ file of a kept original is missing or differs from it (rewritten at the next PDF request). */
  documentNotes: string[];
  /** Documents issued before originals were kept: they have none (their PDF is regenerated on request). */
  legacyDocuments: number;
  /**
   * Not a failure: restores from a backup (`openszamla restore`) after which documents issued since the backup are
   * missing from the database. Their numbers are on record (the audit entry of the restore), so the gap they leave is
   * not reported among numberingGaps.
   */
  restoreWarnings: string[];
  /** The audit hash chain; `head` is its last entry – keep it with the backups to detect a cut-off end. */
  audit: { ok: boolean; entries: number; brokenAtId?: number; head: { id: number; hash: string } | null };
}

export interface OpenOptions extends LoadConfigOptions {
  config?: AppConfig;
  now?: () => Date;
  fetch?: typeof fetch;
  actor?: Actor;
}

const BUILTIN_DEFAULTS: InvoiceDefaults = {
  paymentMethod: 'TRANSFER',
  paymentDays: 8,
  language: 'hu',
  appearance: 'ELECTRONIC',
  currency: 'HUF',
  exchangeRateSource: 'MNB',
};

const MUTABLE_KEYS = [
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
  'contentHash',
] as const;

const PRODUCT_UNITS = new Set(['db', 'kg', 't', 'l', 'm', 'fm', 'm³', 'm3', 'm2', 'm²', 'karton', 'csomag', 'doboz', 'pár', 'liter']);
const SERVICE_UNITS = new Set(['óra', 'nap', 'hó', 'hónap', 'perc', 'alkalom', 'év', 'szolgáltatás', 'hét', 'projekt']);

/** Hash of the immutable part of an invoice (everything except the mutable-after-issuance fields). */
export function invoiceContentHash(inv: Invoice): string {
  const copy: Record<string, unknown> = { ...inv };
  for (const k of MUTABLE_KEYS) delete copy[k];
  return sha256Hex(canonicalJson(copy));
}

/** Nature (termék / szolgáltatás) a unit of measure suggests: db, kg … → PRODUCT; óra, nap … → SERVICE; else OTHER. */
export function inferNature(unit: string): LineNature {
  const u = unit.trim().toLowerCase().replace(/\.$/, '');
  if (PRODUCT_UNITS.has(u)) return 'PRODUCT';
  if (SERVICE_UNITS.has(u)) return 'SERVICE';
  return 'OTHER';
}

/** VAT codes that fit only one nature: EU reverse-charge and non-EU services, supplies of goods. */
const VAT_CODE_NATURE: Partial<Record<VatCode, LineNature>> = { EUFAD37: 'SERVICE', HO: 'SERVICE', KBAET: 'PRODUCT', KBAUK: 'PRODUCT', EAM: 'PRODUCT' };

/**
 * Nature of a line given without nature and product. Without a unit, or with the generic "db", a VAT
 * code that fits only one nature decides (EUFAD37 → SERVICE); otherwise a given unit does (óra →
 * SERVICE, db → PRODUCT). A line with neither is OTHER: a defaulted "db" says nothing about whether
 * e.g. consulting is a service.
 */
function lineNature(unit: string | undefined, vatCode: VatCode): LineNature {
  const given = unit?.trim() ?? '';
  const generic = given === '' || given.toLowerCase().replace(/\.$/, '') === 'db';
  const implied = VAT_CODE_NATURE[vatCode];
  if (generic && implied) return implied;
  return given ? inferNature(given) : 'OTHER';
}

/** The buyer data of a customer record, as a document stores it. */
function customerDataOf(c: Customer): CustomerData {
  const { id: _id, note: _note, archived: _a, createdAt: _c, updatedAt: _u, ...data } = c;
  return data;
}

/** The buyer data fields as messages name them (BUYER_DIFFERS_FROM_RECORD). */
const BUYER_FIELDS: ReadonlyArray<readonly [keyof CustomerData, string]> = [
  ['vatStatus', 'vevő típusa'],
  ['name', 'név'],
  ['taxNumber', 'adószám'],
  ['groupMemberTaxNumber', 'csoporttagi adószám'],
  ['euVatNumber', 'közösségi adószám'],
  ['thirdStateTaxId', 'külföldi adóazonosító'],
  ['address', 'cím'],
  ['email', 'e-mail'],
  ['phone', 'telefon'],
  ['bankAccount', 'bankszámlaszám'],
];

function issue(code: string, message: string, field?: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return field === undefined ? { severity, code, message } : { severity, code, message, field };
}

/** At most this many unprintable characters are named in a message. */
const UNPRINTABLE_LISTED = 8;

/**
 * Printed text the invoice PDF cannot show (pdf/glyphs.ts): each such character would be an empty box on the document.
 * An error where the law wants the data on the invoice – the names and addresses of the parties, the description and
 * the unit of a line (Áfa tv. 169. §) –, a warning for the rest (comment, order number, the seller's bank name, contact
 * data and footer).
 */
function pdfTextIssues(inv: Invoice): ValidationIssue[] {
  const addressText = (a: Address): string => [a.postalCode, a.city, a.addressLine, a.region ?? ''].join(' ');
  const s = inv.seller;
  const c = inv.customer;
  const checks: Array<[field: string, what: string, text: string | null | undefined, severity: 'error' | 'warning']> = [
    ['seller.name', 'Az eladó neve', s.name, 'error'],
    ['seller.address', 'Az eladó címe', addressText(s.address), 'error'],
    ['customer.name', 'A vevő neve', c.name, 'error'],
    ['customer.address', 'A vevő címe', addressText(c.address), 'error'],
    ...inv.lines.flatMap((l, k): Array<[string, string, string, 'error']> => [
      [`lines[${k}].description`, `A(z) ${k + 1}. tétel megnevezése`, l.description, 'error'],
      [`lines[${k}].unit`, `A(z) ${k + 1}. tétel mennyiségi egysége`, l.unit, 'error'],
    ]),
    ['comment', 'A megjegyzés', inv.comment, 'warning'],
    ['orderNumber', 'A megrendelésszám', inv.orderNumber, 'warning'],
    ['seller.bankName', 'Az eladó bankjának neve', s.bankName, 'warning'],
    ['seller.invoiceFooter', 'A számla lábléce', s.invoiceFooter, 'warning'],
    ['seller.contact', 'Az eladó elérhetősége (e-mail, telefon, weboldal, nyilvántartási szám)', [s.email, s.phone, s.website, s.registrationNumber].filter(Boolean).join(' '), 'warning'],
    ['customer.contact', 'A vevő elérhetősége (e-mail, telefon)', [c.email, c.phone].filter(Boolean).join(' '), 'warning'],
  ];
  const out: ValidationIssue[] = [];
  for (const [field, what, text, severity] of checks) {
    if (!text) continue;
    const missing = missingGlyphs(text);
    if (missing.length === 0) continue;
    const listed = missing.slice(0, UNPRINTABLE_LISTED).map(describeCharacter).join(', ');
    const more = missing.length > UNPRINTABLE_LISTED ? ` és még ${missing.length - UNPRINTABLE_LISTED}` : '';
    out.push(
      issue(
        'PDF_UNPRINTABLE_CHARACTERS',
        `${what} olyan karaktert tartalmaz, amelyet a számla PDF-je nem tud megjeleníteni – üres négyzet kerülne a helyére: ${listed}${more}. ` +
          'A PDF latin (ékezetes), cirill és görög betűket, számokat és a szokásos írásjeleket tud; más írásrendszerű nevet írj át latin betűkre, a különleges jelet (pl. nyíl, pipa, emoji) hagyd el vagy írd ki szóval.',
        field,
        severity,
      ),
    );
  }
  return out;
}

/** How the storno's comment introduces the reason, in the language of the invoice it cancels. */
const STORNO_REASON_LABEL: Readonly<Record<string, string>> = {
  hu: 'Sztornó oka',
  en: 'Reason for cancellation',
  'hu-en': 'Sztornó oka / Reason for cancellation',
};

/** A modification needs at least one (difference) line: NAV accepts no modification without a VAT summary row. */
function noCorrectionLines(): AppError {
  return new AppError('INVALID_INPUT', 'A módosító számlához legalább egy különbözeti tétel kell; tétel nélküli módosító számlát a NAV nem fogad be.', {
    hint: 'Fejadat (pl. teljesítési dátum, vevő címe) javításához adj meg egy 0 összegű tételt (mennyiség 1, egységár 0, az eredeti számla ÁFA-kódjával, a megnevezésben a javított adattal), vagy sztornózd a számlát és állíts ki újat.',
  });
}

/** Hint of a storno refused by validation (cancel()): there is no draft to fix, the cause named in the message is. */
const STORNO_REFUSED_HINT = 'A sztornó nem állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), majd próbáld újra.';

/**
 * cancel() with a confirmation: what the confirmation was made for (cancelFingerprint – the invoice chain, the seller
 * data, the day) changed before the storno's transaction, typically because another process issued a modification of
 * the invoice meanwhile. Nothing was issued; a new preview and confirmation make it again.
 */
function stornoChainChanged(original: Pick<Invoice, 'number'>): AppError {
  return new AppError(
    'STORNO_CHAIN_CHANGED',
    `A(z) ${original.number} számla sztornója nem készült el: a jóváhagyott előnézet óta megváltozott, amit a sztornó semlegesít – közben módosító számla készült a számlához, megváltoztak az eladó adatai, vagy új nap kezdődött.`,
    { hint: 'Kérj új sztornó-előnézetet, ellenőrizd az új összeget, és a jóváhagyás után próbáld újra az új megerősítéssel.' },
  );
}

/** The fewest visible characters of a storno or díjbekérő withdrawal reason (the MCP tools and the web ask for 3–200). */
const MIN_CANCEL_REASON = 3;

/**
 * A storno or díjbekérő withdrawal reason as it is stored, printed and shown – normalised once, here: on one
 * line (singleLine: line breaks and other control characters become a space, bidirectional formatting
 * characters are left out, the ends trimmed), every run of spaces one space. INVALID_INPUT when fewer than 3
 * visible characters remain (visibleLength: spaces, invisible formatting characters and blank-rendering ones such as
 * the Hangul filler U+3164 do not count): such a reason says nothing, and it would print as an empty "Sztornó oka:".
 */
function normalizeCancelReason(raw: string | null | undefined, proforma: boolean): string {
  const reason = singleLine(raw ?? '').replace(/\s+/g, ' ');
  if (visibleLength(reason) < MIN_CANCEL_REASON) {
    throw new AppError('INVALID_INPUT', `${proforma ? 'A visszavonás oka' : 'A sztornó oka'} legalább ${MIN_CANCEL_REASON} látható karakterből álljon.`, {
      hint: 'Add meg röviden az okot (pl. „Téves vevő”); a szóköz, a sortörés, a vezérlőkarakter és az üresen megjelenő jel (pl. U+3164) nem számít bele.',
    });
  }
  return reason;
}

/** An archived series never allocates a new number: it cannot be chosen, and no draft is issued from it. */
function seriesArchived(series: Series): AppError {
  return new AppError('SERIES_ARCHIVED', `A(z) "${series.name}" sorszámtartomány archivált.`, {
    hint: 'Válassz aktív sorszámtartományt (új piszkozat az alapértelmezettet kapja), vagy szüntesd meg ennek a sorszámtartománynak az archiválását.',
    details: { seriesId: series.id },
  });
}

/**
 * A storno / modification uses the exchange rate of its original (it corrects that supply, whose tax point
 * the rate belongs to): no other rate can be given. A wrong rate is corrected with a storno and a new invoice.
 */
function correctionRateFixed(originalNumber: string, original: { currency: string; exchangeRate: string }, given: string): AppError {
  const rate = original.currency === 'HUF' ? 'forintos számla, árfolyama 1' : `1 ${original.currency} = ${original.exchangeRate} HUF`;
  return new AppError('CORRECTION_EXCHANGE_RATE_FIXED', `A módosító és a sztornó számla az eredeti számla (${originalNumber}) árfolyamát használja (${rate}); más árfolyam nem adható meg (megadva: ${given}).`, {
    hint: 'Hagyd el az exchangeRate mezőt. Ha az eredeti számla árfolyama hibás, azt módosító számla nem javítja: sztornózd a számlát (invoice_cancel), és állíts ki új számlát a helyes árfolyammal.',
  });
}

function lineInputOf(l: InvoiceLine): InvoiceLineInput {
  const out: InvoiceLineInput = {
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
    priceBasis: l.priceBasis,
    vatCode: l.vatCode,
    nature: l.nature,
  };
  if (l.productId !== undefined) out.productId = l.productId;
  if (l.vatReason !== undefined) out.vatReason = l.vatReason;
  if (l.modifiesLineNo !== undefined) out.modifiesLineNo = l.modifiesLineNo;
  if (l.advanceDeduction !== undefined) out.advanceDeduction = l.advanceDeduction;
  return out;
}

/**
 * Seller data of a storno / modification of `original`: the current identity data (name, address, bank
 * account …) with the VAT regime the original was issued under (VAT status, cash accounting, KATA). The
 * correction belongs to the original supply, so its notations, line VAT codes and NAV header
 * (individualExemption, cashAccountingIndicator, smallBusinessIndicator) must follow the original even
 * when the seller's status changed since (e.g. AAM → normal after passing the threshold).
 */
function correctionSeller(original: Invoice, current: SellerProfile): SellerProfile {
  return { ...current, vatStatus: original.seller.vatStatus, cashAccounting: original.seller.cashAccounting, smallBusiness: original.seller.smallBusiness };
}

/** A customer update (saveCustomer with an id): the given fields over the stored customer. */
function mergeCustomerInput(prev: Customer, input: CustomerInput): CustomerInput {
  const merged: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) merged[k] = v;
  if (input.address && !input.address.countryCode?.trim()) merged.address = { ...input.address, countryCode: prev.address.countryCode };
  return merged as unknown as CustomerInput;
}

function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** UNC and device paths: \\server\share, //server/share, \\?\…, \\.\… – never a plain local folder. */
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}/;

/**
 * The real path of the folder a PDF may be copied to (copyToDir): an existing, absolute, local
 * directory. A UNC or device path is refused before the file system is touched – on Windows even
 * checking that one exists connects to the named host (SMB) and offers the user's credentials – and so
 * is a folder that a symbolic link or junction turns into a network share.
 */
function localCopyDir(dir: string): string {
  const network = (): AppError =>
    new AppError('INVALID_INPUT', `Hálózati (UNC) vagy eszközútvonalra nem másolható a PDF: ${dir}`, {
      hint: 'Adj meg egy létező helyi mappát abszolút útvonallal, pl. C:\\Users\\Nev\\Documents\\Szamlak vagy /home/nev/szamlak.',
    });
  if (NETWORK_OR_DEVICE_PATH.test(dir) || NETWORK_OR_DEVICE_PATH.test(resolve(dir))) throw network();
  if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new AppError('INVALID_INPUT', `A célmappa nem létezik vagy nem abszolút útvonal: ${dir}`);
  }
  const real = realpathSync(dir);
  if (NETWORK_OR_DEVICE_PATH.test(real)) throw network();
  return real;
}

/** Copies a file without ever overwriting another one; an identical earlier copy counts as done. */
function copyWithoutOverwrite(src: string, dest: string, content: Buffer): void {
  try {
    copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (statSync(dest).size === content.length && readFileSync(dest).equals(content)) return;
    throw new AppError('FILE_EXISTS', `A célmappában már van ${basename(dest)} nevű, eltérő tartalmú fájl; a program nem írja felül.`, {
      hint: 'Válassz másik mappát, vagy nevezd át, illetve töröld a meglévő fájlt.',
    });
  }
}

/** Writes `content` to `path` unless the file holds exactly these bytes already; true when it wrote. */
function writeUnlessSame(path: string, content: Buffer): boolean {
  try {
    if (statSync(path).size === content.length && readFileSync(path).equals(content)) return false;
  } catch {
    // missing (or unreadable): written below
  }
  writeFileSync(path, content);
  return true;
}

/** Export warning: the document's file is not named after its number alone (OpenSzamla.fileStems). */
function renamedFile(inv: Invoice, stem: string): Szamla2013Warning {
  return {
    invoiceNumber: inv.number as string,
    field: 'file',
    message: `A fájlok neve ${stem}: a sorszámból képzett „${safeFileName(inv.number as string)}” fájlnév egy korábban kiállított bizonylaté (a fájlnevekben a „/” helyén „_” áll, és a kis- és nagybetű nem különbözik).`,
  };
}

function dateBasisOf(v: string | undefined): DateBasis {
  if (v === undefined || v === 'issue' || v === 'fulfillment' || v === 'payment') return v ?? 'issue';
  throw new AppError('INVALID_INPUT', `Ismeretlen dátumalap: ${v}`, {
    hint: '"issue" (kelte szerint, alapértelmezés), "fulfillment" (teljesítés dátuma szerint) vagy "payment" (befizetés dátuma szerint, pénzforgalmi elszámolás).',
  });
}

/**
 * The document carries the cash-accounting notation (pénzforgalmi elszámolás – buildNotations, cashAccountingIndicator): its
 * seller accounted on a cash basis and it has a line taxed at a percentage rate. Its VAT is due by payment date.
 */
function issuedUnderCashAccounting(inv: Pick<Invoice, 'seller' | 'lines'>): boolean {
  return inv.seller.cashAccounting === true && inv.lines.some((l) => isVatCode(l.vatCode) && isPercentageCode(l.vatCode));
}

/**
 * The proportional HUF figures of `amount` (a part of a payment, in the document's currency) of `inv`: per VAT code of the
 * document amount × its HUF net, VAT and gross ÷ the document's gross total, each rounded to 0.01 Ft – the VAT share of a
 * payment (PAYMENT_BASIS_NOTE).
 */
function allocationShare(inv: Pick<Invoice, 'totals'>, amount: DecValue): { net: DecValue; vat: DecValue; gross: DecValue; byVat: Array<{ vatCode: VatCode; net: DecValue; vat: DecValue; gross: DecValue }> } {
  const gross = dec(inv.totals.grossAmount);
  const part = (huf: string): DecValue => (gross.isZero() ? dec(0) : roundDec(amount.times(huf).div(gross), 2));
  const byVat = inv.totals.byVat.map((r) => ({ vatCode: r.vatCode, net: part(r.netAmountHuf), vat: part(r.vatAmountHuf), gross: part(r.grossAmountHuf) }));
  return { net: sumDec(byVat.map((r) => r.net)), vat: sumDec(byVat.map((r) => r.vat)), gross: sumDec(byVat.map((r) => r.gross)), byVat };
}

/** A CSV cell of the payment ledger export – the same rule as the invoice export (exportInvoices): a formula-like text gets an apostrophe. */
function ledgerCell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A period (both days inclusive) must not end before it starts: a reversed one would silently select
 * nothing and read as "no turnover". The same day as start and end is a one-day period.
 */
function assertPeriod(from: IsoDate, to: IsoDate): void {
  if (from <= to) return;
  throw new AppError('INVALID_INPUT', `A kezdő dátum (${from}) későbbi a záró dátumnál (${to}).`, {
    hint: 'Add meg az időszakot időrendben: a kezdő nap (from) nem lehet későbbi a záró napnál (to) – a két dátum valószínűleg felcserélődött. Egynapos időszaknál a kettő ugyanaz a nap.',
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Settles when `p` does, or when the moment `until` (Date.now()) has come – whichever is first. */
function settledBy(p: Promise<unknown>, until: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, until - Date.now()));
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

/** Internal, not-yet-computed representation of a draft. */
interface DraftState {
  documentType: DocumentType;
  seriesId: string;
  customerId: string | null;
  customer: CustomerData;
  /**
   * Invoice.customerFromRecord: true – the buyer is the customer record customerId; false – inline buyer
   * data (stored as such on the draft); null – not stored: a draft saved before drafts followed their record
   * (flagRecordBuyerDrafts decides), and every issued document (a draft-only flag).
   */
  customerFromRecord: boolean | null;
  /**
   * saveCustomer of this input: the customer is stored together with the draft, in its transaction
   * (createDraft / updateDraft), so a rejected draft leaves no customer behind. `id`: the new customer's id.
   */
  customerSave?: { input: CustomerInput; id: string };
  issueDate: IsoDate;
  fulfillmentDate: IsoDate;
  dueDate: IsoDate | null;
  /** The due date was given as a date (not derived from the payment term): issuing later keeps it. */
  dueDateExplicit: boolean;
  paymentMethod: Invoice['paymentMethod'];
  currency: string;
  exchangeRate: string;
  exchangeRateDate: IsoDate | null;
  exchangeRateSource: Invoice['exchangeRateSource'];
  language: Invoice['language'];
  appearance: Invoice['appearance'];
  comment: string | null;
  internalNote: string | null;
  orderNumber: string | null;
  reference: InvoiceReference | null;
  lines: InvoiceLineInput[];
  /** Invoice.proformaId: the díjbekérő the draft was converted from. */
  proformaId: string | null;
}

/** Payment status as said in notes (the web labels them the same way). */
const PAYMENT_STATUS_TEXT: Readonly<Record<Invoice['paymentStatus'], string>> = { unpaid: 'fizetetlen', partial: 'részben fizetve', paid: 'fizetve' };

/**
 * Why issuing a document converted from a paid díjbekérő does not carry its payment over: another document
 * was already made from it, it was withdrawn, another currency, another buyer, nothing payable, or the
 * document deducts an advance (the díjbekérő payment is probably that advance: it belongs on the előlegszámla).
 */
type ProformaSkip = 'invoiced' | 'cancelled' | 'currency' | 'buyer' | 'payable' | 'advance';

/**
 * The advance deductions of a document (its advanceDeduction lines): the előlegszámla numbers they name (on
 * one line, each once) and the field of the first such line; null when it deducts no advance.
 */
function advanceDeductions(inv: Pick<Invoice, 'lines'>): { numbers: string[]; field: string } | null {
  const first = inv.lines.findIndex((l) => l.advanceDeduction);
  if (first < 0) return null;
  const numbers = new Set<string>();
  for (const l of inv.lines) {
    const no = l.advanceDeduction && typeof l.advanceDeduction.advanceInvoiceNumber === 'string' ? singleLine(l.advanceDeduction.advanceInvoiceNumber) : '';
    if (no) numbers.add(no);
  }
  return { numbers: [...numbers], field: `lines[${first}].advanceDeduction` };
}

/** A buyer's tax number for comparing buyers: the törzsszám of a Hungarian one, otherwise as written (EU, third country). */
function buyerTaxId(c: CustomerData): string | null {
  const hu = c.taxNumber?.trim() ? parseHuTaxNumber(c.taxNumber) : null;
  if (hu?.ok) return `HU${hu.value.taxpayerId}`;
  const id = (c.euVatNumber || c.thirdStateTaxId || c.taxNumber || '').replace(/[\s.-]/g, '').toUpperCase();
  return id || null;
}

/**
 * The same buyer on two documents (a díjbekérő and the document converted from it): the same customer
 * record when both have one, otherwise the same tax number when both have one, otherwise the same name
 * (case and spacing aside).
 */
function sameBuyer(a: Pick<Invoice, 'customerId' | 'customer'>, b: Pick<Invoice, 'customerId' | 'customer'>): boolean {
  if (a.customerId && b.customerId) return a.customerId === b.customerId;
  const taxA = buyerTaxId(a.customer);
  const taxB = buyerTaxId(b.customer);
  if (taxA && taxB) return taxA === taxB;
  const name = (c: CustomerData): string => c.name.replace(/\s+/g, ' ').trim().toLowerCase();
  return name(a.customer) === name(b.customer);
}

/**
 * What is open on a document (`open`, in its currency) in HUF, as the receivables of report() add it up: on a forint
 * document the open amount itself; on a foreign-currency document nothing of which is settled yet its own HUF gross
 * (totals.grossAmountHuf – the sum of its lines' HUF values, which may differ by a few fillér from gross × rate);
 * otherwise the open part at its rate, rounded to 0.01 Ft.
 */
function hufOpen(inv: Pick<Invoice, 'currency' | 'exchangeRate' | 'totals'>, open: DecValue): DecValue {
  if (inv.currency.trim().toUpperCase() === 'HUF') return open;
  if (open.eq(inv.totals.payableAmount)) return dec(inv.totals.grossAmountHuf);
  return roundDec(open.times(inv.exchangeRate), 2);
}

/** Invoice chains settled per transaction by the one-time pass of settleStoredPaymentChains. */
const SETTLE_BATCH = 50;

/** Logged payments taken into the payment ledger per transaction by the one-time pass of backfillPaymentLedger. */
const LEDGER_BATCH = 500;

/** PDFs taxAuditExport renders at the same time (documents without a kept original); the kept ones are copied. */
const PDF_RENDER_CONCURRENCY = 4;

/**
 * Why no payment can be recorded on `inv` at all (recordPayment): a draft or a cancelled document; else null. On a storno
 * only the refund of what its cancelled invoice received can be recorded (applyPayment: stornoPayment).
 */
function paymentRefusal(inv: Pick<Invoice, 'status' | 'documentType'>): AppError | null {
  if (inv.status === 'draft') return new AppError('INVALID_INPUT', 'Piszkozatra nem rögzíthető fizetés.');
  if (inv.status !== 'issued') {
    // A withdrawn díjbekérő has no storno.
    if (inv.documentType === 'proforma') return new AppError('INVALID_INPUT', 'Sztornózott számlára nem rögzíthető fizetés.');
    return new AppError('INVALID_INPUT', 'Sztornózott számlára nem rögzíthető fizetés.', {
      hint: 'Ha a vevő befizetését visszafizették, a visszafizetést a számla sztornó számláján rögzítsd, negatív összeggel.',
    });
  }
  return null;
}

/** A payment may precede its document (an advance, cash on delivery) by at most this many days: beyond it the year is mistyped. */
const PAYMENT_BEFORE_ISSUE_MAX_DAYS = 366;

/** Above every stored payment id: the payments applyPayment is about to store, in their order (settleLedger needs an id). */
const PENDING_PAYMENT_ID = 2 ** 52;

/** How a payment of the ledger is named (history, ledger export): by its sign and the document it was recorded on. */
export type PaymentKind = 'payment' | 'refund' | 'reversal' | 'settled';

export const PAYMENT_KIND_TEXT: Readonly<Record<PaymentKind, string>> = {
  payment: 'befizetés',
  refund: 'visszafizetés a vevőnek',
  reversal: 'visszavonás',
  settled: 'rendezettnek jelölve',
};

export const PAYMENT_SOURCE_TEXT: Readonly<Record<PaymentSource, string>> = {
  manual: 'rögzítve',
  mark_paid: 'a kiállításkor rögzítve',
  proforma: 'a díjbekérőről átvéve',
};

/** The kind of `amount` recorded on a document of payable `payable`: money from the buyer, a refund to the buyer, or a reversal. */
function paymentKind(amount: DecValue, payable: DecValue): PaymentKind {
  if (amount.isZero()) return 'settled';
  if (payable.isNegative()) return amount.isNegative() ? 'refund' : 'reversal';
  return amount.isNegative() ? 'reversal' : 'payment';
}

/** A payment as the payment history of a document shows it (OpenSzamla.paymentHistory). */
export interface PaymentHistoryEntry {
  paymentId: number;
  date: IsoDate;
  /** What the payment brought to this document (its allocation); "0" when it went to the other documents of the chain. */
  amount: string;
  /** The whole payment, and the document it was recorded on (another document of the chain, or this one). */
  paymentAmount: string;
  recordedOn: { id: string; number: string | null };
  kind: PaymentKind;
  source: PaymentSource;
  /** The díjbekérő a carried payment came from. */
  reference: string | null;
  recordedAt: IsoTimestamp;
}

/**
 * A payment of the ledger export (OpenSzamla.paymentLedger): the payment and what it brought to each document of its
 * chain, with the proportional HUF figures of each part (allocationShare).
 */
export interface LedgerEntry {
  id: number;
  date: IsoDate;
  amount: string;
  currency: string;
  kind: PaymentKind;
  source: PaymentSource;
  reference: string | null;
  recordedOn: { id: string; number: string | null; documentType: DocumentType };
  recordedAt: IsoTimestamp;
  allocations: Array<{
    invoice: { id: string; number: string | null; documentType: DocumentType; status: Invoice['status'] };
    amount: string;
    exchangeRate: string;
    /** The document was issued under cash accounting (pénzforgalmi elszámolás): its VAT is due by payment date. */
    cashAccounting: boolean;
    huf: { net: string; vat: string; gross: string };
    byVatCode: Array<{ vatCode: VatCode; net: string; vat: string; gross: string }>;
  }>;
}

export class OpenSzamla {
  readonly store: Store;
  #config: AppConfig;
  readonly #navSettings: NavSettingsWatch | null;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly mnb: MnbClient;
  readonly actor: Actor;

  constructor(store: Store, config: AppConfig, opts: { now?: () => Date; fetch?: typeof fetch; actor?: Actor; navSettings?: NavSettingsWatch } = {}) {
    this.store = store;
    this.#config = config;
    this.#navSettings = opts.navSettings ?? null;
    this.now = opts.now ?? (() => new Date());
    this.fetchImpl = opts.fetch;
    this.actor = opts.actor ?? 'system';
    this.mnb = new MnbClient(opts.fetch ? { fetch: opts.fetch } : {});
    this.ensureDefaultSeries();
    this.backfillPaymentLedger();
    this.settleStoredPaymentChains();
    this.flagRecordBuyerDrafts();
  }

  /**
   * The configuration. When the NAV settings come from <dataDir>/nav-credentials.json, they follow that file: what
   * `openszamla nav-setup` saves while an MCP server or `openszamla serve` runs takes effect at once (NavSettingsWatch),
   * without a restart.
   */
  get config(): AppConfig {
    const next = this.#navSettings?.refresh(this.#config);
    if (next) this.#config = next;
    return this.#config;
  }

  /** Opens (creating if needed) the data directory and database. */
  static open(opts: OpenOptions = {}): OpenSzamla {
    const config = opts.config ?? loadConfig(opts);
    ensureDataDir(config.dataDir);
    if (config.dbPath !== ':memory:') ensureDataDir(dirname(config.dbPath), 'Az adatbázis mappája');
    const store = new Store({ path: config.dbPath, ...(opts.now ? { now: opts.now } : {}) });
    const extra: { now?: () => Date; fetch?: typeof fetch; actor?: Actor; navSettings?: NavSettingsWatch } = {};
    if (opts.now) extra.now = opts.now;
    if (opts.fetch) extra.fetch = opts.fetch;
    if (opts.actor) extra.actor = opts.actor;
    // A configuration given as a whole, or NAV settings fixed by the caller (tests) or by variables, stay as they are.
    if (!opts.config && followsNavCredentialsFile(opts)) extra.navSettings = new NavSettingsWatch(config.dataDir, opts.env ?? process.env);
    return new OpenSzamla(store, config, extra);
  }

  close(): void {
    this.store.close();
  }

  today(): IsoDate {
    return huDate(this.now());
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private audit(action: string, entityType: AuditEntry['entityType'], entityId: string | null, details: Record<string, unknown>, actor?: Actor): void {
    this.store.audit({ actor: actor ?? this.actor, action, entityType, entityId, details });
  }

  // ===========================================================================================
  // Setup
  // ===========================================================================================

  /**
   * Every kind needs a default series. A new one is created only when the kind has none at all: an active
   * series is promoted instead, or an archived one whose numbers the new default would repeat is brought
   * back (continuing its numbering) – a fresh series with the same pattern would restart at 1 and collide
   * with the numbers already issued (invoice numbers are unique).
   */
  private ensureDefaultSeries(): void {
    const created = this.ts();
    const defaults = [
      { kind: 'invoice', name: 'Számlák', pattern: DEFAULT_INVOICE_PATTERN },
      { kind: 'proforma', name: 'Díjbekérők', pattern: DEFAULT_PROFORMA_PATTERN },
    ] as const;
    for (const { kind, name, pattern } of defaults) {
      if (this.store.getDefaultSeries(kind)) continue;
      const existing = this.store.listSeries(kind, true);
      const pick = existing.find((s) => !s.archived) ?? existing.find((s) => patternsOverlap(s.pattern, pattern));
      if (pick) {
        this.store.updateSeries({ ...pick, isDefault: true, archived: false });
        this.audit('series.update', 'series', pick.id, { patch: { isDefault: true, archived: false }, reason: 'no default series' });
        continue;
      }
      this.store.insertSeries({ id: newId('ser'), kind, name, pattern, yearlyReset: true, nextSeq: 1, seqYear: null, isDefault: true, archived: false, createdAt: created });
    }
  }

  /**
   * Payment statuses stored before invoice chains were settled together (each document on its own):
   * once per database, every original invoice with issued modifications is settled with its chain
   * (settleChain); each change is logged ('invoice.payment.status'). The chains are settled in short
   * transactions of SETTLE_BATCH chains, so another process is never kept waiting for the whole pass; each
   * one reads the key again, so a pass another process finished meanwhile is not repeated (settling a chain
   * twice changes nothing). An error leaves the rest for the next start.
   */
  private settleStoredPaymentChains(): void {
    const KEY = 'paymentChainsSettled';
    try {
      if (this.store.getSetting(KEY) !== null) return;
      const originals = new Set<string>();
      this.store.forEachInvoice({ status: ['issued'], documentType: ['modification'], sort: 'issued_asc' }, (m) => {
        if (m.reference) originals.add(m.reference.originalInvoiceId);
      });
      const ids = [...originals];
      for (let i = 0, done = false; !done; i += SETTLE_BATCH) {
        done = this.store.tx(() => {
          if (this.store.getSetting(KEY) !== null) return true;
          for (const id of ids.slice(i, i + SETTLE_BATCH)) {
            const original = this.store.getInvoice(id);
            if (original) this.settleChainOf(original, null, 'system');
          }
          if (i + SETTLE_BATCH < ids.length) return false;
          this.store.setSetting(KEY, 1);
          return true;
        });
      }
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }

  /**
   * Payments recorded before the payment ledger existed (schema 4) are only in the audit log ('invoice.payment'): once per
   * database, every one of them is taken into the ledger in the order of the log (LEDGER_BATCH entries per transaction),
   * then each chain whose payments are not allocated yet is settled from the ledger (allocations, paid amounts, payment
   * dates and statuses; a changed status is logged as 'invoice.payment.status', actor system), SETTLE_BATCH chains per
   * transaction, with one 'payment.ledger' entry at the end. Every transaction reads the key again, like
   * settleStoredPaymentChains, and an entry is never taken over twice (its payments row names it), so a pass another
   * process runs or finished meanwhile changes nothing. An error leaves the rest for the next start – until then a payment
   * on such a chain takes over the chain's entries first (syncLedger).
   */
  private backfillPaymentLedger(): void {
    const KEY = 'paymentLedger';
    try {
      if (this.store.getSetting(KEY) !== null) return;
      let taken = 0;
      for (let after = 0; after >= 0; ) {
        after = this.store.tx(() => {
          if (this.store.getSetting(KEY) !== null) return -1;
          const r = this.syncLedger(undefined, { afterId: after, limit: LEDGER_BATCH });
          taken += r.taken;
          return r.seen < LEDGER_BATCH ? -1 : r.lastId;
        });
      }
      const roots = new Set<string>();
      for (const id of this.store.unallocatedPaymentInvoices()) {
        const inv = this.store.getInvoice(id);
        if (inv) roots.add(inv.reference?.originalInvoiceId ?? inv.id);
      }
      const chains = [...roots];
      for (let i = 0, done = false; !done; i += SETTLE_BATCH) {
        done = this.store.tx(() => {
          if (this.store.getSetting(KEY) !== null) return true;
          for (const id of chains.slice(i, i + SETTLE_BATCH)) {
            const root = this.store.getInvoice(id);
            if (root) this.settleChainOf(root, null, 'system');
          }
          if (i + SETTLE_BATCH < chains.length) return false;
          this.store.setSetting(KEY, 1);
          if (taken > 0 || chains.length > 0) this.audit('payment.ledger', 'invoice', null, { payments: taken, chains: chains.length }, 'system');
          return true;
        });
      }
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }

  getSeller(): SellerProfile | null {
    return this.store.getSetting<SellerProfile>('seller');
  }

  private requireSeller(): SellerProfile {
    const s = this.getSeller();
    if (!s) {
      throw new AppError('SELLER_NOT_CONFIGURED', 'Az eladó (saját cég) adatai még nincsenek beállítva.', {
        hint: 'Először állítsd be az eladó adatait (név, adószám, cím, ÁFA-státusz) – parancssorban: openszamla init.',
      });
    }
    return s;
  }

  getDefaults(): InvoiceDefaults {
    return { ...BUILTIN_DEFAULTS, ...(this.store.getSetting<Partial<InvoiceDefaults>>('invoiceDefaults') ?? {}) };
  }

  updateDefaults(patch: Partial<InvoiceDefaults>, actor?: Actor): InvoiceDefaults {
    if (patch.paymentDays !== undefined && (!Number.isInteger(patch.paymentDays) || patch.paymentDays < 0 || patch.paymentDays > 365)) {
      throw new AppError('INVALID_INPUT', 'A fizetési határidő napjainak száma 0 és 365 közötti egész szám legyen.');
    }
    const next = { ...this.getDefaults(), ...patch };
    this.store.setSetting('invoiceDefaults', next);
    this.audit('settings.defaults', 'settings', null, { patch }, actor);
    return next;
  }

  /** Creates or updates the seller profile. Returns the profile and remaining validation issues. */
  updateSeller(input: SellerInput, actor?: Actor): { seller: SellerProfile; issues: ValidationIssue[] } {
    const prev = this.getSeller();
    const merged: Record<string, unknown> = { ...(prev ?? { vatStatus: 'normal', cashAccounting: false, smallBusiness: false }) };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (v === null || v === '') delete merged[k];
      else merged[k] = typeof v === 'string' ? v.trim() : v;
    }
    if (typeof merged.taxNumber === 'string') {
      const p = parseHuTaxNumber(merged.taxNumber);
      if (!p.ok) throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen adószám: ${p.error}`, { hint: 'Formátum: 12345676-1-23.' });
      if (!p.value.vatCode || !p.value.countyCode) {
        throw new AppError('INVALID_TAX_NUMBER', 'Az eladó adószámát teljes formában add meg (12345676-1-23).');
      }
      merged.taxNumber = p.value.formatted;
    }
    if (typeof merged.groupMemberTaxNumber === 'string') {
      const p = parseHuTaxNumber(merged.groupMemberTaxNumber);
      if (!p.ok) throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen csoporttagi adószám: ${p.error}`);
      merged.groupMemberTaxNumber = p.value.formatted;
    }
    if (typeof merged.euVatNumber === 'string') {
      const p = parseEuVatNumber(merged.euVatNumber);
      if (!p.ok) throw new AppError('INVALID_EU_VAT_NUMBER', `Érvénytelen közösségi adószám: ${p.error}`, { hint: 'Formátum: HU12345676.' });
      merged.euVatNumber = p.value.formatted;
    }
    if (typeof merged.bankAccount === 'string') {
      const p = parseBankAccount(merged.bankAccount);
      if (!p.ok) throw new AppError('INVALID_BANK_ACCOUNT', `Érvénytelen bankszámlaszám: ${p.error}`, { hint: 'Formátum: 2×8 vagy 3×8 számjegy (pl. 11773016-11111018) vagy IBAN.' });
      merged.bankAccount = p.value.formatted;
    }
    const seller = merged as unknown as SellerProfile;
    const issues = validateSeller(seller);
    this.store.setSetting('seller', seller);
    this.audit(prev ? 'seller.update' : 'seller.create', 'settings', null, { fields: Object.keys(input) }, actor);
    return { seller, issues };
  }

  listSeries(kind?: SeriesKind): Series[] {
    return this.store.listSeries(kind);
  }

  /**
   * Invoice numbers are unique across all series, and a number taken by another series blocks a series
   * for good (the sequence cannot skip it). So a series may not share numbers with any other active
   * series (of either kind), and its next number must still be free (e.g. not issued by an archived one).
   */
  private assertSeriesNumbersFree(s: Series): void {
    for (const other of this.store.listSeries()) {
      if (other.id === s.id || !patternsOverlap(s.pattern, other.pattern)) continue;
      throw new AppError(
        'SERIES_PATTERN_OVERLAP',
        `A(z) "${s.pattern}" mintából képzett sorszámok egybeeshetnek a(z) "${other.name}" sorszámtartomány (${other.pattern}) sorszámaival; a számlaszámnak minden sorszámtartományban egyedinek kell lennie.`,
        { hint: 'Adj a mintának saját, a többitől eltérő állandó részt (előtagot), pl. "WEB-{YYYY}-{SEQ:5}".', details: { conflictingSeriesId: other.id } },
      );
    }
    const year = Number(this.today().slice(0, 4));
    if (s.seqYear !== null && year < s.seqYear) return;
    const number = formatNumber(s.pattern, s.yearlyReset && s.seqYear !== null && year > s.seqYear ? 1 : s.nextSeq, year);
    const taken = this.store.getInvoiceByNumber(number);
    if (taken) {
      throw new AppError('SERIES_NUMBER_TAKEN', `A sorszámtartomány következő sorszáma (${number}) már foglalt: ezzel a sorszámmal már van bizonylat.`, {
        hint: 'Adj meg nagyobb kezdő sorszámot (startSeq), vagy válassz eltérő mintát.',
        details: { existingInvoiceId: taken.id },
      });
    }
  }

  createSeries(input: SeriesInput, actor?: Actor): Series {
    const yearlyReset = input.yearlyReset ?? /\{YY(YY)?\}/.test(input.pattern);
    const errors = validatePattern(input.pattern, yearlyReset).filter((i) => i.severity === 'error');
    if (errors.length) throw new AppError('INVALID_SERIES_PATTERN', errors.map((e) => e.message).join(' '), { details: { issues: errors } });
    const startSeq = input.startSeq ?? 1;
    if (!Number.isInteger(startSeq) || startSeq < 1) throw new AppError('INVALID_INPUT', 'A kezdő sorszám pozitív egész szám legyen.');
    const s: Series = {
      id: newId('ser'), kind: input.kind, name: input.name.trim(), pattern: input.pattern, yearlyReset,
      nextSeq: startSeq, seqYear: null, isDefault: false, archived: false, createdAt: this.ts(),
    };
    this.assertSeriesNumbersFree(s);
    this.store.insertSeries(s);
    if (input.isDefault) this.store.updateSeries({ ...s, isDefault: true });
    // startSeq: where the numbering starts (verifyIntegrity looks for gaps from here); yearlyReset: how it
    // continues into a new year until the first switch (verifyIntegrity replays the switches from here).
    this.audit('series.create', 'series', s.id, { name: s.name, pattern: s.pattern, kind: s.kind, startSeq, yearlyReset }, actor);
    return this.store.getSeries(s.id) as Series;
  }

  updateSeries(id: string, patch: SeriesPatch, actor?: Actor): Series {
    const s = this.store.getSeries(id);
    if (!s) throw notFound('Sorszámtartomány', id);
    const next: Series = { ...s };
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.pattern !== undefined) next.pattern = patch.pattern;
    if (patch.yearlyReset !== undefined) next.yearlyReset = patch.yearlyReset;
    if (patch.isDefault !== undefined) next.isDefault = patch.isDefault;
    if (patch.archived !== undefined) next.archived = patch.archived;
    const errors = validatePattern(next.pattern, next.yearlyReset).filter((i) => i.severity === 'error');
    if (errors.length) throw new AppError('INVALID_SERIES_PATTERN', errors.map((e) => e.message).join(' '), { details: { issues: errors } });
    if (s.isDefault && !next.isDefault) {
      // A kind without a default series could not issue at all (and the next start would create one).
      throw new AppError('INVALID_INPUT', 'Az alapértelmezett sorszámtartomány nem kapcsolható ki: mindig kell egy alapértelmezett.', {
        hint: 'Állíts be helyette egy másik sorszámtartományt alapértelmezettnek (isDefault: true) – ez akkor automatikusan nem alapértelmezett lesz, és archiválható.',
      });
    }
    if (next.archived && next.isDefault) throw new AppError('INVALID_INPUT', 'Az alapértelmezett sorszámtartomány nem archiválható.');
    if (!next.archived && (next.pattern !== s.pattern || s.archived)) this.assertSeriesNumbersFree(next);
    this.store.updateSeries(next);
    this.audit('series.update', 'series', id, { patch }, actor);
    return this.store.getSeries(id) as Series;
  }

  status(): SetupStatus {
    const seller = this.getSeller();
    const sellerIssues = seller ? validateSeller(seller) : [];
    const count = (f: Partial<InvoiceFilter>): number => this.store.findInvoices({ limit: 1, offset: 0, ...f }).total;
    const cfg = this.config;
    const nav = cfg.nav;
    // An invoice whose NAV state belongs to the other NAV system (e.g. reported only to the test one) is neither
    // pending nor a problem here: it is counted apart (navOtherEnvironment, see navNextSteps).
    const env = nav && !cfg.navProblem ? nav.environment : null;
    const navCount = (navStatus: NavStatus[]): number => count(env ? { navSelect: [{ navStatus, environment: env }] } : { navStatus });
    const counts = {
      customers: this.store.findCustomers({ limit: 1, offset: 0 }).total,
      products: this.store.findProducts({ limit: 1, offset: 0 }).total,
      drafts: count({ status: ['draft'] }),
      issued: count({ status: ['issued', 'cancelled'] }),
      // Documents something is owed on: no díjbekérő, storno, crediting modification or 0 Ft invoice.
      unpaid: count({ receivable: true, paymentStatus: ['unpaid', 'partial'] }),
      navPending: navCount(['pending', 'processing']),
      navProblems: navCount(['aborted', 'error', 'not_configured']),
      navNotConfigured: navCount(['not_configured']),
      navOtherEnvironment: env ? count({ navSelect: [{ navStatus: NAV_REPORTABLE, otherEnvironment: env }] }) : 0,
    };
    const nextSteps: string[] = [];
    const todos: SetupTodo[] = [];
    const sellerErrors = sellerIssues.filter((i) => i.severity === 'error').length;
    if (!seller) {
      nextSteps.push('Állítsd be az eladó adatait (seller_update): név, adószám, cím, ÁFA-státusz (normal / aam), bankszámla.');
      todos.push({ code: 'SELLER_MISSING', count: 0 });
    } else if (sellerErrors > 0) {
      nextSteps.push('Javítsd az eladói adatok hibáit (sellerIssues).');
      todos.push({ code: 'SELLER_INVALID', count: sellerErrors });
    }
    const navSteps = this.navNextSteps(cfg);
    nextSteps.push(...navSteps.steps);
    todos.push(...navSteps.todos);
    return {
      version: VERSION,
      dataDir: cfg.dataDir,
      dbPath: cfg.dbPath,
      seller,
      sellerIssues,
      defaults: this.getDefaults(),
      series: this.store.listSeries(),
      nav: {
        configured: !!nav && !cfg.navProblem,
        environment: nav?.environment ?? null,
        source: nav?.source ?? null,
        autoSubmit: cfg.navAutoSubmit,
        problem: cfg.navProblem,
      },
      counts,
      nextSteps,
      todos,
      notes: seller?.cashAccounting === true ? [CASH_ACCOUNTING_VAT_NOTE] : [],
    };
  }

  // ===========================================================================================
  // Customers & products
  // ===========================================================================================

  private normalizeCustomer(input: CustomerInput): CustomerData {
    if (!input.vatStatus) {
      throw new AppError('INVALID_INPUT', 'A vevő típusa (vatStatus) kötelező.', {
        hint: 'DOMESTIC = belföldi áfaalany (adószámmal), OTHER = külföldi vagy nem áfaalany szervezet, PRIVATE_PERSON = magánszemély.',
      });
    }
    // Name and address on one line (singleLine): line breaks and other control characters become a space.
    const name = singleLine(input.name ?? '');
    if (!name) throw new AppError('INVALID_INPUT', 'A vevő neve kötelező.', { hint: 'Add meg a vevő teljes nevét.' });
    if (!input.address) throw new AppError('INVALID_INPUT', 'A vevő címe kötelező.', { hint: 'address: { countryCode, postalCode, city, addressLine }' });
    const region = singleLine(input.address.region ?? '');
    const c: CustomerData = {
      vatStatus: input.vatStatus,
      name,
      address: {
        countryCode: singleLine(input.address.countryCode || 'HU').toUpperCase(),
        postalCode: singleLine(String(input.address.postalCode ?? '')),
        city: singleLine(String(input.address.city ?? '')),
        addressLine: singleLine(String(input.address.addressLine ?? '')),
        ...(region ? { region } : {}),
      },
    };
    if (input.taxNumber?.trim()) {
      const p = parseHuTaxNumber(input.taxNumber);
      if (!p.ok) throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen vevői adószám: ${p.error}`, { hint: 'Formátum: 12345676-1-23. Nézd meg a partner korábbi számláján vagy a cégkivonatán.' });
      c.taxNumber = p.value.formatted;
    }
    if (input.groupMemberTaxNumber?.trim()) {
      const p = parseHuTaxNumber(input.groupMemberTaxNumber);
      if (!p.ok) throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen csoporttagi adószám: ${p.error}`);
      c.groupMemberTaxNumber = p.value.formatted;
    }
    if (input.euVatNumber?.trim()) {
      const p = parseEuVatNumber(input.euVatNumber);
      if (!p.ok) throw new AppError('INVALID_EU_VAT_NUMBER', `Érvénytelen közösségi adószám: ${p.error}`, { hint: 'Országkóddal együtt add meg, pl. DE123456789.' });
      c.euVatNumber = p.value.formatted;
    }
    if (input.thirdStateTaxId?.trim()) c.thirdStateTaxId = input.thirdStateTaxId.trim();
    if (input.email?.trim()) c.email = input.email.trim();
    if (input.phone?.trim()) c.phone = input.phone.trim();
    if (input.bankAccount?.trim()) {
      const p = parseBankAccount(input.bankAccount);
      c.bankAccount = p.ok ? p.value.formatted : input.bankAccount.trim();
    }
    return c;
  }

  /**
   * Creates a customer (vatStatus, name and address required), or – with `id` – changes the given fields
   * of one: a field left out keeps its stored value, null or "" clears it, a given address replaces the
   * stored one (keeping its country when countryCode is left out). The result is validated as a whole.
   */
  saveCustomer(input: CustomerInput, actor?: Actor): { customer: Customer; issues: ValidationIssue[] } {
    return this.store.tx(() => this.storeCustomer(input, actor));
  }

  /**
   * The record saveCustomer would store for `input`, checked as a whole (unknown id, VALIDATION_FAILED,
   * DUPLICATE_CUSTOMER) – nothing is stored. `newCustomerId` is the id a new customer gets.
   */
  private customerRecord(input: CustomerInput, newCustomerId: string = newId('cus')): { customer: Customer; prev: Customer | null; issues: ValidationIssue[] } {
    const prev = input.id ? this.store.getCustomer(input.id) : null;
    if (input.id && !prev) throw notFound('Vevő', input.id);
    const data = this.normalizeCustomer(prev ? mergeCustomerInput(prev, input) : input);
    const issues = validateCustomer(data);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new AppError('VALIDATION_FAILED', `A vevő adatai hibásak: ${errors.map((e) => e.message).join(' ')}`, { details: { issues } });
    }
    const now = this.ts();
    if (prev) {
      const next: Customer = { ...data, id: prev.id, archived: input.archived ?? prev.archived, createdAt: prev.createdAt, updatedAt: now };
      const note = input.note === undefined ? prev.note : input.note?.trim() || undefined;
      if (note) next.note = note;
      return { customer: next, prev, issues };
    }
    if (data.taxNumber) {
      const dup = this.store.findCustomers({ taxNumber: data.taxNumber, limit: 1, offset: 0 }).items[0];
      if (dup) {
        throw new AppError('DUPLICATE_CUSTOMER', `Már létezik vevő ezzel az adószámmal: ${dup.name} (${dup.id}).`, {
          hint: 'Használd a meglévő vevőt, vagy frissítsd az adatait.',
          details: { existingId: dup.id },
        });
      }
    }
    const c: Customer = { ...data, id: newCustomerId, archived: input.archived ?? false, createdAt: now, updatedAt: now };
    if (input.note?.trim()) c.note = input.note.trim();
    return { customer: c, prev: null, issues };
  }

  /** saveCustomer inside the caller's transaction: checks (customerRecord), stores and logs the customer. */
  private storeCustomer(input: CustomerInput, actor?: Actor, newCustomerId?: string): { customer: Customer; issues: ValidationIssue[] } {
    const r = this.customerRecord(input, newCustomerId);
    if (r.prev) {
      this.store.updateCustomer(r.customer);
      const fields = Object.entries(input).filter(([k, v]) => k !== 'id' && v !== undefined).map(([k]) => k);
      this.audit('customer.update', 'customer', r.customer.id, { name: r.customer.name, fields }, actor);
    } else {
      this.store.insertCustomer(r.customer);
      this.audit('customer.create', 'customer', r.customer.id, { name: r.customer.name }, actor);
    }
    return { customer: r.customer, issues: r.issues };
  }

  getCustomer(id: string): Customer {
    const c = this.store.getCustomer(id);
    if (!c) throw notFound('Vevő', id);
    return c;
  }

  findCustomers(q: Partial<CustomerQuery>): Page<Customer> {
    return this.store.findCustomers({ limit: 20, offset: 0, ...q });
  }

  saveProduct(input: ProductInput, actor?: Actor): Product {
    if (!input.name?.trim()) throw new AppError('INVALID_INPUT', 'A termék/szolgáltatás neve kötelező.');
    if (!isVatCode(input.vatCode)) throw new AppError('INVALID_VAT_CODE', `Ismeretlen ÁFA-kód: ${String(input.vatCode)}`, { hint: `Használható: ${VAT_CODES.join(', ')}` });
    const now = this.ts();
    const prev = input.id ? this.store.getProduct(input.id) : null;
    if (input.id && !prev) throw notFound('Termék', input.id);
    // On an update, the optional fields left out keep their stored values (not the creation defaults).
    const unit = input.unit?.trim() || prev?.unit || 'db';
    const base = {
      name: input.name.trim(),
      unit,
      unitPrice: normDec(input.unitPrice, 'unitPrice'),
      priceBasis: input.priceBasis ?? prev?.priceBasis ?? 'net',
      currency: (input.currency ?? prev?.currency ?? 'HUF').toUpperCase(),
      vatCode: input.vatCode,
      nature: input.nature ?? (prev && prev.unit === unit ? prev.nature : inferNature(unit)),
    } as const;
    if (prev) {
      const next: Product = { ...prev, ...base, archived: input.archived ?? prev.archived, updatedAt: now };
      if (input.sku !== undefined) {
        if (input.sku?.trim()) next.sku = input.sku.trim();
        else delete next.sku;
      }
      if (input.description !== undefined) {
        if (input.description?.trim()) next.description = input.description.trim();
        else delete next.description;
      }
      this.store.updateProduct(next);
      this.audit('product.update', 'product', next.id, { name: next.name }, actor);
      return next;
    }
    const p: Product = { id: newId('prd'), ...base, archived: input.archived ?? false, createdAt: now, updatedAt: now };
    if (input.sku?.trim()) p.sku = input.sku.trim();
    if (input.description?.trim()) p.description = input.description.trim();
    this.store.insertProduct(p);
    this.audit('product.create', 'product', p.id, { name: p.name }, actor);
    return p;
  }

  getProduct(id: string): Product {
    const p = this.store.getProduct(id);
    if (!p) throw notFound('Termék', id);
    return p;
  }

  findProducts(q: Partial<ProductQuery>): Page<Product> {
    return this.store.findProducts({ limit: 20, offset: 0, ...q });
  }

  // ===========================================================================================
  // Invoices – drafts
  // ===========================================================================================

  getInvoice(idOrNumber: string): Invoice {
    const key = idOrNumber.trim();
    // An id ("inv_…") first, then a number – numbers may start with "inv_" too (pattern "inv_{YYYY}_{SEQ:4}").
    const inv = (key.startsWith('inv_') ? this.store.getInvoice(key) : null) ?? this.store.getInvoiceByNumber(key);
    if (!inv) throw notFound('Számla', idOrNumber);
    return inv;
  }

  /**
   * Invoice plus its current validation issues. A draft is shown as issue() would issue it today (see
   * issuePreview: today's issue date, the due date issuing gives it, the current seller data), with a
   * warning when those dates differ from the ones stored in the draft.
   */
  viewInvoice(idOrNumber: string): InvoiceView {
    const invoice = this.getInvoice(idOrNumber);
    if (invoice.status === 'draft') return this.draftView(invoice);
    return { invoice, issues: [], readyToIssue: false };
  }

  /** The preview of a draft (issuePreview) and its validation issues – what invoice_draft / invoice_get show. */
  private draftView(draft: Invoice): InvoiceView {
    let preview: { invoice: Invoice; notes: ValidationIssue[] };
    try {
      preview = this.issuePreview(draft);
    } catch (e) {
      // Data the calculation cannot even process (e.g. an unknown VAT code): report it on the stored draft.
      if (!isAppError(e)) throw e;
      preview = { invoice: draft, notes: [] };
    }
    const issues = [...preview.notes, ...this.validate(preview.invoice), ...this.proformaIssues(preview.invoice)];
    let chain: ReturnType<OpenSzamla['correctionChain']> = null;
    try {
      chain = this.correctionChain(preview.invoice);
      if (chain) issues.push(...this.repeatedOriginalLines(preview.invoice, chain));
    } catch (e) {
      // Figures the calculation could not process are reported by validate() above.
      if (!isAppError(e)) throw e;
      chain = null;
    }
    return { invoice: preview.invoice, issues, readyToIssue: !issues.some((i) => i.severity === 'error'), ...(chain ? { chain: chain.totals } : {}) };
  }

  /**
   * What a modification draft does to its invoice: the totals of the original with its issued modifications, before and
   * with this one. A modification's lines are differences – the corrected line given instead of the difference leaves a
   * draft that looks plausible on its own (a positive line, a sensible total) and doubles the invoice; these two totals
   * side by side show it. null for anything but a modification of an issued invoice.
   */
  private correctionChain(preview: Invoice): { totals: CorrectionChainTotals; original: Invoice } | null {
    if (preview.documentType !== 'modification' || !preview.reference) return null;
    const chain = this.paymentChain(preview);
    const original = chain?.[0];
    if (!chain || !original?.number) return null;
    const sum = (pick: (i: Invoice) => string, extra?: string): string => toDec(sumDec([...chain.map(pick), ...(extra !== undefined ? [extra] : [])]));
    const t = preview.totals;
    return {
      original,
      totals: {
        originalNumber: original.number,
        modifications: chain.length - 1,
        currency: original.currency,
        before: { netAmount: sum((i) => i.totals.netAmount), vatAmount: sum((i) => i.totals.vatAmount), grossAmount: sum((i) => i.totals.grossAmount) },
        after: { netAmount: sum((i) => i.totals.netAmount, t.netAmount), vatAmount: sum((i) => i.totals.vatAmount, t.vatAmount), grossAmount: sum((i) => i.totals.grossAmount, t.grossAmount) },
      },
    };
  }

  /**
   * Lines of a modification draft that look like a line of the original given again – the same description with the
   * same quantity (a changed price given as the new price), or with the same unit price and a larger quantity (a
   * changed quantity given as the new quantity) – instead of the difference. A warning: more of the same item can be
   * billed in a modification too.
   */
  private repeatedOriginalLines(preview: Invoice, chain: { totals: CorrectionChainTotals; original: Invoice }): ValidationIssue[] {
    const key = (s: string): string => s.trim().toLocaleLowerCase('hu');
    const out: ValidationIssue[] = [];
    preview.lines.forEach((l, k) => {
      let qty: DecValue;
      try {
        qty = dec(l.quantity);
      } catch {
        return;
      }
      if (!qty.gt(0) || !dec(l.unitPrice).gt(0)) return;
      const o = chain.original.lines.find((x) => {
        if (key(x.description) !== key(l.description) || !dec(x.quantity).gt(0)) return false;
        return dec(x.quantity).eq(qty) || (dec(x.unitPrice).eq(l.unitPrice) && qty.gt(x.quantity));
      });
      if (!o) return;
      const cur = preview.currency;
      const t = chain.totals;
      out.push(
        issue(
          'CORRECTION_LINE_REPEATS_ORIGINAL',
          `A(z) ${k + 1}. tétel („${l.description}”, ${formatQuantity(l.quantity)} ${l.unit} × ${formatMoney(l.unitPrice, cur)}) az eredeti számla ${o.lineNo}. tételének (${formatQuantity(o.quantity)} ${o.unit} × ${formatMoney(o.unitPrice, cur)}) megismétlésének látszik. ` +
            `A módosító számla tételei különbözetek: ezzel a(z) ${t.originalNumber} számla a módosításaival együtt bruttó ${formatMoney(t.before.grossAmount, cur)}-ról ${formatMoney(t.after.grossAmount, cur)}-ra változik. ` +
            'Ha a tétel javított értékét adtad meg, helyette a különbözetet add meg (pl. mennyiség 10 → 12: +2 ugyanazon az áron; egységár 15 000 → 14 000: az eredeti mennyiség −1 000 egységáron). Ha valóban ennyivel több került felszámításra, a tétel rendben van.',
          `lines[${k}]`,
          'warning',
        ),
      );
    });
    return out;
  }

  /**
   * The creation result of a new draft whose currency is the seller's non-HUF default says so, once
   * (DEFAULT_CURRENCY_APPLIED): "15 000 Ft + ÁFA" must not silently become 15 000 EUR. Not when the currency
   * was given, comes from a copied document, or a line is priced by a product (in the invoice currency).
   */
  private withDefaultCurrencyNote(view: InvoiceView, input: DraftInput): InvoiceView {
    const pricedByProduct = input.lines?.some((l) => l.productId && (l.unitPrice === undefined || l.unitPrice === null)) ?? false;
    if (input.copyFromId || input.currency !== undefined || view.invoice.currency === 'HUF' || pricedByProduct) return view;
    const note = issue(
      'DEFAULT_CURRENCY_APPLIED',
      `A pénznem az eladó alapértelmezése: ${view.invoice.currency}. A pénznem nem volt megadva, ezért a megadott egységárak is ebben a pénznemben értendők; ha a számla más pénznemben (pl. forintban) szól, add meg a pénznemet (currency).`,
      'currency',
      'warning',
    );
    return { ...view, issues: [note, ...view.issues] };
  }

  /**
   * Warnings of a draft converted from a díjbekérő that has a payment recorded: the payment issuing
   * carries over (or why it does not), and a payment made before the fulfilment date – the conversion
   * sets that to today; a payment before the performance is an advance (Áfa tv. 59. §: the VAT arises when
   * it is received), which needs an előlegszámla. Not on a document deducting an advance: its előlegszámla
   * exists already. The document type is never changed automatically.
   */
  private proformaIssues(draft: Invoice): ValidationIssue[] {
    const p = this.proformaPayment(draft);
    if (!p) return [];
    const { proforma } = p;
    const paid = formatMoney(proforma.paidAmount, proforma.currency);
    const when = proforma.paidDate ? ` (${formatDate(proforma.paidDate)})` : '';
    const out: ValidationIssue[] = [];
    const notCarried = (why: string, todo: string, field?: string): ValidationIssue =>
      issue('PROFORMA_PAYMENT_NOT_CARRIED', `A(z) ${proforma.number} díjbekérőre ${paid} befizetés van rögzítve${when}, de ${why}, ezért kiállításkor nem kerül át: ${todo}`, field, 'warning');
    const deducted = advanceDeductions(draft);
    if (p.invoicedBy) {
      out.push(issue('PROFORMA_ALREADY_INVOICED', `A(z) ${proforma.number} díjbekérőből már kiállítottak bizonylatot (${p.invoicedBy.number}): ellenőrizd, nem számlázod-e kétszer. A díjbekérő befizetése (${paid}) erre a bizonylatra nem kerül át.`, undefined, 'warning'));
    } else if (p.skip === 'cancelled') {
      out.push(notCarried('a díjbekérő vissza van vonva', 'ha a vevő ezt a bizonylatot fizette, a kiállítás után rögzítsd a befizetést.'));
    } else if (p.skip === 'buyer') {
      out.push(notCarried('a díjbekérő vevője nem azonos a bizonylat vevőjével', 'ha ennek a bizonylatnak a vevője fizetett, a kiállítás után rögzítsd a befizetést.', 'customer'));
    } else if (p.skip === 'payable') {
      out.push(notCarried(
        `a bizonylat fizetendő összege ${formatMoney(draft.totals.payableAmount, draft.currency)}`,
        'a befizetést annál a bizonylatnál rögzítsd, amelyre a vevő fizetett (pl. az előlegszámlánál).',
        'totals.payableAmount',
      ));
    } else if (p.skip === 'advance') {
      out.push(notCarried(
        deducted?.numbers.length ? `a bizonylat levonja a(z) ${deducted.numbers.join(', ')} előlegszámlát` : 'a bizonylat előleget von le',
        'a díjbekérő befizetése valószínűleg ez az előleg, így az előlegszámlához tartozik – ha ott még nincs rögzítve, ott rögzítsd. ' +
          'Ha a vevő erre a bizonylatra is fizetett, azt a kiállítás után rögzítsd.',
        deducted?.field,
      ));
    } else if (!p.carry) {
      out.push(issue('PROFORMA_PAYMENT_NOT_CARRIED', `A(z) ${proforma.number} díjbekérőre ${paid} befizetés van rögzítve${when}, de a pénzneme eltér a bizonylatétól (${draft.currency}), ezért kiállításkor nem kerül át: a kiállítás után rögzítsd a befizetést.`, 'currency', 'warning'));
    } else {
      out.push(issue('PROFORMA_PAYMENT_CARRIED', `A(z) ${proforma.number} díjbekérőre ${paid} befizetés van rögzítve${when}: kiállításkor ez a bizonylatra is átkerül befizetésként – ne rögzítsd újra.`, undefined, 'warning'));
    }
    const advance = draft.documentType === 'advance';
    if (!deducted && proforma.paidDate && (advance ? proforma.paidDate !== draft.fulfillmentDate : proforma.paidDate < draft.fulfillmentDate)) {
      out.push(issue(
        'PROFORMA_PAID_BEFORE_FULFILLMENT',
        advance
          ? `Előlegszámlán a teljesítés dátuma az előleg kézhezvételének (jóváírásának) napja (Áfa tv. 59. §): a(z) ${proforma.number} díjbekérőt ${formatDate(proforma.paidDate)} napon fizették, a teljesítés dátuma most ${formatDate(draft.fulfillmentDate)}. Ellenőrizd a teljesítés dátumát (fulfillmentDate).`
          : `A(z) ${proforma.number} díjbekérőt ${formatDate(proforma.paidDate)} napon fizették, a bizonylat teljesítési dátuma ${formatDate(draft.fulfillmentDate)} (díjbekérőből másolva a mai nap). Kérdezd meg a teljesítés napját: ha a teljesítés a fizetéskor vagy előtte volt, add meg (fulfillmentDate); ha a fizetés a teljesítést megelőzte, az előleg – az adó a befizetéskor keletkezik (Áfa tv. 59. §), és előlegszámla kell róla (documentType: "advance"). Ezt a felhasználó (könyvelője) döntse el.`,
        'fulfillmentDate',
        'warning',
      ));
    }
    return out;
  }

  findInvoices(f: Partial<InvoiceFilter>): Page<Invoice> {
    if (f.issueDateFrom !== undefined && f.issueDateTo !== undefined) {
      assertPeriod(assertIsoDate(f.issueDateFrom, 'issueDateFrom'), assertIsoDate(f.issueDateTo, 'issueDateTo'));
    }
    if (f.fulfillmentDateFrom !== undefined && f.fulfillmentDateTo !== undefined) {
      assertPeriod(assertIsoDate(f.fulfillmentDateFrom, 'fulfillmentDateFrom'), assertIsoDate(f.fulfillmentDateTo, 'fulfillmentDateTo'));
    }
    return this.store.findInvoices({ limit: 20, offset: 0, sort: 'issued_desc', ...f });
  }

  private validate(invoice: Invoice): ValidationIssue[] {
    const original = invoice.reference ? this.store.getInvoice(invoice.reference.originalInvoiceId) : null;
    // The issued corrections of the original besides this one: its current fulfilment date and amounts.
    const chain = original ? this.chainOf(original).filter((d) => d.id !== invoice.id) : [];
    return [
      ...validateInvoice(invoice, { today: this.today(), original, chain, exchangeRatePolicy: this.getDefaults().exchangeRateSource }),
      ...this.advanceDeductionIssues(invoice),
      ...this.deductedAdvanceIssues(invoice, original, chain),
      ...navReportSizeIssues(invoice),
      ...pdfTextIssues(invoice),
    ];
  }

  /**
   * Advance deductions of a végszámla checked against the előlegszámla they name (Áfa tv. 10. melléklet
   * 5. pont: the advance actually invoiced is deducted). It must be an issued, not cancelled advance
   * invoice in the same currency (errors). Warnings: another buyer, a VAT code the advance does not
   * have, or more deducted per VAT code than the advance's net amount – counting every issued document
   * that deducts it (a copied végszámla deducting it twice). An unknown number is only a warning: the
   * advance may have been issued by the previous invoicing program. The documents deducting the advances are
   * selected in SQL, in one query for all of them (Store.findAdvanceDeductions): the check runs on every draft
   * view and inside the issue transaction, so it never loads the unrelated documents issued since the advance.
   */
  private advanceDeductionIssues(invoice: Invoice): ValidationIssue[] {
    if (invoice.documentType !== 'final' && invoice.documentType !== 'invoice') return [];
    const own = new Map<string, number[]>();
    invoice.lines.forEach((l, i) => {
      const n = l?.advanceDeduction?.advanceInvoiceNumber?.trim();
      if (n) own.set(n, [...(own.get(n) ?? []), i]);
    });
    const advances = new Map<string, Invoice | null>([...own.keys()].map((n) => [n, this.store.getInvoiceByNumber(n)] as const));
    // The advances whose deductions are added up below: issued, not cancelled, in the invoice's currency.
    const counted = [...advances.values()].filter((a): a is Invoice => a !== null && a.documentType === 'advance' && a.status !== 'cancelled' && a.currency === invoice.currency);
    const since = counted.reduce<IsoDate | null>((min, a) => (min === null || a.issueDate < min ? a.issueDate : min), null);
    const deductingAny = since === null ? [] : this.store.findAdvanceDeductions(counted.map((a) => a.number as string), since).filter((d) => d.id !== invoice.id);
    const out: ValidationIssue[] = [];
    for (const [number, indexes] of own) {
      const field = `lines[${indexes[0]}].advanceDeduction.advanceInvoiceNumber`;
      const adv = advances.get(number) ?? null;
      if (!adv) {
        out.push(issue('ADVANCE_INVOICE_NOT_FOUND', `A levont ${number} előlegszámla nem található ebben a programban. Ha korábbi számlázó programmal készült, ellenőrizd a sorszámát és a levont összeget; ha elírás, javítsd.`, field, 'warning'));
        continue;
      }
      if (adv.documentType !== 'advance') {
        const what = adv.documentType === 'proforma'
          ? 'díjbekérő (nem számla); az előleg beérkezése után kiállított előlegszámla sorszámát add meg'
          : adv.reference?.originalDocumentType === 'advance'
            ? `egy előlegszámla módosító/sztornó okirata; az eredeti előlegszámla sorszámát add meg (${adv.reference.originalInvoiceNumber})`
            : 'nem előlegszámla';
        out.push(issue('ADVANCE_INVOICE_NOT_ADVANCE', `A levont ${number} bizonylat ${what}.`, field));
        continue;
      }
      if (adv.status === 'cancelled') {
        out.push(issue('ADVANCE_INVOICE_CANCELLED', `A levont ${number} előlegszámla sztornózva van; sztornózott előleg nem vonható le. Ha az előleget újra számláztad, az új előlegszámla sorszámát add meg.`, field));
        continue;
      }
      if (adv.currency !== invoice.currency) {
        out.push(issue('ADVANCE_INVOICE_CURRENCY', `A levont ${number} előlegszámla pénzneme (${adv.currency}) eltér a végszámláétól (${invoice.currency}).`, field));
        continue;
      }
      if (!sameCustomer(adv.customer, invoice.customer)) {
        out.push(issue('ADVANCE_INVOICE_OTHER_CUSTOMER', `A levont ${number} előlegszámla vevője (${adv.customer.name}) nem azonos a végszámla vevőjével (${invoice.customer.name}); ellenőrizd.`, field, 'warning'));
      }
      // Net amount of the advance per VAT code (with its issued modifications) vs. everything deducting it.
      const advanceNet = new Map<string, string[]>();
      for (const doc of [adv, ...this.chainOf(adv)]) for (const r of doc.totals.byVat) advanceNet.set(r.vatCode, [...(advanceNet.get(r.vatCode) ?? []), r.netAmount]);
      const deducted = new Map<string, string[]>();
      // As counted before: the issued documents since the advance's issue date.
      const deducting = deductingAny.filter((d) => d.issueDate >= adv.issueDate);
      for (const doc of [...deducting, invoice]) {
        for (const l of doc.lines) {
          if (l.advanceDeduction?.advanceInvoiceNumber?.trim() === number) deducted.set(l.vatCode, [...(deducted.get(l.vatCode) ?? []), l.netAmount]);
        }
      }
      for (const [code, amounts] of deducted) {
        const total = sumDec(amounts).neg();
        const available = advanceNet.get(code);
        if (!available) {
          out.push(issue('ADVANCE_DEDUCTION_VAT_CODE', `A(z) ${number} előlegszámlán nincs ${code} ÁFA-kódú tétel, a levonás mégis ezzel a kóddal történik; az előleget azzal a kóddal kell levonni, amellyel számláztad.`, field, 'warning'));
        } else if (total.gt(sumDec(available))) {
          out.push(issue(
            'ADVANCE_DEDUCTION_EXCEEDS_ADVANCE',
            `A(z) ${number} előlegszámláról (${code}) összesen ${toDec(total)} ${invoice.currency} nettó kerülne levonásra (a már kiállított végszámlákkal együtt), az előleg nettó összege viszont ${toDec(sumDec(available))} ${invoice.currency}. Ellenőrizd, nem vonod-e le kétszer.`,
            field,
            'warning',
          ));
        }
      }
    }
    return out;
  }

  /**
   * A storno or modification of an előlegszámla checked against the végszámlák deducting it – the
   * reverse of advanceDeductionIssues: a végszámla deducts the advance actually invoiced (Áfa tv. 10.
   * melléklet 5. pont), so cancelling or reducing an advance it still deducts would leave the deal's VAT
   * under-declared. Per VAT code this document reduces (a storno: every code), what remains of the
   * advance (with its issued corrections and this document) must cover the net deducted by the issued
   * documents, counted as advanceDeductionIssues counts it (a végszámla's storno neutralises its
   * deduction; drafts do not count). A modification that lowers the advance's total net is also checked
   * on all VAT codes together – a deduction under a code it does not reduce (or the advance does not
   * have) still needs the advance. Otherwise ADVANCE_STILL_DEDUCTED: cancel or correct the végszámla
   * first. Increasing an advance stays possible, also while a végszámla deducts it.
   */
  private deductedAdvanceIssues(invoice: Invoice, advance: Invoice | null, chain: readonly Invoice[]): ValidationIssue[] {
    if ((invoice.documentType !== 'storno' && invoice.documentType !== 'modification') || advance?.documentType !== 'advance' || !advance.number) return [];
    const netByCode = (docs: readonly Invoice[]): Map<string, DecValue> => {
      const m = new Map<string, DecValue>();
      for (const doc of docs) for (const r of doc.totals.byVat) m.set(r.vatCode, (m.get(r.vatCode) ?? dec('0')).plus(dec(r.netAmount)));
      return m;
    };
    const own = netByCode([invoice]);
    const remaining = netByCode([advance, ...chain, invoice]);
    // VAT code → végszámla (the deducting document, or the one its storno / modification corrects) → net deducted.
    // Only the documents deducting this advance are read (Store.findAdvanceDeductions, issue order).
    const deducted = new Map<string, Map<string, DecValue>>();
    for (const doc of this.store.findAdvanceDeductions([advance.number], advance.issueDate)) {
      if (doc.id === invoice.id) continue;
      for (const l of doc.lines) {
        if (l.advanceDeduction?.advanceInvoiceNumber?.trim() !== advance.number) continue;
        const final = doc.reference?.originalInvoiceNumber ?? doc.number ?? doc.id;
        const byFinal = deducted.get(l.vatCode) ?? new Map<string, DecValue>();
        byFinal.set(final, (byFinal.get(final) ?? dec('0')).minus(dec(l.netAmount)));
        deducted.set(l.vatCode, byFinal);
      }
    }
    const out: ValidationIssue[] = [];
    const deducting = (byFinal: ReadonlyMap<string, DecValue>): string => {
      const finals = [...byFinal].filter(([, v]) => v.gt(0)).map(([n]) => n);
      return finals.length === 1 ? `a(z) ${finals[0]} végszámla levonja` : `a(z) ${finals.join(', ')} végszámlák levonják`;
    };
    for (const [code, byFinal] of deducted) {
      if (invoice.documentType === 'modification' && !own.get(code)?.isNegative()) continue;
      const total = sumDec([...byFinal.values()]);
      const left = remaining.get(code) ?? dec('0');
      if (!total.gt(0) || !total.gt(left)) continue;
      const who = deducting(byFinal);
      const head = `A(z) ${advance.number} előlegszámlát ${who} (${code} ÁFA-kód, nettó ${toDec(total)} ${advance.currency})`;
      out.push(issue(
        'ADVANCE_STILL_DEDUCTED',
        invoice.documentType === 'storno'
          ? `${head}, ezért nem sztornózható: a végszámla a ténylegesen számlázott előleget vonja le, a sztornó után az ügylet áfája hiányos lenne. Ha a végszámla hibás, előbb azt sztornózd vagy módosítsd (a levonás csökkentésével); a végszámla kiállítása miatt az előlegszámlát nem kell sztornózni.`
          : `${head}, a módosítás után viszont az előlegből ezen az ÁFA-kódon csak nettó ${toDec(left)} ${advance.currency} maradna. Előbb a végszámlát sztornózd vagy módosítsd (a levonás csökkentésével), utána módosítsd az előlegszámlát.`,
        'lines',
      ));
    }
    // A modification lowering the advance as a whole: everything deducted (all VAT codes) against all that remains.
    const all = (m: ReadonlyMap<string, DecValue>): DecValue => sumDec([...m.values()]);
    if (invoice.documentType === 'modification' && !out.length && all(own).isNegative()) {
      const byFinal = new Map<string, DecValue>();
      for (const perFinal of deducted.values()) for (const [final, v] of perFinal) byFinal.set(final, (byFinal.get(final) ?? dec('0')).plus(v));
      const total = all(byFinal);
      const left = all(remaining);
      if (total.gt(0) && total.gt(left)) {
        const codes = [...deducted].map(([code, m]) => [code, all(m)] as const).filter(([, v]) => v.gt(0)).map(([code, v]) => `${code} ÁFA-kóddal ${toDec(v)} ${advance.currency}`);
        out.push(issue(
          'ADVANCE_STILL_DEDUCTED',
          `A(z) ${advance.number} előlegszámlát ${deducting(byFinal)} (összesen nettó ${toDec(total)} ${advance.currency}, ebből ${codes.join(', ')}), a módosítás után viszont az előlegből összesen csak nettó ${toDec(left)} ${advance.currency} maradna. Előbb a végszámlát sztornózd vagy módosítsd (a levonás csökkentésével), utána módosítsd az előlegszámlát.`,
          'lines',
        ));
      }
    }
    return out;
  }

  private resolveLine(input: LineInput, idx: number, seller: SellerProfile, currency: string): InvoiceLineInput {
    const f = (name: string): string => `lines[${idx}].${name}`;
    const product = input.productId ? this.store.getProduct(input.productId) : null;
    if (input.productId && !product) throw notFound('Termék', input.productId);
    const description = (input.description ?? product?.name ?? '').trim();
    if (!description) throw new AppError('INVALID_INPUT', `Hiányzik a tétel megnevezése (${f('description')}).`, { hint: 'Adj meg description-t vagy productId-t.' });
    if (input.quantity === undefined || input.quantity === null) throw new AppError('INVALID_INPUT', `Hiányzik a mennyiség (${f('quantity')}).`);
    const quantity = normDec(input.quantity, f('quantity'));
    let unitPrice: string;
    if (input.unitPrice !== undefined && input.unitPrice !== null) unitPrice = normDec(input.unitPrice, f('unitPrice'));
    else if (product) {
      if (product.currency !== currency) {
        throw new AppError('CURRENCY_MISMATCH', `A(z) "${product.name}" termék ára ${product.currency}-ban van megadva, a számla pénzneme ${currency}.`, {
          hint: 'Add meg az egységárat (unitPrice) a számla pénznemében.',
        });
      }
      unitPrice = product.unitPrice;
    } else throw new AppError('INVALID_INPUT', `Hiányzik az egységár (${f('unitPrice')}).`);
    const vatCode = input.vatCode ?? product?.vatCode ?? (seller.vatStatus === 'aam' ? 'AAM' : undefined);
    if (!vatCode) {
      throw new AppError('INVALID_INPUT', `Hiányzik az ÁFA-kód (${f('vatCode')}).`, { hint: `Pl. "27" (általános), "5", "18", "TAM", "EUFAD37"… Lehetséges: ${VAT_CODES.join(', ')}` });
    }
    if (!isVatCode(vatCode)) throw new AppError('INVALID_VAT_CODE', `Ismeretlen ÁFA-kód (${f('vatCode')}): ${String(vatCode)}`, { hint: `Lehetséges: ${VAT_CODES.join(', ')}` });
    const unit = (input.unit ?? product?.unit ?? 'db').trim() || 'db';
    const line: InvoiceLineInput = {
      description,
      quantity,
      unit,
      unitPrice,
      priceBasis: input.priceBasis ?? product?.priceBasis ?? 'net',
      vatCode,
      // Given nature > the product's > what the VAT code or the unit tells (lineNature).
      nature: input.nature ?? product?.nature ?? lineNature(input.unit, vatCode),
    };
    if (product) line.productId = product.id;
    if (input.vatReason?.trim()) line.vatReason = input.vatReason.trim();
    if (input.modifiesLineNo !== undefined) line.modifiesLineNo = input.modifiesLineNo;
    if (input.advanceDeduction) {
      const advanceInvoiceNumber = input.advanceDeduction.advanceInvoiceNumber.trim();
      const given = input.advanceDeduction.advanceExchangeRate;
      let advanceExchangeRate: string;
      if (given !== undefined && given !== null) advanceExchangeRate = normDec(given, f('advanceDeduction.advanceExchangeRate'));
      else if (currency === 'HUF') advanceExchangeRate = '1';
      else {
        // NAV advanceExchangeRate = the rate of the advance invoice. Taken from it when it was issued here;
        // otherwise it must be given ('0' → LINE_ADVANCE_RATE_MISSING), never a made-up 1.
        const adv = this.store.getInvoiceByNumber(advanceInvoiceNumber);
        advanceExchangeRate = adv && adv.documentType === 'advance' && adv.currency === currency ? adv.exchangeRate : '0';
      }
      line.advanceDeduction = {
        advanceInvoiceNumber,
        advancePaymentDate: assertIsoDate(input.advanceDeduction.advancePaymentDate, f('advanceDeduction.advancePaymentDate')),
        advanceExchangeRate,
      };
    }
    return line;
  }

  private stateOf(inv: Invoice): DraftState {
    return {
      documentType: inv.documentType,
      seriesId: inv.seriesId,
      customerId: inv.customerId,
      customer: inv.customer,
      customerFromRecord: inv.customerFromRecord ?? null,
      issueDate: inv.issueDate,
      fulfillmentDate: inv.fulfillmentDate,
      dueDate: inv.dueDate,
      dueDateExplicit: inv.dueDateExplicit === true,
      paymentMethod: inv.paymentMethod,
      currency: inv.currency,
      exchangeRate: inv.exchangeRate,
      exchangeRateDate: inv.exchangeRateDate,
      exchangeRateSource: inv.exchangeRateSource,
      language: inv.language,
      appearance: inv.appearance,
      comment: inv.comment,
      internalNote: inv.internalNote,
      orderNumber: inv.orderNumber,
      reference: inv.reference,
      lines: inv.lines.map(lineInputOf),
      proformaId: inv.proformaId ?? null,
    };
  }

  /** Applies an input/patch on top of a base state. `base` null → new draft defaults. */
  private async applyInput(base: DraftState | null, input: DraftInput | DraftPatch, seller: SellerProfile, actor?: Actor): Promise<DraftState> {
    const d = this.getDefaults();
    const today = this.today();
    const documentType: DocumentType = input.documentType ?? base?.documentType ?? 'invoice';
    const kind: SeriesKind = documentType === 'proforma' ? 'proforma' : 'invoice';
    let seriesId = input.seriesId ?? (base && (base.documentType === 'proforma') === (documentType === 'proforma') ? base.seriesId : undefined);
    if (!seriesId) {
      const def = this.store.getDefaultSeries(kind);
      if (!def) throw new AppError('SERIES_MISSING', `Nincs alapértelmezett ${kind === 'proforma' ? 'díjbekérő' : 'számla'} sorszámtartomány.`, { hint: 'Hozz létre egy sorszámtartományt, és jelöld alapértelmezettnek.' });
      seriesId = def.id;
    }
    const series = this.store.getSeries(seriesId);
    if (!series) throw notFound('Sorszámtartomány', seriesId);
    if (series.kind !== kind) throw new AppError('SERIES_KIND_MISMATCH', `A(z) "${series.name}" sorszámtartomány ${series.kind === 'proforma' ? 'díjbekérőkhöz' : 'számlákhoz'} való.`, { hint: 'Válassz megfelelő sorszámtartományt, vagy hagyd üresen az alapértelmezetthez.' });
    // An archived series cannot be chosen. A correction keeps its original's even then: issuing numbers
    // it from the default invoice series (issuingSeries).
    if (series.archived && !(base?.reference && seriesId === base.seriesId)) throw seriesArchived(series);

    // Customer
    if (input.customerId && input.customer) {
      throw new AppError('INVALID_INPUT', 'customerId és customer egyszerre nem adható meg.', {
        hint: 'A tárolt vevőhöz csak a customerId kell. A tárolt vevő adatainak módosításához a customer objektumot add meg a vevő azonosítójával (customer.id) és saveCustomer: true-val; egyszeri, nem mentett vevőhöz csak a customer objektumot, customerId nélkül.',
      });
    }
    let customerId = base?.customerId ?? null;
    let customer = base?.customer ?? null;
    // Kept as stored when the buyer is not given (null stays null: flagRecordBuyerDrafts decides).
    let customerFromRecord = base ? base.customerFromRecord : false;
    let customerSave: DraftState['customerSave'];
    if (input.customerId) {
      const c = this.getCustomer(input.customerId);
      customerId = c.id;
      customer = customerDataOf(c);
      customerFromRecord = true;
    } else if (input.customer) {
      if (input.saveCustomer) {
        // Checked now, stored with the draft (createDraft / updateDraft): a rejected draft saves no customer.
        const r = this.customerRecord(input.customer);
        customerSave = { input: input.customer, id: r.customer.id };
        customerId = r.customer.id;
        customer = customerDataOf(r.customer);
        customerFromRecord = true;
      } else {
        // Inline buyer data (also with customer.id): used as given, the record does not override it.
        customer = this.normalizeCustomer(input.customer);
        customerId = input.customer.id ?? null;
        customerFromRecord = false;
      }
    } else if (customerFromRecord && customerId && !base?.reference) {
      // A buyer from a customer record follows the record.
      const c = this.store.getCustomer(customerId);
      if (c) customer = customerDataOf(c);
    }
    if (!customer) throw new AppError('INVALID_INPUT', 'Hiányzik a vevő.', { hint: 'Adj meg customerId-t (customer_find / customer_save) vagy customer objektumot.' });

    // Dates
    const issueDate = input.issueDate ? assertIsoDate(input.issueDate, 'issueDate') : base?.issueDate ?? today;
    const fulfillmentDate = input.fulfillmentDate ? assertIsoDate(input.fulfillmentDate, 'fulfillmentDate') : base?.fulfillmentDate ?? issueDate;
    const paymentMethod = input.paymentMethod ?? base?.paymentMethod ?? d.paymentMethod;
    // A due date given as a date stays as it is (also when the issue date moves); one derived from the
    // payment term moves with the issue date, so the buyer keeps the full term.
    let dueDate: IsoDate | null;
    let dueDateExplicit = false;
    if (input.dueDate) {
      dueDate = assertIsoDate(input.dueDate, 'dueDate');
      dueDateExplicit = true;
    } else if (input.paymentDays !== undefined) dueDate = addDays(issueDate, input.paymentDays);
    else if (base?.dueDate && base.dueDateExplicit) {
      dueDate = base.dueDate;
      dueDateExplicit = true;
    } else if (base?.dueDate && !input.issueDate) dueDate = base.dueDate;
    else if (base?.dueDate && base.issueDate) dueDate = addDays(issueDate, daysBetween(base.issueDate, base.dueDate));
    else dueDate = paymentMethod === 'TRANSFER' ? addDays(issueDate, d.paymentDays) : issueDate;

    // Currency & exchange rate
    const currency = (input.currency ?? base?.currency ?? d.currency).trim().toUpperCase();
    let exchangeRate = base?.exchangeRate ?? '1';
    let exchangeRateDate = base?.exchangeRateDate ?? null;
    let exchangeRateSource = base?.exchangeRateSource ?? null;
    // Áfa tv. 80. § (1): the rate valid at the tax point – the fulfilment date; on an advance invoice that is
    // the day the advance was received (80. § (1) a), 59. §), which is what its fulfilment date holds.
    const rateDate = fulfillmentDate;
    // A correction uses the rate of the invoice it corrects (the tax point of that supply): another rate is
    // refused – a wrong rate is corrected with a storno and a new invoice –, the same one changes nothing.
    const fixed: Pick<Invoice, 'currency' | 'exchangeRate' | 'exchangeRateDate' | 'exchangeRateSource'> | null =
      base?.reference ? (this.store.getInvoice(base.reference.originalInvoiceId) ?? base) : null;
    if (fixed && base?.reference && input.exchangeRate !== undefined && input.exchangeRate !== null && !dec(input.exchangeRate, 'exchangeRate').eq(dec(fixed.exchangeRate))) {
      throw correctionRateFixed(base.reference.originalInvoiceNumber, fixed, normDec(input.exchangeRate, 'exchangeRate'));
    }
    // A manual rate belongs to the day it was given for: once the fulfilment date moves (or for a copy,
    // which has none), it is dropped like an omitted rate – MNB policy: the MNB rate of the new day,
    // manual policy: a new rate has to be entered (EXCHANGE_RATE_MISSING). Never silently kept.
    const manualRateValid = !!base && base.currency === currency && exchangeRateSource === 'manual' && exchangeRateDate === rateDate;
    // An MNB rate belongs to the fulfilment date (and currency) it was looked up for – its own date is the
    // publication date, earlier on a weekend, a holiday or before the 11:00 fixing. It is looked up again
    // only when one of them changes, never on an unrelated edit, so an unreachable MNB never costs a valid
    // rate. A rate published on the new fulfilment date itself is that day's rate already.
    const mnbRateValid = !!base && base.currency === currency && exchangeRateSource === 'MNB' && exchangeRateDate !== null && exchangeRateDate <= rateDate
      && (base.fulfillmentDate === rateDate || exchangeRateDate === rateDate);
    if (currency === 'HUF') {
      exchangeRate = '1';
      exchangeRateDate = null;
      exchangeRateSource = null;
    } else if (fixed && fixed.currency === currency) {
      // Corrections keep the exchange rate of the invoice they modify.
      exchangeRate = fixed.exchangeRate;
      exchangeRateDate = fixed.exchangeRateDate;
      exchangeRateSource = fixed.exchangeRateSource;
    } else if (input.exchangeRate !== undefined && input.exchangeRate !== null) {
      exchangeRate = normDec(input.exchangeRate, 'exchangeRate');
      exchangeRateDate = rateDate;
      exchangeRateSource = 'manual';
    } else if (d.exchangeRateSource === 'manual') {
      if (!manualRateValid) {
        exchangeRate = '0';
        exchangeRateDate = null;
        exchangeRateSource = null;
      }
    } else if (!manualRateValid && !mnbRateValid) {
      try {
        const r = await this.exchangeRate(currency, rateDate);
        exchangeRate = r.rate;
        exchangeRateDate = r.date;
        exchangeRateSource = 'MNB';
      } catch (e) {
        exchangeRate = '0';
        exchangeRateDate = null;
        exchangeRateSource = null;
        if (!isAppError(e)) throw e;
      }
    }

    // Lines
    let lines: InvoiceLineInput[];
    if (input.lines) lines = input.lines.map((l, i) => this.resolveLine(l, i, seller, currency));
    else lines = base?.lines ?? [];

    const pick = <T>(v: T | null | undefined, b: T | null | undefined): T | null => (v === undefined ? (b ?? null) : (v ?? null));
    const text = (v: string | null | undefined, b: string | null | undefined): string | null => {
      const r = pick(v, b);
      return r && r.trim() ? r.trim() : null;
    };
    return {
      documentType,
      seriesId,
      customerId,
      customer,
      customerFromRecord: customerFromRecord && customerId !== null,
      ...(customerSave ? { customerSave } : {}),
      issueDate,
      fulfillmentDate,
      dueDate,
      dueDateExplicit: dueDateExplicit && dueDate !== null,
      paymentMethod,
      currency,
      exchangeRate,
      exchangeRateDate,
      exchangeRateSource,
      language: input.language ?? base?.language ?? d.language,
      appearance: input.appearance ?? base?.appearance ?? d.appearance,
      comment: text(input.comment, base?.comment),
      internalNote: text(input.internalNote, base?.internalNote),
      orderNumber: text(input.orderNumber, base?.orderNumber),
      reference: base?.reference ?? null,
      lines,
      proformaId: base?.proformaId ?? null,
    };
  }

  /** Computes amounts, notations and builds the Invoice document from a state. */
  private compose(state: DraftState, seller: SellerProfile, prev: Invoice | null): Invoice {
    const ctx = { currency: state.currency, exchangeRate: state.exchangeRate === '0' ? '1' : state.exchangeRate };
    const lines = computeLines(state.lines, ctx);
    const totals = computeTotals(lines, { ...ctx, paymentMethod: state.paymentMethod });
    const now = this.ts();
    const inv: Invoice = {
      id: prev?.id ?? newId('inv'),
      documentType: state.documentType,
      status: 'draft',
      seriesId: state.seriesId,
      number: null,
      issueDate: state.issueDate,
      fulfillmentDate: state.fulfillmentDate,
      dueDate: state.dueDate,
      paymentMethod: state.paymentMethod,
      currency: state.currency,
      exchangeRate: state.exchangeRate,
      exchangeRateDate: state.exchangeRateDate,
      exchangeRateSource: state.exchangeRateSource,
      language: state.language,
      appearance: state.appearance,
      seller,
      customerId: state.customerId,
      customer: state.customer,
      lines,
      totals,
      comment: state.comment,
      internalNote: state.internalNote,
      orderNumber: state.orderNumber,
      reference: state.reference,
      notations: [],
      paymentStatus: 'unpaid',
      paidAmount: '0',
      paidDate: null,
      navStatus: 'not_applicable',
      navTransactionId: null,
      navMessages: [],
      cancelledById: null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      issuedAt: null,
      contentHash: null,
    };
    if (state.dueDateExplicit) inv.dueDateExplicit = true;
    if (state.proformaId) inv.proformaId = state.proformaId;
    // Stored as given – also false (inline buyer data), so the one-time pass of flagRecordBuyerDrafts, which
    // looks only at drafts without the flag, never takes such a draft for an older one; null: not stored.
    if (state.customerFromRecord !== null) inv.customerFromRecord = state.customerFromRecord && state.customerId !== null;
    inv.notations = buildNotations({ documentType: inv.documentType, seller, customer: inv.customer, lines, language: inv.language, reference: inv.reference });
    return inv;
  }

  /** The seller data a document is composed with: the current profile; for a correction with the regime of its original. */
  private sellerFor(state: DraftState, current: SellerProfile): SellerProfile {
    const original = state.reference ? this.store.getInvoice(state.reference.originalInvoiceId) : null;
    return original ? correctionSeller(original, current) : current;
  }

  async createDraft(input: DraftInput, actor?: Actor): Promise<InvoiceView> {
    const seller = this.requireSeller();
    let base: DraftState | null = null;
    if (input.copyFromId) {
      const src = this.getInvoice(input.copyFromId);
      if (src.documentType === 'storno' || src.documentType === 'modification') {
        throw new AppError('INVALID_INPUT', 'Sztornó vagy módosító számla nem másolható.', { hint: 'Az eredeti számlát másold.' });
      }
      const s = this.stateOf(src);
      const today = this.today();
      base = {
        ...s,
        documentType: src.documentType === 'proforma' && !input.documentType ? 'invoice' : s.documentType,
        seriesId: '',
        issueDate: today,
        fulfillmentDate: today,
        // The payment term of the source, counted from today.
        dueDate: s.dueDate && s.issueDate ? addDays(today, Math.max(0, daysBetween(s.issueDate, s.dueDate))) : null,
        dueDateExplicit: false,
        reference: null,
        // A copy has a new tax point (Áfa tv. 80. §): the source's rate is never carried over – applyInput
        // treats it as an omitted rate (MNB policy: the MNB rate of the new fulfilment date; manual policy:
        // EXCHANGE_RATE_MISSING until a rate is given). An exchangeRate given in this call wins.
        exchangeRate: s.currency === 'HUF' ? '1' : '0',
        exchangeRateDate: null,
        exchangeRateSource: null,
        lines: s.lines.map((l) => {
          const { modifiesLineNo: _m, ...rest } = l;
          return rest;
        }),
        // A copy of an invoice is not made from its díjbekérő; a converted díjbekérő is (issue carries its payment).
        proformaId: src.documentType === 'proforma' ? src.id : null,
      };
      if (src.documentType === 'proforma') {
        const note = `Díjbekérő: ${src.number ?? src.id}`;
        base.internalNote = base.internalNote ? `${base.internalNote}\n${note}` : note;
      }
      if (input.seriesId === undefined) base.seriesId = '';
      // The buyer of a copied document is its customer record, with the record's current data (applyInput);
      // without one, the copied buyer data are the copy's own (a copied draft keeps its flag).
      if (src.status !== 'draft') base.customerFromRecord = !!(s.customerId && this.store.getCustomer(s.customerId));
    }
    if (!base && !input.lines?.length) {
      throw new AppError('INVALID_INPUT', 'Legalább egy számlatétel szükséges.', { hint: 'lines: [{ description, quantity, unit, unitPrice, vatCode }]' });
    }
    const state = await this.applyInput(base && base.seriesId === '' ? { ...base, seriesId: '' } : base, input, seller, actor);
    // Everything that can fail was checked: the buyer to save (saveCustomer), the draft and their audit
    // entries are stored together, so a rejected draft saves no customer.
    const inv = this.store.tx(() => {
      this.storeCustomerOf(state, actor);
      const draft = this.compose(state, seller, null);
      this.store.insertDraft(draft);
      this.audit('invoice.draft.create', 'invoice', draft.id, { documentType: draft.documentType, customer: draft.customer.name, gross: draft.totals.grossAmount, currency: draft.currency }, actor);
      return draft;
    });
    return this.withDefaultCurrencyNote(this.draftView(inv), input);
  }

  /** Stores the customer of saveCustomer (DraftState.customerSave) – inside the draft's transaction. */
  private storeCustomerOf(state: DraftState, actor?: Actor): void {
    if (!state.customerSave) return;
    state.customer = customerDataOf(this.storeCustomer(state.customerSave.input, actor, state.customerSave.id).customer);
  }

  async updateDraft(id: string, patch: DraftPatch, actor?: Actor): Promise<InvoiceView> {
    const prev = this.getInvoice(id);
    if (prev.status !== 'draft') {
      throw new AppError('NOT_A_DRAFT', `A(z) ${prev.number ?? prev.id} számla már ki van állítva, nem módosítható.`, { hint: 'Kiállított számlát sztornó számlával vagy módosító számlával lehet javítani.' });
    }
    if (patch.documentType && (prev.documentType === 'storno' || prev.documentType === 'modification')) {
      throw new AppError('INVALID_INPUT', 'Sztornó/módosító számla típusa nem változtatható.');
    }
    if (prev.documentType === 'modification' && patch.lines && patch.lines.length === 0) throw noCorrectionLines();
    const state = this.stateOf(prev);
    const seller = this.sellerFor(state, this.requireSeller());
    const next = await this.applyInput(state, patch, seller, actor);
    // As in createDraft: a customer to save (saveCustomer) is stored only together with the draft.
    const inv = this.store.tx(() => {
      this.storeCustomerOf(next, actor);
      const draft = this.compose(next, seller, prev);
      this.store.updateDraft(draft);
      this.audit('invoice.draft.update', 'invoice', draft.id, { fields: Object.keys(patch) }, actor);
      return draft;
    });
    return this.draftView(inv);
  }

  deleteDraft(id: string, actor?: Actor): void {
    const inv = this.getInvoice(id);
    if (inv.status !== 'draft') {
      throw new AppError('NOT_A_DRAFT', 'Kiállított számla nem törölhető.', { hint: 'Kiállított számlát sztornó számlával lehet érvényteleníteni.' });
    }
    this.store.deleteDraft(inv.id);
    this.audit('invoice.draft.delete', 'invoice', inv.id, { customer: inv.customer.name }, actor);
  }

  /** All issued documents that modify `original` (modifications and stornos), in issue order. */
  private chainOf(original: Invoice): Invoice[] {
    return this.store
      .findInvoices({ originalInvoiceId: original.id, status: ['issued', 'cancelled'], sort: 'issued_asc', limit: 500, offset: 0 })
      .items;
  }

  /** Highest NAV line number used so far in the modification chain of `original`. */
  private maxChainLineNumber(original: Invoice): number {
    let max = original.lines.length;
    for (const m of this.chainOf(original)) {
      for (const l of m.lines) {
        if (l.modificationRef?.lineOperation === 'CREATE') max = Math.max(max, l.modificationRef.lineNumberReference);
      }
    }
    return max;
  }

  /** Creates a draft of a módosító (helyesbítő) számla for an issued invoice. Lines are DELTAS. */
  async createCorrectionDraft(originalIdOrNumber: string, input: { lines?: LineInput[]; comment?: string | null; fulfillmentDate?: IsoDate }, actor?: Actor): Promise<InvoiceView> {
    const original = this.getInvoice(originalIdOrNumber);
    this.assertCorrectable(original);
    if (!input.lines?.length) throw noCorrectionLines();
    const seller = correctionSeller(original, this.requireSeller());
    const base: DraftState = {
      ...this.stateOf(original),
      documentType: 'modification',
      // The invoice's current fulfilment date: its latest modification's, if any. The exchange rate stays
      // the original's (applyInput keeps a correction's rate).
      fulfillmentDate: chainFulfillmentDate(original, this.chainOf(original)).date,
      issueDate: this.today(),
      dueDate: this.today(),
      dueDateExplicit: false,
      comment: input.comment?.trim() || null,
      internalNote: null,
      reference: {
        originalInvoiceId: original.id,
        originalInvoiceNumber: original.number as string,
        modificationIndex: this.store.nextModificationIndex(original.id),
        modifyWithoutMaster: false,
        originalDocumentType: original.documentType,
      },
      lines: [],
      proformaId: null,
    };
    const patch: DraftPatch = {};
    if (input.lines) patch.lines = input.lines;
    if (input.fulfillmentDate) patch.fulfillmentDate = input.fulfillmentDate;
    const state = await this.applyInput(base, patch, seller, actor);
    for (const l of state.lines) {
      if (l.modifiesLineNo !== undefined && (l.modifiesLineNo < 1 || l.modifiesLineNo > this.maxChainLineNumber(original))) {
        throw new AppError('INVALID_INPUT', `A módosított sor száma (${l.modifiesLineNo}) nem létezik az eredeti számlán.`);
      }
    }
    const inv = this.compose(state, seller, null);
    this.store.insertDraft(inv);
    this.audit('invoice.correction.draft', 'invoice', inv.id, { original: original.number }, actor);
    return this.draftView(inv);
  }

  private assertCorrectable(original: Invoice): void {
    if (original.status === 'draft') throw new AppError('NOT_ISSUED', 'Piszkozatot nem kell javítani – módosítsd közvetlenül (invoice_draft).');
    if (original.status === 'cancelled') throw new AppError('ALREADY_CANCELLED', `A(z) ${original.number} számla már sztornózva van.`);
    if (original.documentType === 'storno' || original.documentType === 'modification') {
      throw new AppError('INVALID_INPUT', 'Sztornó vagy módosító számlát nem lehet tovább javítani; az eredeti számlára hivatkozz.', { hint: `Eredeti: ${original.reference?.originalInvoiceNumber ?? '?'}` });
    }
    if (original.documentType === 'proforma') throw new AppError('INVALID_INPUT', 'A díjbekérő nem számla, nem kell helyesbíteni.');
  }

  // ===========================================================================================
  // Issuing
  // ===========================================================================================

  /**
   * A draft whose buyer is a customer record (customerFromRecord) is previewed and issued with the
   * record's current data, as with the seller's: a customer_save after the draft reaches it, and changes
   * the preview (so an earlier confirmation stops matching). Inline buyer data and the buyer of a
   * correction (the original's) stay as stored.
   */
  private withCurrentCustomer(state: DraftState): void {
    if (state.reference || !state.customerFromRecord || !state.customerId) return;
    const c = this.store.getCustomer(state.customerId);
    if (c) state.customer = customerDataOf(c);
  }

  /**
   * Drafts saved before a draft's buyer followed its customer record have no customerFromRecord flag. Once
   * per database, every such draft that names a customer record (customerId; not a correction, whose buyer
   * is the original's) and whose stored buyer data equal the record's current data gets the flag, and from
   * then on follows the record like a draft made today; each one is logged ('invoice.draft.update'). A draft
   * whose data differ keeps them (ownBuyerNote: BUYER_DIFFERS_FROM_RECORD). Only drafts without the flag:
   * drafts saved since carry it either way (false: inline buyer data, also with a record's id), so a pass
   * deferred to a later start never makes such a draft follow the record. The key is read again inside the
   * transaction, so processes starting together do it once; an error leaves it for the next start.
   */
  private flagRecordBuyerDrafts(): void {
    const KEY = 'draftBuyersFollowRecords';
    try {
      if (this.store.getSetting(KEY) !== null) return;
      this.store.tx(() => {
        if (this.store.getSetting(KEY) !== null) return;
        // Read first (one query), updated after: nothing is written while the drafts are being read.
        const drafts: Invoice[] = [];
        this.store.forEachInvoice({ status: ['draft'], sort: 'created_desc' }, (d) => drafts.push(d));
        for (const d of drafts) {
          if (d.reference || d.customerFromRecord !== undefined || !d.customerId) continue;
          const record = this.store.getCustomer(d.customerId);
          if (!record || canonicalJson(customerDataOf(record)) !== canonicalJson(d.customer)) continue;
          this.store.updateDraft({ ...d, customerFromRecord: true });
          this.audit('invoice.draft.update', 'invoice', d.id, { fields: ['customerFromRecord'] }, 'system');
        }
        this.store.setSetting(KEY, 1);
      });
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
  }

  /**
   * BUYER_DIFFERS_FROM_RECORD: a draft naming a customer record (customerId) whose buyer data are its own
   * (customerFromRecord not true – inline data, or a draft saved before drafts followed their record) and differ
   * from the record's current data. It is issued with its own data; giving the customer again
   * (invoice_draft { draftId, customerId }) switches it to the record's.
   */
  private ownBuyerNote(draft: Invoice): ValidationIssue | null {
    if (draft.reference || draft.customerFromRecord === true || !draft.customerId) return null;
    const record = this.store.getCustomer(draft.customerId);
    if (!record) return null;
    const data = customerDataOf(record);
    if (canonicalJson(data) === canonicalJson(draft.customer)) return null;
    const differ = BUYER_FIELDS.filter(([k]) => canonicalJson(data[k] ?? null) !== canonicalJson(draft.customer[k] ?? null)).map(([, label]) => label);
    return issue(
      'BUYER_DIFFERS_FROM_RECORD',
      `A piszkozat a saját vevőadatait tartja meg, és ezek eltérnek a vevők között tárolt adatoktól${differ.length ? ` (eltér: ${differ.join(', ')})` : ''}: kiállításkor a piszkozat adatai kerülnek a számlára, a tárolt vevő módosítása nem hat rá. Ha a tárolt adatokkal kell kiállítani, válaszd ki újra a vevőt: invoice_draft { draftId, customerId: "${draft.customerId}" }.`,
      'customer',
      'warning',
    );
  }

  /**
   * Issue date and due date issue() gives a draft today: the kelt is always the day of issuing; a due
   * date derived from the payment term moves with it (the buyer keeps the full term), a due date given
   * explicitly stays.
   */
  private issueDates(d: { issueDate: IsoDate; dueDate: IsoDate | null; dueDateExplicit: boolean }): { issueDate: IsoDate; dueDate: IsoDate | null; changed: boolean } {
    const today = this.today();
    if (d.issueDate === today) return { issueDate: today, dueDate: d.dueDate, changed: false };
    const dueDate = d.dueDate && !d.dueDateExplicit ? addDays(d.dueDate, daysBetween(d.issueDate, today)) : d.dueDate;
    return { issueDate: today, dueDate, changed: true };
  }

  /**
   * The series issue() takes the number of a draft from. An archived series never allocates a new
   * number: a modification or storno – which keeps its original's series – is numbered from the current
   * default invoice series then (`note`: a warning naming it), any other draft cannot be issued until it
   * gets an active series (`blocked`; `note`: the same as an error).
   */
  private issuingSeries(state: { seriesId: string; reference: InvoiceReference | null }): { seriesId: string; note: ValidationIssue | null; blocked: AppError | null } {
    const series = this.store.getSeries(state.seriesId);
    if (!series?.archived) return { seriesId: state.seriesId, note: null, blocked: null };
    const def = state.reference ? this.store.getDefaultSeries('invoice') : null;
    if (!def) {
      const blocked = seriesArchived(series);
      return { seriesId: series.id, note: issue(blocked.code, `${blocked.message} ${blocked.hint ?? ''}`.trim(), 'seriesId'), blocked };
    }
    const original = state.reference ? this.store.getInvoice(state.reference.originalInvoiceId) : null;
    const archived = original?.seriesId === series.id ? `Az eredeti számla sorszámtartománya („${series.name}”)` : `A(z) „${series.name}” sorszámtartomány`;
    return {
      seriesId: def.id,
      note: issue('CORRECTION_SERIES_ARCHIVED', `${archived} archivált, ezért a(z) „${def.name}” sorszámtartományból kap sorszámot.`, 'seriesId', 'warning'),
      blocked: null,
    };
  }

  /**
   * What issue() would make of `draft` today, without number: the dates of issueDates(), the current
   * seller profile (a correction keeps the VAT regime of its original), the next modification index,
   * amounts and notations recomputed. This is the preview shown for a draft, so what the user approves is
   * what gets issued; `notes` warns when the dates differ from the ones stored in the draft.
   */
  private issuePreview(draft: Invoice): { invoice: Invoice; notes: ValidationIssue[] } {
    const state = this.stateOf(draft);
    this.withCurrentCustomer(state);
    const dates = this.issueDates(state);
    const notes: ValidationIssue[] = [];
    if (dates.changed) {
      const due = !state.dueDate
        ? '.'
        : state.dueDateExplicit
          ? `; a megadott fizetési határidő (${state.dueDate}) nem változik.`
          : `, a fizetési határidő ugyanennyivel eltolódik: ${state.dueDate} → ${dates.dueDate}.`;
      notes.push(issue('ISSUE_DATE_WILL_CHANGE', `A piszkozat kelte ${state.issueDate}; kiállításkor a számla kelte a kiállítás napja (${dates.issueDate}) lesz${due}`, 'issueDate', 'warning'));
    }
    state.issueDate = dates.issueDate;
    state.dueDate = dates.dueDate;
    const numbering = this.issuingSeries(state);
    state.seriesId = numbering.seriesId;
    if (numbering.note) notes.push(numbering.note);
    const ownBuyer = this.ownBuyerNote(draft);
    if (ownBuyer) notes.push(ownBuyer);
    const original = state.reference ? this.store.getInvoice(state.reference.originalInvoiceId) : null;
    if (state.reference && original) {
      // A storno is issued as the negation of the chain as it is then (issue: negateChain) – previewed the same way.
      if (state.documentType === 'storno') this.negateChain(state, original);
      else state.reference = { ...state.reference, modificationIndex: this.store.nextModificationIndex(original.id) };
    }
    const current = this.getSeller() ?? draft.seller;
    const invoice = this.compose(state, original ? correctionSeller(original, current) : current, draft);
    invoice.updatedAt = draft.updatedAt;
    return { invoice, notes };
  }

  /**
   * What an issue confirmation is bound to: exactly what issue() would put on the invoice now – the
   * draft content and its preview (issuePreview: the issue and due date it gets today, the current seller
   * profile, a correction's modification index) and, for a document converted from a paid díjbekérő, what
   * issuing does with that payment (proformaPayment: its amount and date, another document already made
   * from the díjbekérő, whether it is carried over or why not). Editing the draft, passing midnight,
   * changing the seller data, issuing another correction of the same original, or a payment or another
   * conversion of the díjbekérő all change it, so an earlier confirmation stops matching.
   */
  issueFingerprint(id: string): string {
    const draft = this.getInvoice(id);
    let shown = draft;
    let preview: string | null = null;
    try {
      shown = this.issuePreview(draft).invoice;
      preview = invoiceContentHash(shown);
    } catch (e) {
      if (!isAppError(e)) throw e;
    }
    const p = this.proformaPayment(shown);
    const proforma = p ? [p.proforma.id, p.proforma.paidAmount, p.proforma.paidDate, p.invoicedBy?.id ?? null, p.skip] : null;
    return sha256Hex(canonicalJson(['issue', draft.id, invoiceContentHash(draft), preview, this.today(), this.getSeller(), proforma]));
  }

  /**
   * What a storno confirmation is bound to: the original document, every issued correction in its chain
   * (the storno negates all of them), the reason as cancel() stores it (normalizeCancelReason – a reason it
   * refuses binds nothing: INVALID_INPUT), the issue date and the current seller profile.
   */
  cancelFingerprint(idOrNumber: string, reason: string): string {
    const inv = this.getInvoice(idOrNumber);
    const chain = inv.documentType === 'proforma' ? [] : this.chainOf(inv).map((m) => [m.id, m.contentHash]);
    return sha256Hex(canonicalJson(['cancel', inv.id, inv.contentHash, inv.status, chain, normalizeCancelReason(reason, inv.documentType === 'proforma'), this.today(), this.getSeller()]));
  }

  /**
   * Finalises a draft: assigns the number, freezes the document, renders the PDF, reports to NAV. The
   * payment data follow in the same transaction (mutable data – the content and its hash stay as issued):
   * a document converted from a paid díjbekérő takes over its payment, `markPaid` records what is still
   * open as paid on the issue date, and a modification settles its invoice chain anew (settleChain). A storno
   * is made, inside the issuing transaction, from the invoice chain as it is then (negateChain): it negates
   * the original and every modification issued before it, also one another process issued meanwhile.
   */
  async issue(id: string, opts: { submitToNav?: boolean; auditDetails?: Record<string, unknown>; markPaid?: boolean } = {}, actor?: Actor): Promise<IssueResult> {
    return this.issueDraft(id, opts, actor, null);
  }

  /**
   * issue(); `confirmedStorno` (cancel()): the reason of the storno and the cancelFingerprint its confirmation was
   * made for – checked again inside the issuing transaction, so a storno whose chain changed after its preview
   * (another process issued a modification of the invoice meanwhile) is refused (STORNO_CHAIN_CHANGED) instead of
   * being issued with amounts nobody approved.
   */
  private async issueDraft(
    id: string,
    opts: { submitToNav?: boolean; auditDetails?: Record<string, unknown>; markPaid?: boolean },
    actor: Actor | undefined,
    confirmedStorno: { reason: string; fingerprint: string } | null,
  ): Promise<IssueResult> {
    const draft = this.getInvoice(id);
    if (draft.status !== 'draft') {
      throw new AppError('NOT_A_DRAFT', `A(z) ${draft.number ?? draft.id} már ki van állítva.`);
    }
    const seller = this.requireSeller();
    // One view of the settings for the whole issuing (nav-setup may save new NAV settings meanwhile).
    const cfg = this.config;
    const notes: string[] = [];
    const notices: IssueNotice[] = [];
    const note = (code: string, text: string, detail?: string): void => {
      notes.push(text);
      notices.push({ code, text, ...(detail === undefined ? {} : { detail }) });
    };
    const state = this.stateOf(draft);
    // Same buyer and dates as the preview (issuePreview) showed.
    this.withCurrentCustomer(state);
    state.customerFromRecord = null; // a draft-only flag: not kept at issue
    const dates = this.issueDates(state);
    if (dates.changed) {
      const due = !dates.dueDate ? '.' : state.dueDateExplicit ? `; a megadott fizetési határidő (${dates.dueDate}) nem változott.` : `; a fizetési határidő ugyanennyivel eltolódott: ${dates.dueDate}.`;
      note('ISSUE_DATE_CHANGED', `A számla kelte a kiállítás napja (${dates.issueDate}) lett${due}`);
    }
    state.issueDate = dates.issueDate;
    state.dueDate = dates.dueDate;
    state.dueDateExplicit = false; // a draft-only flag

    let issued!: Invoice;
    this.store.tx(() => {
      // Never a number from an archived series (as the preview showed it: issuingSeries).
      const numbering = this.issuingSeries(state);
      if (numbering.blocked) throw numbering.blocked;
      state.seriesId = numbering.seriesId;
      if (numbering.note) note(numbering.note.code, numbering.note.message);
      const original = state.reference ? this.store.getInvoice(state.reference.originalInvoiceId) : null;
      if (state.reference && original) {
        this.assertCorrectable(original);
        if (state.documentType === 'storno') {
          if (confirmedStorno && this.cancelFingerprint(original.id, confirmedStorno.reason) !== confirmedStorno.fingerprint) throw stornoChainChanged(original);
          // The chain as it is now, in this transaction – not as it was when the storno draft was made.
          this.negateChain(state, original);
        } else {
          state.reference = { ...state.reference, modificationIndex: this.store.nextModificationIndex(original.id) };
        }
        // NAV line references: every line of a modification/storno is a NEW line (lineOperation CREATE –
        // MODIFY is rejected by NAV since 2023-09-18, ERROR INVALID_LINE_OPERATION) numbered after the
        // highest line number used so far in the chain of the original invoice.
        let next = this.maxChainLineNumber(original);
        const lines = computeLines(state.lines, { currency: state.currency, exchangeRate: state.exchangeRate });
        for (const l of lines) l.modificationRef = { lineNumberReference: ++next, lineOperation: 'CREATE' };
        const inv = this.compose(state, correctionSeller(original, seller), draft);
        inv.lines = lines;
        issued = inv;
      } else {
        issued = this.compose(state, seller, draft);
      }
      const issues = this.validate(issued);
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length) {
        // A storno has no draft to fix (cancel() makes and removes it): the cause named in the message is.
        const storno = issued.documentType === 'storno';
        throw new AppError('VALIDATION_FAILED', `${storno ? 'A sztornó számla' : 'A számla'} nem állítható ki: ${errors.map((e) => e.message).join(' ')}`, {
          hint: storno ? STORNO_REFUSED_HINT : 'Javítsd a hibákat a piszkozatban, majd próbáld újra.',
          details: { issues, documentType: issued.documentType },
        });
      }
      const series = this.store.getSeries(issued.seriesId);
      if (!series) throw notFound('Sorszámtartomány', issued.seriesId);
      const { seq, year } = this.store.allocateSequence(series.id, issued.issueDate);
      issued.number = formatNumber(series.pattern, seq, year);
      issued.status = 'issued';
      issued.issuedAt = this.ts();
      issued.updatedAt = issued.issuedAt;
      // Unusable NAV settings (navProblem) count as not configured: nothing can be sent until they are fixed.
      issued.navStatus = issued.documentType === 'proforma' ? 'not_applicable' : cfg.nav && !cfg.navProblem ? 'pending' : 'not_configured';
      // Pending in the configured NAV environment: switched to the other one, it is not reported there by itself.
      if (issued.navStatus === 'pending' && cfg.nav) issued.navEnvironment = cfg.nav.environment;
      issued.contentHash = invoiceContentHash(issued);
      this.store.markIssued(issued);
      if (issued.documentType === 'storno' && original) {
        this.store.patchInvoice(original.id, { status: 'cancelled', cancelledById: issued.id });
      }
      this.audit('invoice.issue', 'invoice', issued.id, {
        number: issued.number, documentType: issued.documentType, customer: issued.customer.name,
        gross: issued.totals.grossAmount, currency: issued.currency, original: issued.reference?.originalInvoiceNumber ?? null,
        // Chain-protected evidence for verifyIntegrity: the content as issued and its place in the series.
        contentHash: issued.contentHash, seriesId: series.id, seq, year,
        ...(opts.auditDetails ?? {}),
      }, actor);
      if (issued.documentType === 'storno') return;
      // A modification changes what is open on its chain (a credit note is set off against the original).
      if (issued.documentType === 'modification') this.settleChainOf(issued, issued.number, actor);
      const carried = this.carryProformaPayment(issued, actor);
      if (carried) note('PROFORMA_PAYMENT', carried);
      if (opts.markPaid) note('MARK_PAID', this.markPaidAtIssue(issued, actor));
    });

    let pdfPath: string | null = null;
    let pdfError: string | null = null;
    try {
      // Rendered once, after the issue transaction, and kept as the document's original (pdf()).
      const r = await this.pdf(issued.id, {}, actor);
      pdfPath = r.path;
      if (r.previousFile) note('PDF_PREVIOUS_KEPT', previousPdfNote(r.path, r.previousFile));
    } catch (e) {
      pdfError = e instanceof Error ? e.message : String(e);
      note('PDF_FAILED', 'A PDF előállítása nem sikerült; a következő PDF-kérés (letöltés) újra megpróbálja, és az így elkészülő PDF lesz az eredeti.');
    }

    // The invoice is issued (numbered and committed) from here on: a NAV problem goes into the result, it is
    // never thrown – an error would read as "not issued" and could get the same sale invoiced twice. For the same
    // reason the NAV part is bounded (NAV_ISSUE_BUDGET_MS): MCP clients give up on a call after 60 s by default.
    let nav: NavInvoiceResult | null = null;
    if (issued.documentType !== 'proforma') {
      const navConfig = cfg.nav;
      if (!navConfig) {
        note(
          'NAV_NOT_CONFIGURED',
          'FIGYELEM: NAV Online Számla nincs beállítva – ezt a számlát a törvény szerint haladéktalanul jelenteni kell a NAV-nak. ' +
            `Állítsd be a NAV kapcsolatot (${navSetupCommand(cfg.dataDir)}), majd futtasd a nav_sync-et.`,
        );
      } else if (cfg.navProblem) {
        note(
          'NAV_INVALID_CONFIG',
          `FIGYELEM: a NAV-kapcsolat beállítása hibás, ezért ez a számla nem került jelentésre: ${cfg.navProblem} ` +
            `A törvény szerint haladéktalanul jelenteni kell: javítsd a beállítást (${navSetupCommand(cfg.dataDir)}), majd futtasd a nav_sync-et.`,
        );
      } else {
        if (navConfig.environment === 'test') {
          note('NAV_TEST_ENVIRONMENT', 'TESZT környezet: a NAV-kapcsolat a NAV tesztrendszerére mutat, ezért ez a számla nem kerül éles adatszolgáltatásba. Valódi számlát éles (production) NAV-kapcsolattal kell jelenteni.');
        }
        if ((opts.submitToNav ?? cfg.navAutoSubmit) && this.navRuns > 0) {
          // Never queued behind a running sync (with NAV not answering it can take minutes): the next nav_sync reports
          // it – and the claim of every submission in the database keeps it from being sent twice.
          nav = this.navResult(this.getInvoice(issued.id), navConfig.environment, NAV_BUSY_NOTE);
          note('NAV_BUSY', NAV_BUSY_NOTE);
        } else if (opts.submitToNav ?? cfg.navAutoSubmit) {
          try {
            const res = await this.navSync({ invoiceId: issued.id, waitSeconds: cfg.navWaitSeconds, issue: true }, actor);
            nav = res[0] ?? null;
          } catch (e) {
            const hint = isAppError(e) && e.hint ? ` ${e.hint}` : '';
            note('NAV_NOT_STARTED', `A számla kiállítva, de a NAV-beküldés nem indult el: ${e instanceof Error ? e.message : String(e)}${hint} A hiba elhárítása után futtasd a nav_sync-et.`, e instanceof Error ? e.message : String(e));
          }
        } else {
          note('NAV_NOT_SUBMITTED', 'A NAV-jelentés függőben van – futtasd a nav_sync eszközt.');
        }
      }
    }
    let invoice = issued;
    try {
      invoice = this.getInvoice(issued.id);
    } catch {
      // the committed copy is returned
    }
    return { invoice, pdfPath, pdfError, nav, notes, notices };
  }

  /** Draft state of the storno of `original`: every line of it and of its issued corrections, negated. */
  private stornoState(original: Invoice, reason: string | null | undefined): { state: DraftState; chain: Invoice[] } {
    const chain = this.chainOf(original);
    const chainLines = [...original.lines, ...chain.flatMap((m) => m.lines)];
    const today = this.today();
    const state: DraftState = {
      ...this.stateOf(original),
      documentType: 'storno',
      // The invoice's current fulfilment date: its latest modification's, if any (NAV WARN 11401).
      fulfillmentDate: chainFulfillmentDate(original, chain).date,
      issueDate: today,
      dueDate: today,
      dueDateExplicit: false,
      comment: reason?.trim() ? `${STORNO_REASON_LABEL[original.language] ?? STORNO_REASON_LABEL.hu}: ${reason.trim()}` : null,
      internalNote: null,
      reference: {
        originalInvoiceId: original.id,
        originalInvoiceNumber: original.number as string,
        modificationIndex: this.store.nextModificationIndex(original.id),
        modifyWithoutMaster: false,
        originalDocumentType: original.documentType,
      },
      lines: stornoLineInputs(chainLines),
      proformaId: null,
    };
    return { state, chain };
  }

  /**
   * Makes `state` (a storno of `original`) the negation of the invoice chain as it is now: the lines, the
   * fulfilment date and the reference (with the next modification index) of stornoState. issue() calls it inside
   * its transaction, so a modification issued after the storno draft was made – by another process – is negated
   * too; the reason (comment) and everything else stay.
   */
  private negateChain(state: DraftState, original: Invoice): void {
    const { state: now } = this.stornoState(original, null);
    state.lines = now.lines;
    state.fulfillmentDate = now.fulfillmentDate;
    state.reference = now.reference;
  }

  /**
   * The reason cancel() stores for cancelling `idOrNumber` – a storno, or the withdrawal of a díjbekérő –,
   * normalised (normalizeCancelReason): INVALID_INPUT when it has fewer than 3 visible characters. The MCP
   * tools and the web ask for it before a confirmation code is minted or a dialog is shown.
   */
  cancelReason(idOrNumber: string, reason: string | null | undefined): string {
    return normalizeCancelReason(reason, this.getInvoice(idOrNumber).documentType === 'proforma');
  }

  /**
   * What cancel() would issue for an invoice now, without storing anything: the storno document (its
   * amounts negate the original AND every issued modification of it), the modifications it negates, the
   * reason as cancel() stores it (normalizeCancelReason: INVALID_INPUT when it is too short) and its
   * validation issues. Díjbekérők have no storno (they are withdrawn).
   */
  stornoPreview(idOrNumber: string, reason?: string | null): StornoPreview {
    const original = this.getInvoice(idOrNumber);
    if (original.documentType === 'proforma') throw new AppError('INVALID_INPUT', 'A díjbekérő nem számla: nincs sztornó bizonylata, csak visszavonható.');
    this.assertCorrectable(original);
    const normalized = normalizeCancelReason(reason, false);
    const { state, chain } = this.stornoState(original, normalized);
    const numbering = this.issuingSeries(state);
    state.seriesId = numbering.seriesId;
    const storno = this.compose(state, correctionSeller(original, this.requireSeller()), null);
    return { original, storno, negates: chain, reason: normalized, issues: [...(numbering.note ? [numbering.note] : []), ...this.validate(storno)] };
  }

  /**
   * The refusal cancel() would give the storno of `p` (VALIDATION_FAILED, the storno hint, the issues in
   * `details`) when it has validation errors, else null. The MCP invoice_cancel checks it before the
   * confirmation code and the dialog: nobody is asked to approve a storno that cannot be issued.
   */
  stornoRefusal(p: StornoPreview): AppError | null {
    const errors = p.issues.filter((i) => i.severity === 'error');
    if (!errors.length) return null;
    return new AppError('VALIDATION_FAILED', `A sztornó számla nem állítható ki: ${errors.map((e) => e.message).join(' ')}`, { hint: STORNO_REFUSED_HINT, details: { issues: p.issues } });
  }

  /**
   * Cancels an issued invoice with an érvénytelenítő (sztornó) számla, or a díjbekérő directly. The storno negates
   * the chain as it is when it is issued (issue: negateChain). `confirmedFingerprint`: the cancelFingerprint the
   * user's confirmation was made for (the MCP confirmation code, the web confirmation) – when what it binds changed
   * before the storno's transaction (e.g. another process issued a modification of the invoice meanwhile), no
   * storno is issued: STORNO_CHAIN_CHANGED, to be confirmed again after a new preview.
   */
  async cancel(
    originalIdOrNumber: string,
    opts: { reason?: string | null; submitToNav?: boolean; auditDetails?: Record<string, unknown>; confirmedFingerprint?: string } = {},
    actor?: Actor,
  ): Promise<IssueResult> {
    const original = this.getInvoice(originalIdOrNumber);
    if (original.documentType === 'proforma') {
      if (original.status !== 'issued') throw new AppError('INVALID_INPUT', 'Csak kiállított díjbekérő vonható vissza.');
      const reason = normalizeCancelReason(opts.reason, true);
      this.store.patchInvoice(original.id, { status: 'cancelled' });
      this.audit('proforma.cancel', 'invoice', original.id, { number: original.number, reason, ...(opts.auditDetails ?? {}) }, actor);
      const withdrawn = 'A díjbekérő visszavonva (nem számla, nincs sztornó bizonylat).';
      return { invoice: this.getInvoice(original.id), pdfPath: null, pdfError: null, nav: null, notes: [withdrawn], notices: [{ code: 'PROFORMA_WITHDRAWN', text: withdrawn }] };
    }
    this.assertCorrectable(original);
    // The reason is printed on one line, like a buyer name – the same as its preview (normalizeCancelReason).
    const reason = normalizeCancelReason(opts.reason, false);
    const { state } = this.stornoState(original, reason);
    const draft = this.compose(state, correctionSeller(original, this.requireSeller()), null);
    this.store.insertDraft(draft);
    this.audit('invoice.storno.draft', 'invoice', draft.id, { original: original.number, reason }, actor);
    try {
      return await this.issueDraft(
        draft.id,
        { ...(opts.submitToNav === undefined ? {} : { submitToNav: opts.submitToNav }), ...(opts.auditDetails ? { auditDetails: opts.auditDetails } : {}) },
        actor,
        opts.confirmedFingerprint === undefined ? null : { reason, fingerprint: opts.confirmedFingerprint },
      );
    } catch (e) {
      const still = this.store.getInvoice(draft.id);
      if (still?.status === 'draft') this.store.deleteDraft(draft.id);
      throw e;
    }
  }

  // ===========================================================================================
  // Payments, PDF
  // ===========================================================================================

  /**
   * Records a payment for an issued document – on a crediting document (negative total) the refund to
   * the buyer, a negative amount. Default amount (defaultPayment): on a document something is payable on,
   * what its whole invoice chain still owes (settleChain – a credit note is set off against its original,
   * an overpayment covers the other documents of the chain); on a crediting document what is still to
   * refund on it. An amount of the opposite sign reverses earlier entries (e.g. one recorded by
   * mistake), down to nothing paid at most: the document is then unpaid again, without a payment date.
   * More than the total is accepted (overpayment) – except on a chain whose invoice received its díjbekérő's
   * payment at issue: on any of its documents an amount larger than what the chain still owes in total (chainOpen)
   * would count that payment twice (the full price recorded once more). A 0 Ft document is only marked as
   * settled (no amount). The payment status of every document of the chain follows (settleChain).
   * Nothing is recorded on the documents of a cancelled invoice: its storno negated them. On the storno only the
   * refund of what they received is recorded (stornoPayment). Every payment is a row of the payment ledger, with
   * its date; the chain's allocations, paid amounts and payment dates follow from it (applyPayment).
   */
  recordPayment(idOrNumber: string, input: { amount?: string | number; date?: IsoDate; allowOverpayment?: boolean }, actor?: Actor): Invoice {
    const inv = this.getInvoice(idOrNumber);
    const refused = paymentRefusal(inv);
    if (refused) throw refused;
    const given = input.amount !== undefined ? dec(input.amount, 'amount') : null;
    // An amount the document could not hold (100.123456 Ft) would leave a hátralék no payment can settle; a date after
    // today would put the payment – and, with cash accounting, its VAT – into a later period.
    const places = amountDecimals(inv.currency);
    if (given && given.decimalPlaces() > places) {
      throw new AppError(
        'INVALID_INPUT',
        places === 0
          ? `A befizetés összege egész szám legyen – a bizonylat összegei is egész ${inv.currency === 'HUF' ? 'forintok' : inv.currency}: ${toDec(given)}.`
          : `A befizetés összege legfeljebb ${places} tizedesjegyű lehet (${inv.currency}), mint a bizonylat összegei: ${toDec(given)}.`,
        { hint: places === 0 ? 'Pl. 12500 – fillér nélkül.' : 'Pl. 125.50.' },
      );
    }
    const date = input.date ? assertIsoDate(input.date, 'date') : this.today();
    if (date > this.today()) {
      throw new AppError('INVALID_INPUT', `A befizetés dátuma (${formatDate(date)}) későbbi a mai napnál (${formatDate(this.today())}).`, {
        hint: 'A befizetést a beérkezése után rögzítsd, a valódi dátumával (pénzforgalmi elszámolásnál ez dönti el az ÁFA időszakát).',
      });
    }
    // A payment long before the document (1900-01-01, 2002 for 2026) is a mistyped year: a real one can precede its
    // invoice (an advance, cash on delivery), but not by more than a year.
    if (daysBetween(date, inv.issueDate) > PAYMENT_BEFORE_ISSUE_MAX_DAYS) {
      throw new AppError('INVALID_INPUT', `A befizetés dátuma (${formatDate(date)}) több mint egy évvel korábbi a bizonylat kelténél (${formatDate(inv.issueDate)}).`, {
        hint: 'Ellenőrizd az évszámot: a befizetés a valódi dátumával rögzítendő.',
      });
    }
    this.store.tx(() => {
      // Checked again on the document as it is now: another process may have cancelled it (issued its storno)
      // while this one waited for the write lock.
      const current = this.getInvoice(inv.id);
      const refusedNow = paymentRefusal(current);
      if (refusedNow) throw refusedNow;
      const cancelled = this.cancelledOriginal(current);
      if (cancelled) {
        throw new AppError('INVALID_INPUT', `A(z) ${current.number} a sztornózott ${cancelled.number} számla módosító számlája: a sztornó számla ezt is semlegesítette, ezért rá fizetés nem rögzíthető.`, {
          hint: 'Ha a vevő fizetett, a befizetést a sztornózott számla helyett kiállított számlán rögzítsd.',
        });
      }
      // Payments of the chain still only in the audit log are taken over first (the carried díjbekérő payment too).
      this.syncLedger(this.ledgerChain(current).map((d) => d.id));
      // A payment over what the chain still owes would count the carried díjbekérő payment twice – on any document of it.
      const carried = given?.gt(0) && dec(current.totals.payableAmount).gt(0) ? this.carriedProformaPayment(current) : null;
      if (carried && given) {
        const open = this.chainOpen(current, this.paymentChain(current));
        if (given.gt(open)) {
          throw new AppError(
            'INVALID_INPUT',
            `A(z) ${carried.on} számlára a(z) ${carried.proforma} díjbekérő befizetése (${formatMoney(carried.amount, current.currency)}, ${formatDate(carried.date)}) a kiállításkor már átkerült; ` +
              `ez a befizetés ugyanazt a pénzt kétszer számolná (hátralék: ${formatMoney(open.gt(0) ? toDec(open) : '0', current.currency)}).`,
            { hint: 'Ugyanazt a befizetést ne rögzítsd újra. Ha valóban újabb befizetés érkezett, legfeljebb a hátralékot rögzítsd; a tévesen átvitt befizetés negatív összeggel vonható vissza.' },
          );
        }
      }
      // More than the chain still owes is an overpayment – recorded only when the caller says it is one: the usual
      // cause is a slipped digit (127 000 for 12 700), which would show the invoice paid and hide the rest.
      if (given?.gt(0) && dec(current.totals.payableAmount).gt(0) && current.documentType !== 'storno' && input.allowOverpayment !== true) {
        const open = this.chainOpen(current, this.paymentChain(current));
        const owed = open.gt(0) ? open : dec(0);
        if (given.gt(owed)) {
          throw new AppError(
            'OVERPAYMENT_NOT_CONFIRMED',
            `A megadott összeg (${formatMoney(toDec(given), current.currency)}) nagyobb a hátraléknál (${formatMoney(toDec(owed), current.currency)}): a különbözet (${formatMoney(toDec(given.minus(owed)), current.currency)}) túlfizetés lenne.`,
            { hint: 'Ellenőrizd az összeget (nem csúszott el egy számjegy vagy a tizedesjel?). Ha a vevő valóban ennyit fizetett, rögzítsd a túlfizetés kifejezett megerősítésével (allowOverpayment: true).' },
          );
        }
      }
      this.applyPayment(current, given, date, actor);
    });
    return this.getInvoice(inv.id);
  }

  /**
   * What was recorded on the document itself – its own payments and their reversals, not what payments of other
   * documents of its chain brought to it: the most a reversal on it can take back ("0": nothing to take back).
   */
  recordedOn(inv: Invoice): string {
    if (inv.status === 'draft') return '0';
    return toDec(sumDec(this.store.listPayments([inv.id]).map((p) => dec(p.amount))));
  }

  /**
   * What is still open on an issued document, in its currency: owed by the buyer (> 0), or on a crediting
   * document still to refund (< 0); "0" when settled. Settled with its invoice chain (settleChain): the
   * original invoice and the original's issued modifications. null for a draft, a cancelled document and a
   * modification of a cancelled invoice (nothing can be paid on them: the storno negated the whole chain – as
   * InvoiceFilter.receivable treats them). On a storno: what is still to refund to the buyer of what its
   * cancelled invoice received (< 0), "0" once refunded; null when that invoice received nothing.
   */
  openAmount(inv: Invoice): string | null {
    if (inv.status !== 'issued' || this.cancelledOriginal(inv)) return null;
    if (inv.documentType === 'storno') return this.stornoOpen(inv);
    return this.openIn(inv, this.paymentChain(inv));
  }

  /**
   * What recordPayment records on `inv` without an amount (defaultPayment) – "0": nothing (a 0 Ft
   * document is only marked settled; a settled one is refused); null when no payment can be recorded on
   * it at all (openAmount null). On a storno the refund still due.
   */
  defaultPaymentAmount(inv: Invoice): string | null {
    const open = this.openAmount(inv);
    if (open === null) return null;
    if (inv.documentType === 'storno') return open;
    if (dec(inv.totals.payableAmount).isZero()) return '0';
    return toDec(this.defaultPayment(inv, this.paymentChain(inv)));
  }

  /**
   * The payment history of a document (its payment ledger): the payments recorded on it and those recorded on another
   * document of its chain that it received part of – by payment date, then in recording order –, each with what it
   * brought to this document. A storno's history is its refunds; a draft has none.
   */
  paymentHistory(idOrNumber: string): PaymentHistoryEntry[] {
    const inv = this.getInvoice(idOrNumber);
    if (inv.status === 'draft') return [];
    const chain = this.ledgerChain(inv);
    const byId = new Map(chain.map((d) => [d.id, d] as const));
    const own = new Map<number, DecValue>();
    for (const a of this.store.listAllocations([inv.id])) own.set(a.paymentId, (own.get(a.paymentId) ?? dec(0)).plus(a.amount));
    return this.store
      .listPayments(chain.map((d) => d.id))
      .filter((p) => p.invoiceId === inv.id || !(own.get(p.id) ?? dec(0)).isZero())
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id - b.id))
      .map((p) => {
        const on = byId.get(p.invoiceId);
        return {
          paymentId: p.id,
          date: p.date,
          amount: toDec(own.get(p.id) ?? dec(0)),
          paymentAmount: p.amount,
          recordedOn: { id: p.invoiceId, number: on?.number ?? null },
          kind: paymentKind(dec(p.amount), dec(on?.totals.payableAmount ?? inv.totals.payableAmount)),
          source: p.source,
          reference: p.reference,
          recordedAt: p.createdAt,
        };
      });
  }

  /**
   * What markPaid would record issuing the draft now (markPaidAtIssue): what is then still open on the
   * new document – after the díjbekérő payment it carries over (proformaPayment), settled with its
   * invoice chain. > 0: a payment from the buyer; < 0: a refund to the buyer (a crediting document); "0":
   * nothing (a 0 Ft document is only marked settled).
   */
  markPaidAmount(id: string): string {
    const draft = this.getInvoice(id);
    if (draft.status !== 'draft') throw new AppError('NOT_A_DRAFT', `A(z) ${draft.number ?? draft.id} már ki van állítva.`);
    const inv = this.issuePreview(draft).invoice;
    if (inv.documentType === 'storno' || dec(inv.totals.payableAmount).isZero()) return '0';
    const p = this.proformaPayment(inv);
    const doc: Invoice = p?.carry ? { ...inv, paidAmount: p.proforma.paidAmount } : inv;
    const original = inv.reference ? this.store.getInvoice(inv.reference.originalInvoiceId) : null;
    const chain = original ? this.paymentChain(original) : null;
    return this.openIn(doc, chain ? [...chain, doc] : null);
  }

  /**
   * markPaid for a document (a draft's preview or an issued one) – the one rule of the MCP invoice_issue
   * nextStep and the web issue form: null – not offered (a díjbekérő, or nothing payable: a 0 Ft or
   * crediting document); 'suggested' – a cash or card sale, usually paid on the spot; 'offered' – otherwise.
   */
  markPaidHint(inv: Pick<Invoice, 'documentType' | 'paymentMethod' | 'totals'>): 'suggested' | 'offered' | null {
    if (inv.documentType === 'proforma' || !dec(inv.totals.payableAmount).gt(0)) return null;
    return inv.paymentMethod === 'CASH' || inv.paymentMethod === 'CARD' ? 'suggested' : 'offered';
  }

  /** The cancelled original `inv` modifies (its storno negated `inv` too), or null. */
  private cancelledOriginal(inv: Invoice): Invoice | null {
    if (!inv.reference || inv.documentType !== 'modification') return null;
    const original = this.store.getInvoice(inv.reference.originalInvoiceId);
    return original?.status === 'cancelled' ? original : null;
  }

  /** What the invoice chain of `inv` still has open in total (settleChain): owed (> 0) or to refund (< 0). */
  private chainOpen(inv: Invoice, chain: readonly Invoice[] | null): DecValue {
    return chain ? sumDec([...this.settlement(chain).values()].map((s) => s.open)) : dec(this.openIn(inv, null));
  }

  /**
   * The default payment on `inv`: on a document something is payable on, what its invoice chain still
   * owes in total, when it owes anything (after an upward modification of a paid invoice: the open
   * difference, also on the original); otherwise what is still open on `inv` itself (on a crediting
   * document the refund).
   */
  private defaultPayment(inv: Invoice, chain: readonly Invoice[] | null): DecValue {
    const own = dec(this.openIn(inv, chain));
    if (!dec(inv.totals.payableAmount).gt(0)) return own;
    const total = this.chainOpen(inv, chain);
    return total.gt(0) ? total : own;
  }

  /** openAmount of `inv` with its payment chain already loaded (null: settled on its own). */
  private openIn(inv: Invoice, chain: readonly Invoice[] | null): string {
    const payable = dec(inv.totals.payableAmount);
    if (payable.isZero()) return '0';
    const settled = chain ? this.settlement(chain).get(inv.id) : undefined;
    if (settled) return settled.open;
    const open = payable.minus(inv.paidAmount);
    return payable.isNegative() ? (open.lt(0) ? toDec(open) : '0') : open.gt(0) ? toDec(open) : '0';
  }

  /**
   * The payment chain of an issued document: its original invoice and the original's issued
   * modifications in issue order, settled together (settleChain). null for a storno and for the
   * documents of a cancelled invoice – its storno negated the chain: they are settled one by one.
   */
  private paymentChain(inv: Invoice): Invoice[] | null {
    if (inv.documentType === 'storno') return null;
    const original = inv.reference ? this.store.getInvoice(inv.reference.originalInvoiceId) : inv;
    if (!original || original.status !== 'issued') return null;
    const chain = [original];
    for (let offset = 0; ; offset += 500) {
      const page = this.store.findInvoices({ originalInvoiceId: original.id, status: ['issued'], documentType: ['modification'], sort: 'issued_asc', limit: 500, offset });
      chain.push(...page.items);
      if (page.items.length < 500) break;
    }
    return chain;
  }

  /** settleChain over `chain` (0 Ft documents take no part: they are only marked settled). */
  private settlement(chain: readonly Invoice[]): Map<string, Settlement> {
    return settleChain(chain.filter((d) => !dec(d.totals.payableAmount).isZero()).map((d) => ({ id: d.id, payable: d.totals.payableAmount, paid: d.paidAmount })));
  }

  /**
   * The chain whose payments are settled together in the payment ledger: the original of `inv`, the original's issued
   * modifications in issue order and, when the original is cancelled, its storno (settleLedger); a díjbekérő on its own.
   * The documents as stored now.
   */
  private ledgerChain(inv: Invoice): Invoice[] {
    if (inv.status === 'draft' || inv.documentType === 'proforma') return [inv];
    const original = inv.reference ? this.store.getInvoice(inv.reference.originalInvoiceId) : this.store.getInvoice(inv.id);
    if (!original) return [inv];
    const chain = [original];
    for (let offset = 0; ; offset += 500) {
      const page = this.store.findInvoices({ originalInvoiceId: original.id, status: ['issued'], documentType: ['modification'], sort: 'issued_asc', limit: 500, offset });
      chain.push(...page.items);
      if (page.items.length < 500) break;
    }
    const storno = original.cancelledById ? this.store.getInvoice(original.cancelledById) : null;
    if (storno) chain.push(storno);
    return chain;
  }

  /** settleLedger over the documents of `chain` and its `payments`. */
  private ledgerOf(chain: readonly Invoice[], payments: readonly Payment[]): ChainLedger {
    return settleLedger(
      chain.map((d) => ({ id: d.id, payable: d.totals.payableAmount, ...(d.documentType === 'storno' ? { storno: true } : {}) })),
      payments.map((p) => ({ id: p.id, doc: p.invoiceId, date: p.date, amount: p.amount })),
    );
  }

  /**
   * Takes the payments only the audit log holds into the ledger – 'invoice.payment' entries without a payments row (recorded
   * before the ledger existed, or by an older program version running meanwhile) –, of these documents, or of all documents
   * (`page`: after an entry, at most so many), in their order. An entry that cannot be taken over (a document that does not
   * exist, an unreadable amount) is left out. Returns how many entries it read and took over, and the last one's id. Run
   * inside a transaction.
   */
  private syncLedger(invoiceIds?: readonly string[], page: { afterId?: number; limit?: number } = {}): { seen: number; taken: number; lastId: number } {
    const entries = this.store.unledgeredPaymentEntries(invoiceIds, page);
    let taken = 0;
    for (const e of entries) {
      const { amount, date, proforma, proformaId, markPaid } = e.details;
      if (!e.entityId || typeof amount !== 'string' || typeof date !== 'string' || !/^-?\d+(\.\d+)?$/.test(amount) || !isIsoDate(date)) continue;
      const source: PaymentSource = typeof proformaId === 'string' ? 'proforma' : markPaid === true ? 'mark_paid' : 'manual';
      try {
        this.store.insertPayment({ invoiceId: e.entityId, date, amount, source, reference: source === 'proforma' && typeof proforma === 'string' ? proforma : null, auditId: e.id, createdAt: e.at });
        taken++;
      } catch (err) {
        if (!isAppError(err)) throw err;
      }
    }
    return { seen: entries.length, taken, lastId: entries.at(-1)?.id ?? page.afterId ?? 0 };
  }

  /**
   * Stores `ledger` (settleLedger) for `chain`: appends the allocation rows that bring every payment's stored allocation to
   * the ledger's (`pending`: the ids the ledger used for payments stored since, by the id they got), and stores each
   * document's paid amount, payment date and status. A status that changed on a document other than `skip` (whose payment
   * entry records it) is logged ('invoice.payment.status'; `cause`: the number of the document whose payment or issue
   * changed it, null for a recalculation). Run inside a transaction.
   */
  private storeLedger(chain: readonly Invoice[], ledger: ChainLedger, pending: ReadonlyMap<number, number>, cause: string | null, actor: Actor | undefined, skip?: string): void {
    const key = (paymentId: number, invoiceId: string): string => `${paymentId}\u0000${invoiceId}`;
    const stored = new Map<string, { paymentId: number; invoiceId: string; amount: DecValue }>();
    for (const a of this.store.listAllocations(chain.map((d) => d.id))) {
      const k = key(a.paymentId, a.invoiceId);
      stored.set(k, { paymentId: a.paymentId, invoiceId: a.invoiceId, amount: (stored.get(k)?.amount ?? dec(0)).plus(a.amount) });
    }
    const rows: Array<{ paymentId: number; invoiceId: string; amount: string }> = [];
    for (const [id, parts] of ledger.allocations) {
      const paymentId = pending.get(id) ?? id;
      for (const [invoiceId, amount] of parts) {
        const k = key(paymentId, invoiceId);
        const diff = dec(amount).minus(stored.get(k)?.amount ?? dec(0));
        stored.delete(k);
        if (!diff.isZero()) rows.push({ paymentId, invoiceId, amount: toDec(diff) });
      }
    }
    // A stored part the ledger no longer gives (the payment now covers other documents) is taken back.
    for (const s of stored.values()) if (!s.amount.isZero()) rows.push({ paymentId: s.paymentId, invoiceId: s.invoiceId, amount: toDec(s.amount.neg()) });
    this.store.insertAllocations(rows);
    for (const d of chain) {
      const s = ledger.documents.get(d.id);
      if (!s) continue;
      const patch: InvoiceMutablePatch = {};
      if (s.paid !== d.paidAmount) patch.paidAmount = s.paid;
      if (s.paidDate !== d.paidDate) patch.paidDate = s.paidDate;
      if (s.status !== d.paymentStatus) patch.paymentStatus = s.status;
      if (Object.keys(patch).length > 0) this.store.patchInvoice(d.id, patch);
      if (d.id === skip || s.status === d.paymentStatus) continue;
      this.audit('invoice.payment.status', 'invoice', d.id, { number: d.number, paymentStatus: s.status, previousPaymentStatus: d.paymentStatus, open: s.open, ...(cause ? { cause } : {}) }, actor);
    }
  }

  /**
   * Settles the chain of `inv` from its payment ledger (e.g. after a modification of it was issued: it may take over an
   * overpayment) and stores the result (storeLedger). Run inside a transaction.
   */
  private settleChainOf(inv: Invoice, cause: string | null, actor: Actor | undefined): void {
    const chain = this.ledgerChain(inv);
    const ids = chain.map((d) => d.id);
    this.syncLedger(ids);
    this.storeLedger(chain, this.ledgerOf(chain, this.store.listPayments(ids)), new Map(), cause, actor);
  }

  /** The latest payment date of a document's ledger, or null. */
  private lastPaymentDate(invoiceId: string): IsoDate | null {
    let last: IsoDate | null = null;
    for (const p of this.store.listPayments([invoiceId])) if (last === null || p.date > last) last = p.date;
    return last;
  }

  /**
   * On a storno: what is still to refund to the buyer of what the documents of its cancelled invoice received (< 0), "0"
   * once refunded, null when they received nothing (from the stored paid amounts).
   */
  private stornoOpen(storno: Invoice): string | null {
    const received = sumDec(this.ledgerChain(storno).filter((d) => d.documentType !== 'storno').map((d) => d.paidAmount));
    const refunded = dec(storno.paidAmount);
    if (received.isZero() && refunded.isZero()) return null;
    const left = received.plus(refunded);
    return left.gt(0) ? toDec(left.neg()) : '0';
  }

  /**
   * The amount recordPayment records on the storno `storno` (`given`; null: the whole refund still due): a refund (< 0) of
   * at most what its cancelled invoice still holds, or a reversal (> 0) of at most what was refunded on it. Refused when the
   * cancelled invoice received nothing: then nothing can be recorded on the storno.
   */
  private stornoPayment(storno: Invoice, ledger: ChainLedger, given: DecValue | null): DecValue {
    const received = dec(ledger.received);
    const refunded = dec(ledger.recorded.get(storno.id) ?? '0');
    const left = received.plus(refunded);
    const original = storno.reference?.originalInvoiceNumber ?? '';
    if (received.isZero() && refunded.isZero()) {
      throw new AppError('INVALID_INPUT', 'Sztornó számlára nem rögzíthető fizetés.', {
        hint: `A sztornó számlán csak a sztornózott ${original} számlára (és módosító számláira) befizetett összeg visszafizetése rögzíthető, negatív összeggel – azokra nem érkezett befizetés.`,
      });
    }
    const amount = given ?? (left.gt(0) ? left.neg() : dec(0));
    if (amount.isZero()) {
      if (given) throw new AppError('INVALID_INPUT', 'A befizetés összege nem lehet 0.');
      throw new AppError('INVALID_INPUT', `A sztornó számlán nincs visszafizetendő összeg: a sztornózott ${original} számlára befizetett összeget már visszafizették.`, {
        hint: 'Tévesen rögzített visszafizetést pozitív összeggel lehet visszavonni.',
      });
    }
    if (amount.isNegative() && amount.neg().gt(left.gt(0) ? left : dec(0))) {
      throw new AppError('INVALID_INPUT', `A visszafizetés nem lehet nagyobb a visszafizetendő összegnél (${formatMoney(left.gt(0) ? toDec(left) : '0', storno.currency)}): ennyi maradt a sztornózott ${original} számlára befizetett összegből.`, {
        hint: 'A sztornó számlán a vevőnek visszafizetett összeg negatív, legfeljebb a sztornózott számlára (és módosító számláira) befizetett, még vissza nem fizetett összeg.',
      });
    }
    if (amount.gt(0) && amount.gt(refunded.neg())) {
      throw new AppError('INVALID_INPUT', `A visszavont összeg nem lehet nagyobb a visszafizetettnél (eddig rögzítve: ${toDec(refunded)} ${storno.currency}).`, {
        hint: 'A sztornó számlán a vevőnek visszafizetett összeg negatív; pozitív összeg csak korábban rögzített visszafizetést von vissza.',
      });
    }
    return amount;
  }

  /**
   * Records `given` (null: the default payment – defaultPayment) on `inv` on `date`: a row of the payment ledger with its
   * 'invoice.payment' audit entry (`details`), then the whole chain is settled from the ledger (storeLedger: allocations,
   * paid amounts, payment dates, statuses). `carried`: the payments of a díjbekérő carried over at issue – a row each, with
   * its own date (the entry holds their total). Run inside a transaction.
   */
  private applyPayment(
    inv: Invoice,
    given: DecValue | null,
    date: IsoDate,
    actor: Actor | undefined,
    details: Record<string, unknown> = {},
    carried?: { reference: string; rows: ReadonlyArray<{ date: IsoDate; amount: string }> },
  ): void {
    const chain = this.ledgerChain(inv);
    const ids = chain.map((d) => d.id);
    this.syncLedger(ids);
    const payments = this.store.listPayments(ids);
    const ledger = this.ledgerOf(chain, payments);
    const doc = chain.find((d) => d.id === inv.id) ?? inv;
    const payable = dec(doc.totals.payableAmount);
    const recorded = dec(ledger.recorded.get(doc.id) ?? '0');
    const fullyPaid = (): AppError => {
      const carriedOn = this.carriedProformaPayment(doc);
      return new AppError('INVALID_INPUT', payable.isNegative() ? 'A jóváíró bizonylat már rendezett: nincs visszafizetendő összeg.' : 'A számla már teljesen ki van fizetve.', {
        hint: [
          carriedOn ? `A(z) ${carriedOn.proforma} díjbekérőre rögzített befizetés a kiállításkor átkerült ${carriedOn.on === doc.number ? 'erre a számlára' : `a(z) ${carriedOn.on} számlára`} – ne rögzítsd újra.` : '',
          chain.filter((d) => d.documentType !== 'storno').length > 1 ? 'A hátralék a számla és kiállított módosító számlái együtt: a jóváírást a program beszámítja, a túlfizetést átvezeti.' : '',
          'Tévesen rögzített befizetést ellentétes előjelű összeggel lehet visszavonni.',
        ].filter(Boolean).join(' '),
      });
    };
    let amount: DecValue;
    if (doc.documentType === 'storno') {
      amount = this.stornoPayment(doc, ledger, given);
    } else if (payable.isZero()) {
      if (given && !given.isZero()) throw new AppError('INVALID_INPUT', 'A bizonylat fizetendő összege 0: befizetés nem rögzíthető rá, csak rendezettnek jelölhető (összeg nélkül).');
      if (ledger.documents.get(doc.id)?.status === 'paid') throw fullyPaid();
      amount = dec(0);
    } else {
      // sign: the direction that settles the document (a refund on a crediting document is negative).
      const sign = payable.isNegative() ? -1 : 1;
      amount = given ?? this.ledgerDefault(doc, ledger);
      if (!given && !amount.times(sign).gt(0)) throw fullyPaid();
      if (amount.isZero()) throw new AppError('INVALID_INPUT', 'A befizetés összege nem lehet 0.');
      const paid = recorded.plus(amount);
      if (amount.times(sign).lt(0) && paid.times(sign).lt(0)) {
        throw new AppError('INVALID_INPUT', `A visszavont összeg nem lehet nagyobb a befizetettnél (eddig rögzítve: ${toDec(recorded)} ${doc.currency}).`, {
          hint: sign > 0
            ? 'Befizetéshez pozitív összeget adj meg; negatív összeg csak korábban rögzített befizetést von vissza.'
            : 'Jóváíró bizonylatnál a vevőnek visszafizetett összeg negatív; pozitív összeg csak korábban rögzített visszafizetést von vissza.',
        });
      }
    }
    const source: PaymentSource = carried ? 'proforma' : details['markPaid'] === true ? 'mark_paid' : 'manual';
    const rows = carried && carried.rows.length > 0 ? carried.rows : [{ date, amount: toDec(amount) }];
    const fresh: Payment[] = rows.map((r, i) => ({ id: PENDING_PAYMENT_ID + i, invoiceId: doc.id, date: r.date, amount: r.amount, source, reference: carried?.reference ?? null, auditId: 0, createdAt: '' }));
    const settled = this.ledgerOf(chain, [...payments, ...fresh]);
    const paymentStatus = settled.documents.get(doc.id)?.status ?? 'unpaid';
    const entry = this.store.audit({ actor: actor ?? this.actor, action: 'invoice.payment', entityType: 'invoice', entityId: doc.id, details: { number: doc.number, amount: toDec(amount), date, paymentStatus, ...details } });
    const stored = new Map<number, number>();
    for (const p of fresh) stored.set(p.id, this.store.insertPayment({ invoiceId: p.invoiceId, date: p.date, amount: p.amount, source: p.source, reference: p.reference, auditId: entry.id }).id);
    this.storeLedger(chain, settled, stored, doc.number, actor, doc.id);
  }

  /**
   * The default payment (defaultPayment) from the ledger: on a document something is payable on, what its chain still owes
   * in total when it owes anything, otherwise what is open on the document itself (on a crediting document the refund).
   */
  private ledgerDefault(doc: Invoice, ledger: ChainLedger): DecValue {
    const own = dec(ledger.documents.get(doc.id)?.open ?? '0');
    if (!dec(doc.totals.payableAmount).gt(0)) return own;
    let total = dec(0);
    for (const s of ledger.documents.values()) total = total.plus(s.open);
    return total.gt(0) ? total : own;
  }

  /**
   * The díjbekérő a document was converted from, when a payment is recorded on it: `carry` tells whether
   * issuing the document brings that payment over, `skip` why not – not a second time (`invoicedBy`:
   * another issued document already made from the same díjbekérő), not from a withdrawn díjbekérő, not in
   * another currency, not to another buyer, not to a document nothing is payable on (the payable
   * applyPayment's 0 Ft guard reads), and not to a document deducting an advance: the díjbekérő payment is
   * probably that advance, which belongs on the előlegszámla – carried, the same money would count twice.
   */
  private proformaPayment(inv: Invoice): { proforma: Invoice; carry: boolean; skip: ProformaSkip | null; invoicedBy: Invoice | null } | null {
    if (!inv.proformaId || inv.documentType === 'proforma' || inv.reference) return null;
    const stored = this.store.getInvoice(inv.proformaId);
    if (!stored || stored.documentType !== 'proforma' || stored.status === 'draft' || dec(stored.paidAmount).isZero()) return null;
    // When it was paid: the day it became fully paid, else (paid in part) its latest payment date.
    const proforma = stored.paidDate ? stored : { ...stored, paidDate: this.lastPaymentDate(stored.id) };
    const invoicedBy = this.store.findConversionsOf(proforma.id).find((d) => d.id !== inv.id) ?? null;
    const skip: ProformaSkip | null = invoicedBy
      ? 'invoiced'
      : proforma.status === 'cancelled'
        ? 'cancelled'
        : proforma.currency !== inv.currency
          ? 'currency'
          : !sameBuyer(proforma, inv)
            ? 'buyer'
            : !dec(inv.totals.payableAmount).gt(0)
              ? 'payable'
              : advanceDeductions(inv)
                ? 'advance'
                : null;
    return { proforma, carry: skip === null, skip, invoicedBy };
  }

  /**
   * The payment of its díjbekérő that issuing the invoice of `inv`'s chain (the chain's original: a converted invoice is
   * never a modification) carried over – from the payment ledger: its total, its latest date, the díjbekérő and the
   * invoice (`on`, its number) –, if any. So it is found from every document of the chain.
   */
  private carriedProformaPayment(inv: Invoice): { proforma: string; amount: string; date: IsoDate; on: string } | null {
    if (inv.documentType === 'proforma') return null;
    const root = inv.reference ? this.store.getInvoice(inv.reference.originalInvoiceId) : inv;
    if (!root?.proformaId) return null;
    const rows = this.store.listPayments([root.id]).filter((p) => p.source === 'proforma');
    if (rows.length === 0) return null;
    let date = rows[0]?.date ?? '';
    for (const p of rows) if (p.date > date) date = p.date;
    return { proforma: rows[0]?.reference ?? root.proformaId, amount: toDec(sumDec(rows.map((p) => p.amount))), date, on: root.number ?? root.id };
  }

  /**
   * Issue: the payment recorded on the díjbekérő `issued` was converted from becomes its payment (paid
   * amount, date and status – mutable data, the content and its hash stay as issued). Returns the note.
   * Never blocks issuing: a payment that cannot be carried over (proformaPayment `skip`, or refused by
   * applyPayment – undone in its savepoint) is named in the note instead.
   */
  private carryProformaPayment(issued: Invoice, actor: Actor | undefined): string | null {
    const p = this.proformaPayment(issued);
    if (!p) return null;
    const { proforma } = p;
    const paid = formatMoney(proforma.paidAmount, proforma.currency);
    const notCarried = `A(z) ${proforma.number} díjbekérőre rögzített befizetés (${paid}) nem került át`;
    if (p.invoicedBy) {
      return `A(z) ${proforma.number} díjbekérőből már kiállítottak bizonylatot (${p.invoicedBy.number}); a díjbekérő befizetése (${paid}) ezért nem került át erre a számlára.`;
    }
    switch (p.skip) {
      case 'cancelled':
        return `${notCarried}: a díjbekérő vissza van vonva. Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.`;
      case 'buyer':
        return `${notCarried}: a díjbekérő vevője nem azonos a számla vevőjével. Ha ennek a számlának a vevője fizetett, rögzítsd a befizetést.`;
      case 'payable':
        return `${notCarried}: a számla fizetendő összege ${formatMoney(issued.totals.payableAmount, issued.currency)}. A befizetést annál a bizonylatnál rögzítsd, amelyre a vevő fizetett (pl. az előlegszámlánál).`;
      case 'currency':
        return `${notCarried}: a díjbekérő pénzneme (${proforma.currency}) eltér a számláétól (${issued.currency}). A befizetést a számla pénznemében rögzítsd.`;
      case 'advance': {
        const numbers = advanceDeductions(issued)?.numbers ?? [];
        return (
          `${notCarried}: ${numbers.length ? `a számla levonja a(z) ${numbers.join(', ')} előlegszámlát` : 'a számla előleget von le'}. ` +
          'A díjbekérő befizetése valószínűleg ez az előleg, így az előlegszámlához tartozik – ha ott még nincs rögzítve, ott rögzítsd. ' +
          'Ha a vevő erre a számlára is fizetett, azt ezen a számlán rögzítsd.'
        );
      }
    }
    const date = proforma.paidDate ?? issued.issueDate;
    try {
      // Each payment of the díjbekérő becomes a payment of the invoice, with its own date.
      const rows = (): Array<{ date: IsoDate; amount: string }> => {
        this.syncLedger([proforma.id]);
        return this.store.listPayments([proforma.id]).map((p) => ({ date: p.date, amount: p.amount }));
      };
      this.store.tx(() => this.applyPayment(issued, dec(proforma.paidAmount), date, actor, { proforma: proforma.number, proformaId: proforma.id }, { reference: proforma.number as string, rows: rows() }));
    } catch (e) {
      // A refused payment (a business rule, not a database failure) is undone by the savepoint above.
      if (!isAppError(e) || (e.code !== 'INVALID_INPUT' && e.code !== 'INVALID_NUMBER')) throw e;
      return `${notCarried}: ${e.message} Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.`;
    }
    const status = this.store.getInvoice(issued.id)?.paymentStatus ?? 'unpaid';
    return `A(z) ${proforma.number} díjbekérőre rögzített befizetés (${paid}, ${formatDate(date)}) átkerült erre a számlára – fizetési állapota: ${PAYMENT_STATUS_TEXT[status]}. Ne rögzítsd újra.`;
  }

  /** Issue with markPaid: records what is still open on the new document as paid on its issue date. Returns the note. */
  private markPaidAtIssue(issued: Invoice, actor: Actor | undefined): string {
    const inv = this.getInvoice(issued.id);
    const open = dec(this.openIn(inv, this.paymentChain(inv)));
    const zero = dec(inv.totals.payableAmount).isZero();
    if (zero ? inv.paymentStatus === 'paid' : open.isZero()) return 'A bizonylaton nincs nyitott összeg, ezért befizetés nem lett rögzítve.';
    // What is open on this document – not the default payment, which covers the whole invoice chain.
    this.applyPayment(inv, zero ? null : open, inv.issueDate, actor, { markPaid: true });
    if (zero) return `A 0 összegű bizonylat a kiállítás napjával (${formatDate(inv.issueDate)}) rendezettnek jelölve.`;
    return `${open.isNegative() ? 'Visszafizetés' : 'Befizetés'} rögzítve a kiállítás napjával (${formatDate(inv.issueDate)}): ${formatMoney(toDec(open), inv.currency)} – fizetési állapota: ${PAYMENT_STATUS_TEXT[this.getInvoice(inv.id).paymentStatus]}.`;
  }

  /**
   * The PDF of a document, written into pdf/ of the data folder. An issued document's PDF is its original: rendered once,
   * after issuing, and kept in the database with its fingerprints (originalDocument) – every later request returns
   * exactly those bytes, rewrites pdf/<name>.pdf from them when the file is missing or differs, and never renders it
   * again. A document issued before originals were kept has none: it is rendered with the running program into
   * pdf/<name>_UJRAELOALLITOTT.pdf (kind 'regenerated', audited when the file is written), never stored as its original,
   * and an older pdf/<name>.pdf stays untouched. A draft (watermark, pdf/drafts/) and a "MÁSOLAT" render (copy: a file of
   * its own, …_MASOLAT.pdf) are rendered on demand. Optionally copies the file into an existing local folder – never
   * over another file – and/or returns it as base64. A kept original that fails its fingerprints is refused
   * (DOCUMENT_INTEGRITY_FAILED) and pdf/<name>.pdf is left as it is; when the request keeps the original and finds another
   * file at pdf/<name>.pdf, that file is kept under a name of its own first (previousFile).
   */
  async pdf(idOrNumber: string, opts: { copyToDir?: string; base64?: boolean; copy?: boolean } = {}, actor?: Actor): Promise<PdfResult> {
    const stored = this.getInvoice(idOrNumber);
    let targetDir: string | null = null;
    if (opts.copyToDir) {
      if (!this.config.allowFileCopy) {
        throw new AppError('FILE_COPY_DISABLED', 'Fájlmásolás ebben a módban nem engedélyezett.', {
          hint:
            'A másolást az OPENSZAMLA_ALLOW_FILE_COPY környezeti változó engedélyezi (az openszamla serve webes/HTTP szerverén alapból ki van kapcsolva). ' +
            'Másolás nélkül: MCP-n az erőforrás-hivatkozáson (resource link) át, a webes felületen a „PDF letöltése” gombbal; az openszamla pdf parancs kiírja a PDF helyét.',
        });
      }
      targetDir = localCopyDir(opts.copyToDir);
    }
    let kind: PdfKind;
    let buf: Buffer;
    let path: string;
    let sha256: string | null = null;
    let note: string;
    let previousFile: string | null = null;
    if (stored.status !== 'draft' && !opts.copy) {
      mkdirSync(this.config.pdfDir, { recursive: true });
      const own = join(this.config.pdfDir, `${this.fileStems([stored]).get(stored.id) as string}.pdf`);
      const original = await this.originalDocument(stored, actor);
      if (original) {
        kind = 'original';
        buf = original.doc.content;
        sha256 = original.doc.sha256;
        note = PDF_NOTES.original;
        path = own;
        // Kept just now: a pdf/<name>.pdf already there is not this document's – it is kept, never overwritten.
        const aside = original.kept ? this.keepPreviousPdf(stored, own, buf, actor) : null;
        if (aside) {
          previousFile = aside.path;
          note = `${note} ${aside.note}`;
        }
        writeUnlessSame(path, buf);
      } else {
        kind = 'regenerated';
        const software = this.pdfSoftware();
        buf = await renderInvoicePdf(stored, { softwareName: software });
        path = own.replace(/\.pdf$/, `${REGENERATED_PDF_SUFFIX}.pdf`);
        note = `${PDF_NOTES.regenerated}${existsSync(own) ? ` A korábban kiírt ${basename(own)} fájlt a program nem módosítja.` : ''}`;
        if (writeUnlessSame(path, buf)) {
          const f = fileFingerprints(buf);
          this.audit('invoice.pdf_regenerated', 'invoice', stored.id, { number: stored.number, file: basename(path), sha256: f.sha256, size: f.size, software }, actor);
        }
      }
    } else {
      // A draft is rendered like its preview: with the dates and seller data issuing it today gives.
      const inv = stored.status === 'draft' ? this.draftView(stored).invoice : stored;
      kind = inv.status === 'draft' ? 'draft' : 'copy';
      note = PDF_NOTES[kind];
      buf = await renderInvoicePdf(inv, { draft: inv.status === 'draft', copy: !!opts.copy, softwareName: this.pdfSoftware() });
      const dir = inv.status === 'draft' ? join(this.config.pdfDir, 'drafts') : this.config.pdfDir;
      mkdirSync(dir, { recursive: true });
      const stem = inv.status === 'draft' ? `TERVEZET_${inv.id}` : (this.fileStems([inv]).get(inv.id) as string);
      path = join(dir, `${stem}${opts.copy ? '_MASOLAT' : ''}.pdf`);
      writeFileSync(path, buf);
    }
    let copiedTo: string | null = null;
    if (targetDir !== null) {
      copiedTo = join(targetDir, basename(path));
      copyWithoutOverwrite(path, copiedTo, buf);
    }
    return { kind, sha256, note, path, bytes: buf.length, copiedTo, base64: opts.base64 ? buf.toString('base64') : null, previousFile };
  }

  /** The program name and version a PDF rendered now carries in its footer and metadata (kept with an original). */
  private pdfSoftware(): string {
    return `${this.config.software.softwareName} ${VERSION}`;
  }

  /**
   * The kept original PDF of an issued document (invoice_documents), checked against its fingerprints (intactOriginal);
   * `kept` is true when this call kept it. A document without one gets it here, from its first successful render –
   * normally right after issue() – unless it was issued before originals were kept: null, it never gets one. The render
   * runs outside any transaction; the original is stored in a transaction of its own, together with its
   * 'invoice.document' audit entry (the fingerprints, chain-protected evidence for verifyIntegrity). When another request
   * kept one meanwhile, that one stays. One the log says was kept but the database lacks (removed outside the program)
   * is never replaced: a new render would not be what was handed over (DOCUMENT_MISSING).
   */
  private async originalDocument(inv: Invoice, actor?: Actor): Promise<{ doc: KeptDocument; kept: boolean } | null> {
    const stored = this.store.getDocument(inv.id);
    if (stored) return { doc: this.intactOriginal(inv, stored, actor), kept: false };
    if (this.store.isLegacyDocument(inv.id)) return null;
    if (this.store.hasAudit(inv.id, 'invoice.document')) throw documentMissing(inv);
    const software = this.pdfSoftware();
    const content = await renderInvoicePdf(inv, { softwareName: software });
    const r = this.store.tx(() => {
      const first = this.store.getDocument(inv.id);
      if (first) return { doc: first, kept: false };
      const doc = this.store.insertDocument({ invoiceId: inv.id, content, software });
      this.audit('invoice.document', 'invoice', inv.id, { number: inv.number, kind: doc.kind, sha256: doc.sha256, sha3_512: doc.sha3_512, size: doc.size, software: doc.software }, actor);
      return { doc, kept: true };
    });
    return r.kept ? r : { doc: this.intactOriginal(inv, r.doc, actor), kept: false };
  }

  /**
   * `doc` when its bytes still match the SHA-256, SHA3-512 and size stored with them and those of its 'invoice.document'
   * audit entry; otherwise DOCUMENT_INTEGRITY_FAILED – a changed original is never served as the original, nor written
   * over pdf/<name>.pdf. The first refusal for a document is audited ('invoice.document_altered').
   */
  private intactOriginal(inv: Invoice, doc: KeptDocument, actor?: Actor): KeptDocument {
    const f = fileFingerprints(doc.content);
    const matches = (d: Record<string, unknown>): boolean => d.sha256 === f.sha256 && d.sha3_512 === f.sha3_512 && d.size === f.size;
    const logged = this.store.auditEntries(inv.id, 'invoice.document');
    if (matches({ sha256: doc.sha256, sha3_512: doc.sha3_512, size: doc.size }) && logged.length > 0 && logged.every((e) => matches(e.details))) return doc;
    if (!this.store.hasAudit(inv.id, 'invoice.document_altered')) {
      try {
        this.audit('invoice.document_altered', 'invoice', inv.id, { number: inv.number, storedSha256: doc.sha256, sha256: f.sha256, storedSize: doc.size, size: f.size, logged: logged.length }, actor);
      } catch {
        // the refusal stands even when it cannot be logged (e.g. a read-only database)
      }
    }
    throw documentAltered(inv);
  }

  /**
   * The first keep of `inv`'s original found pdf/<name>.pdf (`own`) with other bytes: a file the program did not write for
   * this document – e.g. the PDF of the invoice that had this number before an older backup was restored. It is copied to
   * pdf/<name>_KORABBI_<ééééhhnn-óóppmm>.pdf (never over another file) and audited ('invoice.pdf_file_kept') before
   * anything can overwrite it; null when there is no such file.
   */
  private keepPreviousPdf(inv: Invoice, own: string, content: Buffer, actor?: Actor): { path: string; note: string } | null {
    let existing: Buffer;
    try {
      existing = readFileSync(own);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e; // unreadable: nothing is written over it
    }
    if (existing.equals(content)) return null;
    const base = own.replace(/\.pdf$/, `_KORABBI_${huFileStamp(this.now())}`);
    let target = `${base}.pdf`;
    for (let n = 2; ; n++) {
      try {
        copyFileSync(own, target, fsConstants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw e;
        target = `${base}_${n}.pdf`;
      }
    }
    const f = fileFingerprints(existing);
    this.audit('invoice.pdf_file_kept', 'invoice', inv.id, { number: inv.number, file: basename(target), sha256: f.sha256, size: f.size }, actor);
    return { path: target, note: previousPdfNote(own, target) };
  }

  /**
   * What pdf() gives for a document now, without rendering or writing anything (the web UI names it next to its
   * download): an issued document's kept original with its SHA-256; for one issued before originals were kept, the
   * regenerated PDF; for a draft, its TERVEZET render. An issued document whose original is not kept yet (its PDF could
   * not be made at issue) gets it at the first request: kind 'original' with sha256 null. DOCUMENT_MISSING and
   * DOCUMENT_INTEGRITY_FAILED as pdf().
   */
  pdfInfo(idOrNumber: string): Pick<PdfResult, 'kind' | 'sha256' | 'note'> {
    const inv = this.getInvoice(idOrNumber);
    if (inv.status === 'draft') return { kind: 'draft', sha256: null, note: PDF_NOTES.draft };
    const kept = this.store.getDocument(inv.id);
    if (kept) return { kind: 'original', sha256: this.intactOriginal(inv, kept).sha256, note: PDF_NOTES.original };
    if (this.store.isLegacyDocument(inv.id)) return { kind: 'regenerated', sha256: null, note: PDF_NOTES.regenerated };
    if (this.store.hasAudit(inv.id, 'invoice.document')) throw documentMissing(inv);
    return { kind: 'original', sha256: null, note: PDF_NOT_KEPT_YET };
  }

  /**
   * The file pdf() serves for an issued document, when it is there as pdf() would serve it: pdf/<name>.pdf holding the
   * kept original's bytes, or pdf/<name>_UJRAELOALLITOTT.pdf for one issued before originals were kept. Null otherwise –
   * not written yet, missing or different (the next pdf() writes it), or the original not kept yet. Renders nothing.
   */
  pdfFile(idOrNumber: string): string | null {
    const inv = this.getInvoice(idOrNumber);
    if (inv.status === 'draft') return null;
    const own = join(this.config.pdfDir, `${this.fileStems([inv]).get(inv.id) as string}.pdf`);
    if (this.store.isLegacyDocument(inv.id)) {
      const regenerated = own.replace(/\.pdf$/, `${REGENERATED_PDF_SUFFIX}.pdf`);
      return existsSync(regenerated) ? regenerated : null;
    }
    const kept = this.store.getDocument(inv.id);
    if (!kept) return null;
    try {
      return readFileSync(own).equals(kept.content) ? own : null;
    } catch {
      return null; // missing (or unreadable)
    }
  }

  /**
   * File names (without extension) of issued documents, by id: the number made file-system safe.
   * Distinct numbers can still meet in one name – "AB/2026/1" and "AB_2026_1", or "ab-1" and "AB-1" on a
   * case-insensitive file system – so only the document issued first keeps it, every later one gets its
   * id appended. A name never changes once given: the pdfPath returned on issuing stays the invoice's own.
   */
  private fileStems(invoices: ReadonlyArray<Pick<Invoice, 'id' | 'number'>>): Map<string, string> {
    if (invoices.length === 0) return new Map();
    const key = (n: string): string => safeFileName(n).toLowerCase();
    // For one document only the numbers that can give its name ("_" may stand for a run of other characters).
    const only = invoices.length === 1 ? invoices[0] : undefined;
    const owners = new Map<string, string>();
    for (const r of this.store.findIssuedNumbers(only ? safeFileName(only.number as string).replace(/_/g, '%') : '%')) {
      if (!owners.has(key(r.number))) owners.set(key(r.number), r.id);
    }
    const out = new Map<string, string>();
    for (const inv of invoices) {
      const stem = safeFileName(inv.number as string);
      const owner = owners.get(stem.toLowerCase());
      out.set(inv.id, owner === undefined || owner === inv.id ? stem : `${stem}_${inv.id}`);
    }
    return out;
  }

  // ===========================================================================================
  // NAV
  // ===========================================================================================

  /** One navSync at a time in this process: overlapping runs would send the same invoice twice (see navSync). */
  private navQueue: Promise<void> = Promise.resolve();
  /** Runs queued or running in this process: issuing does not wait for them (see issue). */
  private navRuns = 0;

  /**
   * The NAV client of one run (NavRunClient: it stops at the first outage). `issue`: the submission when issuing – a
   * short timeout per request, and NAV_ISSUE_BUDGET_MS for everything; `until`: the end of the time limit of a call
   * (NavRunOptions.budgetMs, `budgetMs` long).
   */
  private navClient(opts: { issue?: boolean; until?: number; budgetMs?: number } = {}): NavRunClient {
    const cfg = this.config;
    const nav = cfg.nav;
    if (!nav) {
      throw new AppError('NAV_NOT_CONFIGURED', 'A NAV Online Számla kapcsolat nincs beállítva.', {
        hint: `Hozz létre technikai felhasználót (az Online Számla oldalán, a NAV Felhasználókezelőben), majd futtasd: ${navSetupCommand(cfg.dataDir)}, vagy add meg az OPENSZAMLA_NAV_* környezeti változókat.`,
      });
    }
    if (cfg.navProblem) {
      throw new AppError('NAV_INVALID_CONFIG', `A NAV-kapcsolat beállítása hibás: ${cfg.navProblem}`, {
        hint: `Javítsd a beállítást: ${navSetupCommand(cfg.dataDir)} (vagy az OPENSZAMLA_NAV_* / OPENSZAMLA_SOFTWARE_ID környezeti változókat).`,
      });
    }
    const seller = this.requireSeller();
    const tax = parseHuTaxNumber(seller.taxNumber);
    if (!tax.ok) throw new AppError('INVALID_TAX_NUMBER', 'Az eladó adószáma érvénytelen.');
    const limit: NavTimeLimit | null = opts.issue
      ? { until: Date.now() + NAV_ISSUE_BUDGET_MS, requestMs: NAV_ISSUE_REQUEST_TIMEOUT_MS, budgetMs: NAV_ISSUE_BUDGET_MS, issue: true }
      : opts.until !== undefined
        ? { until: opts.until, requestMs: navBudgetRequestMs(opts.budgetMs ?? 0), budgetMs: opts.budgetMs ?? 0, issue: false }
        : null;
    return new NavRunClient({
      environment: nav.environment,
      credentials: { ...nav.credentials, taxNumber: tax.value.taxpayerId },
      software: cfg.software,
      ...(nav.baseUrl ? { baseUrl: nav.baseUrl } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      timeoutMs: opts.issue ? NAV_ISSUE_REQUEST_TIMEOUT_MS : NAV_TIMEOUT_MS,
      ...(limit ? { limit } : {}),
      now: this.now,
    });
  }

  /**
   * Reports pending invoices to NAV and refreshes the status of those being processed. Originals are always
   * sent before their modifications/stornos. Runs one at a time in this process, and every submission is
   * claimed in the database first (navSubmitOne), so overlapping calls – a double click, parallel tool calls,
   * another process on the same database – never send an invoice twice. An attempt whose outcome is unknown
   * is reconciled with NAV before anything is sent again (navSettleOpen); an invoice rejected only as a
   * duplicate of an accepted report is reconciled too (navReconcileNotUnique). A run stops contacting NAV at the
   * first outage (NavRunClient) and honours a pause NAV asked for (Retry-After, navPauseActive). Only invoices of the
   * configured NAV environment are handled: one whose NAV state belongs to the other NAV system (e.g. reported only
   * to the test one) is reported here only when asked for and confirmed (NavRunOptions.confirmedForeign).
   * With a time limit (NavRunOptions.budgetMs, counted from this call) a run that would have to wait behind another
   * one longer than that does not wait: it contacts NAV no more, and says so for every invoice.
   */
  navSync(opts: NavRunOptions = {}, actor?: Actor): Promise<NavInvoiceResult[]> {
    const until = opts.budgetMs === undefined ? undefined : Date.now() + Math.max(0, opts.budgetMs);
    this.navRuns++;
    const before = this.navQueue;
    // Out of time before its turn, a run only reads and notes – it may then run next to the one still going.
    const turn = until === undefined ? before : settledBy(before, until);
    const run = turn.then(() => this.navSyncRun(opts, actor, until));
    const settled = Promise.all([before, run.then(() => undefined, () => undefined)]).then(() => undefined);
    this.navQueue = settled;
    void settled.then(() => {
      this.navRuns--;
    });
    return run;
  }

  private async navSyncRun(opts: NavRunOptions, actor?: Actor, until?: number): Promise<NavInvoiceResult[]> {
    const client = this.navClient({ issue: opts.issue === true, ...(until !== undefined ? { until, budgetMs: opts.budgetMs ?? 0 } : {}) });
    const environment = client.environment;
    // One given invoice is sent again after a rejection, too.
    const allowed: NavStatus[] = opts.invoiceId || opts.resubmitFailed ? ['pending', 'not_configured', 'aborted', 'error'] : ['pending', 'not_configured'];
    const sendable = (f: Invoice): boolean => !navForeign(f, environment) && allowed.includes(f.navStatus);
    let targets: Invoice[];
    if (opts.invoiceId) {
      targets = [this.getInvoice(opts.invoiceId)];
    } else {
      // Rejected invoices come along only to reconcile duplicates (INVOICE_NUMBER_NOT_UNIQUE), unless resubmitFailed.
      // Selected in SQL, so that the 200 of a run are invoices there is something to do with – older rejected
      // ones a plain run leaves alone cannot crowd out a pending invoice. Only those of this NAV environment (or of
      // none yet): the other NAV system's invoices are never sent here in bulk.
      targets = this.store.findInvoices({ status: ['issued', 'cancelled'], navSelect: navHere(opts.resubmitFailed ? NAV_SEL_QUEUE_RESUBMIT : NAV_SEL_QUEUE, environment), sort: 'issued_asc', limit: 200, offset: 0 }).items;
    }
    const notes = new Map<string, NavRunNote>();
    const note = (id: string, text: string, wait = false, notProcessed?: NavRunNote['notProcessed']): void => {
      notes.set(id, { text, navStatus: this.getInvoice(id).navStatus, wait, ...(notProcessed ? { notProcessed } : {}) });
    };
    // A pause NAV asked for (Retry-After – got by this or another process): nothing is sent or asked before it ends.
    let pause = this.navPauseActive(environment);
    if (pause) {
      for (const t of targets) note(t.id, navPauseNote(pause), false, 'pause');
      return this.navResults(targets, notes, environment, pause);
    }
    /** Notes an invoice a stop of the run (NavRunClient.stopped) leaves as it is; a pause NAV asks for is kept. */
    const stopped = (id: string, stop: NavStop): void => {
      if (stop.kind === 'outage' && navAsksToWait(stop.error)) {
        pause ??= this.navRecordPause(stop.error, environment);
        note(id, navPauseNote(pause), false, 'pause');
        return;
      }
      note(id, navStopNote(stop), false, stop.kind);
    };
    /** Corrections waiting for their original; the originals are polled with the targets. */
    const waiting: string[] = [];
    const polled = new Set(targets.map((t) => t.id));

    for (const target of targets) {
      // With a time limit: nothing more is started once not even one request fits in what is left of it.
      const stop = client.stopped ?? (client.fits(1) ? null : client.stopped);
      if (stop) {
        stopped(target.id, stop);
        continue;
      }
      // Always fresh: an earlier step of this run (or another process) may have changed it.
      const inv = this.getInvoice(target.id);
      if (inv.status === 'draft' || inv.documentType === 'proforma') {
        note(inv.id, 'Nem jelentendő (piszkozat vagy díjbekérő).');
        continue;
      }
      if (opts.onlyAttempted && !this.store.listNavSubmissions(inv.id).some((s) => s.environment === environment)) {
        note(inv.id, 'Még nem volt beküldve: az automatikus szinkron csak a már megkezdett beküldést folytatja – az első beküldést a nav_sync (vagy a webes NAV-szinkron gomb) végzi.');
        continue;
      }
      // Its NAV state belongs to the other NAV system: reported here only when asked for, as a new submission – and
      // only the one the user confirmed (navForeignResend): to production that is a real report.
      if (navForeign(inv, environment)) {
        if (!(opts.invoiceId && opts.resubmitFailed)) {
          note(inv.id, navForeignNote(inv, environment));
          continue;
        }
        const adopted = this.navAdoptAccepted(inv, environment, actor);
        if (adopted) {
          note(inv.id, adopted);
          continue;
        }
        if (opts.confirmedForeign !== navForeignFingerprint(inv, environment)) {
          note(inv.id, navForeignUnconfirmedNote(inv, environment));
          continue;
        }
      }
      // Never send again while an earlier attempt may have reached NAV.
      const unsettled = await this.navSettleOpen(client, inv, actor);
      if (unsettled) {
        note(inv.id, unsettled);
        continue;
      }
      let cur = this.getInvoice(inv.id);
      const foreign = navForeign(cur, environment);
      if (!foreign) {
        // A recorded number collision: NAV holds another invoice under the number. Asked about again only when this
        // invoice is given (nav_sync { invoice, resubmitFailed }) – not by every run (or resubmission of all).
        if (navCollisionRecorded(cur) && opts.invoiceId !== cur.id) {
          note(cur.id, navCollisionKeptNote(cur, environment));
          continue;
        }
        if (cur.navStatus === 'aborted' && navReconcilable(cur.navMessages)) {
          const reconciled = await this.navReconcileNotUnique(client, cur, cur.navMessages, actor);
          // NAV has no valid report with its number (any more): only a resubmission asked for sends it again.
          if (!reconciled.resendable || !allowed.includes('aborted')) {
            note(cur.id, reconciled.note);
            continue;
          }
          cur = this.getInvoice(cur.id);
        }
        if (cur.navStatus === 'processing') continue;
        if (!allowed.includes(cur.navStatus)) {
          note(cur.id, navAccepted(cur.navStatus) ? 'Már sikeresen jelentve.' : 'Nincs teendő.');
          continue;
        }
      }
      const blocker = await this.navChainBlocker(client, cur, actor);
      if (blocker) {
        note(cur.id, blocker, true);
        waiting.push(cur.id);
        if (cur.reference) polled.add(cur.reference.originalInvoiceId);
        const before = this.navBlockingDocument(cur, environment);
        if (before) polled.add(before.id);
        continue;
      }
      const late = client.stopped ?? (client.fits(2) ? null : client.stopped);
      if (late) {
        stopped(cur.id, late);
        continue;
      }
      const skipped = await this.navSubmitOne(client, cur, foreign ? (f) => navForeign(f, environment) || sendable(f) : sendable, actor);
      if (typeof skipped === 'string') note(cur.id, skipped);
      else if (skipped) stopped(cur.id, skipped);
    }

    // Poll everything that is processing: the ones submitted above, and the originals corrections wait for. The wait
    // ends with the time limit of the call, too.
    const processing = (): Invoice[] => [...polled].map((id) => this.getInvoice(id)).filter((i) => i.navStatus === 'processing' && !navForeign(i, environment));
    const deadline = Math.min(Date.now() + Math.max(0, Math.min(120, opts.waitSeconds ?? 15)) * 1000, client.until ?? Infinity);
    await this.navPollUntil(client, processing, deadline, actor);
    // A correction whose original NAV accepted meanwhile is sent in this run too – after its original, as NAV requires.
    let resent = false;
    for (const id of waiting) {
      const cur = this.getInvoice(id);
      if (!sendable(cur) || !cur.reference || this.navBlockingDocument(cur, environment)) continue;
      const late = client.stopped ?? (client.fits(2) ? null : client.stopped);
      if (late) break;
      const skipped = await this.navSubmitOne(client, cur, sendable, actor);
      if (typeof skipped === 'string') note(cur.id, skipped);
      else if (skipped) {
        stopped(cur.id, skipped);
        break;
      }
      resent = true;
    }
    if (resent) await this.navPollUntil(client, processing, deadline, actor);
    const stop = client.stopped;
    if (stop?.kind === 'outage' && navAsksToWait(stop.error)) pause ??= this.navRecordPause(stop.error, environment);
    return this.navResults(targets, notes, environment, pause);
  }

  /**
   * The results of a run, each built from the invoice's final state: a note of the run stays while the status it was
   * written for still holds, and why a correction waits is said again from its original's final state.
   */
  private navResults(targets: readonly Invoice[], notes: ReadonlyMap<string, NavRunNote>, environment: NavEnvironment, pause: NavPause | null): NavInvoiceResult[] {
    return targets.map((t) => {
      const inv = this.getInvoice(t.id);
      const kept = notes.get(inv.id);
      let text: string;
      let notProcessed: NavRunNote['notProcessed'];
      if (kept && kept.navStatus === inv.navStatus) {
        text = kept.wait ? this.navWaitAgain(inv, environment) : kept.text;
        notProcessed = kept.wait ? undefined : kept.notProcessed;
      } else if (pause && (inv.navStatus === 'pending' || inv.navStatus === 'processing') && !navForeign(inv, environment)) {
        text = navPauseNote(pause);
        notProcessed = 'pause';
      } else {
        text = navNote(inv, environment);
      }
      return this.navResult(inv, environment, text, notProcessed);
    });
  }

  /** NAV result of `inv` with `note`; its environment is the one its NAV state belongs to. */
  private navResult(inv: Invoice, environment: NavEnvironment, note: string, notProcessed?: NavInvoiceResult['notProcessed']): NavInvoiceResult {
    return {
      invoiceId: inv.id, number: inv.number, navStatus: inv.navStatus, transactionId: inv.navTransactionId, messages: inv.navMessages, environment: inv.navEnvironment ?? environment, note,
      ...(notProcessed ? { notProcessed } : {}),
    };
  }

  /** Why the correction `inv` still waits at the end of a run, from its original's final state. */
  private navWaitAgain(inv: Invoice, environment: NavEnvironment): string {
    const orig = inv.reference ? this.store.getInvoice(inv.reference.originalInvoiceId) : null;
    if (!orig) return navNote(inv, environment);
    if (!navAccepted(orig.navStatus) || navForeign(orig, environment)) return navWaitNote(orig, environment);
    const earlier = this.navBlockingDocument(inv, environment);
    if (earlier) return navEarlierCorrectionNote(earlier);
    return `Amire ez a számla várt (az eredeti számla: ${orig.number ?? orig.id}, és korábbi módosításai), azt a NAV közben befogadta; ez a számla a következő nav_sync-kel kerül beküldésre.`;
  }

  /** Polls the processing invoices until none is left or `deadline` has passed – while the run may contact NAV. */
  private async navPollUntil(client: NavRunClient, processing: () => Invoice[], deadline: number, actor?: Actor): Promise<void> {
    let delay = 1000;
    for (;;) {
      for (const inv of processing()) {
        if (client.stopped || !client.fits(1)) return;
        await this.navPollOne(client, inv, actor);
      }
      if (processing().length === 0 || client.stopped || Date.now() >= deadline) return;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 5000);
    }
  }

  /**
   * An invoice of the other NAV system to be reported here (nav_sync { invoice, resubmitFailed }) that an earlier
   * submission already reported HERE (the environment was switched back and forth): that report becomes its state again,
   * nothing is sent. Returns the note, or null when there is no such report.
   */
  private navAdoptAccepted(inv: Invoice, environment: NavEnvironment, actor?: Actor): string | null {
    const sub = this.store.listNavSubmissions(inv.id).filter((s) => s.environment === environment && (s.status === 'done' || s.status === 'done_with_warnings')).at(-1);
    if (!sub) return null;
    this.store.patchInvoice(inv.id, { navStatus: sub.status as NavStatus, navTransactionId: sub.transactionId, navMessages: sub.messages, navEnvironment: environment });
    this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, via: 'submission', transactionId: sub.transactionId, environment }, actor);
    return `Ebbe a NAV-rendszerbe egy korábbi beküldését a NAV már befogadta (tranzakció: ${sub.transactionId}), ezért nem küldtük újra.`;
  }

  /** The pause NAV asked for (Retry-After) that still holds for `environment` – recorded by this or another process. */
  private navPauseActive(environment: NavEnvironment): NavPause | null {
    const p = this.store.getSetting<NavPause>(NAV_PAUSE_SETTING);
    return p && p.environment === environment && Date.parse(p.until) > this.now().getTime() ? p : null;
  }

  /** Records the pause `e` asks for (navAsksToWait) in the settings: until it ends no run contacts NAV (navPauseActive). */
  private navRecordPause(e: NavError, environment: NavEnvironment): NavPause {
    const ms = Math.min(Math.max(e.retryAfterMs ?? NAV_DEFAULT_RETRY_AFTER_MS, 1000), NAV_MAX_RETRY_AFTER_MS);
    const pause: NavPause = { until: new Date(this.now().getTime() + ms).toISOString(), environment, code: e.navErrorCode };
    const prev = this.navPauseActive(environment);
    if (prev && prev.until >= pause.until) return prev;
    this.store.setSetting(NAV_PAUSE_SETTING, pause);
    return pause;
  }

  /**
   * Why a modification/storno still waits for NAV reporting, without contacting NAV: NAV accepts it only after
   * its original, and the original is not accepted yet – in the configured NAV environment. null when it does not
   * wait (or is no correction).
   */
  navWaitReason(idOrNumber: string): string | null {
    const inv = this.getInvoice(idOrNumber);
    if (!inv.reference || (inv.navStatus !== 'pending' && inv.navStatus !== 'not_configured')) return null;
    const orig = this.store.getInvoice(inv.reference.originalInvoiceId);
    const env = this.navEnvironmentInUse();
    if (!orig || (navAccepted(orig.navStatus) && !(env && navForeign(orig, env)))) return null;
    return navWaitNote(orig, env);
  }

  /** navWaitReason as a structured value (NavWait): which original the correction waits for, and why. */
  /**
   * Whether a correction (storno, modification) of `original` can be reported to NAV now: NAV – the configured
   * system – has accepted the original (it takes a correction only after its original). True when nothing is sent
   * anyway (NAV not configured).
   */
  navOriginalAccepted(original: Invoice): boolean {
    const cfg = this.config;
    if (!cfg.nav || cfg.navProblem) return true;
    return navAccepted(original.navStatus) && !navForeign(original, cfg.nav.environment);
  }

  navWait(idOrNumber: string): NavWait | null {
    const inv = this.getInvoice(idOrNumber);
    if (!inv.reference || (inv.navStatus !== 'pending' && inv.navStatus !== 'not_configured')) return null;
    const orig = this.store.getInvoice(inv.reference.originalInvoiceId);
    return orig ? navWaitOf(orig, this.navEnvironmentInUse()) : null;
  }

  /**
   * Whether a correction (modification / storno) of `originalIdOrNumber` issued now would have to wait for it at NAV, and
   * why – with a usable NAV connection only (null without one, or when the original is accepted by the configured system).
   */
  navCorrectionWait(originalIdOrNumber: string): NavWait | null {
    const env = this.navEnvironmentInUse();
    return env ? navWaitOf(this.getInvoice(originalIdOrNumber), env) : null;
  }

  /** The issued invoices made from the díjbekérő `idOrNumber` (invoice_draft copyFromId, then issued). */
  proformaConversions(idOrNumber: string): Invoice[] {
    const p = this.getInvoice(idOrNumber);
    return p.documentType === 'proforma' ? this.store.findConversionsOf(p.id) : [];
  }

  /**
   * When the NAV state of `inv` belongs to the other NAV system than the configured one – e.g. it was reported only to
   * the TEST system –: what that means here and how to report it here. null otherwise (or without a usable connection).
   */
  navEnvironmentNote(inv: Invoice): string | null {
    const env = this.navEnvironmentInUse();
    return env && navForeign(inv, env) ? navForeignNote(inv, env) : null;
  }

  /**
   * What sending `idOrNumber` to the configured NAV system means when its NAV state belongs to the other one: a new
   * submission – a real report when this one is production. nav_sync never does it; it shows this as a preview, and
   * nav_send_to_configured_environment (openszamla nav-send-to-configured-environment) does it with the user's
   * confirmation (NavRunOptions.confirmedForeign = `fingerprint`, bound to the invoice, its content, its NAV status,
   * the system it belongs to and this one). null when nothing of that kind would happen: the invoice belongs to this
   * system (or to none), a report of it accepted here earlier is taken over, or there is no usable NAV connection.
   */
  navForeignResend(idOrNumber: string): NavForeignResend | null {
    const inv = this.getInvoice(idOrNumber);
    const env = this.navEnvironmentInUse();
    if (!env || inv.status === 'draft' || inv.documentType === 'proforma' || !navForeign(inv, env) || !inv.navEnvironment) return null;
    if (this.store.listNavSubmissions(inv.id).some((s) => s.environment === env && (s.status === 'done' || s.status === 'done_with_warnings'))) return null;
    return {
      invoiceId: inv.id,
      number: inv.number,
      reportedTo: inv.navEnvironment,
      navStatus: inv.navStatus,
      sendTo: env,
      realReport: env === 'production',
      summary: navForeignResendText(inv, env),
      fingerprint: navForeignFingerprint(inv, env),
    };
  }

  /**
   * navForeignResend of the operation that sends the invoice (nav_send_to_configured_environment, openszamla
   * nav-send-to-configured-environment): when there is nothing of that kind to send, the error says why – without a
   * usable NAV connection the error of nav_sync, otherwise NOT_OTHER_NAV_SYSTEM.
   */
  requireNavForeignResend(idOrNumber: string): NavForeignResend {
    const inv = this.getInvoice(idOrNumber);
    this.navClient(); // NAV_NOT_CONFIGURED / NAV_INVALID_CONFIG, as nav_sync
    const resend = this.navForeignResend(inv.id);
    if (resend) return resend;
    const env = this.navEnvironmentInUse() as NavEnvironment;
    const n = inv.number ?? inv.id;
    const here = env === 'production' ? 'az éles' : 'a TESZT';
    const hint = `Részletek: invoice_get ${n}; a beállított NAV-rendszer számláit a nav_sync kezeli.`;
    if (inv.status === 'draft' || inv.documentType === 'proforma') {
      throw new AppError('NOT_OTHER_NAV_SYSTEM', `A(z) ${n} nem jelentendő a NAV-nak (piszkozat vagy díjbekérő): nincs mit beküldeni.`, { hint });
    }
    if (navForeign(inv, env)) {
      throw new AppError('NOT_OTHER_NAV_SYSTEM', `A(z) ${n} számla egy korábbi beküldését ${here} NAV-rendszer már befogadta: nincs mit beküldeni.`, {
        hint: `A befogadott beküldést beküldés nélkül átveszi: nav_sync { invoice: "${n}", resubmitFailed: true }.`,
      });
    }
    const where = inv.navEnvironment === undefined ? 'még egyik NAV-rendszerbe sem került' : `${here} NAV-rendszerhez tartozik`;
    throw new AppError('NOT_OTHER_NAV_SYSTEM', `A(z) ${n} számla NAV-állapota nem a másik NAV-rendszerhez tartozik (${where}, állapota: ${inv.navStatus}): nincs mit átküldeni.`, { hint });
  }

  /** The NAV environment invoices are reported to now; null without a usable NAV connection. */
  private navEnvironmentInUse(): NavEnvironment | null {
    const cfg = this.config;
    return cfg.nav && !cfg.navProblem ? cfg.nav.environment : null;
  }

  /**
   * The NAV part of status().nextSteps: the state of the connection and what to do with unreported invoices – and the
   * same as structured to-dos (status().todos).
   */
  private navNextSteps(cfg: AppConfig = this.config): { steps: string[]; todos: SetupTodo[] } {
    const steps: string[] = [];
    const todos: SetupTodo[] = [];
    const nav = cfg.nav;
    const setup = navSetupCommand(cfg.dataDir);
    if (!nav) {
      steps.push(
        'NAV Online Számla nincs beállítva: a kiállított számlákat a törvény szerint azonnal jelenteni kell. ' +
          `Hozz létre technikai felhasználót az onlineszamla.nav.gov.hu oldalon, majd futtasd: ${setup} (vagy add meg az OPENSZAMLA_NAV_* környezeti változókat).`,
      );
      todos.push({ code: 'NAV_NOT_CONFIGURED', count: 0 });
    } else if (cfg.navProblem) {
      steps.push(`A NAV-kapcsolat beállítása hibás, ezért a program egyetlen számlát sem tud jelenteni: ${cfg.navProblem} Javítsd: ${setup} (vagy a környezeti változókat), majd futtasd: nav_sync.`);
      todos.push({ code: 'NAV_INVALID_CONFIG', count: 0, problem: cfg.navProblem });
    } else if (nav.environment === 'test') {
      steps.push(
        'A NAV kapcsolat TESZT környezetre mutat: a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás NEM történik. ' +
          `Valódi számlázáshoz állítsd production környezetre (${navSetupCommandLine(cfg.dataDir, 'production')}, vagy OPENSZAMLA_NAV_ENV=production).`,
      );
      todos.push({ code: 'NAV_TEST_ENVIRONMENT', count: 0 });
    }
    // With a usable connection: a pause NAV asked for (Retry-After) – nav_sync sends nothing before it ends.
    const env = nav && !cfg.navProblem ? nav.environment : null;
    const pause = env ? this.navPauseActive(env) : null;
    if (pause) {
      steps.push(`${navPauseText(pause)}: addig a nav_sync nem küld be és nem kérdez le semmit – utána futtasd: nav_sync.`);
      todos.push({ code: 'NAV_PAUSE', count: 0, until: pause.until, pauseCode: pause.code });
    }
    // Counted in SQL: exact however many rejected invoices there are – with a usable connection those of its NAV
    // environment (or of none yet); the other NAV system's invoices have a step of their own.
    const scope = (navSelect: readonly NavSelector[]): readonly NavSelector[] => (env ? navHere(navSelect, env) : navSelect);
    const count = (navSelect: readonly NavSelector[], f: Partial<InvoiceFilter> = {}): number => this.store.findInvoices({ ...f, navSelect: scope(navSelect), limit: 0, offset: 0 }).total;
    const page = (navSelect: readonly NavSelector[], f: Partial<InvoiceFilter> = {}): Invoice[] =>
      this.store.findInvoices({ status: ['issued', 'cancelled'], ...f, navSelect: scope(navSelect), sort: 'issued_asc', limit: 200, offset: 0 }).items;
    // Corrections held up by an original NAV rejected: running nav_sync alone does not help them.
    const heldUp: Partial<InvoiceFilter> = { documentType: ['modification', 'storno'], originalNavSelect: scope(NAV_SEL_BLOCKING_ORIGINAL) };
    const blocked = count([{ navStatus: ['pending'] }], heldUp);
    // … nor those waiting for an original of the other NAV system.
    const otherSystem: NavSelector[] = env ? [{ navStatus: NAV_REPORTABLE, otherEnvironment: env }] : [];
    const heldByOther = env ? count([{ navStatus: ['pending'] }], { documentType: ['modification', 'storno'], originalNavSelect: otherSystem }) : 0;
    const rejected = count(NAV_SEL_REJECTED);
    if (rejected > 0) {
      steps.push(
        `${rejected} számla NAV-jelentését a NAV elutasította vagy végleges hibával zárult: nézd meg az okát (invoice_list navStatus: ["aborted", "error"], majd invoice_get → navMessages), ` +
          'hárítsd el, és küldd újra: nav_sync resubmitFailed: true.',
      );
      todos.push({ code: 'NAV_REJECTED', count: rejected });
    }
    const unchecked = count([NAV_SEL_BLOCKED]);
    if (unchecked > 0) {
      const reasons = new Set(page([NAV_SEL_BLOCKED]).map((i) => navBlockedReason(i.navMessages[i.navMessages.findIndex((m) => m.code === NAV_RECONCILE_BLOCKED) - 1]?.code ?? '')));
      steps.push(
        `${unchecked} számla NAV-jelentését a program nem tudja egyeztetni a NAV-val, mert a NAV lekérdezése végleges hibát ad: ${[...reasons].join('; ')}. ` +
          'Ezeket addig nem küldi (újra), mert nem tudja ellenőrizni, mi van belőlük a NAV-nál. ' +
          `Hárítsd el a hibát (a technikai felhasználó jogosultságai és adatai: onlineszamla.nav.gov.hu, ${setup}), majd futtasd: nav_sync resubmitFailed: true.`,
      );
      todos.push({ code: 'NAV_CHECK_BLOCKED', count: unchecked, reasons: [...reasons] });
    }
    const collisions = count([NAV_SEL_COLLISION]);
    if (collisions > 0) {
      const next = [...new Set(page([NAV_SEL_COLLISION]).map((i) => i.seriesId))].map((id) => this.seriesNextNumber(id)).filter((n): n is string => n !== null);
      steps.push(
        `${collisions} számla sorszáma a NAV-nál egy másik számláé (sorszám-ütközés, OPENSZAMLA_NUMBER_COLLISION): ezek a számlák nincsenek jelentve, és módosító/sztornó számlájuk sem küldhető be. ` +
          'Valószínű ok: egy régebbi mentés visszaállítása, vagy egy másik számlázó program ugyanezzel a sorszámtartománnyal. A teendőt az üzeneteik írják le (invoice_list navStatus: ["aborted"], majd invoice_get → navMessages).' +
          (next.length > 0 ? ` A következő kiadandó sorszám: ${next.join(', ')} – ellenőrizd a NAV felületén, hogy szabad-e.` : ''),
      );
      todos.push({ code: 'NAV_NUMBER_COLLISION', count: collisions, nextNumbers: next });
    }
    if (blocked > 0) {
      // Worded by why the original is not reported: resending helps only a rejected or failed one.
      const heldBy = (originalSelect: readonly NavSelector[]): { count: number; numbers: string; list: string[]; more: number } => {
        const n = count([{ navStatus: ['pending'] }], { documentType: ['modification', 'storno'], originalNavSelect: scope(originalSelect) });
        if (n === 0) return { count: 0, numbers: '', list: [], more: 0 };
        const originals = this.store.findInvoices({ status: ['issued', 'cancelled'], navSelect: scope(originalSelect), correctionNavStatus: ['pending'], sort: 'issued_asc', limit: 10, offset: 0 });
        const more = originals.total - originals.items.length;
        const list = originals.items.map((o) => o.number ?? o.id);
        return { count: n, numbers: `${list.join(', ')}${more > 0 ? ` és további ${more}` : ''}`, list, more };
      };
      const rejectedOriginal = heldBy(NAV_SEL_REJECTED);
      if (rejectedOriginal.count > 0) {
        steps.push(
          `${rejectedOriginal.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${rejectedOriginal.numbers}) NAV-jelentése elutasítva vagy hibás, a NAV pedig a módosítást csak az eredeti után fogadja be. ` +
            'Hárítsd el az eredeti számla jelentésének hibáját, és küldd újra: nav_sync { invoice: "<az eredeti sorszáma>", resubmitFailed: true } – utána a módosító/sztornó számla is beküldésre kerül.',
        );
        todos.push({ code: 'NAV_HELD_BY_REJECTED_ORIGINAL', count: rejectedOriginal.count, numbers: rejectedOriginal.list, more: rejectedOriginal.more });
      }
      const collisionOriginal = heldBy([NAV_SEL_COLLISION]);
      if (collisionOriginal.count > 0) {
        steps.push(
          `${collisionOriginal.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${collisionOriginal.numbers}) sorszáma a NAV-nál egy másik számláé (sorszám-ütközés): az eredeti nincs jelentve, a NAV pedig a módosítást/sztornót a másik számlához kötné. ` +
            'Az újraküldés nem segít: a teendőt az eredeti számla OPENSZAMLA_NUMBER_COLLISION üzenete írja le (invoice_get <az eredeti sorszáma>), a rendezéséhez kérj segítséget (könyvelő).',
        );
        todos.push({ code: 'NAV_HELD_BY_COLLISION_ORIGINAL', count: collisionOriginal.count, numbers: collisionOriginal.list, more: collisionOriginal.more });
      }
      const uncheckedOriginal = heldBy([NAV_SEL_BLOCKED]);
      if (uncheckedOriginal.count > 0) {
        const reasons = new Set(page([NAV_SEL_BLOCKED], { correctionNavStatus: ['pending'] }).map((i) => navBlockedReason(i.navMessages[i.navMessages.findIndex((m) => m.code === NAV_RECONCILE_BLOCKED) - 1]?.code ?? '')));
        steps.push(
          `${uncheckedOriginal.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${uncheckedOriginal.numbers}) NAV-jelentését a program nem tudja egyeztetni a NAV-val (${[...reasons].join('; ')}), a NAV pedig a módosítást csak az eredeti után fogadja be. ` +
            `Hárítsd el a hibát (a technikai felhasználó jogosultságai és adatai: onlineszamla.nav.gov.hu, ${setup}), majd futtasd: nav_sync resubmitFailed: true – az eredeti egyeztetése után a módosító/sztornó számla is beküldésre kerül.`,
        );
        todos.push({ code: 'NAV_HELD_BY_BLOCKED_ORIGINAL', count: uncheckedOriginal.count, numbers: uncheckedOriginal.list, more: uncheckedOriginal.more, reasons: [...reasons] });
      }
    }
    if (env) {
      const other = this.store.findInvoices({ status: ['issued', 'cancelled'], navSelect: otherSystem, sort: 'issued_asc', limit: 10, offset: 0 });
      if (other.total > 0) {
        const more = other.total - other.items.length;
        const numbers = `${other.items.map((o) => o.number ?? o.id).join(', ')}${more > 0 ? ` és további ${more}` : ''}`;
        const held = heldByOther > 0 ? ` Rájuk vár ${heldByOther} módosító/sztornó számla is (a NAV a módosítást csak az eredeti után fogadja be).` : '';
        steps.push(
          env === 'production'
            ? `${other.total} számla NAV-állapota a TESZT rendszerhez tartozik (ott jelentve, feldolgozás alatt vagy jelentésre várva), az éles rendszerbe nincs jelentve (${numbers}): ` +
                'a teszt környezetbe küldött számla nem adatszolgáltatás, és a nav_sync ezeket magától nem küldi be az éles rendszerbe. ' +
                `Ha valamelyik valódi számla, az éles rendszerbe a nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő kód: nav_sync { invoice: "<sorszám>", resubmitFailed: true }.${held}`
            : `${other.total} számla NAV-állapota az ÉLES rendszerhez tartozik (${numbers}): a TESZT környezetben a nav_sync nem foglalkozik velük – az éles jelentésükhöz állítsd vissza az éles (production) környezetet.${held}`,
        );
        const theirs: NavEnvironment = env === 'production' ? 'test' : 'production';
        todos.push({ code: 'NAV_OTHER_ENVIRONMENT', count: other.total, numbers: other.items.map((o) => o.number ?? o.id), more, environment: theirs });
        if (heldByOther > 0) todos.push({ code: 'NAV_HELD_BY_OTHER_ENVIRONMENT', count: heldByOther, environment: theirs });
      }
    }
    const duplicates = count([NAV_SEL_DUPLICATE]);
    if (duplicates > 0) {
      steps.push(`${duplicates} számla beküldését a NAV ismétlésként utasította el (INVOICE_NUMBER_NOT_UNIQUE) – futtasd: nav_sync, a program egyezteti a NAV-val.`);
      todos.push({ code: 'NAV_DUPLICATE', count: duplicates });
    }
    const unreported = count([{ navStatus: ['not_configured'] }]);
    if (unreported > 0) {
      steps.push(`${unreported} számla még nincs jelentve, mert kiállításakor nem volt használható NAV-kapcsolat – a kapcsolat beállítása után futtasd: nav_sync.`);
      todos.push({ code: 'NAV_NOT_REPORTED', count: unreported });
    }
    const pending = count([{ navStatus: ['pending'] }]) - blocked - heldByOther;
    if (pending > 0) {
      steps.push(`${pending} számla NAV-jelentése függőben – futtasd: nav_sync.`);
      todos.push({ code: 'NAV_PENDING', count: pending });
    }
    const processing = count([{ navStatus: ['processing'] }]);
    if (processing > 0) {
      steps.push(`${processing} számla NAV-feldolgozása folyamatban – futtasd később újra: nav_sync.`);
      todos.push({ code: 'NAV_PROCESSING', count: processing });
    }
    return { steps, todos };
  }

  /** The number the series `seriesId` gives next (as of today), or null. */
  private seriesNextNumber(seriesId: string): string | null {
    const s = this.store.getSeries(seriesId);
    if (!s) return null;
    const year = Number(this.today().slice(0, 4));
    if (s.seqYear !== null && year < s.seqYear) return null;
    try {
      return formatNumber(s.pattern, s.yearlyReset && s.seqYear !== null && year > s.seqYear ? 1 : s.nextSeq, year);
    } catch {
      return null;
    }
  }

  /**
   * Why a modification/storno cannot be sent now: NAV accepts it only after its original (spec 2.5). An original
   * rejected only as a duplicate (INVOICE_NUMBER_NOT_UNIQUE) is reconciled first, so it does not hold the chain up –
   * unless its number turns out to belong to another invoice at NAV (a number collision): NAV would attach the
   * correction to that one. A settled reconciliation (a recorded collision, a check a permanent NAV error blocks, a
   * hint) is not asked about again here: only nav_sync of the original itself does that. Accepted means accepted by
   * THIS NAV system: an original reported only to the other one holds its corrections up too.
   */
  private async navChainBlocker(client: NavRunClient, inv: Invoice, actor?: Actor): Promise<string | null> {
    if (!inv.reference) return null;
    let orig = this.store.getInvoice(inv.reference.originalInvoiceId);
    if (!orig) return null;
    const environment = client.environment;
    if (!navForeign(orig, environment) && orig.navStatus === 'aborted' && navUnsettledDuplicate(orig.navMessages)) {
      await this.navReconcileNotUnique(client, orig, orig.navMessages, actor);
      orig = this.getInvoice(orig.id);
    }
    if (!navAccepted(orig.navStatus) || navForeign(orig, environment)) return navWaitNote(orig, environment);
    // …and after the corrections issued before it: NAV numbers them and each refers to the lines the earlier ones
    // added. Sent while an earlier one is rejected, failed or still being processed, it would arrive out of order.
    const earlier = this.navBlockingDocument(inv, environment);
    return earlier ? navEarlierCorrectionNote(earlier) : null;
  }

  /**
   * The document `inv` has to wait for before it can be reported: its original, or the first correction issued before
   * it for the same invoice, that NAV – the configured system – has not accepted; null when nothing stands before it.
   */
  private navBlockingDocument(inv: Invoice, environment: NavEnvironment): Invoice | null {
    if (!inv.reference) return null;
    const orig = this.store.getInvoice(inv.reference.originalInvoiceId);
    if (!orig) return null;
    const accepted = (d: Invoice): boolean => navAccepted(d.navStatus) && !navForeign(d, environment);
    if (!accepted(orig)) return orig;
    for (const d of this.chainOf(orig)) {
      if (d.id === inv.id) break;
      if (!accepted(d)) return d;
    }
    return null;
  }

  /**
   * Sends one invoice. It is claimed first, in one IMMEDIATE transaction – so also against another process on the
   * same database: it must still be `claimable` with no other attempt open in this NAV environment (sending, sent,
   * processing – an attempt of the other NAV system cannot report it here), and the attempt is recorded as 'sending'
   * before anything goes out. Returns why it was not sent – the stop of the run when that kept it from starting –, or null.
   */
  private async navSubmitOne(client: NavRunClient, inv: Invoice, claimable: (fresh: Invoice) => boolean, actor?: Actor): Promise<string | NavStop | null> {
    const operation = navOperationFor(inv);
    // The exact data sent (gzip-compressed above 1 MB): signed, recorded with the attempt, compared when reconciling.
    let payload: { invoiceDataBase64: string; compressed: boolean };
    try {
      payload = encodeInvoiceData(buildInvoiceDataXml(inv));
    } catch (e) {
      // Data NAV would certainly reject: report it on this invoice, keep syncing the others.
      const hint = isAppError(e) && e.hint ? ` ${e.hint}` : '';
      const msg: NavMessage = { severity: 'ERROR', code: isAppError(e) ? e.code : 'NAV_DATA_INVALID', message: `${e instanceof Error ? e.message : String(e)}${hint}` };
      this.store.patchInvoice(inv.id, { navStatus: 'error', navMessages: [msg], navEnvironment: null });
      this.audit('nav.submit.error', 'nav', inv.id, { number: inv.number, code: msg.code, retryable: false }, actor);
      return null;
    }
    // Not started when NAV is out of reach in this run, or the request might not end in time (a time limit).
    const stop = client.stopped ?? (client.fits(2) ? null : client.stopped);
    if (stop) return stop;
    const environment = client.environment;
    const subId = this.store.tx(() => {
      const fresh = this.store.getInvoice(inv.id);
      if (!fresh || !claimable(fresh)) return null;
      if (this.store.listNavSubmissions(inv.id).some((s) => s.environment === environment && NAV_OPEN_SUBMISSION.has(s.status))) return null;
      return this.store.insertNavSubmission({
        invoiceId: inv.id, operation, environment, requestId: '', transactionId: null, status: 'sending',
        invoiceDataBase64: payload.invoiceDataBase64, messages: [], lastResponseXml: null,
      });
    });
    if (subId === null) return 'Nem küldtük be: közben egy másik NAV-szinkron (vagy egy másik folyamat) már beküldte, vagy éppen küldi.';
    try {
      const { transactionId } = await client.manageInvoice([{ index: 1, operation, invoiceDataBase64: payload.invoiceDataBase64 }], {
        compressedContent: payload.compressed,
        // Just measured on the token exchange, and recorded before the report goes out: an attempt cut off (a crash,
        // a power cut) is then still looked up by NAV's times, even if the clock is set right in the meantime.
        beforeSend: () => this.navRecordClock(inv, subId, client.clockOffsetMs, actor),
      });
      this.store.tx(() => {
        this.store.updateNavSubmission(subId, { transactionId, status: 'processing' });
        this.store.patchInvoice(inv.id, { navStatus: 'processing', navTransactionId: transactionId, navMessages: [], navEnvironment: environment });
      });
      this.audit('nav.submit', 'nav', inv.id, { number: inv.number, operation, transactionId, environment }, actor);
    } catch (e) {
      const code = e instanceof NavError ? e.navErrorCode : isAppError(e) ? e.code : 'UNKNOWN';
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof NavError && e.uncertain) {
        // NAV may have it: 'sent', outcome unknown – reconciled before any new attempt (navSettleOpen).
        const messages: NavMessage[] = [{ severity: 'WARN', code, message }, NAV_UNCERTAIN_MESSAGE];
        this.store.tx(() => {
          this.store.updateNavSubmission(subId, { status: 'sent', messages });
          this.store.patchInvoice(inv.id, { navStatus: 'pending', navMessages: messages, navEnvironment: environment });
        });
        // With how far this machine's clock was ahead of NAV's just now (measured on the token exchange before the
        // send; a difference of a minute or more is also on record from before the send – navRecordClock): the attempt
        // is looked up later by NAV's times (navClockOffsetAt).
        const clockOffsetMs = client.clockOffsetMs;
        this.audit('nav.submit.uncertain', 'nav', inv.id, { number: inv.number, code, submission: subId, ...(clockOffsetMs !== null ? { clockOffsetMs } : {}) }, actor);
        return null;
      }
      const msg: NavMessage = { severity: 'ERROR', code, message };
      const retryable = e instanceof NavError ? e.retryable : false;
      this.store.tx(() => {
        this.store.updateNavSubmission(subId, { status: 'error', messages: [msg] });
        this.store.patchInvoice(inv.id, { navStatus: retryable ? 'pending' : 'error', navMessages: [msg], navEnvironment: environment });
      });
      this.audit('nav.submit.error', 'nav', inv.id, { number: inv.number, code, retryable }, actor);
    }
    return null;
  }

  /**
   * Settles the earlier attempts of `inv` that may still lead to a report, before anything is sent again:
   * - 'sending' younger than NAV_SENDING_STALE_MS: another run (maybe another process) is sending it now;
   * - 'sent' (timeout, lost or unreadable answer) or a 'sending' left by a crash: looked up at NAV the way NAV's
   *   reference implementation does (spec 1.9.2) – 5 minutes after the attempt (navReconcileAttempt);
   * - 'processing' under another transaction than the invoice's (a parallel run of an older version): polled,
   *   an accepted one makes the invoice reported.
   * Only the attempts of this NAV environment: another NAV system's cannot report it here, nor be asked about here.
   * Returns why the invoice must not be sent in this run, or null.
   */
  private async navSettleOpen(client: NavRunClient, inv: Invoice, actor?: Actor): Promise<string | null> {
    const wallNow = this.now().getTime();
    for (const sub of this.store.listNavSubmissions(inv.id)) {
      if (sub.environment !== client.environment) continue;
      const cur = this.getInvoice(inv.id);
      if (sub.status === 'processing' && sub.transactionId && sub.transactionId !== cur.navTransactionId) {
        await this.navPollTransaction(client, cur, sub.transactionId, actor);
        if (this.store.findNavSubmissionByTransactionId(sub.transactionId)?.status === 'processing') {
          return `Egy korábbi beküldését a NAV még feldolgozza (tranzakció: ${sub.transactionId}) – addig nem küldjük újra.`;
        }
        continue;
      }
      if (sub.status !== 'sending' && sub.status !== 'sent') continue;
      const createdAt = Date.parse(sub.createdAt);
      // Time since the attempt, on the clock as it ran then: when the clock difference at the attempt is on record
      // and the clock was set since (10 minutes fast, then set right), the attempt would look 10 minutes younger
      // – or older – than it is.
      const atSend = this.navClockOffsetAt(inv.id, sub.id);
      const now = atSend === null ? wallNow : wallNow - (((await client.readClock()) ?? atSend) - atSend);
      if (sub.status === 'sending' && now - createdAt < NAV_SENDING_STALE_MS) {
        return 'Nem küldtük be: egy másik NAV-szinkron (vagy egy másik folyamat) éppen beküldi.';
      }
      // The latest moment the request can have reached NAV.
      const sentBy = sub.status === 'sent' ? Date.parse(sub.updatedAt) : createdAt + NAV_SEND_MAX_MS;
      const due = sentBy + NAV_RECONCILE_DELAY_MS;
      if (now < due) {
        return (
          'Egy korábbi beküldés eredménye bizonytalan (a NAV megkaphatta). A NAV ajánlása szerint a beküldés után 5 perccel ellenőrizzük, hogy megérkezett-e – ' +
          `addig nem küldjük újra, különben kétszer kerülhetne a NAV-hoz. Futtasd újra a nav_sync-et kb. ${Math.ceil((due - now) / 60_000)} perc múlva.`
        );
      }
      const settled = await this.navReconcileAttempt(client, cur, sub, sentBy, actor);
      if (settled) return settled;
    }
    return null;
  }

  /**
   * NAV's reference recovery of a submission with an unknown outcome (spec 1.9.2): list the transactions NAV
   * received around the attempt (queryTransactionList, every page) and compare the original request of every one
   * this technical user sent that is not recorded here (queryTransactionStatus, returnOriginalRequest) with the data
   * we sent. A match is adopted as the attempt's transaction – nothing is sent again; without one the attempt never
   * reached NAV and the invoice may be sent. When the list cannot be searched, the invoice number is looked up
   * directly (navReconcileByNumber). Returns why the invoice must not be sent now, or null.
   */
  private async navReconcileAttempt(client: NavRunClient, inv: Invoice, sub: NavSubmissionRecord, sentBy: number, actor?: Actor): Promise<string | null> {
    // The window around the attempt, in NAV time (NAV lists by when it received a transaction): the attempt's times by
    // how far this machine's clock was ahead of NAV's when it was made (navClockOffsetAt; unknown for an attempt cut
    // off by a crash: the difference measured now), and not later than NAV's "now" – by the difference measured now,
    // on an earlier answer of this run or on the listing's first page, which is then asked again. A PC clock 10
    // minutes fast would otherwise miss our own lost submission.
    const atSend = this.navClockOffsetAt(inv.id, sub.id);
    let nowOffset = (atSend === null ? await client.readClock() : client.clockOffsetMs) ?? atSend ?? 0;
    const windowAt = (o: number): { from: Date; to: Date } => ({
      from: new Date(Date.parse(sub.createdAt) - (atSend ?? o) - NAV_CLOCK_MARGIN_MS),
      // NAV's "now" is known to the second only (the HTTP Date header has whole seconds): one second is added.
      to: new Date(Math.min(this.now().getTime() - o + 1000, sentBy - (atSend ?? o) + NAV_CLOCK_MARGIN_MS)),
    });
    let { from, to } = windowAt(nowOffset);
    let sent: Buffer;
    try {
      sent = decodeInvoiceData(sub.invoiceDataBase64);
    } catch {
      sent = Buffer.from(sub.invoiceDataBase64, 'base64');
    }
    let match: { transactionId: string; result: NavProcessingResult; responseXml: string } | null = null;
    try {
      for (let page = 1, pages = 1; page <= pages && !match; page++) {
        const list = await client.queryTransactionList(from, to, page);
        const measured = client.clockOffsetMs;
        if (page === 1 && measured !== null && measured !== nowOffset) {
          // The clock difference is known better now: the listing starts again only when the window it gives reaches
          // beyond the one just listed (a narrower one was covered).
          nowOffset = measured;
          const better = windowAt(nowOffset);
          const grows = better.from.getTime() < from.getTime() - NAV_CLOCK_RELIST_MS || better.to.getTime() > to.getTime() + NAV_CLOCK_RELIST_MS;
          if (grows) {
            ({ from, to } = better);
            page = 0;
            continue;
          }
        }
        pages = list.availablePage;
        for (const tx of list.transactions) {
          // Another technical user's transaction (e.g. a webshop's) or an annulment cannot be our lost submission.
          if (!tx.ownUser || tx.technicalAnnulment) continue;
          if (this.store.findNavSubmissionByTransactionId(tx.transactionId)) continue; // recorded: not the lost one
          const status = await client.queryTransactionStatus(tx.transactionId, { returnOriginalRequest: true });
          const result = status.results.find((r) => r.originalRequest !== undefined && samePayload(r.originalRequest, sent));
          if (result) {
            match = { transactionId: tx.transactionId, result, responseXml: status.responseXml };
            break;
          }
        }
      }
    } catch (e) {
      return this.navReconcileByNumber(client, inv, sub, e, actor);
    }
    if (!match) {
      const notReceived: NavMessage = {
        severity: 'INFO',
        code: 'OPENSZAMLA_NOT_RECEIVED',
        message: `A NAV tranzakciólistája szerint ez a beküldés nem érkezett meg a NAV-hoz (ellenőrzött időszak: ${from.toISOString()} – ${to.toISOString()}), ezért a számla újra beküldhető.`,
      };
      this.store.updateNavSubmission(sub.id, { status: 'error', messages: [...sub.messages, notReceived] });
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, submission: sub.id, received: false }, actor);
      return null;
    }
    const status = navStatusOf(match.result);
    this.store.updateNavSubmission(sub.id, { transactionId: match.transactionId, status, messages: match.result.messages, lastResponseXml: match.responseXml });
    this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, submission: sub.id, received: true, transactionId: match.transactionId, invoiceStatus: match.result.invoiceStatus }, actor);
    const note = `A korábbi, bizonytalan kimenetelű beküldést a NAV megkapta (tranzakció: ${match.transactionId}), ezért nem küldtük újra.`;
    if (navAccepted(this.getInvoice(inv.id).navStatus)) return note;
    // The found transaction becomes the invoice's own one.
    this.store.patchInvoice(inv.id, { navTransactionId: match.transactionId });
    await this.navApplyResult(client, this.getInvoice(inv.id), match.transactionId, status, match.result, actor);
    return note;
  }

  /**
   * An attempt with an unknown outcome whose transaction list could not be searched (`failure`): what NAV holds
   * under the invoice number (navLookup) settles it when that is this invoice (reported – nothing is sent) or
   * another one (a number collision). Otherwise nothing is sent, and `failure` says why: a permanent NAV error
   * (e.g. no query permission) is a configuration problem – the invoice becomes 'error' with the remedy
   * (OPENSZAMLA_RECONCILE_BLOCKED) until it is fixed –, anything else is tried again by a later run.
   */
  private async navReconcileByNumber(client: NavRunClient, inv: Invoice, sub: NavSubmissionRecord, failure: unknown, actor?: Actor): Promise<string> {
    let found: NavLookup | null = null;
    try {
      found = await this.navLookup(client, inv);
    } catch {
      found = null;
    }
    const cur = this.getInvoice(inv.id);
    const accepted = navAccepted(cur.navStatus);
    if (found && (found.kind === 'same' || found.kind === 'similar')) {
      // Our data at NAV under a transaction not recorded here: most likely the lost one, adopted as this attempt's.
      const adopt = found.kind === 'same' && found.transactionId !== null && !this.store.findNavSubmissionByTransactionId(found.transactionId);
      const settledInfo: NavMessage = { severity: 'INFO', code: 'OPENSZAMLA_RECONCILED', message: 'A NAV-nál a számla szerepel (queryInvoiceData); ez a kísérlet nincs nyitva tovább.' };
      this.store.updateNavSubmission(sub.id, adopt ? { status: 'done', transactionId: found.transactionId, messages: [...sub.messages, settledInfo] } : { status: 'error', messages: [...sub.messages, settledInfo] });
      if (!accepted) this.store.patchInvoice(inv.id, { navStatus: 'done', navTransactionId: found.transactionId, navMessages: [navReconciledMessage(found, 'lookup')], navEnvironment: client.environment });
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, submission: sub.id, via: 'queryInvoiceData', match: found.kind, transactionId: found.transactionId, ...(found.kind === 'similar' ? { source: found.source } : {}) }, actor);
      const how = found.kind === 'same' ? 'azonos adattartalommal' : navManualSource(found.source) ? 'azonos kulcsadatokkal' : 'azonos kulcs- és tételadatokkal';
      return `A korábbi, bizonytalan kimenetelű beküldés tranzakciója nem volt megkereshető, de a NAV-nál a számla szerepel (${how}), ezért nem küldtük újra.`;
    }
    if (found?.kind === 'other') {
      const otherInfo: NavMessage = { severity: 'INFO', code: NAV_COLLISION, message: 'A NAV-nál ezzel a sorszámmal egy másik számla szerepel (queryInvoiceData); ez a kísérlet nincs nyitva tovább.' };
      this.store.updateNavSubmission(sub.id, { status: 'error', messages: [...sub.messages, otherInfo] });
      // The attempt is settled: what remains is the collision.
      if (!accepted) this.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [this.navCollisionMessage(cur, found.differences, found.receivedAt)], navEnvironment: client.environment });
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, submission: sub.id, via: 'queryInvoiceData', match: 'other', differences: found.differences, ...(found.receivedAt !== undefined ? { insDate: found.receivedAt } : {}) }, actor);
      return `Sorszám-ütközés: a NAV-nál ezzel a sorszámmal egy másik számla szerepel (eltérés: ${found.differences.join(', ')}) – ez a számla nincs jelentve, és nem küldtük be. Lásd az üzeneteket.`;
    }
    // Unresolved: never sent without knowing whether NAV has it.
    if (navPermanent(failure)) {
      const blocked = navBlockedMessages(failure);
      if (!accepted) this.store.patchInvoice(inv.id, { navStatus: 'error', navMessages: [...navWithoutOutcome(cur.navMessages), ...blocked], navEnvironment: client.environment });
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, submission: sub.id, received: null, code: failure.navErrorCode }, actor);
      return (blocked[1] as NavMessage).message;
    }
    if (cur.navStatus === 'error' && navHas(cur.navMessages, NAV_RECONCILE_BLOCKED)) {
      // The configuration problem is gone (this failure is a transient one): a plain nav_sync tries again.
      this.store.patchInvoice(inv.id, { navStatus: 'pending', navMessages: navWithoutOutcome(cur.navMessages) });
    }
    return `Egy korábbi, bizonytalan kimenetelű beküldés egyeztetése a NAV-val most nem sikerült (${failure instanceof Error ? failure.message : String(failure)}) – addig nem küldjük újra. Futtasd később újra a nav_sync-et.`;
  }

  /** Polls the transaction of a 'processing' invoice. */
  private async navPollOne(client: NavRunClient, inv: Invoice, actor?: Actor): Promise<void> {
    if (!inv.navTransactionId) {
      // Nothing to poll (an interrupted run of an older version): pending again – the next run reconciles any
      // open attempt before sending.
      this.store.patchInvoice(inv.id, { navStatus: 'pending' });
      return;
    }
    await this.navPollTransaction(client, inv, inv.navTransactionId, actor);
  }

  /** Fetches the result of `transactionId` (a submission of `inv`), records it on that submission and on the invoice. */
  private async navPollTransaction(client: NavRunClient, inv: Invoice, transactionId: string, actor?: Actor): Promise<void> {
    let polled: { results: NavProcessingResult[]; responseXml: string };
    try {
      polled = await client.queryTransactionStatus(transactionId);
    } catch (e) {
      if ((e instanceof NavError && e.retryable) || transactionId !== inv.navTransactionId) return;
      const msg: NavMessage = { severity: 'ERROR', code: e instanceof NavError ? e.navErrorCode : 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
      this.store.patchInvoice(inv.id, { navMessages: [msg] });
      return;
    }
    const r = polled.results.find((x) => x.index === 1) ?? polled.results[0];
    if (!r) {
      await this.navTransactionUnknown(client, inv, transactionId, actor);
      return;
    }
    const status = navStatusOf(r);
    const sub = this.store.findNavSubmissionByTransactionId(transactionId);
    if (sub) this.store.updateNavSubmission(sub.id, { status, messages: r.messages, lastResponseXml: polled.responseXml });
    await this.navApplyResult(client, inv, transactionId, status, r, actor);
  }

  /**
   * NAV has no result for `transactionId`, a submission of `inv` (queryTransactionStatus came back without one): NAV does
   * not know the transaction under this taxpayer – a NAV test system that was emptied, a changed tax number or technical
   * user. For NAV_RECONCILE_DELAY_MS after the attempt nothing changes (a fresh transaction may not show yet). After that
   * the attempt is closed, and what NAV holds under the invoice number decides (navLookup): this invoice – reported;
   * another one – a number collision; several – to be cleared up at NAV; nothing – the invoice is 'pending' again and the
   * next run sends it. While NAV cannot be asked, it stays 'processing' and a later run tries again. Only the invoice's
   * current transaction changes the invoice; an accepted invoice is never touched.
   */
  private async navTransactionUnknown(client: NavRunClient, inv: Invoice, transactionId: string, actor?: Actor): Promise<void> {
    const sub = this.store.findNavSubmissionByTransactionId(transactionId);
    const since = Date.parse(sub?.updatedAt ?? '');
    if (Number.isFinite(since) && this.now().getTime() - since < NAV_RECONCILE_DELAY_MS) return;
    let found: NavLookup;
    try {
      found = await this.navLookup(client, inv);
    } catch {
      return;
    }
    const environment = client.environment;
    const system = environment === 'test' ? 'A NAV TESZT rendszere' : 'A NAV';
    const unknown: NavMessage = {
      severity: 'WARN',
      code: NAV_TRANSACTION_UNKNOWN,
      message:
        `${system} nem ismeri ennek a beküldésnek a tranzakcióját (${transactionId}): nem ad róla feldolgozási eredményt. ` +
        'Ilyen akkor fordul elő, ha a NAV tesztrendszerét kiürítették, vagy ha a beküldés óta megváltozott a technikai felhasználó vagy az eladó adószáma.',
    };
    const cur = this.getInvoice(inv.id);
    const change = transactionId === cur.navTransactionId && !navAccepted(cur.navStatus);
    const close = (...more: NavMessage[]): void => {
      if (sub) this.store.updateNavSubmission(sub.id, { status: 'error', messages: [...sub.messages, unknown, ...more] });
    };
    const log = (details: Record<string, unknown>): void => {
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, ...(sub ? { submission: sub.id } : {}), via: 'queryInvoiceData', unknownTransaction: transactionId, ...details }, actor);
    };
    switch (found.kind) {
      case 'same':
      case 'similar':
        close({ severity: 'INFO', code: 'OPENSZAMLA_RECONCILED', message: 'A NAV-nál a számla szerepel (queryInvoiceData); ez a kísérlet nincs nyitva tovább.' });
        if (change) this.store.patchInvoice(inv.id, { navStatus: 'done', navTransactionId: found.transactionId, navMessages: [navReconciledMessage(found, 'lookup')], navEnvironment: environment });
        log({ match: found.kind, transactionId: found.transactionId, ...(found.kind === 'similar' ? { source: found.source } : {}) });
        return;
      case 'other':
        close({ severity: 'INFO', code: NAV_COLLISION, message: 'A NAV-nál ezzel a sorszámmal egy másik számla szerepel (queryInvoiceData); ez a kísérlet nincs nyitva tovább.' });
        if (change) this.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [unknown, this.navCollisionMessage(cur, found.differences, found.receivedAt)], navEnvironment: environment });
        log({ match: 'other', differences: found.differences, ...(found.receivedAt !== undefined ? { insDate: found.receivedAt } : {}) });
        return;
      case 'multiple':
        close();
        if (change) {
          const hint: NavMessage = {
            severity: 'INFO',
            code: NAV_HINT,
            message:
              'Ez a sorszám a NAV-nál többször is érvényes adatszolgáltatásként szerepel (MULTIPLE_QUERY_RESULT_FOUND). ' +
              'A fölösleget a NAV felületén (onlineszamla.nav.gov.hu) technikai érvénytelenítéssel kell visszavonni; utána futtasd: nav_sync resubmitFailed: true.',
          };
          this.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [unknown, hint], navEnvironment: environment });
        }
        log({ match: 'multiple' });
        return;
      case 'none':
        close();
        if (change) {
          const resend: NavMessage = {
            severity: 'INFO',
            code: NAV_HINT,
            message: 'Ezzel a sorszámmal a NAV-nál nincs érvényes számla (queryInvoiceData), ezért a számla újra beküldhető: a következő NAV-szinkron (nav_sync; a webes felületen a „Függő számlák beküldése a NAV-nak” gomb) beküldi.',
          };
          this.store.patchInvoice(inv.id, { navStatus: 'pending', navTransactionId: null, navMessages: [unknown, resend], navEnvironment: environment });
        }
        log({ match: 'none' });
        return;
    }
  }

  /**
   * Applies NAV's result of one submission of `inv` to the invoice. An accepted submission always wins: a later
   * attempt rejected as a duplicate (INVOICE_NUMBER_NOT_UNIQUE) never turns a reported invoice into 'aborted'.
   * Results of other than the invoice's current transaction change it only when they are an acceptance.
   */
  private async navApplyResult(client: NavRunClient, inv: Invoice, transactionId: string, status: NavStatus, r: NavProcessingResult, actor?: Actor): Promise<void> {
    const current = transactionId === inv.navTransactionId;
    if (status === 'processing') {
      if (current) this.store.patchInvoice(inv.id, { navStatus: 'processing', navMessages: r.messages, navEnvironment: client.environment });
      return;
    }
    this.audit('nav.result', 'nav', inv.id, { number: inv.number, transactionId, invoiceStatus: r.invoiceStatus, messages: r.messages.length }, actor);
    if (navAccepted(status)) {
      this.store.patchInvoice(inv.id, { navStatus: status, navTransactionId: transactionId, navMessages: r.messages, navEnvironment: client.environment });
    } else if (current && navNotUnique(r.messages)) {
      await this.navReconcileNotUnique(client, inv, r.messages, actor);
    } else if (current) {
      this.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: r.messages, navEnvironment: client.environment });
    }
  }

  /**
   * `inv` was rejected as a duplicate (INVOICE_NUMBER_NOT_UNIQUE) – or an earlier reconciliation found its number
   * taken or could not finish: its number has a valid report at NAV. That report is this invoice when one of our
   * submissions was accepted, or when NAV did not receive the report it holds under the number (queryInvoiceData)
   * before the invoice was issued and that report is one of our submissions byte for byte, or matches it
   * (navRecordDifferences – e.g. entered by hand on the NAV web interface). Then the invoice IS reported: it
   * becomes done (audit: nav.reconcile), and its modifications and stornos can follow. Another invoice's data is a
   * number collision (OPENSZAMLA_NUMBER_COLLISION): it stays
   * aborted, and so do its corrections – NAV would attach them to the other invoice. A NAV valid number alone
   * proves nothing. resendable: NAV holds no valid report with the number, so sending it again can succeed. Everything
   * is about the NAV system of `client`: what the other one accepted is no report here.
   */
  private async navReconcileNotUnique(client: NavRunClient, inv: Invoice, rejection: NavMessage[], actor?: Actor): Promise<{ note: string; resendable: boolean }> {
    const environment = client.environment;
    const accepted = this.store.listNavSubmissions(inv.id).filter((s) => s.environment === environment && (s.status === 'done' || s.status === 'done_with_warnings')).at(-1);
    if (accepted) {
      this.store.patchInvoice(inv.id, { navStatus: accepted.status as NavStatus, navTransactionId: accepted.transactionId, navMessages: [...accepted.messages, NAV_DUPLICATE_MESSAGE], navEnvironment: environment });
      this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, via: 'submission', transactionId: accepted.transactionId }, actor);
      return { note: `Egy korábbi beküldését a NAV már befogadta (tranzakció: ${accepted.transactionId}); a későbbi, ismétlésként elutasított beküldés ezen nem változtat.`, resendable: false };
    }
    const keepAborted = (...outcome: NavMessage[]): void => {
      this.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [...navWithoutOutcome(rejection), ...outcome], navEnvironment: environment });
    };
    const hint = (message: string): NavMessage => ({ severity: 'INFO', code: NAV_HINT, message });
    let found: NavLookup;
    try {
      found = await this.navLookup(client, inv);
    } catch (e) {
      if (navPermanent(e)) {
        const blocked = navBlockedMessages(e);
        keepAborted(...blocked);
        return { note: (blocked[1] as NavMessage).message, resendable: false };
      }
      keepAborted({
        severity: 'INFO',
        code: NAV_RECONCILE_RETRY,
        message:
          'A NAV ezt a beküldést ismétlésként utasította el (INVOICE_NUMBER_NOT_UNIQUE). A program lekéri a NAV-tól az ezzel a sorszámmal tárolt számlát, és összeveti ezzel; ez most nem sikerült – a következő nav_sync újra megpróbálja.',
      });
      return { note: `Ismétlésként elutasítva; a NAV-nál tárolt számla lekérése most nem sikerült (${e instanceof Error ? e.message : String(e)}) – futtasd később újra a nav_sync-et.`, resendable: false };
    }
    switch (found.kind) {
      case 'same':
      case 'similar':
        this.store.patchInvoice(inv.id, { navStatus: 'done', navTransactionId: found.transactionId, navMessages: [navReconciledMessage(found, 'duplicate')], navEnvironment: environment });
        this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, via: 'queryInvoiceData', match: found.kind, transactionId: found.transactionId, ...(found.kind === 'similar' ? { source: found.source } : {}) }, actor);
        return {
          note:
            found.kind === 'same'
              ? 'A NAV-nál ellenőrizve: ezzel a sorszámmal ennek a számlának egy korábbi beküldése szerepel (azonos adattartalommal), tehát jelentve van.'
              : navManualSource(found.source)
                ? 'A NAV-nál ellenőrizve: ezzel a sorszámmal azonos kulcsadatú, nem gépi interfészen beküldött számla szerepel (pl. a NAV felületén kézzel rögzítették), tehát jelentve van – lásd az üzenetet.'
                : navOtherChannel(found.source)
                  ? `A NAV-nál ellenőrizve: ezzel a sorszámmal azonos kulcs- és tételadatú számla szerepel – ${navSourceText(found.source)} –, tehát jelentve van – lásd az üzenetet.`
                  : 'A NAV-nál ellenőrizve: ezzel a sorszámmal gépi interfészen beküldött, azonos kulcs- és tételadatú számla szerepel, tehát jelentve van – lásd az üzenetet.',
          resendable: false,
        };
      case 'other':
        keepAborted(this.navCollisionMessage(inv, found.differences, found.receivedAt));
        this.audit('nav.reconcile', 'nav', inv.id, { number: inv.number, via: 'queryInvoiceData', match: 'other', differences: found.differences, ...(found.receivedAt !== undefined ? { insDate: found.receivedAt } : {}) }, actor);
        return { note: `Sorszám-ütközés: a NAV-nál ezzel a sorszámmal egy másik számla szerepel (eltérés: ${found.differences.join(', ')}) – ez a számla nincs jelentve. Lásd az üzeneteket.`, resendable: false };
      case 'multiple':
        keepAborted(
          hint(
            'A NAV ezt a beküldést ismétlésként utasította el (INVOICE_NUMBER_NOT_UNIQUE), és ez a sorszám a NAV-nál többször is érvényes adatszolgáltatásként szerepel (MULTIPLE_QUERY_RESULT_FOUND). ' +
              'A fölösleget a NAV felületén (onlineszamla.nav.gov.hu) technikai érvénytelenítéssel kell visszavonni; utána futtasd: nav_sync resubmitFailed: true.',
          ),
        );
        return { note: 'Ismétlésként elutasítva, és a NAV-nál ez a sorszám többször is érvényes – lásd az üzeneteket.', resendable: false };
      case 'none':
        keepAborted(
          hint(
            'A NAV ezt a beküldést ismétlésként utasította el (INVOICE_NUMBER_NOT_UNIQUE), de a lekérdezés (queryInvoiceData) szerint ezzel a sorszámmal most nincs érvényes számla a NAV-nál (pl. időközben technikailag érvénytelenítették). ' +
              'Ha az onlineszamla.nav.gov.hu felületén sem szerepel, küldd újra: nav_sync resubmitFailed: true.',
          ),
        );
        return { note: 'Ismétlésként elutasítva, de a NAV-nál ezzel a sorszámmal most nincs érvényes számla – lásd az üzeneteket.', resendable: true };
    }
  }

  /**
   * How far this machine's clock was ahead of NAV's (ms) when an attempt of the invoice with an unknown outcome was made –
   * the attempt `submissionId`, or the invoice's first such attempt –, as recorded before the send (navRecordClock: a
   * difference of a minute or more) or with the uncertain outcome ('nav.submit.uncertain'); null when neither did (the
   * difference was under a minute and the attempt was cut off, or a version that did not measure it made it). The times stamped then
   * (the attempt's createdAt, the invoice's issuedAt) turn into NAV time with it, whatever the clock shows since.
   */
  private navClockOffsetAt(invoiceId: string, submissionId?: number): number | null {
    const entries = [...this.store.auditEntries(invoiceId, NAV_CLOCK_ACTION), ...this.store.auditEntries(invoiceId, 'nav.submit.uncertain')].sort((a, b) => a.id - b.id);
    for (const e of entries) {
      const { submission, clockOffsetMs } = e.details;
      if (submissionId !== undefined && submission !== submissionId) continue;
      if (typeof clockOffsetMs === 'number' && Number.isFinite(clockOffsetMs)) return clockOffsetMs;
    }
    return null;
  }

  /**
   * Records, before a report goes out, how far this machine's clock is ahead of NAV's – when it is a minute or more:
   * a smaller difference changes nothing (the comparisons allow NAV_CLOCK_MARGIN_MS), and the log stays free of an
   * entry per report. Never fails the report.
   */
  private navRecordClock(inv: Invoice, submission: number, clockOffsetMs: number | null, actor?: Actor): void {
    if (clockOffsetMs === null || Math.abs(clockOffsetMs) < NAV_CLOCK_RELIST_MS) return;
    try {
      this.audit(NAV_CLOCK_ACTION, 'nav', inv.id, { number: inv.number, submission, clockOffsetMs }, actor);
    } catch {
      // the report matters more than this note
    }
  }

  /**
   * What NAV holds under the number of `inv` (queryInvoiceData), compared with the invoice: 'other' – another
   * invoice: NAV received it more than NAV_CLOCK_MARGIN_MS before `inv` was issued (navReceivedBeforeIssue –
   * whatever its data, even our bytes: `receivedAt` is its insDate), or its data differ (navRecordDifferences);
   * 'same' – the data of one of our submissions, byte for byte; 'similar' – other data that is still this invoice:
   * typed by hand on the NAV web interface (WEB) with the same key data (issue date, seller and buyer, currency, HUF
   * totals), or from any other channel (MGM, XML, OSZ, OPG) with the same key data and lines; 'none' – no valid
   * invoice with this number; 'multiple' – valid more than once. Throws the NavError of the query.
   */
  private async navLookup(client: NavRunClient, inv: Invoice): Promise<NavLookup> {
    const r = await client.queryInvoiceData(inv.number as string);
    if (r.status === 'not_found') return { kind: 'none' };
    if (r.status === 'multiple') return { kind: 'multiple' };
    // issuedAt in NAV time: by the clock difference when the invoice was first sent (right after it was issued), else
    // the one measured on this very answer – a PC clock minutes off must not turn our own lost report into a collision.
    if (navReceivedBeforeIssue(inv, r.audit.insDate, NAV_CLOCK_MARGIN_MS, this.navClockOffsetAt(inv.id) ?? (await client.readClock()))) {
      const receivedAt = r.audit.insDate.trim();
      return { kind: 'other', differences: [`a NAV ${huDateTime(receivedAt)}-kor kapta meg, ez a számla csak ${huDateTime(inv.issuedAt as string)}-kor készült`], receivedAt };
    }
    if (this.store.listNavSubmissions(inv.id).some((s) => samePayload(s.invoiceDataBase64, r.invoiceData))) return { kind: 'same', transactionId: r.audit.transactionId };
    const differences = navRecordDifferences(inv, parseInvoiceDataKeys(r.invoiceData), r.audit.source);
    return differences.length === 0 ? { kind: 'similar', transactionId: r.audit.transactionId, source: r.audit.source } : { kind: 'other', differences };
  }

  /**
   * OPENSZAMLA_NUMBER_COLLISION: NAV holds another invoice under the number of `inv` – the likely cause and what to do.
   * `receivedAt`: NAV received that invoice (insDate) before `inv` was issued (navLookup), which the message names.
   */
  private navCollisionMessage(inv: Invoice, differences: readonly string[], receivedAt?: string): NavMessage {
    const next = this.seriesNextNumber(inv.seriesId);
    const why =
      receivedAt !== undefined
        ? `az ezzel a sorszámmal ott tárolt számlát a NAV ${huDateTime(receivedAt)}-kor kapta meg, ez a számla pedig csak ${huDateTime(inv.issuedAt as string)}-kor készült (e gép órája szerint), így az nem ez a számla – akkor sem, ha az adatai egyeznek vele (pl. ugyanaz a tétel ugyanazon az áron egy másik magánszemélynek, akiről a NAV csak a státuszát kapja)`
        : `az ezzel a sorszámmal ott tárolt számla adatai eltérnek ettől a számlától (${differences.join(', ')})`;
    return {
      severity: 'ERROR',
      code: NAV_COLLISION,
      message:
        `A(z) ${inv.number} sorszám a NAV-nál egy másik számláé: ${why}. ` +
        'Ez a számla tehát NINCS jelentve, és módosító vagy sztornó számlája sem küldhető be (a NAV a másik számlához kötné). ' +
        'Valószínű ok: egy régebbi mentés visszaállítása után a program újra kiadta a már felhasznált sorszámot, vagy egy másik számlázó program (másik telepítés) ugyanezt a sorszámtartományt használja. ' +
        (next ? `A sorszámtartomány következő sorszáma: ${next} – ellenőrizd a NAV felületén (onlineszamla.nav.gov.hu), hogy az még szabad-e; ha nem, hozz létre új sorszámtartományt eltérő előtaggal (series_manage), és állítsd alapértelmezettnek. ` : '') +
        'A sorszám-ütközés rendezéséhez kérj segítséget (könyvelő). Ha a NAV-nál tárolt számla a hibás, és azt a NAV felületén technikai érvénytelenítéssel visszavonják, utána küldd újra ezt a számlát: ' +
        `nav_sync { invoice: "${inv.number}", resubmitFailed: true }.`,
    };
  }

  /**
   * NAV taxpayer lookup (queryTaxpayer); optionally saves the result as a DOMESTIC customer. A pause NAV asked for
   * (Retry-After, navPauseActive) holds here too: NAV is not asked before it ends (NAV_PAUSED), and a pause NAV asks
   * for in its answer is recorded like one of a nav_sync.
   */
  async lookupTaxpayer(taxNumber: string, opts: { saveAsCustomer?: boolean } = {}, actor?: Actor): Promise<{ taxpayer: TaxpayerInfo | null; customer: Customer | null }> {
    const p = parseHuTaxNumber(taxNumber);
    if (!p.ok) throw new AppError('INVALID_TAX_NUMBER', `Érvénytelen adószám: ${p.error}`, { hint: 'Elég a 8 jegyű törzsszám, pl. 12345676.' });
    const client = this.navClient();
    const pause = this.navPauseActive(client.environment);
    if (pause) {
      throw new AppError('NAV_PAUSED', `${navPauseText(pause)} – ${navRemaining(Date.parse(pause.until) - this.now().getTime())} van hátra. Addig a program az adószám-lekérdezéssel sem fordul a NAV-hoz.`, {
        hint: `Próbáld újra ${huDateTime(pause.until)} után; addig a vevő adatait kézzel is megadhatod (customer_save).`,
      });
    }
    let taxpayer: TaxpayerInfo | null;
    try {
      taxpayer = await client.queryTaxpayer(p.value.taxpayerId);
    } catch (e) {
      if (e instanceof NavError && navAsksToWait(e)) this.navRecordPause(e, client.environment);
      throw e;
    }
    let customer: Customer | null = null;
    if (taxpayer && opts.saveAsCustomer) {
      const hq = taxpayer.addresses.find((a) => a.type === 'HQ') ?? taxpayer.addresses[0];
      if (!hq) throw new AppError('NAV_NO_ADDRESS', 'A NAV nem adott vissza címet ehhez az adószámhoz; add meg kézzel (customer_save).');
      customer = this.saveCustomer({ vatStatus: 'DOMESTIC', name: taxpayer.name, taxNumber: taxpayer.formattedTaxNumber, address: hq.address }, actor).customer;
    }
    return { taxpayer, customer };
  }

  // ===========================================================================================
  // Exchange rates, reports, export, audit
  // ===========================================================================================

  async exchangeRate(currency: string, date?: IsoDate): Promise<{ currency: string; rate: string; date: IsoDate; unit: number; source: 'MNB' }> {
    const cur = currency.trim().toUpperCase();
    const day = date ? assertIsoDate(date, 'date') : this.today();
    if (cur === 'HUF') return { currency: 'HUF', rate: '1', date: day, unit: 1, source: 'MNB' };
    const cached = this.store.getCachedRate(cur, day);
    if (cached) return { currency: cur, rate: toDec(dec(cached.rate).div(cached.unit)), date: cached.date, unit: 1, source: 'MNB' };
    const r = await this.mnb.getRate(cur, day);
    // Only past days are final: MNB may still publish today's rate later today.
    if (day < this.today()) this.store.putCachedRate(day, { currency: cur, date: r.date, rate: r.publishedRate, unit: r.unit, source: 'MNB' });
    return { currency: cur, rate: r.rate, date: r.date, unit: 1, source: 'MNB' };
  }

  /** Issued (and cancelled) invoices – no díjbekérő – whose issue or fulfilment date (basis) is in the range, in issue order. */
  private allIssuedBetween(from: IsoDate, to: IsoDate, basis: DateBasis = 'issue'): Invoice[] {
    const out: Invoice[] = [];
    this.forEachIssuedBetween(from, to, basis, (inv) => out.push(inv));
    return out;
  }

  /**
   * allIssuedBetween one document at a time: one query for the whole period (Store.forEachInvoice), so a full year
   * costs one sort of its documents, not one per page. `fn` must not write to the database.
   */
  private forEachIssuedBetween(from: IsoDate, to: IsoDate, basis: DateBasis, fn: (inv: Invoice) => void): void {
    const range = basis === 'fulfillment' ? { fulfillmentDateFrom: from, fulfillmentDateTo: to } : { issueDateFrom: from, issueDateTo: to };
    this.store.forEachInvoice({ status: ['issued', 'cancelled'], documentType: ['invoice', 'advance', 'final', 'modification', 'storno'], ...range, sort: 'issued_asc' }, fn);
  }

  /**
   * Receivables today (report): the counts are the documents something is owed on – what invoice_list
   * lists as unpaid ({ receivable, paymentStatus }) and as overdue ({ overdueOn }), every one of them,
   * however many; the amounts are what is outstanding on them in HUF at each document's own rate, settled
   * with their invoice chain (settleChain: open credit notes set off, overpayments carried over – never
   * below 0), so a document is counted exactly when something is open on it. HUF amounts have at most 2
   * decimals (hufOpen): a foreign-currency document nothing of which is settled counts with its own HUF
   * gross, a partly settled one with its open part at its rate, rounded to 0.01 Ft.
   */
  private receivables(): ReportResult['receivables'] {
    const today = this.today();
    // Issued modifications by original: the chains whose documents are settled together.
    const modifications = new Map<string, Invoice[]>();
    this.store.forEachInvoice({ status: ['issued'], documentType: ['modification'], sort: 'issued_asc' }, (m) => {
      const key = m.reference?.originalInvoiceId;
      if (!key) return;
      const mods = modifications.get(key);
      if (mods) mods.push(m);
      else modifications.set(key, [m]);
    });
    const settled = new Map<string, Map<string, Settlement> | null>();
    const openOf = (i: Invoice): DecValue => {
      const key = i.reference?.originalInvoiceId ?? i.id;
      const mods = modifications.get(key);
      if (mods) {
        if (!settled.has(key)) {
          const original = key === i.id ? i : this.store.getInvoice(key);
          settled.set(key, original ? this.settlement([original, ...mods]) : null);
        }
        const s = settled.get(key)?.get(i.id);
        if (s) return dec(s.open);
      }
      const open = dec(i.totals.payableAmount).minus(i.paidAmount);
      return open.gt(0) ? open : dec(0);
    };
    const unpaid = { count: 0, huf: dec(0) };
    const overdue = { count: 0, huf: dec(0) };
    this.store.forEachInvoice({ receivable: true, paymentStatus: ['unpaid', 'partial'], sort: 'issued_asc' }, (i) => {
      const huf = hufOpen(i, openOf(i));
      unpaid.count++;
      unpaid.huf = unpaid.huf.plus(huf);
      // The overdueOn filter: a receivable not fully paid, due before today.
      if (i.dueDate !== null && i.dueDate < today) {
        overdue.count++;
        overdue.huf = overdue.huf.plus(huf);
      }
    });
    const total = (x: DecValue): string => toDec(roundDec(x, 2));
    return { unpaidCount: unpaid.count, unpaidGrossHuf: total(unpaid.huf), overdueCount: overdue.count, overdueGrossHuf: total(overdue.huf) };
  }

  /** CASH_ACCOUNTING_VAT_NOTE when the seller – or the seller of any of `invoices` – accounts on a cash basis. */
  private cashAccountingNotes(invoices: readonly Invoice[]): string[] {
    return this.getSeller()?.cashAccounting === true || invoices.some((i) => i.seller.cashAccounting === true) ? [CASH_ACCOUNTING_VAT_NOTE] : [];
  }

  /**
   * Note of a report or export (either date basis) when `invoices` include a document of an invoice chain
   * whose current fulfilment date (chainFulfillmentDate: a modification corrected it) differs from the
   * original's. Every document counts in the period of its own fulfilment date: the original stays in its
   * period, the correcting modification and the later corrections and stornos (made with the corrected
   * date) count in the corrected one. Whether the original period needs a self-revision is the accountant's call.
   */
  private fulfillmentCorrectionNotes(invoices: readonly Invoice[]): string[] {
    if (!invoices.length) return [];
    const selected = new Map(invoices.map((i) => [i.id, i] as const));
    const chains = new Set(invoices.map((i) => i.reference?.originalInvoiceId ?? i.id));
    const modifications = new Map<string, Invoice[]>();
    this.store.forEachInvoice({ status: ['issued', 'cancelled'], documentType: ['modification'], sort: 'issued_asc' }, (m) => {
      const key = m.reference?.originalInvoiceId;
      if (key && chains.has(key)) modifications.set(key, [...(modifications.get(key) ?? []), m]);
    });
    const corrected: string[] = [];
    for (const [key, mods] of modifications) {
      const original = selected.get(key) ?? this.store.getInvoice(key);
      if (!original) continue;
      const current = chainFulfillmentDate(original, mods);
      if (current.date === original.fulfillmentDate) continue;
      corrected.push(`a(z) ${original.number} számla teljesítési dátumát a(z) ${current.source.number} módosító számla javította (${formatDate(original.fulfillmentDate)} → ${formatDate(current.date)})`);
    }
    if (!corrected.length) return [];
    const MAX = 10;
    const more = corrected.length > MAX ? ` (és további ${corrected.length - MAX} számlánál)` : '';
    return [
      `Teljesítési dátum javítása: ${corrected.slice(0, MAX).join('; ')}${more}. A teljesítés dátuma szerinti válogatásban minden bizonylat a saját teljesítési dátuma szerinti időszakba kerül: ` +
        'az eredeti számla az eredeti dátum időszakában marad, a dátumot javító módosító számla és az utána kiállított módosító és sztornó számlák a javított dátum időszakában számítanak. ' +
        'Hogy az eredeti időszakot önellenőrzéssel kell-e helyesbíteni, a könyvelő dönti el.',
    ];
  }

  /**
   * The parts of the payments dated in [from, to] that documents (not díjbekérők) received – a payment's allocation to
   * each document, its rows added up, non-zero only –, by payment date then recording order; `cashAccounting`: the
   * document was issued under cash accounting (its VAT counts by payment date).
   */
  private paymentParts(from: IsoDate, to: IsoDate): Array<{ payment: Payment; invoice: Invoice; amount: DecValue; cashAccounting: boolean }> {
    const { payments, allocations } = this.store.paymentsBetween(from, to);
    const parts = new Map<number, Map<string, DecValue>>();
    for (const a of allocations) {
      const of = parts.get(a.paymentId) ?? new Map<string, DecValue>();
      of.set(a.invoiceId, (of.get(a.invoiceId) ?? dec(0)).plus(a.amount));
      parts.set(a.paymentId, of);
    }
    const docs = new Map<string, Invoice | null>();
    const doc = (id: string): Invoice | null => {
      if (!docs.has(id)) docs.set(id, this.store.getInvoice(id));
      return docs.get(id) ?? null;
    };
    const out: Array<{ payment: Payment; invoice: Invoice; amount: DecValue; cashAccounting: boolean }> = [];
    for (const payment of payments) {
      for (const [id, amount] of parts.get(payment.id) ?? []) {
        const invoice = doc(id);
        if (amount.isZero() || !invoice || invoice.status === 'draft' || invoice.documentType === 'proforma') continue;
        out.push({ payment, invoice, amount, cashAccounting: issuedUnderCashAccounting(invoice) });
      }
    }
    return out;
  }

  /** The notes of the payment date basis: PAYMENT_BASIS_NOTE, and how many documents paid in the period it leaves out. */
  private paymentBasisNotes(parts: ReadonlyArray<{ invoice: Invoice; cashAccounting: boolean }>): string[] {
    const others = new Set(parts.filter((p) => !p.cashAccounting).map((p) => p.invoice.id)).size;
    if (others === 0) return [PAYMENT_BASIS_NOTE];
    return [
      PAYMENT_BASIS_NOTE,
      `Az időszakban további ${others} bizonylatra érkezett befizetés, de azokat nem pénzforgalmi elszámolással állították ki (pl. fordítottan adózó, adómentes vagy Közösségen belüli ügylet, ` +
        'vagy az eladó a kiállításkor nem volt pénzforgalmi elszámolású): ezek ÁFA-ja nem a befizetéshez kötődik, ezért itt nem szerepelnek.',
    ];
  }

  /** The documents issued under cash accounting that received a payment of the period, in issue order (each once). */
  private paidInPeriod(parts: ReadonlyArray<{ invoice: Invoice; cashAccounting: boolean }>): Invoice[] {
    const docs = new Map<string, Invoice>();
    for (const p of parts) if (p.cashAccounting) docs.set(p.invoice.id, p.invoice);
    const key = (i: Invoice): string[] => [i.issueDate, i.issuedAt ?? '', i.createdAt, i.number ?? '', i.id];
    return [...docs.values()].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let n = 0; n < x.length; n++) if (x[n] !== y[n]) return (x[n] as string) < (y[n] as string) ? -1 : 1;
      return 0;
    });
  }

  /**
   * report() on the payment date basis (pénzforgalmi elszámolás, Áfa tv. 196/B. §): the payments (and refunds) dated in the
   * period on the documents issued under cash accounting, each part with its proportional HUF net, VAT and gross
   * (allocationShare) – by VAT code, by month of the payment date and by buyer. invoiceCount: the documents, paymentCount:
   * the payments counted.
   */
  private paymentReport(from: IsoDate, to: IsoDate): ReportResult {
    const parts = this.paymentParts(from, to);
    const counted = parts.filter((p) => p.cashAccounting);
    const zero = (): { net: DecValue; vat: DecValue; gross: DecValue } => ({ net: dec(0), vat: dec(0), gross: dec(0) });
    const add = (to: { net: DecValue; vat: DecValue; gross: DecValue }, s: { net: DecValue; vat: DecValue; gross: DecValue }): void => {
      to.net = to.net.plus(s.net);
      to.vat = to.vat.plus(s.vat);
      to.gross = to.gross.plus(s.gross);
    };
    const totals = zero();
    const byVat = new Map<VatCode, { net: DecValue; vat: DecValue; gross: DecValue }>();
    const byMonth = new Map<string, { docs: Set<string>; sums: { net: DecValue; vat: DecValue; gross: DecValue } }>();
    const byCustomer = new Map<string, { name: string; taxNumber: string | null; docs: Set<string>; gross: DecValue }>();
    for (const p of counted) {
      const share = allocationShare(p.invoice, p.amount);
      add(totals, share);
      for (const r of share.byVat) {
        const e = byVat.get(r.vatCode) ?? zero();
        add(e, r);
        byVat.set(r.vatCode, e);
      }
      const month = p.payment.date.slice(0, 7);
      const m = byMonth.get(month) ?? { docs: new Set<string>(), sums: zero() };
      m.docs.add(p.invoice.id);
      add(m.sums, share);
      byMonth.set(month, m);
      const key = p.invoice.customerId ?? p.invoice.customer.taxNumber ?? p.invoice.customer.name;
      const c = byCustomer.get(key) ?? { name: p.invoice.customer.name, taxNumber: p.invoice.customer.taxNumber ?? null, docs: new Set<string>(), gross: dec(0) };
      c.docs.add(p.invoice.id);
      c.gross = c.gross.plus(share.gross);
      byCustomer.set(key, c);
    }
    const s = (x: { net: DecValue; vat: DecValue; gross: DecValue }): { net: string; vat: string; gross: string } => ({ net: toDec(x.net), vat: toDec(x.vat), gross: toDec(x.gross) });
    return {
      from,
      to,
      dateBasis: 'payment',
      invoiceCount: new Set(counted.map((p) => p.invoice.id)).size,
      paymentCount: new Set(counted.map((p) => p.payment.id)).size,
      totalsHuf: s(totals),
      byVatCode: [...byVat.entries()].map(([vatCode, e]) => ({ vatCode, ...s(e) })),
      byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, e]) => ({ month, count: e.docs.size, ...s(e.sums) })),
      topCustomers: [...byCustomer.values()]
        .map((c) => ({ name: c.name, taxNumber: c.taxNumber, count: c.docs.size, gross: toDec(c.gross) }))
        .sort((a, b) => dec(b.gross).comparedTo(dec(a.gross)))
        .slice(0, 10),
      receivables: this.receivables(),
      notes: this.paymentBasisNotes(parts),
    };
  }

  /**
   * The payment ledger of a period: every payment dated in [from, to] (both days inclusive) – on díjbekérők too –, by
   * payment date then recording order, with what it brought to each document of its chain and the proportional HUF figures
   * of each part (allocationShare). `cashAccounting` tells which parts count by payment date (dateBasis 'payment').
   */
  paymentLedger(q: { from: IsoDate; to: IsoDate }): LedgerEntry[] {
    const from = assertIsoDate(q.from, 'from');
    const to = assertIsoDate(q.to, 'to');
    assertPeriod(from, to);
    const { payments, allocations } = this.store.paymentsBetween(from, to);
    const parts = new Map<number, Map<string, DecValue>>();
    for (const a of allocations) {
      const of = parts.get(a.paymentId) ?? new Map<string, DecValue>();
      of.set(a.invoiceId, (of.get(a.invoiceId) ?? dec(0)).plus(a.amount));
      parts.set(a.paymentId, of);
    }
    const docs = new Map<string, Invoice | null>();
    const doc = (id: string): Invoice | null => {
      if (!docs.has(id)) docs.set(id, this.store.getInvoice(id));
      return docs.get(id) ?? null;
    };
    return payments.map((p) => {
      const on = doc(p.invoiceId);
      const allocated: LedgerEntry['allocations'] = [];
      for (const [id, amount] of parts.get(p.id) ?? []) {
        const inv = doc(id);
        if (!inv || amount.isZero()) continue;
        const share = allocationShare(inv, amount);
        allocated.push({
          invoice: { id: inv.id, number: inv.number, documentType: inv.documentType, status: inv.status },
          amount: toDec(amount),
          exchangeRate: inv.exchangeRate,
          cashAccounting: inv.documentType !== 'proforma' && issuedUnderCashAccounting(inv),
          huf: { net: toDec(share.net), vat: toDec(share.vat), gross: toDec(share.gross) },
          byVatCode: share.byVat.map((r) => ({ vatCode: r.vatCode, net: toDec(r.net), vat: toDec(r.vat), gross: toDec(r.gross) })),
        });
      }
      return {
        id: p.id,
        date: p.date,
        amount: p.amount,
        currency: on?.currency ?? '',
        kind: paymentKind(dec(p.amount), dec(on?.totals.payableAmount ?? '0')),
        source: p.source,
        reference: p.reference,
        recordedOn: { id: p.invoiceId, number: on?.number ?? null, documentType: on?.documentType ?? 'invoice' },
        recordedAt: p.createdAt,
        allocations: allocated,
      };
    });
  }

  /** exportInvoices with `ledger`: the payment ledger of the period (paymentLedger) as befizetesek_<from>_<to>.csv / .json. */
  private exportPaymentLedger(
    from: IsoDate,
    to: IsoDate,
    format: 'csv' | 'json' | 'xml',
    dateBasis: string | undefined,
    actor: Actor | undefined,
  ): { path: string; count: number; from: IsoDate; to: IsoDate; dateBasis: DateBasis; ledger: boolean; warnings: Szamla2013Warning[]; notes: string[] } {
    if (format === 'xml') throw new AppError('INVALID_INPUT', 'A befizetési napló CSV vagy JSON formátumban exportálható.', { hint: 'Add meg a "csv" vagy a "json" formátumot.' });
    if (dateBasis !== undefined && dateBasis !== 'payment') {
      throw new AppError('INVALID_INPUT', 'A befizetési napló a befizetés dátuma szerint készül: más dátumalap nem adható meg hozzá.', { hint: 'Hagyd el a dátumalapot, vagy add meg a "payment" értéket.' });
    }
    const entries = this.paymentLedger({ from, to });
    mkdirSync(this.config.exportDir, { recursive: true });
    const path = join(this.config.exportDir, `befizetesek_${from}_${to}.${format}`);
    if (format === 'json') {
      writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8');
    } else {
      const num = (v: string): string => v.replace('.', ',');
      const header = ['Befizetés dátuma', 'Befizetés azonosítója', 'Fajta', 'Forrás', 'Díjbekérő', 'Rögzítve a bizonylaton', 'Összeg', 'Pénznem', 'Bizonylat', 'Bizonylat típusa', 'Jutó összeg', 'Árfolyam', 'Nettó (HUF)', 'ÁFA (HUF)', 'Bruttó (HUF)', 'Pénzforgalmi elszámolás'];
      const rows: string[] = [];
      for (const e of entries) {
        const head = [e.date, String(e.id), PAYMENT_KIND_TEXT[e.kind], PAYMENT_SOURCE_TEXT[e.source], e.reference ?? '', e.recordedOn.number ?? e.recordedOn.id, num(e.amount), e.currency];
        if (e.allocations.length === 0) rows.push([...head, '', '', '', '', '', '', '', ''].map((v) => ledgerCell(v)).join(';'));
        for (const a of e.allocations) {
          rows.push(
            [...head, a.invoice.number ?? a.invoice.id, DOCUMENT_TYPE_NAME[a.invoice.documentType], num(a.amount), num(a.exchangeRate), num(a.huf.net), num(a.huf.vat), num(a.huf.gross), a.cashAccounting ? 'igen' : 'nem']
              .map((v) => ledgerCell(v))
              .join(';'),
          );
        }
      }
      writeFileSync(path, `﻿${[header.join(';'), ...rows].join('\r\n')}\r\n`, 'utf8');
    }
    this.audit('export', 'invoice', null, { from, to, dateBasis: 'payment', format, count: entries.length, ledger: true }, actor);
    return {
      path,
      count: entries.length,
      from,
      to,
      dateBasis: 'payment',
      ledger: true,
      warnings: [],
      notes: [
        'Befizetési napló: az időszak minden befizetése, visszafizetése és visszavonása (a díjbekérőké is), a befizetés dátuma szerint, azzal, hogy melyik bizonylatra mennyi jutott belőle. ' +
          'A pénzforgalmi elszámolás szerinti ÁFA-hoz csak a pénzforgalmi elszámolással kiállított bizonylatokra jutó részek számítanak.',
        PAYMENT_BASIS_NOTE,
      ],
    };
  }

  /**
   * Revenue and VAT of a period – the invoices whose issue date (dateBasis 'issue', default) or
   * fulfilment date ('fulfillment': the VAT tax point) is in [from, to] – and today's receivables. On the
   * payment date basis ('payment') the payments of the period instead (paymentReport).
   */
  report(q: { from: IsoDate; to: IsoDate; dateBasis?: DateBasis }): ReportResult {
    const from = assertIsoDate(q.from, 'from');
    const to = assertIsoDate(q.to, 'to');
    assertPeriod(from, to);
    const dateBasis = dateBasisOf(q.dateBasis);
    if (dateBasis === 'payment') return this.paymentReport(from, to);
    const invoices = this.allIssuedBetween(from, to, dateBasis);
    const byVat = new Map<VatCode, { net: string[]; vat: string[]; gross: string[] }>();
    const byMonth = new Map<string, { count: number; net: string[]; vat: string[]; gross: string[] }>();
    const byCustomer = new Map<string, { name: string; taxNumber: string | null; count: number; gross: string[] }>();
    for (const inv of invoices) {
      for (const row of inv.totals.byVat) {
        const e = byVat.get(row.vatCode) ?? { net: [], vat: [], gross: [] };
        e.net.push(row.netAmountHuf); e.vat.push(row.vatAmountHuf); e.gross.push(row.grossAmountHuf);
        byVat.set(row.vatCode, e);
      }
      const month = (dateBasis === 'fulfillment' ? inv.fulfillmentDate : inv.issueDate).slice(0, 7);
      const m = byMonth.get(month) ?? { count: 0, net: [], vat: [], gross: [] };
      m.count++; m.net.push(inv.totals.netAmountHuf); m.vat.push(inv.totals.vatAmountHuf); m.gross.push(inv.totals.grossAmountHuf);
      byMonth.set(month, m);
      const key = inv.customerId ?? inv.customer.taxNumber ?? inv.customer.name;
      const c = byCustomer.get(key) ?? { name: inv.customer.name, taxNumber: inv.customer.taxNumber ?? null, count: 0, gross: [] };
      c.count++; c.gross.push(inv.totals.grossAmountHuf);
      byCustomer.set(key, c);
    }
    const s = (xs: string[]): string => toDec(sumDec(xs));
    return {
      from, to, dateBasis,
      invoiceCount: invoices.length,
      totalsHuf: {
        net: s(invoices.map((i) => i.totals.netAmountHuf)),
        vat: s(invoices.map((i) => i.totals.vatAmountHuf)),
        gross: s(invoices.map((i) => i.totals.grossAmountHuf)),
      },
      byVatCode: [...byVat.entries()].map(([vatCode, e]) => ({ vatCode, net: s(e.net), vat: s(e.vat), gross: s(e.gross) })),
      byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, e]) => ({ month, count: e.count, net: s(e.net), vat: s(e.vat), gross: s(e.gross) })),
      topCustomers: [...byCustomer.values()]
        .map((c) => ({ name: c.name, taxNumber: c.taxNumber, count: c.count, gross: s(c.gross) }))
        .sort((a, b) => dec(b.gross).comparedTo(dec(a.gross)))
        .slice(0, 10),
      receivables: this.receivables(),
      notes: [...this.cashAccountingNotes(invoices), ...this.fulfillmentCorrectionNotes(invoices)],
    };
  }

  /**
   * Exports issued invoices of a period (by issue date, or by fulfilment date with dateBasis
   * 'fulfillment'): CSV (Excel-friendly, HU), JSON, or NAV invoiceData XML files. `count` is the number
   * of exported invoices; an invoice whose NAV XML cannot be built is left out of the XML export (one
   * broken document does not abort it) and named in `warnings`, as is an XML file whose name had to be
   * extended (see fileStems). `notes`: warnings about the export as a whole (CASH_ACCOUNTING_VAT_NOTE).
   * dateBasis 'payment': the documents issued under cash accounting that received a payment dated in the period.
   * `ledger`: the payment ledger of the period instead (exportPaymentLedger; CSV or JSON).
   */
  exportInvoices(
    q: { from: IsoDate; to: IsoDate; format: 'csv' | 'json' | 'xml'; dateBasis?: DateBasis; ledger?: boolean },
    actor?: Actor,
  ): { path: string; count: number; from: IsoDate; to: IsoDate; dateBasis: DateBasis; ledger: boolean; warnings: Szamla2013Warning[]; notes: string[] } {
    const from = assertIsoDate(q.from, 'from');
    const to = assertIsoDate(q.to, 'to');
    assertPeriod(from, to);
    // A mistyped format ("cvs", "xlsx") must not silently give another one.
    if (!(['csv', 'json', 'xml'] as readonly string[]).includes(q.format as string)) {
      throw new AppError('INVALID_INPUT', `Ismeretlen exportformátum: ${String(q.format)}`, { hint: 'A formátum csv, json vagy xml lehet (a befizetési naplóé csv vagy json).' });
    }
    const dateBasis = dateBasisOf(q.dateBasis);
    if (q.ledger === true) return this.exportPaymentLedger(from, to, q.format, q.dateBasis, actor);
    const parts = dateBasis === 'payment' ? this.paymentParts(from, to) : null;
    const invoices = parts ? this.paidInPeriod(parts) : this.allIssuedBetween(from, to, dateBasis);
    mkdirSync(this.config.exportDir, { recursive: true });
    const stem = dateBasis === 'fulfillment' ? `szamlak_teljesites_${from}_${to}` : dateBasis === 'payment' ? `szamlak_befizetes_${from}_${to}` : `szamlak_${from}_${to}`;
    const warnings: Szamla2013Warning[] = [];
    let count = invoices.length;
    let path: string;
    if (q.format === 'json') {
      path = join(this.config.exportDir, `${stem}.json`);
      writeFileSync(path, JSON.stringify(invoices, null, 2), 'utf8');
    } else if (q.format === 'xml') {
      path = join(this.config.exportDir, `${stem}_nav-xml`);
      mkdirSync(path, { recursive: true });
      count = 0;
      const files = this.fileStems(invoices);
      for (const inv of invoices) {
        let xml: string;
        try {
          xml = buildInvoiceDataXml(inv);
        } catch (e) {
          warnings.push({ invoiceNumber: inv.number ?? inv.id, field: 'nav-xml', message: `A számla kimaradt: a NAV Online Számla XML nem állítható elő: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        const file = files.get(inv.id) as string;
        writeFileSync(join(path, `${file}.xml`), xml, 'utf8');
        if (file !== safeFileName(inv.number as string)) warnings.push(renamedFile(inv, file));
        count++;
      }
    } else {
      path = join(this.config.exportDir, `${stem}.csv`);
      // A text cell a spreadsheet would read as a formula (= + - @, tab, CR) gets a leading apostrophe
      // (CSV injection); amounts come from num() and stay numeric.
      const cell = (v: string | null | undefined): string => {
        let s = v ?? '';
        if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = `'${s}`;
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const num = (v: string): string => v.replace('.', ',');
      const header = ['Sorszám', 'Típus', 'Állapot', 'Kelt', 'Teljesítés', 'Fizetési határidő', 'Vevő', 'Vevő adószáma', 'Pénznem', 'Árfolyam', 'Nettó', 'ÁFA', 'Bruttó', 'Nettó (HUF)', 'ÁFA (HUF)', 'Bruttó (HUF)', 'Fizetési mód', 'Fizetési állapot', 'NAV állapot', 'Eredeti számla'];
      const rows = invoices.map((i) => [
        // In words, as the web UI names them (core/names.ts): an accountant reads this file; the JSON export keeps the codes.
        i.number, DOCUMENT_TYPE_NAME[i.documentType], invoiceStatusName(i), i.issueDate, i.fulfillmentDate, i.dueDate, i.customer.name, i.customer.taxNumber ?? i.customer.euVatNumber ?? '',
        i.currency, num(i.exchangeRate), num(i.totals.netAmount), num(i.totals.vatAmount), num(i.totals.grossAmount),
        num(i.totals.netAmountHuf), num(i.totals.vatAmountHuf), num(i.totals.grossAmountHuf), PAYMENT_METHOD_NAME[i.paymentMethod], PAYMENT_STATUS_NAME[i.paymentStatus], NAV_STATUS_NAME[i.navStatus],
        i.reference?.originalInvoiceNumber ?? '',
      ].map((v) => cell(v)).join(';'));
      writeFileSync(path, `﻿${[header.join(';'), ...rows].join('\r\n')}\r\n`, 'utf8');
    }
    const skipped = warnings.filter((w) => w.field === 'nav-xml').map((w) => w.invoiceNumber);
    this.audit('export', 'invoice', null, { from, to, dateBasis, format: q.format, count, ...(skipped.length ? { skipped } : {}) }, actor);
    const notes = parts ? this.paymentBasisNotes(parts) : [...this.cashAccountingNotes(invoices), ...this.fulfillmentCorrectionNotes(invoices)];
    return { path, count, from, to, dateBasis, ledger: false, warnings, notes };
  }

  /**
   * „Adóhatósági ellenőrzési adatszolgáltatás” (23/2014. NGM rendelet 8. § (1) c), 11/A. §, 19. §):
   * exports the invoices issued in a date range, or in a range of invoice numbers of one series, into a
   * new folder: szamlak.xml (3. melléklet XSD), nav-osa/<sorszám>.xml (NAV Online Számla invoiceData),
   * pdf/<sorszám>.pdf – the kept original, byte for byte (a document issued before originals were kept:
   * pdf/<sorszám>_UJRAELOALLITOTT.pdf, regenerated, named in the warnings) – and OLVASSEL.txt. A PDF that has to
   * be rendered (regenerated, or an original not kept yet) is rendered while the next documents are written, at
   * most PDF_RENDER_CONCURRENCY at a time. `onProgress` (awaited): the documents done out of all, at the start
   * (0), after each document and at the end – a long export can report its progress (MCP notifications/progress).
   */
  async taxAuditExport(
    q: { from?: IsoDate; to?: IsoDate; fromNumber?: string; toNumber?: string },
    actor?: Actor,
    opts: { onProgress?: (done: number, total: number) => void | Promise<void> } = {},
  ): Promise<{ path: string; count: number; rangeFrom: string; rangeTo: string; numberFrom: string; numberTo: string; warnings: Szamla2013Warning[] }> {
    let invoices: Invoice[];
    /** The numbers of the range boundaries – fromNumber / toNumber may also be given as invoice ids. */
    let numbers: { from: string; to: string } | null = null;
    const byNumber = !!(q.fromNumber || q.toNumber);
    if (byNumber) {
      if (!q.fromNumber || !q.toNumber) throw new AppError('INVALID_INPUT', 'Sorszámtartománynál a kezdő és a záró sorszám is kötelező.');
      const first = this.getInvoice(q.fromNumber);
      const last = this.getInvoice(q.toNumber);
      if (first.status === 'draft' || last.status === 'draft' || first.documentType === 'proforma' || last.documentType === 'proforma') {
        throw new AppError('INVALID_INPUT', 'A sorszámtartomány határa csak kiállított számla lehet (piszkozat és díjbekérő nem).');
      }
      if (first.seriesId !== last.seriesId) {
        throw new AppError('INVALID_INPUT', 'A kezdő és a záró sorszám különböző sorszámtartományba tartozik.', { hint: 'Sorszámtartományonként külön exportálj, vagy használj dátumtartományt.' });
      }
      // Same order as the export itself: issue date, issuance time, then the number (natural order). One query, and
      // only the documents of this series are kept.
      const ofSeries: Invoice[] = [];
      this.forEachIssuedBetween('2000-01-01', '9999-12-31', 'issue', (i) => {
        if (i.seriesId === first.seriesId) ofSeries.push(i);
      });
      const series = ofSeries
        .sort((x, y) => x.issueDate.localeCompare(y.issueDate) || (x.issuedAt ?? '').localeCompare(y.issuedAt ?? '') || (x.number ?? '').localeCompare(y.number ?? '', 'en', { numeric: true }));
      const a = series.findIndex((i) => i.id === first.id);
      const b = series.findIndex((i) => i.id === last.id);
      if (a < 0 || b < 0 || a > b) {
        throw new AppError('INVALID_INPUT', 'A kezdő sorszám nem előzi meg a záró sorszámot.', {
          hint: 'A kezdő sorszám (fromNumber) a záró sorszám (toNumber) előtt vagy azzal azonos legyen – a két sorszám valószínűleg felcserélődött.',
        });
      }
      invoices = series.slice(a, b + 1);
      numbers = { from: first.number as string, to: last.number as string };
    } else {
      if (!q.from || !q.to) throw new AppError('INVALID_INPUT', 'Add meg az időszakot (from, to) vagy a sorszámtartományt (fromNumber, toNumber).');
      const from = assertIsoDate(q.from, 'from');
      const to = assertIsoDate(q.to, 'to');
      assertPeriod(from, to);
      invoices = this.allIssuedBetween(from, to);
    }
    if (!invoices.length) throw new AppError('NO_INVOICES', 'A megadott tartományban nincs kiállított számla.', { hint: 'Ellenőrizd a dátumokat, illetve a sorszámokat.' });
    const total = invoices.length;
    let done = 0;
    const progress = async (): Promise<void> => {
      try {
        await opts.onProgress?.(done, total);
      } catch {
        // a progress report that cannot be delivered never stops the export
      }
    };
    await progress();

    const meta = numbers
      ? { exportDate: this.today(), numberFrom: numbers.from, numberTo: numbers.to }
      : { exportDate: this.today(), rangeFrom: q.from as string, rangeTo: q.to as string };
    const exp = buildSzamla2013Export(invoices, meta);
    const warnings: Szamla2013Warning[] = [...exp.warnings];
    const stamp = this.ts().replace(/[-:]/g, '').replace(/\..*$/, '');
    const range = byNumber ? `${exp.numberFrom}_${exp.numberTo}` : `${exp.rangeFrom}_${exp.rangeTo}`;
    const dir = join(this.config.exportDir, safeFileName(`adohatosagi-ellenorzes_${range}_${stamp}`));
    mkdirSync(join(dir, 'nav-osa'), { recursive: true });
    mkdirSync(join(dir, 'pdf'), { recursive: true });
    writeFileSync(join(dir, 'szamlak.xml'), exp.xml, 'utf8');
    // Every part is produced per invoice: one document that cannot be represented is named in the
    // warnings (and OLVASSEL.txt) instead of aborting the statutory export. So is a file whose name had
    // to be extended because another document's number gives the same file name.
    const files = this.fileStems(invoices);
    /** Per document (in the order of `invoices`): its warnings, and whether its PDF in the export is regenerated. */
    const perDocument = invoices.map(() => ({ warnings: [] as Szamla2013Warning[], regenerated: false }));
    /**
     * The PDF of `inv` into pdf/: the kept original, byte for byte; else rendered (and kept, unless it is a legacy
     * document). An original that fails its fingerprints is not copied: a warning names it.
     */
    const pdfOf = async (inv: Invoice, name: string, own: (typeof perDocument)[number]): Promise<void> => {
      try {
        // The PDF as it was handed over (kept when issued); never re-rendered.
        const original = await this.originalDocument(inv, actor);
        if (original) {
          writeFileSync(join(dir, 'pdf', `${name}.pdf`), original.doc.content);
          // Kept just now: another file at the data folder's pdf/<name>.pdf is kept before a PDF request overwrites it.
          const aside = original.kept ? this.keepPreviousPdf(inv, join(this.config.pdfDir, `${name}.pdf`), original.doc.content, actor) : null;
          if (aside) own.warnings.push({ invoiceNumber: inv.number as string, field: 'pdf', message: aside.note });
        } else {
          const file = `${name}${REGENERATED_PDF_SUFFIX}.pdf`;
          writeFileSync(join(dir, 'pdf', file), await renderInvoicePdf(inv, { softwareName: this.pdfSoftware() }));
          own.regenerated = true;
          own.warnings.push({
            invoiceNumber: inv.number as string,
            field: 'pdf',
            message: `Az eredeti PDF nincs megőrizve, mert a bizonylat az eredeti PDF-ek megőrzése előtt készült: a pdf/${file} a program jelenlegi változatával újra előállított kép, nem bájtra azonos a vevőnek átadott PDF-fel.`,
          });
        }
      } catch (e) {
        const message = isAppError(e) && e.code === 'DOCUMENT_INTEGRITY_FAILED'
          ? `Az export nem tartalmazza a PDF-jét: ${e.message} ${e.hint ?? ''}`.trim()
          : `A PDF nem állítható elő: ${e instanceof Error ? e.message : String(e)}`;
        own.warnings.push({ invoiceNumber: inv.number as string, field: 'pdf', message });
      }
      done++;
      await progress();
    };
    /** PDF steps under way: a rendered PDF takes ~25 ms, so up to PDF_RENDER_CONCURRENCY of them overlap. */
    const pending = new Set<Promise<void>>();
    for (const [k, inv] of invoices.entries()) {
      const own = perDocument[k] as (typeof perDocument)[number];
      const name = files.get(inv.id) as string;
      if (name !== safeFileName(inv.number as string)) own.warnings.push(renamedFile(inv, name));
      try {
        writeFileSync(join(dir, 'nav-osa', `${name}.xml`), buildInvoiceDataXml(inv), 'utf8');
      } catch (e) {
        own.warnings.push({ invoiceNumber: inv.number as string, field: 'nav-osa', message: `A NAV Online Számla XML nem állítható elő: ${e instanceof Error ? e.message : String(e)}` });
      }
      const step = pdfOf(inv, name, own).finally(() => pending.delete(step));
      pending.add(step);
      if (pending.size >= PDF_RENDER_CONCURRENCY) await Promise.race(pending);
    }
    await Promise.all(pending);
    /** Documents issued before originals were kept: their PDF in the export is regenerated. */
    const regenerated: string[] = [];
    for (const [k, inv] of invoices.entries()) {
      const own = perDocument[k] as (typeof perDocument)[number];
      warnings.push(...own.warnings);
      if (own.regenerated) regenerated.push(inv.number as string);
    }
    const seller = this.getSeller();
    const readme = [
      'Adóhatósági ellenőrzési adatszolgáltatás (23/2014. (VI. 30.) NGM rendelet 11/A. §)',
      '',
      `Adózó: ${seller?.name ?? '-'} (${seller?.taxNumber ?? '-'})`,
      `Program: ${this.config.software.softwareName} ${VERSION} (azonosító: ${this.config.software.softwareId})`,
      `Export napja: ${meta.exportDate}`,
      byNumber ? `Sorszámtartomány: ${exp.numberFrom} – ${exp.numberTo}` : `Időszak: ${exp.rangeFrom} – ${exp.rangeTo}`,
      `Számlák száma: ${exp.invoiceCount}`,
      '',
      'Tartalom:',
      '  szamlak.xml   – a rendelet 3. melléklete szerinti adatszerkezetben (http://schemas.nav.gov.hu/2013/szamla)',
      '  nav-osa/      – számlánként a NAV Online Számla v3.0 invoiceData XML',
      '  pdf/          – a számlák PDF-je: a kiállításkor készült, bájtra pontosan megőrzött eredeti',
      ...(regenerated.length
        ? [`                  (${REGENERATED_PDF_SUFFIX}.pdf végű fájl: az eredeti PDF-ek megőrzése előtt kiállított bizonylat újra előállított képe, lásd a megjegyzéseket)`]
        : []),
      ...(warnings.length ? ['', 'Megjegyzések:', ...warnings.map((w) => `  ${w.invoiceNumber} (${w.field}): ${w.message}`)] : []),
      '',
    ];
    writeFileSync(join(dir, 'OLVASSEL.txt'), readme.join('\r\n'), 'utf8');
    this.audit('export.tax_audit', 'invoice', null, { byNumber, from: exp.rangeFrom, to: exp.rangeTo, numberFrom: exp.numberFrom, numberTo: exp.numberTo, count: exp.invoiceCount, ...(regenerated.length ? { regeneratedPdf: regenerated } : {}) }, actor);
    return { path: dir, count: exp.invoiceCount, rangeFrom: exp.rangeFrom, rangeTo: exp.rangeTo, numberFrom: exp.numberFrom, numberTo: exp.numberTo, warnings };
  }

  auditLog(q: { entityId?: string; limit?: number; offset?: number } = {}): Page<AuditEntry> {
    const query: { entityId?: string; limit: number; offset: number } = { limit: q.limit ?? 50, offset: q.offset ?? 0 };
    if (q.entityId) query.entityId = q.entityId;
    return this.store.listAudit(query);
  }

  /**
   * A backup made from inside the program (the web UI's button, the backup_create tool): a consistent copy of the
   * database in <dataDir>/backups, named by the time it was made. The place is fixed – a tool or a web form never
   * chooses where a file is written; `openszamla backup <file>` writes anywhere. Returns where it is and how big.
   */
  createBackup(): { path: string; bytes: number; auditHead: { id: number; hash: string } | null } {
    const dir = join(this.config.dataDir, 'backups');
    ensureDataDir(dir, 'A mentések mappája');
    const now = this.now();
    const p = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let path = join(dir, `openszamla_${stamp}.db`);
    for (let n = 2; existsSync(path); n++) path = join(dir, `openszamla_${stamp}_${n}.db`);
    this.store.backup(path);
    return { path, bytes: statSync(path).size, auditHead: this.store.auditHead() };
  }

  /**
   * Tamper evidence (`openszamla verify`): recomputes the content hash of every issued document and the
   * audit hash chain, then cross-checks them. Every issuance logged in the chain must still be in the
   * database with the same number and content hash, every issued document must have been logged, the
   * numbers of each series must run without gaps, the protective triggers must be intact, and every kept
   * original PDF must match its fingerprints and its audit entry (documentIntegrity).
   */
  verifyIntegrity(): IntegrityReport {
    const invoiceMismatches: string[] = [];
    const issued = new Map<string, Pick<Invoice, 'number' | 'contentHash' | 'seriesId'>>();
    const paid = new Map<string, { number: string | null; amount: string; currency: string }>();
    // One query over every issued document, one document at a time (only these few fields are kept).
    this.store.forEachInvoice({ status: ['issued', 'cancelled'], sort: 'issued_asc' }, (inv) => {
      issued.set(inv.id, { number: inv.number, contentHash: inv.contentHash, seriesId: inv.seriesId });
      paid.set(inv.id, { number: inv.number, amount: inv.paidAmount, currency: inv.currency });
      if (inv.contentHash !== invoiceContentHash(inv)) invoiceMismatches.push(inv.number ?? inv.id);
    });
    const issuances = this.store.listAuditByAction('invoice.issue');
    const auditMismatches: string[] = [];
    const logged = new Set<string>();
    for (const e of issuances) {
      const number = typeof e.details.number === 'string' ? e.details.number : (e.entityId ?? `#${e.id}`);
      const inv = e.entityId ? issued.get(e.entityId) : undefined;
      if (e.entityId) logged.add(e.entityId);
      if (!inv) auditMismatches.push(`${number}: a kiállítása naplózva van (#${e.id}), de a bizonylat hiányzik az adatbázisból.`);
      else if (inv.number !== number) auditMismatches.push(`${number}: az adatbázisban más sorszámmal szerepel (${inv.number ?? '–'}).`);
      else if (typeof e.details.contentHash === 'string' && e.details.contentHash !== inv.contentHash) {
        auditMismatches.push(`${number}: a tartalma eltér a kiállításkor naplózottól.`);
      }
    }
    const unauditedInvoices = [...issued].filter(([id]) => !logged.has(id)).map(([id, i]) => i.number ?? id);
    const restores = recordedRestores(this.store);
    const numberingGaps = this.numberingGaps(issuances, issued, restores);
    const alteredTriggers = this.store.findAlteredTriggers();
    const allocated = this.store.allocationTotals();
    const paymentMismatches = [...paid]
      .filter(([id, p]) => !dec(allocated.get(id) ?? '0').eq(p.amount))
      .map(([id, p]) => `${p.number ?? id}: a bizonylat befizetett összege (${formatMoney(p.amount, p.currency)}) eltér a befizetési naplóban rá jutó összegtől (${formatMoney(allocated.get(id) ?? '0', p.currency)}).`);
    const chain = this.store.verifyAuditChain();
    const documents = this.documentIntegrity(issued);
    const ok = chain.ok && [invoiceMismatches, auditMismatches, unauditedInvoices, numberingGaps, alteredTriggers, paymentMismatches, documents.mismatches].every((l) => l.length === 0);
    return {
      ok, invoicesChecked: issued.size, invoiceMismatches, auditMismatches, unauditedInvoices, numberingGaps, alteredTriggers, paymentMismatches,
      documentsChecked: documents.checked, documentMismatches: documents.mismatches, documentWarnings: documents.warnings, documentNotes: documents.notes,
      legacyDocuments: documents.legacy,
      restoreWarnings: restores.filter((r) => r.record.lostCount > 0).map((r) => {
        const lost = r.record.lost;
        const range = lost.length === 0 ? '' : lost.length === 1 ? ` (${lost[0]?.number})` : ` (${lost[0]?.number} – ${lost.at(-1)?.number}${r.record.lostCount > lost.length ? ', …' : ''})`;
        const aside = r.record.replaced ? ` A félretett adatbázisban megvannak: ${r.record.replaced.file}.` : '';
        return `${huDate(new Date(r.at))}: mentés visszaállítása (naplóbejegyzés #${r.id}) – a mentés után kiállított ${r.record.lostCount} bizonylat${range} nincs az adatbázisban.${aside}`;
      }),
      audit: { ...chain, head: this.store.auditHead() },
    };
  }

  /**
   * The kept original PDFs (verifyIntegrity). Failures: an original whose bytes no longer match its stored SHA-256,
   * SHA3-512 or size; an original without its 'invoice.document' audit entry, or whose fingerprints differ from it; an
   * entry whose original is missing. Warnings (no failure): documents issued since originals are kept that have none
   * yet – the render failed at issue, and their PDF was not asked for since. Notes: pdf/<name>.pdf of an original is
   * missing or differs (pdf() rewrites it from the original).
   */
  private documentIntegrity(issued: ReadonlyMap<string, Pick<Invoice, 'number'>>): { checked: number; mismatches: string[]; warnings: string[]; notes: string[]; legacy: number } {
    const logged = new Map<string, AuditEntry[]>();
    for (const e of this.store.listAuditByAction('invoice.document')) {
      const key = e.entityId ?? `#${e.id}`;
      logged.set(key, [...(logged.get(key) ?? []), e]);
    }
    const label = (id: string, logNumber?: unknown): string => issued.get(id)?.number ?? (typeof logNumber === 'string' ? logNumber : id);
    const stems = this.fileStems([...issued].map(([id, i]) => ({ id, number: i.number })));
    const mismatches: string[] = [];
    const notes: string[] = [];
    const kept = new Set<string>();
    let checked = 0;
    this.store.forEachDocument((d) => {
      checked++;
      kept.add(d.invoiceId);
      const name = label(d.invoiceId);
      const f = fileFingerprints(d.content);
      const failed = mismatches.length;
      if (f.sha256 !== d.sha256 || f.sha3_512 !== d.sha3_512 || f.size !== d.size) {
        mismatches.push(`${name}: a megőrzött eredeti PDF tartalma nem egyezik a vele tárolt lenyomattal (SHA-256, SHA3-512, méret).`);
      }
      // One original per document, kept once: every entry of it must name these fingerprints (another one: replaced).
      const entries = logged.get(d.invoiceId) ?? [];
      if (!entries.length) mismatches.push(`${name}: a megőrzött eredeti PDF megőrzése nincs naplózva (invoice.document).`);
      else if (entries.some((e) => e.details.sha256 !== d.sha256 || e.details.sha3_512 !== d.sha3_512 || e.details.size !== d.size)) {
        mismatches.push(`${name}: a megőrzött eredeti PDF lenyomata eltér a megőrzéskor naplózottól.`);
      }
      // A failed original is never served or written (DOCUMENT_INTEGRITY_FAILED): the pdf/ file is left as it is.
      const intact = mismatches.length === failed;
      const stem = stems.get(d.invoiceId);
      if (stem === undefined) return; // its document is missing: reported by the checks above
      const file = join(this.config.pdfDir, `${stem}.pdf`);
      let onDisk: Buffer | null = null;
      try {
        onDisk = readFileSync(file);
      } catch {
        // missing (or unreadable)
      }
      if (!intact) {
        if (onDisk === null) notes.push(`${name}: a pdf/${stem}.pdf fájl hiányzik; a sérült megőrzött eredetiből a program nem írja ki újra.`);
        else if (!onDisk.equals(d.content)) notes.push(`${name}: a pdf/${stem}.pdf fájl eltér a megőrzött eredetitől, amely sérült: a program nem írja felül vele – ha a fájl a kiállításkor átadott PDF, őrizd meg.`);
      } else if (onDisk === null) notes.push(`${name}: a pdf/${stem}.pdf fájl hiányzik – a következő PDF-kéréskor a program a megőrzött eredetiből újra kiírja.`);
      else if (!onDisk.equals(d.content)) notes.push(`${name}: a pdf/${stem}.pdf fájl eltér a megőrzött eredetitől – a következő PDF-kéréskor a program a megőrzött eredetivel felülírja.`);
    });
    for (const [id, entries] of logged) {
      if (kept.has(id)) continue;
      const first = entries[0] as AuditEntry;
      mismatches.push(`${label(id, first.details.number)}: az eredeti PDF megőrzése naplózva van (#${first.id}), de a megőrzött PDF hiányzik az adatbázisból.`);
    }
    const warnings = [...issued]
      .filter(([id]) => !kept.has(id) && !logged.has(id) && !this.store.isLegacyDocument(id))
      .map(([id, i]) => `${i.number ?? id}: nincs megőrzött eredeti PDF-je (a kiállításkor nem készült el, és azóta nem kérték le). Kérd le a PDF-jét (invoice_pdf, openszamla pdf vagy a webes „PDF letöltése”): a program akkor elkészíti és megőrzi.`);
    return { checked, mismatches, warnings, notes, legacy: this.store.countLegacyDocuments() };
  }

  /**
   * Sequence numbers missing from the number series, from the issuances logged with their sequence
   * number. The history of each series is replayed to split its numbering into periods: an issuance in a
   * later year than the series' previous one starts a new period at 1 while its yearly restart is on, and
   * continues the period while it is off. When it was switched (series_manage) the series.update entries
   * tell; the setting before the first switch was logged at creation (series.create; a built-in default
   * series restarts yearly). Each period must run without a gap from its first number (startSeq of the
   * creation; 1 after a restart) up to its last logged one – the current period up to the last number the
   * series gave out (nextSeq − 1). Series with issuances logged by older versions (without the sequence
   * number) are not checked.
   */
  private numberingGaps(issuances: readonly AuditEntry[], issued: ReadonlyMap<string, { seriesId: string }>, restores: ReadonlyArray<{ id: number; record: RestoreRecord }> = []): string[] {
    interface Logged {
      id: number;
      seq: number;
      year: number;
      number: string | null;
    }
    const bySeries = new Map<string, Logged[]>();
    const unchecked = new Set<string>();
    // Numbers given out before a backup of an earlier state was restored: not in this database, but on record in
    // the restore's audit entry – they count as issued where the numbering was continued after them.
    const entries: Array<Pick<AuditEntry, 'id' | 'entityId' | 'details'>> = [...issuances];
    for (const r of restores) {
      if (r.record.earlierState !== true) continue;
      const continuedSeries = new Set(r.record.continued.map((c) => c.seriesId));
      for (const l of r.record.lost) {
        if (l.seriesId === undefined || typeof l.seq !== 'number' || typeof l.year !== 'number' || !continuedSeries.has(l.seriesId)) continue;
        entries.push({ id: r.id, entityId: null, details: { seriesId: l.seriesId, seq: l.seq, year: l.year, number: l.number } });
      }
    }
    entries.sort((a, b) => a.id - b.id);
    for (const e of entries) {
      const { seriesId, seq, year, number } = e.details;
      if (typeof seriesId === 'string' && typeof seq === 'number' && typeof year === 'number') {
        const list = bySeries.get(seriesId) ?? [];
        list.push({ id: e.id, seq, year, number: typeof number === 'string' ? number : null });
        bySeries.set(seriesId, list);
        continue;
      }
      const inv = e.entityId ? issued.get(e.entityId) : undefined;
      if (!inv) return []; // an older issuance of an unknown series: no series can be checked reliably
      unchecked.add(inv.seriesId);
    }
    const created = new Map(this.store.listAuditByAction('series.create').map((e) => [e.entityId, e.details]));
    // Every switch of a series' yearly restart, oldest first: [audit id, the new setting].
    const switches = new Map<string, Array<[number, boolean]>>();
    for (const e of this.store.listAuditByAction('series.update')) {
      const to = (e.details.patch as { yearlyReset?: unknown } | null | undefined)?.yearlyReset;
      if (e.entityId === null || typeof to !== 'boolean') continue;
      switches.set(e.entityId, [...(switches.get(e.entityId) ?? []), [e.id, to]]);
    }
    const out: string[] = [];
    for (const s of this.store.listSeries(undefined, true)) {
      if (unchecked.has(s.id)) continue;
      const origin = created.get(s.id);
      const flips = switches.get(s.id) ?? [];
      // The setting before the first switch: never switched – the current one; else as logged at creation
      // (older versions did not log it: unknown); a series without series.create is a built-in default.
      let restarts: boolean | null = !flips.length ? s.yearlyReset : typeof origin?.yearlyReset === 'boolean' ? origin.yearlyReset : origin ? null : true;
      const periods: Logged[][] = [];
      let flip = 0;
      let prev: Logged | undefined;
      for (const x of bySeries.get(s.id) ?? []) {
        for (; flip < flips.length && (flips[flip] as [number, boolean])[0] < x.id; flip++) restarts = (flips[flip] as [number, boolean])[1];
        // Setting unknown: only a restart explains a number not above the previous one in a later year.
        if (!prev || (x.year > prev.year && (restarts ?? (x.seq <= prev.seq)))) periods.push([]);
        (periods.at(-1) as Logged[]).push(x);
        prev = x;
      }
      // Numbers given out after the last logged one (e.g. the end of the log cut off) in a later year,
      // with the yearly restart on, began a period of their own.
      if (s.seqYear !== null && (!prev || (s.seqYear > prev.year && s.yearlyReset))) periods.push([]);
      const startSeq = origin?.startSeq;
      periods.forEach((period, i) => {
        const seqs = [...period].sort((a, b) => a.seq - b.seq);
        const top = seqs.at(-1);
        // Created by createSeries: its startSeq (older versions: unknown); a default series starts at 1, and so does a restart.
        const first = i === 0 ? (typeof startSeq === 'number' ? startSeq : origin ? (seqs[0]?.seq ?? 1) : 1) : 1;
        const current = i === periods.length - 1 && s.seqYear !== null;
        const last = current ? s.nextSeq - 1 : (top?.seq ?? first - 1);
        const fmt = (n: number, year: number): string => {
          try {
            return formatNumber(s.pattern, n, year);
          } catch {
            return String(n); // a value no number can be formed from (e.g. a damaged log entry)
          }
        };
        const shown = (x: Logged): string => x.number ?? fmt(x.seq, x.year);
        /** Numbers a–b missing between two logged ones (`after` undefined: up to the series' last number). */
        const missing = (a: number, b: number, before: Logged | undefined, after: Logged | undefined): string => {
          const year = after?.year ?? (s.seqYear as number);
          if (!before || before.year === year) return `${s.name}: hiányzik ${a === b ? `a(z) ${fmt(a, year)} sorszám` : `${b - a + 1} sorszám (${fmt(a, year)} – ${fmt(b, year)})`}.`;
          // The year changed in between (no yearly restart): the year the missing numbers were given in is not known.
          return `${s.name}: hiányzik ${a === b ? `a(z) ${a}. sorszám` : `${b - a + 1} sorszám (${a}–${b}.)`} a(z) ${shown(before)} ${after ? `és a(z) ${shown(after)} között` : 'után'}.`;
        };
        let expected = first;
        let before: Logged | undefined;
        for (const x of seqs) {
          if (x.seq > expected) out.push(missing(expected, x.seq - 1, before, x));
          expected = Math.max(expected, x.seq + 1);
          before = x;
        }
        // Only the current period can end in a gap (its last number is the series' last one).
        if (last >= expected) out.push(missing(expected, last, before, undefined));
        if (top && top.seq > last) out.push(`${s.name}: a következő kiadandó sorszám (${fmt(s.nextSeq, s.seqYear ?? top.year)}) nem követi a már kiadott ${shown(top)} sorszámot.`);
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// NAV reporting helpers
// ---------------------------------------------------------------------------------------------

/** NAV client timeout per request (nav_sync); one submission (token exchange + manageInvoice) takes at most twice this. */
const NAV_TIMEOUT_MS = 60_000;
const NAV_SEND_MAX_MS = 2 * NAV_TIMEOUT_MS;
/**
 * The NAV part of issuing (and of a storno) takes about this long at most, end to end – sending and waiting for the
 * result: MCP clients give up on a tool call after 60 s by default, and an error there would read as "not issued".
 */
const NAV_ISSUE_BUDGET_MS = 20_000;
/** Per request when issuing: NAV answers in well under a second; its synchronous blocking timeout is 5 s (spec 1.6.6). */
const NAV_ISSUE_REQUEST_TIMEOUT_MS = 6_000;
/** The pause NAV asked for (Retry-After) is kept in the settings under this key (NavPause). */
const NAV_PAUSE_SETTING = 'navPause';
/** The pause after an HTTP 429 without a usable Retry-After header. */
const NAV_DEFAULT_RETRY_AFTER_MS = 60_000;
/** The longest pause taken from a Retry-After header: the next run after it simply asks again. */
const NAV_MAX_RETRY_AFTER_MS = 60 * 60_000;
/** Every NAV status of an invoice that is reported (all but not_applicable). */
const NAV_REPORTABLE: readonly NavStatus[] = ['not_configured', 'pending', 'processing', 'done', 'done_with_warnings', 'aborted', 'error'];
/** Issuing while a NAV sync runs in this process: the submission is not queued behind it (see issue). */
const NAV_BUSY_NOTE =
  'Egy NAV-szinkron éppen fut, ezért a kiállítás nem várt rá: a számla NAV-jelentése függőben van (pending) – a következő nav_sync beküldi (futtasd: nav_sync).';
/** A 'sending' attempt older than this was interrupted (crash, killed process): its outcome is unknown. */
const NAV_SENDING_STALE_MS = NAV_SEND_MAX_MS + 60_000;
/** NAV's reference procedure waits 5 minutes after a submission with an unknown outcome before looking for it. */
const NAV_RECONCILE_DELAY_MS = 5 * 60_000;
/** Clock difference between this machine and NAV tolerated when searching the transaction list. */
const NAV_CLOCK_MARGIN_MS = 5 * 60_000;
/** A measured clock difference that widens the transaction-list window by more than this makes the listing start again. */
const NAV_CLOCK_RELIST_MS = 60_000;
/** The audit action of a clock difference recorded before a report went out (navRecordClock). */
const NAV_CLOCK_ACTION = 'nav.clock';
/** Attempts that may still lead to a report: no new attempt is started while one of them exists. */
const NAV_OPEN_SUBMISSION: ReadonlySet<string> = new Set(['sending', 'sent', 'processing']);

const NAV_NOT_UNIQUE = 'INVOICE_NUMBER_NOT_UNIQUE';
/** A duplicate NAV holds no valid report of, or holds more than once: someone has to act (see the message). */
const NAV_HINT = 'OPENSZAMLA_HINT';
/** The check of a duplicate failed for a transient reason: the next nav_sync tries again. */
const NAV_RECONCILE_RETRY = 'OPENSZAMLA_RECONCILE_RETRY';
/** NAV holds another invoice under the number (navReconcileNotUnique, navReconcileByNumber). */
const NAV_COLLISION = 'OPENSZAMLA_NUMBER_COLLISION';
/** NAV has no result for a transaction it once accepted for processing (navTransactionUnknown). */
const NAV_TRANSACTION_UNKNOWN = 'OPENSZAMLA_TRANSACTION_UNKNOWN';
/** A reconciliation that a permanent NAV error (missing permission …) prevents; the NAV error is the message before it. */
const NAV_RECONCILE_BLOCKED = 'OPENSZAMLA_RECONCILE_BLOCKED';
/** The outcome of a reconciliation on an invoice: each reconciliation replaces the previous one. */
const NAV_OUTCOME_CODES: ReadonlySet<string> = new Set([NAV_HINT, NAV_RECONCILE_RETRY, NAV_COLLISION, NAV_RECONCILE_BLOCKED]);

/** Rejected as a duplicate and not settled (not checked yet, or the check is to be repeated): a plain nav_sync reconciles it. */
const NAV_SEL_DUPLICATE: NavSelector = { navStatus: ['aborted'], withMessageCode: [NAV_NOT_UNIQUE], withoutMessageCode: [NAV_HINT, NAV_COLLISION, NAV_RECONCILE_BLOCKED] };
const NAV_SEL_COLLISION: NavSelector = { navStatus: ['aborted'], withMessageCode: [NAV_COLLISION], withoutMessageCode: [NAV_RECONCILE_BLOCKED] };
const NAV_SEL_BLOCKED: NavSelector = { navStatus: ['aborted', 'error'], withMessageCode: [NAV_RECONCILE_BLOCKED] };
/** Rejected by NAV or failed for good for any other reason: fixed at the cause, then nav_sync resubmitFailed. */
const NAV_SEL_REJECTED: readonly NavSelector[] = [
  { navStatus: ['error'], withoutMessageCode: [NAV_RECONCILE_BLOCKED] },
  { navStatus: ['aborted'], withoutMessageCode: [NAV_NOT_UNIQUE, NAV_COLLISION, NAV_RECONCILE_BLOCKED] },
  { navStatus: ['aborted'], withMessageCode: [NAV_NOT_UNIQUE, NAV_HINT], withoutMessageCode: [NAV_COLLISION, NAV_RECONCILE_BLOCKED] },
];
/** An original in one of these states holds its modifications and stornos up until someone acts. */
const NAV_SEL_BLOCKING_ORIGINAL: readonly NavSelector[] = [
  { navStatus: ['error'] },
  { navStatus: ['aborted'], withoutMessageCode: [NAV_NOT_UNIQUE] },
  { navStatus: ['aborted'], withMessageCode: [NAV_HINT] },
  { navStatus: ['aborted'], withMessageCode: [NAV_COLLISION] },
  { navStatus: ['aborted'], withMessageCode: [NAV_RECONCILE_BLOCKED] },
];
/** What a plain nav_sync works on: sendable, processing, and duplicates to reconcile. */
const NAV_SEL_QUEUE: readonly NavSelector[] = [{ navStatus: ['pending', 'not_configured', 'processing'] }, NAV_SEL_DUPLICATE];
const NAV_SEL_QUEUE_RESUBMIT: readonly NavSelector[] = [{ navStatus: ['pending', 'not_configured', 'processing', 'aborted', 'error'] }];

/**
 * What NAV holds under an invoice number, compared with the invoice (OpenSzamla.navLookup); `source`: its auditData
 * source; `receivedAt`: its insDate, when NAV received it before the invoice was issued.
 */
type NavLookup =
  | { kind: 'same'; transactionId: string | null }
  | { kind: 'similar'; transactionId: string | null; source: string }
  | { kind: 'other'; differences: string[]; receivedAt?: string }
  | { kind: 'none' }
  | { kind: 'multiple' };

/**
 * Options of one run (OpenSzamla.navSync); `issue`: the submission when issuing (issue(), NAV_ISSUE_BUDGET_MS);
 * `confirmedForeign`: the fingerprint of the cross-system report the user confirmed (navForeignResend) – without it the
 * invoice of `invoiceId` is never sent to another NAV system than the one its NAV state belongs to.
 * `budgetMs`: the time limit of the call, from navSync() on (a wait for another run included) – MCP clients give up on
 * a tool call after about 60 s. Once it is up no new NAV request starts (nor one that would need more of it than is
 * left, navBudgetRequestMs), a request's timeout is cut to what is left, and so is the wait for the processing
 * (waitSeconds); what the run did not get to is marked notProcessed: 'time'. A submission whose answer it cuts off is
 * uncertain like any other (looked up before it is sent again). Without it a run has no time limit (the CLI).
 */
export interface NavRunOptions {
  invoiceId?: string;
  waitSeconds?: number;
  resubmitFailed?: boolean;
  issue?: boolean;
  confirmedForeign?: string;
  budgetMs?: number;
  /**
   * Only invoices that already have a submission attempt in the configured NAV system (the background run of a
   * server, nav-auto.ts): what was started is carried on – an invoice never sent is not sent first by it.
   */
  onlyAttempted?: boolean;
}

/**
 * A note of a run on one invoice, written when it had `navStatus`; `wait`: why a correction waits for its original;
 * `notProcessed`: the stop of the run that left it as it was (NavInvoiceResult.notProcessed).
 */
interface NavRunNote {
  text: string;
  navStatus: NavStatus;
  wait: boolean;
  notProcessed?: 'time' | 'outage' | 'pause';
}

/** A pause NAV asked for (HTTP 429 / maintenance with Retry-After): no run contacts NAV in `environment` before `until`. */
interface NavPause {
  until: string;
  environment: NavEnvironment;
  code: string;
}

/**
 * The time limit of a run (NavRunClient): of issuing (`issue`, NAV_ISSUE_BUDGET_MS) or of a call (NavRunOptions.budgetMs).
 * `until`: Date.now() by which the run ends; `requestMs`: what a request is given at least – one is not started with
 * less left; `budgetMs`: the whole limit (the notes name it).
 */
interface NavTimeLimit {
  until: number;
  requestMs: number;
  budgetMs: number;
  issue: boolean;
}

/** Why a run contacts NAV no more (NavRunClient.stopped): an outage, or its time limit (NavTimeLimit) is up. */
type NavStop = { kind: 'outage'; error: NavError } | { kind: 'time'; limit: NavTimeLimit };

/**
 * The NAV client of one run (nav_sync, or the submission when issuing): a circuit breaker and a time limit around
 * NavClient. After the first outage (navOutage) the run starts nothing more: a transport timeout, a network error or a
 * pause NAV asks for (HTTP 429, Retry-After) stops every further request at once; a quick "unavailable" answer
 * (maintenance, HTTP 5xx) stops the run after the invoice in hand, whose own fallback query may still help. With a time
 * limit (`limit`: issuing, or a call with NavRunOptions.budgetMs) a request is not started without `requestMs` left for
 * it, and none runs past the limit: its timeout is cut to what is left – such a timeout means the time is up (not an
 * outage). Nothing it does not send can reach NAV.
 */
class NavRunClient extends NavClient {
  readonly environment: NavEnvironment;
  readonly #limit: NavTimeLimit | null;
  #outage: { error: NavError; immediate: boolean } | null = null;
  #outOfTime = false;
  /** The timeout of the last request was cut to what was left of the time limit. */
  #cut = false;

  constructor(opts: NavClientOptions & { limit?: NavTimeLimit }) {
    super(opts);
    this.environment = opts.environment;
    this.#limit = opts.limit ?? null;
  }

  /** When the time limit of the run ends (Date.now()), or null without one. */
  get until(): number | null {
    return this.#limit?.until ?? null;
  }

  /** Why this run contacts NAV no more, or null. */
  get stopped(): NavStop | null {
    if (this.#outage) return { kind: 'outage', error: this.#outage.error };
    return this.#outOfTime && this.#limit ? { kind: 'time', limit: this.#limit } : null;
  }

  /** Whether `requests` more requests fit in the time limit (always without one); if not, the run is out of time. */
  fits(requests: number): boolean {
    if (this.#limit && Date.now() + requests * this.#limit.requestMs >= this.#limit.until) this.#outOfTime = true;
    return !this.#outOfTime;
  }

  /** No request runs past the time limit: its timeout is cut to what is left of it. */
  protected override requestTimeoutMs(): number {
    const own = super.requestTimeoutMs();
    const left = this.#limit ? Math.max(1, this.#limit.until - Date.now()) : own;
    this.#cut = left < own;
    return Math.min(own, left);
  }

  // The submission's own check (fits(2), stopped) comes before it claims the invoice: only an outage is checked here.
  override manageInvoice(items: ManageInvoiceItem[], opts: { compressedContent?: boolean; beforeSend?: () => void } = {}) {
    return this.#guard(0, () => super.manageInvoice(items, opts));
  }

  /**
   * The clock difference of this run (clockOffsetMs); when no answer carried a time yet (e.g. a proxy drops the HTTP
   * Date header), one token exchange reads it. Never throws: null when it cannot be read.
   */
  async readClock(): Promise<number | null> {
    if (this.clockOffsetMs === null && !this.stopped) {
      try {
        await this.#guard(1, () => super.tokenExchange());
      } catch {
        // no reading: the caller goes on without one
      }
    }
    return this.clockOffsetMs;
  }

  override queryTransactionStatus(transactionId: string, opts: { returnOriginalRequest?: boolean } = {}) {
    return this.#guard(1, () => super.queryTransactionStatus(transactionId, opts));
  }

  override queryTransactionList(from: Date, to: Date, page = 1) {
    return this.#guard(1, () => super.queryTransactionList(from, to, page));
  }

  override queryInvoiceData(invoiceNumber: string) {
    return this.#guard(1, () => super.queryInvoiceData(invoiceNumber));
  }

  async #guard<T>(requests: number, call: () => Promise<T>): Promise<T> {
    if (this.#outage?.immediate) throw navNotSent(this.#outage.error);
    if (requests > 0 && !this.fits(requests)) throw navNotSent(this.#limit);
    try {
      return await call();
    } catch (e) {
      // A timeout the time limit cut short: the limit is up – NAV may just be slow.
      if (this.#cut && e instanceof NavError && e.navErrorCode === 'TIMEOUT') {
        this.#outOfTime = true;
        throw e;
      }
      const kind = navOutage(e);
      if (kind && (!this.#outage || (kind === 'immediate' && !this.#outage.immediate))) this.#outage = { error: e as NavError, immediate: kind === 'immediate' };
      throw e;
    }
  }
}

/**
 * NAV cannot be reached in this run, or asks not to be called for now: 'immediate' – a transport timeout or network
 * error (more requests would only add timeouts), or a pause NAV asks for (navAsksToWait); 'next' – NAV answers but is
 * unavailable (maintenance, HTTP 5xx without a NAV answer). null: another error, about that one request.
 */
function navOutage(e: unknown): 'immediate' | 'next' | null {
  if (!(e instanceof NavError) || !e.retryable) return null;
  if (e.navErrorCode === 'TIMEOUT' || e.navErrorCode === 'NETWORK_ERROR' || navAsksToWait(e)) return 'immediate';
  if (e.navErrorCode === 'MAINTENANCE_MODE' || e.navErrorCode === 'SERVICE_UNAVAILABLE' || /^HTTP_5\d\d$/.test(e.navErrorCode)) return 'next';
  return null;
}

/** NAV asks for a pause (spec 3.2 #30): HTTP 429 TOO_MANY_REQUESTS, or maintenance / HTTP 503 with a Retry-After. */
function navAsksToWait(e: NavError): boolean {
  return e.navErrorCode === 'TOO_MANY_REQUESTS' || e.httpStatus === 429 || (e.retryAfterMs !== null && (e.httpStatus === 503 || e.navErrorCode === 'MAINTENANCE_MODE'));
}

/** A request a run did not send (NavRunClient): NAV is out of reach in this run (`why`), or its time limit is up. */
function navNotSent(why: NavError | NavTimeLimit | null): NavError {
  const message =
    why instanceof NavError
      ? `A kérést nem küldtük el: a NAV ebben a futásban nem érhető el (${why.navErrorCode}).`
      : why && !why.issue
        ? `A kérést nem küldtük el: a NAV-szinkronra szánt idő (${navSeconds(why.budgetMs)} mp) letelt.`
        : 'A kérést nem küldtük el: a kiállításkor a NAV-ra szánt idő letelt.';
  return new NavError('NOT_SENT', message, { retryable: true, httpStatus: null, hint: 'Futtasd később újra a nav_sync-et.' });
}

/**
 * What a request of a call with a time limit (NavRunOptions.budgetMs) is given at least – one is not started with less
 * left: 6 s, as when issuing (NAV answers in well under a second), an eighth of a shorter limit.
 */
function navBudgetRequestMs(budgetMs: number): number {
  return Math.max(1, Math.min(NAV_ISSUE_REQUEST_TIMEOUT_MS, budgetMs / 8));
}

/** A time limit in whole seconds, for the notes. */
function navSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

/** `selectors` limited to the invoices of NAV environment `env` (or of none yet). */
function navHere(selectors: readonly NavSelector[], env: NavEnvironment): NavSelector[] {
  return selectors.map((s) => ({ ...s, environment: env }));
}

/** The NAV state of `inv` belongs to another NAV system than `env` (e.g. it was reported only to the test one). */
function navForeign(inv: Pick<Invoice, 'navEnvironment'>, env: NavEnvironment): boolean {
  return inv.navEnvironment !== undefined && inv.navEnvironment !== env;
}

/** `iso` as a Hungarian date and time in Hungary, e.g. "2026.11.08. 17:05:30". */
function huDateTime(iso: string): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat('hu-HU', { timeZone: HU_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at);
  return `${formatHuDate(huDate(at))} ${time}`;
}

/** The pause NAV asked for, in one sentence (without the closing period). */
function navPauseText(p: NavPause): string {
  const why = p.code === 'MAINTENANCE_MODE' ? 'karbantartás miatt' : p.code === 'TOO_MANY_REQUESTS' ? 'forgalomkorlátozás miatt (HTTP 429)' : `(${p.code})`;
  return `A NAV ${why} azt kérte, hogy legkorábban ${huDateTime(p.until)}-kor forduljunk hozzá újra (Retry-After)`;
}

/** How long a pause still lasts (`ms`), in Hungarian: "45 másodperc", "kb. 3 perc". */
function navRemaining(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 60 ? `${s} másodperc` : `kb. ${Math.ceil(s / 60)} perc`;
}

/** Note of an invoice a run leaves as it is because of a pause NAV asked for. */
function navPauseNote(p: NavPause): string {
  return `${navPauseText(p)}: addig a program nem küld be és nem kérdez le semmit – a számla állapota nem változott. Utána futtasd újra a nav_sync-et.`;
}

/** Note of an invoice a run leaves as it is because it stopped (NavStop, not a pause). */
function navStopNote(stop: NavStop): string {
  if (stop.kind === 'outage') {
    return `A NAV ebben a futásban nem érhető el (${stop.error.navErrorCode}), ezért a program ennél a számlánál nem fordult a NAV-hoz – a számla állapota nem változott. Futtasd később újra a nav_sync-et.`;
  }
  return stop.limit.issue
    ? `A kiállításkor a NAV-beküldésre szánt idő (${navSeconds(stop.limit.budgetMs)} mp) letelt, ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz – futtasd a nav_sync-et.`
    : `A NAV-szinkronra szánt idő (${navSeconds(stop.limit.budgetMs)} mp) letelt, ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz. Futtasd újra a nav_sync-et: a következő futás folytatja.`;
}

/** Note of a recorded number collision a run does not ask NAV about again (only nav_sync of that invoice does). */
function navCollisionKeptNote(inv: Pick<Invoice, 'id' | 'number' | 'navStatus' | 'navMessages' | 'navEnvironment'>, env: NavEnvironment): string {
  return (
    `${navNote(inv, env)} A program ezt nem kérdezi le újra a NAV-tól minden futásban: ha a NAV-nál ezen a sorszámon tárolt másik számlát technikai érvénytelenítéssel visszavonták, ` +
    `az újraellenőrzéshez futtasd: nav_sync { invoice: "${inv.number ?? inv.id}", resubmitFailed: true }.`
  );
}

/** The NAV status of `inv` in the NAV system it belongs to, in a word or two. */
function navForeignState(inv: Pick<Invoice, 'navStatus'>): string {
  return navAccepted(inv.navStatus)
    ? 'jelentve'
    : inv.navStatus === 'processing'
      ? 'feldolgozás alatt'
      : inv.navStatus === 'aborted' || inv.navStatus === 'error'
        ? 'elutasítva vagy hibás'
        : 'jelentésre vár';
}

/**
 * What a confirmation of sending `inv` (of the other NAV system) to `env` is bound to – what its preview showed: the
 * invoice, its content, its NAV status there and both systems. A change of any of them needs a fresh preview.
 */
function navForeignFingerprint(inv: Pick<Invoice, 'id' | 'contentHash' | 'navEnvironment' | 'navStatus'>, env: NavEnvironment): string {
  return sha256Hex(canonicalJson(['nav-report', inv.id, inv.contentHash, inv.navEnvironment ?? null, inv.navStatus, env]));
}

/** What sending `inv` – whose NAV state belongs to the other NAV system – to `env` means (navForeignResend). */
function navForeignResendText(inv: Pick<Invoice, 'id' | 'number' | 'navStatus' | 'navEnvironment'>, env: NavEnvironment): string {
  const n = inv.number ?? inv.id;
  if (env === 'production') {
    return (
      `A(z) ${n} számla NAV-állapota a TESZT rendszerhez tartozik (ott: ${navForeignState(inv)}), az éles rendszerbe nincs jelentve. ` +
      'Most az ÉLES NAV-rendszerbe kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás a NAV felé, és nem vonható vissza. Csak akkor küldd be, ha ez valódi számla.'
    );
  }
  return (
    `A(z) ${n} számla NAV-állapota az ÉLES rendszerhez tartozik (ott: ${navForeignState(inv)}). ` +
    'Most a NAV TESZT rendszerébe kerülne beküldésre, új beküldésként: ez nem adatszolgáltatás, és a számla NAV-állapota ezután a TESZT rendszerhez tartozik.'
  );
}

/** Note of an invoice of the other NAV system a run did not send to `env`, because the user has not confirmed it. */
function navForeignUnconfirmedNote(inv: Pick<Invoice, 'id' | 'number' | 'navStatus' | 'navEnvironment'>, env: NavEnvironment): string {
  return `Nem küldtük be (megerősítés nélkül): ${navForeignResendText(inv, env)} A másik NAV-rendszerbe küldést a felhasználónak kell jóváhagynia.`;
}

/** The NAV state of `inv` belongs to the other NAV system than `env`: what that means here, and what to do. */
function navForeignNote(inv: Pick<Invoice, 'id' | 'number' | 'navStatus' | 'navEnvironment'>, env: NavEnvironment): string {
  const n = inv.number ?? inv.id;
  const state = navForeignState(inv);
  if (env === 'production') {
    return (
      `A számla NAV-állapota a TESZT rendszerhez tartozik (ott: ${state}), az éles rendszerbe nincs jelentve – a teszt környezetbe küldött számla nem adatszolgáltatás. ` +
      `Ha ez valódi számla, az éles rendszerbe a nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő kód: nav_sync { invoice: "${n}", resubmitFailed: true }.`
    );
  }
  return `A számla NAV-állapota az ÉLES rendszerhez tartozik (ott: ${state}); a TESZT környezetben ezzel nincs teendő – az éles jelentéséhez állítsd vissza az éles (production) környezetet.`;
}

const NAV_UNCERTAIN_MESSAGE: NavMessage = {
  severity: 'INFO',
  code: 'OPENSZAMLA_UNCERTAIN',
  message:
    'A beküldés eredménye bizonytalan: a NAV a kérést megkaphatta. A nav_sync a beküldés után legalább 5 perccel a NAV tranzakciólistáján ellenőrzi, ' +
    'hogy megérkezett-e, és csak akkor küldi újra, ha nem – így a számla nem kerül kétszer a NAV-hoz.',
};

const NAV_DUPLICATE_MESSAGE: NavMessage = {
  severity: 'INFO',
  code: 'OPENSZAMLA_RECONCILED',
  message: 'A számla egy későbbi, ismételt beküldését a NAV INVOICE_NUMBER_NOT_UNIQUE hibával utasította el, mert ezt a beküldést már befogadta – a számla jelentve van.',
};

/** Where a report NAV holds came from (queryInvoiceData auditData source), in a few words. */
function navSourceText(source: string): string {
  switch (source.trim().toUpperCase()) {
    case 'WEB':
      return 'a NAV webes felületén rögzítették (WEB)';
    case 'XML':
      return 'kézi XML-feltöltéssel került a NAV-hoz (XML)';
    case 'OSZ':
      return 'a NAV Online Számlázó programjában állították ki (OSZ)';
    case 'OPG':
      return 'online pénztárgépről érkezett (OPG)';
    default:
      return `forrás: ${source || 'ismeretlen'}`;
  }
}

/**
 * OPENSZAMLA_RECONCILED of a report found under the number (queryInvoiceData): 'same' – one of our submissions,
 * byte for byte; 'similar' – typed by hand on the NAV web interface (WEB) with the same key data, or from another
 * channel (the machine interface, an uploaded XML file, NAV's online invoicing program, an online cash register) with
 * the same key data and lines. `via`: after a duplicate rejection, or when an attempt with an unknown outcome could
 * not be found in the transaction list.
 */
function navReconciledMessage(found: Extract<NavLookup, { kind: 'same' | 'similar' }>, via: 'duplicate' | 'lookup'): NavMessage {
  const why =
    via === 'duplicate'
      ? 'A NAV a beküldést ismétlésként utasította el (INVOICE_NUMBER_NOT_UNIQUE), mert ezzel a sorszámmal már szerepel nála számla. '
      : 'Egy bizonytalan kimenetelű beküldés tranzakciója nem volt megkereshető a NAV tranzakciólistáján, ezért a program a sorszám alapján kérdezte le a NAV-ot. ';
  const keyData = 'kelte, eladó és vevő, pénznem, nettó, ÁFA és bruttó forintösszeg';
  const lineData = '(tételenként a megnevezés, a mennyiség, a mennyiségi egység, a nettó összeg és az ÁFA-kulcs)';
  const what =
    found.kind === 'same'
      ? 'A NAV-tól lekért adat (queryInvoiceData) bájtra azonos ennek a számlának egy beküldésével – a számla jelentve van.'
      : navManualSource(found.source)
        ? `A NAV-tól lekért számla (queryInvoiceData) adattartalma eltér a beküldöttől, de nem gépi interfészen került a NAV-hoz – ${navSourceText(found.source)} –, és a kulcsadatai egyeznek ezzel a számlával (${keyData}), ezért a számla jelentve van. ` +
          'Ellenőrizd a NAV felületén, hogy az ott rögzített adatok a többi részletben is helyesek-e.'
        : navOtherChannel(found.source)
          ? `A NAV-tól lekért számla (queryInvoiceData) nem gépi interfészen került a NAV-hoz – ${navSourceText(found.source)} –, és nem bájtra azonos egyik itt nyilvántartott beküldéssel sem, de a kulcsadatai (${keyData}) és a tételei ` +
            `${lineData} is egyeznek ezzel a számlával, ezért a számla jelentve van. Ellenőrizd a NAV felületén, hogy a többi adata is helyes-e.`
          : `A NAV-tól lekért számla (queryInvoiceData) gépi interfészen (MGM) érkezett, és nem bájtra azonos egyik itt nyilvántartott beküldéssel sem, de a kulcsadatai (${keyData}) és a tételei ` +
            `${lineData} is egyeznek ezzel a számlával – pl. a program egy másik változata vagy telepítése küldte be –, ezért a számla jelentve van. ` +
            'Ellenőrizd a NAV felületén, hogy a többi adata is helyes-e.';
  return { severity: 'INFO', code: 'OPENSZAMLA_RECONCILED', message: why + what };
}

function navAccepted(s: NavStatus): boolean {
  return s === 'done' || s === 'done_with_warnings';
}

function navNotUnique(messages: readonly NavMessage[]): boolean {
  return navHas(messages, NAV_NOT_UNIQUE);
}

function navHas(messages: readonly NavMessage[], code: string): boolean {
  return messages.some((m) => m.code === code);
}

/** An aborted invoice NAV has to be asked about before it is sent again: a duplicate rejection, a collision, a blocked check. */
function navReconcilable(messages: readonly NavMessage[]): boolean {
  return messages.some((m) => m.code === NAV_NOT_UNIQUE || m.code === NAV_COLLISION || m.code === NAV_RECONCILE_BLOCKED);
}

/** Rejected as a duplicate and not settled yet (not checked, or the check is to be repeated) – NAV_SEL_DUPLICATE. */
function navUnsettledDuplicate(messages: readonly NavMessage[]): boolean {
  return navNotUnique(messages) && !messages.some((m) => m.code === NAV_HINT || m.code === NAV_COLLISION || m.code === NAV_RECONCILE_BLOCKED);
}

/** A number collision is recorded on the invoice (and no permanent NAV error blocks its check – NAV_SEL_COLLISION). */
function navCollisionRecorded(inv: Pick<Invoice, 'navStatus' | 'navMessages'>): boolean {
  return inv.navStatus === 'aborted' && navHas(inv.navMessages, NAV_COLLISION) && !navHas(inv.navMessages, NAV_RECONCILE_BLOCKED);
}

/** `messages` without the outcome of an earlier reconciliation (NAV_OUTCOME_CODES, and the NAV error a blocked one names). */
function navWithoutOutcome(messages: readonly NavMessage[]): NavMessage[] {
  return messages.filter((m, i) => !NAV_OUTCOME_CODES.has(m.code) && messages[i + 1]?.code !== NAV_RECONCILE_BLOCKED);
}

/** The base64 invoiceData `b64` (as sent or as NAV echoes it, compressed or not) carries exactly the XML `xml`. */
function samePayload(b64: string, xml: Buffer): boolean {
  try {
    return decodeInvoiceData(b64).equals(xml);
  } catch {
    return false;
  }
}

/** A NAV error that asking again does not change (missing permission, wrong credentials …): a configuration problem. */
function navPermanent(e: unknown): e is NavError {
  return e instanceof NavError && !e.retryable;
}

/** What a permanent NAV error during a reconciliation means, in a few words (also in status().nextSteps). */
function navBlockedReason(code: string): string {
  switch (code) {
    case 'FORBIDDEN':
      return 'a technikai felhasználónak nincs lekérdezési jogosultsága („Számlák lekérdezése”)';
    case 'INVALID_SECURITY_USER':
      return 'hibás a technikai felhasználó neve vagy jelszava';
    case 'INVALID_USER_RELATION':
      return 'a technikai felhasználó nem ehhez az adószámhoz tartozik, vagy le van tiltva';
    case 'NOT_REGISTERED_CUSTOMER':
    case 'INVALID_CUSTOMER':
      return 'az eladó adószáma nincs regisztrálva vagy nem jogosult az Online Számla rendszerben';
    case 'INVALID_REQUEST_SIGNATURE':
      return 'hibás az XML aláírókulcs';
    case 'INVALID_TIMESTAMP':
      return 'a gép órája eltér a NAV idejétől';
    default:
      return `a NAV végleges hibát ad (${code || 'ismeretlen hiba'})`;
  }
}

/** The NAV error of a blocked reconciliation and OPENSZAMLA_RECONCILE_BLOCKED with the remedy (never "try later"). */
function navBlockedMessages(e: NavError): NavMessage[] {
  const remedy =
    e.navErrorCode === 'FORBIDDEN'
      ? 'Add meg a technikai felhasználónak a „Számlák lekérdezése” (vagy „Saját számlák lekérdezése”) jogosultságot az onlineszamla.nav.gov.hu felületén.'
      : (e.hint ?? 'Hárítsd el a NAV által jelzett hibát.');
  return [
    { severity: 'ERROR', code: e.navErrorCode, message: e.message },
    {
      severity: 'ERROR',
      code: NAV_RECONCILE_BLOCKED,
      message:
        `A program nem tudja egyeztetni a NAV-val, mi van ebből a számlából a NAV-nál, mert ${navBlockedReason(e.navErrorCode)}. ` +
        `Addig nem küldi (újra), különben kétszer kerülhetne a NAV-hoz. ${remedy} Utána futtasd: nav_sync resubmitFailed: true.`,
    },
  ];
}

/** NAV's size limits (spec 1.6.5): an invoice whose report would exceed them cannot be issued. */
function navReportSizeIssues(invoice: Invoice): ValidationIssue[] {
  const problem = navReportSizeProblem(invoice);
  if (!problem) return [];
  return [issue('NAV_REPORT_TOO_LARGE', `${problem} Ennyi tétellel (${invoice.lines.length}) a számla nem jelenthető a NAV-nak: oszd több számlára, vagy rövidítsd a tételek szövegét.`, 'lines')];
}

function navStatusOf(r: NavProcessingResult): 'processing' | 'done' | 'done_with_warnings' | 'aborted' {
  if (r.invoiceStatus === 'DONE') return r.messages.some((m) => m.severity === 'WARN' || m.severity === 'ERROR') ? 'done_with_warnings' : 'done';
  return r.invoiceStatus === 'ABORTED' ? 'aborted' : 'processing';
}

/** Why a correction of `orig` waits for it with NAV system `env` (null without a usable connection) – the cases of navWaitNote; null: it does not wait. */
function navWaitOf(orig: Invoice, env: NavEnvironment | null): NavWait | null {
  const base = { originalId: orig.id, originalNumber: orig.number };
  if (env && navForeign(orig, env)) return { ...base, reason: 'other_environment', ...(orig.navEnvironment ? { environment: orig.navEnvironment } : {}) };
  if (navAccepted(orig.navStatus)) return null;
  switch (orig.navStatus) {
    case 'aborted':
    case 'error':
      if (navHas(orig.navMessages, NAV_RECONCILE_BLOCKED)) return { ...base, reason: 'blocked' };
      if (navHas(orig.navMessages, NAV_COLLISION)) return { ...base, reason: 'collision' };
      return { ...base, reason: 'rejected' };
    case 'processing':
      return { ...base, reason: 'processing' };
    default:
      return { ...base, reason: 'pending' };
  }
}

/** Why a correction waits for its original `orig` (not accepted by NAV system `env` yet), and what to do about it. */
/** Why a correction waits for an earlier correction of the same invoice. */
function navEarlierCorrectionNote(earlier: Invoice): string {
  const n = earlier.number ?? earlier.id;
  const kind = earlier.documentType === 'storno' ? 'sztornó' : 'módosító';
  if (earlier.navStatus === 'processing') {
    return `Még nem küldtük be: ugyanennek a számlának egy korábbi ${kind} számláját (${n}) a NAV még feldolgozza, a javító bizonylatokat pedig a kiállításuk sorrendjében kell jelenteni – utána ez is beküldésre kerül (nav_sync).`;
  }
  return (
    `Nem küldhető be: ugyanennek a számlának egy korábbi ${kind} számláját (${n}) a NAV még nem fogadta be (NAV-állapota: ${earlier.navStatus}), a javító bizonylatokat pedig a kiállításuk sorrendjében kell jelenteni. ` +
    `Előbb azt kell rendezni (az oka: invoice_get ${n} → navMessages; újraküldés: nav_sync { invoice: "${n}", resubmitFailed: true }) – utána ez a számla is beküldésre kerül.`
  );
}

function navWaitNote(orig: Invoice, env: NavEnvironment | null): string {
  const n = orig.number ?? orig.id;
  if (env && navForeign(orig, env)) {
    return env === 'production'
      ? `Nem küldhető be: az eredeti számla (${n}) NAV-állapota a TESZT rendszerhez tartozik, az éles rendszerbe nincs jelentve, a NAV pedig a módosítást/sztornót csak az eredeti után fogadja be. ` +
          `Ha az eredeti valódi számla, előbb azt kell beküldeni az éles rendszerbe (nav_send_to_configured_environment, a felhasználó jóváhagyásával – előnézet és megerősítő kód: nav_sync { invoice: "${n}", resubmitFailed: true }) – utána ez a számla is beküldésre kerül.`
      : `Nem küldhető be a TESZT rendszerbe: az eredeti számla (${n}) NAV-állapota az ÉLES rendszerhez tartozik.`;
  }
  switch (orig.navStatus) {
    case 'aborted':
    case 'error':
      if (navHas(orig.navMessages, NAV_RECONCILE_BLOCKED)) {
        return (
          `Nem küldhető be: az eredeti számla (${n}) NAV-jelentését a program nem tudja egyeztetni a NAV-val (a NAV lekérdezése végleges hibát ad), a NAV pedig a módosítást/sztornót csak az eredeti után fogadja be. ` +
          `Hárítsd el a hibát (lásd az eredeti számla üzeneteit: invoice_get ${n}), majd futtasd: nav_sync { invoice: "${n}", resubmitFailed: true } – utána ez a számla is beküldésre kerül.`
        );
      }
      if (navHas(orig.navMessages, NAV_COLLISION)) {
        return (
          `Nem küldhető be: az eredeti számla (${n}) sorszáma a NAV-nál egy másik számláé (sorszám-ütközés), így a NAV ezt a módosítást/sztornót a másik számlához kötné. ` +
          `Az eredeti számla nincs jelentve – a teendőt az üzenetei írják le (invoice_get ${n}).`
        );
      }
      return (
        `Nem küldhető be: az eredeti számla (${n}) NAV-jelentése ${orig.navStatus === 'aborted' ? 'elutasítva (ABORTED)' : 'hibával zárult'}, a NAV pedig a módosítást/sztornót csak az eredeti után fogadja be. ` +
        `Hárítsd el az eredeti számla jelentésének hibáját (lásd az üzeneteit: invoice_get ${n}), és küldd újra: nav_sync { invoice: "${n}", resubmitFailed: true } – utána ez a számla is beküldésre kerül.`
      );
    case 'processing':
      return `Várakozik: az eredeti számlát (${n}) a NAV még feldolgozza; utána ez is beküldésre kerül (nav_sync).`;
    default:
      return `Várakozik: előbb az eredeti számlát (${n}) kell sikeresen jelenteni – futtasd: nav_sync (invoice nélkül), vagy nav_sync { invoice: "${n}" }.`;
  }
}

/** What a NAV status means for the user, with the environment: in the test system nothing is reported for real. */
function navNote(inv: Pick<Invoice, 'id' | 'number' | 'navStatus' | 'navMessages' | 'navEnvironment'>, environment: NavEnvironment): string {
  if (navForeign(inv, environment)) return navForeignNote(inv, environment);
  const test = environment === 'test';
  if ((inv.navStatus === 'aborted' || inv.navStatus === 'error') && navHas(inv.navMessages, NAV_RECONCILE_BLOCKED)) {
    return `A NAV${test ? ' TESZT rendszerének' : ''} lekérdezése végleges hibát ad, ezért nem egyeztethető, mi van ebből a számlából a NAV-nál – a teendőt az üzenetek írják le, utána: nav_sync resubmitFailed: true.`;
  }
  if (inv.navStatus === 'aborted' && navHas(inv.navMessages, NAV_COLLISION)) {
    return `Sorszám-ütközés: a NAV${test ? ' TESZT rendszere' : ''} ezzel a sorszámmal egy másik számlát tárol, ez a számla nincs jelentve – a teendőt az üzenetek írják le (az újraküldés nem segít).`;
  }
  switch (inv.navStatus) {
    case 'done':
      return test ? 'A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.' : 'A NAV sikeresen befogadta.';
    case 'done_with_warnings':
      return `A NAV${test ? ' TESZT rendszere' : ''} befogadta, de figyelmeztetést adott – nézd át az üzeneteket.${test ? ' Éles adatszolgáltatás NEM történt.' : ''}`;
    case 'aborted':
      return `A NAV${test ? ' TESZT rendszere' : ''} elutasította (ABORTED): hárítsd el a hiba okát (lásd az üzeneteket), majd küldd újra: nav_sync resubmitFailed: true.`;
    case 'processing':
      return `A NAV${test ? ' TESZT rendszere' : ''} még feldolgozza – futtasd később újra a nav_sync-et.`;
    case 'pending':
      if (navHas(inv.navMessages, NAV_TRANSACTION_UNKNOWN)) {
        return `A NAV${test ? ' TESZT rendszere' : ''} nem ismeri a korábbi beküldés tranzakcióját, és ezzel a sorszámmal sincs nála számla: a következő nav_sync újra beküldi.`;
      }
      return inv.navMessages.some((m) => m.code === NAV_UNCERTAIN_MESSAGE.code)
        ? 'A beküldés eredménye bizonytalan (a NAV megkaphatta): 5 perc múlva a nav_sync ellenőrzi a NAV-nál, és csak akkor küldi újra, ha nem érkezett meg.'
        : 'Átmeneti hiba miatt nem sikerült elküldeni – később újrapróbálható (nav_sync).';
    case 'error':
      return 'Végleges hiba (pl. hibás hitelesítő adatok): hárítsd el az okát (lásd az üzeneteket), majd küldd újra: nav_sync resubmitFailed: true.';
    case 'not_configured':
      return 'NAV kapcsolat nincs beállítva.';
    default:
      return 'Nincs teendő.';
  }
}

export { navNote };
