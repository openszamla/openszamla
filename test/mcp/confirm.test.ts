import { afterEach, describe, expect, it } from 'vitest';
import { codeFingerprint, mintConfirmCode, verifyConfirmCode } from '../../src/mcp/confirm.ts';
import { makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('confirmation codes', () => {
  it('are short, bound to operation, target and material, and expire after 10–20 minutes', () => {
    t = makeTestApp();
    const now = new Date('2026-10-27T10:00:00.000Z');
    const code = mintConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', now);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', code, now)).toBe(true);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', code.toLowerCase(), now)).toBe(true);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-b', code, now)).toBe(false);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_2', 'hash-a', code, now)).toBe(false);
    expect(verifyConfirmCode(t.app, 'cancel', 'inv_1', 'hash-a', code, now)).toBe(false);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', code, new Date(now.getTime() + 9 * 60_000))).toBe(true);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', code, new Date(now.getTime() + 21 * 60_000))).toBe(false);
    expect(verifyConfirmCode(t.app, 'issue', 'inv_1', 'hash-a', 'nonsense', now)).toBe(false);
  });

  it('use a per-installation key and never store the code itself', () => {
    t = makeTestApp();
    const other = makeTestApp();
    try {
      const now = new Date('2026-10-27T10:00:00.000Z');
      const code = mintConfirmCode(t.app, 'issue', 'inv_1', 'h', now);
      expect(verifyConfirmCode(other.app, 'issue', 'inv_1', 'h', code, now)).toBe(false);
      expect(codeFingerprint(code)).not.toContain(code);
      expect(codeFingerprint(code)).toBe(codeFingerprint(` ${code.toLowerCase()} `));
    } finally {
      other.cleanup();
    }
  });
});
