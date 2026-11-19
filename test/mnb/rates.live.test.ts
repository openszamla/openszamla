/**
 * Talks to the real MNB service. Runs only with OPENSZAMLA_LIVE_TESTS=1, e.g.
 *   OPENSZAMLA_LIVE_TESTS=1 npx vitest run test/mnb
 */
import { describe, expect, it } from 'vitest';
import { addDays, huDate } from '../../src/core/dates.ts';
import { dec } from '../../src/core/decimal.ts';
import { MnbClient } from '../../src/mnb/rates.ts';

const LIVE = process.env.OPENSZAMLA_LIVE_TESTS === '1';

describe('MNB live service (http://www.mnb.hu/arfolyamok.asmx)', () => {
  it.skipIf(!LIVE)('returns official rates, falls back over holidays and lists the quoted currencies', async () => {
    const mnb = new MnbClient();

    // Friday 2026-10-23 was a national holiday: on Sunday the Thursday rate applies.
    expect(await mnb.getRate('EUR', '2026-10-25')).toEqual({
      currency: 'EUR',
      date: '2026-10-22',
      rate: '366.52',
      unit: 1,
      publishedRate: '366.52',
    });
    expect(await mnb.getRate('JPY', '2026-10-25')).toEqual({
      currency: 'JPY',
      date: '2026-10-22',
      rate: '2.0776',
      unit: 100,
      publishedRate: '207.76',
    });

    // Longest gap since 1990: nothing published from 24 to 28 December 2025.
    expect(await mnb.getRate('EUR', '2025-12-28')).toMatchObject({ date: '2025-12-23', rate: '391.19' });
    // Old data: "0,00" placeholder on 1988-05-27 (and duplicate Day elements) – the last real rate applies.
    expect(await mnb.getRate('GRD', '1988-05-27')).toEqual({ currency: 'GRD', date: '1988-05-26', rate: '0.3532', unit: 100, publishedRate: '35.32' });
    expect(await mnb.getRate('GRD', '1988-06-01')).toMatchObject({ date: '1988-06-01', rate: '0.3525' });
    await expect(mnb.getRate('USD', '1949-01-02')).rejects.toMatchObject({ code: 'MNB_RATE_NOT_FOUND' });
    expect(await mnb.getRate('USD', '1949-01-03')).toMatchObject({ date: '1949-01-03', rate: '11.74' });

    const today = huDate();
    const usd = await mnb.getRate('USD', today);
    expect(usd.date <= today).toBe(true);
    expect(dec(usd.rate).gt(0)).toBe(true);
    // No official rate exists yet for a future day.
    await expect(mnb.getRate('USD', addDays(today, 1))).rejects.toMatchObject({ code: 'MNB_RATE_NOT_FOUND', details: { today } });

    await expect(mnb.getRate('XYZ', today)).rejects.toMatchObject({ code: 'MNB_RATE_NOT_FOUND' });

    const currencies = await mnb.listCurrencies();
    expect(currencies).toEqual(expect.arrayContaining(['EUR', 'USD', 'CHF', 'GBP', 'JPY']));
    expect(currencies).not.toContain('HUF');
  }, 60_000);
});
