/**
 * Units of measure: Hungarian labels ↔ NAV UnitOfMeasureType (invoiceData.xsd v3.0).
 */
import { searchKey } from './canonical.ts';

/** NAV UnitOfMeasureType enumeration (invoiceData.xsd v3.0). */
export const NAV_UNITS = [
  'PIECE',
  'KILOGRAM',
  'TON',
  'KWH',
  'DAY',
  'HOUR',
  'MINUTE',
  'MONTH',
  'LITER',
  'KILOMETER',
  'CUBIC_METER',
  'METER',
  'LINEAR_METER',
  'CARTON',
  'PACK',
  'OWN',
] as const;
export type NavUnit = (typeof NAV_UNITS)[number];

/** Common Hungarian unit labels offered to users/agents (canonical spelling). */
export const COMMON_UNITS: readonly string[] = ['db', 'óra', 'nap', 'hó', 'kg', 't', 'l', 'm', 'fm', 'm³', 'km', 'kWh', 'perc', 'csomag', 'karton', 'alkalom', 'év', 'szolgáltatás'];

const HU_LABEL: Record<Exclude<NavUnit, 'OWN'>, string> = {
  PIECE: 'db',
  KILOGRAM: 'kg',
  TON: 't',
  KWH: 'kWh',
  DAY: 'nap',
  HOUR: 'óra',
  MINUTE: 'perc',
  MONTH: 'hó',
  LITER: 'l',
  KILOMETER: 'km',
  CUBIC_METER: 'm³',
  METER: 'm',
  LINEAR_METER: 'fm',
  CARTON: 'karton',
  PACK: 'csomag',
};

/** Accent-free, lower-case aliases → NAV unit. */
const ALIASES: Record<string, Exclude<NavUnit, 'OWN'>> = {};
function alias(unit: Exclude<NavUnit, 'OWN'>, ...labels: string[]): void {
  for (const l of labels) ALIASES[searchKey(l)] = unit;
}
alias('PIECE', 'db', 'darab', 'pcs', 'pc', 'piece', 'pieces', 'st', 'stk');
alias('KILOGRAM', 'kg', 'kilogramm', 'kilogram', 'kilo');
alias('TON', 't', 'tonna', 'ton', 'tonne');
alias('KWH', 'kwh', 'kilowattora', 'kilowatt-ora');
alias('DAY', 'nap', 'day', 'days', 'munkanap');
alias('HOUR', 'ora', 'h', 'hour', 'hours', 'hr', 'munkaora', 'oraszam');
alias('MINUTE', 'perc', 'min', 'minute', 'minutes');
alias('MONTH', 'ho', 'honap', 'month', 'months', 'havidij');
alias('LITER', 'l', 'liter', 'litre', 'ltr');
alias('KILOMETER', 'km', 'kilometer');
alias('CUBIC_METER', 'm3', 'm³', 'm^3', 'kobmeter', 'cubic meter');
alias('METER', 'm', 'meter', 'metre');
alias('LINEAR_METER', 'fm', 'folyometer', 'linear meter');
alias('CARTON', 'karton', 'carton', 'krt');
alias('PACK', 'csomag', 'cs', 'pack', 'package', 'csom');

/**
 * Maps a printed unit label to NAV. Case-insensitive, accent-insensitive and tolerant to a trailing
 * dot ("db.", "Óra", "m3"). Unknown labels → OWN + the label itself (max 50 chars).
 */
export function toNavUnit(label: string): { unitOfMeasure: NavUnit; unitOfMeasureOwn?: string } {
  const trimmed = label.trim();
  const key = searchKey(trimmed).replace(/\.$/, '').trim();
  const nav = ALIASES[key];
  if (nav) return { unitOfMeasure: nav };
  return { unitOfMeasure: 'OWN', unitOfMeasureOwn: (trimmed || 'egység').slice(0, 50) };
}

/** Canonical Hungarian label for a NAV unit ("PIECE" → "db"); OWN → "egyéb". */
export function huLabelForNavUnit(unit: NavUnit): string {
  return unit === 'OWN' ? 'egyéb' : HU_LABEL[unit];
}
