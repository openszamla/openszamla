/**
 * Invoice arithmetic (pure functions, no I/O).
 *
 * CONTRACT FILE – keep the signatures. Rules the implementation must follow (verify the details
 * against docs/research/02-jogi-kovetelmenyek.md, 03-nav-online-szamla-api.md and 06-adatformatumok.md
 * and document every rounding decision in comments + tests):
 * - All arithmetic with ./decimal.ts (decimal.js), ROUND_HALF_UP (ties away from zero).
 * - Amount decimals per currency: currencyDecimals(currency) (HUF → 0, EUR → 2, …).
 * - priceBasis 'net':   net = round(qty × unitPrice); vat = round(net × rate); gross = net + vat.
 *   priceBasis 'gross': gross = round(qty × unitPrice); vat = round(gross × rate / (1 + rate)); net = gross − vat;
 *                       netUnitPrice = net / qty rounded to max 6 decimals (NAV QuantityType allows it).
 * - Non-percentage VAT codes (AAM, TAM, … see ./vat.ts) have vat = 0 and gross = net.
 * - HUF amounts: for HUF invoices identical to the amounts; for foreign currency each HUF amount is
 *   converted with the invoice exchange rate and rounded to 2 decimals (NAV MonetaryType); the
 *   summary HUF values must be consistent with what NAV validates (see the NAV research doc).
 * - VAT summary (byVat): one row per VatCode in first-appearance order; totals = sum of lines.
 * - payableAmount: for HUF + CASH apply the statutory 0/5 Ft rounding (2008. évi III. tv.) to the
 *   gross total; otherwise payableAmount = grossAmount. roundingDifference = payable − gross.
 * - Negative quantities/prices are allowed (storno, modification, advance deduction).
 *
 * Rounding decisions (the Áfa tv. prescribes no method – research 02 §10.1 – so these are
 * implementation choices). They keep lines, VAT summary rows and totals exactly consistent, but they do
 * NOT guarantee NAV's 1% tolerance between a summary row's net × rate and its VAT (WARN 890/891,
 * research 03 §8.4): on an invoice of many small lines the per-line roundings add up (e.g. 40 lines
 * of 90 Ft at 27%: row VAT 960, net × rate 972). Such WARNs do not block; the amounts are legally sound:
 * 1. Every LINE is rounded on its own to the currency decimals (HUF: whole forints); the VAT summary
 *    and the totals are plain sums of the rounded lines, so net + vat = gross holds exactly for every
 *    line, every summary row and the invoice total (NAV 754/880/881 never fire).
 * 2. Ties are rounded away from zero, so a storno line (negated quantity) rounds to the EXACT negative
 *    of the original line, and a storno invoice sums to the exact negation of the original (NAV
 *    1200/1220 consistency).
 * 3. Gross-priced lines: the VAT is extracted from the rounded gross amount (gross × r / (1 + r)),
 *    the net is the remainder; netUnitPrice = net / quantity is what NAV receives as unitPrice. It has
 *    6 decimals (NAV spec 2.3.12) unless quantity × unitPrice would then no longer round back to the
 *    net amount (very large quantities) – then up to 10 decimals (XSD QuantityType fractionDigits=10)
 *    are used, so NAV 740 (quantity × unitPrice ≈ lineNetAmount) never fires.
 * 4. Foreign currency: netHUF = round2(net × rate), vatHUF = round2(vat × rate) (Áfa tv. 172. §: the
 *    VAT charged converted with the 80. § rate; NAV 741/743 compare exactly these products),
 *    grossHUF = netHUF + vatHUF (consistency wins over a ≤ 0.01 HUF deviation from
 *    round2(gross × rate); NAV tolerance is ≥ 1 HUF).
 * 5. Cash rounding (2008. évi III. tv. 2. §) only changes the cash PAYABLE amount, never the tax
 *    base, the VAT or the gross total that are printed and reported to NAV (research 02 §10.2).
 * 6. Amount decimals are capped at 2 (amountDecimals): NAV MonetaryType has fractionDigits=2, so a
 *    3-decimal currency (KWD, BHD …) is rounded to 0.01 here – otherwise the XML builder would have
 *    to re-round every amount and the reported lines/summaries would no longer add up.
 * 7. Outputs are canonical decimal strings (no exponent, no trailing zeros, no "-0"); quantity and
 *    unitPrice of the input are canonicalised too.
 */
import { currencyDecimals, D, dec, roundDec, toDec, type DecInput, type DecValue } from './decimal.ts';
import type {
  CurrencyCode,
  CustomerData,
  Dec,
  DocumentType,
  InvoiceLanguage,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceReference,
  InvoiceTotals,
  PaymentMethod,
  SellerProfile,
  VatCode,
  VatSummaryRow,
} from './types.ts';
import { getVatInfo, isVatCode } from './vat.ts';

export interface CalcContext {
  currency: CurrencyCode;
  /** HUF value of 1 unit of `currency` ("1" for HUF). */
  exchangeRate: Dec;
}

/** HUF equivalents of a foreign-currency invoice: NAV MonetaryType allows 2 decimals. */
const FOREIGN_HUF_DECIMALS = 2;
/** NAV MonetaryType (every amount of the report): fractionDigits=2. */
const NAV_MONETARY_DECIMALS = 2;
/** Net unit price derived from a gross unit price: 6 decimals by default (NAV spec 2.3.12) … */
const NET_UNIT_PRICE_DECIMALS = 6;
/** … at most 10 when 6 are not enough (XSD QuantityType fractionDigits=10). */
const NET_UNIT_PRICE_MAX_DECIMALS = 10;

/**
 * Decimals of every AMOUNT of an invoice in `currency` (net, VAT, gross, totals): the currency's
 * minor unit (HUF 0, EUR 2, JPY 0 …) capped at NAV MonetaryType's 2 fraction digits.
 */
export function amountDecimals(currency: string): number {
  return Math.min(currencyDecimals(currency.trim()), NAV_MONETARY_DECIMALS);
}

function isHuf(currency: string): boolean {
  return currency.trim().toUpperCase() === 'HUF';
}

function isPercentage(code: VatCode): boolean {
  return getVatInfo(code).nav.kind === 'vatPercentage';
}

/** net / quantity with 6 decimals, or up to 10 when quantity × price must round back to `net`. */
function derivedNetUnitPrice(net: DecValue, qty: DecValue, dp: number): DecValue {
  const p = roundDec(net.div(qty), NET_UNIT_PRICE_DECIMALS);
  if (roundDec(qty.times(p), dp).eq(net)) return p;
  return roundDec(net.div(qty), NET_UNIT_PRICE_MAX_DECIMALS);
}

export function computeLine(input: InvoiceLineInput, lineNo: number, ctx: CalcContext): InvoiceLine {
  const where = `lines[${lineNo - 1}]`;
  const info = getVatInfo(input.vatCode);
  const dp = amountDecimals(ctx.currency);
  const qty = dec(input.quantity, `${where}.quantity`);
  const price = dec(input.unitPrice, `${where}.unitPrice`);
  const percentage = info.nav.kind === 'vatPercentage';
  // Non-percentage codes never carry VAT, whatever the catalog rate says.
  const rate = percentage ? dec(info.rate) : new D(0);

  let net: DecValue;
  let vat: DecValue;
  let gross: DecValue;
  let netUnitPrice: DecValue;
  if (input.priceBasis === 'gross') {
    gross = roundDec(qty.times(price), dp);
    vat = percentage ? roundDec(gross.times(rate).div(rate.plus(1)), dp) : new D(0);
    net = gross.minus(vat);
    // quantity 0 is a validation error, but must not crash the draft preview: fall back to the
    // net equivalent of the gross unit price.
    netUnitPrice = qty.isZero() ? roundDec(price.div(rate.plus(1)), NET_UNIT_PRICE_DECIMALS) : derivedNetUnitPrice(net, qty, dp);
  } else {
    net = roundDec(qty.times(price), dp);
    vat = percentage ? roundDec(net.times(rate), dp) : new D(0);
    gross = net.plus(vat);
    netUnitPrice = price;
  }

  let netHuf = net;
  let vatHuf = vat;
  let grossHuf = gross;
  if (!isHuf(ctx.currency)) {
    const xr = dec(ctx.exchangeRate, 'exchangeRate');
    netHuf = roundDec(net.times(xr), FOREIGN_HUF_DECIMALS);
    vatHuf = roundDec(vat.times(xr), FOREIGN_HUF_DECIMALS);
    grossHuf = netHuf.plus(vatHuf);
  }

  return {
    ...input,
    quantity: toDec(qty),
    unitPrice: toDec(price),
    lineNo,
    netUnitPrice: toDec(netUnitPrice),
    netAmount: toDec(net),
    vatAmount: toDec(vat),
    grossAmount: toDec(gross),
    netAmountHuf: toDec(netHuf),
    vatAmountHuf: toDec(vatHuf),
    grossAmountHuf: toDec(grossHuf),
  };
}

export function computeLines(inputs: InvoiceLineInput[], ctx: CalcContext): InvoiceLine[] {
  return inputs.map((l, i) => computeLine(l, i + 1, ctx));
}

interface Acc {
  net: DecValue;
  vat: DecValue;
  gross: DecValue;
  netHuf: DecValue;
  vatHuf: DecValue;
  grossHuf: DecValue;
}

function zeroAcc(): Acc {
  return { net: new D(0), vat: new D(0), gross: new D(0), netHuf: new D(0), vatHuf: new D(0), grossHuf: new D(0) };
}

function accumulate(a: Acc, l: InvoiceLine): void {
  a.net = a.net.plus(dec(l.netAmount));
  a.vat = a.vat.plus(dec(l.vatAmount));
  a.gross = a.gross.plus(dec(l.grossAmount));
  a.netHuf = a.netHuf.plus(dec(l.netAmountHuf));
  a.vatHuf = a.vatHuf.plus(dec(l.vatAmountHuf));
  a.grossHuf = a.grossHuf.plus(dec(l.grossAmountHuf));
}

export function computeTotals(lines: InvoiceLine[], ctx: CalcContext & { paymentMethod: PaymentMethod }): InvoiceTotals {
  const rows = new Map<VatCode, Acc>();
  const total = zeroAcc();
  for (const l of lines) {
    let row = rows.get(l.vatCode);
    if (!row) {
      row = zeroAcc();
      rows.set(l.vatCode, row); // Map keeps insertion order = first appearance
    }
    accumulate(row, l);
    accumulate(total, l);
  }
  const byVat: VatSummaryRow[] = [...rows.entries()].map(([vatCode, a]) => ({
    vatCode,
    netAmount: toDec(a.net),
    vatAmount: toDec(a.vat),
    grossAmount: toDec(a.gross),
    netAmountHuf: toDec(a.netHuf),
    vatAmountHuf: toDec(a.vatHuf),
    grossAmountHuf: toDec(a.grossHuf),
  }));
  const payable = isHuf(ctx.currency) && ctx.paymentMethod === 'CASH' ? dec(cashRoundHuf(total.gross)) : total.gross;
  return {
    netAmount: toDec(total.net),
    vatAmount: toDec(total.vat),
    grossAmount: toDec(total.gross),
    netAmountHuf: toDec(total.netHuf),
    vatAmountHuf: toDec(total.vatHuf),
    grossAmountHuf: toDec(total.grossHuf),
    byVat,
    payableAmount: toDec(payable),
    roundingDifference: toDec(payable.minus(total.gross)),
  };
}

/**
 * Statutory cash rounding of a HUF amount to the nearest 0 or 5 forint (…1,2 → 0; 3–7 → 5; 8,9 → 10).
 *
 * 2008. évi III. tv. 2. §: amounts ending in 0,01–2,49 Ft are rounded down to 0; 2,50–4,99 up to 5;
 * 5,01–7,49 down to 5; 7,50–9,99 up to 10. That is exactly "round half up to the nearest multiple
 * of 5" (x / 5 rounded half up, × 5) and also works for amounts with fillér. Negative amounts
 * (cash refund of a storno) are rounded symmetrically, so the storno payable is the exact negation
 * of the original payable.
 */
export function cashRoundHuf(amount: DecInput): Dec {
  return toDec(roundDec(dec(amount).div(5), 0).times(5));
}

/**
 * Line inputs of a storno invoice: every line of the original with negated quantity (prices unchanged).
 *
 * This is NAV's storno representation (sample "modositas-es-ervenytelenites": quantity −1, unitPrice
 * positive). With half-away-from-zero rounding every computed amount is the exact negative of the
 * original line. Advance-deduction data is kept (a storno of a végszámla reverses the deduction
 * too); `modifiesLineNo` is dropped – storno lines are new (CREATE) lines, their NAV line references
 * are assigned by the service.
 */
export function stornoLineInputs(original: InvoiceLine[]): InvoiceLineInput[] {
  return original.map((l) => {
    const out: InvoiceLineInput = {
      description: l.description,
      quantity: toDec(dec(l.quantity).neg()),
      unit: l.unit,
      unitPrice: l.unitPrice,
      priceBasis: l.priceBasis,
      vatCode: l.vatCode,
      nature: l.nature,
    };
    if (l.productId !== undefined) out.productId = l.productId;
    if (l.vatReason !== undefined) out.vatReason = l.vatReason;
    if (l.advanceDeduction !== undefined) out.advanceDeduction = { ...l.advanceDeduction };
    return out;
  });
}

export interface NotationContext {
  documentType: DocumentType;
  seller: SellerProfile;
  customer: CustomerData;
  lines: InvoiceLine[];
  language: InvoiceLanguage;
  reference: InvoiceReference | null;
}

interface Bilingual {
  hu: string;
  en: string;
}

/**
 * Codes whose notation is a statutory EXPRESSION (Áfa tv. 169. § n, p, q): a line `vatReason` may add
 * the legal basis, but must never remove the expression itself.
 */
const STATUTORY_EXPRESSION: Partial<Record<VatCode, Bilingual>> = {
  FAD: { hu: 'fordított adózás', en: 'Reverse charge' },
  EUFAD37: { hu: 'fordított adózás', en: 'Reverse charge' },
  EUFADE: { hu: 'fordított adózás', en: 'Reverse charge' },
  KUL_UTAZAS: { hu: 'különbözet szerinti szabályozás – utazási irodák', en: 'Margin scheme – travel agents' },
  KUL_HASZNALT: { hu: 'különbözet szerinti szabályozás – használt cikkek', en: 'Margin scheme – second-hand goods' },
  KUL_MUALKOTAS: { hu: 'különbözet szerinti szabályozás – műalkotások', en: 'Margin scheme – works of art' },
  KUL_REGISEG: { hu: 'különbözet szerinti szabályozás – gyűjteménydarabok és régiségek', en: 'Margin scheme – collectors’ items and antiques' },
};

/** Áfa tv. 169. § h): „pénzforgalmi elszámolás” (Directive 226 (7a): "Cash accounting"). */
const CASH_ACCOUNTING: Bilingual = { hu: 'pénzforgalmi elszámolás', en: 'Cash accounting' };

/** 'hu' → Hungarian, 'en' → English, 'hu-en' → "magyar / English" (same convention as the PDF labels). */
function render(hu: string | null, en: string | null, lang: InvoiceLanguage): string | null {
  if (lang === 'hu') return hu ?? en;
  if (lang === 'en') return en ?? hu;
  if (hu && en) return hu === en ? hu : `${hu} / ${en}`;
  return hu ?? en;
}

/**
 * Statutory EXPRESSIONS (169. § h, l, n, p, q) keep their Hungarian wording on English invoices too:
 * the Act prescribes the expression itself, and research 02 §3.1 / §19.3 recommends "magyar / English"
 * because no primary source says the translation alone is enough (the PDF fallback does the same).
 */
function renderStatutory(hu: string, en: string, lang: InvoiceLanguage): string {
  return lang === 'hu' ? hu : `${hu} / ${en}`;
}

/** Comparison key: lower case, single spaces, every dash as "-". */
function looseKey(s: string): string {
  return s.toLowerCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}

function documentNotation(ctx: NotationContext): { hu: string; en: string } | null {
  const ref = ctx.reference;
  const original = ref?.originalInvoiceNumber?.trim();
  switch (ctx.documentType) {
    case 'storno':
      return original
        ? {
            hu: `Érvénytelenítő (sztornó) számla – az eredeti számla sorszáma: ${original}`,
            en: `Cancellation (storno) invoice – original invoice number: ${original}`,
          }
        : { hu: 'Érvénytelenítő (sztornó) számla', en: 'Cancellation (storno) invoice' };
    case 'modification':
      return original
        ? {
            hu: `Módosító számla – az eredeti számla sorszáma: ${original}, módosítás sorszáma: ${ref?.modificationIndex ?? '?'}`,
            en: `Corrective invoice – original invoice number: ${original}, modification number: ${ref?.modificationIndex ?? '?'}`,
          }
        : { hu: 'Módosító számla', en: 'Corrective invoice' };
    case 'advance':
      // Áfa tv. 169. § g) + NAV: on an advance invoice the "date of supply" is the day the advance
      // was credited / received.
      return {
        hu: 'Előlegszámla – a teljesítés dátuma az előleg jóváírásának, illetve kézhezvételének napja',
        en: 'Advance invoice – the date of supply is the date the advance payment was received',
      };
    case 'final': {
      const numbers: string[] = [];
      for (const l of ctx.lines) {
        const n = l.advanceDeduction?.advanceInvoiceNumber?.trim();
        if (n && !numbers.includes(n)) numbers.push(n);
      }
      if (numbers.length === 0) {
        return { hu: 'Végszámla – a korábban kiállított előlegszámlák levonásával', en: 'Final invoice – advance invoices deducted' };
      }
      const list = numbers.join(', ');
      return numbers.length === 1
        ? { hu: `Végszámla – a levont előlegszámla sorszáma: ${list}`, en: `Final invoice – advance invoice deducted: ${list}` }
        : { hu: `Végszámla – a levont előlegszámlák sorszámai: ${list}`, en: `Final invoice – advance invoices deducted: ${list}` };
    }
    default:
      // 'invoice' needs no text; 'proforma' is labelled "not an invoice" by the PDF itself.
      return null;
  }
}

/** Notation of one line: the catalog text, or the line's vatReason (keeping statutory expressions). */
function lineNotation(line: InvoiceLine, lang: InvoiceLanguage): string | null {
  if (!isVatCode(line.vatCode)) return null; // reported by validateInvoice
  const info = getVatInfo(line.vatCode);
  const expr = STATUTORY_EXPRESSION[line.vatCode];
  const reason = typeof line.vatReason === 'string' ? line.vatReason.replace(/\s+/g, ' ').trim() : '';
  if (!reason) {
    if (expr && lang === 'en') return renderStatutory(expr.hu, info.notationEn ?? expr.en, lang);
    return render(info.notationHu, info.notationEn, lang);
  }
  if (!expr || looseKey(reason).includes(looseKey(expr.hu))) return reason;
  // The reason only names the legal basis (or gives the English expression) – the statutory
  // Hungarian expression must still be printed.
  if (lang !== 'hu' && looseKey(reason).startsWith(looseKey(expr.en))) return `${expr.hu} / ${reason}`;
  return `${renderStatutory(expr.hu, expr.en, lang)} – ${reason}`;
}

/**
 * Mandatory notations ("kötelező szöveges megjelölések") to print on the invoice, deduplicated, in a
 * stable order: document-type texts (e.g. storno/modification reference to the original number),
 * VAT-code notations (line vatReason overrides the catalog text), pénzforgalmi elszámolás,
 * önszámlázás (not supported yet), etc. For language 'hu-en' produce "magyar / English" pairs; on
 * 'en' invoices the statutory expressions („fordított adózás”, „pénzforgalmi elszámolás”, the four
 * „különbözet szerinti szabályozás – …”) are still printed in Hungarian, followed by the translation.
 *
 * Order: 1. document type, 2. VAT notations in line order, 3. „pénzforgalmi elszámolás” – printed for
 * a cash-accounting seller only when the invoice has a line taxed at a percentage rate: the scheme
 * does not apply to 89. § supplies, reverse-charge, margin-scheme, exempt or out-of-scope lines
 * (Áfa tv. 196/B. § (2), NAV 18. füzet), and printing it there would mislead the buyer.
 */
export function buildNotations(ctx: NotationContext): string[] {
  const out: string[] = [];
  const add = (text: string | null): void => {
    if (text && !out.includes(text)) out.push(text);
  };

  const doc = documentNotation(ctx);
  if (doc) add(render(doc.hu, doc.en, ctx.language));

  for (const line of ctx.lines) add(lineNotation(line, ctx.language));

  if (ctx.seller.cashAccounting && ctx.lines.some((l) => isVatCode(l.vatCode) && isPercentage(l.vatCode))) {
    add(renderStatutory(CASH_ACCOUNTING.hu, CASH_ACCOUNTING.en, ctx.language));
  }
  return out;
}
