/**
 * setup_status (OpenSzamla.status) gives its to-dos structured as well: `todos` – a stable code, the number of documents
 * and the details (numbers, the NAV system, the pause) – next to the nextSteps texts, which stay as they are for agents.
 * `counts.navNotConfigured` counts the invoices issued without a usable NAV connection apart (they are also in
 * navProblems). The web UI words the to-dos itself from these values.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { makeTestApp, type TestApp } from '../helpers/app.ts';
import { insertIssued } from '../web/helpers.ts';

const apps: TestApp[] = [];
afterEach(() => {
  while (apps.length > 0) apps.pop()?.cleanup();
});

function app(nav: AppConfig['nav'] = null): TestApp {
  const t = makeTestApp({ nav });
  apps.push(t);
  return t;
}

const CREDENTIALS = { login: 'TODOLOGIN7f3a', password: 'todo-password-1', signingKey: 'TODO-SIGNING-KEY-55e0', exchangeKey: 'TODOEXCHd00d42ab' };
const nav = (environment: 'test' | 'production'): AppConfig['nav'] => ({ environment, credentials: CREDENTIALS, source: 'env', baseUrl: 'http://127.0.0.1:9/invoiceService/v3' });

describe('status().todos', () => {
  it('a first run: the seller and the NAV connection, with no document counts', () => {
    const { app: a } = app();
    const s = a.status();
    expect(s.todos).toEqual([
      { code: 'SELLER_MISSING', count: 0 },
      { code: 'NAV_NOT_CONFIGURED', count: 0 },
    ]);
    // The texts for agents stay.
    expect(s.nextSteps).toHaveLength(2);
    expect(s.nextSteps[0]).toContain('seller_update');
  });

  it('invoices issued without NAV: NAV_NOT_REPORTED with their number, counted apart in navNotConfigured', () => {
    const { app: a } = app();
    a.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(a, INVOICE_DOMESTIC, { navStatus: 'not_configured' });
    insertIssued(a, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', navStatus: 'not_configured' });
    const s = a.status();
    expect(s.counts).toMatchObject({ navNotConfigured: 2, navProblems: 2, navPending: 0 });
    expect(s.todos).toEqual([
      { code: 'NAV_NOT_CONFIGURED', count: 0 },
      { code: 'NAV_NOT_REPORTED', count: 2 },
    ]);
    expect(s.nextSteps.join('\n')).toContain('2 számla még nincs jelentve');
  });

  it('the TEST system: the environment, a rejected and a pending report', () => {
    const { app: a } = app(nav('test'));
    a.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(a, INVOICE_DOMESTIC, { navStatus: 'aborted', navEnvironment: 'test' });
    insertIssued(a, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', navStatus: 'pending', navEnvironment: 'test' });
    const s = a.status();
    expect(s.todos.map((t) => [t.code, t.count])).toEqual([
      ['NAV_TEST_ENVIRONMENT', 0],
      ['NAV_REJECTED', 1],
      ['NAV_PENDING', 1],
    ]);
    expect(s.counts).toMatchObject({ navNotConfigured: 0, navProblems: 1, navPending: 1 });
  });

  it('production with an invoice reported only to TEST and its storno waiting: the other system apart, the held storno apart, nothing pending', () => {
    const { app: a } = app(nav('production'));
    a.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(a, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    insertIssued(a, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'production' });
    const s = a.status();
    expect(s.todos).toEqual([
      { code: 'NAV_OTHER_ENVIRONMENT', count: 1, numbers: ['SZ-2026-00001'], more: 0, environment: 'test' },
      { code: 'NAV_HELD_BY_OTHER_ENVIRONMENT', count: 1, environment: 'test' },
    ]);
    expect(s.counts).toMatchObject({ navOtherEnvironment: 1, navPending: 1 });
    // The agents' text names both in one step, as before.
    expect(s.nextSteps.join('\n')).toContain('Rájuk vár 1 módosító/sztornó számla is');
  });

  it('a storno held up by a rejected original: NAV_HELD_BY_REJECTED_ORIGINAL names the original', () => {
    const { app: a } = app(nav('test'));
    a.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(a, INVOICE_DOMESTIC, { navStatus: 'aborted', navEnvironment: 'test' });
    insertIssued(a, INVOICE_STORNO, { navStatus: 'pending', navEnvironment: 'test' });
    const held = a.status().todos.find((t) => t.code === 'NAV_HELD_BY_REJECTED_ORIGINAL');
    expect(held).toEqual({ code: 'NAV_HELD_BY_REJECTED_ORIGINAL', count: 1, numbers: ['SZ-2026-00001'], more: 0 });
    expect(a.status().todos.some((t) => t.code === 'NAV_PENDING')).toBe(false);
  });

  it('seller data with an error: SELLER_INVALID with the number of errors', () => {
    const { app: a } = app();
    a.store.setSetting('seller', { ...SELLER_NORMAL, taxNumber: '' });
    const t = a.status().todos[0];
    expect(t?.code).toBe('SELLER_INVALID');
    expect(t?.count).toBeGreaterThan(0);
  });
});
