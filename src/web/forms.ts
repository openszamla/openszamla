/**
 * Form fields → service inputs. Only input parsing happens here (enums, presence of the fields a
 * form needs, Hungarian number notation); every business rule stays in the service.
 */
import { AppError } from '../core/errors.ts';
import type { Address, Customer, CustomerData, Invoice, PriceBasis, Product, VatCode } from '../core/types.ts';
import { isVatCode } from '../core/vat.ts';
import type { CustomerInput, DraftInput, InvoiceDefaults, LineInput, ProductInput, SellerInput } from '../service/inputs.ts';
import {
  APPEARANCE,
  CUSTOMER_VAT_STATUS,
  isKeyOf,
  LANGUAGE,
  LINE_NATURE,
  PAYMENT_METHOD,
  PRICE_BASIS,
  SELLER_VAT_STATUS,
} from './labels.ts';

export const CUSTOMER_ID_RE = /^cus_[0-9a-f]{1,32}$/;
export const PRODUCT_ID_RE = /^prd_[0-9a-f]{1,32}$/;
export const INVOICE_ID_RE = /^inv_[0-9a-f]{1,32}$/;

/** Document types the web form offers (corrections and storno have dedicated flows). */
export const DRAFT_DOCUMENT_TYPES = ['invoice', 'advance', 'proforma'] as const;
export type DraftDocumentType = (typeof DRAFT_DOCUMENT_TYPES)[number];

export const MAX_LINES = 200;
/**
 * Line rows the draft form renders at least (it must work without JavaScript): the empty ones after the last filled
 * row (from the second row on) are spare rows (spareRowsFrom) – the form's script hides them until "Új tételsor
 * hozzáadása" asks for one.
 */
export const MIN_LINE_ROWS = 5;

function invalid(message: string, hint?: string): AppError {
  return new AppError('INVALID_INPUT', message, hint ? { hint } : {});
}

function field(f: URLSearchParams, name: string): string {
  return (f.get(name) ?? '').trim();
}

/** "1.000", "10.000", "615.943": one dot followed by exactly three digits – a thousands separator, or a decimal point? */
const DOT_GROUP = /^-?[1-9]\d{0,2}\.\d{3}$/;
/** "1.000.000", "12.345.678": two or more groups of three digits – only a thousands grouping reads so. */
const DOT_GROUPS_MANY = /^-?[1-9]\d{0,2}(?:\.\d{3}){2,}$/;
/** "1.000,50", "12.345.678,9": dots grouping the thousands and a decimal comma – how Hungarians write money. */
const DOT_GROUPS_DECIMAL_COMMA = /^-?[1-9]\d{0,2}(?:\.\d{3})+,\d+$/;

/**
 * Hungarian number notation → decimal string: "1 234,5" → "1234.5", "1.234,5" → "1234.5", "1.000.000" → "1000000".
 * "1.000" or "10.000" – one dot followed by exactly three digits, no comma – reads as a thousands separator to a
 * Hungarian and as a decimal point to the program: taken either way it can bill a thousand times too little or too
 * much, so it is refused (naming the field, `label`, and both ways to write it) instead of guessed. Anything else is
 * passed on as typed – the service refuses what is not a number. The forms never pre-fill that form themselves: stored
 * numbers are shown with a decimal comma (numberValue).
 */
export function numberInput(raw: string | null | undefined, label?: string): string {
  let s = (raw ?? '').trim().replace(/[\s\u00A0\u202F]/g, '');
  if (DOT_GROUPS_DECIMAL_COMMA.test(s)) return s.replace(/\./g, '').replace(',', '.');
  if (DOT_GROUPS_MANY.test(s)) return s.replace(/\./g, '');
  if (DOT_GROUP.test(s)) {
    throw invalid(
      `A(z) „${s}” nem egyértelmű${label ? ` a(z) „${label}” mezőben` : ''}: a pont ezres tagolás és tizedesjel is lehet.`,
      `Tizedes törtként vesszővel írd: ${s.replace('.', ',')}. Ezresként pont nélkül: ${s.replace('.', '')} (vagy szóközzel: ${s.replace('.', ' ')}).`,
    );
  }
  if (s.includes(',') && !s.includes('.') && s.indexOf(',') === s.lastIndexOf(',')) s = s.replace(',', '.');
  return s;
}

/**
 * A stored decimal string as the forms pre-fill it: with a decimal comma ("2.125" → "2,125"), the notation numberInput
 * reads back. With a decimal point a stored quantity of 2.125 or a price of 615.943 would be refused as ambiguous when
 * the form is saved unchanged.
 */
export function numberValue(stored: string): string {
  return /^-?\d+\.\d+$/.test(stored) ? stored.replace('.', ',') : stored;
}

function currencyInput(raw: string): string | undefined {
  const s = raw.trim().toUpperCase();
  if (!s) return undefined;
  if (!/^[A-Z]{3}$/.test(s)) throw invalid(`Érvénytelen pénznem: ${raw.trim()}`, 'Háromjegyű ISO-kódot adj meg, pl. HUF, EUR, USD.');
  return s;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

/** Every field of the customer forms (the draft form's inline buyer uses them with a "c_" prefix). */
export const CUSTOMER_FIELDS = [
  'vatStatus', 'name', 'taxNumber', 'groupMemberTaxNumber', 'euVatNumber', 'thirdStateTaxId', 'countryCode', 'postalCode', 'city', 'addressLine', 'region',
  'email', 'phone', 'bankAccount', 'note',
] as const;

/**
 * Customer form (optionally with a field-name prefix, e.g. "c_" inside the draft form). Every field of
 * CustomerData has a form field, so saving an unchanged form never drops data (e.g. one set through MCP).
 */
export function customerInputFrom(f: URLSearchParams, prefix = '', opts: { withArchived?: boolean } = {}): CustomerInput {
  const g = (n: string): string => field(f, prefix + n);
  const vatStatus = g('vatStatus');
  if (!isKeyOf(CUSTOMER_VAT_STATUS, vatStatus)) throw invalid('Válaszd ki a vevő típusát (belföldi áfaalany, egyéb vagy magánszemély).');
  const address: Address = { countryCode: (g('countryCode') || 'HU').toUpperCase(), postalCode: g('postalCode'), city: g('city'), addressLine: g('addressLine') };
  const region = g('region');
  if (region) address.region = region;
  // Every field is sent ("" clears it), so an update through this form replaces the whole record.
  const input: CustomerInput = {
    vatStatus,
    name: g('name'),
    address,
    taxNumber: g('taxNumber'),
    groupMemberTaxNumber: g('groupMemberTaxNumber'),
    euVatNumber: g('euVatNumber'),
    thirdStateTaxId: g('thirdStateTaxId'),
    email: g('email'),
    phone: g('phone'),
    bankAccount: g('bankAccount'),
  };
  if (f.has(`${prefix}note`)) input.note = g('note');
  if (opts.withArchived) input.archived = f.has(`${prefix}archived`);
  return input;
}

/** Form values of a customer record / of the buyer data stored on a draft. */
export function customerDataValues(c: CustomerData): Record<string, string> {
  return {
    vatStatus: c.vatStatus,
    name: c.name,
    taxNumber: c.taxNumber ?? '',
    groupMemberTaxNumber: c.groupMemberTaxNumber ?? '',
    euVatNumber: c.euVatNumber ?? '',
    thirdStateTaxId: c.thirdStateTaxId ?? '',
    countryCode: c.address.countryCode,
    postalCode: c.address.postalCode,
    city: c.address.city,
    addressLine: c.address.addressLine,
    region: c.address.region ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    bankAccount: c.bankAccount ?? '',
  };
}

export function customerValues(c: Customer | null): Record<string, string> {
  if (!c) return { vatStatus: 'DOMESTIC', countryCode: 'HU' };
  return { ...customerDataValues(c), note: c.note ?? '', archived: c.archived ? '1' : '' };
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export function productInputFrom(f: URLSearchParams, opts: { id?: string; withArchived?: boolean } = {}): ProductInput {
  const name = field(f, 'name');
  const unitPrice = numberInput(f.get('unitPrice'), 'Egységár');
  if (!unitPrice) throw invalid('Add meg az egységárat.', 'Pl. 15000 vagy 12,50.');
  const vatCode = field(f, 'vatCode');
  if (!isVatCode(vatCode)) throw invalid('Válassz ÁFA-kódot.');
  const priceBasis = field(f, 'priceBasis');
  const nature = field(f, 'nature');
  const input: ProductInput = {
    name,
    unit: field(f, 'unit'),
    unitPrice,
    priceBasis: isKeyOf(PRICE_BASIS, priceBasis) ? priceBasis : 'net',
    vatCode,
    sku: field(f, 'sku'),
    description: field(f, 'description'),
  };
  const currency = currencyInput(field(f, 'currency'));
  if (currency) input.currency = currency;
  if (isKeyOf(LINE_NATURE, nature)) input.nature = nature;
  if (opts.id) input.id = opts.id;
  if (opts.withArchived) input.archived = f.has('archived');
  return input;
}

// ---------------------------------------------------------------------------------------------
// Seller profile and invoice defaults
// ---------------------------------------------------------------------------------------------

export function sellerInputFrom(f: URLSearchParams): SellerInput {
  const g = (n: string): string => field(f, n);
  const orNull = (n: string): string | null => g(n) || null;
  const input: SellerInput = {
    name: g('name'),
    taxNumber: g('taxNumber'),
    groupMemberTaxNumber: orNull('groupMemberTaxNumber'),
    euVatNumber: orNull('euVatNumber'),
    bankAccount: orNull('bankAccount'),
    bankName: orNull('bankName'),
    swift: orNull('swift'),
    email: orNull('email'),
    phone: orNull('phone'),
    website: orNull('website'),
    registrationNumber: orNull('registrationNumber'),
    invoiceFooter: orNull('invoiceFooter'),
    cashAccounting: f.has('cashAccounting'),
    smallBusiness: f.has('smallBusiness'),
  };
  const vatStatus = g('vatStatus');
  if (isKeyOf(SELLER_VAT_STATUS, vatStatus)) input.vatStatus = vatStatus;
  if (['countryCode', 'postalCode', 'city', 'addressLine', 'region'].some((n) => g(n) !== '' && !(n === 'countryCode' && g(n).toUpperCase() === 'HU'))) {
    input.address = { countryCode: (g('countryCode') || 'HU').toUpperCase(), postalCode: g('postalCode'), city: g('city'), addressLine: g('addressLine') };
    if (g('region')) input.address.region = g('region');
  }
  return input;
}

export function defaultsPatchFrom(f: URLSearchParams): Partial<InvoiceDefaults> {
  const patch: Partial<InvoiceDefaults> = {};
  const pm = field(f, 'paymentMethod');
  if (isKeyOf(PAYMENT_METHOD, pm)) patch.paymentMethod = pm;
  const days = field(f, 'paymentDays');
  if (days !== '') patch.paymentDays = /^-?\d+$/.test(days) ? Number(days) : Number.NaN;
  const lang = field(f, 'language');
  if (isKeyOf(LANGUAGE, lang)) patch.language = lang;
  const app = field(f, 'appearance');
  if (isKeyOf(APPEARANCE, app)) patch.appearance = app;
  const currency = currencyInput(field(f, 'currency'));
  if (currency) patch.currency = currency;
  const src = field(f, 'exchangeRateSource');
  if (src === 'MNB' || src === 'manual') patch.exchangeRateSource = src;
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

/**
 * Fields of a line row. `productId`, `nature` and `natureUnit` are hidden: they carry the product link
 * and the line nature (termék / szolgáltatás) of an existing line through an edit, so an explicitly set
 * nature (e.g. by an agent through MCP) is kept – as long as the unit it belongs to is unchanged.
 */
export const LINE_FIELDS = ['description', 'quantity', 'unit', 'unitPrice', 'priceBasis', 'vatCode', 'productId', 'nature', 'natureUnit'] as const;
export type LineField = (typeof LINE_FIELDS)[number];
export type LineValues = Record<LineField, string>;

const LINE_KEY_RE = new RegExp(`^lines\\[(\\d{1,3})\\]\\.(${LINE_FIELDS.join('|')})$`);

function emptyLine(): LineValues {
  return { description: '', quantity: '', unit: '', unitPrice: '', priceBasis: '', vatCode: '', productId: '', nature: '', natureUnit: '' };
}

/** Every line row of the form by index (blank rows included), in index order. */
export function lineRowsFrom(f: URLSearchParams): Array<{ index: number; values: LineValues }> {
  const rows = new Map<number, LineValues>();
  for (const [key, value] of f) {
    const m = LINE_KEY_RE.exec(key);
    if (!m?.[1] || !m[2]) continue;
    const index = Number(m[1]);
    const row = rows.get(index) ?? emptyLine();
    row[m[2] as LineField] = value;
    rows.set(index, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([index, values]) => ({ index, values }));
}

/** A row with nothing typed and no product chosen: not a line of the document. */
function isBlankRow(v: LineValues): boolean {
  const empty = (s: string): boolean => s.replace(/[\s\u00A0\u202F]/g, '') === '';
  return !v.description.trim() && empty(v.quantity) && empty(v.unitPrice) && !v.productId.trim();
}

/** Index of the first spare row: the rows from there on are empty (the first row never is one). */
export function spareRowsFrom(lines: readonly LineValues[]): number {
  let last = -1;
  lines.forEach((l, i) => {
    if (!isBlankRow(l)) last = i;
  });
  return Math.max(1, last + 1);
}

export interface ParsedDraft {
  input: DraftInput;
  /** Form row number (1-based) of each submitted line, to translate "lines[k]" in service messages. */
  rowNumbers: number[];
}

/** Inline buyer fields that show the user meant to enter a buyer (type and country always have a value). */
const INLINE_CUSTOMER_SIGNAL = CUSTOMER_FIELDS.filter((n) => n !== 'vatStatus' && n !== 'countryCode' && n !== 'note');

/** Draft form → DraftInput (also used as DraftPatch for editing: every field is sent, lines replace all lines). */
export function draftInputFrom(f: URLSearchParams): ParsedDraft {
  const input: DraftInput = {};
  const docType = field(f, 'documentType');
  if (docType) {
    if (!(DRAFT_DOCUMENT_TYPES as readonly string[]).includes(docType)) throw invalid('Válassz bizonylattípust (számla, előlegszámla vagy díjbekérő).');
    input.documentType = docType as DraftDocumentType;
  }
  const customerId = field(f, 'customerId');
  if (customerId) {
    if (!CUSTOMER_ID_RE.test(customerId)) throw invalid('Érvénytelen vevőazonosító.', 'Válaszd ki a vevőt a listából.');
    input.customerId = customerId;
  } else if (INLINE_CUSTOMER_SIGNAL.some((n) => field(f, `c_${n}`) !== '')) {
    input.customer = customerInputFrom(f, 'c_');
    if (f.has('saveCustomer')) input.saveCustomer = true;
  }
  const fulfillmentDate = field(f, 'fulfillmentDate');
  if (fulfillmentDate) input.fulfillmentDate = fulfillmentDate;
  const dueDate = field(f, 'dueDate');
  if (dueDate) input.dueDate = dueDate;
  const pm = field(f, 'paymentMethod');
  if (isKeyOf(PAYMENT_METHOD, pm)) input.paymentMethod = pm;
  const currency = currencyInput(field(f, 'currency'));
  if (currency) input.currency = currency;
  const rate = numberInput(f.get('exchangeRate'), 'Árfolyam');
  if (rate) input.exchangeRate = rate;
  const lang = field(f, 'language');
  if (isKeyOf(LANGUAGE, lang)) input.language = lang;
  input.comment = field(f, 'comment');
  input.orderNumber = field(f, 'orderNumber');
  input.internalNote = field(f, 'internalNote');

  const lines: LineInput[] = [];
  const rowNumbers: number[] = [];
  for (const { index, values } of lineRowsFrom(f)) {
    if (isBlankRow(values)) continue;
    const row = index + 1;
    if (lines.length >= MAX_LINES) throw invalid(`Legfeljebb ${MAX_LINES} tétel adható meg egy bizonylaton.`);
    const productId = values.productId.trim();
    if (productId && !PRODUCT_ID_RE.test(productId)) throw invalid(`A(z) ${row}. tétel termékhivatkozása érvénytelen.`);
    const description = values.description.trim();
    const qty = numberInput(values.quantity, `${row}. tétel – mennyiség`);
    const price = numberInput(values.unitPrice, `${row}. tétel – egységár`);
    // A row with a product chosen from the list takes what is left empty from the product (the service fills it in):
    // its name, its unit and – with an empty unit price – the price together with its basis (net / gross) and VAT code.
    const fromProduct = productId !== '' && !price;
    if (!description && !productId) throw invalid(`A(z) ${row}. tételből hiányzik a megnevezés.`, 'Írd be a tétel megnevezését, vagy válassz terméket a listából.');
    if (!qty) throw invalid(`A(z) ${row}. tételből hiányzik a mennyiség.`);
    if (!price && !productId) throw invalid(`A(z) ${row}. tételből hiányzik az egységár.`, 'Az egységár a számla pénznemében értendő; a negatív érték is megengedett (pl. engedmény).');
    const line: LineInput = { quantity: qty };
    if (description) line.description = description;
    if (price) line.unitPrice = price;
    const unit = values.unit.trim();
    if (unit) line.unit = unit;
    const nature = values.nature.trim();
    if (isKeyOf(LINE_NATURE, nature) && values.natureUnit.trim() === unit) line.nature = nature;
    const basis = values.priceBasis.trim();
    if (isKeyOf(PRICE_BASIS, basis) && !fromProduct) line.priceBasis = basis as PriceBasis;
    const vat = values.vatCode.trim();
    if (vat && !fromProduct) {
      if (!isVatCode(vat)) throw invalid(`A(z) ${row}. tétel ÁFA-kódja ismeretlen.`);
      line.vatCode = vat as VatCode;
    }
    if (productId) line.productId = productId;
    lines.push(line);
    rowNumbers.push(row);
  }
  if (lines.length === 0) throw invalid('Adj meg legalább egy tételt (megnevezés, mennyiség, egységár).');
  input.lines = lines;
  return { input, rowNumbers };
}

const LINE_FIELD_LABELS: Readonly<Record<string, string>> = {
  description: 'megnevezés',
  quantity: 'mennyiség',
  unit: 'mennyiségi egység',
  unitPrice: 'egységár',
  priceBasis: 'ár típusa',
  vatCode: 'ÁFA-kód',
  vatReason: 'adómentesség oka',
  nature: 'jelleg (termék / szolgáltatás)',
  productId: 'termék',
  advanceDeduction: 'előleg levonása',
  advanceInvoiceNumber: 'előlegszámla sorszáma',
  advancePaymentDate: 'az előleg fizetésének dátuma',
  advanceExchangeRate: 'az előleg árfolyama',
  modifiesLineNo: 'módosított sor',
};

/**
 * "lines[1].quantity" in a service message → "3. tétel – mennyiség" (using the form's row numbers); a nested field
 * ("lines[1].advanceDeduction.advanceInvoiceNumber") is named by its last part.
 */
export function localizeLineRefs(message: string, rowNumbers: readonly number[]): string {
  return message.replace(/lines\[(\d+)\]((?:\.[A-Za-z]+)*)/g, (whole: string, k: string, path: string) => {
    const row = rowNumbers[Number(k)];
    if (row === undefined) return whole;
    const last = path.split('.').filter(Boolean).pop();
    const label = last ? LINE_FIELD_LABELS[last] : undefined;
    return label ? `${row}. tétel – ${label}` : `${row}. tétel`;
  });
}

/** Values to (re)display in the draft form. */
export interface DraftFormState {
  values: Record<string, string>;
  lines: LineValues[];
}

function blankLine(vatCode: string): LineValues {
  return { ...emptyLine(), priceBasis: 'net', vatCode };
}

/**
 * Whether the web form can edit this draft without losing data: only the document types the form
 * offers, and no line data the form has no fields for (exemption reason override, advance deduction,
 * modified line reference). Other drafts are edited through MCP / CLI.
 */
export function draftEditableInWeb(inv: Invoice): boolean {
  return (
    inv.status === 'draft' &&
    (DRAFT_DOCUMENT_TYPES as readonly string[]).includes(inv.documentType) &&
    inv.lines.every((l) => l.vatReason === undefined && l.advanceDeduction === undefined && l.modifiesLineNo === undefined)
  );
}

function padLines(lines: LineValues[], vatCode: string): LineValues[] {
  const out = [...lines];
  while (out.length < MIN_LINE_ROWS) out.push(blankLine(vatCode));
  return out;
}

/** A line row filled from a saved product, quantity 1 (the form's product picker fills a row the same way). */
export function productLine(p: Product): LineValues {
  return { ...emptyLine(), description: p.name, quantity: '1', unit: p.unit, unitPrice: numberValue(p.unitPrice), priceBasis: p.priceBasis, vatCode: p.vatCode, productId: p.id };
}

/** The new-draft form; `product` ("Új számla ezzel a termékkel"): its first line is that product, in the product's currency. */
export function newDraftState(o: { defaults: InvoiceDefaults; today: string; defaultVatCode: string; customerId?: string; product?: Product }): DraftFormState {
  return {
    values: {
      documentType: 'invoice',
      customerId: o.customerId ?? '',
      c_vatStatus: 'DOMESTIC',
      c_countryCode: 'HU',
      fulfillmentDate: o.today,
      dueDate: '',
      paymentMethod: o.defaults.paymentMethod,
      currency: o.product?.currency ?? o.defaults.currency,
      language: o.defaults.language,
    },
    lines: padLines(o.product ? [productLine(o.product)] : [], o.defaultVatCode),
  };
}

export function draftStateFromForm(f: URLSearchParams, defaultVatCode: string): DraftFormState {
  const values: Record<string, string> = {};
  for (const [k, v] of f) if (!k.startsWith('lines[') && k !== '_csrf' && !(k in values)) values[k] = v;
  const lines = lineRowsFrom(f).map((r) => r.values);
  return { values, lines: padLines(lines.slice(0, MAX_LINES), defaultVatCode) };
}

/**
 * The exchange rate field is an explicit (manual) rate: sending it makes the service store the rate as
 * "kézi". So an MNB rate is NOT pre-filled – an unchanged save keeps it as an MNB rate (and lets the
 * service fetch the right one when the fulfilment date or the currency changes). The stored form (decimal point): the
 * form field shows numberValue() of it.
 */
export function manualRateValue(inv: Pick<Invoice, 'currency' | 'exchangeRate' | 'exchangeRateSource'>): string {
  if (inv.currency === 'HUF' || inv.exchangeRate === '0' || inv.exchangeRateSource === 'MNB') return '';
  return inv.exchangeRate;
}

/**
 * The edit form sends back every pre-filled field, so a field left as it was would count as given. Two of
 * them would change meaning that way: a due date derived from the payment term would become a fixed date
 * (no longer moving with the issue date), and a manual exchange rate would be confirmed again for a new
 * fulfilment date or currency (the rate belongs to the tax point, Áfa tv. 80. §). A field still holding
 * exactly its pre-filled text is not sent – the service then applies the same rules as for an MCP update
 * without it. `inv` must be the draft the form was rendered from (the caller checks the form's version).
 * Returns the manual rate that was not carried over, so the user can be told.
 */
export function withoutUnchangedPrefill(input: DraftInput, f: URLSearchParams, inv: Invoice): { input: DraftInput; droppedRate: string | null } {
  const out: DraftInput = { ...input };
  if (out.dueDate !== undefined && inv.dueDateExplicit !== true && field(f, 'dueDate') === inv.dueDate) delete out.dueDate;
  const prefilledRate = manualRateValue(inv);
  const rateDayOrCurrencyChanged = (out.fulfillmentDate ?? inv.fulfillmentDate) !== inv.fulfillmentDate || (out.currency ?? inv.currency) !== inv.currency;
  if (out.exchangeRate !== undefined && prefilledRate !== '' && rateDayOrCurrencyChanged && field(f, 'exchangeRate') === numberValue(prefilledRate)) {
    delete out.exchangeRate;
    return { input: out, droppedRate: prefilledRate };
  }
  return { input: out, droppedRate: null };
}

export function draftStateFromInvoice(inv: Invoice, defaultVatCode: string): DraftFormState {
  const values: Record<string, string> = {
    documentType: inv.documentType,
    customerId: inv.customerId ?? '',
    fulfillmentDate: inv.fulfillmentDate,
    dueDate: inv.dueDate ?? '',
    paymentMethod: inv.paymentMethod,
    currency: inv.currency,
    exchangeRate: numberValue(manualRateValue(inv)),
    language: inv.language,
    comment: inv.comment ?? '',
    orderNumber: inv.orderNumber ?? '',
    internalNote: inv.internalNote ?? '',
  };
  if (!inv.customerId) {
    for (const [k, v] of Object.entries(customerDataValues(inv.customer))) values[`c_${k}`] = v;
  } else {
    values.c_vatStatus = 'DOMESTIC';
    values.c_countryCode = 'HU';
  }
  const lines = inv.lines.map((l): LineValues => ({
    description: l.description,
    quantity: numberValue(l.quantity),
    unit: l.unit,
    unitPrice: numberValue(l.unitPrice),
    priceBasis: l.priceBasis,
    vatCode: l.vatCode,
    productId: l.productId ?? '',
    nature: l.nature,
    natureUnit: l.unit,
  }));
  return { values, lines: padLines(lines, defaultVatCode) };
}

/** The draft form's values by field name, the line fields as "lines[<index>].<field>". */
export function draftFormFields(state: DraftFormState): Record<string, string> {
  const out: Record<string, string> = { ...state.values };
  state.lines.forEach((line, i) => {
    for (const name of LINE_FIELDS) out[`lines[${i}].${name}`] = line[name];
  });
  return out;
}
