/**
 * End-to-end MCP tests: a real MCP client (SDK v2) talks to the OpenSzámla server over the in-memory
 * transport (both protocol eras) and over Streamable HTTP, exercising the whole stack
 * (service, store, calc, validation, PDF).
 */
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { AppConfig, ConfirmMode } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

type Json = Record<string, any>;
type Era = 'legacy' | 'modern';

/** fetch() cannot override the Host header, so use node:http for the DNS-rebinding check. */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(
  opts: { confirmMode?: ConfirmMode; elicit?: 'accept' | 'decline'; era?: Era; now?: () => Date; fetch?: typeof fetch; nav?: AppConfig['nav'] } = {},
): Promise<{ t: TestApp; client: Client; dialogs: string[] }> {
  const t = makeTestApp({ confirmMode: opts.confirmMode ?? 'code', ...(opts.now ? { now: opts.now } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.nav ? { nav: opts.nav } : {}) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client(
    { name: 'vitest', version: '1.0.0' },
    {
      capabilities: opts.elicit ? { elicitation: { form: {} } } : {},
      versionNegotiation: { mode: (opts.era ?? 'legacy') === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
    },
  );
  /** Messages of the human confirmation dialogs (elicitation) the server asked for. */
  const dialogs: string[] = [];
  if (opts.elicit) {
    const action = opts.elicit;
    client.setRequestHandler('elicitation/create', async (request) => {
      dialogs.push(String((request.params as { message?: unknown }).message ?? '').replace(/ /g, ' '));
      return action === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  }
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
    t.cleanup();
  });
  return { t, client, dialogs };
}

async function call(client: Client, name: string, args: Json = {}): Promise<{ data: Json; raw: Json }> {
  const raw = (await client.callTool({ name, arguments: args })) as Json;
  const first = raw.content?.[0];
  let data: Json = {};
  if (first && first.type === 'text') {
    try {
      data = JSON.parse(first.text) as Json;
    } catch {
      data = { text: first.text }; // e.g. the SDK's own "Input validation error: …" message
    }
  }
  return { data, raw };
}

async function setupSellerAndCustomer(client: Client): Promise<string> {
  const s = await call(client, 'seller_update', SELLER_INPUT);
  expect(s.raw.isError, JSON.stringify(s.data)).toBeFalsy();
  const c = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
  expect(c.raw.isError, JSON.stringify(c.data)).toBeFalsy();
  return c.data.customer.id as string;
}

async function draft(client: Client, customerId: string): Promise<Json> {
  const d = await call(client, 'invoice_draft', {
    customerId,
    lines: [
      { description: 'Szoftverfejlesztés', quantity: 10, unit: 'óra', unitPrice: 15000, vatCode: '27' },
      { description: 'Szakkönyv', quantity: 2, unit: 'db', unitPrice: '2000', vatCode: '5' },
    ],
  });
  expect(d.raw.isError, JSON.stringify(d.data)).toBeFalsy();
  return d.data;
}

const TOOL_NAMES = [
  'audit_log', 'backup_create', 'verify_integrity', 'customer_find', 'customer_save', 'exchange_rate', 'export_invoices', 'invoice_cancel', 'invoice_cancel_preview', 'invoice_correct',
  'invoice_delete_draft', 'invoice_draft', 'invoice_get', 'invoice_issue', 'invoice_list', 'invoice_pdf', 'invoice_record_payment',
  'nav_send_to_configured_environment', 'nav_sync', 'product_find', 'product_save', 'report_summary', 'series_manage', 'setup_status', 'seller_update', 'tax_audit_export', 'taxpayer_lookup',
].sort();

describe.each<Era>(['legacy', 'modern'])('MCP server over in-memory transport (%s era)', (era) => {
  it('lists every tool with annotations, resources and prompts', async () => {
    const { client } = await connect({ era });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    const issue = tools.find((t) => t.name === 'invoice_issue');
    expect(issue?.annotations?.destructiveHint).toBe(true);
    expect(issue?._meta?.['anthropic/requiresUserInteraction']).toBe(true);
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
    }
    expect(tools.find((t) => t.name === 'invoice_list')?.annotations?.readOnlyHint).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['havi_zaras', 'nav_hibaelharitas', 'szamla_kiallitas']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain('openszamla://invoices/{id}/pdf');
  });

  it('full lifecycle: draft → code → issue → pdf → pay → report → cancel preview → cancel', async () => {
    const { client, t } = await connect({ era });
    const status = await call(client, 'setup_status');
    expect(status.data.seller).toBeNull();
    expect(status.data.nextSteps.join(' ')).toMatch(/seller_update/);
    expect(status.raw.structuredContent).toEqual(status.data);

    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    expect(d.readyToIssue).toBe(true);
    expect(d.invoice.net).toBe('154000');
    expect(d.invoice.vat).toBe('40700');
    expect(d.invoice.gross).toBe('194700');
    expect(d.confirmationCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const draftId = d.invoice.id as string;

    const noCode = await call(client, 'invoice_issue', { draftId });
    expect(noCode.raw.isError).toBe(true);
    expect(noCode.data.error.code).toBe('CONFIRMATION_REQUIRED');
    const badCode = await call(client, 'invoice_issue', { draftId, confirmationCode: 'AAAA-BBBB-CCCC-DDDD' });
    expect(badCode.data.error.code).toBe('CONFIRMATION_INVALID');
    expect(t.app.getInvoice(draftId).status).toBe('draft');

    const issued = await call(client, 'invoice_issue', { draftId, confirmationCode: d.confirmationCode });
    expect(issued.raw.isError, JSON.stringify(issued.data)).toBeFalsy();
    expect(issued.data.invoice.number).toBe('SZ-2026-00001');
    expect(issued.data.invoice.navStatus).toBe('not_configured');
    expect(issued.data.notes.join(' ')).toMatch(/NAV/);
    expect(issued.raw.content.some((c: Json) => c.type === 'resource_link')).toBe(true);
    expect(existsSync(issued.data.pdfPath)).toBe(true);

    const replay = await call(client, 'invoice_issue', { draftId, confirmationCode: d.confirmationCode });
    expect(replay.raw.isError).toBeFalsy();
    expect(replay.data.repeated).toBe(true);
    expect(replay.data.invoice.number).toBe('SZ-2026-00001');

    const got = await call(client, 'invoice_get', { invoice: 'SZ-2026-00001' });
    expect(got.data.invoice.lines).toHaveLength(2);

    const pdf = await client.readResource({ uri: `openszamla://invoices/${draftId}/pdf` });
    const blob = (pdf.contents[0] as Json).blob as string;
    expect(Buffer.from(blob, 'base64').subarray(0, 4).toString()).toBe('%PDF');

    const paid = await call(client, 'invoice_record_payment', { invoice: 'SZ-2026-00001' });
    expect(paid.data.invoice.paymentStatus).toBe('paid');

    const report = await call(client, 'report_summary', { from: '2026-10-01', to: '2026-10-31' });
    expect(report.data.totalsHuf.gross).toBe('194700');

    const exp = await call(client, 'export_invoices', { from: '2026-10-01', to: '2026-10-31', format: 'csv' });
    expect(existsSync(exp.data.path)).toBe(true);

    const preview = await call(client, 'invoice_cancel_preview', { invoice: 'SZ-2026-00001', reason: 'Téves vevő' });
    expect(preview.raw.isError, JSON.stringify(preview.data)).toBeFalsy();
    const wrongReason = await call(client, 'invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Más ok', confirmationCode: preview.data.confirmationCode });
    expect(wrongReason.data.error.code).toBe('CONFIRMATION_INVALID');
    const cancel = await call(client, 'invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves vevő', confirmationCode: preview.data.confirmationCode });
    expect(cancel.raw.isError, JSON.stringify(cancel.data)).toBeFalsy();
    expect(cancel.data.invoice.documentType).toBe('storno');
    expect(cancel.data.invoice.number).toBe('SZ-2026-00002');
    expect(cancel.data.invoice.gross).toBe('-194700');
    expect(t.app.getInvoice(draftId).status).toBe('cancelled');
    const cancelReplay = await call(client, 'invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves vevő', confirmationCode: preview.data.confirmationCode });
    expect(cancelReplay.data.repeated).toBe(true);

    const report2 = await call(client, 'report_summary', { from: '2026-10-01', to: '2026-10-31' });
    expect(report2.data.totalsHuf.gross).toBe('0');

    const audit = await call(client, 'audit_log', { limit: 100 });
    expect(audit.data.total).toBeGreaterThan(5);
    const integrity = t.app.verifyIntegrity();
    expect(integrity.audit.ok).toBe(true);
    expect(integrity.invoiceMismatches).toEqual([]);
  });

  it('elicit mode asks the human; decline changes nothing', async () => {
    const accept = await connect({ era, confirmMode: 'elicit', elicit: 'accept' });
    let customerId = await setupSellerAndCustomer(accept.client);
    let d = await draft(accept.client, customerId);
    const ok = await call(accept.client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(ok.raw.isError, JSON.stringify(ok.data)).toBeFalsy();
    expect(ok.data.invoice.number).toBe('SZ-2026-00001');

    const decline = await connect({ era, confirmMode: 'elicit', elicit: 'decline' });
    customerId = await setupSellerAndCustomer(decline.client);
    d = await draft(decline.client, customerId);
    const no = await call(decline.client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(no.data.status).toBe('cancelled_by_user');
    expect(decline.t.app.getInvoice(d.invoice.id as string).status).toBe('draft');

    const unsupported = await connect({ era, confirmMode: 'elicit' });
    customerId = await setupSellerAndCustomer(unsupported.client);
    d = await draft(unsupported.client, customerId);
    const err = await call(unsupported.client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(err.data.error.code).toBe('ELICITATION_UNSUPPORTED');
  });
});

describe('MCP server behaviour', () => {
  it('returns actionable errors as tool results', async () => {
    const { client } = await connect();
    const r = await call(client, 'invoice_draft', { customer: DOMESTIC_CUSTOMER_INPUT, lines: [{ description: 'x', quantity: 1, unitPrice: 1, vatCode: '27' }] });
    expect(r.raw.isError).toBe(true);
    expect(r.data.error.code).toBe('SELLER_NOT_CONFIGURED');
    expect(r.data.error.hint).toBeTruthy();
    await setupSellerAndCustomer(client);
    const dup = await call(client, 'customer_save', DOMESTIC_CUSTOMER_INPUT);
    expect(dup.raw.isError).toBe(true);
    expect(dup.data.error.code).toBe('DUPLICATE_CUSTOMER');
    const bad = await call(client, 'invoice_draft', { customerId: 'cus_nope', lines: [{ description: 'x', quantity: 'abc', unitPrice: 1, vatCode: '27' }] });
    expect(bad.raw.isError).toBe(true);
    expect(String(bad.data.text ?? bad.data.error?.message)).toMatch(/quantity/);
    const unknown = await call(client, 'invoice_draft', { customerId: 'cus_nope', lines: [{ description: 'x', quantity: 1, unitPrice: 1, vatCode: '27' }] });
    expect(unknown.data.error.code).toBe('NOT_FOUND');
  });

  it('a draft changed after its preview invalidates the code', async () => {
    const { client } = await connect();
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    const upd = await call(client, 'invoice_draft', { draftId: d.invoice.id, comment: 'Új megjegyzés' });
    expect(upd.raw.isError, JSON.stringify(upd.data)).toBeFalsy();
    const stale = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(stale.data.error.code).toBe('CONFIRMATION_INVALID');
    const fresh = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: upd.data.confirmationCode });
    expect(fresh.raw.isError, JSON.stringify(fresh.data)).toBeFalsy();
  });

  it('seller data changed after the preview invalidates the issue code; a new correction invalidates the storno code', async () => {
    const { client } = await connect();
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    const s = await call(client, 'seller_update', { email: 'uj-cim@teszt.hu' });
    expect(s.raw.isError, JSON.stringify(s.data)).toBeFalsy();
    const stale = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(stale.data.error.code).toBe('CONFIRMATION_INVALID');
    const again = await call(client, 'invoice_get', { invoice: d.invoice.id });
    const issued = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: again.data.confirmationCode });
    expect(issued.raw.isError, JSON.stringify(issued.data)).toBeFalsy();
    const number = issued.data.invoice.number as string;

    const preview = await call(client, 'invoice_cancel_preview', { invoice: number, reason: 'Téves számla' });
    const corr = await call(client, 'invoice_correct', { invoice: number, lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] });
    expect(corr.raw.isError, JSON.stringify(corr.data)).toBeFalsy();
    const corrIssued = await call(client, 'invoice_issue', { draftId: corr.data.invoice.id, confirmationCode: corr.data.confirmationCode });
    expect(corrIssued.raw.isError, JSON.stringify(corrIssued.data)).toBeFalsy();
    const staleCancel = await call(client, 'invoice_cancel', { invoice: number, reason: 'Téves számla', confirmationCode: preview.data.confirmationCode });
    expect(staleCancel.data.error.code).toBe('CONFIRMATION_INVALID');
  });

  it('modification invoice and copy-from draft (confirmMode none)', async () => {
    const { client } = await connect({ confirmMode: 'none' });
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    expect(d.confirmationCode).toBeUndefined();
    await call(client, 'invoice_issue', { draftId: d.invoice.id });
    const corr = await call(client, 'invoice_correct', {
      invoice: 'SZ-2026-00001',
      lines: [{ description: 'Árengedmény', quantity: 1, unitPrice: -10000, vatCode: '27', unit: 'db' }],
      comment: 'Utólagos árengedmény',
    });
    expect(corr.raw.isError, JSON.stringify(corr.data)).toBeFalsy();
    expect(corr.data.invoice.documentType).toBe('modification');
    expect(corr.data.invoice.gross).toBe('-12700');
    const issuedCorr = await call(client, 'invoice_issue', { draftId: corr.data.invoice.id });
    expect(issuedCorr.data.invoice.number).toBe('SZ-2026-00002');
    expect(issuedCorr.data.invoice.originalNumber).toBe('SZ-2026-00001');

    const copy = await call(client, 'invoice_draft', { copyFromId: 'SZ-2026-00001' });
    expect(copy.raw.isError, JSON.stringify(copy.data)).toBeFalsy();
    expect(copy.data.invoice.lines).toHaveLength(2);
    expect(copy.data.invoice.status).toBe('draft');
  });
});

describe('MCP previews show what will be issued (review fixes)', () => {
  const plain = (s: string): string => s.replace(/ /g, ' ');
  const SUPPORT = [{ description: 'Support', quantity: 1, unit: 'hó', unitPrice: 1000, vatCode: '27' }];

  it('a modification draft cannot lose all its lines, and gets no confirmation code (LEGAL-1)', async () => {
    const { client } = await connect();
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    expect((await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode })).raw.isError).toBeFalsy();
    const corr = await call(client, 'invoice_correct', { invoice: 'SZ-2026-00001', lines: [{ description: 'Árengedmény', quantity: 1, unitPrice: -1000, vatCode: '27', unit: 'db' }] });
    expect(corr.raw.isError, JSON.stringify(corr.data)).toBeFalsy();
    const emptied = await call(client, 'invoice_draft', { draftId: corr.data.invoice.id, lines: [] });
    expect(emptied.raw.isError).toBe(true);
    expect(emptied.data.error.code).toBe('INVALID_INPUT');
    expect(emptied.data.error.hint).toMatch(/0 összegű tételt/);
    expect(emptied.data.confirmationCode).toBeUndefined();
    expect((await call(client, 'invoice_get', { invoice: corr.data.invoice.id })).data.invoice.lines).toHaveLength(1);
  });

  it('copyFromId of a manual-rate EUR invoice gets the MNB rate of the new fulfilment date (MCP-UX-1)', async () => {
    let clock = new Date('2026-09-30T09:00:00.000Z');
    const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="2026-09-29"&gt;&lt;Rate unit="1" curr="EUR"&gt;401,50&lt;/Rate&gt;&lt;/Day&gt;&lt;Day date="2026-10-26"&gt;&lt;Rate unit="1" curr="EUR"&gt;390,12&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
    const mnb = (async () => new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } })) as unknown as typeof fetch;
    const { client } = await connect({ confirmMode: 'none', now: () => clock, fetch: mnb });
    const customerId = await setupSellerAndCustomer(client);
    const src = await call(client, 'invoice_draft', { customerId, currency: 'EUR', exchangeRate: 401.5, lines: SUPPORT });
    expect(src.data.invoice.exchangeRate).toEqual({ rate: '401.5', date: '2026-09-30', source: 'manual' });
    expect((await call(client, 'invoice_issue', { draftId: src.data.invoice.id })).data.invoice.number).toBe('SZ-2026-00001');
    clock = new Date('2026-10-27T09:00:00.000Z');
    const copy = await call(client, 'invoice_draft', { copyFromId: 'SZ-2026-00001' });
    expect(copy.data.invoice.exchangeRate).toEqual({ rate: '390.12', date: '2026-10-26', source: 'MNB' });
    const moved = await call(client, 'invoice_draft', { draftId: copy.data.invoice.id, fulfillmentDate: '2026-10-26' });
    expect(moved.data.invoice.exchangeRate).toEqual({ rate: '390.12', date: '2026-10-26', source: 'MNB' });
    expect(moved.data.invoice.totalsHuf.vat).toBe('105332.4');
  });

  it('the preview shows the dates issuing gives today; an explicit due date is kept (MCP-UX-4)', async () => {
    let clock = new Date('2026-10-26T09:00:00.000Z');
    const { client } = await connect({ now: () => clock });
    const customerId = await setupSellerAndCustomer(client);
    const d = await call(client, 'invoice_draft', { customerId, dueDate: '2026-11-15', lines: SUPPORT });
    const past = await call(client, 'invoice_draft', { customerId, issueDate: '2026-10-20', fulfillmentDate: '2026-10-20', lines: SUPPORT });
    expect(past.data.invoice.issueDate).toBe('2026-10-26');
    expect(past.data.issues.map((i: Json) => i.code)).toContain('ISSUE_DATE_WILL_CHANGE');
    clock = new Date('2026-10-27T09:00:00.000Z');
    const got = await call(client, 'invoice_get', { invoice: d.data.invoice.id });
    expect([got.data.invoice.issueDate, got.data.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-15']);
    expect(got.data.issues.map((i: Json) => i.code)).toContain('ISSUE_DATE_WILL_CHANGE');
    const stale = await call(client, 'invoice_issue', { draftId: d.data.invoice.id, confirmationCode: d.data.confirmationCode });
    expect(stale.data.error.code).toBe('CONFIRMATION_INVALID');
    const issued = await call(client, 'invoice_issue', { draftId: d.data.invoice.id, confirmationCode: got.data.confirmationCode });
    expect(issued.raw.isError, JSON.stringify(issued.data)).toBeFalsy();
    expect([issued.data.invoice.issueDate, issued.data.invoice.dueDate]).toEqual([got.data.invoice.issueDate, got.data.invoice.dueDate]);
  });

  it('the issue dialog depends on the document type and on the NAV setup (MCP-UX-4)', async () => {
    const { client, dialogs } = await connect({ confirmMode: 'elicit', elicit: 'accept' });
    const customerId = await setupSellerAndCustomer(client);
    const pro = await call(client, 'invoice_draft', { documentType: 'proforma', customerId, lines: SUPPORT });
    expect((await call(client, 'invoice_issue', { draftId: pro.data.invoice.id, confirmationCode: pro.data.confirmationCode })).raw.isError).toBeFalsy();
    const inv = await draft(client, customerId);
    expect((await call(client, 'invoice_issue', { draftId: inv.invoice.id, confirmationCode: inv.confirmationCode })).raw.isError).toBeFalsy();
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]).toMatch(/^Kiállítod a díjbekérőt\?/);
    expect(dialogs[0]).toContain('A díjbekérő nem számla, a NAV-nak nem kerül jelentésre.');
    expect(dialogs[0]).not.toMatch(/NAV-nak (azonnal )?jelentésre kerül/);
    expect(dialogs[0]).toContain('kelte: 2026-10-27');
    expect(dialogs[1]).toMatch(/^Kiállítod a számlát\?/);
    expect(dialogs[1]).toContain('fizetési határidő: 2026-11-04');
    expect(dialogs[1]).toContain('A NAV-kapcsolat nincs beállítva');
  });

  it('the storno preview and dialog show the storno amount: the original and its corrections negated (MCP-UX-3)', async () => {
    const { client, dialogs } = await connect({ confirmMode: 'elicit', elicit: 'accept' });
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    const corr = await call(client, 'invoice_correct', { invoice: 'SZ-2026-00001', lines: [{ description: 'Árengedmény', quantity: 1, unitPrice: -10000, vatCode: '27', unit: 'db' }], comment: 'Kedvezmény' });
    await call(client, 'invoice_issue', { draftId: corr.data.invoice.id, confirmationCode: corr.data.confirmationCode });
    const preview = await call(client, 'invoice_cancel_preview', { invoice: 'SZ-2026-00001', reason: 'Téves számla' });
    expect(preview.data.storno).toMatchObject({ currency: 'HUF', gross: '-182000', negates: [{ number: 'SZ-2026-00002', gross: '-12700' }] });
    expect(plain(preview.data.summary)).toContain('bruttó -182 000 Ft');
    expect(plain(preview.data.summary)).toContain('SZ-2026-00002: bruttó -12 700 Ft');
    const cancel = await call(client, 'invoice_cancel', { invoice: 'SZ-2026-00001', reason: 'Téves számla', confirmationCode: preview.data.confirmationCode });
    expect(cancel.raw.isError, JSON.stringify(cancel.data)).toBeFalsy();
    expect(cancel.data.invoice.gross).toBe(preview.data.storno.gross);
    expect(dialogs.at(-1)).toContain('bruttó -182 000 Ft');
    expect(dialogs.at(-1)).toContain('SZ-2026-00002');
  });

  it('MNB unreachable: one EXCHANGE_RATE_MISSING and "1 hiba", the same in invoice_get (MCP-UX-12)', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { client } = await connect({ fetch: down });
    const customerId = await setupSellerAndCustomer(client);
    const d = await call(client, 'invoice_draft', { customerId, currency: 'EUR', lines: SUPPORT });
    expect(d.data.issues.filter((i: Json) => i.code === 'EXCHANGE_RATE_MISSING')).toHaveLength(1);
    expect(d.data.nextStep).toMatch(/^1 hiba javítandó/);
    expect((await call(client, 'invoice_get', { invoice: d.data.invoice.id })).data.issues).toEqual(d.data.issues);
  });
});

describe('MCP: NAV results (fake NAV server)', () => {
  it('every NAV result names the TEST environment: nothing was reported for real (MCP-UX-5)', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    cleanups.push(() => nav.stop());
    const { client } = await connect({ nav: nav.runtimeConfig(), now: () => new Date() });
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    const issued = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(issued.raw.isError, JSON.stringify(issued.data)).toBeFalsy();
    expect(issued.data.summary).toContain('NAV (TESZT környezet): done – éles adatszolgáltatás NEM történt.');
    expect(issued.data.nav).toMatchObject({ navStatus: 'done', environment: 'test' });
    expect(issued.data.nav.note).toMatch(/TESZT rendszere/);
    expect(issued.data.notes.join(' ')).toMatch(/TESZT környezet/);
    expect(issued.raw.structuredContent).toEqual(issued.data);
    const sync = await call(client, 'nav_sync', { invoice: issued.data.invoice.number });
    expect(sync.data).toMatchObject({ environment: 'test', results: [{ environment: 'test' }] });
    expect(sync.data.summary).toContain('TESZT rendszerébe – éles adatszolgáltatás NEM történt');
    const preview = await call(client, 'invoice_cancel_preview', { invoice: issued.data.invoice.number, reason: 'Teszt' });
    expect(preview.data.summary).toContain('TESZT környezetre mutat');
    const storno = await call(client, 'invoice_cancel', { invoice: issued.data.invoice.number, reason: 'Teszt', confirmationCode: preview.data.confirmationCode });
    expect(storno.data.summary).toContain('NAV (TESZT környezet): done');
  });

  it('unusable NAV settings: setup_status names the problem, and invoice_issue reports success with the problem (BIZ-5)', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    cleanups.push(() => nav.stop());
    const config = nav.runtimeConfig();
    const { client } = await connect({ nav: { ...config, credentials: { ...config.credentials, login: 'tech.user' } } });
    const status = await call(client, 'setup_status');
    expect(status.data.nav).toMatchObject({ configured: false, problem: expect.stringMatching(/login név/) });
    expect(status.data.nextSteps.join(' ')).toMatch(/NAV-kapcsolat beállítása hibás/);
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    const issued = await call(client, 'invoice_issue', { draftId: d.invoice.id, confirmationCode: d.confirmationCode });
    expect(issued.raw.isError, JSON.stringify(issued.data)).toBeFalsy();
    expect(issued.data.summary).toMatch(/^Kiállítva: SZ-2026-00001/);
    expect(issued.data.invoice.navStatus).toBe('not_configured');
    expect(issued.data.notes.join(' ')).toMatch(/beállítása hibás/);
    expect(nav.requests).toHaveLength(0);
  });
});

describe('MCP server over Streamable HTTP', () => {
  it('requires the token, checks Host/Origin and serves both eras', async () => {
    const t = makeTestApp();
    const http = await startHttpServer(t.app, { port: 0, token: 'test-token-0123456789-0123456789-abc', web: false });
    cleanups.push(async () => {
      await http.close();
      t.cleanup();
    });

    const unauth = await fetch(http.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect(await statusWithHost(`${http.url}/healthz`, 'evil.example')).toBe(403);
    expect(await statusWithHost(`${http.url}/healthz`, `localhost:${new URL(http.url).port}`)).toBe(200);
    const evilOrigin = await fetch(`${http.url}/healthz`, { headers: { origin: 'https://evil.example' } });
    expect(evilOrigin.status).toBe(403);
    const otherLocalPort = await fetch(`${http.url}/healthz`, { headers: { origin: 'http://localhost' } });
    expect(otherLocalPort.status).toBe(403);
    const sameOrigin = await fetch(`${http.url}/healthz`, { headers: { origin: `http://localhost:${new URL(http.url).port}` } });
    expect(sameOrigin.status).toBe(200);
    expect((await fetch(`${http.url}/healthz`)).status).toBe(200);

    for (const mode of ['legacy', 'auto'] as const) {
      const client = new Client({ name: `vitest-http-${mode}`, version: '1.0.0' }, { versionNegotiation: { mode } });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.mcpUrl), { requestInit: { headers: { authorization: 'Bearer test-token-0123456789-0123456789-abc' } } }));
      cleanups.push(() => client.close());
      const { tools } = await client.listTools();
      expect(tools.length).toBe(TOOL_NAMES.length);
      const r = (await client.callTool({ name: 'setup_status', arguments: {} })) as Json;
      expect(r.isError).toBeFalsy();
    }

    const pathClient = new Client({ name: 'vitest-path', version: '1.0.0' });
    await pathClient.connect(new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/test-token-0123456789-0123456789-abc`)));
    cleanups.push(() => pathClient.close());
    expect((await pathClient.listTools()).tools.length).toBe(TOOL_NAMES.length);
  });
});

describe('MCP input handling and the data tools (review fixes)', () => {
  const LINE = [{ description: 'Support', quantity: 1, unit: 'hó', unitPrice: 1000, vatCode: '27' }];
  const EU = { vatStatus: 'OTHER', name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } };

  it.each<Era>(['legacy', 'modern'])('unknown (misspelt) arguments are rejected, nested ones too; every input schema says additionalProperties: false (MCP-UX-9, %s era)', async (era) => {
    const { client } = await connect({ era });
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(Object.keys(tool.inputSchema).filter((k) => ['anyOf', 'oneOf', 'allOf'].includes(k)), tool.name).toEqual([]);
    }
    const draftSchema = tools.find((t) => t.name === 'invoice_draft')?.inputSchema as Json;
    expect(draftSchema.properties.lines.items.additionalProperties).toBe(false);
    expect(draftSchema.properties.customer.additionalProperties).toBe(false);
    expect(draftSchema.properties.customer.properties.address.additionalProperties).toBe(false);

    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    const typo = await call(client, 'invoice_draft', { draftId: d.invoice.id, dueDays: 30 });
    expect(typo.raw.isError).toBe(true);
    expect(String(typo.data.text)).toMatch(/dueDays/);
    expect((await call(client, 'invoice_get', { invoice: d.invoice.id })).data.invoice.dueDate).toBe(d.invoice.dueDate);
    const nested = await call(client, 'invoice_draft', { customerId, lines: [{ ...LINE[0], vat: '27' }] });
    expect(nested.raw.isError).toBe(true);
    expect(String(nested.data.text)).toMatch(/"vat"/);
    const period = await call(client, 'report_summary', { start: '2026-09-01', end: '2026-09-30' });
    expect(period.raw.isError).toBe(true);
    expect(String(period.data.text)).toMatch(/start/);
    const list = await call(client, 'invoice_list', { customer: 'Nincs Ilyen Kft.' });
    expect(list.raw.isError).toBe(true);
  });

  it('invoice_list with paymentStatus alone lists the receivables – what setup_status counts as unpaid (MCP-UX-8)', async () => {
    const { client } = await connect({ confirmMode: 'none' });
    const customerId = await setupSellerAndCustomer(client);
    const issue = async (args: Json): Promise<Json> => {
      const d = await call(client, 'invoice_draft', { customerId, lines: LINE, ...args });
      const r = await call(client, 'invoice_issue', { draftId: d.data.invoice.id });
      expect(r.raw.isError, JSON.stringify(r.data)).toBeFalsy();
      return r.data.invoice as Json;
    };
    const open = await issue({});
    const cancelled = await issue({});
    expect((await call(client, 'invoice_cancel', { invoice: cancelled.number, reason: 'Téves számla' })).raw.isError).toBeFalsy();
    const credited = await issue({});
    const corr = await call(client, 'invoice_correct', { invoice: credited.number, lines: [{ description: 'Árengedmény', quantity: 1, unit: 'db', unitPrice: -100, vatCode: '27' }] });
    expect((await call(client, 'invoice_issue', { draftId: corr.data.invoice.id })).raw.isError).toBeFalsy();
    await issue({ documentType: 'proforma' });
    await call(client, 'invoice_draft', { customerId, lines: LINE });

    const unpaid = await call(client, 'invoice_list', { paymentStatus: ['unpaid'] });
    expect(unpaid.data.filters).toMatchObject({ paymentStatus: ['unpaid'], receivablesOnly: true });
    expect(unpaid.data.invoices.map((i: Json) => i.number).sort()).toEqual([open.number, credited.number].sort());
    expect(unpaid.data.total).toBe((await call(client, 'setup_status')).data.counts.unpaid);
    // With a status or a document type the payment status filters every kind of document.
    const literal = await call(client, 'invoice_list', { status: ['issued'], paymentStatus: ['unpaid'] });
    expect(literal.data.filters.receivablesOnly).toBeUndefined();
    // + storno, díjbekérő; the crediting modification is set off against its unpaid original (MCP-6): settled.
    expect(literal.data.total).toBe(4);
  });

  it('customer_save with an id changes only the given fields; null clears; archived hides and restores (MCP-UX-7, DOC-5)', async () => {
    const { client } = await connect();
    await call(client, 'seller_update', SELLER_INPUT);
    const created = await call(client, 'customer_save', { ...EU, email: 'info@beispiel.de', phone: '+49 30 1234567', bankAccount: 'DE89370400440532013000' });
    expect(created.raw.isError, JSON.stringify(created.data)).toBeFalsy();
    const id = created.data.customer.id as string;
    const email = await call(client, 'customer_save', { id, email: 'uj@beispiel.de' });
    expect(email.raw.isError, JSON.stringify(email.data)).toBeFalsy();
    expect(email.data.customer).toMatchObject({ vatStatus: 'OTHER', euVatNumber: 'DE123456789', phone: '+49 30 1234567', email: 'uj@beispiel.de' });
    expect(email.data.customer.bankAccount).toBeTruthy();
    expect((await call(client, 'customer_save', { id, phone: null })).data.customer.phone).toBeUndefined();
    const moved = await call(client, 'customer_save', { id, address: { postalCode: '10117', city: 'Berlin', addressLine: 'Unter den Linden 1' } });
    expect(moved.data.customer.address).toEqual({ countryCode: 'DE', postalCode: '10117', city: 'Berlin', addressLine: 'Unter den Linden 1' });
    // The EU VAT number was kept: a reverse-charge service is still possible.
    const d = await call(client, 'invoice_draft', { customerId: id, lines: [{ description: 'Consulting', quantity: 1, unit: 'óra', unitPrice: 1000, vatCode: 'EUFAD37' }] });
    expect(d.data.issues.map((i: Json) => i.code)).not.toContain('EU_CODE_CUSTOMER_EU_VAT_REQUIRED');

    expect((await call(client, 'customer_save', { id, archived: true })).data.customer.archived).toBe(true);
    expect((await call(client, 'customer_find', { query: 'Beispiel' })).data.total).toBe(0);
    expect((await call(client, 'customer_save', { id, archived: false })).data.customer.archived).toBe(false);
    expect((await call(client, 'customer_find', { query: 'Beispiel' })).data.total).toBe(1);
    const incomplete = await call(client, 'customer_save', { name: 'Hiányos Kft.' });
    expect(incomplete.data.error.code).toBe('INVALID_INPUT');
    expect(incomplete.data.error.hint).toBeTruthy();
  });

  it('report_summary and export_invoices take and echo dateBasis; havi_zaras asks for the VAT summary by fulfilment date (MCP-UX-6)', async () => {
    const { client } = await connect();
    await setupSellerAndCustomer(client);
    const r = await call(client, 'report_summary', { from: '2026-09-01', to: '2026-09-30', dateBasis: 'fulfillment' });
    expect(r.data).toMatchObject({ from: '2026-09-01', to: '2026-09-30', dateBasis: 'fulfillment', invoiceCount: 0 });
    expect((await call(client, 'report_summary', {})).data).toMatchObject({ from: '2026-10-01', to: '2026-10-27', dateBasis: 'issue' });
    const e = await call(client, 'export_invoices', { from: '2026-09-01', to: '2026-09-30', dateBasis: 'fulfillment' });
    expect(e.data).toMatchObject({ count: 0, dateBasis: 'fulfillment', from: '2026-09-01', to: '2026-09-30' });
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'report_summary')?.inputSchema as Json;
    expect(schema.properties.dateBasis.enum).toEqual(['issue', 'fulfillment', 'payment']);
    expect(schema.properties.from.description).toMatch(/dateBasis/);
    const prompt = await client.getPrompt({ name: 'havi_zaras', arguments: { honap: '2026-09' } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('dateBasis: "fulfillment"');
    expect(text).toContain('teljesítés szerinti összesítés');
  });

  it('invoice_pdf refuses a network folder without connecting to it (SEC-1)', async () => {
    const { client } = await connect({ confirmMode: 'none' });
    const customerId = await setupSellerAndCustomer(client);
    const d = await draft(client, customerId);
    expect((await call(client, 'invoice_issue', { draftId: d.invoice.id })).raw.isError).toBeFalsy();
    const started = Date.now();
    const r = await call(client, 'invoice_pdf', { invoice: 'SZ-2026-00001', copyToDir: '\\\\192.0.2.1\\share' });
    expect(r.data.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('UNC') });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
