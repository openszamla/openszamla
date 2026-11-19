/**
 * NAV Online Számla v3.0 cryptography (node:crypto only).
 * CONTRACT FILE – keep the signatures.
 *
 * Source: NAV "Online Számla Interface Specification 3.0" (2026.02.12), chapter 1.5
 * "Calculating requestSignature", 1.3.2 (passwordHash) and 1.8.10 (tokenExchange). Verified in
 * test/nav/crypto.test.ts against the spec's worked example and the signatures of the official
 * request samples (vendor/nav-online-invoice/samples/api).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { NavOperation } from './types.ts';

/** requestId pattern of common:EntityIdType. */
export const REQUEST_ID_RE = /^[+a-zA-Z0-9_]{1,30}$/;

function upperHex(algorithm: 'sha512' | 'sha3-512', text: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex').toUpperCase();
}

function assertValidDate(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('Invalid request timestamp');
}

/** SHA-512 of the technical user's password, uppercase hex. */
export function passwordHash(password: string): string {
  return upperHex('sha512', password);
}

/** UTC request timestamp as sent in the header, e.g. "2026-10-27T13:05:00.000Z". */
export function requestTimestamp(at: Date): string {
  assertValidDate(at);
  return at.toISOString();
}

/** The "YYYYMMDDhhmmss" UTC mask of the timestamp used inside the signature base. */
export function signatureTimestamp(at: Date): string {
  return requestTimestamp(at).slice(0, 19).replace(/[-T:]/g, '');
}

/**
 * requestSignature (SHA3-512, uppercase hex).
 * Ordinary operations: SHA3-512(requestId + yyyyMMddHHmmss(UTC timestamp) + signingKey).
 * manageInvoice / manageAnnulment ("partial authentication" + index hashes): the uppercase per-item
 * hashes (see invoiceHash) are appended, in index order, to that concatenation before hashing:
 *   SHA3-512(requestId + yyyyMMddHHmmss + signingKey + hash(index 1) + hash(index 2) + …)
 */
export function requestSignature(requestId: string, at: Date, signingKey: string, itemHashes: string[] = []): string {
  const base = requestId + signatureTimestamp(at) + signingKey + itemHashes.map((h) => h.toUpperCase()).join('');
  return upperHex('sha3-512', base);
}

/**
 * Per-item hash used in the manageInvoice / manageAnnulment signature:
 * SHA3-512(invoiceOperation literal + base64 content of invoiceData), uppercase hex.
 */
export function invoiceHash(operation: NavOperation | 'ANNUL', invoiceDataBase64: string): string {
  return upperHex('sha3-512', operation + invoiceDataBase64);
}

function aesKey(exchangeKey: string): Buffer {
  const key = Buffer.from(exchangeKey, 'utf8');
  if (key.length !== 16) {
    // Never echo the key itself.
    throw new RangeError(`The XML exchange key must be 16 bytes long for AES-128 (got ${key.length}).`);
  }
  return key;
}

/**
 * Decrypts encodedExchangeToken (base64, AES-128-ECB, key = the 16 bytes of the exchange key,
 * PKCS#5/PKCS#7 padding) to the plain token.
 */
export function decodeExchangeToken(encodedExchangeToken: string, exchangeKey: string): string {
  const data = Buffer.from(encodedExchangeToken.replace(/\s+/g, ''), 'base64');
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('The encoded exchange token is not a valid AES-128 block sequence.');
  const decipher = createDecipheriv('aes-128-ecb', aesKey(exchangeKey), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Inverse of decodeExchangeToken – what NAV does server side (used by the fake NAV server and tests). */
export function encodeExchangeToken(token: string, exchangeKey: string): string {
  const cipher = createCipheriv('aes-128-ecb', aesKey(exchangeKey), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]).toString('base64');
}

/**
 * New unique requestId matching NAV's pattern (max 30 chars, [+a-zA-Z0-9_]):
 * "OSZ" + base36 millisecond time + 64 random bits in hex → at most 28 characters.
 */
export function newRequestId(): string {
  const id = `OSZ${Date.now().toString(36).toUpperCase()}${randomBytes(8).toString('hex').toUpperCase()}`;
  return id.slice(0, 30);
}
