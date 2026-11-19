/**
 * R1 over MCP: nav_sync { invoice, resubmitFailed: true } of an invoice reported only to the TEST system sends
 * nothing to production. It returns a preview – in structuredContent and in the text – with where the invoice was
 * reported, where it would go and that this is a real report, and a confirmation code bound to the invoice, its NAV
 * status and both NAV systems; nav_send_to_configured_environment with the code sends it (NS3). In elicit mode the
 * user also confirms in a dialog (RU1); declining sends nothing. Both eras and HTTP: nav-send-to-configured-environment.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type ConfirmMode, type NavRuntimeConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

type Json = Record<string, any>;

let prod: FakeNavServer;
let test: FakeNavServer;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  prod = await FakeNavServer.start({ receivedPolls: 0 });
  test = await FakeNavServer.start({ receivedPolls: 0 });
});
afterAll(async () => {
  await prod.stop();
  await test.stop();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  prod.reset();
  test.reset();
});

function openWith(dir: string, nav: NavRuntimeConfig): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav, confirmMode: 'code', navWaitSeconds: 3 } });
  return OpenSzamla.open({ config, now: () => new Date() });
}

/** An invoice issued and reported in the TEST system; the data directory then reopened with the production connection. */
async function testOnlyInvoice(): Promise<{ app: OpenSzamla; inv: Invoice }> {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-r1-mcp-'));
  const testApp = openWith(dir, { ...test.runtimeConfig(), environment: 'test' });
  testApp.updateSeller(SELLER_INPUT);
  const customer = testApp.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await testApp.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '2000', vatCode: '27' }] });
  const inv = (await testApp.issue(view.invoice.id)).invoice;
  testApp.close();
  const app = openWith(dir, { ...prod.runtimeConfig(), environment: 'production' });
  cleanups.push(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, inv };
}

async function connect(app: OpenSzamla, confirmMode: ConfirmMode, dialog?: (message: string) => boolean): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(app, { confirmMode }), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: dialog ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: 'legacy' } });
  if (dialog) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const yes = dialog(String((request.params as { message?: unknown }).message ?? ''));
      return yes ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  }
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return client;
}

async function call(client: Client, args: Json, name = 'nav_sync'): Promise<{ isError: boolean; data: Json; text: Json }> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  return { isError: raw.isError === true, data: raw.structuredContent as Json, text: JSON.parse(raw.content?.[0]?.text ?? '{}') as Json };
}

const sentToProduction = (): string[] => prod.invoices.map((i) => `${i.invoiceNumber} ${i.invoiceStatus}`);

describe('R1: nav_sync to the other NAV system needs a confirmation (MCP)', () => {
  it('code mode: the first call is a preview with a code; a wrong code is refused; the code sends it', async () => {
    const { app, inv } = await testOnlyInvoice();
    const client = await connect(app, 'code');

    const preview = await call(client, { invoice: inv.number, resubmitFailed: true });
    expect(preview.isError).toBe(false);
    expect(preview.data).toMatchObject({
      confirmationRequired: true,
      crossEnvironment: { invoiceId: inv.id, number: inv.number, reportedTo: 'test', navStatus: 'done', sendTo: 'production', realReport: true },
      confirmationCode: expect.stringMatching(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/),
      confirmationValidMinutes: 10,
      environment: 'production',
    });
    expect(preview.data.summary).toMatch(
      /TESZT rendszerhez tartozik \(ott: jelentve\).*ÉLES NAV-rendszerbe kerülne beküldésre.*valódi adatszolgáltatás.*Nem küldtük be: a nav_sync a másik NAV-rendszerhez tartozó számlát nem küldi be – ezt a nav_send_to_configured_environment végzi, a felhasználó megerősítésével\./,
    );
    expect(preview.data.nextStep).toMatch(/Csak ha kifejezetten megerősíti.*nav_send_to_configured_environment \{ invoice, confirmationCode \}/);
    expect(preview.text).toEqual(preview.data); // the same in the text
    expect(sentToProduction()).toEqual([]);

    const wrong = await call(client, { invoice: inv.number, confirmationCode: 'AAAA-BBBB-CCCC-DDDD' }, 'nav_send_to_configured_environment');
    expect(wrong.isError).toBe(true);
    expect(wrong.data.error).toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(sentToProduction()).toEqual([]);

    const done = await call(client, { invoice: inv.number, confirmationCode: preview.data.confirmationCode, waitSeconds: 3 }, 'nav_send_to_configured_environment');
    expect(done.isError).toBe(false);
    expect(done.data.summary).toBe('1 számla feldolgozva, ebből 1 sikeresen jelentve (éles környezet).');
    expect(done.data.results[0]).toMatchObject({ number: inv.number, navStatus: 'done', environment: 'production' });
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);

    // Reported here now: the same call needs no confirmation and sends nothing again.
    const again = await call(client, { invoice: inv.number, resubmitFailed: true });
    expect(again.data.confirmationRequired).toBeUndefined();
    expect(again.data.results[0]?.note).toBe('Már sikeresen jelentve.');
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });

  it('without resubmitFailed it only explains – no preview, no code, nothing sent', async () => {
    const { app, inv } = await testOnlyInvoice();
    const client = await connect(app, 'code');
    const res = await call(client, { invoice: inv.number });
    expect(res.data.confirmationRequired).toBeUndefined();
    expect(res.data.results[0]?.note).toMatch(/^A számla NAV-állapota a TESZT rendszerhez tartozik/);
    expect(sentToProduction()).toEqual([]);
  });

  it('elicit mode: the code and a dialog – approved it is sent, declined nothing happens', async () => {
    const declined = await testOnlyInvoice();
    const dialogs: string[] = [];
    const no = await connect(declined.app, 'elicit', (m) => {
      dialogs.push(m);
      return false;
    });
    const declinedCode = (await call(no, { invoice: declined.inv.number, resubmitFailed: true })).data.confirmationCode as string;
    expect(declinedCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(dialogs).toEqual([]); // the preview opens no dialog
    const refused = await call(no, { invoice: declined.inv.number, confirmationCode: declinedCode }, 'nav_send_to_configured_environment');
    expect(refused.data).toMatchObject({ status: 'cancelled_by_user' });
    expect(dialogs[0]).toMatch(new RegExp(`^Beküldöd a\\(z\\) ${declined.inv.number} számlát az ÉLES NAV-rendszerbe\\? A\\(z\\) ${declined.inv.number} számla NAV-állapota a TESZT rendszerhez tartozik`));
    expect(dialogs[0]).toMatch(/valódi adatszolgáltatás a NAV felé, és nem vonható vissza/);
    expect(sentToProduction()).toEqual([]);

    const approved = await testOnlyInvoice();
    const yes = await connect(approved.app, 'elicit', () => true);
    const approvedCode = (await call(yes, { invoice: approved.inv.number, resubmitFailed: true })).data.confirmationCode as string;
    const res = await call(yes, { invoice: approved.inv.number, confirmationCode: approvedCode, waitSeconds: 3 }, 'nav_send_to_configured_environment');
    expect(res.data.results[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(sentToProduction()).toEqual([`${approved.inv.number} DONE`]);
  });
});
