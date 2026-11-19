/**
 * NAV-5: an invoice counts as reported only in the NAV environment that accepted it. One data directory goes
 * production → test → production (OPENSZAMLA_NAV_ENV is a documented override); two fake NAV servers stand in for the
 * two systems. A test-only invoice is not reported in production: status, nextSteps and invoice_list say so, a plain
 * nav_sync never sends (or polls) it there, and nav_sync { invoice, resubmitFailed: true } reports it as a new submission –
 * once the user confirmed it (R1).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type NavRuntimeConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

let prod: FakeNavServer;
let test: FakeNavServer;
let dir: string;
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
  rmSync(dir, { recursive: true, force: true });
  prod.reset();
  test.reset();
  test.setReceivedPolls(0);
});

const prodNav = (): NavRuntimeConfig => ({ ...prod.runtimeConfig(), environment: 'production' });
const testNav = (): NavRuntimeConfig => ({ ...test.runtimeConfig(), environment: 'test' });

/** The data directory opened with the NAV connection `nav` (the previous instance is closed first). */
function openWith(nav: NavRuntimeConfig): OpenSzamla {
  while (open.length) open.pop()?.close();
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav, confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: () => new Date() });
  open.push(app);
  return app;
}

async function issue(app: OpenSzamla, net: string) {
  const customer = app.findCustomers({ text: DOMESTIC_CUSTOMER_INPUT.name, limit: 1, offset: 0 }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: net, vatCode: '27' }] });
  return app.issue(view.invoice.id);
}

const requests = (nav: FakeNavServer, operation: string): number => nav.requests.filter((r) => r.operation === operation).length;
/** The confirmation of sending `id` (of the other NAV system) here – what the user approves through nav_sync's preview. */
const confirmation = (app: OpenSzamla, id: string): string => app.navForeignResend(id)?.fingerprint ?? 'none';

/** A: reported in production; B: reported only to the test system; C: still processing at the test system. */
async function switchedBackAndForth() {
  dir = mkdtempSync(join(tmpdir(), 'openszamla-env-'));
  let app = openWith(prodNav());
  app.updateSeller(SELLER_INPUT);
  const a = await issue(app, '1000');
  app = openWith(testNav());
  const b = await issue(app, '2000');
  test.setReceivedPolls(1000);
  const c = await issue(app, '3000');
  app = openWith(prodNav());
  return { app, a: a.invoice, b: b.invoice, c: c.invoice };
}

describe('NAV-5: the NAV status belongs to the environment that accepted the report', () => {
  it('a test-only report is not counted as reported in production, and a plain nav_sync neither sends nor polls it there', async () => {
    const { app, a, b, c } = await switchedBackAndForth();
    expect([a.navStatus, a.navEnvironment, b.navStatus, b.navEnvironment, c.navStatus, c.navEnvironment]).toEqual(['done', 'production', 'done', 'test', 'processing', 'test']);
    const status = app.status();
    expect(status.counts).toMatchObject({ navPending: 0, navProblems: 0, navOtherEnvironment: 2 });
    const steps = status.nextSteps.join('\n');
    expect(steps).toContain(`2 számla NAV-állapota a TESZT rendszerhez tartozik (ott jelentve, feldolgozás alatt vagy jelentésre várva), az éles rendszerbe nincs jelentve (${b.number}, ${c.number})`);
    expect(steps).toMatch(/nav_sync \{ invoice: "<sorszám>", resubmitFailed: true \}/);
    expect(steps).not.toMatch(/folyamatban/);
    expect(app.navEnvironmentNote(app.getInvoice(b.id))).toMatch(/TESZT rendszerhez tartozik \(ott: jelentve\), az éles rendszerbe nincs jelentve/);
    expect(app.navEnvironmentNote(app.getInvoice(a.id))).toBeNull();

    const before = test.requests.length;
    for (let k = 0; k < 2; k++) expect(await app.navSync({ waitSeconds: 1 })).toEqual([]);
    // Never polled at production with the test system's transaction id (nor at the test system).
    expect(prod.requests.filter((r) => r.operation === 'queryTransactionStatus' && r.requestXml.includes(String(c.navTransactionId)))).toHaveLength(0);
    expect(test.requests.length).toBe(before);
    expect(app.getInvoice(c.id)).toMatchObject({ navStatus: 'processing', navEnvironment: 'test' });
  });

  it('nav_sync { invoice } explains it; with resubmitFailed it is reported to production as a new submission', async () => {
    const { app, b } = await switchedBackAndForth();
    const [explained] = await app.navSync({ invoiceId: b.id });
    expect(explained).toMatchObject({ navStatus: 'done', environment: 'test' });
    expect(explained?.note).toBe(
      `A számla NAV-állapota a TESZT rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve – a teszt környezetbe küldött számla nem adatszolgáltatás. Ha ez valódi számla, az éles rendszerbe a nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő kód: nav_sync { invoice: "${b.number}", resubmitFailed: true }.`,
    );
    expect(requests(prod, 'manageInvoice')).toBe(1); // A only

    // A real report to production: only the one the user confirmed (R1, nav-cross-environment-confirm.test.ts).
    const [unconfirmed] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 3 });
    expect(unconfirmed).toMatchObject({ navStatus: 'done', environment: 'test', note: expect.stringMatching(/^Nem küldtük be \(megerősítés nélkül\)/) });
    expect(requests(prod, 'manageInvoice')).toBe(1);
    const [reported] = await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: confirmation(app, b.id) });
    expect(reported).toMatchObject({ navStatus: 'done', environment: 'production', note: 'A NAV sikeresen befogadta.' });
    expect(prod.invoices.map((i) => [i.invoiceNumber, i.invoiceStatus])).toEqual([
      [`SZ-${new Date().getFullYear()}-00001`, 'DONE'],
      [b.number, 'DONE'],
    ]);
    expect(app.store.listNavSubmissions(b.id).map((s) => [s.environment, s.status])).toEqual([
      ['test', 'done'],
      ['production', 'done'],
    ]);
    expect(app.status().counts.navOtherEnvironment).toBe(1);
    // Reported here now: asking again sends nothing.
    expect((await app.navSync({ invoiceId: b.id, resubmitFailed: true }))[0]?.note).toBe('Már sikeresen jelentve.');
    expect(requests(prod, 'manageInvoice')).toBe(2);
  });

  it('a storno of a test-only invoice waits until the original is reported to production, then follows it', async () => {
    const { app, b } = await switchedBackAndForth();
    const storno = await app.cancel(b.id, { reason: 'Téves számla' });
    expect(storno.invoice.navStatus).toBe('pending');
    expect(storno.nav?.note).toMatch(/az eredeti számla \(.*\) NAV-állapota a TESZT rendszerhez tartozik, az éles rendszerbe nincs jelentve/);
    expect(app.navWaitReason(storno.invoice.id)).toMatch(/TESZT rendszerhez tartozik/);
    expect(app.status().nextSteps.join('\n')).toMatch(/Rájuk vár 1 módosító\/sztornó számla is/);
    expect(app.status().nextSteps.join('\n')).not.toMatch(/függőben/);
    expect(requests(prod, 'manageInvoice')).toBe(1);

    await app.navSync({ invoiceId: b.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: confirmation(app, b.id) });
    const sync = await app.navSync({ waitSeconds: 3 });
    expect(sync.map((r) => [r.number, r.navStatus, r.environment])).toEqual([[storno.invoice.number, 'done', 'production']]);
    expect(prod.invoices.map((i) => i.operation)).toEqual(['CREATE', 'CREATE', 'STORNO']);
  });

  it('an open attempt of the other NAV system neither blocks nor is reconciled here (the claim is per environment)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-env-'));
    let app = openWith(testNav());
    app.updateSeller(SELLER_INPUT);
    test.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const r = await issue(app, '4000');
    expect(r.invoice).toMatchObject({ navStatus: 'pending', navEnvironment: 'test' });
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => [s.environment, s.status])).toEqual([['test', 'sent']]);

    app = openWith(prodNav());
    expect(await app.navSync({ waitSeconds: 1 })).toEqual([]);
    const [sent] = await app.navSync({ invoiceId: r.invoice.id, resubmitFailed: true, waitSeconds: 3, confirmedForeign: confirmation(app, r.invoice.id) });
    expect(sent).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(requests(prod, 'queryTransactionList')).toBe(0);
    expect(app.store.listNavSubmissions(r.invoice.id).map((s) => [s.environment, s.status])).toEqual([
      ['test', 'sent'],
      ['production', 'done'],
    ]);
  });

  it('invoice_list and invoice_get show which NAV system the status belongs to', async () => {
    const { app, a, b } = await switchedBackAndForth();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, {});
    await client.connect(clientT);
    try {
      const text = (r: unknown): Record<string, any> => JSON.parse((r as { content: Array<{ text: string }> }).content[0]?.text ?? '{}');
      const list = text(await client.callTool({ name: 'invoice_list', arguments: { status: ['issued'] } }));
      const rows = new Map<string, Record<string, any>>(list.invoices.map((i: Record<string, any>) => [i.number, i]));
      expect(rows.get(a.number as string)).toMatchObject({ navStatus: 'done', navEnvironment: 'production' });
      expect(rows.get(a.number as string)?.navNote).toBeUndefined();
      expect(rows.get(b.number as string)).toMatchObject({ navStatus: 'done', navEnvironment: 'test', navNote: expect.stringMatching(/^A számla NAV-állapota a TESZT rendszerhez tartozik/) });
      const got = text(await client.callTool({ name: 'invoice_get', arguments: { invoice: b.number } }));
      expect(got.invoice).toMatchObject({ navEnvironment: 'test', navNote: expect.stringMatching(/az éles rendszerbe nincs jelentve/) });
      const sync = text(await client.callTool({ name: 'nav_sync', arguments: { invoice: b.number } }));
      expect(sync.summary).toBe('1 számla feldolgozva, ebből 0 sikeresen jelentve (éles környezet).');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
