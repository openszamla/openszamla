/**
 * Deterministic random data for the property-based core tests: a seeded PRNG (mulberry32 – no
 * Math.random, no clock) and generators that build decimal STRINGS from random digits, so no
 * floating-point value ever becomes an amount.
 */
import { normDec } from '../../src/core/decimal.ts';
import type { InvoiceLineInput, LineNature, PriceBasis, VatCode } from '../../src/core/types.ts';
import { VAT_CODES } from '../../src/core/vat.ts';

export type Rnd = () => number;

export function mulberry32(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rnd: Rnd, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

export function pick<T>(rnd: Rnd, items: readonly T[]): T {
  return items[int(rnd, 0, items.length - 1)] as T;
}

function digits(rnd: Rnd, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(int(rnd, 0, 9));
  return s;
}

/** Canonical decimal string with 1..maxInt integer digits and 0..maxFrac fraction digits. */
export function decimal(rnd: Rnd, maxInt: number, maxFrac: number, opts: { allowZeroInt?: boolean } = {}): string {
  const intLen = int(rnd, 1, maxInt);
  const intPart = opts.allowZeroInt && rnd() < 0.25 ? '0' : String(int(rnd, 1, 9)) + digits(rnd, intLen - 1);
  const fracLen = int(rnd, 0, maxFrac);
  const s = fracLen ? `${intPart}.${digits(rnd, fracLen)}` : intPart;
  const v = normDec(s);
  return v === '0' ? '1' : v;
}

export const CURRENCIES = ['HUF', 'HUF', 'HUF', 'EUR', 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CZK', 'KWD'] as const;

/** A plausible HUF value of one unit (inside NAV's watched bands where they exist). */
export function exchangeRate(rnd: Rnd, currency: string): string {
  switch (currency) {
    case 'HUF':
      return '1';
    case 'EUR':
      return `${int(rnd, 300, 450)}.${digits(rnd, int(rnd, 0, 4))}`.replace(/\.$/, '');
    case 'USD':
    case 'CHF':
      return `${int(rnd, 250, 450)}.${digits(rnd, 2)}`;
    case 'GBP':
      return `${int(rnd, 380, 520)}.${digits(rnd, 2)}`;
    case 'JPY':
      return `2.${digits(rnd, 4)}`;
    case 'CZK':
      return `${int(rnd, 12, 18)}.${digits(rnd, 3)}`;
    default:
      return `${int(rnd, 900, 1300)}.${digits(rnd, 6)}`;
  }
}

/** A random line: quantities up to 6 decimals, unit prices up to 4 (sometimes 8) decimals. */
export function line(rnd: Rnd, opts: { codes?: readonly VatCode[] } = {}): InvoiceLineInput {
  const negative = rnd() < 0.12;
  const qty = rnd() < 0.5 ? String(int(rnd, 1, 40)) : decimal(rnd, int(rnd, 1, 6), 6, { allowZeroInt: true });
  const magnitude = pick(rnd, [2, 3, 4, 5, 6, 7]);
  const price = decimal(rnd, magnitude, rnd() < 0.1 ? 8 : 4, { allowZeroInt: true });
  return {
    description: `Tétel ${int(rnd, 1, 999)}`,
    quantity: negative ? `-${qty}` : qty,
    unit: pick(rnd, ['db', 'óra', 'kg', 'm²', 'alkalom']),
    unitPrice: rnd() < 0.05 ? `-${price}` : price,
    priceBasis: pick<PriceBasis>(rnd, ['net', 'net', 'gross']),
    vatCode: pick(rnd, opts.codes ?? VAT_CODES),
    nature: pick<LineNature>(rnd, ['PRODUCT', 'SERVICE', 'OTHER']),
  };
}

/** Canonical decimal string: no exponent, no leading zeros, no trailing fraction zeros, no "-0". */
export const CANONICAL_DEC = /^(?!-0$)-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
