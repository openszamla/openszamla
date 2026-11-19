/**
 * „Adóhatósági ellenőrzési adatszolgáltatás” (23/2014. (VI. 30.) NGM rendelet 8. § (1) c), 11/A. §, 19. §):
 * issued invoices → one XML document in the data structure of the rendelet 3. melléklet
 * (vendor/ngm-23-2014/szamla-2013.xsd – namespace http://schemas.nav.gov.hu/2013/szamla, root <szamlak>),
 * with the field meanings of its 2. melléklet. Element NAMES, ORDER and TYPES follow the XSD exactly;
 * every scenario is validated against it in test/export/szamla2013.test.ts.
 *
 * What has to be in it (NAV: „Ellenőrzési adatexport teljesítése során jelentkező jellemző hibák”,
 * Ügyféliránytű 2022.07.01.): every mandatory invoice datum, plus every optional datum the XSD has an
 * element for when it is printed on the invoice. Unlike NAV Online Számla, the name and address of a
 * private-person buyer ARE exported.
 *
 * Mapping decisions
 * - Selection: drafts and díjbekérők (proforma – not invoices) are skipped; issued invoices are kept,
 *   including ones cancelled later by a storno. Order: issue date, issuance time, invoice number.
 * - Header: kezdo_ido/zaro_ido AND kezdo_szla_szam/zaro_szla_szam are all mandatory, so the range that
 *   was not requested is derived from the exported invoices (min/max issue date, first/last number).
 *   The schema requires at least one <szamla>: an empty selection raises SZAMLA2013_NO_INVOICES.
 * - szlatipus: invoice/advance/final → 1 (számla), modification → 3 (módosító), storno → 4
 *   (érvénytelenítő). OpenSzámla issues neither simplified (2) nor collective (5) invoices.
 *   modification/storno → <modosito_szla><eredeti_sorszam> = number of the original invoice.
 * - Amounts are in the invoice currency (nem_kotelezo/penznem) EXCEPT the VAT amounts (line adoertek,
 *   afarovat/adoertek, vegosszeg/afaertekossz), which are in HUF: "Forintban kifejezve abban az esetben
 *   is fel kell tüntetni, ha az egyéb adatok külföldi pénznemben kifejezettek" (XSD; Áfa tv. 172. §).
 * - adokulcs is the rate in percent ("27", "5", "0") – the schema's own convention (szazalekertek
 *   "21.26"). Only percentage VAT codes get adokulcs/adoertek and an afarovat row (afarovat requires a
 *   numeric rate); amounts of exempt, out-of-scope, reverse-charge and margin-scheme lines are in their
 *   line amounts and in vegosszeg. afaertekossz is written whenever the invoice prints a VAT total, i.e.
 *   unless every line uses a code whose VAT may not be shown (AAM – 187. § (2) c), F.Á. – 142. § (7),
 *   K.Á. – 222. § (1) b), 210/A. §); same rule as the PDF.
 * - decimal_tipus allows 2 decimals and 12 digits: quantities and unit prices are rounded half-up to 2
 *   decimals (a changed quantity is reported as a warning); a value with more digits raises
 *   SZAMLA2013_DATA_INVALID. string_tipus is 1–100 characters: longer texts are cut (warning); a blank
 *   mandatory text, a missing invoice number or reference raise SZAMLA2013_DATA_INVALID (issued data is
 *   validated at issuance, so this means corrupt data, which must not be papered over). Such a document
 *   is left out of the export with a warning naming it – one broken document must not abort the whole
 *   statutory export; the error itself is raised only when no document of the selection can be exported.
 * - Addresses: a Hungarian address line "<név> <jelleg> <házszám…>" is split into kozterulet_neve /
 *   kozterulet_jellege / hazszam when the jelleg is a known street type followed by a house number (or
 *   nothing); otherwise the whole line is kozterulet_neve. Building/floor/door stay in hazszam. A missing
 *   postal code becomes "0000" (NAV Online Számla convention), a shorter one is zero-padded to 4, a longer
 *   one is cut to 10 characters (warnings). The schema has no country or region element.
 * - Party identifiers: seller adoszam = taxNumber (the group identifier for VAT groups, 169. § c));
 *   buyer adoszam = taxNumber or else thirdStateTaxId, kozadoszam = EU VAT number – business buyers only,
 *   as printed. An optional identifier outside adoszam_tipus (8–20 characters) is left out (warning).
 * - Seller: kisadozo only when true; egyéni vállalkozó is recognised by the mandatory "e.v." /
 *   "egyéni vállalkozó" designation in the name (Evtv. 16. § (4); same rule as the PDF) →
 *   egyeni_vallalkozo, ev_nyilv_tart_szam = registrationNumber, ev_neve = name without the designation.
 * - zaradekok: penzforgelsz and onszamla follow the printed notations (fallback for documents without
 *   stored notations: the seller's cash-accounting flag, as the PDF does); ford_ado = any line where the
 *   buyer pays the VAT (FAD, EUFAD37, EUFADE); adoment_hiv = any exemption code (AAM, TAM, KBAET, KBAUK,
 *   EAM, NAM); kulonb_szer_szab = the margin scheme (1 utazási irodák, 2 használt cikkek, 3 műalkotások,
 *   4 gyűjteménydarabok és régiségek).
 * - eloleg: 1 on every line of an előlegszámla and of its storno/modification (reference.
 *   originalDocumentType = 'advance', as advanceIndicator in the NAV data), 2 on advance-deduction lines
 *   (végszámla, and the reversed deduction on its storno).
 * - nem_kotelezo: due date, payment method and appearance as printed (Hungarian), currency, the seller's
 *   bank account and – for business buyers, as printed – the buyer's.
 * Not representable (no XSD element): VAT-group member tax numbers, exchange rate, order number, comment,
 * modification index and line references, cash-rounded payable amount, country/region of addresses.
 * Data the schema could hold but OpenSzámla does not record: kepviselo (pénzügyi képviselő), besorszam
 * (vtsz./TESZOR), kozv_szolgaltatas, arengedm, gyujto_szla, new means of transport data, excise/product
 * fee notations.
 */
import { assertIsoDate, isIsoDate } from '../core/dates.ts';
import { dec, roundDec, toDec, type DecValue } from '../core/decimal.ts';
import { AppError, isAppError } from '../core/errors.ts';
import type { Address, CustomerData, Dec, DocumentType, Invoice, InvoiceAppearance, InvoiceLine, SellerProfile } from '../core/types.ts';
import { getVatInfo, isVatCode, type MarginScheme, type VatCodeInfo } from '../core/vat.ts';
import { el, leaf, normalizeXmlText, opt, serializeXml, type XmlElement } from '../nav/xml.ts';
import { PAYMENT_METHODS } from '../pdf/labels.ts';

/** Target namespace of the 3. melléklet XSD. */
export const SZAMLA2013_NAMESPACE = 'http://schemas.nav.gov.hu/2013/szamla';

export interface Szamla2013Meta {
  /** export_datuma – the day the export is made (YYYY-MM-DD, Hungarian calendar day). */
  exportDate: string;
  /** kezdo_ido / zaro_ido – the requested issue-date range (11/A. § a)); derived from the invoices when omitted. */
  rangeFrom?: string;
  rangeTo?: string;
  /** kezdo_szla_szam / zaro_szla_szam – the requested number range (11/A. § b)); derived when omitted. */
  numberFrom?: string;
  numberTo?: string;
}

/**
 * Data that had to be adapted to the schema (texts cut, quantities rounded …), or a document left out
 * because it cannot be represented – Hungarian, for the user.
 */
export interface Szamla2013Warning {
  /** Number of the affected invoice (its id when it has no number). */
  invoiceNumber: string;
  /** Source field, e.g. "lines[0].description". */
  field: string;
  message: string;
}

export interface Szamla2013Export {
  /** UTF-8 XML document (with XML declaration). */
  xml: string;
  /** export_szla_db – number of exported invoices. */
  invoiceCount: number;
  /** Numbers of the exported invoices in document order. */
  invoiceNumbers: string[];
  /** Header values as written (requested, or derived from the invoices). */
  rangeFrom: string;
  rangeTo: string;
  numberFrom: string;
  numberTo: string;
  warnings: Szamla2013Warning[];
}

// ---------------------------------------------------------------------------------------------
// Errors, warnings, value normalisation
// ---------------------------------------------------------------------------------------------

interface Ctx {
  invoiceNumber: string;
  warnings: Szamla2013Warning[];
}

const DATA_HINT =
  'Ellenőrizd a számla adatait (invoice_get). Kiállított számla nem módosítható: hibás adatot helyesbítő vagy sztornó számlával lehet javítani.';

function dataError(ctx: Ctx, message: string, field: string): AppError {
  return new AppError('SZAMLA2013_DATA_INVALID', `${ctx.invoiceNumber} számla: ${message}`, {
    hint: DATA_HINT,
    details: { invoiceNumber: ctx.invoiceNumber, field },
  });
}

function warn(ctx: Ctx, field: string, message: string): void {
  ctx.warnings.push({ invoiceNumber: ctx.invoiceNumber, field, message });
}

/** Single-line text: control whitespace → space, invalid XML characters dropped, trimmed; blank → null. */
function clean(value: string | null | undefined): string | null {
  return normalizeXmlText(value, Number.MAX_SAFE_INTEGER);
}

function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Cuts `value` to `max` code points (XSD maxLength counts characters) and records a warning. */
function cut(ctx: Ctx, value: string, max: number, field: string, label: string): string {
  const length = codePoints(value);
  if (length <= max) return value;
  warn(ctx, field, `${capitalize(label)} ${length} karakter; a 3. melléklet szerinti séma legfeljebb ${max} karaktert enged, ezért az exportban rövidítve szerepel.`);
  return Array.from(value).slice(0, max).join('').trimEnd();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** string_tipus (1–100 characters), mandatory. */
function requiredText(ctx: Ctx, value: string | null | undefined, field: string, label: string): string {
  const s = clean(value);
  if (!s) throw dataError(ctx, `hiányzik ${label}, amely a 3. melléklet szerinti sémában kötelező.`, field);
  return cut(ctx, s, 100, field, label);
}

/** string_tipus (1–100 characters), optional. */
function optionalText(ctx: Ctx, value: string | null | undefined, field: string, label: string): string | null {
  const s = clean(value);
  return s ? cut(ctx, s, 100, field, label) : null;
}

/** Invoice numbers (string_tipus) are identifiers: never cut. Returns null when blank. */
function invoiceNumberText(value: string | null | undefined): { value: string | null; fits: boolean } {
  const s = clean(value);
  return { value: s, fits: s === null || codePoints(s) <= 100 };
}

/** The number of an exported (issued) invoice. */
function invoiceNumberOf(inv: Invoice): string {
  const n = invoiceNumberText(inv.number);
  if (!n.value || !n.fits) {
    throw new AppError(
      'SZAMLA2013_DATA_INVALID',
      n.value
        ? `A(z) ${n.value} számlaszám hosszabb 100 karakternél, a 3. melléklet szerinti séma nem tudja ábrázolni.`
        : `A(z) ${inv.id} azonosítójú kiállított számlának nincs sorszáma.`,
      { hint: DATA_HINT, details: { invoiceId: inv.id, field: 'number' } },
    );
  }
  return n.value;
}

/** adoszam_tipus: 8–20 characters. */
function taxId(value: string | null | undefined): { value: string | null; fits: boolean } {
  const s = clean(value);
  if (!s) return { value: null, fits: true };
  const n = codePoints(s);
  return { value: s, fits: n >= 8 && n <= 20 };
}

function requiredTaxId(ctx: Ctx, value: string | null | undefined, field: string, label: string): string {
  const t = taxId(value);
  if (!t.value) throw dataError(ctx, `hiányzik ${label}.`, field);
  if (!t.fits) throw dataError(ctx, `${capitalize(label)} ("${t.value}") nem 8–20 karakter hosszú, így a séma adószám típusába nem írható.`, field);
  return t.value;
}

function optionalTaxId(ctx: Ctx, value: string | null | undefined, field: string, label: string): string | null {
  const t = taxId(value);
  if (t.value && !t.fits) {
    warn(ctx, field, `${capitalize(label)} ("${t.value}") nem 8–20 karakter hosszú, ezért a séma adószám mezőjébe nem írható – az exportból kimarad.`);
    return null;
  }
  return t.value;
}

function date(ctx: Ctx, value: string | null | undefined, field: string, label: string): string {
  const s = (value ?? '').trim();
  if (!isIsoDate(s)) throw dataError(ctx, `érvénytelen dátum (${label}): ${s || '(üres)'}.`, field);
  return s;
}

/**
 * decimal_tipus: xs:decimal, totalDigits 12, fractionDigits 2. Rounded half-up to 2 decimals; when
 * `roundingLabel` is given a changed value is reported. More than 12 significant digits → error.
 */
function decimal(ctx: Ctx, value: Dec, field: string, roundingLabel?: string): string {
  let d: DecValue;
  try {
    d = dec(value, field);
  } catch {
    throw dataError(ctx, `érvénytelen szám (${field}): ${String(value)}.`, field);
  }
  const rounded = roundDec(d, 2);
  const s = toDec(rounded);
  if (roundingLabel && !rounded.eq(d)) {
    warn(ctx, field, `${capitalize(roundingLabel)} (${toDec(d)}) a sémában legfeljebb 2 tizedesjegyű lehet, ezért ${s} szerepel.`);
  }
  const digits = s.replace('-', '').replace('.', '').replace(/^0+/, '');
  if (digits.length > 12) throw dataError(ctx, `túl nagy szám (${field}): ${s}; a séma legfeljebb 12 számjegyet (ebből 2 tizedest) enged.`, field);
  return s;
}

function vatInfo(ctx: Ctx, code: string, field: string): VatCodeInfo {
  if (!isVatCode(code)) throw dataError(ctx, `ismeretlen ÁFA-kód: ${code}.`, field);
  return getVatInfo(code);
}

/** adokulcs: the VAT rate in percent ("0.27" → "27"). */
function percent(ctx: Ctx, info: VatCodeInfo, field: string): string {
  return decimal(ctx, toDec(dec(info.rate).times(100)), field);
}

// ---------------------------------------------------------------------------------------------
// Selection and order
// ---------------------------------------------------------------------------------------------

/** Issued (incl. later cancelled) invoices only: drafts and díjbekérők are not invoices. */
export function isSzamla2013Exportable(inv: Invoice): boolean {
  return inv.documentType !== 'proforma' && inv.status !== 'draft';
}

/** The invoices an export contains, without duplicates, in issuance order. */
export function selectSzamla2013Invoices(invoices: readonly Invoice[]): Invoice[] {
  const byId = new Map<string, Invoice>();
  for (const inv of invoices) if (isSzamla2013Exportable(inv) && !byId.has(inv.id)) byId.set(inv.id, inv);
  return [...byId.values()].sort(compareIssued);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Natural order of invoice numbers ("A-9" < "A-10"). */
function compareNumbers(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const nx = x.replace(/^0+/, '');
      const ny = y.replace(/^0+/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return compareStrings(nx, ny);
      return x.length - y.length;
    }
    return compareStrings(x, y);
  }
  return ta.length - tb.length;
}

function compareIssued(a: Invoice, b: Invoice): number {
  return (
    compareStrings(a.issueDate, b.issueDate) ||
    compareStrings(a.issuedAt ?? '', b.issuedAt ?? '') ||
    compareNumbers(a.number ?? '', b.number ?? '') ||
    compareStrings(a.id, b.id)
  );
}

// ---------------------------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------------------------

/**
 * Közterület jellege words (KSH/NAV code list, the common ones) and their usual abbreviations, lower case.
 */
const STREET_TYPES: ReadonlySet<string> = new Set([
  'akna', 'alagút', 'árok', 'átjáró', 'dűlő', 'dűlőút', 'erdősor', 'fasor', 'forduló', 'gát', 'határsor',
  'határút', 'hegy', 'kapu', 'kert', 'kertsor', 'kilátó', 'köz', 'körönd', 'körtér', 'körút', 'lakópark',
  'lakótelep', 'lejtő', 'lépcső', 'liget', 'major', 'mélyút', 'park', 'part', 'pincesor', 'puszta', 'rakpart',
  'sétány', 'sikátor', 'sor', 'sugárút', 'szer', 'sziget', 'tanya', 'telep', 'tér', 'tere', 'tető', 'udvar',
  'út', 'útja', 'utca', 'utcája', 'üdülőpart', 'üdülősor', 'villasor', 'völgy', 'zug',
  'u.', 'krt.', 'ltp.', 'rkp.', 'stny.',
]);

export interface StreetParts {
  /** kozterulet_neve */
  name: string;
  /** kozterulet_jellege (utca, út, tér …) */
  type: string | null;
  /** hazszam – house number and whatever follows it (building, floor, door). */
  rest: string | null;
}

/**
 * Splits a Hungarian address line ("Irinyi József utca 4-20.") into street name, street type and
 * house number. Conservative: the type must be a known word, not the first token, and be followed by a
 * token starting with a digit (or nothing). Anything else is returned as the street name.
 */
export function splitHuStreetLine(line: string): StreetParts {
  const tokens = line.trim().split(/\s+/).filter((t) => t !== '');
  for (let i = 1; i < tokens.length; i++) {
    const type = (tokens[i] as string).replace(/,$/, '');
    if (!STREET_TYPES.has(type.toLowerCase())) continue;
    const next = tokens[i + 1];
    if (next !== undefined && !/^\d/.test(next)) continue;
    const name = tokens.slice(0, i).join(' ').replace(/,$/, '');
    if (!name) continue;
    const rest = tokens.slice(i + 1).join(' ');
    return { name, type, rest: rest || null };
  }
  return { name: line.trim(), type: null, rest: null };
}

/** iranyitoszam: 4–10 characters, mandatory. */
function postalCode(ctx: Ctx, input: string | null | undefined, field: string, who: string): string {
  const s = clean(input);
  if (!s) {
    warn(ctx, field, `${capitalize(who)} címében nincs irányítószám; a séma kötelezővé teszi, ezért "0000" szerepel (a NAV Online Számla gyakorlata szerint).`);
    return '0000';
  }
  const n = codePoints(s);
  if (n < 4) {
    const padded = '0'.repeat(4 - n) + s;
    warn(ctx, field, `${capitalize(who)} irányítószáma ("${s}") rövidebb 4 karakternél; a séma legalább 4-et vár, ezért "${padded}" szerepel.`);
    return padded;
  }
  return cut(ctx, s, 10, field, `${who} irányítószáma`);
}

function cimEl(ctx: Ctx, a: Address | undefined, field: string, who: string): XmlElement {
  const line = clean(a?.addressLine);
  if (!line) throw dataError(ctx, `hiányzik ${who} címének közterület adata (utca, házszám).`, `${field}.addressLine`);
  const hungarian = (a?.countryCode ?? '').trim().toUpperCase() === 'HU';
  const parts: StreetParts = hungarian ? splitHuStreetLine(line) : { name: line, type: null, rest: null };
  return el('cim', [
    leaf('iranyitoszam', postalCode(ctx, a?.postalCode, `${field}.postalCode`, who)),
    leaf('telepules', requiredText(ctx, a?.city, `${field}.city`, `${who} címének települése`)),
    leaf('kozterulet_neve', cut(ctx, parts.name, 100, `${field}.addressLine`, `${who} címének közterület neve`)),
    opt('kozterulet_jellege', parts.type && cut(ctx, parts.type, 100, `${field}.addressLine`, `${who} címének közterület jellege`)),
    opt('hazszam', parts.rest && cut(ctx, parts.rest, 100, `${field}.addressLine`, `${who} címének házszáma`)),
  ]);
}

/** Egyéni vállalkozó designation (Evtv. 16. § (4)) – same rule as the PDF. */
function isSoleTrader(name: string): boolean {
  return /(^|\s)e\.\s?v\.?$/i.test(name.trim()) || /egyéni vállalkozó/i.test(name);
}

/** The entrepreneur's own name: the seller name without a trailing "e.v." / "egyéni vállalkozó". */
function soleTraderName(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(/[\s,]*(?:\be\.\s?v\.?|egyéni vállalkozó)$/i, '').trim() || trimmed;
}

function szamlakibocsatoEl(ctx: Ctx, s: SellerProfile): XmlElement {
  const soleTrader = isSoleTrader(s.name ?? '');
  return el('szamlakibocsato', [
    leaf('adoszam', requiredTaxId(ctx, s.taxNumber, 'seller.taxNumber', 'az eladó adószáma')),
    opt('kozadoszam', optionalTaxId(ctx, s.euVatNumber, 'seller.euVatNumber', 'az eladó közösségi adószáma')),
    s.smallBusiness === true && leaf('kisadozo', true),
    leaf('nev', requiredText(ctx, s.name, 'seller.name', 'az eladó neve')),
    cimEl(ctx, s.address, 'seller.address', 'az eladó'),
    soleTrader && leaf('egyeni_vallalkozo', true),
    soleTrader && opt('ev_nyilv_tart_szam', optionalText(ctx, s.registrationNumber, 'seller.registrationNumber', 'az egyéni vállalkozó nyilvántartási száma')),
    soleTrader && opt('ev_neve', optionalText(ctx, soleTraderName(s.name), 'seller.name', 'az egyéni vállalkozó neve')),
  ]);
}

function vevoEl(ctx: Ctx, c: CustomerData): XmlElement {
  // Private persons: name and address only – no tax identifiers are printed for them.
  const business = c.vatStatus !== 'PRIVATE_PERSON';
  const taxNumber = !business
    ? null
    : clean(c.taxNumber)
      ? optionalTaxId(ctx, c.taxNumber, 'customer.taxNumber', 'a vevő adószáma')
      : optionalTaxId(ctx, c.thirdStateTaxId, 'customer.thirdStateTaxId', 'a vevő külföldi adóazonosítója');
  return el('vevo', [
    opt('adoszam', taxNumber),
    business && opt('kozadoszam', optionalTaxId(ctx, c.euVatNumber, 'customer.euVatNumber', 'a vevő közösségi adószáma')),
    leaf('nev', requiredText(ctx, c.name, 'customer.name', 'a vevő neve')),
    cimEl(ctx, c.address, 'customer.address', 'a vevő'),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Invoice parts
// ---------------------------------------------------------------------------------------------

const SZLATIPUS: Readonly<Record<Exclude<DocumentType, 'proforma'>, number>> = {
  invoice: 1,
  advance: 1,
  final: 1,
  modification: 3,
  storno: 4,
};

function fejlecEl(ctx: Ctx, inv: Invoice): XmlElement {
  const type = Object.hasOwn(SZLATIPUS, inv.documentType) ? SZLATIPUS[inv.documentType as keyof typeof SZLATIPUS] : null;
  if (type === null) throw dataError(ctx, `ismeretlen bizonylattípus: ${String(inv.documentType)}.`, 'documentType');
  return el('fejlec', [
    leaf('szlasorszam', ctx.invoiceNumber),
    leaf('szlatipus', type),
    leaf('szladatum', date(ctx, inv.issueDate, 'issueDate', 'a számla kelte')),
    // Mandatory in the schema even when it equals the issue date.
    leaf('teljdatum', date(ctx, inv.fulfillmentDate, 'fulfillmentDate', 'a teljesítés dátuma')),
  ]);
}

/**
 * eloleg (2. melléklet: „amennyiben a termékre/szolgáltatásra adott előleg szerepel a számlán, annak
 * jelölése”): 1 – every line of an előlegszámla AND of its corrections (storno/modification of an
 * advance invoice, reference.originalDocumentType – same rule as advanceIndicator in the NAV data);
 * 2 – an advance deducted on a végszámla (also the reversed deduction on its storno).
 */
function elolegCode(inv: Invoice, line: InvoiceLine): 1 | 2 | null {
  if (inv.documentType === 'advance' || inv.reference?.originalDocumentType === 'advance') return 1;
  return line.advanceDeduction ? 2 : null;
}

function tetelEl(ctx: Ctx, inv: Invoice, line: InvoiceLine, i: number): XmlElement {
  const f = `lines[${i}]`;
  const n = `a(z) ${line.lineNo}. tétel`;
  const info = vatInfo(ctx, line.vatCode, `${f}.vatCode`);
  const percentage = info.nav.kind === 'vatPercentage';
  return el('termek_szolgaltatas_tetelek', [
    leaf('termeknev', requiredText(ctx, line.description, `${f}.description`, `${n} megnevezése`)),
    opt('eloleg', elolegCode(inv, line)),
    leaf('menny', decimal(ctx, line.quantity, `${f}.quantity`, `${n} mennyisége`)),
    leaf('mertekegys', requiredText(ctx, line.unit, `${f}.unit`, `${n} mennyiségi egysége`)),
    leaf('nettoar', decimal(ctx, line.netAmount, `${f}.netAmount`)),
    leaf('nettoegysar', decimal(ctx, line.netUnitPrice, `${f}.netUnitPrice`)),
    percentage && leaf('adokulcs', percent(ctx, info, `${f}.vatCode`)),
    // The VAT in HUF, also on foreign-currency invoices (XSD documentation, Áfa tv. 172. §).
    percentage && leaf('adoertek', decimal(ctx, line.vatAmountHuf, `${f}.vatAmountHuf`)),
    leaf('bruttoar', decimal(ctx, line.grossAmount, `${f}.grossAmount`)),
  ]);
}

function modositoSzlaEl(ctx: Ctx, inv: Invoice): XmlElement | null {
  if (inv.documentType !== 'modification' && inv.documentType !== 'storno') return null;
  const field = 'reference.originalInvoiceNumber';
  const original = invoiceNumberText(inv.reference?.originalInvoiceNumber);
  if (!original.value) throw dataError(ctx, 'a módosító/érvénytelenítő számlából hiányzik az eredeti számla sorszáma.', field);
  if (!original.fits) throw dataError(ctx, `az eredeti számla sorszáma hosszabb 100 karakternél: "${original.value}".`, field);
  return el('modosito_szla', leaf('eredeti_sorszam', original.value));
}

/** The buyer pays the VAT: domestic reverse charge and the reverse-charged EU supplies (169. § n)). */
function buyerPaysVat(info: VatCodeInfo): boolean {
  const nav = info.nav;
  return nav.kind === 'vatDomesticReverseCharge' || (nav.kind === 'vatOutOfScope' && (nav.case === 'EUFAD37' || nav.case === 'EUFADE'));
}

/** Codes whose VAT amount may not be shown on the invoice (AAM, F.Á., K.Á.) – the PDF prints no VAT total then. */
function vatAmountForbidden(info: VatCodeInfo): boolean {
  const nav = info.nav;
  return (nav.kind === 'vatExemption' && nav.case === 'AAM') || nav.kind === 'vatDomesticReverseCharge' || nav.kind === 'marginSchemeIndicator';
}

/** kulonb_szer_szab_tipus code and the expression of 169. § p)–q). */
const MARGIN_SCHEMES: Readonly<Record<MarginScheme, { code: number; name: string }>> = {
  TRAVEL_AGENCY: { code: 1, name: 'utazási irodák' },
  SECOND_HAND: { code: 2, name: 'használt cikkek' },
  ARTWORK: { code: 3, name: 'műalkotások' },
  ANTIQUES: { code: 4, name: 'gyűjteménydarabok és régiségek' },
};

const CASH_ACCOUNTING_RE = /pénzforgalmi elszámolás|cash accounting/i;
const SELF_BILLING_RE = /önszámlázás|self-billing/i;

function zaradekokEl(ctx: Ctx, inv: Invoice, infos: readonly VatCodeInfo[]): XmlElement | null {
  const notations = inv.notations ?? [];
  // As printed: the stored notations; documents without them get the PDF's fallback.
  const cashAccounting =
    notations.length > 0 ? notations.some((t) => CASH_ACCOUNTING_RE.test(t)) : inv.seller.cashAccounting === true && inv.seller.vatStatus === 'normal';
  const selfBilling = notations.some((t) => SELF_BILLING_RE.test(t));
  const reverseCharge = infos.some(buyerPaysVat);
  const exempt = infos.some((i) => i.nav.kind === 'vatExemption');
  const schemes = [...new Set(infos.flatMap((i) => (i.nav.kind === 'marginSchemeIndicator' ? [i.nav.value] : [])))];
  const scheme = schemes[0];
  if (schemes.length > 1) {
    const names = schemes.map((s) => MARGIN_SCHEMES[s].name).join(', ');
    warn(ctx, 'lines', `A számlán több különbözet szerinti szabályozás szerepel (${names}); a séma csak egyet enged, az export az elsőt tartalmazza.`);
  }
  const children = [
    cashAccounting && leaf('penzforgelsz', true),
    selfBilling && leaf('onszamla', true),
    reverseCharge && leaf('ford_ado', true),
    exempt && leaf('adoment_hiv', true),
    scheme !== undefined && leaf('kulonb_szer_szab', MARGIN_SCHEMES[scheme].code),
  ];
  return children.some((c) => c !== false) ? el('zaradekok', children) : null;
}

const APPEARANCES: Readonly<Record<InvoiceAppearance, string>> = {
  ELECTRONIC: 'e-számla',
  PAPER: 'papír alapon továbbított számla',
};

function nemKotelezoEl(ctx: Ctx, inv: Invoice): XmlElement {
  const currency = (inv.currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw dataError(ctx, `érvénytelen pénznem: ${String(inv.currency)}.`, 'currency');
  // An unknown (stored) payment method is still string_tipus: at most 100 characters.
  const paymentMethod = Object.hasOwn(PAYMENT_METHODS, inv.paymentMethod)
    ? PAYMENT_METHODS[inv.paymentMethod].hu
    : optionalText(ctx, inv.paymentMethod, 'paymentMethod', 'a fizetési mód');
  const business = inv.customer.vatStatus !== 'PRIVATE_PERSON';
  return el('nem_kotelezo', [
    inv.dueDate ? leaf('fiz_hatarido', date(ctx, inv.dueDate, 'dueDate', 'a fizetési határidő')) : null,
    opt('fiz_mod', paymentMethod),
    leaf('penznem', currency),
    opt('szla_forma', Object.hasOwn(APPEARANCES, inv.appearance) ? APPEARANCES[inv.appearance] : null),
    opt('kibocsato_bankszla', optionalText(ctx, inv.seller.bankAccount, 'seller.bankAccount', 'az eladó bankszámlaszáma')),
    business && opt('befogado_bankszla', optionalText(ctx, inv.customer.bankAccount, 'customer.bankAccount', 'a vevő bankszámlaszáma')),
  ]);
}

function osszesitesEl(ctx: Ctx, inv: Invoice, infos: readonly VatCodeInfo[]): XmlElement {
  const t = inv.totals;
  const rows = t.byVat.flatMap((r, i) => {
    const f = `totals.byVat[${i}]`;
    const info = vatInfo(ctx, r.vatCode, `${f}.vatCode`);
    // afarovat needs a numeric rate: one row per percentage rate.
    if (info.nav.kind !== 'vatPercentage') return [];
    return [
      el('afarovat', [
        leaf('nettoar', decimal(ctx, r.netAmount, `${f}.netAmount`)),
        leaf('adokulcs', percent(ctx, info, `${f}.vatCode`)),
        leaf('adoertek', decimal(ctx, r.vatAmountHuf, `${f}.vatAmountHuf`)),
        leaf('bruttoar', decimal(ctx, r.grossAmount, `${f}.grossAmount`)),
      ]),
    ];
  });
  const vatTotalPrinted = infos.some((i) => !vatAmountForbidden(i));
  return el('osszesites', [
    rows,
    el('vegosszeg', [
      leaf('nettoarossz', decimal(ctx, t.netAmount, 'totals.netAmount')),
      vatTotalPrinted && leaf('afaertekossz', decimal(ctx, t.vatAmountHuf, 'totals.vatAmountHuf')),
      // The invoice gross total – the 0/5 Ft cash-rounded payable amount has no element.
      leaf('bruttoarossz', decimal(ctx, t.grossAmount, 'totals.grossAmount')),
    ]),
  ]);
}

function szamlaEl(ctx: Ctx, inv: Invoice): XmlElement {
  if (!Array.isArray(inv.lines) || inv.lines.length === 0) {
    throw dataError(ctx, 'a számlának nincs tétele; a séma legalább egy tételt vár.', 'lines');
  }
  const infos = inv.lines.map((l, i) => vatInfo(ctx, l.vatCode, `lines[${i}].vatCode`));
  return el('szamla', [
    fejlecEl(ctx, inv),
    szamlakibocsatoEl(ctx, inv.seller),
    vevoEl(ctx, inv.customer),
    inv.lines.map((l, i) => tetelEl(ctx, inv, l, i)),
    modositoSzlaEl(ctx, inv),
    zaradekokEl(ctx, inv, infos),
    nemKotelezoEl(ctx, inv),
    osszesitesEl(ctx, inv, infos),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

function optionalMeta(value: string | undefined): string | null {
  const s = value?.trim();
  return s ? s : null;
}

/** kezdo_szla_szam / zaro_szla_szam given by the caller. */
function metaNumber(value: string, field: string, label: string): string {
  const n = invoiceNumberText(value);
  if (!n.value || !n.fits) {
    throw new AppError('INVALID_INPUT', `${label} legfeljebb 100 karakter lehet (${field}).`, {
      hint: 'Pontosan a számlán szereplő sorszámot add meg.',
    });
  }
  return n.value;
}

/**
 * Builds the „adóhatósági ellenőrzési adatszolgáltatás” XML of `invoices` (the caller selects them by
 * issue-date or number range; drafts and díjbekérők are dropped here) plus what had to be adapted.
 */
export function buildSzamla2013Export(invoices: readonly Invoice[], meta: Szamla2013Meta): Szamla2013Export {
  const exportDate = assertIsoDate(meta.exportDate, 'exportDate');
  const selected = selectSzamla2013Invoices(invoices);
  if (selected.length === 0) {
    throw new AppError('SZAMLA2013_NO_INVOICES', 'Nincs exportálható számla: a kiválasztásban nincs kiállított számla (a piszkozat és a díjbekérő nem számla).', {
      hint: 'Ellenőrizd a dátum- vagy sorszámtartományt (invoice_list). A 3. melléklet szerinti séma legalább egy számlát vár.',
    });
  }

  // One broken document must not abort the statutory export: it is left out with a warning naming it.
  // Only when no document can be exported is the (first) error raised – the schema needs one <szamla>.
  const warnings: Szamla2013Warning[] = [];
  const built: Array<{ inv: Invoice; number: string; node: XmlElement }> = [];
  let firstError: unknown = null;
  for (const inv of selected) {
    const own: Szamla2013Warning[] = [];
    try {
      const number = invoiceNumberOf(inv);
      built.push({ inv, number, node: szamlaEl({ invoiceNumber: number, warnings: own }, inv) });
      warnings.push(...own);
    } catch (e) {
      firstError ??= e;
      const field = isAppError(e) && typeof e.details?.field === 'string' ? e.details.field : 'invoice';
      warnings.push({
        invoiceNumber: clean(inv.number) ?? inv.id,
        field,
        message: `A számla kimaradt a szamlak.xml-ből, mert az adatai nem írhatók a 3. melléklet szerinti sémába: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  if (built.length === 0) throw firstError;

  const numbers = built.map((b) => b.number);
  const issueDates = built.map((b) => b.inv.issueDate).sort(compareStrings);
  const from = optionalMeta(meta.rangeFrom);
  const to = optionalMeta(meta.rangeTo);
  const rangeFrom = from !== null ? assertIsoDate(from, 'rangeFrom') : (issueDates[0] as string);
  const rangeTo = to !== null ? assertIsoDate(to, 'rangeTo') : (issueDates.at(-1) as string);
  if (rangeFrom > rangeTo) {
    throw new AppError('INVALID_INPUT', `A kezdő dátum (${rangeFrom}) későbbi, mint a záró dátum (${rangeTo}).`, {
      hint: 'Add meg a dátumtartományt növekvő sorrendben.',
    });
  }
  const numberFrom = optionalMeta(meta.numberFrom);
  const numberTo = optionalMeta(meta.numberTo);
  const header = {
    rangeFrom,
    rangeTo,
    numberFrom: numberFrom !== null ? metaNumber(numberFrom, 'numberFrom', 'A kezdő számlasorszám') : (numbers[0] as string),
    numberTo: numberTo !== null ? metaNumber(numberTo, 'numberTo', 'A záró számlasorszám') : (numbers.at(-1) as string),
  };

  const szamlak = built.map((b) => b.node);
  const root = el(
    'szamlak',
    [
      leaf('export_datuma', exportDate),
      leaf('export_szla_db', built.length),
      leaf('kezdo_ido', header.rangeFrom),
      leaf('zaro_ido', header.rangeTo),
      leaf('kezdo_szla_szam', header.numberFrom),
      leaf('zaro_szla_szam', header.numberTo),
      szamlak,
    ],
    { xmlns: SZAMLA2013_NAMESPACE },
  );
  return { xml: serializeXml(root), invoiceCount: built.length, invoiceNumbers: numbers, ...header, warnings };
}

/** The XML document only (see buildSzamla2013Export). */
export function buildSzamla2013Xml(invoices: Invoice[], meta: Szamla2013Meta): string {
  return buildSzamla2013Export(invoices, meta).xml;
}
