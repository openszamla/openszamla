/** Hungarian display labels of the domain enums (no business meaning); the names of a document's codes come from core/names.ts. */
import { DOCUMENT_TYPE_NAME, INVOICE_STATUS_NAME, NAV_STATUS_NAME, PAYMENT_METHOD_NAME, PAYMENT_STATUS_NAME } from '../core/names.ts';
import type {
  Actor,
  CustomerVatStatus,
  DocumentType,
  InvoiceAppearance,
  InvoiceLanguage,
  InvoiceStatus,
  LineNature,
  NavStatus,
  PaymentMethod,
  PaymentStatus,
  PriceBasis,
  SellerVatStatus,
  SeriesKind,
} from '../core/types.ts';

/** Visual tone of a badge / message. */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export const INVOICE_STATUS: Readonly<Record<InvoiceStatus, { label: string; tone: Tone }>> = {
  draft: { label: INVOICE_STATUS_NAME.draft, tone: 'neutral' },
  issued: { label: INVOICE_STATUS_NAME.issued, tone: 'info' },
  cancelled: { label: INVOICE_STATUS_NAME.cancelled, tone: 'err' },
};

export const DOCUMENT_TYPE: Readonly<Record<DocumentType, string>> = DOCUMENT_TYPE_NAME;

export const PAYMENT_STATUS: Readonly<Record<PaymentStatus, { label: string; tone: Tone }>> = {
  unpaid: { label: PAYMENT_STATUS_NAME.unpaid, tone: 'warn' },
  partial: { label: PAYMENT_STATUS_NAME.partial, tone: 'info' },
  paid: { label: PAYMENT_STATUS_NAME.paid, tone: 'ok' },
};

export const NAV_STATUS: Readonly<Record<NavStatus, { label: string; tone: Tone }>> = {
  pending: { label: NAV_STATUS_NAME.pending, tone: 'warn' },
  processing: { label: NAV_STATUS_NAME.processing, tone: 'info' },
  done: { label: NAV_STATUS_NAME.done, tone: 'ok' },
  done_with_warnings: { label: NAV_STATUS_NAME.done_with_warnings, tone: 'warn' },
  aborted: { label: NAV_STATUS_NAME.aborted, tone: 'err' },
  error: { label: NAV_STATUS_NAME.error, tone: 'err' },
  not_configured: { label: NAV_STATUS_NAME.not_configured, tone: 'warn' },
  not_applicable: { label: NAV_STATUS_NAME.not_applicable, tone: 'neutral' },
};

export const PAYMENT_METHOD: Readonly<Record<PaymentMethod, string>> = PAYMENT_METHOD_NAME;

export const CUSTOMER_VAT_STATUS: Readonly<Record<CustomerVatStatus, string>> = {
  DOMESTIC: 'belföldi áfaalany (cég, egyéni vállalkozó)',
  OTHER: 'egyéb (külföldi, vagy nem áfaalany szervezet)',
  PRIVATE_PERSON: 'magánszemély',
};

export const SELLER_VAT_STATUS: Readonly<Record<SellerVatStatus, string>> = {
  normal: 'általános szabályok szerint adózó',
  aam: 'alanyi adómentes (AAM)',
};

export const LANGUAGE: Readonly<Record<InvoiceLanguage, string>> = {
  hu: 'magyar',
  en: 'angol',
  'hu-en': 'kétnyelvű (magyar–angol)',
};

export const APPEARANCE: Readonly<Record<InvoiceAppearance, string>> = {
  ELECTRONIC: 'elektronikus',
  PAPER: 'papír',
};

export const PRICE_BASIS: Readonly<Record<PriceBasis, string>> = {
  net: 'nettó',
  gross: 'bruttó',
};

export const LINE_NATURE: Readonly<Record<LineNature, string>> = {
  PRODUCT: 'termék',
  SERVICE: 'szolgáltatás',
  OTHER: 'egyéb',
};

export const SERIES_KIND: Readonly<Record<SeriesKind, string>> = {
  invoice: 'számlák',
  proforma: 'díjbekérők',
};

export const ACTOR: Readonly<Record<Actor, string>> = {
  mcp: 'MCP (AI-ügynök)',
  cli: 'parancssor',
  web: 'webes felület',
  system: 'rendszer',
};

const AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  'invoice.draft.create': 'Piszkozat létrehozva',
  'invoice.draft.update': 'Piszkozat módosítva',
  'invoice.draft.delete': 'Piszkozat törölve',
  'invoice.correction.draft': 'Módosító számla piszkozata létrehozva',
  'invoice.storno.draft': 'Sztornó számla előkészítve',
  'invoice.issue': 'Kiállítva',
  'invoice.document': 'Eredeti PDF megőrizve',
  'invoice.pdf_regenerated': 'PDF újra előállítva (nem az eredeti)',
  'invoice.document_altered': 'A megőrzött eredeti PDF sérült vagy módosult – nem adható ki',
  'invoice.pdf_file_kept': 'A pdf/ mappában talált korábbi fájl más néven megőrizve',
  'invoice.payment': 'Befizetés rögzítve',
  'invoice.payment.status': 'Fizetési állapot (a módosító számlákkal együtt)',
  'proforma.cancel': 'Díjbekérő visszavonva',
  'nav.submit': 'Beküldve a NAV-nak',
  'nav.submit.error': 'NAV-beküldési hiba',
  'nav.submit.uncertain': 'NAV-beküldés: bizonytalan eredmény',
  'nav.clock': 'NAV-beküldés előtt: a gép órája eltér a NAV órájától',
  'nav.result': 'NAV feldolgozási eredmény',
  'nav.reconcile': 'Egyeztetés a NAV-val',
  'customer.create': 'Vevő létrehozva',
  'customer.update': 'Vevő módosítva',
  'product.create': 'Termék létrehozva',
  'product.update': 'Termék módosítva',
  'seller.create': 'Eladói adatok megadva',
  'seller.update': 'Eladói adatok módosítva',
  'settings.defaults': 'Alapértelmezések módosítva',
  'series.create': 'Sorszámtartomány létrehozva',
  'series.update': 'Sorszámtartomány módosítva',
  'payment.ledger': 'Korábbi befizetések átvéve a befizetési naplóba',
  export: 'Export',
  'export.tax_audit': 'Adóhatósági ellenőrzési adatszolgáltatás',
  'database.restore': 'Mentés visszaállítva',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTIONS[action] ?? action;
}

/**
 * Fields of the validation issues (ValidationIssue.field) as the web forms name them; a line's own fields
 * ("lines[k].<name>") are named by forms.ts localizeLineRefs.
 */
export const ISSUE_FIELD_LABELS: Readonly<Record<string, string>> = {
  documentType: 'bizonylat típusa',
  issueDate: 'kelte',
  fulfillmentDate: 'teljesítés dátuma',
  dueDate: 'fizetési határidő',
  paymentMethod: 'fizetési mód',
  currency: 'pénznem',
  exchangeRate: 'árfolyam',
  language: 'nyelv',
  orderNumber: 'megrendelésszám',
  comment: 'megjegyzés',
  seriesId: 'sorszámtartomány',
  number: 'sorszám',
  lines: 'tételek',
  totals: 'végösszeg',
  reference: 'hivatkozás az eredeti számlára',
  customer: 'vevő',
  'customer.vatStatus': 'vevő típusa',
  'customer.name': 'vevő neve',
  'customer.taxNumber': 'vevő adószáma',
  'customer.groupMemberTaxNumber': 'vevő csoporttagi adószáma',
  'customer.euVatNumber': 'vevő közösségi adószáma',
  'customer.thirdStateTaxId': 'vevő harmadik országbeli adóazonosítója',
  'customer.address': 'vevő címe',
  'customer.address.countryCode': 'vevő országa',
  'customer.address.postalCode': 'vevő irányítószáma',
  'customer.address.city': 'vevő települése',
  'customer.address.addressLine': 'vevő címe (utca, házszám)',
  'customer.email': 'vevő e-mail címe',
  'customer.bankAccount': 'vevő bankszámlaszáma',
  seller: 'eladó adatai',
  'seller.taxNumber': 'eladó adószáma',
  'seller.euVatNumber': 'eladó közösségi adószáma',
  'seller.bankAccount': 'eladó bankszámlaszáma',
  'seller.address': 'eladó címe',
};

/** Keys of `rec` as a typed list (for building select options in declaration order). */
export function keysOf<K extends string>(rec: Readonly<Record<K, unknown>>): K[] {
  return Object.keys(rec) as K[];
}

export function isKeyOf<K extends string>(rec: Readonly<Record<K, unknown>>, value: string | null | undefined): value is K {
  return typeof value === 'string' && Object.hasOwn(rec, value);
}
