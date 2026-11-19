/**
 * NavClient against the fake NAV server (real HTTP on 127.0.0.1): happy path, NAV errors, retry
 * classification, timeouts, taxpayer queries and secret hygiene.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { passwordHash } from '../../src/nav/crypto.ts';
import { buildManageInvoiceRequest, buildTokenExchangeRequest, navErrorInfo, type NavRequestContext } from '../../src/nav/api-xml.ts';
import { isRetryableNavError, NavClient, NavError, parseRetryAfter, type ManageInvoiceItem, type NavClientOptions } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import { CUSTOMER_PRIVATE, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM, INVOICE_STORNO } from '../fixtures/invoices.ts';
import { FAKE_NAV_SOFTWARE, startFakeNav, stopFakeNav, type FakeNavServer } from '../helpers/fake-nav.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

/** Same seller as the technical user (12345676), private person buyer. */
const INVOICE_PRIVATE_NORMAL: Invoice = { ...INVOICE_DOMESTIC, id: 'inv_00000000a6', number: 'SZ-2026-00006', customer: CUSTOMER_PRIVATE, orderNumber: null };

let nav: FakeNavServer;

beforeAll(async () => {
  nav = await startFakeNav();
});

afterAll(async () => {
  await stopFakeNav(nav);
});

beforeEach(() => {
  nav.reset();
  nav.setReceivedPolls(1);
});

function client(over: Partial<NavClientOptions> = {}): NavClient {
  return new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE, ...over });
}

function item(index: number, inv: Invoice): ManageInvoiceItem {
  return { index, operation: navOperationFor(inv), invoiceDataBase64: Buffer.from(buildInvoiceDataXml(inv), 'utf8').toString('base64') };
}

function xmlItem(index: number, operation: ManageInvoiceItem['operation'], xml: string): ManageInvoiceItem {
  return { index, operation, invoiceDataBase64: Buffer.from(xml, 'utf8').toString('base64') };
}

async function navError(p: Promise<unknown>): Promise<NavError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(NavError);
    return e as NavError;
  }
  throw new Error('expected a NavError');
}

/** Submits and polls until the final status. */
async function submitAndWait(c: NavClient, items: ManageInvoiceItem[]) {
  const { transactionId } = await c.manageInvoice(items);
  for (let i = 0; i < 5; i++) {
    const r = await c.queryTransactionStatus(transactionId);
    if (r.results.length && r.results.every((x) => x.invoiceStatus === 'DONE' || x.invoiceStatus === 'ABORTED')) return { transactionId, ...r };
  }
  throw new Error('no final status');
}

/** Every value that must never leave the client. */
function secrets(): string[] {
  const c = nav.credentials;
  return [c.password, passwordHash(c.password), c.signingKey, c.exchangeKey, ...(nav.lastIssuedToken ? [nav.lastIssuedToken] : [])];
}

function expectNoSecrets(text: string): void {
  for (const s of secrets()) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
}

function errorTexts(e: NavError): string {
  return [e.message, e.hint ?? '', String(e), e.stack ?? '', JSON.stringify(e), inspect(e, { depth: 5 })].join('\n');
}

// ---------------------------------------------------------------------------------------------

describe('NavClient – happy path', () => {
  it('tokenExchange decodes the AES-encrypted token', async () => {
    const t = await client().tokenExchange();
    expect(t.token).toBe(nav.lastIssuedToken);
    expect(t.validFrom).toMatch(/Z$/);
    expect(new Date(t.validTo as string).getTime() - new Date(t.validFrom as string).getTime()).toBe(5 * 60_000);
  });

  it('manageInvoice → RECEIVED → DONE for three invoices in one request', async () => {
    const c = client();
    const items = [item(1, INVOICE_DOMESTIC), item(2, INVOICE_EU_SERVICE), item(3, INVOICE_PRIVATE_NORMAL)];
    const { transactionId, requestId } = await c.manageInvoice(items);
    expect(transactionId).toMatch(/^[A-Z0-9]{16}$/);
    expect(requestId).toMatch(/^[+a-zA-Z0-9_]{1,30}$/);
    expect(nav.requests.map((r) => [r.operation, r.status])).toEqual([
      ['tokenExchange', 200],
      ['manageInvoice', 200],
    ]);
    expect(nav.requests[1]?.requestId).toBe(requestId);

    const first = await c.queryTransactionStatus(transactionId);
    expect(first.results).toEqual([1, 2, 3].map((index) => ({ index, invoiceStatus: 'RECEIVED', messages: [] })));
    const second = await c.queryTransactionStatus(transactionId);
    expect(second.results).toEqual([1, 2, 3].map((index) => ({ index, invoiceStatus: 'DONE', messages: [] })));
    expect(second.responseXml).toContain('QueryTransactionStatusResponse');
    expectNoSecrets(second.responseXml);

    // the fake decoded exactly what we built
    expect(nav.invoices.map((r) => [r.index, r.operation, r.invoiceNumber, r.invoiceStatus])).toEqual([
      [1, 'CREATE', 'SZ-2026-00001', 'DONE'],
      [2, 'CREATE', 'SZ-2026-00003', 'DONE'],
      [3, 'CREATE', 'SZ-2026-00006', 'DONE'],
    ]);
    expect(nav.invoices[0]?.xml).toBe(buildInvoiceDataXml(INVOICE_DOMESTIC));
  });

  it("an invoice of another taxpayer is ABORTED (SUPPLIER_TAX_NUMBER_MISMATCH), like NAV does", async () => {
    // INVOICE_PRIVATE_AAM is issued by SELLER_AAM (11223346), the technical user belongs to 12345676.
    const { results } = await submitAndWait(client(), [item(1, INVOICE_PRIVATE_AAM)]);
    expect(results[0]?.invoiceStatus).toBe('ABORTED');
    expect(results[0]?.messages.map((m) => m.code)).toEqual(['SUPPLIER_TAX_NUMBER_MISMATCH']);
  });

  it('storno after the original is DONE', async () => {
    const c = client();
    expect((await submitAndWait(c, [item(1, INVOICE_DOMESTIC)])).results[0]?.invoiceStatus).toBe('DONE');
    const storno = await submitAndWait(c, [item(1, INVOICE_STORNO)]);
    expect(storno.results).toEqual([{ index: 1, invoiceStatus: 'DONE', messages: [] }]);
    expect(nav.invoices[1]?.operation).toBe('STORNO');
  });

  it('every request we send and every answer of the fake is valid against invoiceApi.xsd', async () => {
    const c = client();
    await submitAndWait(c, [item(1, INVOICE_DOMESTIC)]);
    await c.queryTaxpayer('87654323');
    await c.queryTaxpayer('11111111');
    expect(nav.requests.length).toBe(6);
    for (const r of nav.requests) {
      expect((await validateNavXml(r.requestXml, 'api')).errors).toEqual([]);
      expect((await validateNavXml(r.responseXml as string, 'api')).errors).toEqual([]);
    }
  });

  it('uses the injected fetch with POST, application/xml and the operation endpoint', async () => {
    const calls: Array<{ url: string; method: string | undefined; headers: Record<string, string> }> = [];
    const spy: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
      return fetch(input, init);
    };
    await client({ fetch: spy, baseUrl: `${nav.url}/` }).queryTaxpayer('87654323');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${nav.url}/queryTaxpayer`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['Content-Type']).toMatch(/^application\/xml/);
    expect(calls[0]?.headers.Accept).toBe('application/xml');
  });
});

describe('NavClient – processing results with validation messages', () => {
  it('ABORTED with businessValidationMessages is surfaced (code, severity, pointer); WARN keeps DONE', async () => {
    nav.addBusinessMessage('SZ-2026-00001', { result: 'ERROR', code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már létezik.', tag: 'invoiceNumber', value: 'SZ-2026-00001' });
    nav.addBusinessMessage('SZ-2026-00003', { result: 'WARN', code: 'INCORRECT_HEAD_DATA_CUSTOMER_COMMUNITY_VAT_NUMBER', message: 'Ellenőrizd a közösségi adószámot.', line: 1 });
    const { results } = await submitAndWait(client(), [item(1, INVOICE_DOMESTIC), item(2, INVOICE_EU_SERVICE)]);
    expect(results).toEqual([
      {
        index: 1,
        invoiceStatus: 'ABORTED',
        messages: [{ severity: 'ERROR', code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már létezik.', pointer: 'tag: invoiceNumber; value: SZ-2026-00001' }],
      },
      {
        index: 2,
        invoiceStatus: 'DONE',
        messages: [{ severity: 'WARN', code: 'INCORRECT_HEAD_DATA_CUSTOMER_COMMUNITY_VAT_NUMBER', message: 'Ellenőrizd a közösségi adószámot.', pointer: 'line: 1' }],
      },
    ]);
  });

  it('a schema-invalid invoiceData comes back ABORTED with SCHEMA_VIOLATION', async () => {
    const xml = buildInvoiceDataXml(INVOICE_DOMESTIC).replace(/<supplierName>[^<]*<\/supplierName>/, '');
    const { results } = await submitAndWait(client(), [{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(xml).toString('base64') }]);
    expect(results[0]?.invoiceStatus).toBe('ABORTED');
    expect(results[0]?.messages[0]).toMatchObject({ severity: 'ERROR', code: 'SCHEMA_VIOLATION' });
    expect(results[0]?.messages[0]?.message).toMatch(/supplier/);
  });

  it('a storno of an unknown original is ABORTED with INVALID_INVOICE_REFERENCE', async () => {
    const { results } = await submitAndWait(client(), [item(1, INVOICE_STORNO)]);
    expect(results[0]).toMatchObject({ index: 1, invoiceStatus: 'ABORTED' });
    expect(results[0]?.messages).toEqual([
      { severity: 'ERROR', code: 'INVALID_INVOICE_REFERENCE', message: 'A hivatkozott számla nem található.', pointer: 'tag: originalInvoiceNumber; value: SZ-2026-00001' },
    ]);
  });

  it('lineOperation=MODIFY is rejected like NAV does (INVALID_LINE_OPERATION)', async () => {
    const c = client();
    await submitAndWait(c, [item(1, INVOICE_DOMESTIC)]);
    const modification: Invoice = { ...INVOICE_STORNO, documentType: 'modification', number: 'SZ-2026-00005' };
    // The builder refuses MODIFY lines itself, so hand-edit the report: "modify" original lines 1 and 2.
    const xml = buildInvoiceDataXml(modification)
      .replace(/<lineNumberReference>3</, '<lineNumberReference>1<')
      .replace(/<lineNumberReference>4</, '<lineNumberReference>2<')
      .replaceAll('<lineOperation>CREATE</lineOperation>', '<lineOperation>MODIFY</lineOperation>');
    const { results } = await submitAndWait(c, [xmlItem(1, 'MODIFY', xml)]);
    expect(results[0]?.invoiceStatus).toBe('ABORTED');
    expect(results[0]?.messages.map((m) => m.code)).toEqual(['INVALID_LINE_OPERATION', 'INVALID_LINE_OPERATION']);
  });

  it('a correction may not re-create an existing chain line or reuse a modificationIndex (like NAV)', async () => {
    const c = client();
    await submitAndWait(c, [item(1, INVOICE_DOMESTIC)]);
    // 1st modification: new lines 3 and 4, modificationIndex 1 → DONE
    const first: Invoice = { ...INVOICE_STORNO, documentType: 'modification', number: 'SZ-2026-00007' };
    expect((await submitAndWait(c, [item(1, first)])).results[0]?.invoiceStatus).toBe('DONE');
    // 2nd one wrongly reuses line 4 and modificationIndex 1
    const second: Invoice = {
      ...first,
      number: 'SZ-2026-00008',
      lines: first.lines.map((l, i) => ({ ...l, modificationRef: { lineNumberReference: 4 + i, lineOperation: 'CREATE' as const } })),
    };
    const { results } = await submitAndWait(c, [item(1, second)]);
    expect(results[0]?.invoiceStatus).toBe('ABORTED');
    expect(results[0]?.messages.map((m) => [m.code, m.pointer])).toEqual([
      ['MODIFICATION_INDEX_NOT_UNIQUE', 'tag: modificationIndex; value: 1'],
      ['INVOICE_LINE_ALREADY_EXISTS', 'tag: lineNumberReference; value: 4; line: 1'],
    ]);
    // continuing the chain correctly (5, 6 with modificationIndex 2) is accepted
    const third: Invoice = {
      ...second,
      number: 'SZ-2026-00009',
      reference: { ...(first.reference as NonNullable<Invoice['reference']>), modificationIndex: 2 },
      lines: first.lines.map((l, i) => ({ ...l, modificationRef: { lineNumberReference: 5 + i, lineOperation: 'CREATE' as const } })),
    };
    expect((await submitAndWait(c, [item(1, third)])).results).toEqual([{ index: 1, invoiceStatus: 'DONE', messages: [] }]);
  });

  /** XSD-valid hand edits of our own reports, each tripping one of NAV's blocking business rules. */
  const blockingCases: Array<[string, () => string, string[]]> = [
    ['HUF with an exchange rate other than 1', () => buildInvoiceDataXml(INVOICE_DOMESTIC).replace('<exchangeRate>1</exchangeRate>', '<exchangeRate>2</exchangeRate>'), ['INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF']],
    ['a VAT rate NAV does not know (0.3)', () => buildInvoiceDataXml(INVOICE_DOMESTIC).replaceAll('<vatPercentage>0.27</vatPercentage>', '<vatPercentage>0.3</vatPercentage>'), ['INVALID_VAT_DATA', 'INVALID_VAT_DATA']],
    ['a line without description', () => buildInvoiceDataXml(INVOICE_DOMESTIC).replace(/<lineDescription>[^<]*<\/lineDescription>/, ''), ['MANDATORY_LINE_CONTENT_MISSING']],
    ['an invoice without lines', () => buildInvoiceDataXml(INVOICE_DOMESTIC).replace(/<invoiceLines>[\s\S]*<\/invoiceLines>/, ''), ['INVOICE_LINE_MISSING']],
    [
      'an exempt line and summary row carrying VAT',
      () => buildInvoiceDataXml(INVOICE_DOMESTIC).replaceAll('<vatPercentage>0.05</vatPercentage>', '<vatExemption><case>TAM</case><reason>Tárgyi adómentes</reason></vatExemption>'),
      ['INCORRECT_LINE_DATA_VAT_EXEMPTION_NORMAL', 'INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL'],
    ],
    [
      'EUFAD37 to a DOMESTIC customer',
      () => buildInvoiceDataXml(INVOICE_EU_SERVICE).replace('<customerVatStatus>OTHER</customerVatStatus>', '<customerVatStatus>DOMESTIC</customerVatStatus>'),
      ['INCORRECT_LINE_DATA_VAT_STATUS_VAT_DATA_MISMATCH_EUFAD37', 'MISSING_CUSTOMER_DOMESTIC_TAXNUMBER'],
    ],
  ];

  it.each(blockingCases)('%s is ABORTED with the NAV error code', async (_name, makeXml, codes) => {
    const xml = makeXml();
    expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
    const { results } = await submitAndWait(client(), [xmlItem(1, 'CREATE', xml)]);
    expect(results[0]?.invoiceStatus).toBe('ABORTED');
    expect(results[0]?.messages.map((m) => m.code)).toEqual(codes);
  });

  it('two lines of a correction referencing the same line number are ABORTED (LINE_NUMBER_REFERENCE_NOT_UNIQUE)', async () => {
    const c = client();
    await submitAndWait(c, [item(1, INVOICE_DOMESTIC)]);
    const xml = buildInvoiceDataXml(INVOICE_STORNO).replace('<lineNumberReference>4</lineNumberReference>', '<lineNumberReference>3</lineNumberReference>');
    const { results } = await submitAndWait(c, [xmlItem(1, 'STORNO', xml)]);
    expect(results[0]?.messages.map((m) => [m.code, m.pointer])).toEqual([['LINE_NUMBER_REFERENCE_NOT_UNIQUE', 'tag: lineNumberReference; value: 3; line: 2']]);
  });

  it('several RECEIVED polls are configurable', async () => {
    nav.setReceivedPolls(3);
    const c = client();
    const { transactionId } = await c.manageInvoice([item(1, INVOICE_DOMESTIC)]);
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await c.queryTransactionStatus(transactionId)).results[0]?.invoiceStatus ?? '-');
    expect(statuses).toEqual(['RECEIVED', 'RECEIVED', 'RECEIVED', 'DONE']);
  });

  it('an unknown transaction has no results', async () => {
    expect((await client().queryTransactionStatus('UNKNOWN123')).results).toEqual([]);
  });
});

describe('NavClient – errors and retry classification', () => {
  it('wrong signing key → INVALID_REQUEST_SIGNATURE (HTTP 400, not retryable)', async () => {
    const e = await navError(client({ credentials: { ...nav.credentials, signingKey: 'wrong-signing-key-0000000000000' } }).queryTaxpayer('87654323'));
    expect(e.navErrorCode).toBe('INVALID_REQUEST_SIGNATURE');
    expect(e.code).toBe('NAV_INVALID_REQUEST_SIGNATURE');
    expect(e.httpStatus).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.hint).toMatch(/aláírókulcs/);
    expect(e.message).toMatch(/INVALID_REQUEST_SIGNATURE/);
  });

  it('signature error switch on manageInvoice', async () => {
    nav.failNext({ kind: 'INVALID_REQUEST_SIGNATURE' }, { operation: 'manageInvoice' });
    const e = await navError(client().manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['INVALID_REQUEST_SIGNATURE', 400, false]);
    expect(nav.requests.map((r) => r.operation)).toEqual(['tokenExchange', 'manageInvoice']);
  });

  it('wrong password → INVALID_SECURITY_USER (HTTP 401, not retryable)', async () => {
    const e = await navError(client({ credentials: { ...nav.credentials, password: 'not-the-password' } }).tokenExchange());
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['INVALID_SECURITY_USER', 401, false]);
  });

  it('permanent NAV errors stay non-retryable with the new (400) and the pre-3.49 (500) HTTP status', async () => {
    const e = await navError(client({ credentials: { ...nav.credentials, taxNumber: '87654323' } }).tokenExchange());
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['INVALID_USER_RELATION', 400, false]);
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'NOT_REGISTERED_CUSTOMER', httpStatus: 500 });
    const old = await navError(client().tokenExchange());
    expect([old.navErrorCode, old.httpStatus, old.retryable]).toEqual(['NOT_REGISTERED_CUSTOMER', 500, false]);
    expect(old.hint).toMatch(/regisztrálva/);
  });

  it('HTTP 429 TOO_MANY_REQUESTS is retryable and carries Retry-After', async () => {
    nav.failNext({ kind: 'RATE_LIMIT', retryAfterSeconds: 7 });
    const e = await navError(client().queryTaxpayer('87654323'));
    expect([e.navErrorCode, e.httpStatus, e.retryable, e.retryAfterMs]).toEqual(['TOO_MANY_REQUESTS', 429, true, 7000]);
    expect(e.message).toMatch(/Retry-After/);
  });

  it('parseRetryAfter: delay-seconds and HTTP-date', () => {
    const now = new Date('2026-10-27T13:00:00.000Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Tue, 27 Oct 2026 13:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Tue, 27 Oct 2026 12:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('the fake answers non-XML bodies like the live API (GeneralExceptionResponse with notifications)', async () => {
    const res = await fetch(`${nav.url}/tokenExchange`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: '<oops' });
    expect(res.status).toBe(400);
    expect(navErrorInfo(await res.text())).toEqual({
      errorCode: 'INVALID_REQUEST',
      message: 'Érvénytelen kérés!',
      technicalMessages: [{ severity: 'ERROR', code: 'SCHEMA_VIOLATION', message: 'Request body is not well-formed XML.' }],
    });
  });

  it('plain HTTP 500 → retryable NavError', async () => {
    nav.failNext({ kind: 'HTTP_500' });
    const e = await navError(client().queryTaxpayer('87654323'));
    expect([e.navErrorCode, e.code, e.httpStatus, e.retryable]).toEqual(['HTTP_500', 'NAV_HTTP_500', 500, true]);
  });

  it('maintenance (HTTP 503 + MAINTENANCE_MODE) and OPERATION_FAILED are retryable', async () => {
    nav.failNext({ kind: 'MAINTENANCE' });
    const m = await navError(client().tokenExchange());
    expect([m.navErrorCode, m.httpStatus, m.retryable]).toEqual(['MAINTENANCE_MODE', 503, true]);
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'OPERATION_FAILED', httpStatus: 500 });
    const o = await navError(client().tokenExchange());
    expect([o.navErrorCode, o.httpStatus, o.retryable]).toEqual(['OPERATION_FAILED', 500, true]);
  });

  it('timeout → retryable TIMEOUT; for manageInvoice the message warns that the outcome is uncertain', async () => {
    nav.failNext({ kind: 'TIMEOUT' }, { operation: 'queryTaxpayer' });
    const started = Date.now();
    const e = await navError(client({ timeoutMs: 250 }).queryTaxpayer('87654323'));
    expect(Date.now() - started).toBeLessThan(5000);
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['TIMEOUT', null, true]);

    expect(e.uncertain).toBe(false);

    // Only manageInvoice hangs. The time limit applies to every request, the token exchange before it too: it has to
    // be long enough for that exchange even under the load of a full parallel test run (250 ms was not), so that the
    // timeout comes from manageInvoice itself.
    nav.failNext({ kind: 'TIMEOUT' }, { operation: 'manageInvoice' });
    const sending = Date.now();
    const m = await navError(client({ timeoutMs: 2000 }).manageInvoice([item(1, INVOICE_DOMESTIC)]));
    const elapsed = Date.now() - sending;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(15_000);
    // (whether the abandoned queryTaxpayer above reached the fake server before it was aborted depends on the load)
    expect(nav.requests.map((r) => r.operation).filter((op) => op !== 'queryTaxpayer')).toEqual(['tokenExchange', 'manageInvoice']);
    expect(m.navErrorCode).toBe('TIMEOUT');
    expect(m.message).toMatch(/^A NAV nem válaszolt 2000 ms alatt \(manageInvoice\)\..*bizonytalan/);
    expect(m.uncertain).toBe(true);
  });

  it('uncertain: a manageInvoice failure after the request may have reached NAV, and nothing else', async () => {
    // processed, then the connection dropped (lost answer)
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const lost = await navError(client().manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([lost.navErrorCode, lost.retryable, lost.uncertain]).toEqual(['NETWORK_ERROR', true, true]);
    expect(nav.invoices.map((i) => i.invoiceStatus)).toEqual(['DONE']);
    expectNoSecrets(errorTexts(lost));
    // processed, then an unreadable HTTP 200 answer
    nav.failNext({ kind: 'GARBLED_RESPONSE' }, { operation: 'manageInvoice' });
    const garbled = await navError(client().manageInvoice([item(1, INVOICE_EU_SERVICE)]));
    expect([garbled.navErrorCode, garbled.httpStatus, garbled.uncertain]).toEqual(['INVALID_RESPONSE', 200, true]);
    // gateway timeout without a NAV answer
    const gateway: typeof fetch = async (input, init) => (String(input).endsWith('/manageInvoice') ? new Response('Gateway Timeout', { status: 504 }) : fetch(input, init));
    expect((await navError(client({ fetch: gateway }).manageInvoice([item(1, INVOICE_DOMESTIC)]))).uncertain).toBe(true);
    // refused before anything was sent: certain
    const refusing: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/manageInvoice')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return fetch(input, init);
    };
    const refused = await navError(client({ fetch: refusing }).manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([refused.navErrorCode, refused.uncertain]).toEqual(['NETWORK_ERROR', false]);
    // a NAV error answer is certain; other operations are never uncertain
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'manageInvoice' });
    expect((await navError(client().manageInvoice([item(1, INVOICE_DOMESTIC)]))).uncertain).toBe(false);
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'queryTaxpayer' });
    expect((await navError(client().queryTaxpayer('87654323'))).uncertain).toBe(false);
  });

  it('manageInvoice answered with HTTP 200 but an unreadable body: retryable, but the message warns it was probably received', async () => {
    const garbled: typeof fetch = async (input, init) =>
      String(input).endsWith('/manageInvoice') ? new Response('<html><body>proxy page</body></html>', { status: 200 }) : fetch(input, init);
    const e = await navError(client({ fetch: garbled }).manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['INVALID_RESPONSE', 200, true]);
    expect(e.message).toMatch(/befogadta/);
    expectNoSecrets(errorTexts(e));
    // other operations have nothing to warn about
    const q = await navError(client({ fetch: async () => new Response('not xml', { status: 200 }) }).queryTaxpayer('87654323'));
    expect(q.navErrorCode).toBe('INVALID_RESPONSE');
    expect(q.message).not.toMatch(/befogadta/);
  });

  it('connection refused → retryable NETWORK_ERROR', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const e = await navError(client({ baseUrl: `http://127.0.0.1:${port}/invoiceService/v3` }).tokenExchange());
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['NETWORK_ERROR', null, true]);
  });

  it('unknown endpoint (wrong baseUrl) → HTTP_404, not retryable', async () => {
    const e = await navError(client({ baseUrl: `${nav.url}/nope` }).tokenExchange());
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['HTTP_404', 404, false]);
  });

  it('wrong exchange key → TOKEN_DECODE_FAILED (not retryable), without key material in the error', async () => {
    const e = await navError(client({ credentials: { ...nav.credentials, exchangeKey: 'WRONGEXCHANGEKEY' } }).manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([e.navErrorCode, e.retryable]).toEqual(['TOKEN_DECODE_FAILED', false]);
    expect(errorTexts(e)).not.toContain('WRONGEXCHANGEKEY');
    expectNoSecrets(errorTexts(e));
    expect(nav.requests.map((r) => r.operation)).toEqual(['tokenExchange']);
  });

  it('client clock off by two days → INVALID_TIMESTAMP (not retryable)', async () => {
    const e = await navError(client({ now: () => new Date(Date.now() - 2 * 24 * 3600_000) }).tokenExchange());
    expect([e.navErrorCode, e.retryable]).toEqual(['INVALID_TIMESTAMP', false]);
  });

  it('expired / reused exchange token → INVALID_EXCHANGE_TOKEN is retryable (a retry fetches a new token)', async () => {
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'INVALID_EXCHANGE_TOKEN', httpStatus: 400 }, { operation: 'manageInvoice' });
    const e = await navError(client().manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect([e.navErrorCode, e.httpStatus, e.retryable]).toEqual(['INVALID_EXCHANGE_TOKEN', 400, true]);
  });

  it('invalid manageInvoice input is rejected before any HTTP call', async () => {
    const c = client();
    const one = item(1, INVOICE_DOMESTIC);
    for (const bad of [[], Array.from({ length: 101 }, (_, i) => ({ ...one, index: i + 1 })), [{ ...one, index: 2 }], [{ ...one, invoiceDataBase64: '<xml/>' }]]) {
      const e = await navError(c.manageInvoice(bad));
      expect([e.navErrorCode, e.retryable]).toEqual(['INVALID_ARGUMENT', false]);
    }
    await expect(c.queryTransactionStatus('bad id!')).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
    expect(nav.requests).toEqual([]);
  });

  it('retry policy table', () => {
    expect(isRetryableNavError('OPERATION_FAILED', 500)).toBe(true);
    expect(isRetryableNavError('NOT_REGISTERED_CUSTOMER', 500)).toBe(false);
    expect(isRetryableNavError('SOMETHING_NEW', 500)).toBe(true);
    expect(isRetryableNavError('SOMETHING_NEW', 400)).toBe(false);
    expect(isRetryableNavError('HTTP_429', 429)).toBe(true);
    expect(isRetryableNavError('HTTP_404', 404)).toBe(false);
  });
});

describe('fake NAV fidelity – authentication exactly as specified (spec 1.3, 1.5)', () => {
  const sha3 = (s: string): string => createHash('sha3-512').update(s, 'utf8').digest('hex').toUpperCase();
  const ctxAt = (requestId: string, timestamp: Date): NavRequestContext => ({ requestId, timestamp, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  const withSignature = (xml: string, signature: string): string =>
    xml.replace(/(<common:requestSignature[^>]*>)[^<]*(<\/common:requestSignature>)/, `$1${signature}$2`);

  async function post(operation: string, xml: string): Promise<{ status: number; code: string | null }> {
    const res = await fetch(`${nav.url}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml });
    return { status: res.status, code: navErrorInfo(await res.text())?.errorCode ?? null };
  }

  it('rejects requestSignatures built with typical mistakes and accepts the specified one', async () => {
    const at = new Date();
    const iso = at.toISOString();
    const mask = iso.slice(0, 19).replace(/[-T:]/g, '');
    const key = nav.credentials.signingKey;
    const mistakes: Record<string, (rid: string) => string> = {
      'timestamp not masked': (rid) => sha3(rid + iso + key),
      'milliseconds kept': (rid) => sha3(rid + mask + iso.slice(20, 23) + key),
      'lowercase hex': (rid) => sha3(rid + mask + key).toLowerCase(),
      'SHA-512 instead of SHA3-512': (rid) => createHash('sha512').update(rid + mask + key, 'utf8').digest('hex').toUpperCase(),
      'key before the timestamp': (rid) => sha3(rid + key + mask),
    };
    let n = 0;
    for (const [name, sign] of Object.entries(mistakes)) {
      const rid = `RIDMISTAKE${++n}`;
      expect(await post('tokenExchange', withSignature(buildTokenExchangeRequest(ctxAt(rid, at)), sign(rid))), name).toEqual({ status: 400, code: 'INVALID_REQUEST_SIGNATURE' });
    }
    // computed here by hand from the spec text, not by src/nav/crypto.ts
    expect((await post('tokenExchange', withSignature(buildTokenExchangeRequest(ctxAt('RIDBYHAND1', at)), sha3(`RIDBYHAND1${mask}${key}`)))).status).toBe(200);
  });

  it('manageInvoice: the index hashes (operation + base64 text, uppercase, in index order) are part of the signature', async () => {
    const at = new Date();
    const mask = at.toISOString().slice(0, 19).replace(/[-T:]/g, '');
    const key = nav.credentials.signingKey;
    const a = Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC), 'utf8').toString('base64');
    const b = Buffer.from(buildInvoiceDataXml(INVOICE_EU_SERVICE), 'utf8').toString('base64');
    const ops = [
      { index: 1, operation: 'CREATE' as const, invoiceDataBase64: a },
      { index: 2, operation: 'CREATE' as const, invoiceDataBase64: b },
    ];
    const h = (op: string, data: string): string => sha3(op + data);
    const decoded = (data: string): string => Buffer.from(data, 'base64').toString('utf8');
    const mistakes: Record<string, (rid: string) => string> = {
      'no index hashes': (rid) => sha3(rid + mask + key),
      'lowercase index hashes': (rid) => sha3(rid + mask + key + h('CREATE', a).toLowerCase() + h('CREATE', b).toLowerCase()),
      'index hashes in reverse order': (rid) => sha3(rid + mask + key + h('CREATE', b) + h('CREATE', a)),
      'hash of the decoded XML': (rid) => sha3(rid + mask + key + h('CREATE', decoded(a)) + h('CREATE', decoded(b))),
      'operation left out': (rid) => sha3(rid + mask + key + sha3(a) + sha3(b)),
    };
    let n = 0;
    for (const [name, sign] of Object.entries(mistakes)) {
      const rid = `RIDMANAGEBAD${++n}`;
      const xml = withSignature(buildManageInvoiceRequest(ctxAt(rid, at), 'made-up-token', ops), sign(rid));
      expect(await post('manageInvoice', xml), name).toEqual({ status: 400, code: 'INVALID_REQUEST_SIGNATURE' });
    }
    // the specified signature passes authentication and then fails on the made-up token
    const ok = withSignature(buildManageInvoiceRequest(ctxAt('RIDMANAGEOK1', at), 'made-up-token', ops), sha3(`RIDMANAGEOK1${mask}${key}${h('CREATE', a)}${h('CREATE', b)}`));
    expect(await post('manageInvoice', ok)).toEqual({ status: 400, code: 'INVALID_EXCHANGE_TOKEN' });
  });

  it('a requestId is used up by a successful call or a signature error only', async () => {
    const at = new Date();
    const b64 = Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC), 'utf8').toString('base64');
    const tokenError = buildManageInvoiceRequest(ctxAt('RIDREUSE1', at), 'made-up-token', [{ index: 1, operation: 'CREATE', invoiceDataBase64: b64 }]);
    expect(await post('manageInvoice', tokenError)).toEqual({ status: 400, code: 'INVALID_EXCHANGE_TOKEN' });
    expect(await post('manageInvoice', tokenError)).toEqual({ status: 400, code: 'INVALID_EXCHANGE_TOKEN' });

    const good = buildTokenExchangeRequest(ctxAt('RIDREUSE2', at));
    expect(await post('tokenExchange', withSignature(good, '0'.repeat(128)))).toEqual({ status: 400, code: 'INVALID_REQUEST_SIGNATURE' });
    expect(await post('tokenExchange', good)).toEqual({ status: 400, code: 'REQUEST_ID_NOT_UNIQUE' });

    const once = buildTokenExchangeRequest(ctxAt('RIDREUSE3', at));
    expect((await post('tokenExchange', once)).status).toBe(200);
    expect(await post('tokenExchange', once)).toEqual({ status: 400, code: 'REQUEST_ID_NOT_UNIQUE' });
  });
});

describe('NavClient – queryTaxpayer', () => {
  it('known taxpayer → TaxpayerInfo (8-digit or full tax number accepted)', async () => {
    const c = client();
    const t = await c.queryTaxpayer('87654323');
    expect(t).toMatchObject({
      valid: true,
      name: 'Árvíztűrő Tükörfúrógép Zártkörűen Működő Részvénytársaság',
      taxpayerId: '87654323',
      vatCode: '2',
      countyCode: '13',
      formattedTaxNumber: '87654323-2-13',
      incorporation: 'ORGANIZATION',
      infoDate: '2025-01-15T00:00:00.000Z',
    });
    expect(t?.addresses).toEqual([
      { type: 'HQ', address: { countryCode: 'HU', postalCode: '1117', city: 'BUDAPEST', addressLine: 'Október huszonharmadika utca 18. 2/5.' } },
      { type: 'SITE', address: { countryCode: 'HU', postalCode: '2040', city: 'BUDAÖRS', addressLine: 'Gyár utca 2. B ép.' } },
    ]);
    expect((await c.queryTaxpayer('87654323-2-13'))?.taxpayerId).toBe('87654323');
    expect(nav.requests.at(-1)?.requestXml).toContain('<taxNumber>87654323</taxNumber>');
  });

  it('unknown taxpayer → null; existing but invalid → valid=false', async () => {
    const c = client();
    expect(await c.queryTaxpayer('11111111')).toBeNull();
    expect(await c.queryTaxpayer('24681353')).toMatchObject({ valid: false, formattedTaxNumber: '24681353-2-41' });
  });

  it('malformed input → INVALID_ARGUMENT without calling NAV', async () => {
    const e = await navError(client().queryTaxpayer('12-34'));
    expect(e.navErrorCode).toBe('INVALID_ARGUMENT');
    expect(nav.requests).toEqual([]);
  });
});

describe('NavClient – reconciliation queries (queryInvoiceCheck, queryTransactionList, original request)', () => {
  it('queryInvoiceCheck: true only for a number NAV accepted exactly once', async () => {
    const c = client();
    const number = INVOICE_DOMESTIC.number as string;
    expect(await c.queryInvoiceCheck(number)).toBe(false);
    await submitAndWait(c, [item(1, INVOICE_DOMESTIC)]);
    expect(await c.queryInvoiceCheck(number)).toBe(true);
    // a rejected duplicate does not change it
    expect((await submitAndWait(c, [item(1, INVOICE_DOMESTIC)])).results[0]?.messages.map((m) => m.code)).toContain('INVOICE_NUMBER_NOT_UNIQUE');
    expect(await c.queryInvoiceCheck(number)).toBe(true);
    expect(await c.queryInvoiceCheck('SZ-2026-99999')).toBe(false);
    await expect(c.queryInvoiceCheck(' ')).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
  });

  it('queryTransactionList pages the transactions of the interval; returnOriginalRequest gives back exactly what was sent', async () => {
    const paged = await startFakeNav({ receivedPolls: 0, transactionListPageSize: 1 });
    try {
      const c = client({ baseUrl: paged.url });
      const from = new Date(Date.now() - 60_000);
      const first = await c.manageInvoice([item(1, INVOICE_DOMESTIC)]);
      const second = await c.manageInvoice([item(1, INVOICE_EU_SERVICE)]);
      const to = new Date(Date.now() + 60_000);
      const p1 = await c.queryTransactionList(from, to, 1);
      const p2 = await c.queryTransactionList(from, to, 2);
      expect([p1.availablePage, p1.currentPage, p2.currentPage]).toEqual([2, 1, 2]);
      expect([...p1.transactions, ...p2.transactions].map((t) => t.transactionId).sort()).toEqual([first.transactionId, second.transactionId].sort());
      expect(p1.transactions[0]).toMatchObject({ source: 'MGM', requestStatus: 'FINISHED', technicalAnnulment: false, itemCount: 1 });
      expect(JSON.stringify([p1, p2])).not.toContain(paged.credentials.login);
      expect((await c.queryTransactionList(new Date(Date.now() - 3_600_000), new Date(Date.now() - 1_800_000))).transactions).toEqual([]);

      const withOriginal = await c.queryTransactionStatus(first.transactionId, { returnOriginalRequest: true });
      expect(withOriginal.results[0]?.originalRequest).toBe(item(1, INVOICE_DOMESTIC).invoiceDataBase64);
      // what is stored never carries the invoice data
      expect(withOriginal.responseXml).not.toMatch(/<originalRequest>/);
      expect(withOriginal.responseXml).not.toContain(item(1, INVOICE_DOMESTIC).invoiceDataBase64);
      expect((await c.queryTransactionStatus(first.transactionId)).results[0]?.originalRequest).toBeUndefined();

      for (const r of paged.requests) {
        expect((await validateNavXml(r.requestXml, 'api')).errors, `${r.operation} request`).toEqual([]);
        expect((await validateNavXml(r.responseXml ?? '', 'api')).errors, `${r.operation} response`).toEqual([]);
      }
    } finally {
      await stopFakeNav(paged);
    }
  });

  it('queryTransactionList refuses an interval NAV would reject, without calling NAV', async () => {
    const c = client();
    const now = Date.now();
    await expect(c.queryTransactionList(new Date(now), new Date(now - 1000))).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
    await expect(c.queryTransactionList(new Date(now - 36 * 24 * 3600_000), new Date(now))).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
    await expect(c.queryTransactionList(new Date(now - 1000), new Date(now), 0)).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
    expect(nav.requests).toEqual([]);
  });
});

describe('NavClient – secrets never leak', () => {
  it('NAV error messages echoing the token / password hash are redacted', async () => {
    nav.failNext(
      {
        kind: 'GENERAL_ERROR',
        errorCode: 'INVALID_EXCHANGE_TOKEN',
        httpStatus: 400,
        message: (fake) => `A token (${fake.lastIssuedToken ?? '-'}) érvénytelen; hash: ${passwordHash(fake.credentials.password)}; kulcs: ${fake.credentials.signingKey}`,
      },
      { operation: 'manageInvoice' },
    );
    const e = await navError(client().manageInvoice([item(1, INVOICE_DOMESTIC)]));
    expect(nav.lastIssuedToken).toBeTruthy();
    expect(e.message).toContain('***');
    expectNoSecrets(errorTexts(e));
  });

  it('no secret appears in any error of the error scenarios or in returned XML', async () => {
    const errors: NavError[] = [];
    const collect = async (p: Promise<unknown>): Promise<void> => {
      errors.push(await navError(p));
    };
    await collect(client({ credentials: { ...nav.credentials, signingKey: 'wrong-signing-key-0000000000000' } }).tokenExchange());
    nav.failNext({ kind: 'HTTP_500' }, { operation: 'manageInvoice' });
    await collect(client().manageInvoice([item(1, INVOICE_DOMESTIC)]));
    nav.failNext({ kind: 'TIMEOUT' }, { operation: 'manageInvoice' });
    await collect(client({ timeoutMs: 200 }).manageInvoice([item(1, INVOICE_DOMESTIC)]));
    nav.failNext({ kind: 'MAINTENANCE' });
    await collect(client().queryTaxpayer('87654323'));
    for (const e of errors) expectNoSecrets(errorTexts(e));

    const ok = await submitAndWait(client(), [item(1, INVOICE_DOMESTIC)]);
    expectNoSecrets(ok.responseXml);
  });

  it('the client object does not expose credentials (JSON / inspect)', () => {
    const c = client();
    expect(JSON.stringify(c)).toBe('{}');
    expectNoSecrets(inspect(c, { depth: 5, showHidden: true }));
  });
});
