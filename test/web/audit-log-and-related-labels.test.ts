/**
 * U12: the invoice page's log ("Napló") speaks Hungarian – every action the program logs for an invoice has a label (the
 * NAV reconciliation and the uncertain submission too), amounts are money in the document's currency, a series is named,
 * internal ids are left out –, and a storno names its original as "Sztornózott számla" under the related documents, not as
 * the "1. módosítás" of an "Eredeti számla".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

function logOf(body: string): string {
  const start = body.indexOf('aria-labelledby="h-audit"');
  return body.slice(start, body.indexOf('</section>', start));
}

describe('the log of an invoice', () => {
  it('labels, money, the series name, no internal ids', async () => {
    const e = await startWeb();
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const inv = insertIssued(e.app, INVOICE_DOMESTIC);
    const audit = (action: string, details: Record<string, unknown>): void => {
      e.app.store.audit({ actor: 'system', action, entityType: action.startsWith('nav') ? 'nav' : 'invoice', entityId: inv.id, details });
    };
    audit('invoice.issue', { number: inv.number, gross: '194700', currency: 'HUF', seriesId: inv.seriesId });
    audit('invoice.payment', { number: inv.number, amount: '50000', date: '2026-10-28', paymentStatus: 'partial', proformaId: 'inv_00000000ff' });
    audit('nav.submit.uncertain', { number: inv.number, code: 'TIMEOUT' });
    audit('nav.reconcile', { number: inv.number, submission: 12, received: true, transactionId: 'TX-1', invoiceStatus: 'DONE' });
    audit('nav.reconcile', { number: inv.number, via: 'queryInvoiceData', match: 'similar', transactionId: 'TX-2', environment: 'production' });
    const b = await e.loggedIn();
    const log = logOf((await b.get(`/invoices/${inv.id}`)).body);
    expect(log).toContain(`<span class="muted">bruttó:</span> ${formatMoney('194700', 'HUF', 'hu')}`);
    expect(log).toContain(`<span class="muted">összeg:</span> ${formatMoney('50000', 'HUF', 'hu')}`);
    expect(log).toContain('<span class="muted">sorszámtartomány:</span> Számlák');
    expect(log).toContain('NAV-beküldés: bizonytalan eredmény');
    expect(log).toContain('Egyeztetés a NAV-val');
    expect(log).toContain('<span class="muted">megérkezett a NAV-hoz:</span> igen');
    expect(log).toContain('<span class="muted">mód:</span> a NAV-tól lekért számlaadat alapján');
    expect(log).toContain('<span class="muted">egyezés:</span> egyező kulcsadatok');
    expect(log).toContain('<span class="muted">környezet:</span> éles');
    for (const raw of [inv.seriesId, 'inv_00000000ff', 'submission', 'nav.reconcile', 'queryInvoiceData</']) expect(log, raw).not.toContain(raw);
  });
});

describe('related documents', () => {
  it('a storno names the invoice it cancelled, not a modification of it', async () => {
    const e = await startWeb();
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC);
    insertIssued(e.app, INVOICE_STORNO);
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000a4')).body;
    expect(page).toContain('Sztornózott számla: <a href="/invoices/inv_00000000a1">SZ-2026-00001</a></p>');
    expect(page).not.toContain('Eredeti számla: <a');
    expect(page).not.toContain('1. módosítás');
  });
});
