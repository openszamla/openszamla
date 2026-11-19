/**
 * When a draft's MNB rate is looked up again (MCP-9): the rate belongs to the fulfilment date and the
 * currency it was looked up for – its own date is the publication date, earlier on a weekend, a holiday
 * or before the 11:00 fixing. Only a change of the fulfilment date or the currency (or a rate that could
 * not be looked up before) asks MNB again; an unrelated edit keeps the stored rate without contacting
 * MNB, so an unreachable MNB never turns a ready draft into one without a rate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidationIssue } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);

interface FakeMnb {
  fetch: typeof fetch;
  /** "<currency> <endDate>" of every GetExchangeRates request, also the ones that failed. */
  requests: string[];
  /** currency → publication date → published rate ("366,52"); only days with a publication. */
  rates: Record<string, Record<string, string>>;
  down: boolean;
}

/** The MNB service: the publications of the requested currency in [startDate, endDate], or a network error when down. */
function fakeMnb(rates: FakeMnb['rates']): FakeMnb {
  const fake: FakeMnb = {
    requests: [],
    rates,
    down: false,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const param = (name: string): string => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? '';
      const [cur, from, to] = [param('currencyNames'), param('startDate'), param('endDate')];
      fake.requests.push(`${cur} ${to}`);
      if (fake.down) throw new TypeError('fetch failed');
      const days = Object.entries(fake.rates[cur] ?? {})
        .filter(([d]) => d >= from && d <= to)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([d, r]) => `&lt;Day date="${d}"&gt;&lt;Rate unit="1" curr="${cur}"&gt;${r}&lt;/Rate&gt;&lt;/Day&gt;`)
        .join('');
      const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;${days}&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    }) as typeof fetch,
  };
  return fake;
}

function setup(now: string, mnb: FakeMnb): { app: OpenSzamla; clock: { now: Date } } {
  const clock = { now: new Date(now) };
  t = makeTestApp({ now: () => clock.now, fetch: mnb.fetch });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, clock };
}

const EU_CUSTOMER = { vatStatus: 'OTHER' as const, name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } };
const CONSULTING = [{ description: 'Consulting', quantity: '1', unit: 'óra', unitPrice: '1000', vatCode: 'EUFAD37' as const }];
const rateOf = (inv: { exchangeRate: string; exchangeRateDate: string | null; exchangeRateSource: string | null }): unknown[] => [inv.exchangeRate, inv.exchangeRateDate, inv.exchangeRateSource];

describe('the MNB rate of a draft is looked up again only for a new fulfilment date or currency', () => {
  it('weekend fulfilment date: unrelated edits keep the rate without asking MNB, also while MNB is unreachable', async () => {
    // Sunday 2026-10-25; Friday 23 October was a holiday: the rate valid on the day is Thursday's.
    const mnb = fakeMnb({ EUR: { '2026-10-21': '365,28', '2026-10-22': '366,52' } });
    const { app } = setup('2026-10-25T09:00:00.000Z', mnb);
    const customerId = app.saveCustomer(EU_CUSTOMER).customer.id;
    const d = await app.createDraft({ customerId, currency: 'EUR', lines: CONSULTING });
    expect(d.invoice.fulfillmentDate).toBe('2026-10-25');
    expect(rateOf(d.invoice)).toEqual(['366.52', '2026-10-22', 'MNB']);
    expect(mnb.requests).toEqual(['EUR 2026-10-25']);

    const commented = await app.updateDraft(d.invoice.id, { comment: 'PO 4711' });
    expect(rateOf(commented.invoice)).toEqual(['366.52', '2026-10-22', 'MNB']);
    mnb.down = true;
    const ordered = await app.updateDraft(d.invoice.id, { orderNumber: '4711', lines: [{ ...CONSULTING[0]!, quantity: '2' }] });
    expect(rateOf(ordered.invoice)).toEqual(['366.52', '2026-10-22', 'MNB']);
    expect(ordered.readyToIssue, JSON.stringify(ordered.issues)).toBe(true);
    expect(codes(ordered.issues)).not.toContain('EXCHANGE_RATE_MISSING');
    // The same date and currency given again are no change either.
    const same = await app.updateDraft(d.invoice.id, { fulfillmentDate: '2026-10-25', currency: 'eur' });
    expect(rateOf(same.invoice)).toEqual(['366.52', '2026-10-22', 'MNB']);
    expect(mnb.requests).toEqual(['EUR 2026-10-25']);

    const issued = (await app.issue(d.invoice.id)).invoice;
    expect(rateOf(issued)).toEqual(['366.52', '2026-10-22', 'MNB']);
    expect(issued.totals.netAmountHuf).toBe('733040');
    expect(mnb.requests).toEqual(['EUR 2026-10-25']);
  });

  it('a new fulfilment date while MNB is unreachable drops the old day\'s rate (one EXCHANGE_RATE_MISSING); a later save looks it up', async () => {
    const mnb = fakeMnb({ EUR: { '2026-10-20': '363,03', '2026-10-22': '366,52' } });
    const { app } = setup('2026-10-25T09:00:00.000Z', mnb);
    const customerId = app.saveCustomer(EU_CUSTOMER).customer.id;
    const d = await app.createDraft({ customerId, currency: 'EUR', lines: CONSULTING });
    mnb.down = true;
    const moved = await app.updateDraft(d.invoice.id, { fulfillmentDate: '2026-10-20' });
    expect(rateOf(moved.invoice)).toEqual(['0', null, null]);
    expect(codes(moved.issues).filter((c) => c === 'EXCHANGE_RATE_MISSING')).toHaveLength(1);
    expect(moved.readyToIssue).toBe(false);
    mnb.down = false;
    const retried = await app.updateDraft(d.invoice.id, { comment: 'Újra' });
    expect(rateOf(retried.invoice)).toEqual(['363.03', '2026-10-20', 'MNB']);
    expect(retried.readyToIssue, JSON.stringify(retried.issues)).toBe(true);
    expect(mnb.requests).toEqual(['EUR 2026-10-25', 'EUR 2026-10-20', 'EUR 2026-10-20']);
  });

  it('before the 11:00 fixing: a later unrelated edit keeps the previous publication; the fulfilment date or the currency refreshes it', async () => {
    // Tuesday 2026-10-27, 09:00 in Budapest: the day's rates are not published yet.
    const mnb = fakeMnb({ EUR: { '2026-10-26': '366,95' }, USD: { '2026-10-26': '314,10' } });
    const { app, clock } = setup('2026-10-27T08:00:00.000Z', mnb);
    const customerId = app.saveCustomer(EU_CUSTOMER).customer.id;
    const d = await app.createDraft({ customerId, currency: 'EUR', lines: CONSULTING });
    expect(rateOf(d.invoice)).toEqual(['366.95', '2026-10-26', 'MNB']);

    // 14:00: MNB has published the day's rates by now.
    clock.now = new Date('2026-10-27T13:00:00.000Z');
    mnb.rates = { EUR: { '2026-10-26': '366,95', '2026-10-27': '367,14' }, USD: { '2026-10-26': '314,10', '2026-10-27': '315,20' } };
    const later = await app.updateDraft(d.invoice.id, { comment: 'Délután' });
    expect(rateOf(later.invoice)).toEqual(['366.95', '2026-10-26', 'MNB']);
    expect(mnb.requests).toEqual(['EUR 2026-10-27']);
    // Monday's publication is Monday's rate as it is.
    const monday = await app.updateDraft(d.invoice.id, { fulfillmentDate: '2026-10-26' });
    expect(rateOf(monday.invoice)).toEqual(['366.95', '2026-10-26', 'MNB']);
    expect(mnb.requests).toEqual(['EUR 2026-10-27']);
    const today = await app.updateDraft(d.invoice.id, { fulfillmentDate: '2026-10-27' });
    expect(rateOf(today.invoice)).toEqual(['367.14', '2026-10-27', 'MNB']);
    const usd = await app.updateDraft(d.invoice.id, { currency: 'USD' });
    expect(rateOf(usd.invoice)).toEqual(['315.2', '2026-10-27', 'MNB']);
    expect(mnb.requests).toEqual(['EUR 2026-10-27', 'EUR 2026-10-27', 'USD 2026-10-27']);
  });
});
