/**
 * Domain model of OpenSzámla.
 *
 * Conventions
 * - Every decimal value (money, quantity, rate) is a canonical decimal STRING ("12500", "0.27", "-3.5").
 *   Never use JS floating point for money. Use the helpers in ./decimal.ts.
 * - Dates are ISO calendar dates "YYYY-MM-DD" in Hungarian local time (Europe/Budapest).
 * - Timestamps are ISO-8601 UTC strings ("2026-10-27T13:05:00.000Z").
 * - IDs are short prefixed random strings: "cus_…", "prd_…", "inv_…", "ser_…".
 */

export type IsoDate = string;
export type IsoTimestamp = string;
/** Canonical decimal string, e.g. "12500", "-0.5", "0.27". */
export type Dec = string;
/** ISO 4217 currency code, e.g. "HUF", "EUR". */
export type CurrencyCode = string;
/** ISO 3166-1 alpha-2 country code, e.g. "HU". */
export type CountryCode = string;

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

/**
 * VAT treatment of an invoice line ("ÁFA-kulcs / adókód").
 * The identifiers follow Hungarian invoicing practice; ./vat.ts maps each one to its
 * rate, NAV Online Számla representation (VatRateType), printed label and mandatory notation.
 */
export type VatCode =
  | '27'
  | '18'
  | '5'
  | '0'
  /** Alanyi adómentes (Áfa tv. XIII. fejezet) */
  | 'AAM'
  /** Tárgyi adómentes (Áfa tv. 85–87. §) */
  | 'TAM'
  /** Közösségen belüli adómentes termékértékesítés (Áfa tv. 89. §) */
  | 'KBAET'
  /** Új közlekedési eszköz adómentes Közösségen belüli értékesítése (Áfa tv. 89. §) */
  | 'KBAUK'
  /** Adómentes termékexport harmadik országba (Áfa tv. 98–109. §) */
  | 'EAM'
  /** Egyéb nemzetközi ügylethez kapcsolódó adómentesség (Áfa tv. 110–118. §) */
  | 'NAM'
  /** Az Áfa tv. tárgyi hatályán kívüli ügylet */
  | 'ATK'
  /** Más tagállamban teljesített szolgáltatás, Áfa tv. 37. § (1) – a vevő fizeti az adót */
  | 'EUFAD37'
  /** Más tagállamban teljesített, nem 37. § szerinti ügylet, fordított adózással */
  | 'EUFADE'
  /** Más tagállamban teljesített, nem fordított adózású ügylet */
  | 'EUE'
  /** Harmadik országban teljesített ügylet */
  | 'HO'
  /** Belföldi fordított adózás (Áfa tv. 142. §) */
  | 'FAD'
  /** Különbözet szerinti szabályozás – utazási irodák */
  | 'KUL_UTAZAS'
  /** Különbözet szerinti szabályozás – használt cikkek */
  | 'KUL_HASZNALT'
  /** Különbözet szerinti szabályozás – műalkotások */
  | 'KUL_MUALKOTAS'
  /** Különbözet szerinti szabályozás – gyűjteménydarabok és régiségek */
  | 'KUL_REGISEG';

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export interface Address {
  countryCode: CountryCode;
  postalCode: string;
  city: string;
  /** Street, house number, building, floor, door – one line ("Fő utca 1. 2/3."). */
  addressLine: string;
  region?: string;
}

/** How the seller handles VAT. Drives allowed VAT codes and mandatory notations. */
export type SellerVatStatus =
  /** Általános szabályok szerint adózó áfaalany */
  | 'normal'
  /** Alanyi adómentes áfaalany – every line must use VatCode 'AAM' */
  | 'aam';

export interface SellerProfile {
  name: string;
  /** Hungarian tax number "12345676-1-23". For VAT groups this is the group identifier. */
  taxNumber: string;
  /** Own tax number of a VAT-group member (csoporttag adószáma), if any. */
  groupMemberTaxNumber?: string;
  /** Community VAT number "HU12345676" (needed for intra-EU transactions). */
  euVatNumber?: string;
  address: Address;
  /** Bank account: Hungarian GIRO (2×8 or 3×8 digits, e.g. "11773016-11111018") or IBAN. */
  bankAccount?: string;
  bankName?: string;
  swift?: string;
  email?: string;
  phone?: string;
  website?: string;
  /** Cégjegyzékszám or EV nyilvántartási szám – printed if given. */
  registrationNumber?: string;
  vatStatus: SellerVatStatus;
  /** Pénzforgalmi elszámolás – printed notation + NAV cashAccountingIndicator. */
  cashAccounting: boolean;
  /** Kisadózó (KATA) – NAV smallBusinessIndicator. */
  smallBusiness: boolean;
  /** Free text printed in the invoice footer. */
  invoiceFooter?: string;
}

/** NAV CustomerVatStatusType. */
export type CustomerVatStatus =
  /** Belföldi áfaalany – Hungarian tax number required */
  | 'DOMESTIC'
  /** Egyéb (külföldi adóalany, vagy belföldi nem áfaalany jogi személy) */
  | 'OTHER'
  /** Nem áfaalany természetes személy – name/address are printed but NEVER sent to NAV */
  | 'PRIVATE_PERSON';

export interface CustomerData {
  vatStatus: CustomerVatStatus;
  name: string;
  /** Hungarian tax number (DOMESTIC). For VAT groups: the group identifier. */
  taxNumber?: string;
  groupMemberTaxNumber?: string;
  /** EU VAT number incl. country prefix, e.g. "DE123456789" (OTHER, EU buyer). */
  euVatNumber?: string;
  /** Tax id of a buyer outside the EU (OTHER, third country). */
  thirdStateTaxId?: string;
  address: Address;
  email?: string;
  phone?: string;
  bankAccount?: string;
}

export interface Customer extends CustomerData {
  id: string;
  note?: string;
  archived: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** NAV LineNatureIndicatorType. */
export type LineNature = 'PRODUCT' | 'SERVICE' | 'OTHER';

/** Whether a unit price is net (nettó) or gross (bruttó, VAT included). */
export type PriceBasis = 'net' | 'gross';

export interface Product {
  id: string;
  name: string;
  /** Hungarian unit label as printed, e.g. "db", "óra", "kg". Mapped to NAV units in ./units.ts. */
  unit: string;
  unitPrice: Dec;
  priceBasis: PriceBasis;
  currency: CurrencyCode;
  vatCode: VatCode;
  nature: LineNature;
  sku?: string;
  description?: string;
  archived: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

export type SeriesKind =
  /** Számlák (normál, előleg, vég-, módosító és sztornó számlák közös sorszámtartománya) */
  | 'invoice'
  /** Díjbekérők – NOT invoices, never reported to NAV */
  | 'proforma';

export interface Series {
  id: string;
  kind: SeriesKind;
  name: string;
  /**
   * Number pattern. Tokens: {YYYY} year of issue date, {SEQ} sequence, {SEQ:n} zero-padded to n digits.
   * Example: "OSZ-{YYYY}-{SEQ:5}" → "OSZ-2026-00001". Allowed literal chars: A–Z a–z 0–9 - / _ .
   */
  pattern: string;
  /** Restart the sequence at 1 when the year of the issue date changes. Requires {YYYY} in pattern. */
  yearlyReset: boolean;
  /** Next sequence value to use. */
  nextSeq: number;
  /** Year the current sequence belongs to (for yearlyReset). */
  seqYear: number | null;
  isDefault: boolean;
  archived: boolean;
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type DocumentType =
  /** Normál számla */
  | 'invoice'
  /** Előlegszámla */
  | 'advance'
  /** Végszámla (előleg levonásával) */
  | 'final'
  /** Módosító (helyesbítő) számla – references the original */
  | 'modification'
  /** Érvénytelenítő (sztornó) számla – references the original, negates every line */
  | 'storno'
  /** Díjbekérő – not an invoice */
  | 'proforma';

export type InvoiceStatus =
  | 'draft'
  | 'issued'
  /** Issued and later cancelled by a storno invoice (the original stays immutable). */
  | 'cancelled';

/** NAV PaymentMethodType. */
export type PaymentMethod = 'TRANSFER' | 'CASH' | 'CARD' | 'VOUCHER' | 'OTHER';

/** NAV InvoiceAppearanceType (how the invoice is delivered). */
export type InvoiceAppearance = 'ELECTRONIC' | 'PAPER';

export type InvoiceLanguage = 'hu' | 'en' | 'hu-en';

export type PaymentStatus = 'unpaid' | 'partial' | 'paid';

export type NavStatus =
  /** Proforma or draft – nothing to report */
  | 'not_applicable'
  /** NAV credentials not configured – the invoice still has to be reported! */
  | 'not_configured'
  /** Waiting to be sent (or a previous attempt failed with a transient error) */
  | 'pending'
  /** Accepted by NAV for processing; transactionId known; waiting for the final status */
  | 'processing'
  /** NAV processed it successfully (DONE) */
  | 'done'
  /** DONE, but NAV returned WARN messages worth reviewing */
  | 'done_with_warnings'
  /** NAV rejected the data (ABORTED) – must be fixed and re-sent */
  | 'aborted'
  /** Permanent client-side error (e.g. invalid credentials) – see navMessages */
  | 'error';

export interface NavMessage {
  severity: 'ERROR' | 'WARN' | 'INFO';
  code: string;
  message: string;
  pointer?: string;
}

/** Data entered for a line (what callers provide). */
export interface InvoiceLineInput {
  productId?: string;
  description: string;
  quantity: Dec;
  unit: string;
  unitPrice: Dec;
  priceBasis: PriceBasis;
  vatCode: VatCode;
  /**
   * Override of the exemption / out-of-scope reason (NAV `reason`, max 200 chars, printed as
   * notation), e.g. "Áfa tv. 85. § (1) e) – oktatási szolgáltatás" for TAM.
   */
  vatReason?: string;
  nature: LineNature;
  /** Modification invoices only: number of the ORIGINAL line this delta line modifies. */
  modifiesLineNo?: number;
  /** For 'final' invoices: this line deducts an advance paid earlier (negative amount). */
  advanceDeduction?: {
    advanceInvoiceNumber: string;
    advancePaymentDate: IsoDate;
    advanceExchangeRate: Dec;
  };
}

/** A line with all computed amounts (in invoice currency and in HUF). */
export interface InvoiceLine extends InvoiceLineInput {
  lineNo: number;
  /**
   * NAV lineModificationReference (modification and storno invoices only): which line of the
   * original invoice chain this line modifies (MODIFY) or which new line number it creates (CREATE).
   */
  modificationRef?: { lineNumberReference: number; lineOperation: 'CREATE' | 'MODIFY' };
  /** Net unit price (derived when priceBasis is 'gross'). */
  netUnitPrice: Dec;
  netAmount: Dec;
  vatAmount: Dec;
  grossAmount: Dec;
  netAmountHuf: Dec;
  vatAmountHuf: Dec;
  grossAmountHuf: Dec;
}

export interface VatSummaryRow {
  vatCode: VatCode;
  netAmount: Dec;
  vatAmount: Dec;
  grossAmount: Dec;
  netAmountHuf: Dec;
  vatAmountHuf: Dec;
  grossAmountHuf: Dec;
}

export interface InvoiceTotals {
  netAmount: Dec;
  vatAmount: Dec;
  grossAmount: Dec;
  netAmountHuf: Dec;
  vatAmountHuf: Dec;
  grossAmountHuf: Dec;
  byVat: VatSummaryRow[];
  /**
   * Amount payable in cash after the statutory 0/5 Ft rounding (only for HUF + CASH),
   * otherwise equal to grossAmount.
   */
  payableAmount: Dec;
  /** payableAmount - grossAmount (0 when no rounding applies). */
  roundingDifference: Dec;
}

/** Reference from a modification/storno invoice to the invoice it modifies. */
export interface InvoiceReference {
  originalInvoiceId: string;
  originalInvoiceNumber: string;
  /** NAV modificationIndex: 1 for the first modification/storno of the original, then 2, 3… */
  modificationIndex: number;
  /** True when the original was not reported to NAV (e.g. pre-2018 paper invoice). */
  modifyWithoutMaster: boolean;
  /** Document type of the original (a correction of an advance invoice is reported as advance data). */
  originalDocumentType?: DocumentType;
}

/** The full invoice document. Frozen (immutable) once issued. */
export interface Invoice {
  id: string;
  documentType: DocumentType;
  status: InvoiceStatus;
  seriesId: string;
  /** Assigned at issuance; null while draft. */
  number: string | null;
  issueDate: IsoDate;
  fulfillmentDate: IsoDate;
  dueDate: IsoDate | null;
  /**
   * Drafts only: the due date was given as a date (dueDate), not derived from the payment term. Issuing
   * on a later day keeps such a due date instead of moving it with the issue date. Not kept at issuance.
   */
  dueDateExplicit?: boolean;
  paymentMethod: PaymentMethod;
  currency: CurrencyCode;
  /** HUF value of 1 unit of `currency` ("1" for HUF). */
  exchangeRate: Dec;
  exchangeRateDate: IsoDate | null;
  exchangeRateSource: 'MNB' | 'manual' | null;
  language: InvoiceLanguage;
  appearance: InvoiceAppearance;
  /** Seller data as printed. Snapshot taken from the profile; frozen at issuance. */
  seller: SellerProfile;
  customerId: string | null;
  /**
   * Drafts only: true – the buyer is the customer record `customerId` (given by customerId, saved with
   * saveCustomer, or the record of a copied invoice), not inline buyer data; the preview and issuing use
   * the record's current data. false – inline buyer data (also with a record's id), used as given. Absent
   * on drafts saved before drafts followed their record (the one-time pass decides) and on issued
   * documents: not kept at issuance.
   */
  customerFromRecord?: boolean;
  /** Buyer data as printed. Snapshot; frozen at issuance. */
  customer: CustomerData;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  /** Printed free-text comment. */
  comment: string | null;
  /** Internal note – never printed or reported. */
  internalNote: string | null;
  /** Buyer's order / reference number, printed if given. */
  orderNumber: string | null;
  reference: InvoiceReference | null;
  /**
   * The díjbekérő (id) this document was converted from (invoice_draft copyFromId); issuing carries the
   * payment recorded on that díjbekérő over (OpenSzamla.issue). Not printed, not reported.
   */
  proformaId?: string;
  /** Mandatory notations printed on the invoice (derived from VAT codes, seller status, document type). */
  notations: string[];
  // --- mutable after issuance -------------------------------------------------
  paymentStatus: PaymentStatus;
  paidAmount: Dec;
  paidDate: IsoDate | null;
  navStatus: NavStatus;
  navTransactionId: string | null;
  navMessages: NavMessage[];
  /**
   * The NAV environment (test / production) navStatus, navTransactionId and navMessages belong to; absent when no
   * NAV system is involved yet. A report accepted by the test system is no report in production.
   */
  navEnvironment?: 'test' | 'production';
  /** For issued invoices: id of the storno invoice that cancelled it. */
  cancelledById: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  issuedAt: IsoTimestamp | null;
  /** SHA-256 of the canonical JSON of the immutable part, set at issuance (integrity check). */
  contentHash: string | null;
}

// ---------------------------------------------------------------------------
// Validation & errors
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Stable machine-readable code, e.g. "CUSTOMER_TAX_NUMBER_REQUIRED". */
  code: string;
  /** Human readable explanation (Hungarian) with a hint how to fix it. */
  message: string;
  /** JSON-path-like pointer to the offending field, e.g. "lines[2].vatCode". */
  field?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Payment ledger
// ---------------------------------------------------------------------------

/**
 * Where a payment of the ledger comes from: recorded as a payment (manual), recorded at issue (mark_paid), or the
 * payment of the díjbekérő the invoice was made from, carried over at issue (proforma).
 */
export type PaymentSource = 'manual' | 'mark_paid' | 'proforma';

/** One payment of the ledger (a row of payments): money recorded on a document. */
export interface Payment {
  id: number;
  /** The document it was recorded on. */
  invoiceId: string;
  /** Payment date (the day the money was received or paid back). */
  date: IsoDate;
  /** Signed, in the document's currency: received (> 0); refunded to the buyer or reversed (< 0); 0 marks a 0 Ft document settled. */
  amount: Dec;
  source: PaymentSource;
  /** The number of the díjbekérő a carried payment came from; null otherwise. */
  reference: string | null;
  /** The 'invoice.payment' audit entry recording it. */
  auditId: number;
  createdAt: IsoTimestamp;
}

/** A row of payment_allocations: part of a payment allocated to a document of the chain (signed; rows of the same pair add up). */
export interface PaymentAllocation {
  id: number;
  paymentId: number;
  invoiceId: string;
  amount: Dec;
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type Actor = 'mcp' | 'cli' | 'web' | 'system';

export interface AuditEntry {
  id: number;
  at: IsoTimestamp;
  actor: Actor;
  action: string;
  entityType: 'invoice' | 'customer' | 'product' | 'series' | 'settings' | 'nav';
  entityId: string | null;
  details: Record<string, unknown>;
}
