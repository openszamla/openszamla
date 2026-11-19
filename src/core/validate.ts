/**
 * Format validators and business validation of parties and invoices.
 *
 * CONTRACT FILE – keep the signatures. Algorithms and rules come from
 * docs/research/06-adatformatumok.md (formats, check digits) and 02-jogi-kovetelmenyek.md
 * (Áfa tv. 169. § mandatory content, scenario rules) and 03-nav-online-szamla-api.md (NAV
 * blocking validations). Every issue message is Hungarian, explains the problem AND how to fix it.
 * Severity 'error' blocks issuing; 'warning' is shown but does not block.
 *
 * Algorithms (verified on real, publicly listed numbers in test/core/validate.test.ts):
 * - Adószám törzsszám check digit: the first 7 digits weighted 9,7,3,1,9,7,3; check digit =
 *   (10 − Σ mod 10) mod 10 (Céginformációs Szolgálat, research 06 §1.2). Áfakód 1–5; megyekód
 *   02–20, 22–44, 51 (NAV spec 4.1).
 * - Pénzforgalmi jelzőszám (GIRO), 35/2017. (XII. 14.) MNB rendelet 1. melléklet 1. pont: digits
 *   1–7 → check digit 8, and digits 9–15 → 16 (16-digit account) or 9–23 → 24 (24-digit account;
 *   digit 16 is "szabadon kialakítható", NOT a check digit), weights 9,7,3,1 repeated. The popular
 *   "three separate 8-digit blocks" check is wrong (it rejects NAV's own 10032000-00009722-05020029).
 * - IBAN: ISO 13616 mod 97 = 1 and the registry length of the country; a HU IBAN must also contain
 *   a valid GIRO number (MNB rendelet 1. melléklet 2. pont).
 * - Közösségi adószám: VIES format table per member state (research 06 §2.2), "EL" for Greece, "XI"
 *   for Northern Ireland, HU check digit, and NAV CommunityVatNumberType ([A-Z]{2}[0-9A-Z]{2,13}).
 *
 * validateInvoice pre-checks the blocking NAV business validations (research 03 §8.1, numbers in the
 * messages refer to its ERROR table) so that an issued invoice is never ABORTED, plus the legal
 * scenario rules of research 02 (§2.3 buyer tax numbers, §3/§20 notations and prohibitions, §5
 * deadlines, §7 corrections, §8 advance/final, §15 seller statuses).
 */
import { normalizeXmlText } from '../nav/xml.ts';
import { amountDecimals, cashRoundHuf, computeLine } from './calc.ts';
import { daysBetween, isIsoDate } from './dates.ts';
import { visibleLength } from './format.ts';
import { D, dec, toDec, type DecValue } from './decimal.ts';
import type { Address, CustomerData, Invoice, InvoiceLine, IsoDate, LineNature, SellerProfile, ValidationIssue } from './types.ts';
import { toNavUnit } from './units.ts';
import { getVatInfo, isVatCode, VAT_CODES } from './vat.ts';

export interface HuTaxNumber {
  /** "12345676-1-23" */
  formatted: string;
  /** 8-digit törzsszám */
  taxpayerId: string;
  /** 1 digit ÁFA-kód (may be missing when only the törzsszám was given) */
  vatCode: string | null;
  /** 2 digit megyekód */
  countyCode: string | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

const W9731 = [9, 7, 3, 1] as const;

/** 9-7-3-1 check digit of `digits` (weights repeated from the left): (10 − Σ mod 10) mod 10. */
function checkDigit9731(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * W9731[i % 4]!;
  return (10 - (sum % 10)) % 10;
}

/** True if the last digit of `block` is the 9-7-3-1 check digit of the digits before it. */
function hasValidCheckDigit(block: string): boolean {
  return /^\d{2,}$/.test(block) && checkDigit9731(block.slice(0, -1)) === Number(block.slice(-1));
}

/** NAV-valid megyekódok (NAV spec 4.1, WARN INCORRECT_COUNTY_CODE_*): 02–20, 22–44, 51. */
const HU_COUNTY_CODES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 19 }, (_, i) => String(i + 2).padStart(2, '0')),
  ...Array.from({ length: 23 }, (_, i) => String(i + 22)),
  '51',
]);

/**
 * Text as the NAV XML builder sends it (normalizeXmlText): control whitespace → space, characters XML cannot
 * carry dropped, trimmed. So a field made only of such characters fails as missing here, not at reporting.
 */
function clean(v: unknown): string {
  return typeof v === 'string' ? (normalizeXmlText(v, Number.MAX_SAFE_INTEGER) ?? '') : '';
}

/** Length in Unicode code points (the XSD length facets count characters, not UTF-16 units). */
function len(s: string): number {
  return Array.from(s).length;
}

function num(v: unknown): DecValue | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  try {
    return dec(v);
  } catch {
    return null;
  }
}

/** XSD totalDigits of a decimal value (integer digits without leading zeros + fraction digits). */
function totalDigits(d: DecValue): number {
  const [int = '', frac = ''] = toDec(d).replace('-', '').split('.');
  return int.replace(/^0+/, '').length + frac.length;
}

/** base:MonetaryType: totalDigits 18, fractionDigits 2. */
function monetaryOk(d: DecValue): boolean {
  return d.decimalPlaces() <= 2 && totalDigits(d) <= 18;
}

/** data:QuantityType (quantity, unitPrice, unitPriceHUF): totalDigits 22, fractionDigits 10. */
function quantityTypeOk(d: DecValue): boolean {
  return d.decimalPlaces() <= 10 && totalDigits(d) <= 22;
}

/** data:ExchangeRateType: > 0, totalDigits 14, fractionDigits 6. */
function exchangeRateTypeOk(d: DecValue): boolean {
  return d.gt(0) && d.decimalPlaces() <= 6 && totalDigits(d) <= 14;
}

/** base:InvoiceDateType: a real calendar date, not before 2010-01-01. */
function validInvoiceDate(s: unknown): s is IsoDate {
  return typeof s === 'string' && isIsoDate(s) && s >= '2010-01-01';
}

/** "YYYY-MM-DD" + n years as a comparable string (29 Feb stays 29 Feb – still compares correctly). */
function plusYears(date: IsoDate, years: number): string {
  return `${String(Number(date.slice(0, 4)) + years).padStart(4, '0')}${date.slice(4)}`;
}

/** The 15th day of the month after the month of `date` (Áfa tv. 163. § (2) a)). */
function fifteenthOfNextMonth(date: IsoDate): IsoDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class Issues {
  readonly list: ValidationIssue[] = [];

  error(code: string, message: string, field?: string): void {
    this.push('error', code, message, field);
  }

  warn(code: string, message: string, field?: string): void {
    this.push('warning', code, message, field);
  }

  /** Adds issues of a nested object, prefixing their field pointers. */
  addAll(items: ValidationIssue[], prefix: string): void {
    for (const i of items) this.list.push({ ...i, field: i.field ? `${prefix}.${i.field}` : prefix });
  }

  private push(severity: ValidationIssue['severity'], code: string, message: string, field: string | undefined): void {
    this.list.push(field === undefined ? { severity, code, message } : { severity, code, message, field });
  }
}

// ---------------------------------------------------------------------------------------------
// Adószám
// ---------------------------------------------------------------------------------------------

/**
 * Accepts "12345676-1-23", "12345676123", "12345676" (törzsszám only), with or without "HU" prefix
 * of a community VAT number ("HU12345676" → törzsszám). Verifies the törzsszám check digit.
 */
export function parseHuTaxNumber(input: string): ParseResult<HuTaxNumber> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return fail('Az adószám üres. Formátum: 12345676-1-23 (vagy csak a 8 jegyű törzsszám).');
  const s = raw
    .toUpperCase()
    .replace(/^HU[\s.-]*(?=\d)/, '')
    .replace(/[\s.]/g, '');
  const m = /^(\d{8})(?:-?(\d)-?(\d{2}))?$/.exec(s);
  if (!m) {
    return fail(`"${raw}" nem adószám formátumú. Formátum: 12345676-1-23 (8 jegyű törzsszám, 1 jegyű áfakód, 2 jegyű megyekód) vagy csak a 8 jegyű törzsszám.`);
  }
  const taxpayerId = m[1] as string;
  if (!hasValidCheckDigit(taxpayerId)) {
    return fail(`A törzsszám (${taxpayerId}) ellenőrző számjegye (8. jegy) nem stimmel – valószínűleg elírás. Ellenőrizd az adószámot.`);
  }
  const vatCode = m[2] ?? null;
  const countyCode = m[3] ?? null;
  if (vatCode === null || countyCode === null) return ok({ formatted: taxpayerId, taxpayerId, vatCode: null, countyCode: null });
  if (!/^[1-5]$/.test(vatCode)) {
    return fail(`Az adószám 9. jegye (áfakód) csak 1–5 lehet, megadva: ${vatCode}.`);
  }
  if (!HU_COUNTY_CODES.has(countyCode)) {
    return fail(`Az adószám utolsó két jegye (megyekód) érvénytelen: ${countyCode} (lehetséges: 02–20, 22–44, 51).`);
  }
  return ok({ formatted: `${taxpayerId}-${vatCode}-${countyCode}`, taxpayerId, vatCode, countyCode });
}

// ---------------------------------------------------------------------------------------------
// Közösségi adószám
// ---------------------------------------------------------------------------------------------

/** VIES "structure of VAT numbers" table (research 06 §2.2), country prefix removed. */
const EU_VAT_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^(?=[0-9A-Z]{9}$)(?!\d{9}$)[0-9A-Z]\d{7}[0-9A-Z]$/,
  FI: /^\d{8}$/,
  FR: /^[0-9A-Z]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(?:\d[0-9A-Z+*]\d{5}[A-Z]|\d{7}[A-Z]{2})$/,
  IT: /^\d{11}$/,
  LT: /^(?:\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^[0-9A-Z+*]{12}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** NTCA common:CommunityVatNumberType (length 4–15). */
const NAV_COMMUNITY_VAT_RE = /^[A-Z]{2}[0-9A-Z]{2,13}$/;

/** EU VAT number incl. country prefix ("HU12345676", "DE123456789"); format check per member state. */
export function parseEuVatNumber(input: string): ParseResult<{ countryCode: string; number: string; formatted: string }> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return fail('A közösségi adószám üres. Országkóddal együtt add meg, pl. DE123456789.');
  const s = raw.toUpperCase().replace(/[\s.-]/g, '');
  const cc = s.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(cc)) return fail(`"${raw}": a közösségi adószám a tagállam kétbetűs előtagjával kezdődik (pl. DE123456789, HU12345676).`);
  if (cc === 'GR') return fail('Görögország közösségi adószámának előtagja EL (nem GR), pl. EL123456789.');
  if (cc === 'GB') {
    return fail('Az Egyesült Királyság nem EU-tagállam: a GB-s áfaszámot harmadik országbeli adóazonosítóként add meg; észak-írországi áruügyletnél XI előtag használható.');
  }
  const re = EU_VAT_FORMATS[cc];
  if (!re) return fail(`"${cc}" nem EU-tagállami (VIES) előtag. Harmadik országbeli (nem uniós) vevő adóazonosítóját harmadik országbeli adóazonosítóként add meg, ne közösségi adószámként.`);
  let body = s.slice(2);
  let suffix = '';
  // EU small-enterprise scheme identification number (Directive 2020/285, Áfa tv. 195/I. §): "…EX".
  if (!re.test(body) && body.endsWith('EX') && re.test(body.slice(0, -2))) {
    suffix = 'EX';
    body = body.slice(0, -2);
  }
  if (!re.test(body)) return fail(`"${raw}" nem felel meg a(z) ${cc} közösségi adószám formátumának (VIES).`);
  if (cc === 'HU' && !hasValidCheckDigit(body)) return fail(`A magyar közösségi adószám törzsszámának (${body}) ellenőrző számjegye nem stimmel – valószínűleg elírás.`);
  const formatted = `${cc}${body}${suffix}`;
  if (!NAV_COMMUNITY_VAT_RE.test(formatted)) {
    return fail(`"${raw}" a NAV adatszolgáltatásban nem adható meg (csak betű és számjegy lehet, a "+" és "*" nem). Ellenőrizd a VIES-ben a pontos alakot.`);
  }
  return ok({ countryCode: cc, number: `${body}${suffix}`, formatted });
}

// ---------------------------------------------------------------------------------------------
// Bankszámlaszám
// ---------------------------------------------------------------------------------------------

/** IBAN length per country (SWIFT IBAN registry). Unknown countries: NAV's 15–34 characters. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
  RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
};

/** ISO 13616 / ISO 7064 mod 97-10 over an IBAN of any length (no BigInt needed). */
function ibanMod97(iban: string): number {
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

function giroError(digits: string): string | null {
  if (!hasValidCheckDigit(digits.slice(0, 8))) {
    return 'az első 8 jegy (pénzforgalmi szolgáltató és fiók azonosítója) ellenőrző számjegye nem stimmel – valószínűleg elírás.';
  }
  if (!hasValidCheckDigit(digits.slice(8))) {
    return `a 9–${digits.length}. jegy (számlaazonosító) ellenőrző számjegye nem stimmel – valószínűleg elírás.`;
  }
  return null;
}

/** Hungarian GIRO account (2×8 / 3×8 digits, check digits verified) or IBAN (mod-97 verified). */
export function parseBankAccount(input: string): ParseResult<{ kind: 'giro' | 'iban'; formatted: string }> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return fail('A bankszámlaszám üres.');
  const compact = raw.toUpperCase().replace(/[\s-]/g, '');
  if (/^\d+$/.test(compact)) {
    if (compact.length !== 16 && compact.length !== 24) {
      return fail(`A belföldi bankszámlaszám 16 (2×8) vagy 24 (3×8) számjegy, megadva ${compact.length} számjegy ("${raw}").`);
    }
    const e = giroError(compact);
    if (e) return fail(`A bankszámlaszám hibás: ${e}`);
    return ok({ kind: 'giro', formatted: (compact.match(/\d{8}/g) ?? []).join('-') });
  }
  if (/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) {
    const cc = compact.slice(0, 2);
    const expected = IBAN_LENGTHS[cc];
    if (expected !== undefined ? compact.length !== expected : compact.length < 15 || compact.length > 34) {
      return fail(`Az IBAN hossza hibás: ${compact.length} karakter${expected !== undefined ? `, a(z) ${cc} IBAN ${expected} karakteres` : ''}.`);
    }
    if (ibanMod97(compact) !== 1) return fail('Az IBAN ellenőrző számjegyei (3–4. karakter) nem stimmelnek – valószínűleg elírás.');
    if (cc === 'HU') {
      const bban = compact.slice(4);
      if (!/^\d{24}$/.test(bban)) return fail('A magyar IBAN a HU és 2 ellenőrző jegy után 24 számjegyet tartalmaz.');
      const e = giroError(bban);
      if (e) return fail(`Az IBAN-ban szereplő belföldi számlaszám hibás: ${e}`);
    }
    return ok({ kind: 'iban', formatted: compact });
  }
  return fail(`"${raw}" nem bankszámlaszám. Formátum: 2×8 vagy 3×8 számjegy (pl. 11773016-11111018) vagy IBAN (pl. HU42 1177 3016 1111 1018 0000 0000).`);
}

// ---------------------------------------------------------------------------------------------
// Irányítószám
// ---------------------------------------------------------------------------------------------

/** Postal code formats of frequent partner countries (after upper-casing). */
const POSTAL_CODE_FORMATS: Readonly<Record<string, RegExp>> = {
  // Magyar Posta: 4 digits, first 1–9 (Budapest 1xxx incl. PO-box codes such as 1438).
  HU: /^[1-9]\d{3}$/,
  AT: /^\d{4}$/,
  BE: /^\d{4}$/,
  BG: /^\d{4}$/,
  CH: /^\d{4}$/,
  CY: /^\d{4}$/,
  DK: /^\d{4}$/,
  NO: /^\d{4}$/,
  LU: /^(?:L-?)?\d{4}$/,
  SI: /^(?:SI-?)?\d{4}$/,
  LV: /^(?:LV-?)?\d{4}$/,
  DE: /^\d{5}$/,
  EE: /^\d{5}$/,
  ES: /^\d{5}$/,
  FI: /^\d{5}$/,
  FR: /^\d{5}$/,
  HR: /^\d{5}$/,
  IT: /^\d{5}$/,
  RS: /^\d{5}$/,
  UA: /^\d{5}$/,
  LT: /^(?:LT-?)?\d{5}$/,
  US: /^\d{5}(?:-\d{4})?$/,
  CZ: /^\d{3} ?\d{2}$/,
  SK: /^\d{3} ?\d{2}$/,
  SE: /^\d{3} ?\d{2}$/,
  GR: /^\d{3} ?\d{2}$/,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  RO: /^\d{6}$/,
  NL: /^\d{4} ?[A-Z]{2}$/,
  IE: /^[A-Z]\d[\dW](?: ?[0-9AC-FHKNPRTV-Y]{4})?$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/,
  MT: /^[A-Z]{3} ?\d{2,4}$/,
};

/** NTCA common:PostalCodeType. */
const NAV_POSTAL_CODE_RE = /^[A-Z0-9][A-Z0-9 -]{1,8}[A-Z0-9]$/;

export function isValidPostalCode(countryCode: string, postalCode: string): boolean {
  if (typeof countryCode !== 'string' || typeof postalCode !== 'string') return false;
  const cc = countryCode.trim().toUpperCase();
  const pc = postalCode.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!pc || !NAV_POSTAL_CODE_RE.test(pc)) return false;
  const re = POSTAL_CODE_FORMATS[cc];
  return re ? re.test(pc) : true;
}

// ---------------------------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------------------------

/** Name, address and lengths as NAV accepts them (SimpleText…NotBlankType facets). */
function checkAddress(out: Issues, addr: Address | null | undefined, code: string, who: string, opts: { foreignPostalWarning: boolean }): void {
  if (!addr || typeof addr !== 'object') {
    out.error(`${code}_ADDRESS_REQUIRED`, `Hiányzik ${who} címe (169. § e)). Add meg az országkódot, az irányítószámot, a települést és az utcát, házszámot.`, 'address');
    return;
  }
  const cc = clean(addr.countryCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    out.error(`${code}_COUNTRY_INVALID`, `${capital(who)} címének országkódja érvénytelen: "${String(addr.countryCode)}". Kétbetűs ISO 3166-1 kódot adj meg (pl. HU, DE, AT).`, 'address.countryCode');
  } else if (cc === 'EL' || cc === 'UK') {
    out.warn(`${code}_COUNTRY_CODE`, `A címben az ISO 3166-1 országkódot használd: ${cc === 'EL' ? 'GR (Görögország)' : 'GB (Egyesült Királyság)'} – az EL/XI előtag csak a közösségi adószámban szerepel.`, 'address.countryCode');
  }
  const pc = clean(addr.postalCode);
  if (cc === 'HU') {
    if (!pc) out.error(`${code}_POSTAL_CODE_REQUIRED`, `${capital(who)} magyar címéből hiányzik az irányítószám (4 számjegy, pl. 1117).`, 'address.postalCode');
    else if (!isValidPostalCode('HU', pc)) out.error(`${code}_POSTAL_CODE_INVALID`, `${capital(who)} irányítószáma érvénytelen: "${pc}". A magyar irányítószám 4 számjegy, nem kezdődhet 0-val (pl. 1117, 6720).`, 'address.postalCode');
  } else if (pc && /^[A-Z]{2}$/.test(cc) && !isValidPostalCode(cc, pc) && opts.foreignPostalWarning) {
    out.warn(`${code}_POSTAL_CODE_FORMAT`, `${capital(who)} irányítószáma ("${pc}") nem a(z) ${cc} szokásos formátuma; ellenőrizd. A NAV-jelentésbe a szabványnak nem megfelelő irányítószám helyett „0000” kerül.`, 'address.postalCode');
  }
  const city = clean(addr.city);
  if (!city) out.error(`${code}_CITY_REQUIRED`, `Hiányzik ${who} címéből a település neve.`, 'address.city');
  else if (len(city) > 255) out.error(`${code}_CITY_TOO_LONG`, `${capital(who)} településneve legfeljebb 255 karakter lehet (NAV).`, 'address.city');
  const line = clean(addr.addressLine);
  if (!line) out.error(`${code}_ADDRESS_LINE_REQUIRED`, `Hiányzik ${who} címéből az utca, házszám (addressLine), pl. „Fő utca 1.”.`, 'address.addressLine');
  else if (len(line) > 255) out.error(`${code}_ADDRESS_LINE_TOO_LONG`, `${capital(who)} címsora legfeljebb 255 karakter lehet (NAV).`, 'address.addressLine');
  if (addr.region !== undefined && len(clean(addr.region)) > 50) {
    out.error(`${code}_REGION_TOO_LONG`, `${capital(who)} címének régió mezője legfeljebb 50 karakter lehet (NAV).`, 'address.region');
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function checkName(out: Issues, name: unknown, code: string, who: string): string {
  const n = clean(name);
  // A name that shows nothing (only fillers such as U+3164, visibleLength) would print blank: missing too.
  if (!n || visibleLength(n) === 0) out.error(`${code}_NAME_REQUIRED`, `${capital(who)} neve kötelező (Áfa tv. 169. § e)).`, 'name');
  else if (len(n) > 512) out.error(`${code}_NAME_TOO_LONG`, `${capital(who)} neve legfeljebb 512 karakter lehet (NAV), most ${len(n)}. Rövidítsd.`, 'name');
  return n;
}

const EV_DESIGNATION_RE = /(?:^|[\s,(])e\.\s?v\.?(?=$|[\s,)])|egyéni\s+vállalkozó/i;

export function validateSeller(seller: SellerProfile): ValidationIssue[] {
  const out = new Issues();
  if (!seller || typeof seller !== 'object') {
    out.error('SELLER_MISSING', 'Hiányoznak az eladó (saját cég) adatai. Állítsd be őket: név, adószám, cím, ÁFA-státusz.');
    return out.list;
  }
  const name = checkName(out, seller.name, 'SELLER', 'az eladó');
  const status = seller.vatStatus;
  if (status !== 'normal' && status !== 'aam') {
    out.error('SELLER_VAT_STATUS_INVALID', `Ismeretlen ÁFA-státusz: "${String(status)}". Lehetséges: normal (általános szabályok szerint adózó) vagy aam (alanyi adómentes).`, 'vatStatus');
  }

  let tax: HuTaxNumber | null = null;
  if (!clean(seller.taxNumber)) {
    out.error('SELLER_TAX_NUMBER_REQUIRED', 'Az eladó adószáma kötelező (Áfa tv. 169. § c)). Formátum: 12345676-1-23.', 'taxNumber');
  } else {
    const p = parseHuTaxNumber(seller.taxNumber);
    if (!p.ok) {
      out.error('SELLER_TAX_NUMBER_INVALID', `Az eladó adószáma érvénytelen: ${p.error}`, 'taxNumber');
    } else {
      tax = p.value;
      if (!tax.vatCode || !tax.countyCode) {
        out.error('SELLER_TAX_NUMBER_INCOMPLETE', 'Az eladó adószámát teljes, 11 jegyű formában add meg (12345676-1-23): az áfakód és a megyekód is kell.', 'taxNumber');
      } else if (tax.vatCode === '4') {
        out.error(
          'SELLER_TAX_NUMBER_GROUP_MEMBER',
          'Az adószám 9. jegye 4, ez egy áfacsoport tagjának saját adószáma. Csoporttagként a csoportazonosító számot (…-5-…) add meg adószámként, a saját adószámodat csoporttagi adószámként (Art. 30. § (2); NAV: az eladó áfakódja nem lehet 4).',
          'taxNumber',
        );
      } else if (tax.vatCode === '5' && !clean(seller.groupMemberTaxNumber)) {
        out.error(
          'SELLER_GROUP_MEMBER_TAX_NUMBER_REQUIRED',
          'Csoportazonosító szám (…-5-…) mellett a csoporttag saját adószámát is fel kell tüntetni (Art. 30. § (2), Áfa tv. 10. melléklet 5/C. pont; a NAV tesztkörnyezete 2026 óta elutasítja nélküle). Add meg csoporttagi adószámként.',
          'groupMemberTaxNumber',
        );
      }
    }
  }
  if (clean(seller.groupMemberTaxNumber)) {
    const p = parseHuTaxNumber(seller.groupMemberTaxNumber as string);
    if (!p.ok) {
      out.error('SELLER_GROUP_MEMBER_TAX_NUMBER_INVALID', `A csoporttagi adószám érvénytelen: ${p.error}`, 'groupMemberTaxNumber');
    } else {
      if (!p.value.vatCode || !p.value.countyCode) {
        out.error('SELLER_GROUP_MEMBER_TAX_NUMBER_INCOMPLETE', 'A csoporttagi adószámot teljes, 11 jegyű formában add meg (12345676-4-23).', 'groupMemberTaxNumber');
      } else if (p.value.vatCode !== '4') {
        out.warn('SELLER_GROUP_MEMBER_TAX_NUMBER_VAT_CODE', `A csoporttag saját adószámának áfakódja (9. jegy) 4 szokott lenni, itt ${p.value.vatCode}. Ellenőrizd az adószámot.`, 'groupMemberTaxNumber');
      }
      if (tax?.vatCode && tax.vatCode !== '5') {
        out.error(
          'SELLER_GROUP_MEMBER_WITHOUT_GROUP',
          'Csoporttagi adószám csak csoportazonosító szám (…-5-…) mellett adható meg. Áfacsoport tagjaként a csoportazonosító legyen az adószám; ha nem vagy csoporttag, töröld a csoporttagi adószámot.',
          'groupMemberTaxNumber',
        );
      }
    }
  }
  if (clean(seller.euVatNumber)) {
    const p = parseEuVatNumber(seller.euVatNumber as string);
    if (!p.ok) {
      out.error('SELLER_EU_VAT_NUMBER_INVALID', `Az eladó közösségi adószáma érvénytelen: ${p.error}`, 'euVatNumber');
    } else if (p.value.countryCode !== 'HU') {
      out.error('SELLER_EU_VAT_NUMBER_NOT_HU', `Az eladó közösségi adószáma HU + a törzsszám (pl. HU12345676); megadva: ${p.value.formatted}.`, 'euVatNumber');
    } else if (tax && p.value.number.slice(0, 8) !== tax.taxpayerId) {
      out.error(
        'SELLER_EU_VAT_NUMBER_MISMATCH',
        `A közösségi adószám (${p.value.formatted}) nem az adószám törzsszámából képzett; helyesen: HU${tax.taxpayerId} (áfacsoportnál a csoportazonosító törzsszáma). NAV: INCORRECT_HEAD_DATA_SUPPLIER_COMMUNITY_VAT_NUMBER.`,
        'euVatNumber',
      );
    }
  }
  checkAddress(out, seller.address, 'SELLER', 'az eladó', { foreignPostalWarning: true });
  if (clean(seller.bankAccount)) {
    const p = parseBankAccount(seller.bankAccount as string);
    if (!p.ok) out.error('SELLER_BANK_ACCOUNT_INVALID', `Az eladó bankszámlaszáma érvénytelen: ${p.error}`, 'bankAccount');
  }
  if (clean(seller.email) && !EMAIL_RE.test(clean(seller.email))) {
    out.warn('SELLER_EMAIL_INVALID', `Az eladó e-mail címe nem tűnik érvényesnek: "${clean(seller.email)}".`, 'email');
  }
  if (status === 'aam' && seller.cashAccounting === true) {
    out.error(
      'SELLER_AAM_CASH_ACCOUNTING',
      'Alanyi adómentes adóalany nem alkalmazhat pénzforgalmi elszámolást (nem számít fel áfát; a két különös szabály nem kombinálható). Kapcsold ki a cashAccounting beállítást, vagy állítsd az ÁFA-státuszt normal-ra.',
      'cashAccounting',
    );
  }
  // The county code tells companies (02–20) and sole proprietors (22–40) apart (NAV spec 4.1).
  const county = tax?.countyCode ? Number(tax.countyCode) : null;
  const soleProprietor = county !== null && county >= 22 && county <= 40;
  const company = county !== null && county >= 2 && county <= 20;
  if (soleProprietor) {
    if (name && !EV_DESIGNATION_RE.test(name)) {
      out.warn('SELLER_EV_DESIGNATION_MISSING', 'Egyéni vállalkozó (a megyekód szerint): a név mellett az „egyéni vállalkozó” vagy „e.v.” megjelölést is fel kell tüntetni (Evtv. 16. § (4)), pl. „Kovács Anna e.v.”.', 'name');
    }
    if (!clean(seller.registrationNumber)) {
      out.warn('SELLER_REGISTRATION_NUMBER_MISSING', 'Egyéni vállalkozónál a nyilvántartási számot is fel kell tüntetni (Evtv. 16. § (4)); add meg a registrationNumber mezőben.', 'registrationNumber');
    }
  } else if (company && !clean(seller.registrationNumber)) {
    out.warn('SELLER_REGISTRATION_NUMBER_MISSING', 'Cégnél a cégjegyzékszámot a cég iratain fel kell tüntetni (Ctv. 44. § (1)); add meg a registrationNumber mezőben (pl. 01-09-123456).', 'registrationNumber');
  }
  if (seller.smallBusiness === true && company) {
    out.warn('SELLER_KATA_NOT_SOLE_PROPRIETOR', 'Kisadózó (KATA) 2022 óta csak főfoglalkozású egyéni vállalkozó lehet, a megyekód viszont társas vállalkozásra utal. Ellenőrizd a smallBusiness beállítást.', 'smallBusiness');
  }
  return out.list;
}

export function validateCustomer(customer: CustomerData): ValidationIssue[] {
  const out = new Issues();
  if (!customer || typeof customer !== 'object') {
    out.error('CUSTOMER_MISSING', 'Hiányoznak a vevő adatai (név, cím, ÁFA-státusz).');
    return out.list;
  }
  const status = customer.vatStatus;
  if (status !== 'DOMESTIC' && status !== 'OTHER' && status !== 'PRIVATE_PERSON') {
    out.error(
      'CUSTOMER_VAT_STATUS_INVALID',
      `Ismeretlen vevő-státusz: "${String(status)}". Lehetséges: DOMESTIC (belföldi áfaalany), OTHER (külföldi vagy belföldi nem áfaalany szervezet), PRIVATE_PERSON (magánszemély).`,
      'vatStatus',
    );
  }
  checkName(out, customer.name, 'CUSTOMER', 'a vevő');
  checkAddress(out, customer.address, 'CUSTOMER', 'a vevő', { foreignPostalWarning: status !== 'PRIVATE_PERSON' });
  const country = clean(customer.address?.countryCode).toUpperCase();

  let tax: HuTaxNumber | null = null;
  if (clean(customer.taxNumber)) {
    const p = parseHuTaxNumber(customer.taxNumber as string);
    if (!p.ok) out.error('CUSTOMER_TAX_NUMBER_INVALID', `A vevő adószáma érvénytelen: ${p.error}`, 'taxNumber');
    else tax = p.value;
  }
  let eu: { countryCode: string; number: string; formatted: string } | null = null;
  if (clean(customer.euVatNumber)) {
    const p = parseEuVatNumber(customer.euVatNumber as string);
    if (!p.ok) out.error('CUSTOMER_EU_VAT_NUMBER_INVALID', `A vevő közösségi adószáma érvénytelen: ${p.error}`, 'euVatNumber');
    else eu = p.value;
  }
  const thirdState = clean(customer.thirdStateTaxId);
  if (thirdState && len(thirdState) > 50) {
    out.error('CUSTOMER_THIRD_STATE_TAX_ID_TOO_LONG', 'A harmadik országbeli adóazonosító legfeljebb 50 karakter lehet (NAV).', 'thirdStateTaxId');
  }

  if (status === 'DOMESTIC') {
    if (!clean(customer.taxNumber)) {
      out.error(
        'CUSTOMER_TAX_NUMBER_REQUIRED',
        'Belföldi áfaalany (DOMESTIC) vevőnél az adószám kötelező (Áfa tv. 169. § d); NAV: MISSING_CUSTOMER_DOMESTIC_TAXNUMBER). Add meg (12345676-1-23), vagy ha a vevő nem áfaalany, válaszd az OTHER / PRIVATE_PERSON státuszt.',
        'taxNumber',
      );
    } else if (tax) {
      if (!tax.vatCode || !tax.countyCode) {
        out.warn('CUSTOMER_TAX_NUMBER_SHORT', 'A vevőnek csak a törzsszáma (8 jegy) van megadva. Belföldi ügyletnél ez elég (169. § dc)), fordított adózásnál viszont a teljes adószám kell (12345676-1-23).', 'taxNumber');
      } else if (tax.vatCode === '4') {
        out.warn(
          'CUSTOMER_TAX_NUMBER_GROUP_MEMBER',
          'A vevő adószámának 9. jegye 4 (áfacsoport tagja). A számlán a csoportazonosító szám kell (169. § dc)): add meg a csoportazonosítót (…-5-…) adószámként, a tag adószámát csoporttagi adószámként.',
          'taxNumber',
        );
      }
      if (country && country !== 'HU' && tax.countyCode !== '51') {
        out.warn('CUSTOMER_DOMESTIC_FOREIGN_ADDRESS', 'Belföldi áfaalany (DOMESTIC) vevő külföldi címmel: ellenőrizd a vevő státuszát (külföldi adóalany → OTHER, közösségi adószámmal).', 'vatStatus');
      }
    }
    if (clean(customer.groupMemberTaxNumber)) {
      const p = parseHuTaxNumber(customer.groupMemberTaxNumber as string);
      if (!p.ok) out.error('CUSTOMER_GROUP_MEMBER_TAX_NUMBER_INVALID', `A vevő csoporttagi adószáma érvénytelen: ${p.error}`, 'groupMemberTaxNumber');
      else if (tax?.vatCode && tax.vatCode !== '5') {
        out.warn('CUSTOMER_GROUP_MEMBER_WITHOUT_GROUP', 'Csoporttagi adószám mellett a vevő adószáma a csoportazonosító szám (…-5-…) legyen.', 'groupMemberTaxNumber');
      }
    }
  } else if (status === 'OTHER') {
    if (eu && thirdState) {
      out.warn('CUSTOMER_MULTIPLE_TAX_IDS', 'A vevőnek közösségi és harmadik országbeli adóazonosítója is van; a NAV-ba csak egy kerülhet (a közösségi adószám). Hagyd meg a megfelelőt.', 'thirdStateTaxId');
    }
    if (eu?.countryCode === 'HU') {
      out.warn('CUSTOMER_OTHER_WITH_HU_VAT_NUMBER', 'Magyar közösségi adószámú vevő belföldi áfaalany: a státusza DOMESTIC legyen, az adószámával (12345676-1-23).', 'vatStatus');
    }
    if (tax?.vatCode && tax.vatCode !== '1') {
      out.warn(
        'CUSTOMER_OTHER_DOMESTIC_TAXPAYER',
        'A vevő magyar adószáma áfaalanyra utal (áfakód 2–5): belföldi áfaalany vevő státusza DOMESTIC (NAV WARN INCORRECT_HEAD_DATA_CUSTOMERVATSTATUS). Ha a vevő valóban nem áfaalany, hagyd OTHER-en.',
        'vatStatus',
      );
    }
  } else if (status === 'PRIVATE_PERSON') {
    if (clean(customer.taxNumber) || clean(customer.euVatNumber) || clean(customer.groupMemberTaxNumber)) {
      out.warn(
        'CUSTOMER_PRIVATE_PERSON_TAX_ID',
        'Magánszemély (PRIVATE_PERSON) vevőnek adószáma van megadva. Ha adóalanyként (pl. egyéni vállalkozóként) vásárol, a státusza DOMESTIC vagy OTHER legyen; magánszemély adatai nem kerülnek a NAV-hoz.',
        'vatStatus',
      );
    }
  }
  if (clean(customer.email) && !EMAIL_RE.test(clean(customer.email))) {
    out.warn('CUSTOMER_EMAIL_INVALID', `A vevő e-mail címe nem tűnik érvényesnek: "${clean(customer.email)}".`, 'email');
  }
  if (clean(customer.bankAccount)) {
    const p = parseBankAccount(customer.bankAccount as string);
    if (!p.ok) out.warn('CUSTOMER_BANK_ACCOUNT_INVALID', `A vevő bankszámlaszáma nem ellenőrizhető: ${p.error}`, 'bankAccount');
  }
  return out.list;
}

// ---------------------------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------------------------

export interface InvoiceValidationContext {
  /** Today in Hungary. */
  today: IsoDate;
  /** For modification/storno: the original invoice. */
  original?: Invoice | null;
  /**
   * For modification/storno: the issued documents that already correct the original (its modifications
   * and storno, without the one validated). They give the invoice's current fulfilment date
   * (chainFulfillmentDate) and, with the original, the amounts a modification changes – and those a storno
   * must negate (STORNO_CHAIN_MISMATCH; checked only when the chain is given).
   */
  chain?: readonly Invoice[];
  /**
   * The seller's exchange-rate policy (InvoiceDefaults.exchangeRateSource). Only words the message of a
   * missing rate: with 'MNB' the automatic MNB lookup failed, with 'manual' the rate has to be entered.
   */
  exchangeRatePolicy?: 'MNB' | 'manual';
}

/**
 * The current fulfilment date (teljesítés dátuma) of an invoice with corrections: that of its latest
 * issued modification (highest modificationIndex) – a modification correcting the date carries the new
 * one, and NAV compares later modifications and the storno with the last modifying document (spec
 * 3.45.1, WARN 11400/11401) –, otherwise the original's. `source` is the document that set it: the
 * original when no modification changed it.
 */
export function chainFulfillmentDate(original: Invoice, chain: readonly Invoice[]): { date: IsoDate; source: Invoice } {
  const mods = chain.filter((d) => d.documentType === 'modification' && d.status !== 'draft');
  mods.sort((a, b) => (a.reference?.modificationIndex ?? 0) - (b.reference?.modificationIndex ?? 0));
  const docs = [original, ...mods];
  const date = (docs.at(-1) as Invoice).fulfillmentDate;
  let i = docs.length - 1;
  while (i > 0 && docs[i - 1]?.fulfillmentDate === date) i--;
  return { date, source: docs[i] as Invoice };
}

/**
 * NAV ERROR 78 INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME (CREATE, MODIFY): watched currencies and the
 * accepted HUF / unit band (NAV spec 2026.02.12, ERROR table row 78; may change without notice).
 */
const EXCHANGE_RATE_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  EUR: [250, 600],
  USD: [200, 600],
  GBP: [250, 720],
  CHF: [200, 600],
  BGN: [120, 360],
  RON: [50, 180],
  PLN: [50, 180],
  SEK: [20, 72],
  NOK: [20, 72],
  CZK: [5, 48],
  ILS: [40, 240],
  DKK: [20, 120],
  BAM: [100, 360],
};

const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['invoice', 'advance', 'final', 'modification', 'storno', 'proforma']);
const PAYMENT_METHODS: ReadonlySet<string> = new Set(['TRANSFER', 'CASH', 'CARD', 'VOUCHER', 'OTHER']);
const APPEARANCES: ReadonlySet<string> = new Set(['ELECTRONIC', 'PAPER']);
const LANGUAGES: ReadonlySet<string> = new Set(['hu', 'en', 'hu-en']);
const NATURES: ReadonlySet<string> = new Set(['PRODUCT', 'SERVICE', 'OTHER']);

/** Alanyi adómentesség értékhatára (Áfa tv. 188. § (2), research 02 §15). */
function aamThresholdHuf(year: number): number {
  if (year >= 2028) return 24_000_000;
  if (year === 2027) return 22_000_000;
  if (year === 2026) return 20_000_000;
  if (year === 2025) return 18_000_000;
  return 12_000_000;
}

interface Amounts {
  net: DecValue;
  vat: DecValue;
  gross: DecValue;
  netHuf: DecValue;
  vatHuf: DecValue;
  grossHuf: DecValue;
}

const AMOUNT_KEYS = ['net', 'vat', 'gross', 'netHuf', 'vatHuf', 'grossHuf'] as const;
const AMOUNT_FIELDS: Record<(typeof AMOUNT_KEYS)[number], 'netAmount' | 'vatAmount' | 'grossAmount' | 'netAmountHuf' | 'vatAmountHuf' | 'grossAmountHuf'> = {
  net: 'netAmount',
  vat: 'vatAmount',
  gross: 'grossAmount',
  netHuf: 'netAmountHuf',
  vatHuf: 'vatAmountHuf',
  grossHuf: 'grossAmountHuf',
};

function zeroAmounts(): Amounts {
  return { net: new D(0), vat: new D(0), gross: new D(0), netHuf: new D(0), vatHuf: new D(0), grossHuf: new D(0) };
}

function amountsOf(o: unknown): Amounts | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const a: Partial<Amounts> = {};
  for (const k of AMOUNT_KEYS) {
    const v = num(r[AMOUNT_FIELDS[k]]);
    if (!v) return null;
    a[k] = v;
  }
  return a as Amounts;
}

function addAmounts(acc: Amounts, a: Amounts): void {
  for (const k of AMOUNT_KEYS) acc[k] = acc[k].plus(a[k]);
}

function sameAmounts(a: Amounts, b: Amounts): (typeof AMOUNT_KEYS)[number][] {
  return AMOUNT_KEYS.filter((k) => !a[k].eq(b[k]));
}

/**
 * Validates a (draft) invoice with computed lines/totals. Must cover at least: seller completeness,
 * customer data per vatStatus (DOMESTIC → valid HU tax number; OTHER → EU VAT number or third-state id
 * when the VAT code needs a taxable buyer; PRIVATE_PERSON → name+address required on the invoice),
 * at least one line, non-empty descriptions, quantity ≠ 0, VAT code allowed for the seller's status
 * (AAM sellers → AAM or out-of-scope codes only), VAT code vs customer scope (e.g. KBAET needs an EU
 * VAT number of another member state), dates (issue date not in the future beyond today, fulfillment
 * date plausibility vs issue date per Áfa tv. deadlines → warning, due date ≥ issue date), currency ↔
 * exchange rate (HUF → 1; foreign → > 0), document-type rules (storno/modification need a reference;
 * final invoices: advance deduction lines), amount limits of NAV types, text length limits of NAV
 * (description 512, names 512, etc.).
 */
export function validateInvoice(invoice: Invoice, ctx: InvoiceValidationContext): ValidationIssue[] {
  const out = new Issues();
  if (!invoice || typeof invoice !== 'object') {
    out.error('INVOICE_MISSING', 'Hiányzó számlaadat.');
    return out.list;
  }
  const docType = invoice.documentType;
  if (!DOCUMENT_TYPES.has(docType)) {
    out.error('DOCUMENT_TYPE_INVALID', `Ismeretlen bizonylattípus: "${String(docType)}" (invoice, advance, final, modification, storno, proforma).`, 'documentType');
  }
  const correction = docType === 'modification' || docType === 'storno';
  /** NAV CREATE documents (and the proforma, which shares their content rules). */
  const createLike = docType === 'invoice' || docType === 'advance' || docType === 'final';
  const today = ctx && typeof ctx.today === 'string' && isIsoDate(ctx.today) ? ctx.today : null;
  const original = ctx?.original ?? null;
  const seller = invoice.seller;
  const customer = invoice.customer;
  // A storno / modification corrects the original supply, so its lines follow the VAT status the
  // original was issued under, even if the seller's status changed since (Áfa tv. 170. §).
  const sellerStatus = correction && original?.seller ? original.seller.vatStatus : seller?.vatStatus;

  // --- Parties ---------------------------------------------------------------------------------
  out.addAll(validateSeller(seller), 'seller');
  out.addAll(validateCustomer(customer), 'customer');

  // --- Currency and exchange rate --------------------------------------------------------------
  const currency = clean(invoice.currency).toUpperCase();
  const currencyOk = /^[A-Z]{3}$/.test(currency);
  if (!currencyOk) out.error('CURRENCY_INVALID', `Érvénytelen pénznem: "${String(invoice.currency)}". Háromjegyű ISO 4217 kódot adj meg (pl. HUF, EUR, USD).`, 'currency');
  const huf = currency === 'HUF';
  const rate = num(invoice.exchangeRate);
  /** The rate can be used to check HUF amounts. */
  let rateUsable = false;
  if (huf) {
    if (!rate || !rate.eq(1)) {
      out.error('EXCHANGE_RATE_HUF_NOT_ONE', `Forintos számla árfolyama pontosan 1 (megadva: ${String(invoice.exchangeRate)}); a NAV mást elutasít (ERROR 77 INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF).`, 'exchangeRate');
    }
    rateUsable = true;
  } else if (currencyOk) {
    if (!rate || rate.lte(0)) {
      const policy = invoice.exchangeRateSource === 'manual' ? undefined : ctx?.exchangeRatePolicy;
      out.error(
        'EXCHANGE_RATE_MISSING',
        policy === 'manual'
          ? `Devizás (${currency}) számlához árfolyam kell (kézi árfolyam-beállítás): add meg az árfolyamot (1 ${currency} = ? HUF), pl. a bankod deviza eladási árfolyamát a teljesítés napján (Áfa tv. 80. §).`
          : policy === 'MNB'
            ? `Nem sikerült lekérni az MNB ${currency} árfolyamát a teljesítés napjára. Add meg kézzel az árfolyamot (1 ${currency} = ? HUF), vagy mentsd újra később a piszkozatot (a program akkor újra lekéri).`
            : `Devizás (${currency}) számlához pozitív árfolyam kell: 1 ${currency} hány forint az Áfa tv. 80. § szerinti napon (főszabály: a teljesítés napján). Add meg az árfolyamot, vagy kérd le az MNB árfolyamot.`,
        'exchangeRate',
      );
    } else {
      rateUsable = true;
      if (!exchangeRateTypeOk(rate)) {
        out.error('EXCHANGE_RATE_PRECISION', `Az árfolyam (${toDec(rate)}) legfeljebb 6 tizedesjegyű és összesen 14 jegyű lehet (NAV ExchangeRateType). Kerekítsd 6 tizedesre.`, 'exchangeRate');
      }
      const band = EXCHANGE_RATE_BANDS[currency];
      if (band && docType !== 'storno' && (rate.lt(band[0]) || rate.gt(band[1]))) {
        out.error(
          'EXCHANGE_RATE_EXTREME',
          `Az árfolyam (1 ${currency} = ${toDec(rate)} HUF) kívül esik a NAV által elfogadott ${band[0]}–${band[1]} HUF sávon (ERROR 78 INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME). Ellenőrizd: 1 egység forintértéke kell (pl. JPY-nál az MNB 100 egységre közöl).`,
          'exchangeRate',
        );
      }
      if (rate.eq(1)) {
        out.warn('EXCHANGE_RATE_ONE', `Az árfolyam 1 – devizás (${currency}) számlánál ez szinte biztosan hiba (NAV WARN). Add meg 1 ${currency} forintértékét.`, 'exchangeRate');
      }
    }
  }
  if (!huf && currencyOk && rateUsable && !correction && validInvoiceDate(invoice.exchangeRateDate) && validInvoiceDate(invoice.fulfillmentDate)) {
    // Áfa tv. 80. § (1): the rate valid on the tax point (fulfilment; for an advance invoice the
    // receipt of the advance, which is its fulfilment date) – the last one published by that day.
    const rateDate = invoice.exchangeRateDate;
    const taxPoint = invoice.fulfillmentDate;
    if (rateDate > taxPoint) {
      out.warn(
        'EXCHANGE_RATE_DATE_AFTER_TAX_POINT',
        `Az árfolyam dátuma (${rateDate}) későbbi, mint a teljesítés (adófizetési kötelezettség) napja (${taxPoint}). Az Áfa tv. 80. § szerint a teljesítéskor érvényes (utoljára közzétett) árfolyamot kell alkalmazni.`,
        'exchangeRateDate',
      );
    } else if (daysBetween(rateDate, taxPoint) > 10) {
      out.warn('EXCHANGE_RATE_DATE_OLD', `Az árfolyam ${daysBetween(rateDate, taxPoint)} nappal régebbi a teljesítés napjánál; ellenőrizd, hogy a teljesítéskor érvényes árfolyamot használod-e (Áfa tv. 80. §).`, 'exchangeRateDate');
    }
  } else if (!huf && currencyOk && rateUsable && !correction && (invoice.exchangeRateDate === null || invoice.exchangeRateDate === undefined)) {
    // Without its date the rate cannot be checked against the tax point (e.g. a rate copied from an older document).
    out.warn(
      'EXCHANGE_RATE_DATE_MISSING',
      `Az árfolyamhoz (${toDec(rate as DecValue)}) nincs dátum rögzítve, így nem ellenőrizhető, hogy a teljesítés napján érvényes-e (Áfa tv. 80. §). Add meg újra az árfolyamot, vagy mentsd újra a piszkozatot árfolyam nélkül (MNB-beállításnál a program lekéri a teljesítés napi árfolyamot).`,
      'exchangeRateDate',
    );
  }

  // --- Number --------------------------------------------------------------------------------
  if (invoice.number !== null && invoice.number !== undefined) {
    const n = typeof invoice.number === 'string' ? invoice.number : '';
    if (!clean(n)) out.error('NUMBER_EMPTY', 'A számla sorszáma üres.', 'number');
    else if (n !== n.trim()) out.error('NUMBER_WHITESPACE', `A sorszám elején/végén nem lehet szóköz vagy sortörés ("${n}"); NAV ERROR 51 INVALID_INVOICE_NUMBER.`, 'number');
    else if (len(n) > 50) out.error('NUMBER_TOO_LONG', 'A számla sorszáma legfeljebb 50 karakter lehet (NAV).', 'number');
  }

  // --- Dates ---------------------------------------------------------------------------------
  const issueOk = validInvoiceDate(invoice.issueDate);
  const fulfilmentOk = validInvoiceDate(invoice.fulfillmentDate);
  if (!issueOk) out.error('ISSUE_DATE_INVALID', `Érvénytelen kiállítási dátum: "${String(invoice.issueDate)}" (ÉÉÉÉ-HH-NN, legkorábban 2010-01-01).`, 'issueDate');
  if (!fulfilmentOk) out.error('FULFILLMENT_DATE_INVALID', `Érvénytelen teljesítési dátum: "${String(invoice.fulfillmentDate)}" (ÉÉÉÉ-HH-NN, legkorábban 2010-01-01).`, 'fulfillmentDate');
  const issueDate = issueOk ? invoice.issueDate : null;
  const fulfilment = fulfilmentOk ? invoice.fulfillmentDate : null;
  if (issueDate && today && issueDate > today) {
    out.error('ISSUE_DATE_IN_FUTURE', `A számla kelte (${issueDate}) nem lehet későbbi a mai napnál (${today}). Kiállításkor a kelte a kiállítás napja lesz – állítsd a mai napra.`, 'issueDate');
  }
  if (issueDate && fulfilment) {
    if (fulfilment > plusYears(issueDate, 5)) {
      out.error('FULFILLMENT_DATE_TOO_LATE', `A teljesítés dátuma (${fulfilment}) több mint 5 évvel a kiállítás után van; a NAV elutasítja (ERROR 54 INVOICE_DELIVERY_DATE_LATE). Javítsd a dátumot.`, 'fulfillmentDate');
    } else if (daysBetween(issueDate, fulfilment) >= 397) {
      out.warn('FULFILLMENT_DATE_FAR_AHEAD', `A teljesítés dátuma (${fulfilment}) több mint egy évvel a kiállítás után van (NAV WARN 313); ellenőrizd.`, 'fulfillmentDate');
    }
    if (docType === 'advance' && fulfilment > issueDate) {
      out.warn('ADVANCE_RECEIPT_DATE_AFTER_ISSUE', 'Előlegszámlán a teljesítés dátuma az előleg jóváírásának/kézhezvételének napja; ez nem lehet későbbi a kiállításnál. Előleg beérkezése előtt díjbekérőt (proforma) állíts ki.', 'fulfillmentDate');
    }
  }
  if (fulfilment && today && fulfilment < `${Number(today.slice(0, 4)) - 6}-01-01`) {
    out.warn('FULFILLMENT_DATE_TOO_OLD', `A teljesítés dátuma (${fulfilment}) régebbi a hatodik megelőző év első napjánál (NAV WARN 312); ellenőrizd.`, 'fulfillmentDate');
  }
  if (invoice.dueDate !== null && invoice.dueDate !== undefined) {
    if (!validInvoiceDate(invoice.dueDate)) out.error('DUE_DATE_INVALID', `Érvénytelen fizetési határidő: "${String(invoice.dueDate)}" (ÉÉÉÉ-HH-NN).`, 'dueDate');
    else if (issueDate && invoice.dueDate < issueDate) {
      out.error('DUE_DATE_BEFORE_ISSUE_DATE', `A fizetési határidő (${invoice.dueDate}) nem lehet korábbi a számla kelténél (${issueDate}). Add meg a helyes határidőt (vagy a fizetési napok számát).`, 'dueDate');
    }
  }

  // --- Header enums and texts ------------------------------------------------------------------
  if (!PAYMENT_METHODS.has(invoice.paymentMethod)) out.error('PAYMENT_METHOD_INVALID', `Ismeretlen fizetési mód: "${String(invoice.paymentMethod)}" (TRANSFER, CASH, CARD, VOUCHER, OTHER).`, 'paymentMethod');
  if (!APPEARANCES.has(invoice.appearance)) out.error('APPEARANCE_INVALID', `Ismeretlen megjelenési forma: "${String(invoice.appearance)}" (ELECTRONIC vagy PAPER).`, 'appearance');
  if (!LANGUAGES.has(invoice.language)) out.error('LANGUAGE_INVALID', `Ismeretlen számlanyelv: "${String(invoice.language)}" (hu, en, hu-en).`, 'language');
  if (invoice.paymentMethod === 'TRANSFER' && !clean(seller?.bankAccount) && docType !== 'storno') {
    out.warn('SELLER_BANK_ACCOUNT_MISSING', 'Átutalásos számlán az eladó bankszámlaszáma nincs megadva, így a vevő nem tudja, hová utaljon. Add meg az eladói adatokban.', 'seller.bankAccount');
  }
  if (clean(invoice.orderNumber) && len(clean(invoice.orderNumber)) > 100) {
    out.warn('ORDER_NUMBER_TOO_LONG', 'A rendelésszám legfeljebb 100 karakteren kerül a NAV-hoz; a többi levágódik.', 'orderNumber');
  }

  // --- Reference of corrections ----------------------------------------------------------------
  const ref = invoice.reference;
  if (correction) {
    if (!ref || typeof ref !== 'object') {
      out.error('REFERENCE_REQUIRED', 'Módosító és sztornó számlán kötelező az eredeti számlára hivatkozás (Áfa tv. 170. § (1) c)). Ezeket az eredeti számlából, módosító számlaként vagy sztornóként hozd létre.', 'reference');
    } else {
      const orig = typeof ref.originalInvoiceNumber === 'string' ? ref.originalInvoiceNumber : '';
      if (!clean(orig)) out.error('REFERENCE_NUMBER_REQUIRED', 'Hiányzik az eredeti számla sorszáma (170. § (1) c)).', 'reference.originalInvoiceNumber');
      else {
        if (orig !== orig.trim()) out.error('REFERENCE_NUMBER_WHITESPACE', 'Az eredeti számla sorszámának elején/végén nem lehet szóköz (NAV ERROR 79 INVALID_ORIGINAL_INVOICE_NUMBER).', 'reference.originalInvoiceNumber');
        if (len(orig) > 50) out.error('REFERENCE_NUMBER_TOO_LONG', 'Az eredeti számla sorszáma legfeljebb 50 karakter lehet (NAV).', 'reference.originalInvoiceNumber');
        if (typeof invoice.number === 'string' && invoice.number.trim() === orig.trim()) {
          out.error('REFERENCE_SAME_NUMBER', 'A módosító/sztornó okirat saját sorszámot kap; nem egyezhet az eredeti számláéval (170. § (1) b); NAV ERROR 66).', 'number');
        }
        if (original && typeof original.number === 'string' && original.number !== orig.trim()) {
          out.error('REFERENCE_NUMBER_MISMATCH', `A hivatkozott sorszám (${orig}) nem egyezik az eredeti számla sorszámával (${original.number}).`, 'reference.originalInvoiceNumber');
        }
      }
      if (!Number.isInteger(ref.modificationIndex) || ref.modificationIndex < 1) {
        out.error('MODIFICATION_INDEX_INVALID', `Érvénytelen módosítási sorszám: ${String(ref.modificationIndex)} (1-től induló egész szám).`, 'reference.modificationIndex');
      } else if (ref.modificationIndex > 1000) {
        out.error('MODIFICATION_INDEX_TOO_LARGE', 'A módosítási sorszám legfeljebb 1000 lehet (NAV ERROR 76).', 'reference.modificationIndex');
      }
      // The original's type decides how the correction is reported (e.g. advance data for an
      // előlegszámla) – it must be the real type of the referenced invoice.
      const refType = ref.originalDocumentType;
      if (refType !== undefined && refType !== null) {
        if (!DOCUMENT_TYPES.has(refType) || refType === 'storno' || refType === 'modification' || refType === 'proforma') {
          out.error('REFERENCE_DOCUMENT_TYPE_INVALID', `Az eredeti bizonylat típusa (${String(refType)}) nem lehet módosítás alapja (invoice, advance vagy final).`, 'reference.originalDocumentType');
        } else if (original && original.documentType !== refType) {
          out.error(
            'REFERENCE_DOCUMENT_TYPE_MISMATCH',
            `A hivatkozásban rögzített eredeti bizonylattípus (${refType}) nem egyezik az eredeti számláéval (${original.documentType}); a NAV-jelentés előleg-jelölése hibás lenne. Hozd létre újra a módosító/sztornó számlát.`,
            'reference.originalDocumentType',
          );
        }
      }
    }
    if (original) {
      if (original.status === 'draft') out.error('ORIGINAL_NOT_ISSUED', 'Az eredeti számla még piszkozat; piszkozatot közvetlenül kell módosítani.', 'reference');
      if (original.documentType === 'storno' || original.documentType === 'modification') {
        out.error('ORIGINAL_IS_CORRECTION', 'Módosító vagy sztornó okirat nem módosítható; az eredeti számlára hivatkozz (a lánc újabb módosításával).', 'reference');
      }
      if (original.documentType === 'proforma') out.error('ORIGINAL_IS_PROFORMA', 'A díjbekérő nem számla, nem lehet helyesbíteni vagy sztornózni.', 'reference');
      if (invoice.status === 'draft' && original.status === 'cancelled') {
        out.error('ORIGINAL_CANCELLED', `Az eredeti számla (${String(original.number)}) már sztornózva van; újabb módosítás nem adható ki rá.`, 'reference');
      }
      if (currencyOk && clean(original.currency).toUpperCase() !== currency) {
        out.error('CURRENCY_DIFFERS_FROM_ORIGINAL', `A módosító/sztornó okirat pénzneme (${currency}) meg kell egyezzen az eredeti számláéval (${String(original.currency)}).`, 'currency');
      } else if (currencyOk && !huf && rate?.gt(0)) {
        // The correction uses the original's rate (it corrects that supply); a draft of an older version may
        // hold another one.
        const originalRate = num(original.exchangeRate);
        if (originalRate && !rate.eq(originalRate)) {
          out.error(
            'CORRECTION_EXCHANGE_RATE_FIXED',
            `A módosító/sztornó okirat árfolyama (${toDec(rate)}) eltér az eredeti számláétól (${toDec(originalRate)}); a javító okirat az eredeti számla árfolyamát használja. Mentsd újra a piszkozatot: ekkor az eredeti árfolyamot kapja. Ha az eredeti számla árfolyama hibás, sztornózd a számlát, és állíts ki újat a helyes árfolyammal.`,
            'exchangeRate',
          );
        }
      }
      // Same VAT regime as the original (status, cash accounting, KATA): the notations and the NAV header
      // of the correction describe the original supply. Name, address, bank account are the current ones.
      const o = original.seller;
      if (seller && o && (o.vatStatus !== seller.vatStatus || (o.cashAccounting === true) !== (seller.cashAccounting === true) || (o.smallBusiness === true) !== (seller.smallBusiness === true))) {
        out.error(
          'CORRECTION_SELLER_REGIME_MISMATCH',
          `A módosító/sztornó okiraton az eredeti számla szerinti ÁFA-helyzetnek kell szerepelnie (ÁFA-státusz: ${String(o.vatStatus)}, pénzforgalmi elszámolás: ${o.cashAccounting ? 'igen' : 'nem'}, kisadózó: ${o.smallBusiness ? 'igen' : 'nem'}), mert az eredeti ügyletet helyesbíti. Hozd létre újra a módosító, illetve a sztornó számlát.`,
          'seller.vatStatus',
        );
      }
      if (issueDate && validInvoiceDate(original.issueDate) && issueDate < original.issueDate) {
        out.warn('ISSUE_DATE_BEFORE_ORIGINAL', 'A módosító/sztornó okirat kelte nem lehet korábbi az eredeti számla kelténél (NAV WARN 342).', 'issueDate');
      }
      // Compared with the invoice's current fulfilment date: after a date-correcting modification that
      // is the latest modification's, as NAV compares it (spec 3.45.1).
      const current = chainFulfillmentDate(original, ctx?.chain ?? []);
      if (fulfilment && validInvoiceDate(current.date)) {
        const holder = current.source === original ? 'az eredeti számla' : `a(z) ${String(current.source.number)} módosító számla`;
        if (docType === 'storno' && fulfilment !== current.date) {
          out.warn('STORNO_FULFILLMENT_DATE', `A sztornó számla teljesítési dátuma a számla aktuális teljesítési dátuma legyen: ${current.date} (${holder} szerint); különben a NAV a teljesítési dátumot módosítottnak tekinti (WARN 11401).`, 'fulfillmentDate');
        } else if (docType === 'modification' && fulfilment.slice(0, 7) !== current.date.slice(0, 7)) {
          out.warn('MODIFICATION_FULFILLMENT_DATE', `A módosító számla teljesítési dátuma (${fulfilment}) más hónapra esik, mint a számla aktuális teljesítési dátuma: ${current.date} (${holder} szerint); ez a NAV-nál a teljesítési dátum módosítását jelenti (WARN 11400). Csak akkor hagyd így, ha valóban a teljesítés dátumát javítod.`, 'fulfillmentDate');
        }
      }
      if (docType === 'modification' && original.customer && customer && !sameCustomer(original.customer, customer)) {
        out.warn('MODIFICATION_CUSTOMER_CHANGED', 'A módosító számla vevője eltér az eredetiétől. Téves vevő esetén a helyes eljárás: sztornó + új számla a helyes vevőnek (NAV 18. füzet).', 'customer');
      }
    }
    if (docType === 'modification' && !clean(invoice.comment)) {
      out.warn('MODIFICATION_REASON_MISSING', 'Tüntesd fel a módosítás okát/természetét a megjegyzésben (Áfa tv. 170. § (1) e): a módosított adat megnevezése és a módosítás természete).', 'comment');
    }
  } else if (ref) {
    out.error('REFERENCE_NOT_EXPECTED', 'Csak módosító és sztornó okirat hivatkozhat eredeti számlára (NAV ERROR INVOICE_REFERENCE_NOT_EXPECTED).', 'reference');
  }

  // --- Lines ---------------------------------------------------------------------------------
  const lines: InvoiceLine[] = Array.isArray(invoice.lines) ? invoice.lines : [];
  if (lines.length === 0) {
    if (docType === 'modification') {
      // NAV needs at least one summaryByVatRate and the 3. melléklet export at least one item, so a
      // header-only modification could be issued but never reported or exported.
      out.error(
        'MODIFICATION_WITHOUT_LINES',
        'A módosító számlán nincs tétel; tétel nélküli módosító számlát a NAV nem fogad be. Fejadat (pl. teljesítési dátum, vevő címe) javításához adj meg egy 0 összegű különbözeti tételt (mennyiség 1, egységár 0, az eredeti számla ÁFA-kódjával, a megnevezésben a javított adattal), vagy sztornózd a számlát és állíts ki újat. Összegmódosításhoz add meg a különbözet tételeit.',
        'lines',
      );
    } else {
      out.error('LINES_REQUIRED', 'Legalább egy számlatétel szükséges (NAV ERROR INVOICE_LINE_MISSING). Add meg a tétel megnevezését, mennyiségét, mennyiségi egységét, egységárát és ÁFA-kódját.', 'lines');
    }
  }
  const dp = currencyOk ? amountDecimals(currency) : 2;
  const calcCtx = { currency: currencyOk ? currency : 'HUF', exchangeRate: huf ? '1' : rateUsable && rate ? toDec(rate) : '1' };
  const sums = zeroAmounts();
  let sumsOk = true;
  const byCode = new Map<string, Amounts>();
  const lineRefs = new Set<number>();
  let hasAdvanceDeduction = false;

  lines.forEach((line, i) => {
    const no = i + 1;
    const f = (k: string): string => `lines[${i}].${k}`;
    if (!line || typeof line !== 'object') {
      out.error('LINE_INVALID', `A(z) ${no}. tétel hiányos.`, `lines[${i}]`);
      sumsOk = false;
      return;
    }
    if (line.lineNo !== no) {
      out.error('LINE_NUMBER_NOT_SEQUENTIAL', `A tételek sorszáma 1-től hézag nélkül folyamatos kell legyen; a(z) ${no}. tétel sorszáma ${String(line.lineNo)} (NAV ERROR LINE_NUMBER_NOT_SEQUENTIAL).`, f('lineNo'));
    }
    const desc = clean(line.description);
    if (!desc) out.error('LINE_DESCRIPTION_REQUIRED', `A(z) ${no}. tétel megnevezése üres. Add meg a termék vagy szolgáltatás megnevezését (169. § f)).`, f('description'));
    else if (len(desc) > 512) out.error('LINE_DESCRIPTION_TOO_LONG', `A(z) ${no}. tétel megnevezése ${len(desc)} karakter; a NAV legfeljebb 512-t fogad el. Rövidítsd (a részleteket írd megjegyzésbe).`, f('description'));

    const qty = num(line.quantity);
    if (!qty) out.error('LINE_QUANTITY_INVALID', `A(z) ${no}. tétel mennyisége nem szám: "${String(line.quantity)}" (pont a tizedesjel, pl. 1.5).`, f('quantity'));
    else {
      if (qty.isZero()) out.error('LINE_QUANTITY_ZERO', `A(z) ${no}. tétel mennyisége 0. Adj meg nullától eltérő mennyiséget, vagy töröld a tételt.`, f('quantity'));
      if (!quantityTypeOk(qty)) out.error('LINE_QUANTITY_PRECISION', `A(z) ${no}. tétel mennyisége legfeljebb 10 tizedesjegyű és összesen 22 jegyű lehet (NAV QuantityType). Kerekítsd, vagy válassz nagyobb mértékegységet.`, f('quantity'));
    }
    const unit = clean(line.unit);
    if (!unit) out.error('LINE_UNIT_REQUIRED', `A(z) ${no}. tétel mennyiségi egysége üres (pl. db, óra, kg); a NAV a mennyiség mellé egységet is kér.`, f('unit'));
    else if (toNavUnit(unit).unitOfMeasure === 'OWN' && len(unit) > 50) {
      out.error('LINE_UNIT_TOO_LONG', `A(z) ${no}. tétel saját mennyiségi egysége legfeljebb 50 karakter lehet (NAV unitOfMeasureOwn).`, f('unit'));
    }
    const price = num(line.unitPrice);
    if (!price) out.error('LINE_UNIT_PRICE_INVALID', `A(z) ${no}. tétel egységára nem szám: "${String(line.unitPrice)}" (pont a tizedesjel, ezres elválasztó nélkül).`, f('unitPrice'));
    else if (!quantityTypeOk(price)) out.error('LINE_UNIT_PRICE_PRECISION', `A(z) ${no}. tétel egységára legfeljebb 10 tizedesjegyű és összesen 22 jegyű lehet (NAV QuantityType).`, f('unitPrice'));
    const netUnitPrice = num(line.netUnitPrice);
    if (!netUnitPrice || !quantityTypeOk(netUnitPrice)) {
      out.error('LINE_NET_UNIT_PRICE_INVALID', `A(z) ${no}. tétel nettó egységára hiányzik vagy nem ábrázolható a NAV-nál (legfeljebb 10 tizedes, 22 jegy). Számold újra a piszkozatot.`, f('netUnitPrice'));
    }
    if (line.priceBasis !== 'net' && line.priceBasis !== 'gross') out.error('LINE_PRICE_BASIS_INVALID', `A(z) ${no}. tétel árának típusa net vagy gross lehet.`, f('priceBasis'));
    if (!NATURES.has(line.nature)) out.error('LINE_NATURE_INVALID', `A(z) ${no}. tétel jellege PRODUCT, SERVICE vagy OTHER lehet.`, f('nature'));

    // VAT code
    const code = line.vatCode;
    const info = isVatCode(code) ? getVatInfo(code) : null;
    const reason = clean(line.vatReason);
    if (!info) {
      out.error('LINE_VAT_CODE_INVALID', `A(z) ${no}. tétel ÁFA-kódja ismeretlen: "${String(code)}". Használható: ${VAT_CODES.join(', ')}.`, f('vatCode'));
    } else {
      if ((sellerStatus === 'normal' || sellerStatus === 'aam') && !info.allowedFor.includes(sellerStatus)) {
        if (sellerStatus === 'aam' && info.nav.kind === 'vatPercentage' && reason) {
          out.warn(
            'LINE_VAT_CODE_AAM_EXCEPTION',
            `Alanyi adómentes eladó ${info.label} kulccsal csak az alanyi mentesség alá nem eső ügyletet számlázhat (Áfa tv. 193. §, pl. tárgyi eszköz értékesítése). Ellenőrizd a(z) ${no}. tétel jogalapját.`,
            f('vatCode'),
          );
        } else if (sellerStatus === 'aam') {
          out.error(
            'LINE_VAT_CODE_NOT_ALLOWED',
            info.nav.kind === 'vatPercentage'
              ? `Alanyi adómentes eladó számláján nem szerepelhet áthárított adó és adómérték (Áfa tv. 187. § (2) c)); a(z) ${no}. tétel kódja ${code}. Használd az AAM kódot. (Ha az ügylet a 193. § szerint nem tartozik az alanyi mentesség alá, add meg a tételnél a jogalapot.)`
              : `Alanyi adómentes eladó a(z) ${code} kódot nem használhatja (${info.nameHu}); a(z) ${no}. tételnél használd az AAM kódot.`,
            f('vatCode'),
          );
        } else {
          out.error('LINE_VAT_CODE_NOT_ALLOWED', `A(z) ${no}. tétel AAM (alanyi adómentes) kódú, de az eladó ÁFA-státusza normal. Használd a megfelelő adókulcsot vagy mentességi kódot (pl. 27, TAM).`, f('vatCode'));
        }
      }
      if (info.nav.kind === 'vatPercentage' && dec(info.nav.value).isZero() && fulfilment && fulfilment < '2024-01-01') {
        out.error('LINE_ZERO_RATE_BEFORE_2024', `A 0%-os adókulcs csak 2024-01-01-jei vagy későbbi teljesítésre alkalmazható (NAV ERROR INVALID_VAT_DATA); a(z) ${no}. tétel teljesítése ${fulfilment}.`, f('vatCode'));
      }
      if (code === 'KUL_UTAZAS' && docType !== 'storno' && (!fulfilment || fulfilment >= '2026-01-01')) {
        out.error(
          'LINE_TRAVEL_MARGIN_UNSUPPORTED',
          'Utazásszervezés (KUL_UTAZAS): 2026-tól a NAV-adatszolgáltatásnak a különbözet forintos adóalapját és adóját is tartalmaznia kell (Áfa tv. 210/A. § (3)), ezt a program még nem számolja. Ezt a számlát más eszközzel állítsd ki.',
          f('vatCode'),
        );
      }
      if ((info.nav.kind === 'vatExemption' || info.nav.kind === 'vatOutOfScope') && reason && len(reason) > 200) {
        out.error('LINE_VAT_REASON_TOO_LONG', `A(z) ${no}. tétel mentességi/hatályon kívüliségi indoklása legfeljebb 200 karakter lehet (NAV reason).`, f('vatReason'));
      }
      if ((code === 'TAM' || code === 'NAM') && !reason && docType !== 'storno') {
        out.warn(
          'LINE_EXEMPTION_REFERENCE_RECOMMENDED',
          `A(z) ${no}. tétel ${code === 'TAM' ? 'tárgyi adómentes' : 'nemzetközi ügylethez kapcsolódó adómentes'}: add meg a tételnél a mentesség pontos jogszabályhelyét (pl. „Áfa tv. 85. § (1) e) – oktatás”), hogy a számlán egyértelmű legyen (169. § m)).`,
          f('vatReason'),
        );
      }
      if (code === 'KBAUK' && docType !== 'storno') {
        out.warn('LINE_NEW_MEANS_OF_TRANSPORT_DATA', `Új közlekedési eszköz értékesítésénél a számlán fel kell tüntetni a 259. § 25. pont szerinti adatokat (forgalomba helyezés napja, futott km / üzemóra stb. – 169. § o)); írd be a(z) ${no}. tétel megnevezésébe.`, f('description'));
      }
      if (line.nature === 'SERVICE' && (code === 'KBAET' || code === 'KBAUK' || code === 'EAM')) {
        out.warn(
          'LINE_NATURE_MISMATCH',
          `A(z) ${no}. tétel jellege szolgáltatás (SERVICE), a(z) ${code} kód viszont termékértékesítésre való. Ha a tétel termék, állítsd a jellegét termékre (PRODUCT); ha szolgáltatás, más a kód (pl. EUFAD37 vagy HO).`,
          f('nature'),
        );
      }
      if (line.nature === 'PRODUCT' && code === 'EUFAD37') {
        out.warn(
          'LINE_NATURE_MISMATCH',
          `A(z) ${no}. tétel jellege termék (PRODUCT), az EUFAD37 kód viszont más tagállamban teljesített szolgáltatásra való. Ha a tétel szolgáltatás (pl. „db” egységgel számlázott tanácsadás), állítsd a jellegét szolgáltatásra (SERVICE); ha termék, más a kód (pl. KBAET vagy EUFADE).`,
          f('nature'),
        );
      }
    }

    // Modification data
    if (line.modifiesLineNo !== undefined && line.modifiesLineNo !== null) {
      if (!Number.isInteger(line.modifiesLineNo) || line.modifiesLineNo < 1) {
        out.error('LINE_MODIFIES_LINE_INVALID', `A(z) ${no}. tétel által módosított sor száma pozitív egész szám legyen.`, f('modifiesLineNo'));
      } else if (docType !== 'modification') {
        out.warn('LINE_MODIFIES_LINE_NOT_EXPECTED', `A(z) ${no}. tétel módosított sorra hivatkozik, de a bizonylat nem módosító számla; a hivatkozás nem kerül a számlára.`, f('modifiesLineNo'));
      }
    }
    if (line.modificationRef !== undefined && line.modificationRef !== null) {
      const r = line.modificationRef;
      if (!correction) out.error('LINE_MODIFICATION_REF_NOT_EXPECTED', 'Tételhivatkozás (lineModificationReference) csak módosító/sztornó okiraton lehet (NAV ERROR LINE_MODIFICATION_NOT_EXPECTED).', f('modificationRef'));
      if (r.lineOperation !== 'CREATE') {
        out.error('LINE_OPERATION_NOT_CREATE', `A(z) ${no}. tétel lineOperation értéke csak CREATE lehet (NAV ERROR 60 INVALID_LINE_OPERATION, 2023-09-18 óta).`, f('modificationRef.lineOperation'));
      }
      if (!Number.isInteger(r.lineNumberReference) || r.lineNumberReference < 1) {
        out.error('LINE_REFERENCE_INVALID', `A(z) ${no}. tétel lineNumberReference értéke pozitív egész szám legyen.`, f('modificationRef.lineNumberReference'));
      } else if (lineRefs.has(r.lineNumberReference)) {
        out.error('LINE_REFERENCE_DUPLICATE', `A(z) ${no}. tétel ugyanarra a sorszámra (${r.lineNumberReference}) hivatkozik, mint egy korábbi tétel (NAV ERROR LINE_NUMBER_REFERENCE_NOT_UNIQUE).`, f('modificationRef.lineNumberReference'));
      } else {
        lineRefs.add(r.lineNumberReference);
      }
    }

    // Advance deduction (végszámla)
    const adv = line.advanceDeduction;
    if (adv !== undefined && adv !== null) {
      hasAdvanceDeduction = true;
      if (docType === 'advance') {
        out.error('LINE_ADVANCE_DEDUCTION_ON_ADVANCE', 'Előlegszámlán nem lehet előleglevonás; a levonás a végszámlán (final) szerepel.', f('advanceDeduction'));
      } else if (docType === 'invoice') {
        out.warn('LINE_ADVANCE_DEDUCTION_DOC_TYPE', 'Előleget levonó számla végszámla: válaszd a final bizonylattípust (a számlán „Végszámla” megjelölés szerepel).', 'documentType');
      }
      const advNo = typeof adv.advanceInvoiceNumber === 'string' ? adv.advanceInvoiceNumber : '';
      if (!clean(advNo)) out.error('LINE_ADVANCE_NUMBER_REQUIRED', `A(z) ${no}. tételnél add meg a levont előlegszámla sorszámát.`, f('advanceDeduction.advanceInvoiceNumber'));
      else if (advNo !== advNo.trim() || len(advNo) > 50) {
        out.error('LINE_ADVANCE_NUMBER_INVALID', `A(z) ${no}. tétel előlegszámla-sorszáma legfeljebb 50 karakter lehet, elején/végén szóköz nélkül.`, f('advanceDeduction.advanceInvoiceNumber'));
      }
      if (!validInvoiceDate(adv.advancePaymentDate)) {
        out.error('LINE_ADVANCE_DATE_INVALID', `A(z) ${no}. tételnél az előleg fizetésének dátuma érvénytelen (ÉÉÉÉ-HH-NN).`, f('advanceDeduction.advancePaymentDate'));
      } else if (issueDate && adv.advancePaymentDate > issueDate) {
        out.warn('LINE_ADVANCE_DATE_AFTER_ISSUE', `A(z) ${no}. tételnél az előleg fizetésének dátuma későbbi a végszámla kelténél; ellenőrizd.`, f('advanceDeduction.advancePaymentDate'));
      }
      const advRate = num(adv.advanceExchangeRate);
      const advRateMissing = adv.advanceExchangeRate === undefined || adv.advanceExchangeRate === null || adv.advanceExchangeRate === '' || advRate?.isZero() === true;
      if (!huf && currencyOk && advRateMissing) {
        // NAV advanceExchangeRate is the rate of the advance invoice (80. § (1) a): the day the advance was received).
        out.error(
          'LINE_ADVANCE_RATE_MISSING',
          `A(z) ${no}. tételnél hiányzik az előlegszámla árfolyama: devizás végszámlán a levont előleg az előlegszámla árfolyamával kerül a NAV-hoz. Add meg (1 ${currency} = ? HUF); ha az előlegszámla ebben a programban készült, a program kitölti.`,
          f('advanceDeduction.advanceExchangeRate'),
        );
      } else if (!advRate || !exchangeRateTypeOk(advRate)) {
        out.error('LINE_ADVANCE_RATE_INVALID', `A(z) ${no}. tételnél az előleg árfolyama pozitív, legfeljebb 6 tizedesjegyű szám legyen (forintos előlegnél 1).`, f('advanceDeduction.advanceExchangeRate'));
      } else if (huf && !advRate.eq(1)) {
        out.warn('LINE_ADVANCE_RATE_HUF', `Forintos végszámlán az előleg árfolyama 1.`, f('advanceDeduction.advanceExchangeRate'));
      } else if (!huf && advRate.eq(1)) {
        out.warn('LINE_ADVANCE_RATE_ONE', `A(z) ${no}. tételnél az előleg árfolyama 1 – devizás (${currency}) végszámlánál ez szinte biztosan hiba. Add meg az előlegszámla árfolyamát (1 ${currency} = ? HUF).`, f('advanceDeduction.advanceExchangeRate'));
      }
    }

    // Amounts
    const a = amountsOf(line);
    if (!a) {
      out.error('LINE_AMOUNTS_INVALID', `A(z) ${no}. tétel összegei hiányoznak vagy nem számok. Mentsd újra a piszkozatot: a program újraszámolja.`, `lines[${i}]`);
      sumsOk = false;
      return;
    }
    addAmounts(sums, a);
    if (isVatCode(code)) {
      const acc = byCode.get(code) ?? zeroAmounts();
      addAmounts(acc, a);
      byCode.set(code, acc);
    }
    const tooLarge = AMOUNT_KEYS.filter((k) => !monetaryOk(a[k]));
    if (tooLarge.length) {
      out.error('LINE_AMOUNT_NOT_REPRESENTABLE', `A(z) ${no}. tétel összege nem ábrázolható a NAV-nál (legfeljebb 2 tizedes és 18 számjegy): ${tooLarge.map((k) => AMOUNT_FIELDS[k]).join(', ')}.`, f(AMOUNT_FIELDS[tooLarge[0]!]));
    }
    const internal: string[] = [];
    if (!a.net.plus(a.vat).eq(a.gross)) internal.push('nettó + ÁFA ≠ bruttó');
    if (!a.netHuf.plus(a.vatHuf).eq(a.grossHuf)) internal.push('nettó + ÁFA ≠ bruttó (HUF)');
    if (info && info.nav.kind !== 'vatPercentage' && (!a.vat.isZero() || !a.vatHuf.isZero())) {
      out.error(
        'LINE_VAT_NOT_ZERO',
        `A(z) ${no}. tétel ${code} kódú (${info.nameHu}), ÁFA-összege mégsem 0. Ilyen tételen áfa nem szerepelhet (NAV ERROR 71/72; AAM: 187. § (2) c), fordított adózás: 142. § (7)).`,
        f('vatAmount'),
      );
    }
    if (internal.length) {
      out.error('LINE_AMOUNTS_INCONSISTENT', `A(z) ${no}. tétel összegei nem konzisztensek (${internal.join('; ')}). Számold újra a piszkozatot.`, f('grossAmount'));
    } else if (info && qty && price && (line.priceBasis === 'net' || line.priceBasis === 'gross') && currencyOk) {
      // Same arithmetic as calc.ts: the stored amounts must be exactly what the inputs give.
      let expected: InvoiceLine | null = null;
      try {
        expected = computeLine(line, no, calcCtx);
      } catch {
        expected = null;
      }
      if (expected) {
        const checks: Array<[string, DecValue | null, string]> = [
          ['netAmount', a.net, expected.netAmount],
          ['vatAmount', a.vat, expected.vatAmount],
          ['grossAmount', a.gross, expected.grossAmount],
          ['netUnitPrice', netUnitPrice, expected.netUnitPrice],
        ];
        if (rateUsable) {
          checks.push(['netAmountHuf', a.netHuf, expected.netAmountHuf], ['vatAmountHuf', a.vatHuf, expected.vatAmountHuf], ['grossAmountHuf', a.grossHuf, expected.grossAmountHuf]);
        }
        const wrong = checks.filter(([, stored, exp]) => !stored || !stored.eq(dec(exp)));
        if (wrong.length) {
          out.error(
            'LINE_AMOUNTS_STALE',
            `A(z) ${no}. tétel összegei nem egyeznek a mennyiség × egységár, az ÁFA-kód és az árfolyam alapján számítottal (${wrong.map(([k, stored, exp]) => `${k}: ${stored ? toDec(stored) : '?'} ≠ ${exp}`).join(', ')}). Mentsd újra a piszkozatot: a program újraszámolja.`,
            f(wrong[0]![0]),
          );
        }
      }
    }
    if (adv !== undefined && adv !== null && (docType === 'final' || docType === 'invoice') && !a.net.isNegative()) {
      out.error('LINE_ADVANCE_DEDUCTION_NOT_NEGATIVE', `A(z) ${no}. tétel előleget von le, ezért az összege negatív legyen (negatív mennyiség vagy egységár).`, f('netAmount'));
    }
  });

  if (docType === 'final' && lines.length > 0 && !hasAdvanceDeduction) {
    out.error('FINAL_WITHOUT_ADVANCE_DEDUCTION', 'A végszámla (final) a teljes ügyletet tartalmazza, és le kell vonnia a korábbi előlegszámlá(ka)t: adj meg legalább egy előleglevonó tételt (negatív összeggel).', 'lines');
  }

  // --- Totals --------------------------------------------------------------------------------
  const t = invoice.totals;
  const totals = t ? amountsOf(t) : null;
  if (!t || typeof t !== 'object') {
    out.error('TOTALS_MISSING', 'Hiányzik a számla összesítője. Számold újra a piszkozatot.', 'totals');
  } else if (!totals) {
    out.error('TOTALS_INVALID', 'A számla összesítőjének összegei hiányoznak vagy nem számok. Számold újra a piszkozatot.', 'totals');
  } else {
    if (sumsOk) {
      const diff = sameAmounts(sums, totals);
      if (diff.length) out.error('TOTALS_MISMATCH', `A számla végösszegei nem egyeznek a tételek összegével (${diff.map((k) => AMOUNT_FIELDS[k]).join(', ')}). Számold újra a piszkozatot.`, `totals.${AMOUNT_FIELDS[diff[0]!]}`);
    }
    if (!totals.net.plus(totals.vat).eq(totals.gross) || !totals.netHuf.plus(totals.vatHuf).eq(totals.grossHuf)) {
      out.error('TOTALS_INCONSISTENT', 'A végösszegben a nettó + ÁFA nem egyenlő a bruttóval. Számold újra a piszkozatot.', 'totals.grossAmount');
    }
    const tooLarge = AMOUNT_KEYS.filter((k) => !monetaryOk(totals[k]));
    if (tooLarge.length) {
      out.error('TOTAL_AMOUNT_NOT_REPRESENTABLE', `A számla végösszege nem ábrázolható a NAV-nál (legfeljebb 2 tizedes és 18 számjegy): ${tooLarge.map((k) => AMOUNT_FIELDS[k]).join(', ')}.`, `totals.${AMOUNT_FIELDS[tooLarge[0]!]}`);
    }
    const payable = num(t.payableAmount);
    const rounding = num(t.roundingDifference);
    const expectedPayable = huf && invoice.paymentMethod === 'CASH' ? dec(cashRoundHuf(totals.gross)) : totals.gross;
    if (!payable || !payable.eq(expectedPayable) || !rounding || !rounding.eq(expectedPayable.minus(totals.gross))) {
      out.error(
        'PAYABLE_MISMATCH',
        `A fizetendő összeg hibás (várt: ${toDec(expectedPayable)}; készpénzes forintfizetésnél a végösszeg 0/5 Ft-ra kerekítve, 2008. évi III. tv., egyébként a bruttó végösszeg). Számold újra a piszkozatot.`,
        'totals.payableAmount',
      );
    }

    // VAT summary (NAV: per VAT rate; 435/734 – every rate of the lines has a row and vice versa)
    const rows = Array.isArray(t.byVat) ? t.byVat : [];
    const rowSums = zeroAmounts();
    let rowsOk = true;
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const f = `totals.byVat[${i}]`;
      const ra = amountsOf(row);
      if (!row || !isVatCode(row.vatCode) || !ra) {
        out.error('VAT_SUMMARY_ROW_INVALID', `Az ÁFA-összesítő ${i + 1}. sora hibás (ismeretlen kód vagy hiányzó összeg). Számold újra a piszkozatot.`, f);
        rowsOk = false;
        return;
      }
      addAmounts(rowSums, ra);
      if (seen.has(row.vatCode)) {
        out.error('VAT_SUMMARY_DUPLICATE', `Az ÁFA-összesítőben a(z) ${row.vatCode} kód többször szerepel.`, f);
        rowsOk = false;
      }
      seen.add(row.vatCode);
      const info = getVatInfo(row.vatCode);
      if (info.nav.kind !== 'vatPercentage' && (!ra.vat.isZero() || !ra.vatHuf.isZero())) {
        out.error('VAT_SUMMARY_VAT_NOT_ZERO', `Az ÁFA-összesítő ${row.vatCode} sorában az ÁFA csak 0 lehet (NAV ERROR 75/80).`, `${f}.vatAmount`);
      }
      if (!ra.net.plus(ra.vat).eq(ra.gross) || !ra.netHuf.plus(ra.vatHuf).eq(ra.grossHuf)) {
        out.error('VAT_SUMMARY_INCONSISTENT', `Az ÁFA-összesítő ${row.vatCode} sorában a nettó + ÁFA nem egyenlő a bruttóval.`, f);
      }
      const expectedRow = byCode.get(row.vatCode);
      if (sumsOk && !expectedRow) {
        out.error('VAT_SUMMARY_EXTRA_ROW', `Az ÁFA-összesítőben szerepel a(z) ${row.vatCode} kód, de nincs ilyen tétel (NAV WARN 734). Számold újra a piszkozatot.`, f);
      } else if (sumsOk && expectedRow && sameAmounts(expectedRow, ra).length) {
        out.error('VAT_SUMMARY_MISMATCH', `Az ÁFA-összesítő ${row.vatCode} sora nem egyezik a(z) ${row.vatCode} kódú tételek összegével (NAV WARN 820/821). Számold újra a piszkozatot.`, f);
      }
      if (createLike && ra.net.isNegative()) {
        out.warn('NEGATIVE_TAX_BASE_BY_RATE', `Az ÁFA-összesítő ${row.vatCode} sorában negatív az adóalap; ellenőrizd (az adóalap nem lehet negatív).`, `${f}.netAmount`);
      }
    });
    if (sumsOk) {
      for (const code of byCode.keys()) {
        if (!seen.has(code)) out.error('VAT_SUMMARY_MISSING_ROW', `Az ÁFA-összesítőből hiányzik a(z) ${code} kód sora (NAV WARN 435). Számold újra a piszkozatot.`, 'totals.byVat');
      }
    }
    if (rowsOk && rows.length > 0 && sameAmounts(rowSums, totals).length) {
      out.error('VAT_SUMMARY_TOTAL_MISMATCH', 'Az ÁFA-összesítő sorainak összege nem egyezik a végösszeggel (NAV WARN 840/850). Számold újra a piszkozatot.', 'totals.byVat');
    }
    if (createLike && totals.net.isNegative()) {
      out.error(
        'NEGATIVE_TAX_BASE',
        docType === 'final'
          ? 'A végszámla adóalapja negatív: a levont előleg nagyobb a teljes ellenértéknél. Ilyenkor az előlegszámlát kell módosítani (NAV 2.9).'
          : 'A számla adóalapja (nettó végösszege) nem lehet negatív. Visszatérítéshez, jóváíráshoz módosító vagy sztornó számlát használj.',
        'totals.netAmount',
      );
    }
    if (docType === 'modification' && original?.totals) {
      // Research 02 §7.2: the tax base and the VAT must not become negative after a modification – the
      // original, its issued modifications and this one together, per VAT code of this document. Only a
      // warning: a correction made in several documents (e.g. moving an amount from 27% to 5%) may pass it.
      const earlier = (ctx?.chain ?? []).filter((d) => d.documentType === 'modification' && d.status !== 'draft' && d.id !== invoice.id);
      const after = new Map<string, { net: DecValue; vat: DecValue }>();
      for (const doc of [original, ...earlier, invoice]) {
        for (const r of Array.isArray(doc.totals?.byVat) ? doc.totals.byVat : []) {
          const net = num(r?.netAmount);
          const vat = num(r?.vatAmount);
          if (!net || !vat) continue;
          const acc = after.get(r.vatCode) ?? { net: new D(0), vat: new D(0) };
          after.set(r.vatCode, { net: acc.net.plus(net), vat: acc.vat.plus(vat) });
        }
      }
      const warned = new Set<string>();
      rows.forEach((row, i) => {
        const a = row ? after.get(row.vatCode) : undefined;
        if (!a || warned.has(row.vatCode) || (!a.net.isNegative() && !a.vat.isNegative())) return;
        warned.add(row.vatCode);
        const what = a.net.isNegative() ? (a.vat.isNegative() ? 'adóalapja és adója' : 'adóalapja') : 'adója';
        const amounts = [a.net.isNegative() ? `nettó ${toDec(a.net)}` : null, a.vat.isNegative() ? `ÁFA ${toDec(a.vat)}` : null].filter((s) => s !== null).join(', ');
        out.warn(
          'MODIFICATION_NEGATIVE_RESULT',
          `A módosítás után az eredeti számla ${row.vatCode} ÁFA-kódú ${what}${earlier.length ? ' – a korábbi módosításaival együtt –' : ''} negatív lenne (${amounts} ${currency}); az adóalap és az adó módosítás után sem lehet negatív. Ellenőrizd a különbözet összegét.`,
          `totals.byVat[${i}].${a.net.isNegative() ? 'netAmount' : 'vatAmount'}`,
        );
      });
    }
    if (docType === 'storno' && original?.totals && Array.isArray(ctx?.chain)) {
      // A storno negates the original and every issued modification of it (Áfa tv. 170. §): per VAT code its net
      // is the opposite of theirs together. Checked when the chain is known; a storno made from an outdated chain
      // would leave the invoice partly in force although it counts as cancelled.
      const netByCode = (docs: readonly Invoice[]): Map<string, DecValue> => {
        const m = new Map<string, DecValue>();
        for (const doc of docs) {
          for (const r of Array.isArray(doc.totals?.byVat) ? doc.totals.byVat : []) {
            const net = num(r?.netAmount);
            if (net) m.set(r.vatCode, (m.get(r.vatCode) ?? new D(0)).plus(net));
          }
        }
        return m;
      };
      const chainNet = netByCode([original, ...ctx.chain.filter((d) => d.documentType === 'modification' && d.status !== 'draft' && d.id !== invoice.id)]);
      const own = netByCode([invoice]);
      for (const code of new Set([...chainNet.keys(), ...own.keys()])) {
        const negated = (chainNet.get(code) ?? new D(0)).neg();
        const net = own.get(code) ?? new D(0);
        if (net.eq(negated)) continue;
        out.error(
          'STORNO_CHAIN_MISMATCH',
          `A sztornó számla ${code} ÁFA-kódú nettó összege (${toDec(net)} ${currency}) nem ellentéte az eredeti számla és kiállított módosító számlái együttes összegének (${toDec(negated.neg())} ${currency}): a sztornónak az egész számlát semlegesítenie kell. Kérj új sztornó-előnézetet, és sztornózd újra.`,
          'lines',
        );
        break;
      }
    }
    // Alanyi adómentesség értékhatára (research 02 §15) – a single invoice above it ends the status.
    if (sellerStatus === 'aam' && createLike) {
      const year = Number((fulfilment ?? issueDate ?? today ?? '2026').slice(0, 4));
      const limit = aamThresholdHuf(year);
      if (totals.grossHuf.gt(limit)) {
        out.warn(
          'AAM_THRESHOLD_EXCEEDED',
          `A számla összege (${toDec(totals.grossHuf)} Ft) meghaladja az alanyi adómentesség ${year}. évi értékhatárát (${limit} Ft, Áfa tv. 188. §): az értékhatárt túllépő ügylettől az áfát fel kell számítani. Egyeztess a könyvelőddel.`,
          'totals.grossAmountHuf',
        );
      }
    }
  }

  // --- Scenario rules: VAT code ↔ buyer (research 02 §2.3, §20; NAV ERROR 50, 67–70, 73) -------
  const codes = new Set(lines.map((l) => l?.vatCode).filter((c): c is NonNullable<typeof c> => typeof c === 'string' && isVatCode(c)));
  const cStatus = customer?.vatStatus;
  const custTax = customer && clean(customer.taxNumber) ? parseHuTaxNumber(customer.taxNumber as string) : null;
  const custEu = customer && clean(customer.euVatNumber) ? parseEuVatNumber(customer.euVatNumber as string) : null;
  const custCountry = clean(customer?.address?.countryCode).toUpperCase();
  if (docType !== 'storno') {
    if (codes.has('FAD')) {
      if (cStatus !== 'DOMESTIC') {
        out.error('FAD_CUSTOMER_NOT_DOMESTIC', 'Belföldi fordított adózás (FAD) csak belföldi áfaalany (DOMESTIC) vevőnek számlázható (NAV ERROR 73).', 'customer.vatStatus');
      } else if (!custTax?.ok || !custTax.value.vatCode || !custTax.value.countyCode) {
        out.error('FAD_CUSTOMER_TAX_NUMBER_REQUIRED', 'Fordított adózásnál a vevő teljes, 11 jegyű adószáma kötelező (Áfa tv. 169. § da); NAV ERROR 50). Add meg a vevő adószámát (12345676-1-23).', 'customer.taxNumber');
      } else if (custTax.value.vatCode === '1') {
        out.warn('FAD_CUSTOMER_EXEMPT', 'A vevő áfakódja 1 (adómentes adóalany): alanyi adómentes féllel fordított adózás nem alkalmazható (142. § (3)). Ellenőrizd a vevő státuszát.', 'customer.taxNumber');
      }
      if (createLike) {
        out.warn('FAD_BUYER_DECLARATION', 'Belföldi fordított adózás: építési-szerelési munkánál (142. § (1) b)) és adóalany-kereskedőnél (k)) a vevő előzetes írásbeli nyilatkozata szükséges – győződj meg róla, hogy megvan.', 'lines');
      }
    }
    for (const code of ['KBAET', 'EUFAD37', 'EUFADE'] as const) {
      if (!codes.has(code)) continue;
      if (cStatus !== 'OTHER') {
        out.error(
          'EU_CODE_CUSTOMER_NOT_OTHER',
          `A(z) ${code} kódú tétel csak OTHER státuszú (más tagállambeli adóalany) vevőnek számlázható (NAV ERROR ${code === 'KBAET' ? '67' : code === 'EUFAD37' ? '69' : '70'}). Állítsd a vevő státuszát OTHER-re a közösségi adószámával.`,
          'customer.vatStatus',
        );
      }
      if (!custEu || !custEu.ok) {
        out.error(
          'EU_CODE_CUSTOMER_EU_VAT_REQUIRED',
          `A(z) ${code} ügyletnél a vevő közösségi adószáma kötelező (Áfa tv. 169. § ${code === 'KBAET' ? 'db' : 'da'})). Add meg (pl. DE123456789), és ellenőrizd a VIES-ben.`,
          'customer.euVatNumber',
        );
      } else if (custEu.value.countryCode === 'HU') {
        out.error('EU_CODE_CUSTOMER_HU_VAT', `A(z) ${code} ügylet más tagállambeli adóalany vevőnek szól; magyar közösségi adószámú vevőnél ez a kód nem alkalmazható.`, 'customer.euVatNumber');
      }
      if (seller && !clean(seller.euVatNumber)) {
        out.warn('SELLER_EU_VAT_NUMBER_MISSING', 'Közösségi ügylethez az eladónak közösségi adószám (HU + törzsszám) kell; add meg az eladói adatokban.', 'seller.euVatNumber');
      }
    }
    if (codes.has('KBAUK') && cStatus === 'DOMESTIC') {
      out.error('KBAUK_CUSTOMER_DOMESTIC', 'Új közlekedési eszköz Közösségen belüli értékesítése (KBAUK) nem számlázható belföldi áfaalany (DOMESTIC) vevőnek (NAV ERROR 68).', 'customer.vatStatus');
    }
    if ((codes.has('EAM') || codes.has('HO')) && custCountry && EU_COUNTRIES.has(custCountry)) {
      out.warn('NON_EU_CODE_EU_CUSTOMER', `EAM/HO kód (termékexport / harmadik országban teljesített ügylet), a vevő címe viszont ${custCountry}. Ellenőrizd a teljesítés helyét és a kódot.`, 'lines');
    }
    if (codes.has('0') && cStatus === 'OTHER' && custCountry && custCountry !== 'HU') {
      out.warn('ZERO_RATE_FOREIGN_CUSTOMER', 'A 0% adókulcs csak a 3/B. melléklet szerinti termékekre (napilap, vényköteles gyógyszer) vonatkozik, nem adómentesség. Külföldi vevőnél valószínűleg KBAET, EAM vagy EUFAD37 a helyes kód.', 'lines');
    }
    const euBusiness = cStatus === 'OTHER' && custEu?.ok === true && custEu.value.countryCode !== 'HU';
    if (euBusiness && createLike) {
      const taxed = lines.filter((l) => l && isVatCode(l.vatCode) && getVatInfo(l.vatCode).nav.kind === 'vatPercentage' && !dec(getVatInfo(l.vatCode).rate).isZero());
      if (taxed.some((l) => l.nature === 'SERVICE')) {
        out.warn('EU_B2B_SERVICE_WITH_HU_VAT', 'Más tagállambeli adóalanynak nyújtott szolgáltatás teljesítési helye főszabályként a vevő tagállama (Áfa tv. 37. § (1)): ilyenkor EUFAD37 (fordított adózás) a kód, magyar áfa nélkül. Magyar áfa csak a kivételeknél (pl. belföldi ingatlanhoz kapcsolódó szolgáltatás) jár.', 'lines');
      }
      // Goods / not marked lines: the nature may be the wrong one (e.g. a service billed in "db"), so it is named too.
      const withNature = (nature: LineNature): { nos: string; field: string } | null => {
        const idx = lines.flatMap((l, i) => (l && taxed.includes(l) && l.nature === nature ? [i] : []));
        return idx.length ? { nos: idx.map((i) => `${i + 1}.`).join(', '), field: `lines[${idx[0]}].nature` } : null;
      };
      const goods = withNature('PRODUCT');
      if (goods) {
        out.warn(
          'EU_B2B_GOODS_WITH_HU_VAT',
          `A(z) ${goods.nos} tétel jellege termék (PRODUCT), a vevő más tagállambeli adóalany: ha a termék elhagyja Magyarországot, az ügylet adómentes Közösségen belüli értékesítés (KBAET). Ha a tétel szolgáltatás, állítsd a jellegét szolgáltatásra (SERVICE) – szolgáltatásnál főszabályként EUFAD37 a kód (fordított adózás). Ellenőrizd a kódot és a jelleget.`,
          goods.field,
        );
      }
      const other = withNature('OTHER');
      if (other) {
        out.warn(
          'EU_B2B_OTHER_WITH_HU_VAT',
          `A(z) ${other.nos} tétel magyar áfás, jellege sem termék, sem szolgáltatás (OTHER), a vevő pedig más tagállambeli adóalany: szolgáltatásnál a teljesítés helye főszabályként a vevő tagállama – ilyenkor EUFAD37 (fordított adózás) a kód –, a Magyarországot elhagyó termék pedig adómentes Közösségen belüli értékesítés (KBAET). Add meg a tétel jellegét (szolgáltatás vagy termék), és ellenőrizd a kódot.`,
          other.field,
        );
      }
    }
  }

  // --- Seller status rules --------------------------------------------------------------------
  if (seller && customer && createLike) {
    const sellerTax = clean(seller.taxNumber) ? parseHuTaxNumber(seller.taxNumber) : null;
    if (sellerTax?.ok && custTax?.ok && sellerTax.value.taxpayerId === custTax.value.taxpayerId) {
      out.warn('SELLER_EQUALS_CUSTOMER', 'Az eladó és a vevő adószáma azonos (NAV WARN); saját magadnak nem állíthatsz ki számlát. Ellenőrizd a vevőt.', 'customer.taxNumber');
    }
    if (seller.smallBusiness === true && (cStatus === 'DOMESTIC' || (cStatus === 'OTHER' && (!custCountry || custCountry === 'HU')))) {
      out.warn(
        'KATA_PAYER_CUSTOMER',
        'Kisadózó (KATA) eladó, a vevő pedig belföldi szervezet/vállalkozó (kifizető): ha kifizetőtől szerzel bevételt, a KATA-alanyiság a bevételszerzést megelőző nappal megszűnik (2022. évi XIII. tv. 5. § (1) g)), és 15 napon belül be kell jelenteni. Egyeztess a könyvelőddel.',
        'customer.vatStatus',
      );
    }
  }
  if (docType === 'advance' && codes.has('KBAET')) {
    out.warn('ADVANCE_FOR_INTRA_EU_SUPPLY', 'Közösségen belüli adómentes termékértékesítés (KBAET) előlegéről nem kell számlát kiállítani (Áfa tv. 59. § (4), 159. § (4)).', 'documentType');
  }

  // --- Issuing deadlines (Áfa tv. 163. §, research 02 §5.1) ----------------------------------
  if (issueDate && fulfilment && createLike && issueDate > fulfilment) {
    if (codes.has('KBAET') || codes.has('KBAUK') || codes.has('EUFAD37')) {
      const deadline = fifteenthOfNextMonth(fulfilment);
      if (issueDate > deadline) {
        out.warn('ISSUE_DEADLINE_MISSED', `Közösségen belüli termékértékesítésről / 37. § szerinti szolgáltatásról a számlát a teljesítés hónapját követő hónap 15. napjáig (${deadline}) kellett volna kiállítani (Áfa tv. 163. § (2) a)). Állítsd ki mielőbb.`, 'issueDate');
      }
    } else if (docType === 'advance') {
      if (daysBetween(fulfilment, issueDate) > 8) {
        out.warn('ISSUE_DEADLINE_MISSED', 'Előlegszámlát az előleg beérkezésekor haladéktalanul ki kell állítani (Áfa tv. 163. § (2) b)).', 'issueDate');
      }
    } else if ([...codes].some((c) => getVatInfo(c).nav.kind === 'vatPercentage') && daysBetween(fulfilment, issueDate) > 8) {
      out.warn(
        'ISSUE_DEADLINE_MISSED',
        `A számla ${daysBetween(fulfilment, issueDate)} nappal a teljesítés után kelt. Áfás számlát a teljesítéstől számított 8 napon belül, a teljesítésig kifizetett ügyletről haladéktalanul kell kiállítani (Áfa tv. 163. § (2) b)–c)).`,
        'issueDate',
      );
    }
  }
  return out.list;
}

/** Same buyer: same tax number (törzsszám) when both have one, otherwise the same name and EU VAT number. */
export function sameCustomer(a: CustomerData, b: CustomerData): boolean {
  const taxA = clean(a.taxNumber) ? parseHuTaxNumber(a.taxNumber as string) : null;
  const taxB = clean(b.taxNumber) ? parseHuTaxNumber(b.taxNumber as string) : null;
  if (taxA?.ok && taxB?.ok) return taxA.value.taxpayerId === taxB.value.taxpayerId;
  return clean(a.name).toLowerCase() === clean(b.name).toLowerCase() && clean(a.euVatNumber) === clean(b.euVatNumber);
}
