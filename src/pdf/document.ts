/**
 * Invoice → pdfmake document definition (pure function, no I/O).
 *
 * Legal checklist (Áfa tv. 169. §, 170. §, 172. §; docs/research/02-jogi-kovetelmenyek.md):
 *   a) issue date – meta grid             b) number – header
 *   c) seller tax number (+ VAT-group member tax number, Art. 30. § (2)) – seller block
 *   d) buyer tax number / EU VAT number – buyer block (never for private persons)
 *   e) names and addresses – party blocks  f) description + quantity + unit – lines table
 *   g) fulfilment date – meta grid         i) tax base + net unit price – lines table, VAT summary
 *   j) VAT rate – lines table (VAT label), VAT summary      k) VAT amount – lines, summary, totals
 *   h) l) m) n) p) q) mandatory expressions – invoice.notations (printed verbatim, highlighted)
 *   170. § c) reference to the original invoice + modification index; e) modified line references
 *   172. § VAT in HUF for foreign currency – HUF columns in the VAT summary + HUF totals + rate
 *   Prohibitions: no VAT amount for AAM (187. § (2) c)), domestic reverse charge (142. § (7)) and
 *   second-hand margin schemes (222. § (1) b)); travel agencies need not show it (210/A. § (1)) and
 *   carry no VAT amount in the data model – these print "–" instead of an amount.
 *   2008. évi III. tv.: cash rounding as separate "Kerekítés" / "Fizetendő (kerekítve)" lines.
 *
 * Layout robustness (every line item and amount must be visible, whatever the data):
 * - long tokens (URLs, e-mail addresses, IDs) wrap at the cell edge instead of widening their column
 *   and pushing the amount columns off the page (wrapLong);
 * - amounts are printed with the decimals they are stored with (never silently rounded);
 * - a line item taller than a page is allowed to break across pages (pdfmake drops such an
 *   unbreakable row without any error).
 */
import type { Content, CustomTableLayout, Style, TableCell } from 'pdfmake';
import { currencyDecimals, dec, isZero, normDec } from '../core/decimal.ts';
import { formatDate, formatNumber, formatQuantity, primaryLang } from '../core/format.ts';
import type {
  Address,
  CustomerData,
  Dec,
  Invoice,
  InvoiceLanguage,
  InvoiceLine,
  SellerProfile,
  VatCode,
  VatSummaryRow,
} from '../core/types.ts';
import { getVatInfo, isPercentageCode } from '../core/vat.ts';
import type { DocDefinition } from './engine.ts';
import {
  countryName,
  DOCUMENT_SUBTITLES,
  DOCUMENT_TITLES,
  label,
  LABELS,
  modifiesLineLabel,
  PAYMENT_METHODS,
  pageLabel,
  pick,
  RATE_SOURCES,
  unitLabel,
  type Bilingual,
  type LabelKey,
} from './labels.ts';

/** Fully resolved rendering options (see renderInvoicePdf for the defaults). */
export interface DocumentOptions {
  draft: boolean;
  copy: boolean;
  softwareName: string;
}

/** U+00A0 no-break space (same grouping character as ../core/format.ts). */
const NBSP = String.fromCharCode(0xa0);

const COLOR = {
  text: '#1f2937',
  muted: '#6b7280',
  rule: '#cbd5e1',
  accent: '#0f3d5e',
  headFill: '#e8eef4',
  zebra: '#f7f9fb',
  boxFill: '#f7f9fb',
  noteFill: '#fff7e6',
  noteRule: '#d97706',
  red: '#b91c1c',
} as const;

const PAGE_MARGINS: [number, number, number, number] = [40, 40, 40, 52];

/**
 * VAT codes whose invoices must not show a VAT amount or rate: alanyi adómentes (Áfa tv. 187. § (2) c)),
 * belföldi fordított adózás (142. § (7)), különbözet szerinti szabályozás (222. § (1) b)); for travel
 * agencies (210/A. § (1)) showing it is not required and the data model has no VAT amount for them.
 */
const VAT_NOT_PRINTED: ReadonlySet<VatCode> = new Set<VatCode>([
  'AAM',
  'FAD',
  'KUL_UTAZAS',
  'KUL_HASZNALT',
  'KUL_MUALKOTAS',
  'KUL_REGISEG',
]);

const DASH = '–';

/**
 * OpenType features: standard/contextual ligatures OFF. Roboto's "fi"/"fl" ligature glyphs lose their
 * text mapping in the PDF ("official" would be extracted/copied as "ofcial"), and invoice text must
 * stay machine-readable. fontkit accepts a { tag: false } object to switch a default feature off;
 * the pdfmake typings only know the array form, hence the cast.
 */
const NO_LIGATURES = { liga: false, clig: false } as unknown as Style['fontFeatures'];

/**
 * Longest whitespace-free token (in characters) that is kept unbreakable, per context. pdfmake sizes
 * 'auto' and '*' columns from the widest unbreakable word, so a longer token (URL, e-mail address, ID
 * without separators) would widen its column until the neighbouring columns are pushed off the page –
 * in the lines table that hides every amount. Longer tokens wrap at the cell edge instead (wrapLong).
 * The limits are chosen so that the token fits the narrowest realistic width of its column.
 */
const MAX_TOKEN = {
  /** Invoice number in the header (15 pt bold, 'auto' column next to the title). */
  number: 24,
  /** Party name (10.5 pt bold, half page width). */
  partyName: 30,
  /** Address lines and identifiers of the parties (8.5 pt, half page width). */
  party: 36,
  /** Values of the date/payment grid (8.5 pt bold, a quarter of the page width). */
  meta: 20,
  /** Line description (8 pt, the '*' column of the lines table). */
  line: 22,
  /** Sub-line notes under a line description (7 pt). */
  lineNote: 24,
  /** Unit label: longer (custom) units may wrap instead of widening the quantity column. */
  unit: 12,
  /** Full-width blocks (notations, reference to the original invoice). */
  wide: 60,
} as const;

/**
 * Line items are kept on one page (dontBreakRows) only while every row is clearly shorter than a page:
 * pdfmake silently drops an unbreakable block that does not fit on an empty page, so an over-tall line
 * item would vanish from the invoice while the totals still contain it. Row heights are estimated
 * conservatively in text lines – a paragraph needs ceil(length / MIN_CHARS_PER_LINE) lines in the
 * narrowest realistic description column (~115 pt at 8 pt) – and 60 lines (~550 pt) leave room for the
 * repeated table header on an A4 page (~750 pt of content height).
 */
const MIN_CHARS_PER_LINE = 20;
const MAX_UNBREAKABLE_ROW_LINES = 60;

function estimatedLines(text: string): number {
  return text.split(/\r?\n/).reduce((n, paragraph) => n + Math.max(1, Math.ceil(paragraph.length / MIN_CHARS_PER_LINE)), 0);
}

/** Same guard for the notations box (kept on one page when it reasonably fits; full page width). */
const MAX_UNBREAKABLE_NOTATION_CHARS = 2000;

/** Same guard for the VAT summary + totals block (one row per VAT code; ~10 rows take a third of a page). */
const MAX_UNBREAKABLE_SUMMARY_ROWS = 10;

type Lang = InvoiceLanguage;
type NumLang = 'hu' | 'en';

interface Ctx {
  inv: Invoice;
  lang: Lang;
  nl: NumLang;
  cur: string;
  foreign: boolean;
  /**
   * Decimals of amounts in the invoice currency: the currency's decimals, or more when a stored amount
   * has more (e.g. fillér on a HUF invoice) – a printed amount must never differ from the stored one.
   */
  amountDp: number;
  /** Decimals used for HUF equivalents of a foreign currency invoice (0, or 2 if any value has fillér). */
  hufDp: number;
  opts: DocumentOptions;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function compact<T>(items: ReadonlyArray<T | null | undefined | false>): T[] {
  return items.filter((x): x is T => x !== null && x !== undefined && x !== false);
}

function L(key: LabelKey, ctx: Ctx): string {
  return label(key, ctx.lang);
}

function decimalsOf(v: Dec): number {
  const s = normDec(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Decimals to print a group of amounts with: `base`, or – if any stored value has more decimals – at
 * least 2 and as many as the values need, so that nothing is rounded away on the printout.
 */
function printDecimals(values: readonly Dec[], base: number): number {
  const needed = values.reduce((max, v) => Math.max(max, decimalsOf(v)), 0);
  return needed <= base ? base : Math.max(2, needed);
}

/**
 * Break opportunities inside a token that pdfmake's line breaker (Unicode UAX #14) also uses: after a
 * hyphen, en dash or slash that is followed by a letter ("KELET-MAGYAR", "ugyfelek/projekt"; not
 * "2026-117", "https://").
 */
const NATURAL_BREAK = /(?<=[-–/])(?=\p{L})/u;

/**
 * Runs of breaking white space, and the tokens between them. No-break spaces (U+00A0, U+2007, U+202F)
 * belong to the token: the line breaker never breaks there (amounts, IBANs and "10 db" rely on it).
 */
const TOKENS = /[^\S   ]+|(?:[^\s]|[   ])+/gu;
const BREAKING_SPACE = /^[^\S   ]/u;

/**
 * Text fragments of `text` in which every unbreakable run longer than `maxChars` – a token between
 * breaking spaces, or the part of it between natural break points – may wrap at any character (pdfmake
 * `wordBreak: 'break-all'`); everything else keeps normal word wrapping. See MAX_TOKEN for why this is
 * needed. `style` is applied to every fragment (pdfmake drops the style of a wrapper around nested text
 * arrays).
 */
export function wrapLong(text: string, maxChars: number, style: Style = {}): Content[] {
  const styled = Object.keys(style).length > 0;
  const out: Content[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) out.push(styled ? { text: plain, ...style } : plain);
    plain = '';
  };
  for (const [token] of text.matchAll(TOKENS)) {
    if (token.length <= maxChars || BREAKING_SPACE.test(token)) {
      plain += token;
      continue;
    }
    for (const part of token.split(NATURAL_BREAK)) {
      if (part.length <= maxChars) {
        plain += part;
      } else {
        flush();
        out.push({ text: part, wordBreak: 'break-all', ...style });
      }
    }
  }
  flush();
  if (out.length === 0) out.push(styled ? { text: '', ...style } : '');
  return out;
}

/** "1 234 Ft" / "1 234,50 EUR" (hu), "HUF 1,234" / "EUR 1,234.50" (en) – same conventions as formatMoney. */
function withCurrency(n: string, cur: string, nl: NumLang): string {
  if (nl === 'en') return `${cur}${NBSP}${n}`;
  return cur === 'HUF' ? `${n}${NBSP}Ft` : `${n}${NBSP}${cur}`;
}

/** Amount in invoice currency without currency suffix (table cells). */
function amount(v: Dec, ctx: Ctx): string {
  return formatNumber(v, ctx.amountDp, ctx.nl);
}

/** Amount with currency ("194 700 Ft", "1 234,50 EUR", "HUF 194,700"). */
function money(v: Dec, ctx: Ctx): string {
  return withCurrency(amount(v, ctx), ctx.cur, ctx.nl);
}

/** HUF equivalent of a foreign currency amount ("312 096 Ft"; 2 decimals if the invoice has fillér values). */
function huf(v: Dec, ctx: Ctx): string {
  return withCurrency(formatNumber(v, ctx.hufDp, ctx.nl), 'HUF', ctx.nl);
}

/** Unit price: at least the currency's decimals, more if the stored price has them (max 6 by calc rules). */
function unitPrice(v: Dec, ctx: Ctx): string {
  return formatNumber(v, printDecimals([v], currencyDecimals(ctx.cur)), ctx.nl);
}

function signed(text: string, v: Dec): string {
  return dec(v).isPositive() && !isZero(v) ? `+${text}` : text;
}

function rateText(ctx: Ctx): string {
  const r = formatQuantity(ctx.inv.exchangeRate, ctx.nl);
  return ctx.nl === 'en' ? `1 ${ctx.cur} = ${r} HUF` : `1 ${ctx.cur} = ${r}${NBSP}Ft`;
}

function rateSourceText(ctx: Ctx): string | null {
  const { exchangeRateSource: src, exchangeRateDate: date } = ctx.inv;
  // Unknown (future) sources are printed as stored instead of failing.
  const source = src ? (Object.hasOwn(RATE_SOURCES, src) ? pick(RATE_SOURCES[src], ctx.lang) : String(src)) : null;
  const parts = compact([source, date ? formatDate(date, ctx.nl) : null]);
  return parts.length ? parts.join(', ') : null;
}

/** IBAN printed in groups of four joined by no-break spaces ("HU42 1177 3016 …"); GIRO numbers as stored. */
export function bankAccountText(account: string): string {
  const iban = account.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) ? iban.replace(/(.{4})(?=.)/g, `$1${NBSP}`) : account.trim();
}

function isSoleTrader(name: string): boolean {
  return /(^|\s)e\.\s?v\.?$/i.test(name.trim()) || /egyéni vállalkozó/i.test(name);
}

// ---------------------------------------------------------------------------------------------
// Table layouts
// ---------------------------------------------------------------------------------------------

function pad(h: number, v: number): Pick<CustomTableLayout, 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom'> {
  return { paddingLeft: () => h, paddingRight: () => h, paddingTop: () => v, paddingBottom: () => v };
}

/**
 * Left padding of amount columns. Amounts are grouped with no-break spaces (about 2 pt wide), so with
 * the default 6 pt between two right-aligned columns "2 522 280 681 015" reads as a single number; a
 * 12 pt gap keeps neighbouring amounts clearly apart.
 */
export const NUMERIC_PADDING_LEFT = 9;

/**
 * Data table: accent rules around the header, hairlines between rows, zebra body rows. Columns from
 * `firstNumericCol` on hold amounts and get the wider left padding.
 */
function gridLayout(headerRows: number, firstNumericCol: number): CustomTableLayout {
  return {
    hLineWidth: (i, node) => (i === 0 || i === headerRows || i === node.table.body.length ? 0.8 : i < headerRows ? 0 : 0.3),
    vLineWidth: () => 0,
    hLineColor: (i: number) => (i <= headerRows ? COLOR.accent : COLOR.rule),
    fillColor: (row: number) => (row < headerRows ? COLOR.headFill : (row - headerRows) % 2 === 1 ? COLOR.zebra : null),
    ...pad(3, 3),
    paddingLeft: (i: number) => (i >= firstNumericCol ? NUMERIC_PADDING_LEFT : 3),
  };
}

const META_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => COLOR.rule,
  vLineColor: () => COLOR.rule,
  fillColor: () => COLOR.boxFill,
  ...pad(5, 3),
};

const TOTALS_LAYOUT: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0),
  vLineWidth: () => 0,
  hLineColor: () => COLOR.accent,
  ...pad(4, 2),
};

const NOTE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0,
  vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
  vLineColor: () => COLOR.noteRule,
  fillColor: () => COLOR.noteFill,
  ...pad(7, 4),
};

const BADGE_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 1.2,
  vLineWidth: () => 1.2,
  hLineColor: () => COLOR.red,
  vLineColor: () => COLOR.red,
  ...pad(6, 1),
};

/**
 * Table header cell. Narrow column labels carry "\n" (two short lines); bilingual headers are stacked:
 * Hungarian on top, English below in one smaller line.
 */
function th(key: LabelKey, ctx: Ctx, alignment: 'left' | 'right' | 'center' = 'left', rowSpan?: number): TableCell {
  const l: Bilingual = LABELS[key];
  const span = rowSpan ? { rowSpan } : {};
  if (ctx.lang === 'hu-en' && l.hu !== l.en) {
    return { stack: [{ text: l.hu, style: 'th' }, { text: l.en.replace(/\n/g, ' '), style: 'thSub' }], alignment, ...span };
  }
  return { text: ctx.lang === 'en' ? l.en : l.hu, style: 'th', alignment, ...span };
}

function right(text: string, extra: { bold?: boolean; color?: string } = {}): TableCell {
  return { text, alignment: 'right', noWrap: true, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function headerBlock(ctx: Ctx): Content {
  const { inv, lang, opts } = ctx;
  const title = DOCUMENT_TITLES[inv.documentType];
  const subtitle = DOCUMENT_SUBTITLES[inv.documentType];
  const proforma = inv.documentType === 'proforma';
  const left: Content[] = compact<Content>([
    { text: lang === 'en' ? title.en : title.hu, style: 'title' },
    lang === 'hu-en' ? { text: title.en, style: 'titleEn' } : null,
    subtitle ? { text: pick(subtitle, lang), style: 'subtitle' } : null,
    proforma ? { text: L('notAnInvoice', ctx), style: 'warning', margin: [0, 3, 0, 0] } : null,
    proforma ? { text: L('proformaNote', ctx), style: 'caption' } : null,
    opts.draft
      ? { text: L(inv.number === null ? 'draftNote' : 'draftNoteNumbered', ctx), style: 'warningSmall', margin: [0, 3, 0, 0] }
      : null,
  ]);
  const badge: Content | null = opts.copy
    ? {
        columns: [
          { width: '*', text: '' },
          {
            width: 'auto',
            table: { body: [[{ text: L('copy', ctx), bold: true, color: COLOR.red, fontSize: 11, characterSpacing: 1 }]] },
            layout: BADGE_LAYOUT,
          },
        ],
        margin: [0, 5, 0, 0],
      }
    : null;
  const rightCol: Content[] = compact<Content>([
    { text: L('number', ctx), style: 'caption', alignment: 'right' },
    { text: wrapLong(inv.number ?? L('draftNumber', ctx), MAX_TOKEN.number), style: 'number', alignment: 'right' },
    badge,
  ]);
  return {
    columns: [
      { width: '*', stack: left },
      { width: 'auto', stack: rightCol },
    ],
    columnGap: 16,
    margin: [0, 0, 0, 8],
  };
}

function referenceBlock(ctx: Ctx): Content | null {
  const ref = ctx.inv.reference;
  if (!ref) return null;
  const parts: Content[] = [
    { text: `${L('originalInvoice', ctx)}: ` },
    ...wrapLong(ref.originalInvoiceNumber, MAX_TOKEN.wide, { bold: true }),
    { text: `      ${L('modificationIndex', ctx)}: ` },
    { text: String(ref.modificationIndex), bold: true },
  ];
  const stack: Content[] = compact<Content>([
    { text: parts },
    ref.modifyWithoutMaster ? { text: L('modifyWithoutMaster', ctx), style: 'caption' } : null,
  ]);
  return {
    table: { widths: ['*'], body: [[{ stack }]] },
    layout: NOTE_LAYOUT,
    margin: [0, 0, 0, 8],
  };
}

function kv(key: LabelKey, value: string, ctx: Ctx): Content {
  return { text: [{ text: `${L(key, ctx)}: `, color: COLOR.muted }, ...wrapLong(value, MAX_TOKEN.party)] };
}

function addressLines(a: Address, ctx: Ctx, showCountry: boolean): Content[] {
  const cityLine = compact([a.postalCode, a.city]).join(' ');
  const lines: string[] =
    a.countryCode.toUpperCase() === 'HU' ? [compact([cityLine, a.addressLine]).join(', ')] : compact([a.addressLine, cityLine]);
  if (showCountry) lines.push(compact([a.region, countryName(a.countryCode, ctx.lang)]).join(', '));
  else if (a.region) lines.push(a.region);
  return lines.filter((l) => l.trim() !== '').map((text) => ({ text: wrapLong(text, MAX_TOKEN.party) }));
}

function sectionTitle(text: string): Content {
  return { text, style: 'section', margin: [0, 0, 0, 3] };
}

/** Identifiers of a party, set off from the address by a small gap. */
function identifiers(items: ReadonlyArray<Content | null>): Content {
  return { stack: compact(items), margin: [0, 4, 0, 0] };
}

function sellerBlock(s: SellerProfile, ctx: Ctx, showCountry: boolean): Content[] {
  const group = !!s.groupMemberTaxNumber;
  return [
    sectionTitle(L('seller', ctx)),
    { text: wrapLong(s.name, MAX_TOKEN.partyName), style: 'partyName' },
    ...addressLines(s.address, ctx, showCountry),
    identifiers([
      kv(group ? 'groupId' : 'taxNumber', s.taxNumber, ctx),
      group && s.groupMemberTaxNumber ? kv('groupMemberTaxNumber', s.groupMemberTaxNumber, ctx) : null,
      s.euVatNumber ? kv('euVatNumber', s.euVatNumber, ctx) : null,
      s.registrationNumber ? kv(isSoleTrader(s.name) ? 'soleTraderRegNumber' : 'companyRegNumber', s.registrationNumber, ctx) : null,
      s.bankAccount
        ? kv('bankAccount', s.bankName ? `${bankAccountText(s.bankAccount)} (${s.bankName})` : bankAccountText(s.bankAccount), ctx)
        : null,
      s.swift ? kv('swift', s.swift, ctx) : null,
      s.email ? kv('email', s.email, ctx) : null,
      s.phone ? kv('phone', s.phone, ctx) : null,
      s.website ? kv('website', s.website, ctx) : null,
    ]),
  ];
}

function buyerBlock(c: CustomerData, ctx: Ctx, showCountry: boolean): Content[] {
  // Private persons: name and address only (Áfa tv. 169. § e)); no tax identifiers are printed.
  const business = c.vatStatus !== 'PRIVATE_PERSON';
  const group = business && !!c.groupMemberTaxNumber;
  return [
    sectionTitle(L('buyer', ctx)),
    { text: wrapLong(c.name, MAX_TOKEN.partyName), style: 'partyName' },
    ...addressLines(c.address, ctx, showCountry),
    identifiers([
      business && c.taxNumber ? kv(group ? 'groupId' : 'taxNumber', c.taxNumber, ctx) : null,
      group && c.groupMemberTaxNumber ? kv('groupMemberTaxNumber', c.groupMemberTaxNumber, ctx) : null,
      business && c.euVatNumber ? kv('euVatNumber', c.euVatNumber, ctx) : null,
      business && c.thirdStateTaxId ? kv('thirdStateTaxId', c.thirdStateTaxId, ctx) : null,
      business && c.bankAccount ? kv('bankAccount', bankAccountText(c.bankAccount), ctx) : null,
      c.email ? kv('email', c.email, ctx) : null,
      c.phone ? kv('phone', c.phone, ctx) : null,
    ]),
  ];
}

function partiesBlock(ctx: Ctx): Content {
  const { seller, customer } = ctx.inv;
  const showCountry =
    seller.address.countryCode.toUpperCase() !== 'HU' || customer.address.countryCode.toUpperCase() !== 'HU';
  return {
    columns: [
      { width: '*', stack: sellerBlock(seller, ctx, showCountry) },
      { width: '*', stack: buyerBlock(customer, ctx, showCountry) },
    ],
    columnGap: 24,
    margin: [0, 4, 0, 10],
  };
}

interface MetaItem {
  label: string;
  value: string;
  sub?: string | null;
}

function metaBlock(ctx: Ctx): Content {
  const { inv } = ctx;
  const proforma = inv.documentType === 'proforma';
  const items: MetaItem[] = compact<MetaItem>([
    { label: L(proforma ? 'proformaDate' : 'issueDate', ctx), value: formatDate(inv.issueDate, ctx.nl) },
    { label: L(proforma ? 'expectedFulfillmentDate' : 'fulfillmentDate', ctx), value: formatDate(inv.fulfillmentDate, ctx.nl) },
    inv.dueDate ? { label: L('dueDate', ctx), value: formatDate(inv.dueDate, ctx.nl) } : null,
    { label: L('paymentMethod', ctx), value: pick(PAYMENT_METHODS[inv.paymentMethod], ctx.lang) },
    { label: L('currency', ctx), value: ctx.cur },
    ctx.foreign ? { label: L('exchangeRate', ctx), value: rateText(ctx), sub: rateSourceText(ctx) } : null,
    inv.orderNumber ? { label: L('orderNumber', ctx), value: inv.orderNumber } : null,
  ]);
  const cols = items.length <= 4 ? items.length : items.length <= 6 ? 3 : 4;
  const body: TableCell[][] = [];
  for (let i = 0; i < items.length; i += cols) {
    const row: TableCell[] = [];
    for (let j = 0; j < cols; j++) {
      const it = items[i + j];
      row.push(
        it
          ? {
              stack: compact<Content>([
                { text: it.label, style: 'caption' },
                { text: wrapLong(it.value, MAX_TOKEN.meta), bold: true },
                it.sub ? { text: it.sub, style: 'caption' } : null,
              ]),
            }
          : { text: '' },
      );
    }
    body.push(row);
  }
  return {
    table: { widths: Array.from({ length: cols }, () => '*'), body },
    layout: META_LAYOUT,
    margin: [0, 0, 0, 10],
  };
}

/** Quantity with unit: short units stay glued to the number; long (custom) units may wrap below it. */
function quantityCell(line: InvoiceLine, ctx: Ctx): TableCell {
  const unit = unitLabel(line.unit, ctx.lang).trim();
  const qty = formatQuantity(line.quantity, ctx.nl);
  if (!unit) return right(qty);
  if (unit.length <= MAX_TOKEN.unit) return right(`${qty}${NBSP}${unit}`);
  return { text: [{ text: qty, noWrap: true }, ' ', ...wrapLong(unit, MAX_TOKEN.unit)], alignment: 'right' };
}

function lineNotes(line: InvoiceLine, ctx: Ctx): string[] {
  const adv = line.advanceDeduction;
  return compact([
    line.modifiesLineNo !== undefined ? modifiesLineLabel(line.modifiesLineNo, ctx.lang) : null,
    adv
      ? `${L('advanceDeduction', ctx)}: ${adv.advanceInvoiceNumber} ` +
        `(${L('advancePaid', ctx)}: ${formatDate(adv.advancePaymentDate, ctx.nl)}` +
        `${ctx.foreign ? `, ${L('exchangeRate', ctx).toLowerCase()}: ${formatQuantity(adv.advanceExchangeRate, ctx.nl)}` : ''})`
      : null,
  ]);
}

function lineRow(line: InvoiceLine, ctx: Ctx): TableCell[] {
  const info = getVatInfo(line.vatCode);
  const vatShown = isPercentageCode(line.vatCode);
  const description: Content = { text: wrapLong(line.description, MAX_TOKEN.line) };
  const notes = lineNotes(line, ctx).map((n): Content => ({ text: wrapLong(n, MAX_TOKEN.lineNote), style: 'lineNote' }));
  return [
    { text: String(line.lineNo), alignment: 'right', color: COLOR.muted, noWrap: true },
    notes.length ? { stack: [description, ...notes] } : description,
    quantityCell(line, ctx),
    right(unitPrice(line.netUnitPrice, ctx)),
    right(amount(line.netAmount, ctx)),
    { text: info.label, alignment: 'center', noWrap: true },
    right(vatShown ? amount(line.vatAmount, ctx) : DASH),
    right(amount(line.grossAmount, ctx)),
  ];
}

function linesBlock(ctx: Ctx): Content {
  // Amounts are in the invoice currency (shown in the meta grid); the header repeats on every page.
  const header: TableCell[] = [
    th('colNo', ctx, 'right'),
    th('colDescription', ctx),
    th('colQuantity', ctx, 'right'),
    th('colUnitPrice', ctx, 'right'),
    th('colNet', ctx, 'right'),
    th('colVatRate', ctx, 'center'),
    th('colVat', ctx, 'right'),
    th('colGross', ctx, 'right'),
  ];
  const fits = ctx.inv.lines.map(
    (l) => estimatedLines(l.description) + lineNotes(l, ctx).reduce((n, note) => n + estimatedLines(note), 0) <= MAX_UNBREAKABLE_ROW_LINES,
  );
  return {
    table: {
      headerRows: 1,
      // keepWithHeaderRows makes header + first row one unbreakable block: only if that row fits
      keepWithHeaderRows: fits[0] === false ? 0 : 1,
      dontBreakRows: fits.every(Boolean),
      // Line numbers: 'auto' + noWrap, a fixed width would wrap "100" as "10" / "0".
      widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
      body: [header, ...ctx.inv.lines.map((l) => lineRow(l, ctx))],
    },
    layout: gridLayout(1, 2),
    style: 'table',
    margin: [0, 0, 0, 10],
  };
}

function vatName(code: VatCode, ctx: Ctx): string {
  const info = getVatInfo(code);
  return pick({ hu: info.nameHu, en: info.nameEn }, ctx.lang);
}

function vatSummaryBlock(ctx: Ctx): Content | null {
  const rows = ctx.inv.totals.byVat;
  if (rows.length === 0) return null;
  // Foreign currency: tax base and VAT per VAT code in HUF as well (Áfa tv. 172. §), under a
  // two-level header "EUR | HUF".
  const header: TableCell[][] = ctx.foreign
    ? [
        [
          th('colVatCode', ctx, 'left', 2),
          { text: ctx.cur, style: 'th', alignment: 'center', colSpan: 3 },
          {},
          {},
          { text: 'HUF', style: 'th', alignment: 'center', colSpan: 2 },
          {},
        ],
        [
          {},
          th('colNet', ctx, 'right'),
          th('colVat', ctx, 'right'),
          th('colGross', ctx, 'right'),
          th('colNet', ctx, 'right'),
          th('colVat', ctx, 'right'),
        ],
      ]
    : [[th('colVatCode', ctx), th('colNet', ctx, 'right'), th('colVat', ctx, 'right'), th('colGross', ctx, 'right')]];
  const columns = ctx.foreign ? 6 : 4;
  const body: TableCell[][] = [
    ...header,
    ...rows.map((r: VatSummaryRow): TableCell[] => {
      const shown = isPercentageCode(r.vatCode);
      return compact<TableCell>([
        { stack: [{ text: getVatInfo(r.vatCode).label, bold: true }, { text: vatName(r.vatCode, ctx), style: 'lineNote' }] },
        right(amount(r.netAmount, ctx)),
        right(shown ? amount(r.vatAmount, ctx) : DASH),
        right(amount(r.grossAmount, ctx)),
        ctx.foreign ? right(huf(r.netAmountHuf, ctx)) : null,
        ctx.foreign ? right(shown ? huf(r.vatAmountHuf, ctx) : DASH) : null,
      ]);
    }),
  ];
  return {
    stack: [
      sectionTitle(L('vatSummary', ctx)),
      {
        table: {
          headerRows: header.length,
          widths: ['*', ...Array.from({ length: columns - 1 }, () => 'auto' as const)],
          body,
        },
        layout: gridLayout(header.length, 1),
        style: 'table',
      },
    ],
  };
}

interface TotalRow {
  label: string;
  value: string;
  /** Grand total style (bigger, bold). */
  strong?: boolean;
  /** Bold at normal size. */
  bold?: boolean;
}

function totalsTable(rows: TotalRow[], title: string | null): Content {
  const body: TableCell[][] = rows.map((r) => {
    const bold = !!(r.strong || r.bold);
    return [
      { text: r.label, bold, color: bold ? COLOR.text : COLOR.muted, fontSize: r.strong ? 10 : 8.5 },
      { text: r.value, bold, fontSize: r.strong ? 11 : 8.5, alignment: 'right', noWrap: true },
    ];
  });
  return {
    stack: compact<Content>([
      title ? { text: title, style: 'caption', margin: [0, 0, 0, 2] } : null,
      { table: { widths: ['*', 'auto'], body }, layout: TOTALS_LAYOUT },
    ]),
  };
}

/** VAT rows are omitted when the invoice may not show VAT at all (AAM, F.Á., K.Á. only). */
function showsVatRows(inv: Invoice): boolean {
  return inv.lines.length === 0 || inv.lines.some((l) => !VAT_NOT_PRINTED.has(l.vatCode));
}

/** Totals in the invoice currency, with the cash rounding lines when they apply. */
function totalsBlock(ctx: Ctx): Content {
  const t = ctx.inv.totals;
  const main: TotalRow[] = showsVatRows(ctx.inv)
    ? [
        { label: L('netTotal', ctx), value: money(t.netAmount, ctx) },
        { label: L('vatTotal', ctx), value: money(t.vatAmount, ctx) },
        { label: L('grossTotal', ctx), value: money(t.grossAmount, ctx), strong: true },
      ]
    : [{ label: L('total', ctx), value: money(t.grossAmount, ctx), strong: true }];
  if (!isZero(t.roundingDifference)) {
    main.push({ label: L('rounding', ctx), value: signed(money(t.roundingDifference, ctx), t.roundingDifference) });
    main.push({ label: L('payableRounded', ctx), value: money(t.payableAmount, ctx), strong: true });
  }
  return totalsTable(main, null);
}

/** Foreign currency invoices: the totals in HUF under the exchange rate caption. */
function hufTotalsBlock(ctx: Ctx): Content {
  const t = ctx.inv.totals;
  // The VAT in HUF is the legally required figure (Áfa tv. 172. §) – bold.
  const hufRows: TotalRow[] = showsVatRows(ctx.inv)
    ? [
        { label: `${L('netTotal', ctx)} (HUF)`, value: huf(t.netAmountHuf, ctx) },
        { label: `${L('vatTotal', ctx)} (HUF)`, value: huf(t.vatAmountHuf, ctx), bold: true },
        { label: `${L('grossTotal', ctx)} (HUF)`, value: huf(t.grossAmountHuf, ctx) },
      ]
    : [{ label: `${L('total', ctx)} (HUF)`, value: huf(t.grossAmountHuf, ctx), bold: true }];
  return totalsTable(hufRows, `${L('inHuf', ctx)} – ${rateText(ctx)}`);
}

function summaryAndTotals(ctx: Ctx): Content {
  const summary = vatSummaryBlock(ctx);
  const totals = totalsBlock(ctx);
  const unbreakable = ctx.inv.totals.byVat.length <= MAX_UNBREAKABLE_SUMMARY_ROWS;
  if (!ctx.foreign) {
    return {
      columns: summary
        ? [
            { width: '*', stack: [summary] },
            { width: 230, stack: [{ text: '', margin: [0, 13, 0, 0] }, totals] },
          ]
        : [{ width: '*', text: '' }, { width: 270, stack: [totals] }],
      columnGap: 18,
      unbreakable,
      margin: [0, 0, 0, 12],
    };
  }
  // Foreign currency: the VAT summary (invoice currency + HUF columns) needs the full width; the HUF
  // totals sit left of the invoice-currency totals rather than below them, which would leave half of
  // the page empty and push the notations of an otherwise one-page invoice onto a second page.
  return {
    stack: compact<Content>([
      summary ? { stack: [summary], margin: [0, 0, 0, 8] } : null,
      {
        columns: [
          { width: '*', stack: [hufTotalsBlock(ctx)] },
          // empty caption line: aligns the two tables under the HUF caption
          { width: 250, stack: [{ text: '', style: 'caption', margin: [0, 0, 0, 2] }, totals] },
        ],
        columnGap: 18,
      },
    ]),
    unbreakable,
    margin: [0, 0, 0, 12],
  };
}

/**
 * Mandatory notations: invoice.notations verbatim. Older/hand-made documents without notations get
 * the catalog texts of their VAT codes (and „pénzforgalmi elszámolás” when the scheme applies, i.e. on
 * lines taxed at a percentage rate – Áfa tv. 196/B. §) so that 169. § h)–q) is never silently missing
 * from the printout. The statutory Hungarian expressions are kept on English invoices too
 * ("magyar / English"), as the law prescribes the expression itself.
 */
export function effectiveNotations(inv: Invoice): string[] {
  if (inv.notations.length > 0) return inv.notations;
  const out: string[] = [];
  const add = (hu: string, en: string | null): void => {
    const text = inv.language !== 'hu' && en ? `${hu} / ${en}` : hu;
    if (!out.includes(text)) out.push(text);
  };
  for (const line of inv.lines) {
    const info = getVatInfo(line.vatCode);
    if (line.vatReason) add(line.vatReason, null);
    else if (info.notationHu) add(info.notationHu, info.notationEn);
  }
  const cashAccounting = inv.seller.cashAccounting && inv.seller.vatStatus === 'normal';
  if (cashAccounting && inv.lines.some((l) => isPercentageCode(l.vatCode))) add('pénzforgalmi elszámolás', 'Cash accounting');
  return out;
}

function notationsBlock(ctx: Ctx): Content | null {
  const notations = effectiveNotations(ctx.inv);
  if (notations.length === 0) return null;
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: L('notations', ctx), style: 'caption', margin: [0, 0, 0, 2] },
              ...notations.map((n): Content => ({ text: wrapLong(n, MAX_TOKEN.wide), bold: true, fontSize: 9, margin: [0, 1, 0, 1] })),
            ],
          },
        ],
      ],
    },
    layout: NOTE_LAYOUT,
    // kept on one page – unless it could not fit on one (pdfmake would drop it, see MAX_UNBREAKABLE_ROW_LINES)
    unbreakable: notations.join('').length <= MAX_UNBREAKABLE_NOTATION_CHARS,
    margin: [0, 0, 0, 10],
  };
}

function commentBlock(ctx: Ctx): Content | null {
  const c = ctx.inv.comment?.trim();
  if (!c) return null;
  return {
    text: [{ text: `${L('comment', ctx)}: `, bold: true }, { text: c }],
    margin: [0, 0, 0, 8],
  };
}

function sellerFooterBlock(ctx: Ctx): Content | null {
  const f = ctx.inv.seller.invoiceFooter?.trim();
  return f ? { text: f, style: 'caption', margin: [0, 6, 0, 0] } : null;
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

function creationDate(inv: Invoice): Date {
  for (const candidate of [inv.issuedAt, inv.createdAt, `${inv.issueDate}T00:00:00.000Z`]) {
    if (!candidate) continue;
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

function hufDecimals(inv: Invoice): number {
  const t = inv.totals;
  const values = [
    t.netAmountHuf,
    t.vatAmountHuf,
    t.grossAmountHuf,
    ...t.byVat.flatMap((r) => [r.netAmountHuf, r.vatAmountHuf, r.grossAmountHuf]),
  ];
  return printDecimals(values, 0);
}

function amountDecimals(inv: Invoice, cur: string): number {
  const t = inv.totals;
  const values = [
    t.netAmount,
    t.vatAmount,
    t.grossAmount,
    t.payableAmount,
    t.roundingDifference,
    ...t.byVat.flatMap((r) => [r.netAmount, r.vatAmount, r.grossAmount]),
    ...inv.lines.flatMap((l) => [l.netAmount, l.vatAmount, l.grossAmount]),
  ];
  return printDecimals(values, currencyDecimals(cur));
}

export function buildInvoiceDocument(inv: Invoice, opts: DocumentOptions): DocDefinition {
  const lang = inv.language;
  const cur = inv.currency.toUpperCase();
  const ctx: Ctx = {
    inv,
    lang,
    nl: primaryLang(lang),
    cur,
    foreign: cur !== 'HUF',
    amountDp: amountDecimals(inv, cur),
    hufDp: hufDecimals(inv),
    opts,
  };
  const title = pick(DOCUMENT_TITLES[inv.documentType], lang);
  const numberText = inv.number ?? L('draftNumber', ctx);
  const footerLeft = compact([opts.copy ? L('copy', ctx) : null, `${title} ${numberText}`, opts.softwareName]).join('  ·  ');

  const content: Content[] = compact<Content>([
    headerBlock(ctx),
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.2, lineColor: COLOR.accent }], margin: [0, 0, 0, 8] },
    referenceBlock(ctx),
    partiesBlock(ctx),
    metaBlock(ctx),
    linesBlock(ctx),
    summaryAndTotals(ctx),
    notationsBlock(ctx),
    commentBlock(ctx),
    sellerFooterBlock(ctx),
  ]);

  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    language: lang === 'en' ? 'en' : 'hu',
    displayTitle: true,
    info: {
      title: inv.number ?? `${title} – ${L('draftNumber', ctx)}`,
      author: inv.seller.name,
      subject: `${title} ${numberText}`,
      creator: opts.softwareName,
      producer: opts.softwareName,
      creationDate: creationDate(inv),
    },
    // Fixed size: pdfmake's 'auto' size runs the diagonal text edge to edge (clipped at the corners).
    watermark: opts.draft
      ? { text: lang === 'en' ? LABELS.watermark.en : LABELS.watermark.hu, color: COLOR.red, opacity: 0.13, bold: true, fontSize: 54 }
      : undefined,
    footer: (currentPage: number, pageCount: number): Content => ({
      margin: [PAGE_MARGINS[0], 18, PAGE_MARGINS[2], 0],
      columns: [
        { width: '*', text: footerLeft, style: 'footer' },
        { width: 'auto', text: pageLabel(currentPage, pageCount, lang), style: 'footer', alignment: 'right' },
      ],
    }),
    content,
    defaultStyle: { font: 'Roboto', fontSize: 8.5, color: COLOR.text, lineHeight: 1.15, fontFeatures: NO_LIGATURES },
    styles: {
      title: { fontSize: 20, bold: true, color: COLOR.accent, characterSpacing: 0.5 },
      titleEn: { fontSize: 11, bold: true, color: COLOR.accent },
      subtitle: { fontSize: 9, color: COLOR.muted },
      number: { fontSize: 15, bold: true },
      caption: { fontSize: 7, color: COLOR.muted },
      footer: { fontSize: 7, color: COLOR.muted },
      warning: { fontSize: 10, bold: true, color: COLOR.red },
      warningSmall: { fontSize: 8, bold: true, color: COLOR.red },
      section: { fontSize: 8.5, bold: true, color: COLOR.accent },
      partyName: { fontSize: 10.5, bold: true },
      table: { fontSize: 8 },
      th: { fontSize: 7.5, bold: true },
      thSub: { fontSize: 6.5, color: COLOR.muted },
      lineNote: { fontSize: 7, color: COLOR.muted },
    },
  };
}
