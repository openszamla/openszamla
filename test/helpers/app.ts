/** Creates an isolated OpenSzamla instance (temp data dir, fixed clock) for integration tests. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type AppConfig, type ConfirmMode } from '../../src/service/config.ts';

export interface TestApp {
  app: OpenSzamla;
  dir: string;
  cleanup(): void;
}

/** 2026-10-27 10:00 Budapest time. */
export const FIXED_NOW = new Date('2026-10-27T09:00:00.000Z');

/**
 * A clock for tests that record payments over time. "Today" starts at `start` (10:00 Budapest time), when the documents
 * are issued; recording a payment dated later moves it to that day – the payment is recorded when it arrives, as in real
 * use, where the program refuses a payment dated after today. It never moves back. Give `now` to the app, then `follow` it.
 */
export function paymentClock(start: string): { now: () => Date; follow<A extends Pick<OpenSzamla, 'recordPayment'>>(app: A): A } {
  let today = start;
  return {
    now: () => new Date(`${today}T09:00:00.000Z`),
    follow(app) {
      const record = app.recordPayment.bind(app);
      app.recordPayment = (idOrNumber, input, actor) => {
        if (input.date && input.date > today) today = input.date;
        return record(idOrNumber, input, actor);
      };
      return app;
    },
  };
}

export function makeTestApp(opts: { confirmMode?: ConfirmMode; nav?: AppConfig['nav']; now?: () => Date; fetch?: typeof fetch } = {}): TestApp {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-test-'));
  const config = loadConfig({
    dataDir: dir,
    env: {},
    overrides: { nav: opts.nav ?? null, confirmMode: opts.confirmMode ?? 'code', navWaitSeconds: 3 },
  });
  const app = OpenSzamla.open({ config, now: opts.now ?? (() => FIXED_NOW), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return {
    app,
    dir,
    cleanup() {
      try {
        app.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const SELLER_INPUT = {
  name: 'Teszt Számlázó Kft.',
  taxNumber: '12345676-2-42',
  euVatNumber: 'HU12345676',
  address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Irinyi József utca 4.' },
  bankAccount: '12345676-11111111',
  email: 'szamla@teszt.hu',
  vatStatus: 'normal' as const,
};

export const DOMESTIC_CUSTOMER_INPUT = {
  vatStatus: 'DOMESTIC' as const,
  name: 'Árvíztűrő Tükörfúrógép Zrt.',
  taxNumber: '87654323-2-13',
  address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
};
