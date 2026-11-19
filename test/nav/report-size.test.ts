/**
 * NAV-10: NAV's size limits (spec 1.6.5). invoiceData over 1 MB (base64) goes out gzip-compressed with
 * compressedContent=true, and the signature covers exactly the compressed text; a report over 15 MB of XML
 * (or a request over 10 MB) is refused before anything is sent; HTTP 413 is permanent, never "uncertain".
 * The bounds behind NAV_SIZE_SAFE_LINES (validation builds the report only for longer invoices) are checked.
 */
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeLines, computeTotals } from '../../src/core/calc.ts';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice, InvoiceLine, InvoiceLineInput, InvoiceTotals, VatCode } from '../../src/core/types.ts';
import { VAT_CODES } from '../../src/core/vat.ts';
import { buildManageInvoiceRequest, type NavRequestContext } from '../../src/nav/api-xml.ts';
import { NavClient, NavError } from '../../src/nav/client.ts';
import { invoiceHash, requestSignature } from '../../src/nav/crypto.ts';
import { buildInvoiceDataXml, decodeInvoiceData, encodeInvoiceData, NAV_SIZE_SAFE_LINES, navReportSizeProblem } from '../../src/nav/invoice-data.ts';
import { NAV_COMPRESS_ABOVE_BYTES, NAV_MAX_REQUEST_BYTES } from '../../src/nav/types.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { FAKE_NAV_CREDENTIALS, FAKE_NAV_SOFTWARE, startFakeNav, stopFakeNav, type FakeNavServer } from '../helpers/fake-nav.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

/** A HUF invoice of `n` simple lines (computed by the real calculation). */
function withLines(base: Invoice, n: number, description: (i: number) => string = (i) => `Napi szolgáltatás – ${i + 1}. tétel`): Invoice {
  const inputs = Array.from({ length: n }, (_, i): InvoiceLineInput => ({ description: description(i), quantity: '1.5', unit: 'óra', unitPrice: '12345.67', priceBasis: 'net', vatCode: '27', nature: 'SERVICE' }));
  const lines = computeLines(inputs, { currency: 'HUF', exchangeRate: '1' });
  return { ...base, lines, totals: computeTotals(lines, { currency: 'HUF', exchangeRate: '1' } as never) };
}

describe('NAV-10: payload encoding', () => {
  it('plain base64 up to 1 MB, base64(gzip -1) above it; decodeInvoiceData gives back the XML either way', () => {
    const small = buildInvoiceDataXml(INVOICE_DOMESTIC);
    const plain = encodeInvoiceData(small);
    expect(plain).toEqual({ invoiceDataBase64: Buffer.from(small).toString('base64'), compressed: false });
    const big = buildInvoiceDataXml(withLines(INVOICE_DOMESTIC, 1200));
    expect(Buffer.from(big).toString('base64').length).toBeGreaterThan(NAV_COMPRESS_ABOVE_BYTES);
    const packed = encodeInvoiceData(big);
    expect(packed.compressed).toBe(true);
    expect(packed.invoiceDataBase64.length).toBeLessThan(NAV_COMPRESS_ABOVE_BYTES / 4);
    expect(gunzipSync(Buffer.from(packed.invoiceDataBase64, 'base64')).toString('utf8')).toBe(big);
    expect(decodeInvoiceData(packed.invoiceDataBase64).toString('utf8')).toBe(big);
    expect(decodeInvoiceData(plain.invoiceDataBase64).toString('utf8')).toBe(small);
  });

  it('over 15 MB of XML, or over the 10 MB request even compressed: NAV_REPORT_TOO_LARGE, with the program-error hint', () => {
    const tooBig = () => encodeInvoiceData(`<x>${'a'.repeat(15_000_001)}</x>`);
    expect(tooBig).toThrow(AppError);
    expect(tooBig).toThrow(/15,0 MB/);
    // ~12 MB of UTF-8 that gzip cannot shrink below 10 MB
    const noise = randomBytes(8_000_000).toString('latin1');
    let e: unknown = null;
    try {
      encodeInvoiceData(noise);
    } catch (err) {
      e = err;
    }
    expect(e).toMatchObject({ code: 'NAV_REPORT_TOO_LARGE', hint: expect.stringMatching(/programhiba/) });
    expect((e as Error).message).toMatch(/tömörítve is .* MB; egy NAV-kérés legfeljebb 10,0 MB/);
  });

  it('a compressed ManageInvoiceRequest is XSD-valid, says compressedContent=true and signs the compressed text', async () => {
    const packed = encodeInvoiceData(buildInvoiceDataXml(withLines(INVOICE_DOMESTIC, 1200)));
    const ctx: NavRequestContext = { requestId: 'OSZTEST0002', timestamp: new Date('2026-10-27T13:05:00.000Z'), credentials: { ...FAKE_NAV_CREDENTIALS }, software: { ...FAKE_NAV_SOFTWARE } };
    const xml = buildManageInvoiceRequest(ctx, 'b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U', [{ index: 1, operation: 'CREATE', invoiceDataBase64: packed.invoiceDataBase64 }], true);
    expect((await validateNavXml(xml, 'api')).errors).toEqual([]);
    expect(xml).toContain('<compressedContent>true</compressedContent>');
    expect(xml).toContain(`<common:requestSignature cryptoType="SHA3-512">${requestSignature(ctx.requestId, ctx.timestamp, ctx.credentials.signingKey, [invoiceHash('CREATE', packed.invoiceDataBase64)])}</common:requestSignature>`);
  });
});

describe('NAV-10: the size check before issuing', () => {
  /** The longest line the builder can make: every text at its maximum and escaped six-fold, every number at its longest. */
  const q = '"';
  const worstLine = (lineNo: number, vatCode: VatCode): InvoiceLine => ({
    lineNo,
    description: q.repeat(512),
    quantity: '-1234567890.1234567891',
    unit: q.repeat(50),
    unitPrice: '1234567890.1234567891',
    priceBasis: 'net',
    vatCode,
    vatReason: q.repeat(200),
    nature: 'PRODUCT',
    netUnitPrice: '1234567890.1234567891',
    netAmount: '-9999999999999999.99', vatAmount: '0', grossAmount: '-9999999999999999.99',
    netAmountHuf: '-9999999999999999.99', vatAmountHuf: '0', grossAmountHuf: '-9999999999999999.99',
    modificationRef: { lineNumberReference: 999_999_000 + lineNo, lineOperation: 'CREATE' },
    advanceDeduction: { advanceInvoiceNumber: q.repeat(50), advancePaymentDate: '2026-10-01', advanceExchangeRate: '12345678.123456' },
  });
  const row = (vatCode: VatCode): InvoiceTotals['byVat'][number] => ({ vatCode, netAmount: '-9999999999999999.99', vatAmount: '0', grossAmount: '-9999999999999999.99', netAmountHuf: '-9999999999999999.99', vatAmountHuf: '0', grossAmountHuf: '-9999999999999999.99' });
  const worst = (codes: readonly VatCode[]): Invoice => ({
    ...INVOICE_STORNO,
    number: 'X'.repeat(50),
    orderNumber: q.repeat(100),
    seller: { ...SELLER_NORMAL, name: q.repeat(512), groupMemberTaxNumber: '12345676-4-42', address: { countryCode: 'HU', postalCode: '1117', city: q.repeat(255), addressLine: q.repeat(255), region: q.repeat(50) } },
    customer: { vatStatus: 'OTHER', name: q.repeat(512), thirdStateTaxId: q.repeat(50), address: { countryCode: 'US', postalCode: '1234567890', city: q.repeat(255), addressLine: q.repeat(255), region: q.repeat(50) } },
    reference: { originalInvoiceId: 'inv_x', originalInvoiceNumber: 'Y'.repeat(50), modificationIndex: 1000, modifyWithoutMaster: false, originalDocumentType: 'final' },
    lines: codes.map((c, i) => worstLine(i + 1, c)),
    totals: { ...INVOICE_STORNO.totals, byVat: codes.map(row) },
  });

  it(`a line is at most 12 KB of XML and the rest at most 256 KB, so ${NAV_SIZE_SAFE_LINES} lines always fit`, () => {
    const size = (inv: Invoice): number => Buffer.byteLength(buildInvoiceDataXml(inv), 'utf8');
    const line = size(worst(['TAM', 'TAM'])) - size(worst(['TAM']));
    expect(line).toBeLessThanOrEqual(12 * 1024);
    const codes = VAT_CODES.filter((c) => c !== 'FAD'); // every VAT code a storno of an OTHER buyer can carry
    expect(size(worst(codes)) - codes.length * line).toBeLessThanOrEqual(256 * 1024);
    // Even uncompressed in base64 they stay below one request.
    expect(Math.ceil(((NAV_SIZE_SAFE_LINES * 12 * 1024 + 256 * 1024) * 4) / 3) + 64 * 1024).toBeLessThan(NAV_MAX_REQUEST_BYTES);
  });

  it('up to the safe line count nothing is built; above it the report is measured – drafts and corrections too', () => {
    expect(navReportSizeProblem(withLines(INVOICE_DOMESTIC, NAV_SIZE_SAFE_LINES + 100))).toBeNull();
    const long = (i: number): string => `${q.repeat(500)} ${i}`;
    const tooBig = withLines({ ...INVOICE_DOMESTIC, number: null, status: 'draft' }, 4000, long);
    expect(navReportSizeProblem(tooBig)).toMatch(/^A számla NAV-adatszolgáltatása \d+,\d MB; a NAV számlánként legfeljebb 15,0 MB/);
    const storno = withLines({ ...INVOICE_STORNO, number: null, status: 'draft' }, 4000, long);
    expect(storno.lines[0]?.modificationRef).toBeUndefined();
    expect(navReportSizeProblem(storno)).toMatch(/15,0 MB/);
    expect(navReportSizeProblem({ ...tooBig, documentType: 'proforma' })).toBeNull();
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

describe('NAV-10: requests NAV would refuse for their size', () => {
  it('the client never sends a request over 10 MB: REQUEST_TOO_LARGE, permanent, not uncertain', async () => {
    const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
    const e = await client.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: 'A'.repeat(NAV_MAX_REQUEST_BYTES) }]).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(NavError);
    expect(e).toMatchObject({ navErrorCode: 'REQUEST_TOO_LARGE', retryable: false, uncertain: false });
    expect(nav.requests.map((r) => r.operation)).toEqual(['tokenExchange']);
  });

  it('HTTP 413 is a permanent error, not an uncertain one; the fake answers an oversized body with it', async () => {
    const tooLarge: typeof fetch = async (input, init) => (String(input).endsWith('/manageInvoice') ? new Response('Payload Too Large', { status: 413 }) : fetch(input, init));
    const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE, fetch: tooLarge });
    const e = await client.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC)).toString('base64') }]).catch((err: unknown) => err);
    expect(e).toMatchObject({ navErrorCode: 'HTTP_413', retryable: false, uncertain: false, hint: expect.stringMatching(/10 MB/) });

    const res = await fetch(`${nav.url}/manageInvoice`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: 'x'.repeat(11 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(nav.requests.at(-1)).toMatchObject({ operation: 'manageInvoice', status: 413 });
  });
});
