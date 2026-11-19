/**
 * MCP-specific advice for the service's errors and validation issues: the tools and fields that do what the message
 * says. The core and service texts are surface-neutral – the web UI and the command line show them too –, so the MCP
 * adapter adds this after the service's own hint, keyed by the stable error / issue code (and, where one code covers
 * several cases, by its details). Agents get the same guidance as before; nobody else sees tool or field names.
 */
import type { AppError } from '../core/errors.ts';
import type { ValidationIssue } from '../core/types.ts';

type Hint = string | ((details: Record<string, unknown>) => string | undefined);

const TAX_LOOKUP = 'MCP: a NAV adószám-lekérdezése (taxpayer_lookup) megmutatja, milyen adószámmal és névvel szerepel a partner a NAV-nál.';
const THIRD_STATE = 'MCP: harmadik országbeli (nem uniós) adóazonosító a thirdStateTaxId mezőbe kerül.';
const GROUP_MEMBER = 'MCP: a csoportazonosító szám a taxNumber, a csoporttag saját adószáma a groupMemberTaxNumber mező (seller_update, illetve customer_save).';
const ADDRESS = 'MCP: address { countryCode, postalCode, city, addressLine }.';
const RATE = 'MCP: az árfolyam az invoice_draft exchangeRate mezője (1 egység forintban).';
const CORRECTION = 'MCP: módosító számla: invoice_correct; sztornó: invoice_cancel_preview, majd invoice_cancel.';
const RECALCULATE = 'MCP: az invoice_draft { draftId } menti újra (és számolja újra) a piszkozatot.';
const NATURE = 'MCP: a tétel jellege a nature mező: PRODUCT (termék), SERVICE (szolgáltatás) vagy OTHER.';
const RECORD_PAYMENT = 'MCP: a befizetés rögzítése: invoice_record_payment.';
const NOT_A_DRAFT = 'MCP: a bizonylat adatai: invoice_get; kiállított számla sztornója: invoice_cancel_preview, majd invoice_cancel; módosító számla: invoice_correct.';

const seriesHint = (details: Record<string, unknown>): string => {
  const id = typeof details.seriesId === 'string' ? details.seriesId : '<a sorszámtartomány id-ja>';
  return `MCP: másik sorszámtartomány: seriesId (a lista: series_manage { action: "list" }; új piszkozatnál elhagyva az alapértelmezettet kapja); visszaállítás: series_manage { action: "update", id: "${id}", archived: false }.`;
};

/** By AppError code. */
const ERROR_HINTS: Readonly<Record<string, Hint>> = {
  INVALID_TAX_NUMBER: TAX_LOOKUP,
  INVALID_EU_VAT_NUMBER: THIRD_STATE,
  SELLER_NOT_CONFIGURED: 'MCP: seller_update.',
  DUPLICATE_CUSTOMER: (d) => `MCP: a meglévő vevő a customerId-val használható${typeof d.existingId === 'string' ? ` (customerId: "${d.existingId}")` : ''}; az adatai a customer_save-vel frissíthetők, az id megadásával.`,
  NOT_A_DRAFT,
  // A storno refused by validation has no draft to fix (its own hint says what to do); a customer's has no document type.
  VALIDATION_FAILED: (d) => (typeof d.documentType === 'string' && d.documentType !== 'storno' ? 'MCP: a piszkozat javítása: invoice_draft { draftId, … } – a hibák a details.issues-ban.' : undefined),
  STORNO_CHAIN_CHANGED: 'MCP: új előnézet és kód: invoice_cancel_preview { invoice, reason }, majd invoice_cancel az új kóddal.',
  SERIES_ARCHIVED: seriesHint,
  SERIES_MISSING: 'MCP: series_manage { action: "create", … , isDefault: true }.',
  INVALID_SERIES_PATTERN: 'MCP: series_manage { action: "update", id, pattern }.',
  NO_INVOICES: 'MCP: a bizonylatok és dátumaik: invoice_list.',
};

/** By validation issue code. */
const ISSUE_HINTS: Readonly<Record<string, Hint>> = {
  SELLER_MISSING: 'MCP: seller_update.',
  SELLER_BANK_ACCOUNT_MISSING: 'MCP: seller_update { bankAccount }.',
  SELLER_TAX_NUMBER_INVALID: TAX_LOOKUP,
  CUSTOMER_TAX_NUMBER_INVALID: TAX_LOOKUP,
  SELLER_GROUP_MEMBER_TAX_NUMBER_INVALID: TAX_LOOKUP,
  CUSTOMER_GROUP_MEMBER_TAX_NUMBER_INVALID: TAX_LOOKUP,
  SELLER_TAX_NUMBER_GROUP_MEMBER: GROUP_MEMBER,
  SELLER_GROUP_MEMBER_TAX_NUMBER_REQUIRED: GROUP_MEMBER,
  SELLER_GROUP_MEMBER_WITHOUT_GROUP: GROUP_MEMBER,
  CUSTOMER_TAX_NUMBER_GROUP_MEMBER: GROUP_MEMBER,
  SELLER_EU_VAT_NUMBER_INVALID: THIRD_STATE,
  CUSTOMER_EU_VAT_NUMBER_INVALID: THIRD_STATE,
  SELLER_ADDRESS_REQUIRED: ADDRESS,
  CUSTOMER_ADDRESS_REQUIRED: ADDRESS,
  EXCHANGE_RATE_MISSING: RATE,
  EXCHANGE_RATE_DATE_MISSING: RATE,
  CORRECTION_EXCHANGE_RATE_FIXED: RECALCULATE,
  REFERENCE_REQUIRED: CORRECTION,
  CORRECTION_SELLER_REGIME_MISMATCH: CORRECTION,
  LINES_REQUIRED: 'MCP: lines: [{ description, quantity, unit, unitPrice, vatCode }].',
  LINE_VAT_CODE_NOT_ALLOWED: 'MCP: a tétel ÁFA-kódja a vatCode, a jogalap (indoklás) a vatReason mező.',
  LINE_EXEMPTION_REFERENCE_RECOMMENDED: 'MCP: a jogszabályhely a tétel vatReason mezője (invoice_draft).',
  LINE_NATURE_MISMATCH: NATURE,
  EU_B2B_GOODS_WITH_HU_VAT: NATURE,
  EU_B2B_OTHER_WITH_HU_VAT: NATURE,
  LINE_ADVANCE_RATE_MISSING: 'MCP: a tétel advanceDeduction.advanceExchangeRate mezője.',
  FINAL_WITHOUT_ADVANCE_DEDUCTION: 'MCP: előleglevonó tétel: advanceDeduction { advanceInvoiceNumber, … }, negatív összeggel (invoice_draft).',
  LINE_AMOUNTS_INVALID: RECALCULATE,
  LINE_AMOUNTS_STALE: RECALCULATE,
  PROFORMA_PAYMENT_NOT_CARRIED: RECORD_PAYMENT,
  SERIES_ARCHIVED: seriesHint,
};

/** A text that already names a tool (snake_case, e.g. invoice_get) was written for MCP: nothing is added to it. */
const NAMES_A_TOOL = /\b[a-z]+(?:_[a-z]+)+\b/;

function lookup(table: Readonly<Record<string, Hint>>, code: string, details: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(table, code)) return undefined;
  const h = table[code] as Hint;
  return typeof h === 'string' ? h : h(details);
}

/** The hint of an AppError as an MCP tool result gives it: the service's hint, then the MCP advice for its code. */
export function mcpErrorHint(e: AppError): string | undefined {
  if (e.hint && NAMES_A_TOOL.test(e.hint)) return e.hint;
  const extra = lookup(ERROR_HINTS, e.code, e.details ?? {});
  return [e.hint, extra].filter(Boolean).join(' ') || undefined;
}

/** The MCP advice for a validation issue (a `hint` next to its message), if its code has one. */
export function mcpIssueHint(issue: ValidationIssue): string | undefined {
  return NAMES_A_TOOL.test(issue.message) ? undefined : lookup(ISSUE_HINTS, issue.code, {});
}
