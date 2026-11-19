/**
 * The fulfilment date of a correction chain (TAX-2): once a modification corrected the teljesítés
 * dátuma, later modifications and the storno carry the corrected date – NAV compares them with the date
 * of the last modifying document (spec 3.45.1, WARN 11400/11401) – while the exchange rate stays the
 * original's. Chains without a date correction keep the original's date.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);

function setup(opts: { fetch?: typeof fetch } = {}): { app: OpenSzamla; clock: { now: Date } } {
  const clock = { now: new Date('2026-10-16T09:00:00.000Z') };
  t = makeTestApp({ now: () => clock.now, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, clock };
}

/** invoiceDeliveryDate of the NAV invoiceData, after checking the XML against the XSD. */
async function navDeliveryDate(inv: Invoice): Promise<string | undefined> {
  const xml = buildInvoiceDataXml(inv);
  expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
  return /<invoiceDeliveryDate>([^<]*)<\/invoiceDeliveryDate>/.exec(xml)?.[1];
}

const reduction = [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-20000', vatCode: '27' as const }];
const dateFix = [{ description: 'Teljesítési dátum javítása: 2026-11-03', quantity: '1', unit: 'db', unitPrice: '0', vatCode: '27' as const }];

/** Invoice SZ-2026-00001 with the wrong fulfilment date 2026-10-15, then SZ-2026-00002 correcting it to 2026-11-03. */
async function withDateFix(app: OpenSzamla, clock: { now: Date }, extra: Record<string, unknown> = {}) {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, fulfillmentDate: '2026-10-15', lines: [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' }], ...extra });
  const original = (await app.issue(d.invoice.id)).invoice;
  clock.now = new Date('2026-11-05T09:00:00.000Z');
  const fix = await app.createCorrectionDraft(original.id, { lines: dateFix, fulfillmentDate: '2026-11-03', comment: 'A teljesítés dátuma helyesen 2026-11-03.' });
  expect(codes(fix.issues)).toContain('MODIFICATION_FULFILLMENT_DATE');
  const fixed = (await app.issue(fix.invoice.id)).invoice;
  expect(fixed.fulfillmentDate).toBe('2026-11-03');
  return { original, fixed };
}

describe('the current fulfilment date of a correction chain', () => {
  it('a later modification and the storno take the corrected date, and NAV receives it', async () => {
    const { app, clock } = setup();
    const { original, fixed } = await withDateFix(app, clock);

    const later = await app.createCorrectionDraft(original.id, { lines: reduction, comment: 'Utólagos árengedmény' });
    expect(later.invoice.fulfillmentDate).toBe('2026-11-03');
    expect(codes(later.issues)).not.toContain('MODIFICATION_FULFILLMENT_DATE');
    // The corrected date given explicitly is no date change either.
    const explicit = await app.updateDraft(later.invoice.id, { fulfillmentDate: '2026-11-03' });
    expect(codes(explicit.issues)).not.toContain('MODIFICATION_FULFILLMENT_DATE');
    // Going back to the old date is a date change again – the warning names the current date and its source.
    const back = await app.updateDraft(later.invoice.id, { fulfillmentDate: '2026-10-15' });
    const warning = back.issues.find((i) => i.code === 'MODIFICATION_FULFILLMENT_DATE');
    expect(warning?.message).toContain(`a számla aktuális teljesítési dátuma: 2026-11-03 (a(z) ${fixed.number} módosító számla szerint)`);
    await app.updateDraft(later.invoice.id, { fulfillmentDate: '2026-11-03' });
    const mod = (await app.issue(later.invoice.id)).invoice;
    expect(mod.fulfillmentDate).toBe('2026-11-03');
    expect(await navDeliveryDate(mod)).toBe('2026-11-03');

    const preview = app.stornoPreview(original.id, 'Téves számla');
    expect(preview.storno.fulfillmentDate).toBe('2026-11-03');
    expect(codes(preview.issues)).not.toContain('STORNO_FULFILLMENT_DATE');
    const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
    expect(storno.fulfillmentDate).toBe('2026-11-03');
    expect(await navDeliveryDate(storno)).toBe('2026-11-03');
  });

  it('a storno right after the date fix takes the corrected date', async () => {
    const { app, clock } = setup();
    const { original } = await withDateFix(app, clock);
    const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
    expect(storno.fulfillmentDate).toBe('2026-11-03');
    expect(await navDeliveryDate(storno)).toBe('2026-11-03');
  });

  it('without a date correction the modification and the storno keep the original date', async () => {
    const { app, clock } = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, fulfillmentDate: '2026-10-15', lines: [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' }] });
    const original = (await app.issue(d.invoice.id)).invoice;
    clock.now = new Date('2026-11-05T09:00:00.000Z');
    const corr = await app.createCorrectionDraft(original.id, { lines: reduction, comment: 'Utólagos árengedmény' });
    expect(corr.invoice.fulfillmentDate).toBe('2026-10-15');
    expect(codes(corr.issues)).not.toContain('MODIFICATION_FULFILLMENT_DATE');
    const mod = (await app.issue(corr.invoice.id)).invoice;
    expect(await navDeliveryDate(mod)).toBe('2026-10-15');
    // A date in another month than the original's is still a date change.
    const moved = await app.createCorrectionDraft(original.id, { lines: reduction, fulfillmentDate: '2026-11-04', comment: 'Utólagos árengedmény' });
    expect(moved.issues.find((i) => i.code === 'MODIFICATION_FULFILLMENT_DATE')?.message).toContain('a számla aktuális teljesítési dátuma: 2026-10-15 (az eredeti számla szerint)');
    app.deleteDraft(moved.invoice.id);
    const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
    expect(storno.fulfillmentDate).toBe('2026-10-15');
    expect(await navDeliveryDate(storno)).toBe('2026-10-15');
  });

  it('foreign currency: the corrected date never fetches a new MNB rate – the chain keeps the original rate', async () => {
    let calls = 0;
    const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="2026-10-15"&gt;&lt;Rate unit="1" curr="EUR"&gt;390,00&lt;/Rate&gt;&lt;/Day&gt;&lt;Day date="2026-11-03"&gt;&lt;Rate unit="1" curr="EUR"&gt;401,00&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
    const fetchMock = (async () => {
      calls++;
      return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    }) as unknown as typeof fetch;
    const { app, clock } = setup({ fetch: fetchMock });
    const { original, fixed } = await withDateFix(app, clock, { currency: 'EUR', lines: [{ description: 'Maintenance', quantity: '1', unit: 'db', unitPrice: '500', vatCode: '27' }] });
    expect(original.exchangeRate).toBe('390');
    expect(fixed.exchangeRate).toBe('390');
    const fetched = calls;

    const later = await app.createCorrectionDraft(original.id, { lines: [{ description: 'Discount', quantity: '1', unit: 'db', unitPrice: '-50', vatCode: '27' }], comment: 'Discount' });
    expect([later.invoice.fulfillmentDate, later.invoice.exchangeRate, later.invoice.exchangeRateDate]).toEqual(['2026-11-03', '390', original.exchangeRateDate]);
    const mod = (await app.issue(later.invoice.id)).invoice;
    expect(mod.exchangeRate).toBe('390');
    const storno = (await app.cancel(original.id, { reason: 'Téves számla' })).invoice;
    expect([storno.fulfillmentDate, storno.exchangeRate]).toEqual(['2026-11-03', '390']);
    expect(calls).toBe(fetched);
    expect(await navDeliveryDate(storno)).toBe('2026-11-03');
  });
});
