/**
 * NAV-9: after HTTP 429 (or maintenance with Retry-After) a run sends nothing more, keeps the rest pending with one
 * note giving the earliest retry time, and records that time: later runs, polls and the submission when issuing
 * honour it (also in another process – it is kept in the database). Nothing becomes 'error', nothing sleeps.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
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
  nav.setReceivedPolls(0);
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

async function issueSimple(app: OpenSzamla, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ text: DOMESTIC_CUSTOMER_INPUT.name, limit: 1, offset: 0 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Szoftverfejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  return app.issue(view.invoice.id, opts);
}

const PAUSE_NOTE = /^A NAV forgalomkorlátozás miatt \(HTTP 429\) azt kérte, hogy legkorábban \d{4}\.\d{2}\.\d{2}\. \d{2}:\d{2}:\d{2}-kor forduljunk hozzá újra \(Retry-After\): addig a program nem küld be és nem kérdez le semmit/;

describe('NAV-9: a pause NAV asks for (Retry-After) is honoured', () => {
  it('after a 429 the run stops at once; later runs and issuing send nothing before the time NAV gave', async () => {
    const c = clock();
    const app = setup(c.now);
    for (let i = 0; i < 5; i++) await issueSimple(app, { submitToNav: false });
    nav.failNext({ kind: 'RATE_LIMIT', retryAfterSeconds: 60 }, { times: 1000 });
    const before = nav.requests.length;
    const res = await app.navSync({ waitSeconds: 0 });
    expect(nav.requests.length - before).toBe(1);
    expect(res.map((r) => r.navStatus)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    for (const r of res) expect(r.note).toMatch(PAUSE_NOTE);
    expect(res[0]?.messages[0]?.code).toBe('TOO_MANY_REQUESTS');
    expect(app.store.getSetting('navPause')).toEqual({ until: new Date(c.now().getTime() + 60_000).toISOString(), environment: 'test', code: 'TOO_MANY_REQUESTS' });

    // Before the deadline: no run, poll or issue-time submission contacts NAV.
    c.advanceSeconds(30);
    const again = await app.navSync({ waitSeconds: 0 });
    expect(again.map((r) => r.note)).toEqual(res.map((r) => r.note));
    const issued = await issueSimple(app);
    expect(issued.invoice.navStatus).toBe('pending');
    expect(issued.nav?.note).toMatch(PAUSE_NOTE);
    expect(nav.requests.length - before).toBe(1);
    expect(app.status().nextSteps.join('\n')).toMatch(/legkorábban .* forduljunk hozzá újra \(Retry-After\): addig a nav_sync nem küld be/);
    expect(app.status().counts.navProblems).toBe(0);

    // Another process on the same database honours it too.
    const other = OpenSzamla.open({ config: app.config, now: c.now });
    try {
      expect((await other.navSync({ waitSeconds: 0 }))[0]?.note).toMatch(PAUSE_NOTE);
    } finally {
      other.close();
    }
    expect(nav.requests.length - before).toBe(1);

    // After it: everything is reported.
    nav.reset();
    c.advanceSeconds(31);
    const after = await app.navSync({ waitSeconds: 3 });
    expect(after.map((r) => r.navStatus)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('maintenance with a Retry-After is a pause too; without one only the current run stops', async () => {
    const c = clock();
    const app = setup(c.now);
    for (let i = 0; i < 3; i++) await issueSimple(app, { submitToNav: false });
    nav.failNext({ kind: 'MAINTENANCE', retryAfterSeconds: 600 }, { operation: 'tokenExchange', times: 1000 });
    const first = await app.navSync({ waitSeconds: 0 });
    expect(nav.requests).toHaveLength(1);
    expect(first.map((r) => r.navStatus)).toEqual(['pending', 'pending', 'pending']);
    expect(first[1]?.note).toMatch(/^A NAV karbantartás miatt azt kérte, hogy legkorábban .*-kor forduljunk hozzá újra \(Retry-After\)/);
    expect(app.store.getSetting('navPause')).toMatchObject({ code: 'MAINTENANCE_MODE', until: new Date(c.now().getTime() + 600_000).toISOString() });

    nav.reset();
    c.advanceSeconds(601);
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'tokenExchange', times: 1000 });
    const second = await app.navSync({ waitSeconds: 0 });
    expect(nav.requests).toHaveLength(1); // stopped after the first answer of the run …
    expect(second[1]?.note).toMatch(/^A NAV ebben a futásban nem érhető el \(MAINTENANCE_MODE\)/);
    expect(app.store.getSetting<{ until: string }>('navPause')?.until).toBe(new Date(c.now().getTime() - 1000).toISOString()); // … without a new pause
    nav.reset();
    expect((await app.navSync({ waitSeconds: 3 })).map((r) => r.navStatus)).toEqual(['done', 'done', 'done']);
  });

  it('a 429 while polling: the pause holds for the polls of later runs', async () => {
    const c = clock();
    const app = setup(c.now);
    nav.setReceivedPolls(1000);
    const r = await issueSimple(app);
    expect(r.invoice.navStatus).toBe('processing');
    nav.failNext({ kind: 'RATE_LIMIT', retryAfterSeconds: 120 }, { operation: 'queryTransactionStatus', times: 1000 });
    const before = nav.requests.length;
    expect((await app.navSync({ waitSeconds: 0 }))[0]?.navStatus).toBe('processing');
    expect(nav.requests.length - before).toBe(1);
    c.advanceSeconds(60);
    const later = await app.navSync({ waitSeconds: 0 });
    expect(later[0]).toMatchObject({ navStatus: 'processing', note: expect.stringMatching(PAUSE_NOTE) });
    expect(nav.requests.length - before).toBe(1);
  });
});
