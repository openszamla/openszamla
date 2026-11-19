import { randomBytes } from 'node:crypto';

export type IdPrefix = 'cus' | 'prd' | 'inv' | 'ser';

/** Short random id like "inv_3f9a1c7e2b" (40 bits of entropy – plenty for one company's data). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}
