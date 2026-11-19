/**
 * The payment badge says what is to be paid: a cancelled invoice is "nem fizetendő (sztornózva)" – or, when something
 * was paid on it, "befizetve – sztornózva, visszajár" –, a withdrawn díjbekérő "nem fizetendő (visszavonva)", a credit
 * note (a modification with a negative payable amount) "jóváírás – nem fizetendő" – in the page head, the lists and the
 * payment part, which calls the amount "Eredetileg fizetendő" on a cancelled invoice and says what it means.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

function headOf(body: string): string {
  const start = body.indexOf('<div class="page-head">');
  return body.slice(start, body.indexOf('<section', start));
}

function payPartOf(body: string): string {
  const start = body.indexOf('aria-labelledby="h-pay"');
  return start < 0 ? '' : body.slice(start, body.indexOf('</section>', start));
}

function listRowOf(body: string, id: string): string {
  const at = body.indexOf(`href="/invoices/${id}"`);
  return at < 0 ? '' : body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at));
}

/** An issued fixture, then cancelled (the status is a mutable field of an issued document). */
function insertCancelled(e: WebEnv, fixture: Invoice, o: Partial<Invoice> = {}): void {
  const inv = insertIssued(e.app, fixture, o);
  e.app.store.patchInvoice(inv.id, { status: 'cancelled' });
}

describe('payment badges', () => {
  it('a cancelled invoice nothing was paid on: not to be paid, in the head, the list and the payment part', async () => {
    const e = await env();
    insertCancelled(e, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000a1')).body;
    expect(headOf(page)).toContain('nem fizetendő (sztornózva)</span>');
    expect(headOf(page)).not.toContain('fizetetlen');
    const pay = payPartOf(page);
    expect(pay).toContain('<dt>Eredetileg fizetendő</dt>');
    expect(pay).toContain('A számlát sztornózták, nem kell kifizetni.');
    expect(listRowOf((await b.get('/invoices')).body, 'inv_00000000a1')).toContain('nem fizetendő (sztornózva)</span>');
  });

  it('a cancelled invoice the buyer paid: paid, cancelled, to be paid back', async () => {
    const e = await env();
    insertCancelled(e, INVOICE_DOMESTIC, { paymentStatus: 'paid', paidAmount: INVOICE_DOMESTIC.totals.payableAmount, paidDate: '2026-10-20' });
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000a1')).body;
    expect(headOf(page)).toMatch(/<span class="badge b-warn">.*befizetve – sztornózva, visszajár<\/span>/);
    expect(payPartOf(page)).toContain('A számlát sztornózták: a befizetett összeg a vevőnek visszajár, vagy a helyette kiállított számlába beszámítható.');
  });

  it('a withdrawn díjbekérő and a credit note', async () => {
    const e = await env();
    insertCancelled(e, INVOICE_DOMESTIC, { id: 'inv_00000000f9', number: 'DB-2026-00001', documentType: 'proforma', navStatus: 'not_applicable' });
    const credit = {
      ...INVOICE_DOMESTIC,
      id: 'inv_00000000e5',
      number: 'SZ-2026-00005',
      documentType: 'modification' as const,
      reference: { originalInvoiceId: 'inv_00000000a1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false },
      totals: { ...INVOICE_DOMESTIC.totals, netAmount: '-10000', vatAmount: '-2700', grossAmount: '-12700', payableAmount: '-12700', netAmountHuf: '-10000', vatAmountHuf: '-2700', grossAmountHuf: '-12700' },
    };
    insertIssued(e.app, INVOICE_DOMESTIC);
    insertIssued(e.app, credit, { paymentStatus: 'paid' });
    const b = await e.loggedIn();
    const proforma = (await b.get('/invoices/inv_00000000f9')).body;
    expect(headOf(proforma)).toContain('nem fizetendő (visszavonva)</span>');
    expect(payPartOf(proforma)).toContain('A díjbekérőt visszavonták, nem kell kifizetni.');
    const note = (await b.get('/invoices/inv_00000000e5')).body;
    expect(headOf(note)).toContain('jóváírás – nem fizetendő</span>');
    expect(headOf(note)).not.toContain('>fizetve</span>');
    expect(listRowOf((await b.get('/invoices')).body, 'inv_00000000e5')).toContain('jóváírás – nem fizetendő</span>');
  });
});
