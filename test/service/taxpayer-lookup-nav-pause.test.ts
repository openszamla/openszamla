/**
 * NV5b: taxpayer_lookup honours the pause NAV asked for (Retry-After, kept in the database). Before it ends the
 * lookup does not call NAV: it fails with NAV_PAUSED, saying until when and how long is left. A pause NAV asks for in
 * the answer to a lookup is recorded like one of a nav_sync, so the runs honour it too; after it the lookup works.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

let nav: FakeNavServer;
let t: TestApp | null = null;

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await nav.stop();
});
afterEach(() => {
  t?.cleanup();
  t = null;
  nav.reset();
});

function clock(): { now: () => Date; advanceSeconds(s: number): void } {
  let at = Date.now();
  return {
    now: () => new Date(at),
    advanceSeconds(s: number) {
      at += s * 1000;
    },
  };
}

function setup(now: () => Date): OpenSzamla {
  t = makeTestApp({ nav: nav.runtimeConfig(), now });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

async function lookupError(app: OpenSzamla): Promise<AppError> {
  try {
    await app.lookupTaxpayer('87654323');
  } catch (e) {
    return e as AppError;
  }
  throw new Error('the lookup did not fail');
}

const taxpayerQueries = (): number => nav.requests.filter((r) => r.operation === 'queryTaxpayer').length;

describe('NV5b: taxpayer_lookup and the NAV pause (Retry-After)', () => {
  it('a pause recorded by a nav_sync: the lookup does not call NAV before it ends, and says how long is left', async () => {
    const c = clock();
    const app = setup(c.now);
    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    await app.issue(view.invoice.id, { submitToNav: false });
    nav.failNext({ kind: 'RATE_LIMIT', retryAfterSeconds: 150 });
    await app.navSync({ waitSeconds: 0 });
    expect(app.store.getSetting('navPause')).toMatchObject({ environment: 'test', code: 'TOO_MANY_REQUESTS' });

    c.advanceSeconds(30);
    const e = await lookupError(app);
    expect(e.code).toBe('NAV_PAUSED');
    expect(e.message).toMatch(/^A NAV forgalomkorlátozás miatt \(HTTP 429\) azt kérte, hogy legkorábban \d{4}\.\d{2}\.\d{2}\. \d{2}:\d{2}:\d{2}-kor forduljunk hozzá újra \(Retry-After\) – kb\. 2 perc van hátra\. Addig a program az adószám-lekérdezéssel sem fordul a NAV-hoz\.$/);
    expect(e.hint).toMatch(/^Próbáld újra \d{4}\.\d{2}\.\d{2}\. \d{2}:\d{2}:\d{2} után; addig a vevő adatait kézzel is megadhatod \(customer_save\)\.$/);
    c.advanceSeconds(100);
    expect((await lookupError(app)).message).toMatch(/– 20 másodperc van hátra\./);
    expect(taxpayerQueries()).toBe(0);

    c.advanceSeconds(21); // the pause is over
    const r = await app.lookupTaxpayer('87654323');
    expect(r.taxpayer?.name).toMatch(/^Árvíztűrő Tükörfúrógép/);
    expect(taxpayerQueries()).toBe(1);
  });

  it('a pause NAV asks for in the answer to a lookup is recorded: later lookups and nav_sync runs honour it', async () => {
    const c = clock();
    const app = setup(c.now);
    nav.failNext({ kind: 'RATE_LIMIT', retryAfterSeconds: 60 }, { operation: 'queryTaxpayer' });
    expect((await lookupError(app)).code).toBe('NAV_TOO_MANY_REQUESTS');
    expect(app.store.getSetting('navPause')).toEqual({ until: new Date(c.now().getTime() + 60_000).toISOString(), environment: 'test', code: 'TOO_MANY_REQUESTS' });
    const requests = nav.requests.length;
    expect((await lookupError(app)).code).toBe('NAV_PAUSED');

    const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const issued = await app.issue(view.invoice.id);
    expect(issued.invoice.navStatus).toBe('pending');
    expect(issued.nav?.note).toMatch(/forduljunk hozzá újra \(Retry-After\): addig a program nem küld be és nem kérdez le semmit/);
    expect(nav.requests.length).toBe(requests);

    c.advanceSeconds(61);
    expect((await app.lookupTaxpayer('87654323')).taxpayer).not.toBeNull();
  });
});
