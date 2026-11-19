/**
 * Domain Invoice → NAV invoiceData XML (namespace http://schemas.nav.gov.hu/OSA/3.0/data).
 *
 * CONTRACT FILE – keep the signatures. Element NAMES and ORDER follow invoiceData.xsd v3.0
 * exactly; every generated document is validated against the official XSD in
 * test/nav/invoice-data.test.ts. Rules implemented (NAV Interface Specification 3.0, chapter 2):
 * - VAT representation from ../core/vat.ts `getVatInfo(code).nav`; exemption/out-of-scope `reason`
 *   = line.vatReason ?? catalog notation (max 200 chars).
 * - PRIVATE_PERSON customers: customerVatStatus ONLY (no name, address, tax data – NAV rejects them).
 * - DOMESTIC: customerTaxNumber (taxpayerId/vatCode/countyCode) [+ groupMemberTaxNumber], name, address.
 *   OTHER: communityVatNumber (EU) or thirdStateTaxId (or a Hungarian tax number), name, address.
 * - Supplier: tax number split, groupMemberTaxNumber, communityVatNumber, name, simpleAddress,
 *   supplierBankAccountNumber (only when it matches BankAccountNumberType), individualExemption
 *   for alanyi adómentes sellers.
 * - advance: every line advanceData/advanceIndicator=true. final: advance deduction lines carry
 *   advanceIndicator=true + advancePaymentData.
 * - storno / modification: invoiceReference (originalInvoiceNumber, modifyWithoutMaster,
 *   modificationIndex) and lineModificationReference on every line (from line.modificationRef).
 *   Only lineOperation=CREATE is accepted (NAV ERROR 60 INVALID_LINE_OPERATION since 2023-09-18).
 * - cashAccountingIndicator only when the invoice carries the cash-accounting notation (169. § h).
 * - Amount formatting: plain decimal with "." and no grouping; monetary values with at most 2
 *   decimals, exchange rates with at most 6, quantities/unit prices with at most 10, VAT rates with
 *   at most 4 – exactly as the XSD types allow.
 * - Output: UTF-8 XML string with XML declaration (indented; whitespace between elements only);
 *   encodeInvoiceData makes the base64 invoiceData of it (gzip-compressed above 1 MB, spec 1.6.5).
 * Data that cannot be represented validly (missing supplier tax number, unparseable customer tax
 * number, over-long invoice number …) or that trips one of NAV's BLOCKING business validations
 * (spec 3.3.2, see assertNavBlockingRules) raises AppError('NAV_DATA_INVALID') instead of producing
 * a report NAV would reject.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { AppError } from '../core/errors.ts';
import { dec, roundDec, toDec } from '../core/decimal.ts';
import type { Address, CustomerData, CustomerVatStatus, Dec, Invoice, InvoiceLine, SellerProfile, VatCode } from '../core/types.ts';
import { toNavUnit } from '../core/units.ts';
import { getVatInfo, type VatCodeInfo } from '../core/vat.ts';
import { NAV_COMPRESS_ABOVE_BYTES, NAV_MAX_INVOICE_XML_BYTES, NAV_MAX_REQUEST_BYTES, NAV_NAMESPACES, type NavOperation, type NavTaxNumberParts } from './types.ts';
import { el, leaf, normalizeXmlText, opt, serializeXml, type XmlChild, type XmlElement } from './xml.ts';

export interface InvoiceDataOptions {
  /** completenessIndicator – true only when the XML itself is the e-invoice (not our case). Default false. */
  completenessIndicator?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Errors & value normalisation
// ---------------------------------------------------------------------------------------------

/**
 * The report is only built for issued documents, which cannot be changed – and whatever validation lets
 * through must be reportable, so a failure here is a program error. A correction or a storno does not help:
 * NAV accepts neither while the original is not reported (docs/nav-beallitas.md, 5.).
 */
const DATA_HINT =
  'Ez programhiba: a kiállítás előtti ellenőrzésnek ki kellett volna szűrnie. Ne állíts ki rá módosító vagy sztornó számlát – amíg az eredeti számla nincs a NAV-nál, azokat sem fogadja be. ' +
  'Jelezd a hibát a fejlesztőknek a hibaüzenettel együtt, és kérj segítséget (könyvelő, NAV ügyfélszolgálat): az eredeti számla jelentését pótolni kell.';

function dataError(message: string, field: string, hint: string = DATA_HINT): AppError {
  return new AppError('NAV_DATA_INVALID', message, { hint, details: { field } });
}

/** Free text for the SimpleTextNNNotBlankType family (see normalizeXmlText). */
const cleanText = normalizeXmlText;

function requiredText(value: string | null | undefined, maxLen: number, field: string, label: string): string {
  const s = cleanText(value, maxLen);
  if (!s) throw dataError(`Hiányzó adat a NAV-jelentéshez: ${label}.`, field);
  return s;
}

/** Identifiers (invoice numbers) must never be truncated. */
function identifier(value: string | null | undefined, maxLen: number, field: string, label: string): string {
  const s = cleanText(value, Number.MAX_SAFE_INTEGER);
  if (!s) throw dataError(`Hiányzó adat a NAV-jelentéshez: ${label}.`, field);
  if (Array.from(s).length > maxLen) throw dataError(`${label} legfeljebb ${maxLen} karakter lehet a NAV-nál: "${s}".`, field);
  return s;
}

function decimalOut(value: Dec, dp: number, totalDigits: number, field: string): string {
  let s: string;
  try {
    s = toDec(roundDec(value, dp));
  } catch {
    throw dataError(`Érvénytelen szám a NAV-jelentésben (${field}): ${String(value)}`, field);
  }
  const digits = s.replace('-', '').replace('.', '').replace(/^0+/, '');
  if (digits.length > totalDigits) throw dataError(`Túl nagy szám a NAV-jelentésben (${field}): ${s}`, field);
  return s;
}

/** base:MonetaryType – max 18 digits, 2 decimals. */
function money(value: Dec, field: string): string {
  return decimalOut(value, 2, 18, field);
}

/** QuantityType (quantity, unitPrice, unitPriceHUF) – max 22 digits, 10 decimals. */
function quantity(value: Dec, field: string): string {
  return decimalOut(value, 10, 22, field);
}

/** ExchangeRateType – max 14 digits, 6 decimals, > 0. */
function exchangeRate(value: Dec, field: string): string {
  const s = decimalOut(value, 6, 14, field);
  if (!dec(s).gt(0)) throw dataError(`Az árfolyamnak pozitívnak kell lennie (${field}): ${String(value)}`, field);
  return s;
}

/** RateType (vatPercentage) – between 0 and 1, max 4 decimals. */
function vatRate(value: Dec, field: string): string {
  const s = decimalOut(value, 4, 5, field);
  const d = dec(s);
  if (d.lt(0) || d.gt(1)) throw dataError(`Érvénytelen ÁFA-kulcs (${field}): ${String(value)}`, field);
  return s;
}

function isoDate(value: string | null | undefined, field: string, label: string): string {
  const s = (value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok =
    !!m &&
    s >= '2010-01-01' &&
    (() => {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.toISOString().slice(0, 10) === s;
    })();
  if (!ok) throw dataError(`Érvénytelen dátum a NAV-jelentéshez (${label}): ${s || '(üres)'}`, field);
  return s;
}

/**
 * Splits a Hungarian tax number: "12345676-1-23", "12345676123", "12345676" (törzsszám only) and
 * "HU12345676" are accepted. Returns null when the value is not a Hungarian tax number.
 * (Format only – the check digit is validated by core/validate.ts at data entry.)
 */
export function splitHuTaxNumber(input: string | null | undefined): NavTaxNumberParts | null {
  if (!input) return null;
  const s = input.trim().toUpperCase().replace(/^HU/, '').replace(/[\s.]/g, '');
  const m = /^(\d{8})(?:-?(\d)-?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const vatCode = m[2] ?? null;
  if (vatCode !== null && !/^[1-5]$/.test(vatCode)) return null;
  return { taxpayerId: m[1] as string, vatCode, countyCode: m[3] ?? null };
}

function requiredTaxNumber(input: string | null | undefined, field: string, label: string): NavTaxNumberParts {
  const t = splitHuTaxNumber(input);
  if (!t) throw dataError(`${label} hiányzik vagy nem magyar adószám formátumú (${input ? `"${input}"` : 'üres'}).`, field);
  return t;
}

/** CommunityVatNumberType ([A-Z]{2}[0-9A-Z]{2,13}); separators are removed. */
function communityVatNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.toUpperCase().replace(/[\s.\-]/g, '');
  return /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(s) ? s : null;
}

/** BankAccountNumberType: GIRO 2×8 / 3×8 digits (dashed) or IBAN; anything else → null. */
export function navBankAccount(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.replace(/\s+/g, '');
  const digits = compact.replace(/-/g, '');
  if (/^\d{16}$/.test(digits)) return `${digits.slice(0, 8)}-${digits.slice(8)}`;
  if (/^\d{24}$/.test(digits)) return `${digits.slice(0, 8)}-${digits.slice(8, 16)}-${digits.slice(16)}`;
  const iban = digits.toUpperCase();
  if (/^[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30}$/.test(iban)) return iban;
  return null;
}

/** PostalCodeType ([A-Z0-9][A-Z0-9\s\-]{1,8}[A-Z0-9]); NAV asks for "0000" when there is none. */
function postalCode(input: string | null | undefined): string {
  const re = /^[A-Z0-9][A-Z0-9 \-]{1,8}[A-Z0-9]$/;
  const s = (input ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (re.test(s)) return s;
  const stripped = s.replace(/[^A-Z0-9 \-]/g, '').trim();
  return re.test(stripped) ? stripped : '0000';
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

function taxNumberEl(name: string, t: NavTaxNumberParts, extra?: XmlChild): XmlElement {
  return el(name, [leaf('base:taxpayerId', t.taxpayerId), opt('base:vatCode', t.vatCode), opt('base:countyCode', t.countyCode), extra]);
}

function simpleAddress(addr: Address | undefined, field: string, who: string): XmlElement {
  const countryCode = (addr?.countryCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw dataError(`Érvénytelen országkód (${who} címe): ${addr?.countryCode ?? '(üres)'}`, `${field}.countryCode`);
  return el('base:simpleAddress', [
    leaf('base:countryCode', countryCode),
    opt('base:region', cleanText(addr?.region, 50)),
    leaf('base:postalCode', postalCode(addr?.postalCode)),
    leaf('base:city', requiredText(addr?.city, 255, `${field}.city`, `${who} címének települése`)),
    leaf('base:additionalAddressDetail', requiredText(addr?.addressLine, 255, `${field}.addressLine`, `${who} címe (utca, házszám)`)),
  ]);
}

function supplierInfo(seller: SellerProfile): XmlElement {
  const tax = requiredTaxNumber(seller.taxNumber, 'seller.taxNumber', 'Az eladó adószáma');
  const member = seller.groupMemberTaxNumber
    ? requiredTaxNumber(seller.groupMemberTaxNumber, 'seller.groupMemberTaxNumber', 'Az eladó csoporttagi adószáma')
    : null;
  return el('supplierInfo', [
    taxNumberEl('supplierTaxNumber', tax),
    member && taxNumberEl('groupMemberTaxNumber', member),
    opt('communityVatNumber', communityVatNumber(seller.euVatNumber)),
    leaf('supplierName', requiredText(seller.name, 512, 'seller.name', 'az eladó neve')),
    el('supplierAddress', simpleAddress(seller.address, 'seller.address', 'az eladó')),
    opt('supplierBankAccountNumber', navBankAccount(seller.bankAccount)),
    // "Értéke true, amennyiben az eladó (szállító) alanyi ÁFA mentes" (invoiceData.xsd)
    seller.vatStatus === 'aam' && leaf('individualExemption', true),
  ]);
}

function customerNameAndAddress(c: CustomerData): XmlElement[] {
  return [
    leaf('customerName', requiredText(c.name, 512, 'customer.name', 'a vevő neve')),
    el('customerAddress', simpleAddress(c.address, 'customer.address', 'a vevő')),
  ];
}

function customerInfo(c: CustomerData): XmlElement {
  switch (c.vatStatus) {
    case 'PRIVATE_PERSON':
      // NAV rejects (CUSTOMER_DATA_NOT_EXPECTED) any name/address/tax data of a private person.
      return el('customerInfo', [leaf('customerVatStatus', 'PRIVATE_PERSON')]);
    case 'DOMESTIC': {
      const tax = requiredTaxNumber(c.taxNumber, 'customer.taxNumber', 'A belföldi áfaalany vevő adószáma');
      const member = c.groupMemberTaxNumber
        ? requiredTaxNumber(c.groupMemberTaxNumber, 'customer.groupMemberTaxNumber', 'A vevő csoporttagi adószáma')
        : null;
      return el('customerInfo', [
        leaf('customerVatStatus', 'DOMESTIC'),
        el('customerVatData', taxNumberEl('customerTaxNumber', tax, member && taxNumberEl('groupMemberTaxNumber', member))),
        customerNameAndAddress(c),
      ]);
    }
    case 'OTHER': {
      let vatData: XmlElement | null = null;
      if (c.euVatNumber) {
        const v = communityVatNumber(c.euVatNumber);
        if (!v) {
          throw dataError(
            `A vevő közösségi adószáma érvénytelen: "${c.euVatNumber}" (formátum: országkód + szám, pl. DE123456789).`,
            'customer.euVatNumber',
          );
        }
        vatData = el('customerVatData', leaf('communityVatNumber', v));
      } else if (cleanText(c.thirdStateTaxId, 50)) {
        vatData = el('customerVatData', leaf('thirdStateTaxId', cleanText(c.thirdStateTaxId, 50) as string));
      } else if (c.taxNumber) {
        vatData = el('customerVatData', taxNumberEl('customerTaxNumber', requiredTaxNumber(c.taxNumber, 'customer.taxNumber', 'A vevő adószáma')));
      }
      return el('customerInfo', [leaf('customerVatStatus', 'OTHER'), vatData, customerNameAndAddress(c)]);
    }
    default:
      throw dataError(`Ismeretlen vevő ÁFA-státusz: ${String((c as { vatStatus: unknown }).vatStatus)}`, 'customer.vatStatus');
  }
}

const PAYMENT_METHODS = new Set(['TRANSFER', 'CASH', 'CARD', 'VOUCHER', 'OTHER']);
const APPEARANCES = new Set(['PAPER', 'ELECTRONIC', 'EDI', 'UNKNOWN']);

function currencyCode(invoice: Invoice): string {
  const cur = (invoice.currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw dataError(`Érvénytelen pénznem: ${invoice.currency}`, 'currency');
  return cur;
}

/** HUF value of one unit of the invoice currency as sent to NAV (HUF → exactly "1", NAV error 77). */
function headExchangeRate(invoice: Invoice): string {
  return currencyCode(invoice) === 'HUF' ? '1' : exchangeRate(invoice.exchangeRate, 'exchangeRate');
}

/**
 * cashAccountingIndicator means "the invoice carries the cash-accounting notation" (spec 2.2.2.4:
 * "Accounting indicator, if one is included in the invoice – as per Section 169 h) of the VAT Act").
 * core/calc.ts buildNotations prints „pénzforgalmi elszámolás” only for a cash-accounting seller AND
 * an invoice with a line taxed at a percentage rate (the scheme does not cover exempt, out-of-scope,
 * reverse-charge or margin-scheme supplies), so the data report must follow the same rule.
 */
function cashAccountingNotation(invoice: Invoice): boolean {
  return invoice.seller.cashAccounting === true && invoice.lines.some((l) => getVatInfo(l.vatCode).nav.kind === 'vatPercentage');
}

function invoiceDetail(invoice: Invoice): XmlElement {
  if (!PAYMENT_METHODS.has(invoice.paymentMethod)) throw dataError(`Érvénytelen fizetési mód: ${invoice.paymentMethod}`, 'paymentMethod');
  if (!APPEARANCES.has(invoice.appearance)) throw dataError(`Érvénytelen számla megjelenési forma: ${invoice.appearance}`, 'appearance');
  const orderNumber = cleanText(invoice.orderNumber, 100);
  return el('invoiceDetail', [
    leaf('invoiceCategory', 'NORMAL'),
    leaf('invoiceDeliveryDate', isoDate(invoice.fulfillmentDate, 'fulfillmentDate', 'teljesítés dátuma')),
    invoice.seller.smallBusiness && leaf('smallBusinessIndicator', true),
    leaf('currencyCode', currencyCode(invoice)),
    leaf('exchangeRate', headExchangeRate(invoice)),
    leaf('paymentMethod', invoice.paymentMethod),
    invoice.dueDate ? leaf('paymentDate', isoDate(invoice.dueDate, 'dueDate', 'fizetési határidő')) : null,
    cashAccountingNotation(invoice) && leaf('cashAccountingIndicator', true),
    leaf('invoiceAppearance', invoice.appearance),
    orderNumber ? el('conventionalInvoiceInfo', el('orderNumbers', leaf('orderNumber', orderNumber))) : null,
  ]);
}

/** NAV `reason` of an exemption / out-of-scope case: line override, else the catalog notation (≤ 200 chars). */
function vatReasonText(info: VatCodeInfo, override: string | null | undefined): string {
  return cleanText(override, 200) ?? cleanText(info.notationHu, 200) ?? cleanText(info.nameHu, 200) ?? info.code;
}

/** VatRateType – exactly one choice branch, as defined by the VAT catalog. */
function vatRateEl(name: 'lineVatRate' | 'vatRate', code: VatCode, reasonOverride: string | null | undefined): XmlElement {
  const info = getVatInfo(code);
  const nav = info.nav;
  switch (nav.kind) {
    case 'vatPercentage':
      return el(name, leaf('vatPercentage', vatRate(nav.value, `vat.${code}`)));
    case 'vatExemption':
      return el(name, el('vatExemption', [leaf('case', nav.case), leaf('reason', vatReasonText(info, reasonOverride))]));
    case 'vatOutOfScope':
      return el(name, el('vatOutOfScope', [leaf('case', nav.case), leaf('reason', vatReasonText(info, reasonOverride))]));
    case 'vatDomesticReverseCharge':
      return el(name, leaf('vatDomesticReverseCharge', true));
    case 'marginSchemeIndicator':
      return el(name, leaf('marginSchemeIndicator', nav.value));
    default:
      throw dataError(`Ismeretlen NAV ÁFA-típus: ${code}`, 'vatCode');
  }
}

function isCorrection(invoice: Invoice): boolean {
  return invoice.documentType === 'modification' || invoice.documentType === 'storno';
}

// ---------------------------------------------------------------------------------------------
// NAV blocking business validations (spec 3.3.2) that the data itself can trip
// ---------------------------------------------------------------------------------------------

/**
 * Exempt / out-of-scope VAT rates may not carry VAT. Blocking validations (spec 3.3.2), with their
 * operation scope – STORNO was left out of most of them so that old invoices stay cancellable:
 * 71 line + vatExemption (CREATE, MODIFY), 72 line + vatOutOfScope (CREATE, MODIFY, STORNO),
 * 74 summary + vatOutOfScope (CREATE, MODIFY), 80 summary + vatExemption (CREATE, MODIFY).
 */
function assertNoVatOnExemptLine(invoice: Invoice, code: VatCode, vatAmount: string, vatAmountHuf: string, field: string, where: 'line' | 'summary'): void {
  const kind = getVatInfo(code).nav.kind;
  if (kind !== 'vatExemption' && kind !== 'vatOutOfScope') return;
  const appliesToStorno = where === 'line' && kind === 'vatOutOfScope';
  if (invoice.documentType === 'storno' && !appliesToStorno) return;
  if (dec(vatAmount).isZero() && dec(vatAmountHuf).isZero()) return;
  const what = where === 'line' ? 'tétel' : 'ÁFA-összesítő sor';
  throw dataError(
    `${field}: a(z) ${code} (${kind === 'vatExemption' ? 'adómentes' : 'ÁFA hatályán kívüli'}) kódú ${what} ÁFA-összeget tartalmaz (${vatAmount}, HUF: ${vatAmountHuf}); a NAV ezt elutasítja, az ÁFA csak 0 lehet.`,
    `${field}.vatAmount`,
  );
}

/** Customer VAT statuses NAV accepts for a VAT case (blocking validations 67–70 and 73; CREATE, MODIFY). */
const CUSTOMER_STATUS_BY_CASE: Readonly<Record<string, readonly CustomerVatStatus[]>> = {
  KBAET: ['OTHER'],
  KBAUK: ['OTHER', 'PRIVATE_PERSON'],
  EUFAD37: ['OTHER'],
  EUFADE: ['OTHER'],
};

function allowedCustomerStatuses(code: VatCode): readonly CustomerVatStatus[] | null {
  const nav = getVatInfo(code).nav;
  if (nav.kind === 'vatDomesticReverseCharge') return ['DOMESTIC'];
  if (nav.kind === 'vatExemption' || nav.kind === 'vatOutOfScope') return CUSTOMER_STATUS_BY_CASE[nav.case] ?? null;
  return null;
}

/** "YYYY-MM-DD" + n years as a comparable date string (29 Feb stays 29 Feb, which still compares correctly). */
function plusYears(date: string, years: number): string {
  return `${String(Number(date.slice(0, 4)) + years).padStart(4, '0')}${date.slice(4)}`;
}

/**
 * The blocking validations of spec 3.3.2 that the invoice data can trip (the remaining ones –
 * customer data, HUF exchange rate, own unit of measure, mandatory line content, MODIFY lines,
 * line numbering, own invoice number of a modification, exempt lines with VAT – are enforced where
 * the element is built). Each would come back as ABORTED, so we refuse to build the report.
 */
function assertNavBlockingRules(invoice: Invoice): void {
  const type = invoice.documentType;
  const deliveryDate = isoDate(invoice.fulfillmentDate, 'fulfillmentDate', 'teljesítés dátuma');
  const issueDate = isoDate(invoice.issueDate, 'issueDate', 'kiállítás dátuma');

  // 4 INVOICE_LINE_MISSING (CREATE, STORNO): only a modification may come without lines.
  if (type !== 'modification' && invoice.lines.length === 0) {
    throw dataError('A számlának nincs tétele; a NAV tétel nélküli számlát (és sztornót) nem fogad el.', 'lines');
  }

  // 54 INVOICE_DELIVERY_DATE_LATE: delivery date at most issue date + 5 years.
  if (deliveryDate > plusYears(issueDate, 5)) {
    throw dataError(`A teljesítés dátuma (${deliveryDate}) több mint 5 évvel a kiállítás (${issueDate}) utánra esik; a NAV ezt elutasítja.`, 'fulfillmentDate');
  }

  // 76 INCONSISTENT_MODIFICATION_DATA_MODIFICATIONINDEX_UNREAL (MODIFY): modificationIndex ≤ 1000.
  if (type === 'modification' && invoice.reference && invoice.reference.modificationIndex > 1000) {
    throw dataError(`A módosítási sorszám (modificationIndex = ${invoice.reference.modificationIndex}) nem lehet 1000-nél nagyobb.`, 'reference.modificationIndex');
  }

  invoice.lines.forEach((line, i) => {
    const f = `lines[${i}]`;
    const nav = getVatInfo(line.vatCode).nav;
    // 14 INVALID_VAT_DATA: the 0% rate exists only for deliveries from 2024-01-01.
    if (nav.kind === 'vatPercentage' && dec(nav.value).isZero() && deliveryDate < '2024-01-01') {
      throw dataError(`A(z) ${line.lineNo}. tétel 0%-os ÁFA-kulcsa csak 2024-01-01-jei vagy későbbi teljesítésnél jelenthető (teljesítés: ${deliveryDate}).`, `${f}.vatCode`);
    }
    // 67–70, 73: VAT case vs. customer VAT status (CREATE, MODIFY – a storno only mirrors its original).
    const allowed = type === 'storno' ? null : allowedCustomerStatuses(line.vatCode);
    if (allowed && !allowed.includes(invoice.customer.vatStatus)) {
      throw dataError(
        `A(z) ${line.lineNo}. tétel ÁFA-kódja (${line.vatCode}) ${allowed.join(' vagy ')} vevőt kíván, a vevő státusza viszont ${invoice.customer.vatStatus}; a NAV ezt elutasítja.`,
        `${f}.vatCode`,
      );
    }
  });

  // 12 LINE_NUMBER_REFERENCE_NOT_UNIQUE (MODIFY, STORNO): one line per referenced line number.
  if (isCorrection(invoice)) {
    const seen = new Set<number>();
    invoice.lines.forEach((line, i) => {
      const ref = line.modificationRef?.lineNumberReference;
      if (ref === undefined) return;
      if (seen.has(ref)) {
        throw dataError(`A(z) ${line.lineNo}. tétel ugyanarra a sorszámra (${ref}) hivatkozik, mint egy korábbi tétel; a NAV ezt elutasítja (LINE_NUMBER_REFERENCE_NOT_UNIQUE).`, `lines[${i}].modificationRef`);
      }
      seen.add(ref);
    });
  }
}

function lineEl(invoice: Invoice, line: InvoiceLine, i: number): XmlElement {
  const f = `lines[${i}]`;
  if (line.lineNo !== i + 1) {
    throw dataError(
      `A tételek sorszámozása nem folyamatos (a(z) ${i + 1}. tétel sorszáma ${line.lineNo}); a NAV 1-től kezdődő, hézagmentes sorszámozást vár.`,
      `${f}.lineNo`,
    );
  }

  let modificationRef: XmlElement | null = null;
  if (isCorrection(invoice)) {
    const r = line.modificationRef;
    if (!r || !Number.isInteger(r.lineNumberReference) || r.lineNumberReference < 1 || (r.lineOperation !== 'CREATE' && r.lineOperation !== 'MODIFY')) {
      throw dataError(
        `A(z) ${line.lineNo}. tételnél hiányzik vagy hibás a NAV tételhivatkozás (lineModificationReference).`,
        `${f}.modificationRef`,
      );
    }
    if (r.lineOperation !== 'CREATE') {
      // Blocking validation 60 (INVALID_LINE_OPERATION, live since 2023-09-18): NAV rejects every
      // MODIFY line. It cannot be rewritten here: a CREATE line needs the next free line number of
      // the whole invoice chain, which only the service knows.
      throw dataError(
        `A(z) ${line.lineNo}. tétel lineOperation=MODIFY hivatkozással jelentené a(z) ${r.lineNumberReference}. sor módosítását; ezt a NAV elutasítja (INVALID_LINE_OPERATION).`,
        `${f}.modificationRef.lineOperation`,
        'Módosító és sztornó számlán minden tétel új sor: lineOperation=CREATE, a lineNumberReference a számlalánc eddigi legnagyobb sorszámát folytatja.',
      );
    }
    modificationRef = el('lineModificationReference', [leaf('lineNumberReference', r.lineNumberReference), leaf('lineOperation', r.lineOperation)]);
  }

  let advanceData: XmlElement | null = null;
  if (invoice.documentType === 'advance' || invoice.reference?.originalDocumentType === 'advance') {
    advanceData = el('advanceData', leaf('advanceIndicator', true));
  } else if (line.advanceDeduction) {
    const a = line.advanceDeduction;
    advanceData = el('advanceData', [
      leaf('advanceIndicator', true),
      el('advancePaymentData', [
        leaf('advanceOriginalInvoice', identifier(a.advanceInvoiceNumber, 50, `${f}.advanceDeduction.advanceInvoiceNumber`, 'Az előlegszámla sorszáma')),
        leaf('advancePaymentDate', isoDate(a.advancePaymentDate, `${f}.advanceDeduction.advancePaymentDate`, 'előleg fizetésének dátuma')),
        leaf('advanceExchangeRate', exchangeRate(a.advanceExchangeRate, `${f}.advanceDeduction.advanceExchangeRate`)),
      ]),
    ]);
  }

  const unit = toNavUnit(line.unit);
  const rate = headExchangeRate(invoice);
  const unitPrice = quantity(line.netUnitPrice, `${f}.netUnitPrice`);
  const unitPriceHuf = quantity(toDec(dec(line.netUnitPrice).times(dec(rate))), `${f}.unitPriceHUF`);
  const vatAmount = money(line.vatAmount, `${f}.vatAmount`);
  const vatAmountHuf = money(line.vatAmountHuf, `${f}.vatAmountHuf`);
  assertNoVatOnExemptLine(invoice, line.vatCode, vatAmount, vatAmountHuf, f, 'line');

  return el('line', [
    leaf('lineNumber', line.lineNo),
    modificationRef,
    advanceData,
    leaf('lineExpressionIndicator', true),
    leaf('lineNatureIndicator', line.nature),
    // lineExpressionIndicator=true makes description, quantity, unit and unit price mandatory
    // (blocking validation 13, MANDATORY_LINE_CONTENT_MISSING).
    leaf('lineDescription', requiredText(line.description, 512, `${f}.description`, `a(z) ${line.lineNo}. tétel megnevezése`)),
    leaf('quantity', quantity(line.quantity, `${f}.quantity`)),
    leaf('unitOfMeasure', unit.unitOfMeasure),
    unit.unitOfMeasure === 'OWN' && leaf('unitOfMeasureOwn', cleanText(unit.unitOfMeasureOwn, 50) ?? 'egység'),
    leaf('unitPrice', unitPrice),
    leaf('unitPriceHUF', unitPriceHuf),
    el('lineAmountsNormal', [
      el('lineNetAmountData', [leaf('lineNetAmount', money(line.netAmount, `${f}.netAmount`)), leaf('lineNetAmountHUF', money(line.netAmountHuf, `${f}.netAmountHuf`))]),
      vatRateEl('lineVatRate', line.vatCode, line.vatReason),
      el('lineVatData', [leaf('lineVatAmount', vatAmount), leaf('lineVatAmountHUF', vatAmountHuf)]),
      el('lineGrossAmountData', [
        leaf('lineGrossAmountNormal', money(line.grossAmount, `${f}.grossAmount`)),
        leaf('lineGrossAmountNormalHUF', money(line.grossAmountHuf, `${f}.grossAmountHuf`)),
      ]),
    ]),
  ]);
}

function invoiceSummary(invoice: Invoice): XmlElement {
  const t = invoice.totals;
  if (!t.byVat.length) throw dataError('A számla ÁFA-összesítője üres; a NAV legalább egy ÁFA-kulcs szerinti összesítést vár.', 'totals.byVat');
  const rows = t.byVat.map((r, i) => {
    // Same reason text as the lines of that VAT code (first override wins), so line and summary match.
    const reason = invoice.lines.find((l) => l.vatCode === r.vatCode && cleanText(l.vatReason, 200))?.vatReason;
    const f = `totals.byVat[${i}]`;
    const vatAmount = money(r.vatAmount, `${f}.vatAmount`);
    const vatAmountHuf = money(r.vatAmountHuf, `${f}.vatAmountHuf`);
    assertNoVatOnExemptLine(invoice, r.vatCode, vatAmount, vatAmountHuf, f, 'summary');
    return el('summaryByVatRate', [
      vatRateEl('vatRate', r.vatCode, reason),
      el('vatRateNetData', [leaf('vatRateNetAmount', money(r.netAmount, `${f}.netAmount`)), leaf('vatRateNetAmountHUF', money(r.netAmountHuf, `${f}.netAmountHuf`))]),
      el('vatRateVatData', [leaf('vatRateVatAmount', vatAmount), leaf('vatRateVatAmountHUF', vatAmountHuf)]),
      el('vatRateGrossData', [leaf('vatRateGrossAmount', money(r.grossAmount, `${f}.grossAmount`)), leaf('vatRateGrossAmountHUF', money(r.grossAmountHuf, `${f}.grossAmountHuf`))]),
    ]);
  });
  return el('invoiceSummary', [
    el('summaryNormal', [
      rows,
      leaf('invoiceNetAmount', money(t.netAmount, 'totals.netAmount')),
      leaf('invoiceNetAmountHUF', money(t.netAmountHuf, 'totals.netAmountHuf')),
      leaf('invoiceVatAmount', money(t.vatAmount, 'totals.vatAmount')),
      leaf('invoiceVatAmountHUF', money(t.vatAmountHuf, 'totals.vatAmountHuf')),
    ]),
    // The invoice gross total (not the 0/5 Ft rounded cash payable amount).
    el('summaryGrossData', [leaf('invoiceGrossAmount', money(t.grossAmount, 'totals.grossAmount')), leaf('invoiceGrossAmountHUF', money(t.grossAmountHuf, 'totals.grossAmountHuf'))]),
  ]);
}

function invoiceReference(invoice: Invoice): XmlElement | null {
  if (!isCorrection(invoice)) return null;
  const ref = invoice.reference;
  if (!ref) throw dataError('A módosító/sztornó számlához hiányzik az eredeti számla hivatkozása.', 'reference');
  if (!Number.isInteger(ref.modificationIndex) || ref.modificationIndex < 1) {
    throw dataError(`Érvénytelen módosítási sorszám (modificationIndex): ${ref.modificationIndex}`, 'reference.modificationIndex');
  }
  const original = identifier(ref.originalInvoiceNumber, 50, 'reference.originalInvoiceNumber', 'Az eredeti számla sorszáma');
  if (original === normalizeXmlText(invoice.number, Number.MAX_SAFE_INTEGER)) {
    // NAV ERROR INCORRECT_HEAD_DATA_MOD_REF_INVOICE_NUMBER: the modifying document needs its own number.
    throw dataError(`A módosító/sztornó okirat sorszáma nem egyezhet meg az eredeti számláéval (${original}).`, 'number');
  }
  return el('invoiceReference', [
    leaf('originalInvoiceNumber', original),
    leaf('modifyWithoutMaster', ref.modifyWithoutMaster === true),
    leaf('modificationIndex', ref.modificationIndex),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export function buildInvoiceDataXml(invoice: Invoice, opts: InvoiceDataOptions = {}): string {
  if (invoice.documentType === 'proforma') {
    throw new AppError('NAV_NOT_REPORTABLE', 'A díjbekérő nem számla, a NAV-nak nem kell jelenteni.', {
      hint: 'Csak kiállított számlákat (normál, előleg-, vég-, módosító és sztornó számla) kell jelenteni.',
    });
  }
  assertNavBlockingRules(invoice);
  const root = el(
    'InvoiceData',
    [
      leaf('invoiceNumber', identifier(invoice.number, 50, 'number', 'A számla sorszáma')),
      leaf('invoiceIssueDate', isoDate(invoice.issueDate, 'issueDate', 'kiállítás dátuma')),
      leaf('completenessIndicator', opts.completenessIndicator === true),
      el(
        'invoiceMain',
        el('invoice', [
          invoiceReference(invoice),
          el('invoiceHead', [supplierInfo(invoice.seller), customerInfo(invoice.customer), invoiceDetail(invoice)]),
          invoice.lines.length > 0 && el('invoiceLines', [leaf('mergedItemIndicator', false), invoice.lines.map((l, i) => lineEl(invoice, l, i))]),
          invoiceSummary(invoice),
        ]),
      ),
    ],
    { xmlns: NAV_NAMESPACES.data, 'xmlns:base': NAV_NAMESPACES.base },
  );
  return serializeXml(root);
}

// ---------------------------------------------------------------------------------------------
// Payload encoding and NAV's size limits (spec 1.6.5)
// ---------------------------------------------------------------------------------------------

/** Room for the rest of a manageInvoice request: header, user, software, token, one operation. */
const REQUEST_ENVELOPE_BYTES = 64 * 1024;

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;
}

function tooLarge(message: string): AppError {
  return new AppError('NAV_REPORT_TOO_LARGE', message, { hint: DATA_HINT, details: { field: 'lines' } });
}

/** gzip's magic bytes (an XML document starts with "<" or a byte order mark). */
function gzipped(b: Buffer): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * The invoiceData of one manageInvoice operation: base64 of the UTF-8 XML or – when that is longer than
 * NAV_COMPRESS_ABOVE_BYTES – base64(gzip -1 (xml)) with compressed: true (compressedContent; we send one invoice
 * per request). These are the bytes signed (requestSignature), stored with the submission and compared when
 * reconciling. Throws NAV_REPORT_TOO_LARGE above NAV's limits: 15 MB of XML per invoice, 10 MB per request.
 */
export function encodeInvoiceData(xml: string): { invoiceDataBase64: string; compressed: boolean } {
  const bytes = Buffer.from(xml, 'utf8');
  if (bytes.length > NAV_MAX_INVOICE_XML_BYTES) {
    throw tooLarge(`A számla NAV-adatszolgáltatása ${megabytes(bytes.length)}; a NAV számlánként legfeljebb ${megabytes(NAV_MAX_INVOICE_XML_BYTES)} adatot fogad el (tömörítetlenül).`);
  }
  const plain = bytes.toString('base64');
  if (plain.length <= NAV_COMPRESS_ABOVE_BYTES) return { invoiceDataBase64: plain, compressed: false };
  const packed = gzipSync(bytes, { level: 1 }).toString('base64');
  if (packed.length > NAV_MAX_REQUEST_BYTES - REQUEST_ENVELOPE_BYTES) {
    throw tooLarge(`A számla NAV-adatszolgáltatása tömörítve is ${megabytes(packed.length)}; egy NAV-kérés legfeljebb ${megabytes(NAV_MAX_REQUEST_BYTES)} lehet.`);
  }
  return { invoiceDataBase64: packed, compressed: true };
}

/**
 * The XML bytes of a base64 invoiceData – as stored with a submission (encodeInvoiceData) or as NAV returns it
 * (originalRequest, queryInvoiceData) – decompressed when it is gzip-compressed. Throws when it cannot be.
 */
export function decodeInvoiceData(invoiceDataBase64: string): Buffer {
  const raw = Buffer.from(invoiceDataBase64, 'base64');
  return gzipped(raw) ? gunzipSync(raw, { maxOutputLength: 2 * NAV_MAX_INVOICE_XML_BYTES }) : raw;
}

/**
 * Invoices of at most this many lines always fit NAV's limits: a line takes at most 12 KB of XML (escaping
 * included) and the rest of the report at most 256 KB, so even uncompressed their base64 stays below
 * 10 MB (test/nav/report-size.test.ts checks both bounds). Longer ones are built and measured.
 */
export const NAV_SIZE_SAFE_LINES = 500;

/**
 * Why the report of `invoice` – a draft too – would exceed NAV's size limits (encodeInvoiceData), or null.
 * A draft is measured with the longest number and the line references it can get when issued. Also null
 * when the report cannot be built from the data at all (validation tells why).
 */
export function navReportSizeProblem(invoice: Invoice): string | null {
  if (invoice.documentType === 'proforma' || invoice.lines.length <= NAV_SIZE_SAFE_LINES) return null;
  const sized: Invoice = {
    ...invoice,
    number: invoice.number ?? 'X'.repeat(50),
    lines: isCorrection(invoice)
      ? invoice.lines.map((l, i) => (l.modificationRef ? l : { ...l, modificationRef: { lineNumberReference: 9_000_000 + i, lineOperation: 'CREATE' as const } }))
      : invoice.lines,
  };
  let xml: string;
  try {
    xml = buildInvoiceDataXml(sized);
  } catch {
    return null;
  }
  try {
    encodeInvoiceData(xml);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** CREATE for normal/advance/final, MODIFY for modification, STORNO for storno invoices. */
export function navOperationFor(invoice: Invoice): NavOperation {
  switch (invoice.documentType) {
    case 'invoice':
    case 'advance':
    case 'final':
      return 'CREATE';
    case 'modification':
      return 'MODIFY';
    case 'storno':
      return 'STORNO';
    default:
      throw new AppError('NAV_NOT_REPORTABLE', `Ez a bizonylattípus nem jelentendő a NAV-nak: ${String(invoice.documentType)}`, {
        hint: 'A díjbekérő nem számla; csak kiállított számlákat kell jelenteni.',
      });
  }
}
