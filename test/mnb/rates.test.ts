/**
 * MnbClient against recorded replies of the real MNB service (test/fixtures/mnb/, recorded on
 * 2026-10-27) and hand-made variants of them. Friday 2026-10-23 was a national holiday, so the
 * last publication before the weekend of 24–25 October is Thursday 2026-10-22.
 */
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { MnbClient } from '../../src/mnb/rates.ts';
import type { MnbClientOptions } from '../../src/mnb/rates.ts';

const FIXTURES = new URL('../fixtures/mnb/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

const EUR_HOLIDAY = fixture('GetExchangeRates_EUR_2026-10-09_2026-10-23.xml');
const EUR_SUNDAY = fixture('GetExchangeRates_EUR_2026-10-11_2026-10-25.xml');
const EUR_MONDAY = fixture('GetExchangeRates_EUR_2026-10-12_2026-10-26.xml');
const EUR_TODAY = fixture('GetExchangeRates_EUR_2026-10-13_2026-10-27.xml');
const EUR_TOMORROW = fixture('GetExchangeRates_EUR_2026-10-14_2026-10-28.xml');
const EUR_FUTURE = fixture('GetExchangeRates_EUR_2026-11-20_2026-12-04.xml');
const EUR_CHRISTMAS = fixture('GetExchangeRates_EUR_2025-12-14_2025-12-28.xml');
const JPY_SUNDAY = fixture('GetExchangeRates_JPY_2026-10-11_2026-10-25.xml');
const XYZ_SUNDAY = fixture('GetExchangeRates_XYZ_2026-10-11_2026-10-25.xml');
const USD_BEFORE_1949 = fixture('GetExchangeRates_USD_1948-12-19_1949-01-02.xml');
const GRD_ZERO_LAST = fixture('GetExchangeRates_GRD_1988-05-13_1988-05-27.xml');
const GRD_ZERO_INSIDE = fixture('GetExchangeRates_GRD_1988-05-18_1988-06-01.xml');
const CURRENT = fixture('GetCurrentExchangeRates_2026-10-27.xml');
const FAULT = fixture('Fault_GetExchangeRates_invalid-date.xml');

const EUR_SUNDAY_KEY = 'GetExchangeRates EUR 2026-10-11 2026-10-25';
/** 2026-10-27 14:00 in Budapest (CET, UTC+1): after MNB's publication of the day (recording time of the fixtures). */
const AT_RECORDING = (): Date => new Date('2026-10-27T13:00:00Z');

// ---------------------------------------------------------------------------------------------
// Fake MNB service
// ---------------------------------------------------------------------------------------------

type Route = string | { status?: number; body: string; contentType?: string };

interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
  signal: AbortSignal | null | undefined;
  /** "<Operation> [currencyNames startDate endDate]" */
  key: string;
}

/** Answers "<Operation> [currencyNames startDate endDate]" with the given reply; records requests. */
function fakeMnb(routes: Record<string, Route>): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const param = (name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
    const operation = /<soap:Body><(\w+)/.exec(body)?.[1] ?? '?';
    const key = [operation, param('currencyNames'), param('startDate'), param('endDate')].filter((p) => p !== undefined).join(' ');
    requests.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body, signal: init?.signal, key });
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected MNB request: ${key}`);
    const reply = typeof route === 'string' ? { body: route } : route;
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': reply.contentType ?? 'text/xml; charset=utf-8' },
    });
  };
  return { fetch: fetchFn, requests };
}

/** Rewrites the (still escaped) text of the <…Result> element of a recorded reply. */
function mapResult(reply: string, fn: (escaped: string) => string): string {
  const m = /(<(\w+Result)>)([\s\S]*?)(<\/\2>)/.exec(reply);
  if (!m) throw new Error('no Result element in fixture');
  return reply.replace(m[0], `${m[1]}${fn(m[3] ?? '')}${m[4]}`);
}

function single<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected the promise to reject');
}

/** A client talking to the fake MNB; its clock stands at the recording time unless `opts.now` says otherwise. */
function client(routes: Record<string, Route>, opts: Omit<MnbClientOptions, 'fetch'> = {}): { mnb: MnbClient; requests: RecordedRequest[] } {
  const fake = fakeMnb(routes);
  return { mnb: new MnbClient({ now: AT_RECORDING, ...opts, fetch: fake.fetch }), requests: fake.requests };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------

describe('MnbClient.getRate – recorded MNB replies', () => {
  it('posts a SOAP 1.1 GetExchangeRates request for [date − 14 days, date] to the HTTP endpoint', async () => {
    const { mnb, requests } = client({ [EUR_SUNDAY_KEY]: EUR_SUNDAY });
    await mnb.getRate('EUR', '2026-10-25');

    const req = single(requests);
    expect(req.url).toBe('http://www.mnb.hu/arfolyamok.asmx');
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(req.headers.get('soapaction')).toBe('"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetExchangeRates"');
    expect(req.signal).toBeInstanceOf(AbortSignal);

    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(req.body);
    expect(parsed['soap:Envelope']['@_xmlns:soap']).toBe('http://schemas.xmlsoap.org/soap/envelope/');
    expect(parsed['soap:Envelope']['soap:Body'].GetExchangeRates).toEqual({
      '@_xmlns': 'http://www.mnb.hu/webservices/',
      startDate: '2026-10-11',
      endDate: '2026-10-25',
      currencyNames: 'EUR',
    });
  });

  it('returns the publication of the requested day itself', async () => {
    const { mnb } = client({ 'GetExchangeRates EUR 2026-10-13 2026-10-27': EUR_TODAY });
    expect(await mnb.getRate('EUR', '2026-10-27')).toEqual({
      currency: 'EUR',
      date: '2026-10-27',
      rate: '367.14',
      unit: 1,
      publishedRate: '367.14',
    });
  });

  it.each([
    ['the Friday national holiday 2026-10-23', '2026-10-23', 'GetExchangeRates EUR 2026-10-09 2026-10-23', EUR_HOLIDAY, '2026-10-22', '366.52'],
    ['Saturday-Sunday after it (2026-10-25)', '2026-10-25', EUR_SUNDAY_KEY, EUR_SUNDAY, '2026-10-22', '366.52'],
    ['the next working day (2026-10-26)', '2026-10-26', 'GetExchangeRates EUR 2026-10-12 2026-10-26', EUR_MONDAY, '2026-10-26', '366.95'],
    // The longest gap since 1990: no publication from 24 to 28 December 2025.
    ['the Sunday after Christmas (2025-12-28)', '2025-12-28', 'GetExchangeRates EUR 2025-12-14 2025-12-28', EUR_CHRISTMAS, '2025-12-23', '391.19'],
  ])('on %s it uses the latest publication on or before the date', async (_label, date, key, reply, expectedDate, expectedRate) => {
    const { mnb } = client({ [key]: reply });
    const r = await mnb.getRate('EUR', date);
    expect(r).toEqual({ currency: 'EUR', date: expectedDate, rate: expectedRate, unit: 1, publishedRate: expectedRate });
    expect(r.date <= date).toBe(true);
  });

  it('normalises JPY, published per 100 units, to HUF per 1 JPY', async () => {
    const { mnb } = client({ 'GetExchangeRates JPY 2026-10-11 2026-10-25': JPY_SUNDAY });
    expect(await mnb.getRate('JPY', '2026-10-25')).toEqual({
      currency: 'JPY',
      date: '2026-10-22',
      rate: '2.0776',
      unit: 100,
      publishedRate: '207.76',
    });
  });

  it.each([
    ['366,52000', '1', '366.52', '366.52'],
    ['367,14', '1', '367.14', '367.14'],
    ['42', '1', '42', '42'],
    ['1234,5678', '1', '1234.5678', '1234.5678'],
    ['24,83', '100', '24.83', '0.2483'],
    ['1,1', '100', '1.1', '0.011'], // in floating point 1.1 / 100 = 0.011000000000000001
    ['0,07', '1000', '0.07', '0.00007'],
  ])('parses the decimal comma exactly: %s per %s unit(s)', async (published, unit, publishedRate, rate) => {
    const reply = mapResult(EUR_SUNDAY, (s) => s.replace('unit="1" curr="EUR"&gt;366,52000', `unit="${unit}" curr="EUR"&gt;${published}`));
    const { mnb } = client({ [EUR_SUNDAY_KEY]: reply });
    expect(await mnb.getRate('EUR', '2026-10-25')).toEqual({ currency: 'EUR', date: '2026-10-22', rate, unit: Number(unit), publishedRate });
  });

  it('accepts lower-case and padded currency codes (MNB itself is case-sensitive)', async () => {
    const { mnb, requests } = client({ [EUR_SUNDAY_KEY]: EUR_SUNDAY });
    expect((await mnb.getRate(' eur ', '2026-10-25')).currency).toBe('EUR');
    expect(single(requests).key).toBe(EUR_SUNDAY_KEY);
  });

  it('answers HUF with 1 without calling MNB', async () => {
    const { mnb, requests } = client({});
    expect(await mnb.getRate('huf', '2026-10-25')).toEqual({ currency: 'HUF', date: '2026-10-25', rate: '1', unit: 1, publishedRate: '1' });
    expect(requests).toHaveLength(0);
  });

  it('rejects malformed currency codes and dates before calling MNB', async () => {
    const { mnb, requests } = client({});
    for (const currency of ['EURO', 'E1R', '', 'EUR,USD', '<x>']) {
      expect((await rejection(mnb.getRate(currency, '2026-10-25'))).code).toBe('INVALID_CURRENCY');
    }
    for (const date of ['2026-02-30', '2026/10/25', '25.10.2026', '']) {
      expect((await rejection(mnb.getRate('EUR', date))).code).toBe('INVALID_DATE');
    }
    expect(requests).toHaveLength(0);
  });

  it('MNB_RATE_NOT_FOUND for a currency MNB does not quote (recorded reply for XYZ)', async () => {
    const { mnb } = client({ 'GetExchangeRates XYZ 2026-10-11 2026-10-25': XYZ_SUNDAY });
    const err = await rejection(mnb.getRate('XYZ', '2026-10-25'));
    expect(err.code).toBe('MNB_RATE_NOT_FOUND');
    expect(err.message).toBe('Az MNB 2026-10-11 és 2026-10-25 között nem tett közzé XYZ árfolyamot.');
    expect(err.hint).toContain('devizakód');
    expect(err.details).toEqual({ currency: 'XYZ', date: '2026-10-25', searchedFrom: '2026-10-11', searchedTo: '2026-10-25' });
  });

  it('MNB_RATE_NOT_FOUND when nothing was published in the window (recorded blank document before 1949-01-03)', async () => {
    const { mnb } = client({ 'GetExchangeRates USD 1948-12-19 1949-01-02': USD_BEFORE_1949 });
    const err = await rejection(mnb.getRate('USD', '1949-01-02'));
    expect(err.code).toBe('MNB_RATE_NOT_FOUND');
    expect(err.message).toBe('Az MNB 1948-12-19 és 1949-01-02 között nem tett közzé árfolyamot.');
    expect(err.hint).toContain('1949-01-03');
    expect(err.hint).toContain('14 napra');
    expect(err.details).toEqual({ currency: 'USD', date: '1949-01-02', searchedFrom: '1948-12-19', searchedTo: '1949-01-02' });
  });

  it('MNB_RATE_NOT_FOUND for a blank document even when the local clock runs ahead (recorded future window)', async () => {
    // This machine believes it is 2026-12-04; MNB (recorded on 2026-10-27) has nothing for the window.
    const { mnb, requests } = client({ 'GetExchangeRates EUR 2026-11-20 2026-12-04': EUR_FUTURE }, { now: () => new Date('2026-12-04T12:00:00Z') });
    const err = await rejection(mnb.getRate('EUR', '2026-12-04'));
    expect(err.code).toBe('MNB_RATE_NOT_FOUND');
    expect(err.message).toBe('Az MNB 2026-11-20 és 2026-12-04 között nem tett közzé árfolyamot.');
    expect(requests).toHaveLength(1);
  });

  // Regression: "0,00" (MNB's placeholder for a missing quotation) used to fail the whole reply with
  // MNB_BAD_RESPONSE, so no GRD/YUD rate could be had for 1988-05-27 … 1988-06-10.
  it('skips the "0,00" placeholder of a missing quotation and uses the last real rate (recorded GRD 1988-05-27)', async () => {
    const { mnb } = client({ 'GetExchangeRates GRD 1988-05-13 1988-05-27': GRD_ZERO_LAST });
    expect(await mnb.getRate('GRD', '1988-05-27')).toEqual({ currency: 'GRD', date: '1988-05-26', rate: '0.3532', unit: 100, publishedRate: '35.32' });
  });

  it('a "0,00" placeholder earlier in the window does not spoil the reply (recorded GRD window with duplicate Day elements)', async () => {
    const { mnb } = client({ 'GetExchangeRates GRD 1988-05-18 1988-06-01': GRD_ZERO_INSIDE });
    expect(await mnb.getRate('GRD', '1988-06-01')).toEqual({ currency: 'GRD', date: '1988-06-01', rate: '0.3525', unit: 100, publishedRate: '35.25' });
  });

  it('MNB_RATE_NOT_FOUND when the currency only has "0,00" placeholders in the window', async () => {
    const reply = mapResult(EUR_SUNDAY, (s) => s.replace(/&gt;[\d,]+&lt;\/Rate&gt;/g, '&gt;0,00&lt;/Rate&gt;'));
    const { mnb } = client({ [EUR_SUNDAY_KEY]: reply });
    const err = await rejection(mnb.getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_RATE_NOT_FOUND');
    expect(err.message).toBe('Az MNB 2026-10-11 és 2026-10-25 között nem tett közzé EUR árfolyamot.');
  });

  it('never returns a rate published after the requested date', async () => {
    // A reply that (unlike the real service) also contains 2026-10-27 for a window ending 2026-10-26.
    const { mnb } = client({ 'GetExchangeRates EUR 2026-10-12 2026-10-26': EUR_TODAY });
    expect(await mnb.getRate('EUR', '2026-10-26')).toMatchObject({ date: '2026-10-26', rate: '366.95' });
  });

  it.each([
    ['character references', (s: string) => s.replaceAll('&lt;', '&#60;').replaceAll('&gt;', '&#x3E;')],
    ['escaped attribute quotes', (s: string) => s.replaceAll('"', '&quot;')],
    ['a CDATA section instead of escaping', (s: string) => `<![CDATA[${s.replaceAll('&lt;', '<').replaceAll('&gt;', '>')}]]>`],
  ])('unescapes the embedded document properly: %s', async (_label, transform) => {
    const { mnb } = client({ [EUR_SUNDAY_KEY]: mapResult(EUR_SUNDAY, transform) });
    expect(await mnb.getRate('EUR', '2026-10-25')).toEqual({ currency: 'EUR', date: '2026-10-22', rate: '366.52', unit: 1, publishedRate: '366.52' });
  });
});

// Áfa tv. 80. § (2): the rate is the last one valid at the relevant time. Nobody knows that for a day that
// has not come yet. Regression: a date up to 14 days ahead used to get today's rate (silently, as if it
// were the official rate of that day), while a date 15+ days ahead was MNB_RATE_NOT_FOUND.
describe('MnbClient.getRate – today and future dates', () => {
  it.each([
    ['tomorrow', '2026-10-28'],
    ['a Saturday', '2026-10-31'],
    ['14 days ahead (the window would still have contained today)', '2026-11-10'],
    ['15 days ahead', '2026-11-11'],
    ['next year', '2027-03-15'],
  ])('MNB_RATE_NOT_FOUND for %s without asking MNB', async (_label, date) => {
    const { mnb, requests } = client({}, { now: AT_RECORDING });
    const err = await rejection(mnb.getRate('EUR', date));
    expect(err.code).toBe('MNB_RATE_NOT_FOUND');
    expect(err.message).toBe(`Az MNB még nem tett közzé EUR árfolyamot a(z) ${date} napra: a dátum a jövőben van (ma 2026-10-27 van).`);
    expect(err.hint).toContain('kézzel');
    expect(err.details).toEqual({ currency: 'EUR', date, today: '2026-10-27' });
    expect(requests).toHaveLength(0);
  });

  it('today is allowed and gives the publication of the day once MNB has published it', async () => {
    const { mnb } = client({ 'GetExchangeRates EUR 2026-10-13 2026-10-27': EUR_TODAY }, { now: AT_RECORDING });
    expect(await mnb.getRate('EUR', '2026-10-27')).toMatchObject({ date: '2026-10-27', rate: '367.14' });
  });

  it('"today" is the calendar day in Budapest, not in UTC', async () => {
    // 2026-10-27 23:30 UTC is already 2026-10-28 00:30 in Budapest: the 27th's rate is valid until MNB publishes at 11:00.
    const afterMidnight = client({ 'GetExchangeRates EUR 2026-10-14 2026-10-28': EUR_TOMORROW }, { now: () => new Date('2026-10-27T23:30:00Z') });
    expect(await afterMidnight.mnb.getRate('EUR', '2026-10-28')).toEqual({ currency: 'EUR', date: '2026-10-27', rate: '367.14', unit: 1, publishedRate: '367.14' });
    // 22:59:59 UTC is still 23:59:59 on the 27th in Budapest: the 28th is in the future.
    const beforeMidnight = client({}, { now: () => new Date('2026-10-27T22:59:59Z') });
    expect((await rejection(beforeMidnight.mnb.getRate('EUR', '2026-10-28'))).code).toBe('MNB_RATE_NOT_FOUND');
    expect(beforeMidnight.requests).toHaveLength(0);
  });

  it('HUF is 1 for any date, future ones included', async () => {
    const { mnb, requests } = client({}, { now: AT_RECORDING });
    expect(await mnb.getRate('HUF', '2027-01-01')).toEqual({ currency: 'HUF', date: '2027-01-01', rate: '1', unit: 1, publishedRate: '1' });
    expect(requests).toHaveLength(0);
  });

  it('uses the system clock when no clock is given', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-02-01T10:00:00Z'));
    const fake = fakeMnb({});
    const err = await rejection(new MnbClient({ fetch: fake.fetch }).getRate('EUR', '2027-02-02'));
    expect(err.details).toEqual({ currency: 'EUR', date: '2027-02-02', today: '2027-02-01' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('MnbClient – failures', () => {
  it('MNB_UNAVAILABLE on network errors', async () => {
    const failing: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.mnb.hu'), { code: 'ENOTFOUND' }) }));
    const err = await rejection(new MnbClient({ fetch: failing, now: AT_RECORDING }).getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_UNAVAILABLE');
    expect(err.message).toBe('Nem sikerült elérni az MNB árfolyam-szolgáltatását: fetch failed (getaddrinfo ENOTFOUND www.mnb.hu)');
    expect(err.hint).toContain('http://www.mnb.hu/arfolyamok.asmx');
    expect(err.details).toMatchObject({ operation: 'GetExchangeRates', endpoint: 'http://www.mnb.hu/arfolyamok.asmx' });
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('MNB_UNAVAILABLE when the timeout aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
    const started = Date.now();
    const err = await rejection(new MnbClient({ fetch: hanging, timeoutMs: 50, now: AT_RECORDING }).getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_UNAVAILABLE');
    expect(err.message).toBe('Az MNB árfolyam-szolgáltatása nem válaszolt 0,05 másodpercen belül.');
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the default timeout is 10 seconds', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
    const settled = new MnbClient({ fetch: hanging, now: AT_RECORDING }).getRate('EUR', '2026-10-25').then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('MNB_UNAVAILABLE');
    expect(signal?.aborted).toBe(true);
  });

  it('MNB_UNAVAILABLE with the fault text on a SOAP fault (recorded HTTP 500 reply)', async () => {
    const { mnb } = client({ [EUR_SUNDAY_KEY]: { status: 500, body: FAULT } });
    const err = await rejection(mnb.getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_UNAVAILABLE');
    expect(err.message).toBe(
      'Az MNB árfolyam-szolgáltatása hibát jelzett (HTTP 500): Year, Month, and Day parameters describe an un-representable DateTime.',
    );
    expect(err.details).toMatchObject({ httpStatus: 500, faultCode: 'a:InternalServiceFault' });
  });

  it.each([
    ['the empty 404 that https://www.mnb.hu gives to SOAP calls', 404, '', 'Ellenőrizd a végpontot'],
    ['a 503 maintenance page', 503, '<html><body>Karbantartás</body></html>', 'átmeneti hiba'],
  ])('MNB_UNAVAILABLE on HTTP errors: %s', async (_label, status, body, hint) => {
    const { mnb } = client({ [EUR_SUNDAY_KEY]: { status, body, contentType: 'text/html' } });
    const err = await rejection(mnb.getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_UNAVAILABLE');
    expect(err.message).toBe(`Az MNB árfolyam-szolgáltatása hibával válaszolt (HTTP ${status}).`);
    expect(err.hint).toContain(hint);
    expect(err.details).toMatchObject({ httpStatus: status });
  });

  const dayOf22 = '&lt;Day date="2026-10-22"&gt;&lt;Rate unit="1" curr="EUR"&gt;366,52000&lt;/Rate&gt;&lt;/Day&gt;';
  it.each([
    ['an HTML page with HTTP 200', '<!DOCTYPE html><html><body><h1>Request Rejected</h1></body></html>'],
    ['an empty body', ''],
    ['a truncated reply', EUR_SUNDAY.slice(0, EUR_SUNDAY.indexOf('366,52') + 5)],
    ['no GetExchangeRatesResult element', EUR_SUNDAY.replace(/<GetExchangeRatesResult>[\s\S]*<\/GetExchangeRatesResult>/, '')],
    // Regression: an empty result used to be read as "nothing published" (MNB_RATE_NOT_FOUND, "check the
    // currency/date") although MNB's no-data answer is <MNBExchangeRates />, never an empty string.
    ['an empty GetExchangeRatesResult', mapResult(EUR_SUNDAY, () => '')],
    ['a nil GetExchangeRatesResult', EUR_SUNDAY.replace(/<GetExchangeRatesResult>[\s\S]*<\/GetExchangeRatesResult>/, '<GetExchangeRatesResult i:nil="true" />')],
    ['a result that is not an XML document', mapResult(EUR_SUNDAY, () => 'Hiba történt')],
    ['a double-escaped document', mapResult(EUR_SUNDAY, (s) => s.replaceAll('&', '&amp;'))],
    ['broken embedded XML', mapResult(EUR_SUNDAY, (s) => s.replace('&lt;/Rate&gt;', ''))],
    ['an unexpected root element', mapResult(EUR_SUNDAY, (s) => s.replaceAll('MNBExchangeRates', 'MNBRates'))],
    ['a decimal point instead of the decimal comma', mapResult(EUR_SUNDAY, (s) => s.replace('366,52000', '366.52000'))],
    ['a thousands separator', mapResult(EUR_SUNDAY, (s) => s.replace('366,52000', '1.366,52'))],
    ['an empty rate', mapResult(EUR_SUNDAY, (s) => s.replace('366,52000', ''))],
    ['a negative rate', mapResult(EUR_SUNDAY, (s) => s.replace('366,52000', '-366,52000'))],
    ['a rate without unit', mapResult(EUR_SUNDAY, (s) => s.replace('unit="1" curr="EUR"&gt;366', 'curr="EUR"&gt;366'))],
    ['a zero unit', mapResult(EUR_SUNDAY, (s) => s.replace('unit="1" curr="EUR"&gt;366', 'unit="0" curr="EUR"&gt;366'))],
    ['a rate without currency', mapResult(EUR_SUNDAY, (s) => s.replace('unit="1" curr="EUR"&gt;366', 'unit="1"&gt;366'))],
    ['an invalid Day date', mapResult(EUR_SUNDAY, (s) => s.replace('2026-10-22', '2026-10-32'))],
    ['two different rates for one day', mapResult(EUR_SUNDAY, (s) => s.replace(dayOf22, dayOf22 + dayOf22.replace('366,52000', '366,53')))],
  ])('MNB_BAD_RESPONSE for %s', async (_label, body) => {
    const { mnb } = client({ [EUR_SUNDAY_KEY]: body });
    const err = await rejection(mnb.getRate('EUR', '2026-10-25'));
    expect(err.code).toBe('MNB_BAD_RESPONSE');
    expect(err.message).toMatch(/^Az MNB árfolyam-szolgáltatása váratlan választ adott: /);
    expect(err.hint).toBeTruthy();
  });

  it('accepts the same rate repeated for one day', async () => {
    const { mnb } = client({ [EUR_SUNDAY_KEY]: mapResult(EUR_SUNDAY, (s) => s.replace(dayOf22, dayOf22 + dayOf22.replace('366,52000', '366,52'))) });
    expect(await mnb.getRate('EUR', '2026-10-25')).toMatchObject({ date: '2026-10-22', rate: '366.52' });
  });
});

describe('MnbClient.listCurrencies', () => {
  it('lists the currencies of the latest publication (recorded GetCurrentExchangeRates reply)', async () => {
    const { mnb, requests } = client({ GetCurrentExchangeRates: CURRENT });
    const list = await mnb.listCurrencies();
    expect(list).toEqual([
      'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW',
      'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'RSD', 'RUB', 'SEK', 'SGD', 'THB', 'TRY', 'UAH', 'USD', 'ZAR',
    ]);
    expect(list).not.toContain('HUF');
    expect(list).not.toContain('BGN'); // Bulgaria uses the euro since 2026, MNB no longer quotes BGN
    const req = single(requests);
    expect(req.headers.get('soapaction')).toBe('"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetCurrentExchangeRates"');
    expect(req.body).toContain('<soap:Body><GetCurrentExchangeRates xmlns="http://www.mnb.hu/webservices/"></GetCurrentExchangeRates></soap:Body>');
  });

  it('MNB_BAD_RESPONSE for an empty table', async () => {
    const { mnb } = client({ GetCurrentExchangeRates: mapResult(CURRENT, () => '&lt;MNBCurrentExchangeRates /&gt;') });
    expect((await rejection(mnb.listCurrencies())).code).toBe('MNB_BAD_RESPONSE');
  });

  it('leaves out a currency whose rate is the "0,00" placeholder', async () => {
    const { mnb } = client({ GetCurrentExchangeRates: mapResult(CURRENT, (s) => s.replace('curr="AUD"&gt;231,58', 'curr="AUD"&gt;0,00')) });
    const list = await mnb.listCurrencies();
    expect(list).not.toContain('AUD');
    expect(list).toHaveLength(31);
  });

  it('MNB_UNAVAILABLE when MNB cannot be reached', async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect((await rejection(new MnbClient({ fetch: failing }).listCurrencies())).code).toBe('MNB_UNAVAILABLE');
  });
});

describe('MnbClient options', () => {
  it('sends requests to a custom endpoint', async () => {
    const fake = fakeMnb({ [EUR_SUNDAY_KEY]: EUR_SUNDAY });
    await new MnbClient({ fetch: fake.fetch, endpoint: 'http://localhost:8099/arfolyamok.asmx', now: AT_RECORDING }).getRate('EUR', '2026-10-25');
    expect(single(fake.requests).url).toBe('http://localhost:8099/arfolyamok.asmx');
  });

  it('uses the global fetch when none is injected (looked up at call time)', async () => {
    const fake = fakeMnb({ [EUR_SUNDAY_KEY]: EUR_SUNDAY });
    const mnb = new MnbClient({ now: AT_RECORDING });
    vi.stubGlobal('fetch', fake.fetch);
    expect((await mnb.getRate('EUR', '2026-10-25')).rate).toBe('366.52');
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects invalid options', () => {
    // 2^31 ms is beyond setTimeout's limit: Node would fire it after 1 ms, i.e. an instant "timeout" (regression).
    for (const opts of [{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { timeoutMs: 2 ** 31 }, { timeoutMs: Number.POSITIVE_INFINITY }, { endpoint: 'not a url' }]) {
      let err: unknown;
      try {
        new MnbClient(opts);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_ARGUMENT');
    }
  });
});
