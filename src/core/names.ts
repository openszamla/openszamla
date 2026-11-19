/**
 * The Hungarian names of the codes a document carries – its type, state, payment method, payment state and NAV state –,
 * for what a person reads: the web UI's labels and the CSV exports an accountant opens in a spreadsheet. (The JSON
 * export, the MCP results and the NAV data keep the codes.)
 */
import type { DocumentType, Invoice, InvoiceStatus, NavStatus, PaymentMethod, PaymentStatus } from './types.ts';

export const DOCUMENT_TYPE_NAME: Readonly<Record<DocumentType, string>> = {
  invoice: 'számla',
  advance: 'előlegszámla',
  final: 'végszámla',
  modification: 'módosító számla',
  storno: 'sztornó számla',
  proforma: 'díjbekérő',
};

export const INVOICE_STATUS_NAME: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'piszkozat',
  issued: 'kiállított',
  cancelled: 'sztornózott',
};

export const PAYMENT_METHOD_NAME: Readonly<Record<PaymentMethod, string>> = {
  TRANSFER: 'átutalás',
  CASH: 'készpénz',
  CARD: 'bankkártya',
  VOUCHER: 'utalvány',
  OTHER: 'egyéb',
};

export const PAYMENT_STATUS_NAME: Readonly<Record<PaymentStatus, string>> = {
  unpaid: 'fizetetlen',
  partial: 'részben fizetve',
  paid: 'fizetve',
};

export const NAV_STATUS_NAME: Readonly<Record<NavStatus, string>> = {
  pending: 'függő',
  processing: 'feldolgozás alatt',
  done: 'rendben',
  done_with_warnings: 'figyelmeztetés',
  aborted: 'elutasítva',
  error: 'hiba',
  not_configured: 'nincs beállítva',
  not_applicable: 'nem jelentendő',
};

/** The state of a document in words: a díjbekérő is withdrawn, not cancelled by a storno. */
export function invoiceStatusName(inv: Pick<Invoice, 'status' | 'documentType'>): string {
  return inv.status === 'cancelled' && inv.documentType === 'proforma' ? 'visszavont' : INVOICE_STATUS_NAME[inv.status];
}
