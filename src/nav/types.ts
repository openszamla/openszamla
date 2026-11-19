/** Shared types of the NAV Online Számla v3.0 integration. */
import type { Address, NavMessage } from '../core/types.ts';

export type NavEnvironment = 'test' | 'production';

export const NAV_BASE_URLS: Record<NavEnvironment, string> = {
  test: 'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3',
  production: 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3',
};

/** XML namespaces of the v3.0 schemas (invoiceApi.xsd, invoiceData.xsd, invoiceBase.xsd, common.xsd). */
export const NAV_NAMESPACES = {
  api: 'http://schemas.nav.gov.hu/OSA/3.0/api',
  data: 'http://schemas.nav.gov.hu/OSA/3.0/data',
  base: 'http://schemas.nav.gov.hu/OSA/3.0/base',
  common: 'http://schemas.nav.gov.hu/NTCA/1.0/common',
} as const;

/**
 * The API operations (endpoint names under invoiceService/v3) used by OpenSzámla. queryTransactionList and
 * queryInvoiceData reconcile submissions whose outcome is unknown (timeout, lost answer) or that NAV rejected
 * as a duplicate (INVOICE_NUMBER_NOT_UNIQUE) with NAV.
 */
export type NavApiOperation =
  | 'tokenExchange'
  | 'manageInvoice'
  | 'queryTransactionStatus'
  | 'queryTransactionList'
  | 'queryInvoiceCheck'
  | 'queryInvoiceData'
  | 'queryTaxpayer';

/** NAV size limits (spec 1.6.5): a request body of at most 10 MB, an invoice of at most 15 MB uncompressed. */
export const NAV_MAX_REQUEST_BYTES = 10_000_000;
export const NAV_MAX_INVOICE_XML_BYTES = 15_000_000;
/** invoiceData whose base64 is longer than this is sent gzip-compressed (compressedContent=true, spec 1.6.5). */
export const NAV_COMPRESS_ABOVE_BYTES = 1_000_000;

/** One invoice operation of a manageInvoice request (index is 1-based and sequential). */
export interface NavInvoiceOperationInput {
  index: number;
  operation: NavOperation;
  invoiceDataBase64: string;
}

/** Split Hungarian tax number ("12345676-1-23" → 12345676 / 1 / 23). */
export interface NavTaxNumberParts {
  taxpayerId: string;
  vatCode: string | null;
  countyCode: string | null;
}

/** Technical user credentials ("technikai felhasználó") – SECRET, never log or return them. */
export interface NavCredentials {
  login: string;
  password: string;
  /** XML aláírókulcs */
  signingKey: string;
  /** XML cserekulcs */
  exchangeKey: string;
  /** 8-digit törzsszám of the taxpayer the technical user belongs to. */
  taxNumber: string;
}

/** The `software` block of every request (identifies this invoicing program). */
export interface NavSoftware {
  softwareId: string;
  softwareName: string;
  softwareOperation: 'LOCAL_SOFTWARE' | 'ONLINE_SERVICE';
  softwareMainVersion: string;
  softwareDevName: string;
  softwareDevContact: string;
  softwareDevCountryCode?: string;
  softwareDevTaxNumber?: string;
}

export type NavOperation = 'CREATE' | 'MODIFY' | 'STORNO';

export type NavInvoiceStatus = 'RECEIVED' | 'PROCESSING' | 'SAVED' | 'DONE' | 'ABORTED';

export interface NavProcessingResult {
  /** 1-based index of the invoice inside the manageInvoice request. */
  index: number;
  invoiceStatus: NavInvoiceStatus;
  messages: NavMessage[];
  /** The invoiceData of this index as NAV received it (base64) – only when asked for (returnOriginalRequest). */
  originalRequest?: string;
}

/** Processing state of a whole transaction in the transaction list (RequestStatusType). */
export type NavRequestStatus = 'RECEIVED' | 'PROCESSING' | 'SAVED' | 'FINISHED' | 'NOTIFIED';

/** One transaction of queryTransactionList (TransactionType; the submitting user's login itself is left out). */
export interface NavTransactionInfo {
  transactionId: string;
  /** When NAV received the request (UTC timestamp). */
  insDate: string;
  /** Sent by the technical user of this client (insCusUser), not by another user of the taxpayer. */
  ownUser: boolean;
  /** WEB, XML, MGM, OPG, OSZ … – who sent it. */
  source: string;
  requestStatus: NavRequestStatus;
  technicalAnnulment: boolean;
  itemCount: number;
}

/** Where a valid invoice NAV holds came from (queryInvoiceData auditData). */
export interface NavInvoiceAuditData {
  /** When NAV stored it (UTC timestamp). */
  insDate: string;
  /** WEB, XML, MGM, OPG, OSZ … */
  source: string;
  /** The transaction it came in, when it was sent through the machine interface. */
  transactionId: string | null;
  index: number | null;
}

/**
 * queryInvoiceData of one of the taxpayer's own (OUTBOUND) invoice numbers: 'found' when NAV holds a valid
 * invoice with it exactly once – invoiceData are the bytes of its InvoiceData XML (decompressed when it was
 * sent compressed) –, 'not_found' when NAV holds none, 'multiple' when it is valid more than once
 * (MULTIPLE_QUERY_RESULT_FOUND).
 */
export type NavInvoiceDataResult =
  | { status: 'found'; invoiceData: Buffer; compressed: boolean; audit: NavInvoiceAuditData }
  | { status: 'not_found' }
  | { status: 'multiple' };

/** The key data of an InvoiceData XML that tell whether it is the same invoice (null: not in the XML). */
export interface NavInvoiceKeys {
  invoiceNumber: string | null;
  issueDate: string | null;
  supplierTaxpayerId: string | null;
  customerVatStatus: string | null;
  customerTaxpayerId: string | null;
  customerCommunityVatNumber: string | null;
  customerThirdStateTaxId: string | null;
  customerName: string | null;
  currency: string | null;
  netAmountHuf: string | null;
  vatAmountHuf: string | null;
  grossAmountHuf: string | null;
  /** The lines in document order ([] without any). */
  lines: NavInvoiceLineKeys[];
}

/** The data of one InvoiceData line that tell whether it is the same line (null: not in the XML). */
export interface NavInvoiceLineKeys {
  description: string | null;
  quantity: string | null;
  /** unitOfMeasure; for OWN with its unitOfMeasureOwn text ("OWN:óra"). */
  unit: string | null;
  /** lineNetAmount in the invoice currency (null on a simplified line). */
  netAmount: string | null;
  /** The VAT choice of lineVatRate: vatPercentage, vatExemption (its case), vatOutOfScope, vatDomesticReverseCharge … */
  vatKind: string | null;
  /** Its value: the rate, the exemption or out-of-scope case, the margin scheme … (null when it has none). */
  vatValue: string | null;
}

export interface TaxpayerInfo {
  /** taxpayerValidity from NAV. */
  valid: boolean;
  name: string;
  shortName: string | null;
  taxpayerId: string;
  vatCode: string | null;
  countyCode: string | null;
  /** "12345676-1-23" when all parts are known. */
  formattedTaxNumber: string;
  incorporation: string | null;
  vatGroupMembership: string | null;
  addresses: Array<{ type: string; address: Address }>;
  infoDate: string | null;
}
