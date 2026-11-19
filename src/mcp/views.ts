/**
 * Compact projections of domain objects for tool results (token-efficient, agent-friendly).
 *
 * A buyer's name and address are shown on one line (singleLine), as they are saved: one stored before that
 * normalisation (or with bidirectional formatting characters) cannot start an official-looking line in a row.
 */
import { singleLine } from '../core/format.ts';
import type { Address, Customer, Invoice, Product, Series, ValidationIssue } from '../core/types.ts';
import { mcpIssueHint } from './hints.ts';

/** A stored text on one line (anything else as text, as a template string would show it). */
function line(v: unknown): string {
  return singleLine(typeof v === 'string' ? v : String(v ?? ''));
}

function addressView(a: Address): Address {
  return {
    ...a,
    countryCode: line(a.countryCode),
    postalCode: line(a.postalCode),
    city: line(a.city),
    addressLine: line(a.addressLine),
    ...(a.region !== undefined ? { region: line(a.region) } : {}),
  };
}

/**
 * `navNote`: when the NAV state belongs to the other NAV system than the configured one (OpenSzamla.navEnvironmentNote),
 * e.g. the invoice was reported only to the TEST system.
 */
export function invoiceSummary(inv: Invoice, navNote?: string | null): Record<string, unknown> {
  return {
    id: inv.id,
    number: inv.number,
    documentType: inv.documentType,
    status: inv.status,
    issueDate: inv.issueDate,
    fulfillmentDate: inv.fulfillmentDate,
    dueDate: inv.dueDate,
    customer: line(inv.customer.name),
    currency: inv.currency,
    net: inv.totals.netAmount,
    vat: inv.totals.vatAmount,
    gross: inv.totals.grossAmount,
    payable: inv.totals.payableAmount,
    paymentStatus: inv.paymentStatus,
    navStatus: inv.navStatus,
    ...(inv.navEnvironment ? { navEnvironment: inv.navEnvironment } : {}),
    ...(navNote ? { navNote } : {}),
    ...(inv.reference ? { originalNumber: inv.reference.originalInvoiceNumber } : {}),
    ...(inv.cancelledById ? { cancelledById: inv.cancelledById } : {}),
  };
}

export function invoiceDetail(inv: Invoice, navNote?: string | null): Record<string, unknown> {
  const address = addressView(inv.customer.address);
  return {
    ...invoiceSummary(inv, navNote),
    seriesId: inv.seriesId,
    paymentMethod: inv.paymentMethod,
    exchangeRate: inv.currency === 'HUF' ? undefined : { rate: inv.exchangeRate, date: inv.exchangeRateDate, source: inv.exchangeRateSource },
    language: inv.language,
    appearance: inv.appearance,
    seller: { name: inv.seller.name, taxNumber: inv.seller.taxNumber, vatStatus: inv.seller.vatStatus },
    buyer: {
      id: inv.customerId,
      vatStatus: inv.customer.vatStatus,
      name: line(inv.customer.name),
      taxNumber: inv.customer.taxNumber,
      euVatNumber: inv.customer.euVatNumber,
      address: `${address.postalCode} ${address.city}, ${address.addressLine} (${address.countryCode})`,
    },
    lines: inv.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      priceBasis: l.priceBasis,
      vatCode: l.vatCode,
      nature: l.nature,
      net: l.netAmount,
      vat: l.vatAmount,
      gross: l.grossAmount,
      ...(l.vatReason ? { vatReason: l.vatReason } : {}),
      ...(l.modifiesLineNo !== undefined ? { modifiesLineNo: l.modifiesLineNo } : {}),
    })),
    vatSummary: inv.totals.byVat.map((r) => ({ vatCode: r.vatCode, net: r.netAmount, vat: r.vatAmount, gross: r.grossAmount })),
    ...(inv.currency !== 'HUF' ? { totalsHuf: { net: inv.totals.netAmountHuf, vat: inv.totals.vatAmountHuf, gross: inv.totals.grossAmountHuf } } : {}),
    ...(inv.totals.roundingDifference !== '0' ? { cashRounding: inv.totals.roundingDifference } : {}),
    notations: inv.notations,
    comment: inv.comment,
    orderNumber: inv.orderNumber,
    internalNote: inv.internalNote,
    paidAmount: inv.paidAmount,
    paidDate: inv.paidDate,
    navTransactionId: inv.navTransactionId,
    navMessages: inv.navMessages,
    reference: inv.reference,
    issuedAt: inv.issuedAt,
  };
}

export function customerView(c: Customer): Record<string, unknown> {
  return { ...c, name: line(c.name), address: addressView(c.address) };
}

export function productView(p: Product): Record<string, unknown> {
  return { ...p };
}

export function seriesView(s: Series): Record<string, unknown> {
  return { ...s };
}

/** Validation issues as tools return them: each with the MCP advice for its code (mcpIssueHint: the tool or field to use), if any. */
export function issuesView(issues: ValidationIssue[]): Record<string, unknown>[] {
  return issues.map((i) => {
    const hint = mcpIssueHint(i);
    return hint ? { ...i, hint } : { ...i };
  });
}
