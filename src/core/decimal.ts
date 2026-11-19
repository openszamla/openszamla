import { Decimal } from 'decimal.js';
import { AppError } from './errors.ts';
import type { Dec } from './types.ts';

/**
 * Isolated Decimal constructor: high precision, ROUND_HALF_UP (= ties away from zero, so a
 * storno line rounds to the exact negative of the original line).
 */
export const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type DecValue = InstanceType<typeof D>;
export type DecInput = string | number | DecValue;

const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Parses a decimal input strictly ("12.5", 12.5). Rejects "1,5", "1e3", NaN, Infinity. */
export function dec(v: DecInput, field = 'érték'): DecValue {
  if (v instanceof D) return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw invalid(field, String(v));
    return new D(v);
  }
  const s = String(v).trim();
  if (!DEC_RE.test(s)) throw invalid(field, s);
  return new D(s);
}

function invalid(field: string, value: string): AppError {
  return new AppError('INVALID_NUMBER', `Érvénytelen szám a(z) "${field}" mezőben: ${value}`, {
    hint: 'Pont legyen a tizedesjel, ezres elválasztó nélkül (pl. 12500 vagy 12.5).',
  });
}

/** Canonical string: no exponent, no trailing zeros, no "-0". */
export function toDec(v: DecValue): Dec {
  let s = v.toFixed();
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Normalises any accepted input to the canonical string form. */
export function normDec(v: DecInput, field?: string): Dec {
  return toDec(dec(v, field));
}

/** Rounds half away from zero to `dp` decimal places. */
export function roundDec(v: DecInput, dp: number): DecValue {
  return dec(v).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** Fixed number of decimals as string (for XML/PDF), e.g. fixed("12.5", 2) → "12.50". */
export function fixed(v: DecInput, dp: number): string {
  const s = dec(v).toFixed(dp, Decimal.ROUND_HALF_UP);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

export function sumDec(values: DecInput[]): DecValue {
  return values.reduce<DecValue>((acc, v) => acc.plus(dec(v)), new D(0));
}

export function isZero(v: DecInput): boolean {
  return dec(v).isZero();
}

/**
 * Number of decimals used for AMOUNTS in a currency. HUF amounts are rounded to whole forints
 * (Hungarian invoicing convention); unit prices may still have decimals.
 */
export function currencyDecimals(currency: string): number {
  switch (currency.toUpperCase()) {
    case 'HUF':
    case 'JPY':
    case 'KRW':
    case 'ISK':
    case 'CLP':
    case 'VND':
      return 0;
    case 'BHD':
    case 'KWD':
    case 'OMR':
    case 'JOD':
    case 'TND':
      return 3;
    default:
      return 2;
  }
}
