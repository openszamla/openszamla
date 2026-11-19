/**
 * Input shapes accepted by the service layer (MCP tools, CLI and web UI all funnel into these).
 * Numbers may be given as JS numbers or decimal strings; the service normalises them.
 */
import type { DecInput } from '../core/decimal.ts';
import type {
  Address,
  CurrencyCode,
  CustomerVatStatus,
  DocumentType,
  InvoiceAppearance,
  InvoiceLanguage,
  IsoDate,
  LineNature,
  PaymentMethod,
  PriceBasis,
  SellerVatStatus,
  SeriesKind,
  VatCode,
} from '../core/types.ts';

export interface SellerInput {
  name?: string;
  taxNumber?: string;
  groupMemberTaxNumber?: string | null;
  euVatNumber?: string | null;
  address?: Address;
  bankAccount?: string | null;
  bankName?: string | null;
  swift?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  registrationNumber?: string | null;
  vatStatus?: SellerVatStatus;
  cashAccounting?: boolean;
  smallBusiness?: boolean;
  invoiceFooter?: string | null;
}

/** Defaults used when creating drafts. */
export interface InvoiceDefaults {
  paymentMethod: PaymentMethod;
  /** Payment term in days for TRANSFER (fizetési határidő). */
  paymentDays: number;
  language: InvoiceLanguage;
  appearance: InvoiceAppearance;
  currency: CurrencyCode;
  /**
   * Exchange rate for foreign-currency invoices (Áfa tv. 80. §): 'MNB' = official MNB rate fetched
   * automatically (requires a prior notification to NAV!), 'manual' = the rate must be given on every
   * foreign-currency invoice (e.g. the selling rate of the seller's bank – no notification needed).
   */
  exchangeRateSource: 'MNB' | 'manual';
}

export interface SeriesInput {
  kind: SeriesKind;
  name: string;
  pattern: string;
  yearlyReset?: boolean;
  /** First sequence value (default 1) – useful when migrating from another invoicing program. */
  startSeq?: number;
  isDefault?: boolean;
}

export interface SeriesPatch {
  name?: string;
  pattern?: string;
  yearlyReset?: boolean;
  isDefault?: boolean;
  archived?: boolean;
}

/**
 * A customer to create (vatStatus, name and address required) or, with `id`, the changes to one:
 * fields left out keep their stored values, null or "" clears an optional one (saveCustomer).
 */
export interface CustomerInput {
  /** Update this customer instead of creating a new one. */
  id?: string;
  vatStatus?: CustomerVatStatus;
  name?: string;
  taxNumber?: string | null;
  groupMemberTaxNumber?: string | null;
  euVatNumber?: string | null;
  thirdStateTaxId?: string | null;
  /** The whole address; an empty countryCode means HU (on an update: the stored country). */
  address?: Address;
  email?: string | null;
  phone?: string | null;
  bankAccount?: string | null;
  note?: string | null;
  archived?: boolean;
}

export interface ProductInput {
  id?: string;
  name: string;
  unit: string;
  unitPrice: DecInput;
  priceBasis?: PriceBasis;
  currency?: CurrencyCode;
  vatCode: VatCode;
  nature?: LineNature;
  sku?: string | null;
  description?: string | null;
  archived?: boolean;
}

export interface LineInput {
  /** Take name, unit, price, VAT code and nature from this product (explicit fields override). */
  productId?: string;
  description?: string;
  quantity: DecInput;
  unit?: string;
  unitPrice?: DecInput;
  priceBasis?: PriceBasis;
  vatCode?: VatCode;
  /** Override of the exemption / out-of-scope reason text (e.g. the exact TAM legal basis). */
  vatReason?: string;
  nature?: LineNature;
  /** Only on modification invoices: number of the ORIGINAL line this delta line modifies. */
  modifiesLineNo?: number;
  /** Only on 'final' invoices: deducts an advance invoice. */
  advanceDeduction?: {
    advanceInvoiceNumber: string;
    advancePaymentDate: IsoDate;
    /**
     * Rate of the advance invoice (NAV advanceExchangeRate). Default: 1 on a HUF invoice; on a foreign-
     * currency one the rate of the advance invoice if it was issued in this program, otherwise required.
     */
    advanceExchangeRate?: DecInput;
  };
}

export interface DraftInput {
  /** 'invoice' (default), 'advance', 'final' or 'proforma'. Corrections use dedicated operations. */
  documentType?: Extract<DocumentType, 'invoice' | 'advance' | 'final' | 'proforma'>;
  seriesId?: string;
  customerId?: string;
  /** Inline buyer data (alternative to customerId). */
  customer?: CustomerInput;
  /** Also save the inline customer to the partner list. */
  saveCustomer?: boolean;
  issueDate?: IsoDate;
  fulfillmentDate?: IsoDate;
  /** A due date given as a date stays when the draft is issued on a later day (a derived one moves). */
  dueDate?: IsoDate;
  /** Payment term in days (used when dueDate is not given). */
  paymentDays?: number;
  paymentMethod?: PaymentMethod;
  currency?: CurrencyCode;
  /**
   * HUF per 1 unit of currency (a manual rate, bound to the fulfillment date). If omitted for a foreign
   * currency: the MNB rate of the fulfillment date (policy 'MNB'), or the rate is missing (policy 'manual').
   * A copy never inherits the rate of its source, and a manual rate is dropped when the fulfillment date changes.
   * An MNB rate is looked up again only when the fulfillment date or the currency changes. A correction
   * (modification) always keeps its original's rate: another value is refused (CORRECTION_EXCHANGE_RATE_FIXED).
   */
  exchangeRate?: DecInput;
  language?: InvoiceLanguage;
  appearance?: InvoiceAppearance;
  comment?: string | null;
  internalNote?: string | null;
  orderNumber?: string | null;
  lines?: LineInput[];
  /** Start from an existing document (duplicate a previous invoice, convert a díjbekérő). */
  copyFromId?: string;
}

/** Partial update of a draft. `lines`, when given, replaces all lines. */
export type DraftPatch = Omit<DraftInput, 'copyFromId'>;
