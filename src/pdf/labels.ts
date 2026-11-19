/**
 * Printed labels of the invoice PDF – Hungarian and English.
 *
 * Language modes (Invoice.language):
 * - 'hu'    → Hungarian only
 * - 'en'    → English only
 * - 'hu-en' → bilingual "magyar / English" (Számv. tv. 166. §: a foreign-language document must also
 *             carry the data needed for bookkeeping in Hungarian – the bilingual template does that).
 */
import { toNavUnit, type NavUnit } from '../core/units.ts';
import type { DocumentType, InvoiceLanguage, PaymentMethod } from '../core/types.ts';

export interface Bilingual {
  hu: string;
  en: string;
}

export const LABELS = {
  // --- header -----------------------------------------------------------------------------
  number: { hu: 'Sorszám', en: 'Number' },
  draftNumber: { hu: 'TERVEZET', en: 'DRAFT' },
  draftNote: {
    hu: 'Tervezet – sorszámot a kiállításkor kap, így nem számla.',
    en: 'Draft – it gets its number when issued; this is not an invoice.',
  },
  draftNoteNumbered: { hu: 'Tervezet – nem számla.', en: 'Draft – not an invoice.' },
  copy: { hu: 'MÁSOLAT', en: 'COPY' },
  notAnInvoice: { hu: 'Ez nem számla', en: 'This is not an invoice' },
  proformaNote: {
    hu: 'Fizetési felhívás – áfa levonására nem jogosít.',
    en: 'Payment request – it does not entitle the recipient to deduct VAT.',
  },
  originalInvoice: { hu: 'Az eredeti számla sorszáma', en: 'Original invoice number' },
  modificationIndex: { hu: 'Módosítási index', en: 'Modification index' },
  modifyWithoutMaster: {
    hu: 'Az eredeti számláról nem történt NAV-adatszolgáltatás',
    en: 'The original invoice was not reported to NAV',
  },
  // --- parties ----------------------------------------------------------------------------
  seller: { hu: 'Eladó (szállító)', en: 'Seller' },
  buyer: { hu: 'Vevő', en: 'Buyer' },
  taxNumber: { hu: 'Adószám', en: 'Tax number' },
  groupId: { hu: 'Csoportazonosító szám', en: 'VAT group ID' },
  groupMemberTaxNumber: { hu: 'Csoporttag adószáma', en: 'Group member tax number' },
  euVatNumber: { hu: 'Közösségi adószám', en: 'EU VAT number' },
  thirdStateTaxId: { hu: 'Külföldi adóazonosító', en: 'Foreign tax ID' },
  companyRegNumber: { hu: 'Cégjegyzékszám', en: 'Company reg. no.' },
  soleTraderRegNumber: { hu: 'Nyilvántartási szám', en: 'Registration no.' },
  bankAccount: { hu: 'Bankszámla', en: 'Bank account' },
  swift: { hu: 'SWIFT', en: 'SWIFT' },
  email: { hu: 'E-mail', en: 'E-mail' },
  phone: { hu: 'Telefon', en: 'Phone' },
  website: { hu: 'Web', en: 'Web' },
  // --- dates / meta -----------------------------------------------------------------------
  issueDate: { hu: 'Számla kelte', en: 'Issue date' },
  proformaDate: { hu: 'Kelt', en: 'Date' },
  fulfillmentDate: { hu: 'Teljesítés dátuma', en: 'Date of supply' },
  expectedFulfillmentDate: { hu: 'Várható teljesítés', en: 'Expected date of supply' },
  dueDate: { hu: 'Fizetési határidő', en: 'Due date' },
  paymentMethod: { hu: 'Fizetési mód', en: 'Payment method' },
  currency: { hu: 'Pénznem', en: 'Currency' },
  exchangeRate: { hu: 'Árfolyam', en: 'Exchange rate' },
  orderNumber: { hu: 'Megrendelésszám', en: 'Order number' },
  // --- lines table (\n = preferred line break in narrow column headers) --------------------
  colNo: { hu: '#', en: '#' },
  colDescription: { hu: 'Megnevezés', en: 'Description' },
  colQuantity: { hu: 'Mennyiség', en: 'Quantity' },
  colUnitPrice: { hu: 'Nettó\negységár', en: 'Net unit\nprice' },
  colNet: { hu: 'Nettó\nérték', en: 'Net\namount' },
  colVatRate: { hu: 'ÁFA', en: 'VAT' },
  colVat: { hu: 'ÁFA\nérték', en: 'VAT\namount' },
  colGross: { hu: 'Bruttó\nérték', en: 'Gross\namount' },
  // --- VAT summary / totals -------------------------------------------------------------------
  vatSummary: { hu: 'ÁFA-összesítő', en: 'VAT summary' },
  colVatCode: { hu: 'ÁFA-kulcs / jogcím', en: 'VAT rate / category' },
  netTotal: { hu: 'Nettó összesen', en: 'Net total' },
  vatTotal: { hu: 'ÁFA összesen', en: 'VAT total' },
  grossTotal: { hu: 'Bruttó összesen', en: 'Gross total' },
  total: { hu: 'Összesen', en: 'Total' },
  inHuf: { hu: 'Forintban', en: 'In HUF' },
  rounding: { hu: 'Kerekítés', en: 'Rounding' },
  payableRounded: { hu: 'Fizetendő (kerekítve)', en: 'Amount payable (rounded)' },
  // --- notes ------------------------------------------------------------------------------
  notations: { hu: 'Kötelező megjelölések', en: 'Mandatory notes' },
  comment: { hu: 'Megjegyzés', en: 'Comment' },
  advanceDeduction: { hu: 'Előleg levonása – előlegszámla', en: 'Advance deducted – advance invoice' },
  advancePaid: { hu: 'előleg fizetése', en: 'advance paid' },
  // --- footer -----------------------------------------------------------------------------
  watermark: { hu: 'TERVEZET – NEM SZÁMLA', en: 'DRAFT – NOT AN INVOICE' },
} as const satisfies Record<string, Bilingual>;

export type LabelKey = keyof typeof LABELS;

/** The text of a bilingual pair in the given language ('hu-en' → "magyar / English"). */
export function pick(text: Bilingual, lang: InvoiceLanguage): string {
  if (lang === 'hu') return text.hu;
  if (lang === 'en') return text.en;
  return text.hu === text.en ? text.hu : `${text.hu} / ${text.en}`;
}

/** Label in the given language; line breaks meant for narrow table headers are flattened. */
export function label(key: LabelKey, lang: InvoiceLanguage): string {
  const l: Bilingual = LABELS[key];
  return pick({ hu: l.hu.replace(/\n/g, ' '), en: l.en.replace(/\n/g, ' ') }, lang);
}

export const DOCUMENT_TITLES: Record<DocumentType, Bilingual> = {
  invoice: { hu: 'SZÁMLA', en: 'INVOICE' },
  advance: { hu: 'ELŐLEGSZÁMLA', en: 'ADVANCE INVOICE' },
  final: { hu: 'VÉGSZÁMLA', en: 'FINAL INVOICE' },
  modification: { hu: 'MÓDOSÍTÓ SZÁMLA', en: 'CORRECTIVE INVOICE' },
  storno: { hu: 'SZTORNÓ SZÁMLA', en: 'CANCELLATION INVOICE' },
  proforma: { hu: 'DÍJBEKÉRŐ', en: 'PRO FORMA INVOICE' },
};

/** Optional second title line (legal name of the document type). */
export const DOCUMENT_SUBTITLES: Partial<Record<DocumentType, Bilingual>> = {
  storno: { hu: 'Érvénytelenítő számla', en: 'Invoice cancelling the original invoice' },
  modification: { hu: 'Helyesbítő számla', en: 'Invoice correcting the original invoice' },
  final: { hu: 'Előleg levonásával', en: 'Advance payments deducted' },
};

export const PAYMENT_METHODS: Record<PaymentMethod, Bilingual> = {
  TRANSFER: { hu: 'Átutalás', en: 'Bank transfer' },
  CASH: { hu: 'Készpénz', en: 'Cash' },
  CARD: { hu: 'Bankkártya', en: 'Card' },
  VOUCHER: { hu: 'Utalvány', en: 'Voucher' },
  OTHER: { hu: 'Egyéb', en: 'Other' },
};

export const RATE_SOURCES: Record<'MNB' | 'manual', Bilingual> = {
  MNB: { hu: 'MNB hivatalos árfolyam', en: 'official MNB rate' },
  manual: { hu: 'egyedi árfolyam', en: 'custom rate' },
};

/** "1/2. oldal" / "Page 1/2" / "1/2. oldal / Page 1/2". */
export function pageLabel(current: number, total: number, lang: InvoiceLanguage): string {
  return pick({ hu: `${current}/${total}. oldal`, en: `Page ${current}/${total}` }, lang);
}

/** Sub-line of a modification invoice line that modifies an original line. */
export function modifiesLineLabel(lineNo: number, lang: InvoiceLanguage): string {
  return pick(
    { hu: `Az eredeti számla ${lineNo}. tételének módosítása`, en: `Modifies line ${lineNo} of the original invoice` },
    lang,
  );
}

const EN_UNITS: Record<Exclude<NavUnit, 'OWN'>, string> = {
  PIECE: 'pcs',
  KILOGRAM: 'kg',
  TON: 't',
  KWH: 'kWh',
  DAY: 'day',
  HOUR: 'h',
  MINUTE: 'min',
  MONTH: 'month',
  LITER: 'l',
  KILOMETER: 'km',
  CUBIC_METER: 'm³',
  METER: 'm',
  LINEAR_METER: 'lm',
  CARTON: 'carton',
  PACK: 'pack',
};

/**
 * Unit label as printed: the stored (Hungarian) label, translated for English-only invoices when it
 * is a known unit ("óra" → "h", "db" → "pcs"); unknown labels are printed unchanged.
 */
export function unitLabel(unit: string, lang: InvoiceLanguage): string {
  if (lang !== 'en') return unit;
  const nav = toNavUnit(unit).unitOfMeasure;
  return nav === 'OWN' ? unit : EN_UNITS[nav];
}

const regionNames = new Map<'hu' | 'en', Intl.DisplayNames>();

/** Country name for an ISO 3166-1 alpha-2 code ("DE" → "Németország" / "Germany"). */
export function countryName(code: string, lang: InvoiceLanguage): string {
  const name = (l: 'hu' | 'en'): string => {
    let dn = regionNames.get(l);
    if (!dn) {
      dn = new Intl.DisplayNames([l], { type: 'region', fallback: 'code' });
      regionNames.set(l, dn);
    }
    try {
      return dn.of(code.toUpperCase()) ?? code;
    } catch {
      return code;
    }
  };
  return pick({ hu: name('hu'), en: name('en') }, lang);
}
