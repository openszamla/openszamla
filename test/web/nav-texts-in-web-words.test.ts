/**
 * The web says what a NAV run did, and why a correction waits for its original, from the structured values (the NAV
 * status, the stop of the run, the NAV system, the program's own message codes, NavWait) – never with the service's
 * agent notes (nav_sync, invoice_get, nav_send_to_configured_environment …). OpenSzamla.navWait gives the reason.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { NavStatus } from '../../src/core/types.ts';
import type { NavInvoiceResult, NavWait } from '../../src/service/app.ts';
import type { AppConfig } from '../../src/service/config.ts';
import { navResultText, navWaitText } from '../../src/web/nav-text.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { makeTestApp, type TestApp } from '../helpers/app.ts';
import { insertIssued } from './helpers.ts';

const AGENT_WORDS = /nav_sync|invoice_get|invoice_list|nav_send_to_configured_environment|resubmitFailed|navMessages|\{ invoice/;

const result = (navStatus: NavStatus, o: Partial<NavInvoiceResult> = {}): NavInvoiceResult => ({
  invoiceId: 'inv_00000000a1', number: 'SZ-2026-00001', navStatus, transactionId: null, messages: [], environment: 'production', note: 'nav_sync …', ...o,
});

describe('navResultText', () => {
  it('every status, every stop of the run and the other NAV system in web words', () => {
    // [the run's result, the NAV system configured, what the web says]
    const cases: Array<[NavInvoiceResult, 'test' | 'production', string]> = [
      [result('done'), 'production', 'A NAV befogadta.'],
      [result('done', { environment: 'test' }), 'test', 'A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.'],
      [result('done_with_warnings'), 'production', 'A NAV befogadta, de figyelmeztetést adott'],
      [result('aborted'), 'production', 'A NAV elutasította: az okát a számla NAV részében, a NAV üzeneteinél olvashatod.'],
      [result('aborted', { messages: [{ severity: 'ERROR', code: 'OPENSZAMLA_NUMBER_COLLISION', message: '…' }] }), 'production', 'Sorszám-ütközés'],
      [result('error', { messages: [{ severity: 'ERROR', code: 'OPENSZAMLA_RECONCILE_BLOCKED', message: '…' }] }), 'production', 'nem tudja egyeztetni a NAV-val'],
      [result('error'), 'production', 'Végleges hiba'],
      [result('processing'), 'production', 'A NAV még feldolgozza'],
      [result('pending'), 'production', 'Átmeneti hiba miatt nem sikerült elküldeni'],
      [result('pending', { messages: [{ severity: 'INFO', code: 'OPENSZAMLA_UNCERTAIN', message: '…' }] }), 'production', 'A beküldés eredménye bizonytalan'],
      [result('pending', { notProcessed: 'time' }), 'production', 'A rendelkezésre álló idő letelt'],
      [result('pending', { notProcessed: 'outage' }), 'production', 'A NAV most nem érhető el'],
      [result('pending', { notProcessed: 'pause' }), 'production', 'A NAV szünetet kért'],
      // The NAV state of the other system: the web did not send it.
      [result('done', { environment: 'test' }), 'production', 'a másik NAV-rendszerhez tartozik, ezért a webes felület nem küldte be'],
    ];
    for (const [r, configured, text] of cases) {
      const said = navResultText(r, configured);
      expect(said, `${r.navStatus} ${configured}`).toContain(text);
      expect(said).not.toMatch(AGENT_WORDS);
    }
  });

  it('a pending correction: why it waits, naming the original', () => {
    const w: NavWait = { originalId: 'inv_00000000a1', originalNumber: 'SZ-2026-00001', reason: 'pending' };
    expect(navResultText(result('pending', { invoiceId: 'inv_00000000a4' }), 'production', w, 'Ez a sztornó számla')).toBe(
      'Ez a sztornó számla az eredeti számlára vár: előbb a(z) SZ-2026-00001 számlát kell jelenteni a NAV-nak. A „Függő számlák beküldése a NAV-nak” gomb sorban mindkettőt beküldi.',
    );
  });
});

describe('navWaitText', () => {
  it('each reason, in both NAV systems', () => {
    const reasons: Array<NavWait['reason']> = ['other_environment', 'rejected', 'collision', 'blocked', 'processing', 'pending'];
    for (const reason of reasons) {
      for (const env of ['test', 'production'] as const) {
        const text = navWaitText({ originalId: 'inv_00000000a1', originalNumber: 'SZ-2026-00001', reason, environment: env === 'test' ? 'production' : 'test' }, 'Ez a módosító számla', env);
        expect(text, `${reason} ${env}`).toContain('SZ-2026-00001');
        expect(text.startsWith('Ez a módosító számla')).toBe(true);
        expect(text).not.toMatch(AGENT_WORDS);
      }
    }
  });
});

describe('OpenSzamla.navWait / navCorrectionWait', () => {
  const apps: TestApp[] = [];
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.cleanup();
  });
  const CREDENTIALS = { login: 'WAITLOGIN7f3a', password: 'wait-password-1', signingKey: 'WAIT-SIGNING-KEY-55e0', exchangeKey: 'WAITEXCHd00d42ab' };
  const nav = (environment: 'test' | 'production'): AppConfig['nav'] => ({ environment, credentials: CREDENTIALS, source: 'env', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' });

  it('names the original and the reason; null for an accepted original', () => {
    const t = makeTestApp({ nav: nav('production') });
    apps.push(t);
    t.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(t.app, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    insertIssued(t.app, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'production' });
    expect(t.app.navWait('inv_00000000a4')).toEqual({ originalId: 'inv_00000000a1', originalNumber: 'SZ-2026-00001', reason: 'other_environment', environment: 'test' });
    expect(t.app.navCorrectionWait('inv_00000000a1')).toMatchObject({ reason: 'other_environment' });
    // The text for agents is unchanged.
    expect(t.app.navWaitReason('inv_00000000a4')).toContain('nav_send_to_configured_environment');
    insertIssued(t.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', navStatus: 'done', navEnvironment: 'production' });
    expect(t.app.navCorrectionWait('inv_00000000b1')).toBeNull();
    expect(t.app.navWait('inv_00000000a1')).toBeNull();
  });
});
