/**
 * queryInvoiceData (NAV-1): the XSD-valid request, the response parser (compressed content, no result), the
 * key data of an InvoiceData, MULTIPLE_QUERY_RESULT_FOUND, and the client against the fake NAV; the submitting
 * technical user of the transaction list (NAV-2).
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildQueryInvoiceDataRequest, NavResponseFormatError, parseInvoiceDataKeys, parseQueryInvoiceDataResponse, type NavRequestContext } from '../../src/nav/api-xml.ts';
import { isRetryableNavError, NavClient, type ManageInvoiceItem } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import type { Invoice } from '../../src/core/types.ts';
import { INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM } from '../fixtures/invoices.ts';
import { FAKE_NAV_SOFTWARE, startFakeNav, stopFakeNav, type FakeNavServer } from '../helpers/fake-nav.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

const SAMPLE = readFileSync(new URL('../../vendor/nav-online-invoice/samples/api/queryInvoiceData.xml', import.meta.url), 'utf8');

const orderedParser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, ignoreDeclaration: true });
type O = Record<string, unknown>;
const tagOf = (n: O): string | null => {
  const k = Object.keys(n).find((key) => key !== ':@');
  return k && k !== '#text' ? k : null;
};
/** Child element names of the element at a slash path. */
function childNames(xml: string, path: string): string[] {
  let nodes = orderedParser.parse(xml) as O[];
  let node: O | null = null;
  for (const seg of path.split('/')) {
    node = nodes.find((n) => tagOf(n) === seg) ?? null;
    if (!node) return [];
    nodes = node[seg] as O[];
  }
  return node ? (node[tagOf(node) as string] as O[]).map(tagOf).filter((t): t is string => t !== null) : [];
}
function value(xml: string, name: string): string {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
  if (!m?.[1]) throw new Error(`no ${name}`);
  return m[1].trim();
}

/** The technical user and software of the official samples (only the signature is compared). */
const SAMPLE_CTX: NavRequestContext = {
  requestId: value(SAMPLE, 'requestId'),
  timestamp: new Date(value(SAMPLE, 'timestamp')),
  credentials: { login: 'lwilsmn0uqdxe6u', password: 'unknown-password', signingKey: 'ac-ac3a-7f661bff7d342N43CYX4U9FG', exchangeKey: '0123456789ABCDEF', taxNumber: '11111111' },
  software: {
    softwareId: '123456789123456789',
    softwareName: 'string',
    softwareOperation: 'LOCAL_SOFTWARE',
    softwareMainVersion: 'string',
    softwareDevName: 'string',
    softwareDevContact: 'string',
    softwareDevCountryCode: 'HU',
    softwareDevTaxNumber: 'string',
  },
};

// Responses written the way NAV serialises them (ns2 = common).
const NS = 'xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns3="http://schemas.nav.gov.hu/OSA/3.0/base"';
const HEADER = '<ns2:header><ns2:requestId>RID1</ns2:requestId><ns2:timestamp>2026-10-27T13:05:00.000Z</ns2:timestamp><ns2:requestVersion>3.0</ns2:requestVersion><ns2:headerVersion>1.0</ns2:headerVersion></ns2:header>';
const OK = '<ns2:result><ns2:funcCode>OK</ns2:funcCode></ns2:result>';
const SOFTWARE = '<software><softwareId>HU12345676-TESZT01</softwareId><softwareName>x</softwareName><softwareOperation>LOCAL_SOFTWARE</softwareOperation><softwareMainVersion>1</softwareMainVersion><softwareDevName>x</softwareDevName><softwareDevContact>x</softwareDevContact></software>';
const response = (body: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<QueryInvoiceDataResponse ${NS}>${HEADER}${OK}${SOFTWARE}${body}</QueryInvoiceDataResponse>`;
const result = (data: string, compressed: boolean): string =>
  `<invoiceDataResult><invoiceData>${data}</invoiceData><auditData><insdate>2026-10-27T13:05:01.123Z</insdate><insCusUser>fakeuser2026</insCusUser><source>MGM</source><transactionId>2T6BE8A0G2EFOL0J</transactionId><index>1</index><originalRequestVersion>3.0</originalRequestVersion></auditData><compressedContentIndicator>${compressed}</compressedContentIndicator></invoiceDataResult>`;

const XML = buildInvoiceDataXml(INVOICE_DOMESTIC);

describe('queryInvoiceData – request and response', () => {
  it('QueryInvoiceDataRequest: XSD-valid, the sample signature, our own (OUTBOUND) invoice number only', async () => {
    const ours = buildQueryInvoiceDataRequest(SAMPLE_CTX, 'SZ-2026-00001');
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(SAMPLE, 'requestSignature'));
    expect(childNames(ours, 'QueryInvoiceDataRequest')).toEqual(childNames(SAMPLE, 'QueryInvoiceDataRequest'));
    // batchIndex / supplierTaxNumber of the sample belong to batch invoices and the buyer's side
    expect(childNames(ours, 'QueryInvoiceDataRequest/invoiceNumberQuery')).toEqual(['invoiceNumber', 'invoiceDirection']);
    expect(value(ours, 'invoiceNumber')).toBe('SZ-2026-00001');
    expect(value(ours, 'invoiceDirection')).toBe('OUTBOUND');
  });

  it('QueryInvoiceDataResponse: the invoice data (decompressed when it was sent compressed) with its audit data; no result', async () => {
    const plain = response(result(Buffer.from(XML).toString('base64'), false));
    const packed = response(result(gzipSync(Buffer.from(XML), { level: 1 }).toString('base64'), true));
    const none = response('');
    for (const xml of [plain, packed, none]) expect((await validateNavXml(xml, 'api')).errors).toEqual([]);

    const p = parseQueryInvoiceDataResponse(plain);
    expect(p).toMatchObject({ found: true, compressed: false, audit: { insDate: '2026-10-27T13:05:01.123Z', source: 'MGM', transactionId: '2T6BE8A0G2EFOL0J', index: 1 } });
    expect(p.found && p.invoiceData.equals(Buffer.from(XML))).toBe(true);
    const c = parseQueryInvoiceDataResponse(packed);
    expect(c.found && c.compressed).toBe(true);
    expect(c.found && c.invoiceData.toString('utf8')).toBe(XML);
    // base64Binary may be wrapped
    const wrapped = parseQueryInvoiceDataResponse(response(result(Buffer.from(XML).toString('base64').replace(/(.{76})/g, '$1\n'), false)));
    expect(wrapped.found && wrapped.invoiceData.toString('utf8')).toBe(XML);
    expect(parseQueryInvoiceDataResponse(none)).toEqual({ found: false });
    // gzip header, broken stream
    const broken = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from('not really gzip')]).toString('base64');
    expect(() => parseQueryInvoiceDataResponse(response(result(broken, true)))).toThrow(NavResponseFormatError);
  });

  it('the key data of an InvoiceData: number, date, seller, buyer, currency, HUF totals', () => {
    expect(parseInvoiceDataKeys(Buffer.from(XML))).toEqual({
      invoiceNumber: 'SZ-2026-00001',
      issueDate: '2026-10-27',
      supplierTaxpayerId: '12345676',
      customerVatStatus: 'DOMESTIC',
      customerTaxpayerId: '87654323',
      customerCommunityVatNumber: null,
      customerThirdStateTaxId: null,
      customerName: 'Árvíztűrő Tükörfúrógép Zrt.',
      currency: 'HUF',
      netAmountHuf: '154000',
      vatAmountHuf: '40700',
      grossAmountHuf: '194700',
      lines: expect.any(Array),
    });
    expect(parseInvoiceDataKeys(buildInvoiceDataXml(INVOICE_EU_SERVICE))).toMatchObject({ customerVatStatus: 'OTHER', customerCommunityVatNumber: 'DE123456789', currency: 'EUR', netAmountHuf: '312096' });
    expect(parseInvoiceDataKeys(buildInvoiceDataXml(INVOICE_PRIVATE_AAM))).toMatchObject({ customerVatStatus: 'PRIVATE_PERSON', customerName: null, customerTaxpayerId: null });
    const { lines, ...none } = parseInvoiceDataKeys('<html>no invoice</html>');
    expect(Object.values(none).every((v) => v === null)).toBe(true);
    expect(lines).toEqual([]);
  });

  it('MULTIPLE_QUERY_RESULT_FOUND (HTTP 500) is permanent: asking again gives the same answer', () => {
    expect(isRetryableNavError('MULTIPLE_QUERY_RESULT_FOUND', 500)).toBe(false);
  });
});

let nav: FakeNavServer;
beforeAll(async () => {
  nav = await startFakeNav({ receivedPolls: 0 });
});
afterAll(async () => {
  await stopFakeNav(nav);
});
beforeEach(() => {
  nav.reset();
});

const client = (): NavClient => new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
const item = (inv: Invoice, compressed = false): ManageInvoiceItem => {
  const bytes = Buffer.from(buildInvoiceDataXml(inv), 'utf8');
  return { index: 1, operation: navOperationFor(inv), invoiceDataBase64: (compressed ? gzipSync(bytes, { level: 1 }) : bytes).toString('base64') };
};

describe('NavClient.queryInvoiceData against the fake NAV', () => {
  it('not_found, then found with exactly the data NAV accepted and its transaction; compressed data comes back decompressed', async () => {
    const c = client();
    expect(await c.queryInvoiceData('SZ-2026-00001')).toEqual({ status: 'not_found' });
    const { transactionId } = await c.manageInvoice([item(INVOICE_DOMESTIC)]);
    expect((await c.queryTransactionStatus(transactionId)).results[0]?.invoiceStatus).toBe('DONE');
    const found = await c.queryInvoiceData('SZ-2026-00001');
    expect(found).toMatchObject({ status: 'found', compressed: false, audit: { transactionId, source: 'MGM', index: 1 } });
    expect(found.status === 'found' && found.invoiceData.equals(Buffer.from(XML))).toBe(true);

    const compressed = await c.manageInvoice([item(INVOICE_EU_SERVICE, true)], { compressedContent: true });
    expect((await c.queryTransactionStatus(compressed.transactionId)).results[0]?.invoiceStatus).toBe('DONE');
    const eu = await c.queryInvoiceData('SZ-2026-00003');
    expect(eu).toMatchObject({ status: 'found', compressed: true });
    expect(eu.status === 'found' && eu.invoiceData.toString('utf8')).toBe(buildInvoiceDataXml(INVOICE_EU_SERVICE));

    for (const r of nav.requests) {
      expect((await validateNavXml(r.requestXml, 'api')).errors, `${r.operation} request`).toEqual([]);
      expect((await validateNavXml(r.responseXml ?? '', 'api')).errors, `${r.operation} response`).toEqual([]);
    }
  });

  it('a number valid more than once answers MULTIPLE_QUERY_RESULT_FOUND: status multiple, not an error', async () => {
    const c = client();
    const { transactionId } = await c.manageInvoice([item(INVOICE_DOMESTIC)]);
    await c.queryTransactionStatus(transactionId);
    const accepted = nav.invoices[0];
    if (!accepted) throw new Error('no record');
    nav.invoices.push({ ...accepted }); // e.g. a manual entry at NAV next to the machine report
    expect(await c.queryInvoiceData('SZ-2026-00001')).toEqual({ status: 'multiple' });
    expect(nav.requests.at(-1)).toMatchObject({ operation: 'queryInvoiceData', status: 500, errorCode: 'MULTIPLE_QUERY_RESULT_FOUND' });
  });

  it('refuses an invoice number NAV would reject, without calling NAV', async () => {
    await expect(client().queryInvoiceData(' SZ-1')).rejects.toMatchObject({ navErrorCode: 'INVALID_ARGUMENT' });
    expect(nav.requests).toEqual([]);
  });
});

describe('queryTransactionList – the submitting technical user (insCusUser)', () => {
  it("other technical users' transactions are told apart, and no login is returned", async () => {
    const c = client();
    const from = new Date(Date.now() - 60_000);
    const own = await c.manageInvoice([item(INVOICE_DOMESTIC)]);
    const [foreign] = nav.addTransactions(1, { user: 'webshopuser1' });
    const list = await c.queryTransactionList(from, new Date(Date.now() + 60_000));
    expect(list.transactions.map((t) => [t.transactionId, t.ownUser]).sort()).toEqual([[own.transactionId, true], [foreign, false]].sort());
    expect(JSON.stringify(list)).not.toMatch(/webshopuser1|fakeuser2026/);
    for (const r of nav.requests) expect((await validateNavXml(r.responseXml ?? '', 'api')).errors, `${r.operation} response`).toEqual([]);
  });
});
