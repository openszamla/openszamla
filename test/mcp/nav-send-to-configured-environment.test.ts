/**
 * NS3 + RU1 + RU2 + NS6: sending an invoice whose NAV state belongs to the other NAV system (here: reported only to the
 * TEST one) to the configured one (production) is an irreversible, real report – the tool of its own
 * nav_send_to_configured_environment does it, like invoice_issue: destructive, it asks the client for the user
 * (anthropic/requiresUserInteraction), it needs the confirmation code in every mode but none, and in elicit mode the
 * dialog as well. nav_sync never sends such an invoice: nav_sync { invoice, resubmitFailed: true } only returns the
 * preview and the code. The code is bound to what the preview showed – a change of the invoice's NAV status since then
 * gives CONFIRMATION_INVALID. Both protocol eras (2025-06-18 and 2026-07-28), in memory and over the HTTP endpoint.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { startHttpServer } from '../../src/mcp/http.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig, type ConfirmMode, type NavRuntimeConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

const TOOL = 'nav_send_to_configured_environment';
const TOKEN = 'nav-send-http-test-token-0123456789-abc';
const CODE_RE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/;

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

const PROD = (): NavRuntimeConfig => ({ ...prod.runtimeConfig(), environment: 'production' });
const TEST = (): NavRuntimeConfig => ({ ...test.runtimeConfig(), environment: 'test' });

function openWith(dir: string, nav: NavRuntimeConfig, confirmMode: ConfirmMode): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav, confirmMode, navWaitSeconds: 3 } });
  return OpenSzamla.open({ config, now: () => new Date() });
}

/** An invoice issued and reported in the TEST system; the data directory then reopened with the production connection. */
async function testOnlyInvoice(confirmMode: ConfirmMode): Promise<{ app: OpenSzamla; inv: Invoice }> {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-ns3-'));
  const t = openWith(dir, TEST(), confirmMode);
  t.updateSeller(SELLER_INPUT);
  const customer = t.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const view = await t.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '2000', vatCode: '27' }] });
  const inv = (await t.issue(view.invoice.id)).invoice;
  expect(inv).toMatchObject({ navStatus: 'done', navEnvironment: 'test' });
  t.close();
  const app = openWith(dir, PROD(), confirmMode);
  cleanups.push(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, inv };
}

/** A client of `era`; with `answer` it declares form elicitation and answers every dialog with it (changeable later). */
function newClient(era: Era, answer?: { yes: boolean }): { c: Client; dialogs: string[] } {
  const c = new Client(
    { name: 'vitest-ns3', version: '1.0.0' },
    { capabilities: answer ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  const dialogs: string[] = [];
  if (answer) {
    c.setRequestHandler('elicitation/create', async (request) => {
      dialogs.push(String((request.params as { message?: unknown }).message ?? ''));
      return answer.yes ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  }
  return { c, dialogs };
}

async function inMemory(app: OpenSzamla, era: Era, confirmMode: ConfirmMode, answer?: { yes: boolean }): Promise<{ c: Client; dialogs: string[] }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(app, { confirmMode }), { transport: serverT });
  const k = newClient(era, answer);
  await k.c.connect(clientT);
  cleanups.push(async () => {
    await k.c.close();
    await handle.close();
  });
  return k;
}

/** The HTTP endpoint (openszamla serve); its confirm mode is the app's. */
async function overHttp(app: OpenSzamla, era: Era, answer?: { yes: boolean }): Promise<{ c: Client; dialogs: string[] }> {
  const http = await startHttpServer(app, { port: 0, token: TOKEN, web: false });
  const k = newClient(era, answer);
  await k.c.connect(new StreamableHTTPClientTransport(new URL(http.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  cleanups.push(async () => {
    await k.c.close();
    await http.close();
  });
  return k;
}

async function call(c: Client, name: string, args: Json): Promise<{ isError: boolean; data: Json; text: string }> {
  const raw = (await c.callTool({ name, arguments: args })) as Json;
  return { isError: raw.isError === true, data: (raw.structuredContent ?? {}) as Json, text: String(raw.content?.[0]?.text ?? '') };
}

/** What the production NAV received. */
const sentToProduction = (): string[] => prod.invoices.map((i) => `${i.invoiceNumber} ${i.invoiceStatus}`);

describe('NS3: the cross-environment send is a tool of its own, marked irreversible', () => {
  it.each<Era>(['legacy', 'modern'])('%s era: nav_send_to_configured_environment is destructive and asks the user; nav_sync takes no code', async (era) => {
    const { app } = await testOnlyInvoice('code');
    const { c } = await inMemory(app, era, 'code');
    const tools = (await c.listTools()).tools;
    const send = tools.find((t) => t.name === TOOL);
    expect(send?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(send?._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
    expect(Object.keys((send?.inputSchema as Json).properties).sort()).toEqual(['confirmationCode', 'invoice', 'waitSeconds']);
    expect((send?.inputSchema as Json).required).toEqual(['invoice']);
    expect(send?.description).toMatch(/^IRREVERSIBLE/);
    // The same hints as invoice_issue.
    const issue = tools.find((t) => t.name === 'invoice_issue');
    expect(send?.annotations).toEqual(issue?.annotations);
    expect(send?._meta).toEqual(issue?._meta);
    const sync = tools.find((t) => t.name === 'nav_sync');
    expect(sync?.annotations?.destructiveHint).toBe(false);
    expect(Object.keys((sync?.inputSchema as Json).properties).sort()).toEqual(['invoice', 'resubmitFailed', 'waitSeconds']);
  });
});

describe.each<Era>(['legacy', 'modern'])('NS3/RU1 in memory (%s era)', (era) => {
  it('code mode: nav_sync only previews (never sends); the new tool needs the code and sends once', async () => {
    const { app, inv } = await testOnlyInvoice('code');
    const { c } = await inMemory(app, era, 'code');

    const preview = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true });
    expect(preview.isError).toBe(false);
    expect(preview.data).toMatchObject({
      confirmationRequired: true,
      crossEnvironment: { invoiceId: inv.id, number: inv.number, reportedTo: 'test', navStatus: 'done', sendTo: 'production', realReport: true },
      confirmationCode: expect.stringMatching(CODE_RE),
      confirmationValidMinutes: 10,
      environment: 'production',
    });
    expect(preview.data.summary).toMatch(/ÉLES NAV-rendszerbe kerülne beküldésre.*nem vonható vissza.*Nem küldtük be: a nav_sync a másik NAV-rendszerhez tartozó számlát nem küldi be/);
    expect(preview.data.nextStep).toMatch(/hívd: nav_send_to_configured_environment \{ invoice, confirmationCode \}\.$/);
    expect(JSON.parse(preview.text)).toEqual(preview.data);
    // nav_sync never sends it – asking again previews again, and a code is no parameter of it.
    expect((await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true })).data.confirmationRequired).toBe(true);
    const withCode = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true, confirmationCode: preview.data.confirmationCode });
    expect(withCode.isError).toBe(true);
    expect(withCode.text).toMatch(/confirmationCode/);
    expect(sentToProduction()).toEqual([]);

    const noCode = await call(c, TOOL, { invoice: inv.number });
    expect(noCode.isError).toBe(true);
    expect(noCode.data.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', hint: expect.stringMatching(/nav_sync \{ invoice, resubmitFailed: true \}/) });
    const wrong = await call(c, TOOL, { invoice: inv.number, confirmationCode: 'AAAA-BBBB-CCCC-DDDD' });
    expect(wrong.data.error).toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(sentToProduction()).toEqual([]);

    const sent = await call(c, TOOL, { invoice: inv.number, confirmationCode: preview.data.confirmationCode, waitSeconds: 3 });
    expect(sent.isError, JSON.stringify(sent.data)).toBe(false);
    expect(sent.data).toMatchObject({
      summary: '1 számla feldolgozva, ebből 1 sikeresen jelentve (éles környezet).',
      environment: 'production',
      crossEnvironment: { invoiceId: inv.id, reportedTo: 'test', sendTo: 'production', realReport: true },
      results: [{ number: inv.number, navStatus: 'done', environment: 'production', note: 'A NAV sikeresen befogadta.' }],
    });
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);

    // Repeated: it belongs to production now – nothing more is sent.
    const again = await call(c, TOOL, { invoice: inv.number, confirmationCode: preview.data.confirmationCode });
    expect(again.isError).toBe(true);
    expect(again.data.error).toMatchObject({ code: 'NOT_OTHER_NAV_SYSTEM' });
    expect(again.data.error.message).toBe(`A(z) ${inv.number} számla NAV-állapota nem a másik NAV-rendszerhez tartozik (az éles NAV-rendszerhez tartozik, állapota: done): nincs mit átküldeni.`);
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });

  it('elicit mode: the code AND the dialog – no code no dialog, declined nothing, approved sent', async () => {
    const { app, inv } = await testOnlyInvoice('elicit');
    const answer = { yes: false };
    const { c, dialogs } = await inMemory(app, era, 'elicit', answer);

    const preview = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true });
    expect(preview.data).toMatchObject({ confirmationRequired: true, confirmationCode: expect.stringMatching(CODE_RE) });
    expect(preview.data.nextStep).toMatch(/nav_send_to_configured_environment \{ invoice, confirmationCode \} \(a kliens párbeszédablaka is rákérdez\)\.$/);
    expect(dialogs).toEqual([]);

    // RU1: the dialog alone is not enough.
    const noCode = await call(c, TOOL, { invoice: inv.number });
    expect(noCode.data.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(dialogs).toEqual([]);
    expect(sentToProduction()).toEqual([]);

    const declined = await call(c, TOOL, { invoice: inv.number, confirmationCode: preview.data.confirmationCode });
    expect(declined.data).toMatchObject({ status: 'cancelled_by_user' });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toBe(`Beküldöd a(z) ${inv.number} számlát az ÉLES NAV-rendszerbe? ${app.navForeignResend(inv.id)?.summary}`);
    expect(sentToProduction()).toEqual([]);

    answer.yes = true;
    const sent = await call(c, TOOL, { invoice: inv.number, confirmationCode: preview.data.confirmationCode, waitSeconds: 3 });
    expect(sent.data.results?.[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(dialogs).toHaveLength(2);
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });
});

describe('confirm mode none', () => {
  it('nav_sync still only previews (no code); the new tool sends without one', async () => {
    const { app, inv } = await testOnlyInvoice('none');
    const { c } = await inMemory(app, 'modern', 'none');
    const preview = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true });
    expect(preview.data).toMatchObject({ confirmationRequired: false, crossEnvironment: { sendTo: 'production' } });
    expect(preview.data.confirmationCode).toBeUndefined();
    expect(preview.data.nextStep).toMatch(/nav_send_to_configured_environment \{ invoice \}\.$/);
    expect(sentToProduction()).toEqual([]);
    const sent = await call(c, TOOL, { invoice: inv.number, waitSeconds: 3 });
    expect(sent.data.results?.[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });
});

describe('NS6: over the HTTP endpoint (openszamla serve)', () => {
  it('2026-07-28 client, elicit mode: declined nothing happens, approved it is sent', async () => {
    const { app, inv } = await testOnlyInvoice('elicit');
    const answer = { yes: false };
    const { c, dialogs } = await overHttp(app, 'modern', answer);
    const code = (await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true })).data.confirmationCode as string;
    expect(code).toMatch(CODE_RE);
    expect((await call(c, TOOL, { invoice: inv.number, confirmationCode: code })).data).toMatchObject({ status: 'cancelled_by_user' });
    expect(sentToProduction()).toEqual([]);
    answer.yes = true;
    const sent = await call(c, TOOL, { invoice: inv.number, confirmationCode: code, waitSeconds: 3 });
    expect(sent.data.results?.[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]).toMatch(/^Beküldöd a\(z\) .* számlát az ÉLES NAV-rendszerbe\?/);
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });

  it('2025-era client, elicit mode: ELICITATION_UNAVAILABLE_LEGACY_HTTP even with a valid code – no dialog, nothing sent', async () => {
    const { app, inv } = await testOnlyInvoice('elicit');
    const { c, dialogs } = await overHttp(app, 'legacy', { yes: true });
    const code = (await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true })).data.confirmationCode as string;
    expect(code).toMatch(CODE_RE);
    const res = await call(c, TOOL, { invoice: inv.number, confirmationCode: code });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatchObject({ code: 'ELICITATION_UNAVAILABLE_LEGACY_HTTP' });
    expect(dialogs).toEqual([]);
    expect(sentToProduction()).toEqual([]);
    expect(app.getInvoice(inv.id)).toMatchObject({ navStatus: 'done', navEnvironment: 'test' });
  });

  it.each<Era>(['legacy', 'modern'])('%s era, code mode: preview and send work over HTTP too', async (era) => {
    const { app, inv } = await testOnlyInvoice('code');
    const { c } = await overHttp(app, era);
    const code = (await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true })).data.confirmationCode as string;
    expect((await call(c, TOOL, { invoice: inv.number })).data.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const sent = await call(c, TOOL, { invoice: inv.number, confirmationCode: code, waitSeconds: 3 });
    expect(sent.data.results?.[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });
});

describe('RU2: the code is bound to what the preview showed', () => {
  it('a NAV-state change since the preview (rejected → reported in the TEST system) makes the code invalid', async () => {
    const { app, inv } = await testOnlyInvoice('code');
    // Its TEST report was rejected there.
    app.store.patchInvoice(inv.id, { navStatus: 'aborted', navMessages: [{ severity: 'ERROR', code: 'INVALID_INVOICE_REFERENCE', message: 'próba' }] });
    const { c } = await inMemory(app, 'modern', 'code');
    const preview = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true });
    expect(preview.data.crossEnvironment).toMatchObject({ navStatus: 'aborted' });
    expect(preview.data.summary).toMatch(/\(ott: elutasítva vagy hibás\)/);

    // Meanwhile a process configured for the TEST system sends it there again: reported there now.
    app.store.patchInvoice(inv.id, { navStatus: 'done', navMessages: [] });
    const stale = await call(c, TOOL, { invoice: inv.number, confirmationCode: preview.data.confirmationCode });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({
      code: 'CONFIRMATION_INVALID',
      message: 'A megerősítő kód érvénytelen vagy lejárt, vagy az előnézet óta megváltozott a számla NAV-állapota (az állapota, vagy hogy melyik NAV-rendszerhez tartozik), illetve a beállított NAV-környezet.',
    });
    expect(sentToProduction()).toEqual([]);

    // The fresh preview shows the new state, and its code sends it.
    const fresh = await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true });
    expect(fresh.data.summary).toMatch(/\(ott: jelentve\)/);
    expect(fresh.data.confirmationCode).not.toBe(preview.data.confirmationCode);
    const sent = await call(c, TOOL, { invoice: inv.number, confirmationCode: fresh.data.confirmationCode, waitSeconds: 3 });
    expect(sent.data.results?.[0]).toMatchObject({ navStatus: 'done', environment: 'production' });
    expect(sentToProduction()).toEqual([`${inv.number} DONE`]);
  });
});

describe('NV5c: the MCP tools that contact NAV pass the time limit of a call', () => {
  it('nav_sync and nav_send_to_configured_environment run with budgetMs 45 000', async () => {
    const { app, inv } = await testOnlyInvoice('code');
    const spy = vi.spyOn(app, 'navSync');
    const { c } = await inMemory(app, 'modern', 'code');
    await call(c, 'nav_sync', {});
    const code = (await call(c, 'nav_sync', { invoice: inv.number, resubmitFailed: true })).data.confirmationCode as string;
    await call(c, TOOL, { invoice: inv.number, confirmationCode: code, waitSeconds: 1 });
    expect(spy.mock.calls.map(([opts]) => opts?.budgetMs)).toEqual([45_000, 45_000]);
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ invoiceId: inv.id, resubmitFailed: true, confirmedForeign: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
