/**
 * NV5c: one nav_sync call can be given a time limit (NavRunOptions.budgetMs – the MCP tools pass about 45 s, because MCP
 * clients give up on a call after about 60 s, the web about 60 s). Against a hanging or very slow NAV the call returns
 * within it: after the limit no new NAV request starts, a request's timeout is cut to what is left, the wait for the
 * processing (waitSeconds) too, and a call queued behind a run still going does not wait past it. The invoices it did
 * not get to are marked notProcessed with a note to run nav_sync again. A submission whose answer was cut off is an
 * uncertain one (looked up before anything is sent again), nothing is sent twice, and a later nav_sync finishes the rest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

let nav: FakeNavServer;
let t: TestApp | null = null;
/** The service clock runs this much ahead of the real one (the 5-minute rule of an uncertain submission). */
let ahead = 0;

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
  ahead = 0;
});

/** The real clock, `ahead` later – for the program and for NAV alike (time passes for both). */
function setup(opts: { fetch?: typeof fetch } = {}): OpenSzamla {
  nav.setNow(() => new Date(Date.now() + ahead));
  t = makeTestApp({ nav: nav.runtimeConfig(), now: () => new Date(Date.now() + ahead), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

/** `n` issued invoices waiting for their NAV report; their numbers. */
async function pending(app: OpenSzamla, n: number): Promise<string[]> {
  const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const numbers: string[] = [];
  for (let i = 0; i < n; i++) {
    const view = await app.createDraft({ customerId: customer.id, lines: [{ description: `Tanácsadás ${i + 1}`, quantity: '1', unit: 'óra', unitPrice: String(10_000 + i), vatCode: '27' }] });
    numbers.push((await app.issue(view.invoice.id, { submitToNav: false })).invoice.number as string);
  }
  return numbers;
}

/** How many times NAV received each invoice number. */
function received(): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of nav.invoices) m.set(i.invoiceNumber as string, (m.get(i.invoiceNumber as string) ?? 0) + 1);
  return m;
}

async function timed<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t0 };
}

const TIME_NOTE = 'A NAV-szinkronra szánt idő (2 mp) letelt, ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz. Futtasd újra a nav_sync-et: a következő futás folytatja.';

describe('NV5c: a nav_sync call with a time limit returns within it', () => {
  it('a NAV that hangs after receiving a submission: back within the limit, the cut-off one is looked up later, never sent twice', async () => {
    const app = setup();
    const numbers = await pending(app, 3);
    nav.failNext({ kind: 'HANG' }, { operation: 'manageInvoice' });
    const { value: res, ms } = await timed(app.navSync({ waitSeconds: 45, budgetMs: 2_000 }));
    // Without the limit the hanging request alone would take its own 60 s.
    expect(ms).toBeLessThan(5_000);
    expect(res[0]).toMatchObject({ number: numbers[0], navStatus: 'pending' });
    expect(res[0]?.messages.map((m) => m.code)).toEqual(['TIMEOUT', 'OPENSZAMLA_UNCERTAIN']);
    const cut = Number(/A NAV nem válaszolt (\d+) ms alatt \(manageInvoice\)/.exec(res[0]?.messages[0]?.message ?? '')?.[1]);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThanOrEqual(2_000);
    // The cut-off timeout means the time is up: the others are left as they were, to run nav_sync again for.
    expect(res.slice(1).map((r) => [r.number, r.navStatus, r.notProcessed, r.note])).toEqual([
      [numbers[1], 'pending', 'time', TIME_NOTE],
      [numbers[2], 'pending', 'time', TIME_NOTE],
    ]);
    expect(res[0]?.notProcessed).toBeUndefined();
    expect(Object.fromEntries(received())).toEqual({ [numbers[0] as string]: 1 });

    // Later (after the 5 minutes of an uncertain submission) a nav_sync without a limit finishes everything.
    ahead = 6 * 60_000;
    const later = await app.navSync({ waitSeconds: 5 });
    expect(later.map((r) => [r.number, r.navStatus])).toEqual(numbers.map((n) => [n, 'done']));
    expect(later[0]?.note).toMatch(/^A korábbi, bizonytalan kimenetelű beküldést a NAV megkapta/);
    expect(Object.fromEntries(received())).toEqual(Object.fromEntries(numbers.map((n) => [n, 1])));
  }, 30_000);

  it('a very slow NAV: what does not fit is notProcessed "time" with a note; a later nav_sync finishes the rest, each once', async () => {
    const app = setup();
    const numbers = await pending(app, 8);
    // Every answer comes late: 8 submissions take at least 8 × 2 × 150 ms – more than the limit.
    nav.failNext({ kind: 'DELAY', ms: 150 }, { times: 10_000 });
    const { value: res, ms } = await timed(app.navSync({ waitSeconds: 45, budgetMs: 2_400 }));
    expect(ms).toBeLessThan(5_400);
    const left = res.filter((r) => r.notProcessed === 'time');
    const sent = res.filter((r) => r.notProcessed === undefined);
    expect(left.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length + left.length).toBe(numbers.length);
    // The run went in order: the ones it did not get to are the last ones, untouched.
    expect(res.map((r) => r.number)).toEqual(numbers);
    expect(res.slice(sent.length).every((r) => r.notProcessed === 'time')).toBe(true);
    for (const r of left) expect(r).toMatchObject({ navStatus: 'pending', messages: [], note: TIME_NOTE });
    expect([...received().values()].every((n) => n === 1)).toBe(true);
    expect(received().size).toBeLessThanOrEqual(sent.length);

    nav.clearFaults();
    ahead = 6 * 60_000; // in case an answer was cut off: it is looked up first
    const later = await app.navSync({ waitSeconds: 5 });
    expect(later.map((r) => [r.number, r.navStatus])).toEqual(numbers.map((n) => [n, 'done']));
    expect(Object.fromEntries(received())).toEqual(Object.fromEntries(numbers.map((n) => [n, 1])));
  }, 30_000);

  it('the wait for the processing (waitSeconds) ends with the limit', async () => {
    const app = setup();
    const [number] = await pending(app, 1);
    nav.setReceivedPolls(1_000_000); // NAV keeps processing
    const { value: res, ms } = await timed(app.navSync({ waitSeconds: 45, budgetMs: 1_500 }));
    expect(ms).toBeLessThan(4_500);
    expect(res).toMatchObject([{ number, navStatus: 'processing' }]);
    expect(res[0]?.notProcessed).toBeUndefined(); // it was sent: only the result is still to come
    nav.setReceivedPolls(0);
    expect((await app.navSync({ waitSeconds: 3 })).map((r) => [r.number, r.navStatus])).toEqual([[number, 'done']]);
  }, 30_000);

  it('queued behind a run still going, it does not wait past its limit and sends nothing; the queue stays one run at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let requests = 0;
    const app = setup({
      fetch: async (input, init) => {
        requests++;
        if (!held && String(input).endsWith('/tokenExchange')) {
          held = true;
          await gate; // the first run's first request hangs until the test lets it go
        }
        return fetch(input, init);
      },
    });
    const numbers = await pending(app, 2);
    const first = app.navSync({ waitSeconds: 3 });
    const { value: second, ms } = await timed(app.navSync({ waitSeconds: 3, budgetMs: 800 }));
    expect(ms).toBeLessThan(3_800);
    expect(second.map((r) => [r.number, r.navStatus, r.notProcessed])).toEqual(numbers.map((n) => [n, 'pending', 'time']));
    expect(second[0]?.note).toBe('A NAV-szinkronra szánt idő (1 mp) letelt, ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz. Futtasd újra a nav_sync-et: a következő futás folytatja.');
    expect(requests).toBe(1); // only the first run's held request
    // A run queued now waits for the first one, not for the expired second one.
    const third = app.navSync({ waitSeconds: 3 });
    release();
    expect((await first).map((r) => r.navStatus)).toEqual(['done', 'done']);
    expect(await third).toEqual([]);
    expect(Object.fromEntries(received())).toEqual(Object.fromEntries(numbers.map((n) => [n, 1])));
  }, 30_000);
});
