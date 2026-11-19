import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Fingerprints of a file (a kept original PDF): uppercase hex SHA-256 and SHA3-512 – as NAV writes electronicInvoiceHash – and its size. */
export function fileFingerprints(content: Uint8Array): { sha256: string; sha3_512: string; size: number } {
  return {
    sha256: createHash('sha256').update(content).digest('hex').toUpperCase(),
    sha3_512: createHash('sha3-512').update(content).digest('hex').toUpperCase(),
    size: content.byteLength,
  };
}

/** Lower-cased, accent-free form for search ("Árvíztűrő" → "arvizturo"). */
export function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
