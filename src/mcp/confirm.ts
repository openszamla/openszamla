/**
 * Server-issued confirmation codes for irreversible operations (issuing, storno, reporting an invoice of the
 * other NAV system to the configured one).
 *
 * A code is bound to the operation, the target id and a hash of exactly what was previewed
 * (draft content, storno reason, or the invoice, its NAV status and both NAV systems), and expires after 10–20
 * minutes. The calling model can only obtain one from a preview (invoice_draft / invoice_get / invoice_cancel_preview /
 * nav_sync for nav_send_to_configured_environment), so the irreversible tool cannot be called "blind", and a draft
 * changed after its preview invalidates the code. Codes are short ("ABCD-EFGH-JKMN-PQRS") so they survive copying by
 * models and humans.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../core/canonical.ts';
import type { OpenSzamla } from '../service/app.ts';

const KEY_SETTING = 'mcpConfirmKey';
const BUCKET_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type ConfirmOperation = 'issue' | 'cancel' | 'nav-report';

function key(app: OpenSzamla): Buffer {
  let hex = app.store.getSetting<string>(KEY_SETTING);
  if (!hex) {
    hex = randomBytes(32).toString('hex');
    app.store.setSetting(KEY_SETTING, hex);
  }
  return Buffer.from(hex, 'hex');
}

function encode(bytes: Buffer): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

function codeFor(app: OpenSzamla, op: ConfirmOperation, id: string, material: string, bucket: number): string {
  const mac = createHmac('sha256', key(app)).update(`${op}|${id}|${material}|${bucket}`).digest();
  return encode(mac);
}

function bucketOf(now: Date): number {
  return Math.floor(now.getTime() / BUCKET_MS);
}

export function mintConfirmCode(app: OpenSzamla, op: ConfirmOperation, id: string, material: string, now: Date = new Date()): string {
  return codeFor(app, op, id, material, bucketOf(now));
}

/** True if `code` was minted for this exact operation/target/material within the last 10–20 minutes. */
export function verifyConfirmCode(app: OpenSzamla, op: ConfirmOperation, id: string, material: string, code: string, now: Date = new Date()): boolean {
  const given = Buffer.from(code.trim().toUpperCase());
  const b = bucketOf(now);
  for (const bucket of [b, b - 1]) {
    const expected = Buffer.from(codeFor(app, op, id, material, bucket));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Stable fingerprint of a code for audit/idempotency (never store the code itself). */
export function codeFingerprint(code: string): string {
  return sha256Hex(code.trim().toUpperCase()).slice(0, 32);
}
