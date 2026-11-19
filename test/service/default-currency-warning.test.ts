/**
 * A new draft without a currency gets the seller's default currency (MCP-7). When that default is not HUF,
 * the creation response says so once (DEFAULT_CURRENCY_APPLIED): "15 000 Ft + ÁFA" must not silently become
 * a 15 000 EUR line. No warning when the currency was given, came from a copied document, or a line is
 * priced by a product (whose price is in the invoice currency – otherwise CURRENCY_MISMATCH).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidationIssue } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const warned = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter((i) => i.code === 'DEFAULT_CURRENCY_APPLIED');

/** MNB: EUR 390,12 published on 2026-10-26. */
const mnb = (async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="2026-10-26"&gt;&lt;Rate unit="1" curr="EUR"&gt;390,12&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
  return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}) as unknown as typeof fetch;

function setup(defaults: Parameters<OpenSzamla['updateDefaults']>[0]): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ fetch: mnb });
  t.app.updateSeller(SELLER_INPUT);
  t.app.updateDefaults(defaults);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

const DEVELOPMENT = [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];

describe('a non-HUF default currency applied to a new draft is announced once', () => {
  it('no currency given, default EUR: a warning on creation only; the draft is an EUR draft with the other defaults', async () => {
    const { app, customerId } = setup({ currency: 'EUR', appearance: 'PAPER', language: 'hu-en' });
    const d = await app.createDraft({ customerId, lines: DEVELOPMENT });
    expect([d.invoice.currency, d.invoice.appearance, d.invoice.language]).toEqual(['EUR', 'PAPER', 'hu-en']);
    expect(warned(d.issues)).toEqual([{
      severity: 'warning',
      code: 'DEFAULT_CURRENCY_APPLIED',
      field: 'currency',
      message: 'A pénznem az eladó alapértelmezése: EUR. A pénznem nem volt megadva, ezért a megadott egységárak is ebben a pénznemben értendők; ha a számla más pénznemben (pl. forintban) szól, add meg a pénznemet (currency).',
    }]);
    expect(d.readyToIssue, JSON.stringify(d.issues)).toBe(true);
    expect(warned(app.viewInvoice(d.invoice.id).issues)).toEqual([]);
    expect(warned((await app.updateDraft(d.invoice.id, { comment: 'Október' })).issues)).toEqual([]);
    // The fix the warning points to.
    const huf = await app.updateDraft(d.invoice.id, { currency: 'HUF' });
    expect([huf.invoice.currency, huf.invoice.totals.grossAmount]).toEqual(['HUF', '190500']);
  });

  it('no warning when the currency is given, the default is HUF, or the currency comes from a copied document', async () => {
    const { app, customerId } = setup({ currency: 'EUR' });
    expect(warned((await app.createDraft({ customerId, currency: 'EUR', lines: DEVELOPMENT })).issues)).toEqual([]);
    expect(warned((await app.createDraft({ customerId, currency: 'HUF', lines: DEVELOPMENT })).issues)).toEqual([]);
    const huf = await app.issue((await app.createDraft({ customerId, currency: 'HUF', lines: DEVELOPMENT })).invoice.id);
    const copy = await app.createDraft({ copyFromId: huf.invoice.id });
    expect(copy.invoice.currency).toBe('HUF');
    expect(warned(copy.issues)).toEqual([]);
    app.updateDefaults({ currency: 'HUF' });
    expect(warned((await app.createDraft({ customerId, lines: DEVELOPMENT })).issues)).toEqual([]);
  });

  it('a line priced by a product decides the currency; a product line with its own unit price does not; CURRENCY_MISMATCH stays', async () => {
    const { app, customerId } = setup({ currency: 'EUR' });
    const eurProduct = app.saveProduct({ name: 'Support (EUR)', unit: 'óra', unitPrice: '80', currency: 'EUR', vatCode: '27' });
    const hufProduct = app.saveProduct({ name: 'Támogatás', unit: 'óra', unitPrice: '25000', vatCode: '27' });
    const priced = await app.createDraft({ customerId, lines: [{ productId: eurProduct.id, quantity: '3' }] });
    expect([priced.invoice.currency, priced.invoice.totals.netAmount]).toEqual(['EUR', '240']);
    expect(warned(priced.issues)).toEqual([]);
    const ownPrice = await app.createDraft({ customerId, lines: [{ productId: hufProduct.id, quantity: '3', unitPrice: '15000' }] });
    expect(warned(ownPrice.issues)).toHaveLength(1);
    await expect(app.createDraft({ customerId, lines: [{ productId: hufProduct.id, quantity: '3' }] })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });
});
