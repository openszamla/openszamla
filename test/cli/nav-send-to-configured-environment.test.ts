/**
 * NS3 at the command line: `openszamla nav-send-to-configured-environment <sorszám|id> [--confirm]` sends an invoice
 * whose NAV state belongs to the other NAV system (here: reported only to the TEST one) to the configured one. It
 * always prints what that means first; without --confirm it sends nothing (CONFIRMATION_REQUIRED, exit code 1). The
 * sending part runs in process against fake NAV servers (the CLI process itself only ever reaches the real NAV).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { navSendToConfiguredEnvironment } from '../../src/cli/nav-send.ts';
import { isAppError } from '../../src/core/errors.ts';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, navSendCommandLine, type NavRuntimeConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';
import { FAKE_NAV_CREDENTIALS, FakeNavServer } from '../helpers/fake-nav.ts';

let prod: FakeNavServer;
let test: FakeNavServer;
const open: OpenSzamla[] = [];

beforeAll(async () => {
  prod = await FakeNavServer.start({ receivedPolls: 0 });
  test = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await prod.stop();
  await test.stop();
});
afterEach(() => {
  while (open.length) open.pop()?.close();
  removeTempDirs();
  prod.reset();
  test.reset();
});

function openWith(dir: string, nav: NavRuntimeConfig): OpenSzamla {
  const app = OpenSzamla.open({ config: loadConfig({ dataDir: dir, env: {}, overrides: { nav, navWaitSeconds: 3 } }), now: () => new Date() });
  open.push(app);
  return app;
}

/** A data directory with an invoice issued and reported in the TEST system. */
async function testOnlyInvoice(): Promise<{ dir: string; inv: Invoice }> {
  const dir = tempDir('openszamla-cli-ns3-');
  const app = openWith(dir, { ...test.runtimeConfig(), environment: 'test' });
  app.updateSeller(SELLER_INPUT);
  const customer = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '2000', vatCode: '27' }] });
  const inv = (await app.issue(view.invoice.id)).invoice;
  open.pop()?.close();
  return { dir, inv };
}

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string; hint: string | undefined }> {
  try {
    await p;
  } catch (e) {
    if (isAppError(e)) return { code: e.code, message: e.message, hint: e.hint };
    throw e;
  }
  throw new Error('no error');
}

describe('openszamla nav-send-to-configured-environment', () => {
  it('prints what it means; sends only with --confirm, once', async () => {
    const { dir, inv } = await testOnlyInvoice();
    const app = openWith(dir, { ...prod.runtimeConfig(), environment: 'production' });
    const summary = app.navForeignResend(inv.id)?.summary as string;
    expect(summary).toMatch(/ÉLES NAV-rendszerbe kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás/);

    const lines: string[] = [];
    const refused = await failure(navSendToConfiguredEnvironment(app, inv.number as string, { confirm: false, dataDir: dir }, (l) => lines.push(l)));
    expect(lines).toEqual([summary]);
    expect(refused).toEqual({
      code: 'CONFIRMATION_REQUIRED',
      message: 'Nem küldtem be: a másik NAV-rendszerhez tartozó számla beküldéséhez kifejezett megerősítés kell (--confirm).',
      hint: `Ha ez valódi számla, és az éles NAV-rendszerbe is be kell küldeni: ${navSendCommandLine(inv.number as string, dir)}`,
    });
    expect(prod.invoices).toHaveLength(0);

    lines.length = 0;
    expect(await navSendToConfiguredEnvironment(app, inv.number as string, { confirm: true, dataDir: dir }, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([summary, `${inv.number}: done (éles rendszer) – A NAV sikeresen befogadta.`]);
    expect(prod.invoices.map((i) => `${i.invoiceNumber} ${i.invoiceStatus}`)).toEqual([`${inv.number} DONE`]);

    // It belongs to production now: nothing more to send.
    expect((await failure(navSendToConfiguredEnvironment(app, inv.id, { confirm: true, dataDir: dir }, () => undefined))).code).toBe('NOT_OTHER_NAV_SYSTEM');
    expect(prod.invoices).toHaveLength(1);
  });

  it('as a command: without --confirm it prints the preview, CONFIRMATION_REQUIRED, exit code 1 – no NAV request', async () => {
    const { dir, inv } = await testOnlyInvoice();
    // Production credentials of the right form: nothing is sent without --confirm, so no NAV is contacted.
    const env = {
      OPENSZAMLA_NAV_ENV: 'production',
      OPENSZAMLA_NAV_LOGIN: FAKE_NAV_CREDENTIALS.login,
      OPENSZAMLA_NAV_PASSWORD: FAKE_NAV_CREDENTIALS.password,
      OPENSZAMLA_NAV_SIGNING_KEY: FAKE_NAV_CREDENTIALS.signingKey,
      OPENSZAMLA_NAV_EXCHANGE_KEY: FAKE_NAV_CREDENTIALS.exchangeKey,
    };
    const r = await cli(['nav-send-to-configured-environment', inv.number as string, '--data-dir', dir], { env });
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe(
      `A(z) ${inv.number} számla NAV-állapota a TESZT rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve. ` +
        'Most az ÉLES NAV-rendszerbe kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás a NAV felé, és nem vonható vissza. Csak akkor küldd be, ha ez valódi számla.',
    );
    expect(r.stderr).toContain('Hiba [CONFIRMATION_REQUIRED]: Nem küldtem be: a másik NAV-rendszerhez tartozó számla beküldéséhez kifejezett megerősítés kell (--confirm).');
    expect(r.stderr).toContain(`Tipp: Ha ez valódi számla, és az éles NAV-rendszerbe is be kell küldeni: ${navSendCommandLine(inv.number as string, dir)}`);
    expect(r.stdout + r.stderr).not.toContain(FAKE_NAV_CREDENTIALS.password);

    // Its own option only, an argument required, documented in the help.
    expect((await cli(['nav-send-to-configured-environment', inv.number as string, '--confirm=igen', '--data-dir', dir], { env })).stderr).toContain('A(z) --confirm kapcsoló nem kap értéket.');
    expect((await cli(['nav-send-to-configured-environment', '--data-dir', dir], { env })).stderr).toContain('Hiba [INVALID_INPUT]: Add meg a számla sorszámát vagy azonosítóját.');
    expect((await cli(['status', '--confirm', '--data-dir', dir])).stderr).toContain('A(z) --confirm kapcsoló a(z) status parancsnál nem használható.');
    expect((await cli(['--help'])).stdout).toMatch(/nav-send-to-configured-environment <sorszám\|id> \[--confirm\]/);
  }, 60_000);
});
