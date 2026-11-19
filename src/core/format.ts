/**
 * Human-readable formatting (PDF, text summaries for agents, web UI).
 * Hungarian invoice conventions: thousands grouped with a no-break space (U+00A0), decimal comma,
 * "Ft" after HUF amounts, dates as "2026.10.27.". Grouping is applied to every number of 4+ digits
 * (consistent columns) – deliberately not relying on Intl's locale-dependent minimum grouping.
 */
import { currencyDecimals, dec, fixed, toDec, type DecInput } from './decimal.ts';
import type { CurrencyCode, InvoiceLanguage } from './types.ts';

const NBSP = ' ';

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function render(s: string, lang: 'hu' | 'en'): string {
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const body = group(int ?? '0', lang === 'hu' ? NBSP : ',') + (frac ? (lang === 'hu' ? ',' : '.') + frac : '');
  return neg ? `-${body}` : body;
}

/** 1234567.5 → "1 234 567,50" (hu) / "1,234,567.50" (en) with exactly `dp` decimals. */
export function formatNumber(value: DecInput, dp: number, lang: 'hu' | 'en' = 'hu'): string {
  return render(fixed(value, dp), lang);
}

/** Amount with currency: HUF → "127 000 Ft" (hu) / "HUF 127,000" (en); EUR → "1 234,50 EUR". */
export function formatMoney(value: DecInput, currency: CurrencyCode, lang: 'hu' | 'en' = 'hu'): string {
  const cur = currency.toUpperCase();
  const n = formatNumber(value, currencyDecimals(cur), lang);
  if (lang === 'en') return `${cur}${NBSP}${n}`;
  return cur === 'HUF' ? `${n}${NBSP}Ft` : `${n}${NBSP}${cur}`;
}

/** Quantity/price without trailing zeros: "1,5" (hu) / "1.5" (en). */
export function formatQuantity(value: DecInput, lang: 'hu' | 'en' = 'hu'): string {
  return render(toDec(dec(value)), lang);
}

/** "2026-10-27" → "2026.10.27." (hu) / "2026-10-27" (en – ISO, unambiguous). */
export function formatDate(iso: string, lang: 'hu' | 'en' = 'hu'): string {
  if (lang === 'en') return iso;
  return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}.`;
}

/** Pick 'hu' for 'hu' and 'hu-en' (primary language), 'en' for 'en'. */
export function primaryLang(lang: InvoiceLanguage): 'hu' | 'en' {
  return lang === 'en' ? 'en' : 'hu';
}

/** Control characters – C0 (CR, LF, TAB …), DEL, C1 – and the Unicode line / paragraph separators. */
const CONTROL_RUN = /[ \u00A0]*[\u0000-\u001F\u007F-\u009F\u2028\u2029][\s\u0000-\u001F\u007F-\u009F]*/g;

/** Bidirectional formatting characters: ALM, LRM, RLM, the embeddings and overrides (LRE…RLO) and the isolates (LRI…PDI). */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Text on one line: every run of line breaks, tabs and other control characters (with the spaces around
 * it) becomes one space, bidirectional formatting characters are left out, and the ends are trimmed. A
 * legal name, an address or a storno reason has no line breaks; text copied from an e-mail could
 * otherwise start a new, official-looking line in a summary or confirmation dialog, or – with a
 * right-to-left override – show its characters in another order than they are stored.
 */
export function singleLine(text: string): string {
  return text.replace(BIDI_CONTROL, '').replace(CONTROL_RUN, ' ').trim();
}

/**
 * Characters that show nothing on their own: white space, format characters (\p{Cf}: zero-width spaces and joiners,
 * bidirectional controls …), the other default-ignorable code points (the Hangul fillers U+115F, U+1160, U+3164 and
 * U+FFA0, the variation selectors, U+034F …) and the blank Braille pattern U+2800.
 */
const SHOWS_NOTHING = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;

/**
 * The number of characters of `text` that show something (in code points): a storno reason or a name made only of
 * SHOWS_NOTHING characters would print as an empty "Sztornó oka:" or a blank buyer name.
 */
export function visibleLength(text: string): number {
  return Array.from(text.replace(SHOWS_NOTHING, '')).length;
}
