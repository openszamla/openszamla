import { AppError } from './errors.ts';
import type { IsoDate } from './types.ts';

export const HU_TIME_ZONE = 'Europe/Budapest';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date of `at` in Hungary (Europe/Budapest), as "YYYY-MM-DD". */
export function huDate(at: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HU_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertIsoDate(s: string, field: string): IsoDate {
  if (!isIsoDate(s)) {
    throw new AppError('INVALID_DATE', `Érvénytelen dátum a(z) "${field}" mezőben: ${s}`, {
      hint: 'Használd az ÉÉÉÉ-HH-NN formátumot, pl. 2026-10-27.',
    });
  }
  return s;
}

/** Adds (or subtracts) whole days to an ISO date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new AppError('INVALID_DATE', `Érvénytelen dátum: ${date}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return dt.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive if b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function yearOf(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

/** "2026-10-27" → "2026.10.27." (Hungarian convention). */
export function formatHuDate(date: IsoDate): string {
  return `${date.slice(0, 4)}.${date.slice(5, 7)}.${date.slice(8, 10)}.`;
}
