/**
 * VAT code catalog: the single source of truth for how each VatCode is computed, printed and
 * reported to NAV Online Számla (VatRateType choice in invoiceData.xsd).
 *
 * Notation texts follow docs/research/02-jogi-kovetelmenyek.md §3 and §20:
 * - Statutory EXPRESSIONS (Áfa tv. 169. § h, l, n, p, q) are printed verbatim, in the exact (lower
 *   case) form of the Act: „fordított adózás”, „különbözet szerinti szabályozás – …” (the four
 *   variants; „régiségek” spelling – the njt text has the typo „régisek”, see §2.1).
 * - Exemptions (169. § m) need a legal / directive reference or another unambiguous indication;
 *   the catalog text is the default, a line's `vatReason` (e.g. "Áfa tv. 85. § (1) e)") overrides it.
 * - Out-of-scope codes have no mandatory wording; the research suggests „Az Áfa tv. területi
 *   hatályán kívüli ügylet” (EUE, HO) and „… tárgyi hatályán kívüli …” (ATK).
 * The Hungarian text is also the default NAV `reason` (≤ 200 characters) of exemption / out-of-scope
 * codes (see ../nav/invoice-data.ts), so every notationHu stays well below 200 characters.
 *
 * allowedFor (seller VAT status) – legal basis:
 * - AAM (alanyi adómentes) sellers may not charge VAT (187. § (2) c)), may not apply the KBAET
 *   exemption (90. § (1) a)), may not invoice under domestic reverse charge (142. § (3): no party may
 *   have a status excluding tax liability) or under the margin schemes.
 * - 193. § (1): the AAM exemption does NOT cover e.g. the sale of business assets / built real estate
 *   and the intra-Community supply of new means of transport – such supplies fall under the general
 *   rules, hence TAM and KBAUK are allowed for AAM sellers too (a percentage rate is possible in the
 *   193. § cases; ./validate.ts lets it through with a warning when the line names the legal basis).
 * customerScope documents who the buyer is expected to be; ./validate.ts turns the NAV-blocking
 * combinations (KBAET/EUFAD37/EUFADE → OTHER with EU VAT number, KBAUK → not DOMESTIC,
 * FAD → DOMESTIC) into errors and the rest into warnings.
 */
import { AppError } from './errors.ts';
import type { Dec, SellerVatStatus, VatCode } from './types.ts';

export type MarginScheme = 'TRAVEL_AGENCY' | 'SECOND_HAND' | 'ARTWORK' | 'ANTIQUES';

/** NAV VatRateType representation of a VAT code (exactly one choice branch). */
export type NavVatRate =
  | { kind: 'vatPercentage'; value: Dec }
  | { kind: 'vatExemption'; case: string }
  | { kind: 'vatOutOfScope'; case: string }
  | { kind: 'vatDomesticReverseCharge' }
  | { kind: 'marginSchemeIndicator'; value: MarginScheme };

/** Who the buyer is expected to be for a VAT code (used for validation warnings). */
export type CustomerScope = 'any' | 'domestic_taxable' | 'eu_taxable' | 'non_eu' | 'foreign';

export interface VatCodeInfo {
  code: VatCode;
  /** Rate used to compute the VAT amount ("0.27"); "0" for every non-percentage code. */
  rate: Dec;
  /** Short label printed in the VAT column ("27%", "AAM"). */
  label: string;
  nameHu: string;
  nameEn: string;
  nav: NavVatRate;
  /**
   * Default text for NAV `reason` (max 200 chars) and the mandatory notation printed on the
   * invoice (Áfa tv. 169. § m–p). null = no notation needed. Lines may override it (vatReason).
   */
  notationHu: string | null;
  notationEn: string | null;
  customerScope: CustomerScope;
  /** Seller VAT statuses that may use this code. */
  allowedFor: SellerVatStatus[];
}

const BOTH: SellerVatStatus[] = ['normal', 'aam'];
const NORMAL: SellerVatStatus[] = ['normal'];

const CATALOG: Record<VatCode, VatCodeInfo> = {
  '27': {
    code: '27', rate: '0.27', label: '27%', nameHu: '27% általános adókulcs', nameEn: '27% standard rate',
    nav: { kind: 'vatPercentage', value: '0.27' }, notationHu: null, notationEn: null,
    customerScope: 'any', allowedFor: NORMAL,
  },
  '18': {
    code: '18', rate: '0.18', label: '18%', nameHu: '18% kedvezményes adókulcs', nameEn: '18% reduced rate',
    nav: { kind: 'vatPercentage', value: '0.18' }, notationHu: null, notationEn: null,
    customerScope: 'any', allowedFor: NORMAL,
  },
  '5': {
    code: '5', rate: '0.05', label: '5%', nameHu: '5% kedvezményes adókulcs', nameEn: '5% reduced rate',
    nav: { kind: 'vatPercentage', value: '0.05' }, notationHu: null, notationEn: null,
    customerScope: 'any', allowedFor: NORMAL,
  },
  '0': {
    code: '0', rate: '0', label: '0%', nameHu: '0% adókulcs (Áfa tv. 3/B. melléklet)', nameEn: '0% rate',
    nav: { kind: 'vatPercentage', value: '0' }, notationHu: null, notationEn: null,
    customerScope: 'any', allowedFor: NORMAL,
  },
  AAM: {
    code: 'AAM', rate: '0', label: 'AAM', nameHu: 'Alanyi adómentes', nameEn: 'Exempt (small business exemption)',
    nav: { kind: 'vatExemption', case: 'AAM' },
    notationHu: 'Alanyi adómentes (Áfa tv. XIII. fejezet)',
    notationEn: 'VAT exempt – small business exemption (Hungarian VAT Act, Chapter XIII)',
    customerScope: 'any', allowedFor: ['aam'],
  },
  TAM: {
    code: 'TAM', rate: '0', label: 'TAM', nameHu: 'Tárgyi adómentes', nameEn: 'Exempt (exempt activity)',
    nav: { kind: 'vatExemption', case: 'TAM' },
    notationHu: 'Tárgyi adómentes (Áfa tv. 85–86. §)',
    notationEn: 'VAT exempt activity (Hungarian VAT Act §§ 85–86)',
    customerScope: 'any', allowedFor: BOTH,
  },
  KBAET: {
    code: 'KBAET', rate: '0', label: 'KBAET', nameHu: 'Közösségen belüli adómentes termékértékesítés', nameEn: 'Exempt intra-Community supply of goods',
    nav: { kind: 'vatExemption', case: 'KBAET' },
    notationHu: 'Adómentes Közösségen belüli termékértékesítés (Áfa tv. 89. §)',
    notationEn: 'Exempt intra-Community supply of goods (Article 138 of Directive 2006/112/EC)',
    customerScope: 'eu_taxable', allowedFor: NORMAL,
  },
  KBAUK: {
    code: 'KBAUK', rate: '0', label: 'KBAUK', nameHu: 'Új közlekedési eszköz adómentes Közösségen belüli értékesítése', nameEn: 'Exempt intra-Community supply of new means of transport',
    nav: { kind: 'vatExemption', case: 'KBAUK' },
    notationHu: 'Új közlekedési eszköz adómentes Közösségen belüli értékesítése (Áfa tv. 89. § (2) bekezdés)',
    notationEn: 'Exempt intra-Community supply of a new means of transport (Article 138(2)(a) of Directive 2006/112/EC)',
    customerScope: 'foreign', allowedFor: BOTH,
  },
  EAM: {
    code: 'EAM', rate: '0', label: 'EAM', nameHu: 'Adómentes termékexport', nameEn: 'Exempt export of goods',
    nav: { kind: 'vatExemption', case: 'EAM' },
    notationHu: 'Adómentes termékexport (Áfa tv. 98–109. §)',
    notationEn: 'Exempt export of goods outside the EU (Article 146 of Directive 2006/112/EC)',
    customerScope: 'non_eu', allowedFor: NORMAL,
  },
  NAM: {
    code: 'NAM', rate: '0', label: 'NAM', nameHu: 'Egyéb nemzetközi ügylethez kapcsolódó adómentesség', nameEn: 'Exempt international transaction',
    nav: { kind: 'vatExemption', case: 'NAM' },
    // Research 02 §20 row 10 lists the NAV code's scope as 93–95. § and 110–118. §, but 93–95. § are
    // IMPORT exemptions ("Adó alóli mentesség termék importja esetében") that never appear on a sales
    // invoice; the supplies a seller invoices under NAM are in 110–118. §. validate.ts asks for the
    // exact section in vatReason.
    notationHu: 'Adómentes nemzetközi ügylet (Áfa tv. 110–118. §)',
    notationEn: 'Exempt international transaction (Hungarian VAT Act §§ 110–118)',
    customerScope: 'any', allowedFor: NORMAL,
  },
  ATK: {
    code: 'ATK', rate: '0', label: 'ATK', nameHu: 'Áfa tárgyi hatályán kívüli ügylet', nameEn: 'Outside the scope of VAT',
    nav: { kind: 'vatOutOfScope', case: 'ATK' },
    notationHu: 'Az Áfa tv. tárgyi hatályán kívüli ügylet',
    notationEn: 'Outside the scope of VAT (not subject to the Hungarian VAT Act)',
    customerScope: 'any', allowedFor: BOTH,
  },
  EUFAD37: {
    code: 'EUFAD37', rate: '0', label: 'EUFAD37', nameHu: 'Más tagállamban teljesített szolgáltatás (Áfa tv. 37. §), fordított adózás', nameEn: 'Service supplied in another Member State, reverse charge',
    nav: { kind: 'vatOutOfScope', case: 'EUFAD37' },
    notationHu: 'fordított adózás – a teljesítés helye az Áfa tv. 37. § (1) bekezdése alapján a vevő tagállama',
    notationEn: 'Reverse charge (Article 196 of Directive 2006/112/EC)',
    customerScope: 'eu_taxable', allowedFor: BOTH,
  },
  EUFADE: {
    code: 'EUFADE', rate: '0', label: 'EUFADE', nameHu: 'Más tagállamban teljesített ügylet, fordított adózás', nameEn: 'Supply in another Member State, reverse charge',
    nav: { kind: 'vatOutOfScope', case: 'EUFADE' },
    notationHu: 'fordított adózás – a teljesítés helye a Közösség másik tagállama, az adót a vevő fizeti',
    notationEn: 'Reverse charge – place of supply in another EU Member State, VAT payable by the customer',
    customerScope: 'eu_taxable', allowedFor: BOTH,
  },
  EUE: {
    code: 'EUE', rate: '0', label: 'EUE', nameHu: 'Más tagállamban teljesített, nem fordított adózású ügylet', nameEn: 'Supply in another Member State, not reverse charged',
    nav: { kind: 'vatOutOfScope', case: 'EUE' },
    notationHu: 'Az Áfa tv. területi hatályán kívüli ügylet – a teljesítés helye a Közösség másik tagállama',
    notationEn: 'Outside the territorial scope of the Hungarian VAT Act – place of supply in another EU Member State',
    customerScope: 'any', allowedFor: BOTH,
  },
  HO: {
    code: 'HO', rate: '0', label: 'HO', nameHu: 'Harmadik országban teljesített ügylet', nameEn: 'Supply in a third country',
    nav: { kind: 'vatOutOfScope', case: 'HO' },
    notationHu: 'Az Áfa tv. területi hatályán kívüli ügylet – a teljesítés helye harmadik ország',
    notationEn: 'Outside the territorial scope of the Hungarian VAT Act – place of supply outside the EU',
    customerScope: 'non_eu', allowedFor: BOTH,
  },
  FAD: {
    code: 'FAD', rate: '0', label: 'F.Á.', nameHu: 'Belföldi fordított adózás', nameEn: 'Domestic reverse charge',
    nav: { kind: 'vatDomesticReverseCharge' },
    notationHu: 'fordított adózás',
    notationEn: 'Reverse charge',
    customerScope: 'domestic_taxable', allowedFor: NORMAL,
  },
  KUL_UTAZAS: {
    code: 'KUL_UTAZAS', rate: '0', label: 'K.Á.', nameHu: 'Különbözet szerinti szabályozás – utazási irodák', nameEn: 'Margin scheme – travel agents',
    nav: { kind: 'marginSchemeIndicator', value: 'TRAVEL_AGENCY' },
    notationHu: 'különbözet szerinti szabályozás – utazási irodák',
    notationEn: 'Margin scheme – travel agents',
    customerScope: 'any', allowedFor: NORMAL,
  },
  KUL_HASZNALT: {
    code: 'KUL_HASZNALT', rate: '0', label: 'K.Á.', nameHu: 'Különbözet szerinti szabályozás – használt cikkek', nameEn: 'Margin scheme – second-hand goods',
    nav: { kind: 'marginSchemeIndicator', value: 'SECOND_HAND' },
    notationHu: 'különbözet szerinti szabályozás – használt cikkek',
    notationEn: 'Margin scheme – second-hand goods',
    customerScope: 'any', allowedFor: NORMAL,
  },
  KUL_MUALKOTAS: {
    code: 'KUL_MUALKOTAS', rate: '0', label: 'K.Á.', nameHu: 'Különbözet szerinti szabályozás – műalkotások', nameEn: 'Margin scheme – works of art',
    nav: { kind: 'marginSchemeIndicator', value: 'ARTWORK' },
    notationHu: 'különbözet szerinti szabályozás – műalkotások',
    notationEn: 'Margin scheme – works of art',
    customerScope: 'any', allowedFor: NORMAL,
  },
  KUL_REGISEG: {
    code: 'KUL_REGISEG', rate: '0', label: 'K.Á.', nameHu: 'Különbözet szerinti szabályozás – gyűjteménydarabok és régiségek', nameEn: 'Margin scheme – collectors’ items and antiques',
    nav: { kind: 'marginSchemeIndicator', value: 'ANTIQUES' },
    notationHu: 'különbözet szerinti szabályozás – gyűjteménydarabok és régiségek',
    notationEn: 'Margin scheme – collectors’ items and antiques',
    customerScope: 'any', allowedFor: NORMAL,
  },
};

const RATE_CODES: readonly string[] = ['27', '18', '5', '0'];

/** Every code, the rates first in descending order (Object.keys alone would list integer-like keys first, ascending). */
export const VAT_CODES = [...RATE_CODES, ...Object.keys(CATALOG).filter((k) => !RATE_CODES.includes(k))] as VatCode[];

export function isVatCode(s: string): s is VatCode {
  return typeof s === 'string' && Object.hasOwn(CATALOG, s);
}

export function getVatInfo(code: VatCode): VatCodeInfo {
  // hasOwn: "constructor", "toString", "__proto__" … must not resolve to Object.prototype members.
  const info = typeof code === 'string' && Object.hasOwn(CATALOG, code) ? CATALOG[code] : undefined;
  if (!info) {
    throw new AppError('INVALID_VAT_CODE', `Ismeretlen ÁFA-kód: ${String(code)}`, {
      hint: `Használható kódok: ${VAT_CODES.join(', ')}`,
    });
  }
  return info;
}

export function listVatCodes(): VatCodeInfo[] {
  return VAT_CODES.map((c) => CATALOG[c]);
}

/** True if the code is a real percentage rate (27/18/5/0) whose VAT amount is computed. */
export function isPercentageCode(code: VatCode): boolean {
  return getVatInfo(code).nav.kind === 'vatPercentage';
}
