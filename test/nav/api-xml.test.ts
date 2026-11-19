/**
 * invoiceApi request builders (XSD-valid, same structure and signatures as the official samples)
 * and response parsers (NAV-style namespace prefixes, single/multiple occurrences, errors).
 */
import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import {
  assertNavCredentials,
  assertNavSoftware,
  buildManageInvoiceRequest,
  buildQueryInvoiceCheckRequest,
  buildQueryTaxpayerRequest,
  buildQueryTransactionListRequest,
  buildQueryTransactionStatusRequest,
  buildTokenExchangeRequest,
  navCredentialProblems,
  navErrorInfo,
  NavResponseFormatError,
  parseManageInvoiceResponse,
  parseNavResponseXml,
  parseQueryInvoiceCheckResponse,
  parseQueryTaxpayerResponse,
  parseQueryTransactionListResponse,
  parseQueryTransactionStatusResponse,
  parseTokenExchangeResponse,
  redactSecrets,
  sanitizeNavXml,
  type NavRequestContext,
} from '../../src/nav/api-xml.ts';
import { passwordHash } from '../../src/nav/crypto.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { NavCredentials, NavSoftware } from '../../src/nav/types.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO } from '../fixtures/invoices.ts';
import { FAKE_NAV_CREDENTIALS, FAKE_NAV_SOFTWARE } from '../helpers/fake-nav.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

const API_SAMPLES = new URL('../../vendor/nav-online-invoice/samples/api/', import.meta.url);
const sample = (file: string): string => readFileSync(new URL(file, API_SAMPLES), 'utf8');

const attrParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, ignoreDeclaration: true });
const orderedParser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, ignoreDeclaration: true });

type O = Record<string, unknown>;

function rootOf(xml: string, name: string): O {
  return (attrParser.parse(xml) as O)[name] as O;
}

function tagOf(n: O): string | null {
  const k = Object.keys(n).find((key) => key !== ':@');
  return k && k !== '#text' ? k : null;
}

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

/** The technical user of the official samples (password unknown – only the signature is compared). */
const SAMPLE_CREDENTIALS: NavCredentials = {
  login: 'lwilsmn0uqdxe6u',
  password: 'unknown-password',
  signingKey: 'ac-ac3a-7f661bff7d342N43CYX4U9FG',
  exchangeKey: '0123456789ABCDEF',
  taxNumber: '11111111',
};

const SAMPLE_SOFTWARE: NavSoftware = {
  softwareId: '123456789123456789',
  softwareName: 'string',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: 'string',
  softwareDevName: 'string',
  softwareDevContact: 'string',
  softwareDevCountryCode: 'HU',
  softwareDevTaxNumber: 'string',
};

function sampleContext(file: string): NavRequestContext {
  const xml = sample(file);
  return { requestId: value(xml, 'requestId'), timestamp: new Date(value(xml, 'timestamp')), credentials: SAMPLE_CREDENTIALS, software: SAMPLE_SOFTWARE };
}

const FAKE_CTX: NavRequestContext = {
  requestId: 'OSZTEST0001',
  timestamp: new Date('2026-10-27T13:05:00.000Z'),
  credentials: { ...FAKE_NAV_CREDENTIALS },
  software: { ...FAKE_NAV_SOFTWARE },
};

// ---------------------------------------------------------------------------------------------

describe('request builders – reproduce the official samples', () => {
  it('TokenExchangeRequest: same structure and requestSignature as samples/api/tokenExchange.xml', async () => {
    const theirs = sample('tokenExchange.xml');
    const ours = buildTokenExchangeRequest(sampleContext('tokenExchange.xml'));
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(childNames(ours, 'TokenExchangeRequest')).toEqual(childNames(theirs, 'TokenExchangeRequest'));
    expect(childNames(ours, 'TokenExchangeRequest/header')).toEqual(childNames(theirs, 'TokenExchangeRequest/header'));
    expect(childNames(ours, 'TokenExchangeRequest/user')).toEqual(childNames(theirs, 'TokenExchangeRequest/user'));
    expect(childNames(ours, 'TokenExchangeRequest/software')).toEqual(childNames(theirs, 'TokenExchangeRequest/software'));
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(value(ours, 'timestamp')).toBe(value(theirs, 'timestamp'));
    const user = rootOf(ours, 'TokenExchangeRequest').user as O;
    expect(user.passwordHash).toEqual({ '#text': passwordHash('unknown-password'), '@_cryptoType': 'SHA-512' });
    expect((user.requestSignature as O)['@_cryptoType']).toBe('SHA3-512');
    expect(ours).toContain('xmlns="http://schemas.nav.gov.hu/OSA/3.0/api"');
    expect(ours).toContain('xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common"');
    expect(value(ours, 'requestVersion')).toBe('3.0');
    expect(value(ours, 'headerVersion')).toBe('1.0');
  });

  it('ManageInvoiceRequest: the three sample invoices give the sample requestSignature', async () => {
    const theirs = sample('manageInvoice.xml');
    const payloads = [...theirs.matchAll(/<invoiceData>([^<]+)<\/invoiceData>/g)].map((m) => (m[1] as string).trim());
    expect(payloads).toHaveLength(3);
    const ours = buildManageInvoiceRequest(
      sampleContext('manageInvoice.xml'),
      value(theirs, 'exchangeToken'),
      payloads.map((invoiceDataBase64, i) => ({ index: i + 1, operation: 'CREATE' as const, invoiceDataBase64 })),
    );
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(childNames(ours, 'ManageInvoiceRequest')).toEqual(childNames(theirs, 'ManageInvoiceRequest'));
    expect(childNames(ours, 'ManageInvoiceRequest/invoiceOperations')).toEqual(childNames(theirs, 'ManageInvoiceRequest/invoiceOperations'));
    // we never send electronicInvoiceHash (completenessIndicator is always false)
    expect(childNames(ours, 'ManageInvoiceRequest/invoiceOperations/invoiceOperation')).toEqual(['index', 'invoiceOperation', 'invoiceData']);
    expect(value(ours, 'compressedContent')).toBe('false');
  });

  it('ManageInvoiceRequest sorts operations by index (signature order = index order)', () => {
    const a = Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC)).toString('base64');
    const b = Buffer.from(buildInvoiceDataXml(INVOICE_STORNO)).toString('base64');
    const sorted = buildManageInvoiceRequest(FAKE_CTX, 'token', [
      { index: 1, operation: 'CREATE', invoiceDataBase64: a },
      { index: 2, operation: 'STORNO', invoiceDataBase64: b },
    ]);
    const shuffled = buildManageInvoiceRequest(FAKE_CTX, 'token', [
      { index: 2, operation: 'STORNO', invoiceDataBase64: b },
      { index: 1, operation: 'CREATE', invoiceDataBase64: a },
    ]);
    expect(shuffled).toBe(sorted);
  });

  it('QueryTransactionStatusRequest: sample signature, returnOriginalRequest=false', async () => {
    const theirs = sample('queryTransactionStatus.xml');
    const ours = buildQueryTransactionStatusRequest(sampleContext('queryTransactionStatus.xml'), 'string');
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(childNames(ours, 'QueryTransactionStatusRequest')).toEqual(childNames(theirs, 'QueryTransactionStatusRequest'));
    expect(value(ours, 'returnOriginalRequest')).toBe('false');
  });

  it('QueryTaxpayerRequest: sample signature and taxNumber', async () => {
    const theirs = sample('queryTaxpayer.xml');
    const ours = buildQueryTaxpayerRequest(sampleContext('queryTaxpayer.xml'), '22222222');
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(childNames(ours, 'QueryTaxpayerRequest')).toEqual(childNames(theirs, 'QueryTaxpayerRequest'));
    expect(value(ours, 'taxNumber')).toBe('11111111'); // user/taxNumber comes first
    expect(rootOf(ours, 'QueryTaxpayerRequest').taxNumber).toBe('22222222');
  });

  it('QueryInvoiceCheckRequest: sample signature, our own (OUTBOUND) invoice number only', async () => {
    const theirs = sample('queryInvoiceCheck.xml');
    const ours = buildQueryInvoiceCheckRequest(sampleContext('queryInvoiceCheck.xml'), 'SZ-2026-00001');
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(childNames(ours, 'QueryInvoiceCheckRequest')).toEqual(childNames(theirs, 'QueryInvoiceCheckRequest'));
    // batchIndex / supplierTaxNumber of the sample belong to batch invoices and the buyer's side
    expect(childNames(ours, 'QueryInvoiceCheckRequest/invoiceNumberQuery')).toEqual(['invoiceNumber', 'invoiceDirection']);
    expect(value(ours, 'invoiceNumber')).toBe('SZ-2026-00001');
    expect(value(ours, 'invoiceDirection')).toBe('OUTBOUND');
  });

  it('QueryTransactionListRequest: sample structure and signature, page and insDate interval', async () => {
    const theirs = sample('queryTransactionList.xml');
    const ours = buildQueryTransactionListRequest(sampleContext('queryTransactionList.xml'), 1, new Date('2020-02-05T06:46:42.223Z'), new Date('2020-02-05T08:53:16.165Z'));
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'requestSignature')).toBe(value(theirs, 'requestSignature'));
    expect(childNames(ours, 'QueryTransactionListRequest')).toEqual(childNames(theirs, 'QueryTransactionListRequest'));
    expect(childNames(ours, 'QueryTransactionListRequest/insDate')).toEqual(['dateTimeFrom', 'dateTimeTo']);
    expect(value(ours, 'dateTimeFrom')).toBe(value(theirs, 'dateTimeFrom'));
    expect(value(ours, 'dateTimeTo')).toBe(value(theirs, 'dateTimeTo'));
    expect(value(ours, 'page')).toBe('1');
  });

  it('QueryTransactionStatusRequest with returnOriginalRequest=true (reconciliation of an unclear submission)', async () => {
    const ours = buildQueryTransactionStatusRequest(FAKE_CTX, '2T6BE8A0G2EFOL0J', true);
    expect((await validateNavXml(ours, 'api')).errors).toEqual([]);
    expect(value(ours, 'returnOriginalRequest')).toBe('true');
  });
});

describe('request builders – XSD validity with OpenSzámla data', () => {
  const invoiceB64 = Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC), 'utf8').toString('base64');
  const cases: Record<string, string> = {
    tokenExchange: buildTokenExchangeRequest(FAKE_CTX),
    manageInvoice: buildManageInvoiceRequest(FAKE_CTX, 'b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U', [{ index: 1, operation: 'CREATE', invoiceDataBase64: invoiceB64 }]),
    queryTransactionStatus: buildQueryTransactionStatusRequest(FAKE_CTX, '2T6BE8A0G2EFOL0J'),
    queryTaxpayer: buildQueryTaxpayerRequest(FAKE_CTX, '87654323'),
    queryInvoiceCheck: buildQueryInvoiceCheckRequest(FAKE_CTX, 'SZ-2026-00001'),
    queryTransactionList: buildQueryTransactionListRequest(FAKE_CTX, 2, new Date('2026-10-27T12:55:00.000Z'), new Date('2026-10-27T13:07:00.000Z')),
    'minimal software block': buildTokenExchangeRequest({
      ...FAKE_CTX,
      software: { softwareId: 'OPENSZAMLA-0000001', softwareName: 'OpenSzámla', softwareOperation: 'ONLINE_SERVICE', softwareMainVersion: '0.1.0', softwareDevName: 'x', softwareDevContact: 'y' },
    }),
    'software texts with special characters / too long': buildTokenExchangeRequest({
      ...FAKE_CTX,
      software: { ...FAKE_NAV_SOFTWARE, softwareName: `Kovács & <Fiai> "számlázó" ${'x'.repeat(80)}`, softwareMainVersion: '2026.10.27-beta.123456', softwareDevCountryCode: 'hungary' },
    }),
  };

  it.each(Object.keys(cases))('%s is valid against invoiceApi.xsd', async (name) => {
    const res = await validateNavXml(cases[name] as string, 'api');
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('never puts the plain password, signing key or exchange key into a request', () => {
    for (const xml of Object.values(cases)) {
      expect(xml).not.toContain(FAKE_NAV_CREDENTIALS.password);
      expect(xml).not.toContain(FAKE_NAV_CREDENTIALS.signingKey);
      expect(xml).not.toContain(FAKE_NAV_CREDENTIALS.exchangeKey);
    }
  });

  it('rejects an invalid requestId', () => {
    expect(() => buildTokenExchangeRequest({ ...FAKE_CTX, requestId: 'has-dash' })).toThrow(AppError);
  });
});

describe('credential and software checks', () => {
  it('accepts the fake credentials and software', () => {
    expect(() => assertNavCredentials(FAKE_NAV_CREDENTIALS)).not.toThrow();
    expect(() => assertNavSoftware(FAKE_NAV_SOFTWARE)).not.toThrow();
  });

  it('explains what is wrong without echoing secret values', () => {
    const bad: NavCredentials = { login: 'a b', password: '', signingKey: 'SECRET-SIGN-KEY-123', exchangeKey: 'tooShortSecret', taxNumber: '1234' };
    try {
      assertNavCredentials(bad);
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('NAV_INVALID_CREDENTIALS');
      expect(err.message).toMatch(/login/);
      expect(err.message).toMatch(/cserekulcs/);
      expect(JSON.stringify(err)).not.toContain('tooShortSecret');
      expect(JSON.stringify(err)).not.toContain('SECRET-SIGN-KEY-123');
    }
    expect(() => assertNavSoftware({ ...FAKE_NAV_SOFTWARE, softwareId: 'too-short' })).toThrow(AppError);
  });

  it('navCredentialProblems lists every problem of the configuration (no törzsszám there) without values', () => {
    const { taxNumber: _taxNumber, ...configured } = FAKE_NAV_CREDENTIALS;
    void _taxNumber;
    expect(navCredentialProblems(configured, { taxNumber: false })).toEqual([]);
    expect(navCredentialProblems({ ...configured, login: 'tech.user', exchangeKey: 'FIFTEEN-CHARS-1' }, { taxNumber: false })).toEqual([
      'a login név 6–15 betű/szám lehet',
      'az XML cserekulcs nem 16 karakteres',
    ]);
    expect(navCredentialProblems(configured)).toEqual(['az adószám nem 8 jegyű törzsszám']);
  });
});

// ---------------------------------------------------------------------------------------------
// Responses (written the way NAV serialises them: ns2 = common, ns3 = base)
// ---------------------------------------------------------------------------------------------

const NS = 'xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:ns2="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns3="http://schemas.nav.gov.hu/OSA/3.0/base"';
const HEADER = `<ns2:header><ns2:requestId>RID1</ns2:requestId><ns2:timestamp>2026-10-27T13:05:00.000Z</ns2:timestamp><ns2:requestVersion>3.0</ns2:requestVersion><ns2:headerVersion>1.0</ns2:headerVersion></ns2:header>`;
const OK = '<ns2:result><ns2:funcCode>OK</ns2:funcCode></ns2:result>';
const SOFTWARE = `<software><softwareId>HU12345676-TESZT01</softwareId><softwareName>x</softwareName><softwareOperation>LOCAL_SOFTWARE</softwareOperation><softwareMainVersion>1</softwareMainVersion><softwareDevName>x</softwareDevName><softwareDevContact>x</softwareDevContact></software>`;
const response = (root: string, body: string, result = OK): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root} ${NS}>${HEADER}${result}${SOFTWARE}${body}</${root}>`;

const TOKEN_RESPONSE = response(
  'TokenExchangeResponse',
  '<encodedExchangeToken>dGVzdA==</encodedExchangeToken><tokenValidityFrom>2026-10-27T13:05:00.000Z</tokenValidityFrom><tokenValidityTo>2026-10-27T13:10:00.000Z</tokenValidityTo>',
);
const MANAGE_RESPONSE = response('ManageInvoiceResponse', '<transactionId>2T6BE8A0G2EFOL0J</transactionId>');
const STATUS_RESPONSE = response(
  'QueryTransactionStatusResponse',
  `<processingResults>
     <processingResult>
       <index>1</index><invoiceStatus>DONE</invoiceStatus>
       <businessValidationMessages>
         <validationResultCode>WARN</validationResultCode>
         <validationErrorCode>INCORRECT_COUNTY_CODE_CUSTOMER</validationErrorCode>
         <message>A vevő megyekódja hibás.</message>
         <pointer><tag>InvoiceData/invoiceMain/invoice/invoiceHead/customerInfo</tag><value>13</value></pointer>
       </businessValidationMessages>
       <compressedContentIndicator>false</compressedContentIndicator>
     </processingResult>
     <processingResult>
       <index>2</index><invoiceStatus>ABORTED</invoiceStatus>
       <technicalValidationMessages><ns2:validationResultCode>ERROR</ns2:validationResultCode><ns2:validationErrorCode>SCHEMA_VIOLATION</ns2:validationErrorCode><ns2:message>cvc-complex-type.2.4.a: Invalid content</ns2:message></technicalValidationMessages>
       <businessValidationMessages><validationResultCode>ERROR</validationResultCode><validationErrorCode>INVALID_LINE_OPERATION</validationErrorCode><message>MODIFY nem használható</message><pointer><line>2</line></pointer></businessValidationMessages>
       <businessValidationMessages><validationResultCode>INFO</validationResultCode><validationErrorCode>MODIFICATIONINDEX_SEQUENCE_INCOMPLETE</validationErrorCode></businessValidationMessages>
       <compressedContentIndicator>false</compressedContentIndicator>
       <originalRequest>PD94bWw+</originalRequest>
     </processingResult>
     <originalRequestVersion>3.0</originalRequestVersion>
   </processingResults>`,
);
const TAXPAYER_RESPONSE = response(
  'QueryTaxpayerResponse',
  `<infoDate>2025-01-15T00:00:00.000Z</infoDate><taxpayerValidity>true</taxpayerValidity>
   <taxpayerData>
     <taxpayerName>ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP ZRT.</taxpayerName>
     <taxNumberDetail><ns3:taxpayerId>87654323</ns3:taxpayerId><ns3:vatCode>2</ns3:vatCode><ns3:countyCode>13</ns3:countyCode></taxNumberDetail>
     <incorporation>ORGANIZATION</incorporation>
     <vatGroupMembership>22223333</vatGroupMembership>
     <taxpayerAddressList>
       <taxpayerAddressItem><taxpayerAddressType>HQ</taxpayerAddressType>
         <taxpayerAddress><ns3:countryCode>HU</ns3:countryCode><ns3:postalCode>1117</ns3:postalCode><ns3:city>BUDAPEST</ns3:city><ns3:streetName>OKTÓBER HUSZONHARMADIKA</ns3:streetName><ns3:publicPlaceCategory>UTCA</ns3:publicPlaceCategory><ns3:number>18</ns3:number><ns3:floor>2</ns3:floor><ns3:door>5</ns3:door></taxpayerAddress>
       </taxpayerAddressItem>
     </taxpayerAddressList>
   </taxpayerData>`,
);
const TAXPAYER_NOT_FOUND = response('QueryTaxpayerResponse', '<taxpayerValidity>false</taxpayerValidity>');
const GENERAL_ERROR = response(
  'GeneralErrorResponse',
  `<technicalValidationMessages><ns2:validationResultCode>ERROR</ns2:validationResultCode><ns2:validationErrorCode>SCHEMA_VIOLATION</ns2:validationErrorCode><ns2:message>cvc-pattern-valid: login</ns2:message></technicalValidationMessages>`,
  '<ns2:result><ns2:funcCode>ERROR</ns2:funcCode><ns2:errorCode>INVALID_REQUEST</ns2:errorCode><ns2:message>Helytelen kérés!</ns2:message></ns2:result>',
);
/** Shape observed on the live test API (docs/research/03, 6.1): common as default namespace, notifications. */
const GENERAL_EXCEPTION = `<?xml version="1.0" encoding="UTF-8"?><GeneralExceptionResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"><funcCode>ERROR</funcCode><errorCode>INVALID_REQUEST</errorCode><message>Érvénytelen kérés!</message><notifications><notification><notificationCode>SCHEMA_VIOLATION</notificationCode><notificationText>Request body contains on line: [1] and column: [47] error: [cvc-elt.1.a: Cannot find the declaration of element 'Probe'.]</notificationText></notification></notifications></GeneralExceptionResponse>`;

describe('response parsers', () => {
  it('the hand-written NAV-style responses are themselves valid against invoiceApi.xsd', async () => {
    for (const xml of [TOKEN_RESPONSE, MANAGE_RESPONSE, STATUS_RESPONSE, TAXPAYER_RESPONSE, TAXPAYER_NOT_FOUND, GENERAL_ERROR]) {
      const res = await validateNavXml(xml, 'api');
      expect(res.errors).toEqual([]);
    }
  });

  it('TokenExchangeResponse', () => {
    expect(navErrorInfo(TOKEN_RESPONSE)).toBeNull();
    expect(parseTokenExchangeResponse(TOKEN_RESPONSE)).toEqual({
      encodedExchangeToken: 'dGVzdA==',
      tokenValidityFrom: '2026-10-27T13:05:00.000Z',
      tokenValidityTo: '2026-10-27T13:10:00.000Z',
    });
  });

  it('ManageInvoiceResponse', () => {
    expect(parseManageInvoiceResponse(MANAGE_RESPONSE)).toEqual({ transactionId: '2T6BE8A0G2EFOL0J' });
  });

  it('QueryTransactionStatusResponse: statuses, technical + business messages, pointers, original request', () => {
    expect(parseQueryTransactionStatusResponse(STATUS_RESPONSE)).toStrictEqual([
      {
        index: 1,
        invoiceStatus: 'DONE',
        messages: [
          {
            severity: 'WARN',
            code: 'INCORRECT_COUNTY_CODE_CUSTOMER',
            message: 'A vevő megyekódja hibás.',
            pointer: 'tag: InvoiceData/invoiceMain/invoice/invoiceHead/customerInfo; value: 13',
          },
        ],
      },
      {
        index: 2,
        invoiceStatus: 'ABORTED',
        messages: [
          { severity: 'ERROR', code: 'SCHEMA_VIOLATION', message: 'cvc-complex-type.2.4.a: Invalid content' },
          { severity: 'ERROR', code: 'INVALID_LINE_OPERATION', message: 'MODIFY nem használható', pointer: 'line: 2' },
          { severity: 'INFO', code: 'MODIFICATIONINDEX_SEQUENCE_INCOMPLETE', message: '' },
        ],
        // returnOriginalRequest=true: the invoiceData NAV received, to recognise a lost submission of ours.
        originalRequest: 'PD94bWw+',
      },
    ]);
  });

  it('decodes numeric character references in NAV texts (fast-xml-parser leaves them alone by default)', () => {
    const xml = STATUS_RESPONSE.replace('A vevő megyekódja hibás.', 'A &#34;13&#34; megyek&#xF3;d hib&#225;s &#38;lt;!&gt;');
    expect(parseQueryTransactionStatusResponse(xml)[0]?.messages[0]?.message).toBe('A "13" megyekód hibás &lt;!>');
  });

  it('a UTF-8 byte order mark before the declaration is tolerated', () => {
    expect(parseManageInvoiceResponse(`﻿${MANAGE_RESPONSE}`)).toEqual({ transactionId: '2T6BE8A0G2EFOL0J' });
  });

  it('QueryTransactionStatusResponse without processingResults (unknown transaction) → []', () => {
    expect(parseQueryTransactionStatusResponse(response('QueryTransactionStatusResponse', ''))).toEqual([]);
  });

  it('QueryInvoiceCheckResponse → invoiceCheckResult (xs:boolean)', () => {
    expect(parseQueryInvoiceCheckResponse(response('QueryInvoiceCheckResponse', '<invoiceCheckResult>true</invoiceCheckResult>'))).toBe(true);
    expect(parseQueryInvoiceCheckResponse(response('QueryInvoiceCheckResponse', '<invoiceCheckResult>0</invoiceCheckResult>'))).toBe(false);
    expect(() => parseQueryInvoiceCheckResponse(response('QueryInvoiceCheckResponse', ''))).toThrow(NavResponseFormatError);
  });

  it('QueryTransactionListResponse → pages and transactions; the submitting user only as "ours or not", never the login', () => {
    const tx = (id: string, status: string, user = 'lwilsmn0uqdxe6u') =>
      `<transaction><insDate>2026-10-27T13:05:01.123Z</insDate><insCusUser>${user}</insCusUser><source>MGM</source><transactionId>${id}</transactionId><requestStatus>${status}</requestStatus><technicalAnnulment>false</technicalAnnulment><originalRequestVersion>3.0</originalRequestVersion><itemCount>1</itemCount></transaction>`;
    const xml = response(
      'QueryTransactionListResponse',
      `<transactionListResult><currentPage>1</currentPage><availablePage>2</availablePage>${tx('2T6BE8A0G2EFOL0J', 'FINISHED')}${tx('3X7CF9B1H3FGPM1K', 'RECEIVED', 'webshop2026')}</transactionListResult>`,
    );
    const parsed = parseQueryTransactionListResponse(xml, 'LWILSMN0UQDXE6U');
    expect(parsed).toStrictEqual({
      currentPage: 1,
      availablePage: 2,
      transactions: [
        { transactionId: '2T6BE8A0G2EFOL0J', insDate: '2026-10-27T13:05:01.123Z', ownUser: true, source: 'MGM', requestStatus: 'FINISHED', technicalAnnulment: false, itemCount: 1 },
        { transactionId: '3X7CF9B1H3FGPM1K', insDate: '2026-10-27T13:05:01.123Z', ownUser: false, source: 'MGM', requestStatus: 'RECEIVED', technicalAnnulment: false, itemCount: 1 },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/lwilsmn0uqdxe6u|webshop2026/i);
    const empty = parseQueryTransactionListResponse(response('QueryTransactionListResponse', '<transactionListResult><currentPage>1</currentPage><availablePage>0</availablePage></transactionListResult>'), 'lwilsmn0uqdxe6u');
    expect(empty.transactions).toEqual([]);
    expect(() =>
      parseQueryTransactionListResponse(response('QueryTransactionListResponse', `<transactionListResult><currentPage>1</currentPage><availablePage>1</availablePage>${tx('2T6BE8A0G2EFOL0J', 'LOST')}</transactionListResult>`), 'lwilsmn0uqdxe6u'),
    ).toThrow(NavResponseFormatError);
  });

  it('QueryTaxpayerResponse: found / not found', () => {
    expect(parseQueryTaxpayerResponse(TAXPAYER_RESPONSE)).toEqual({
      valid: true,
      name: 'ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP ZRT.',
      shortName: null,
      taxpayerId: '87654323',
      vatCode: '2',
      countyCode: '13',
      formattedTaxNumber: '87654323-2-13',
      incorporation: 'ORGANIZATION',
      vatGroupMembership: '22223333',
      addresses: [{ type: 'HQ', address: { countryCode: 'HU', postalCode: '1117', city: 'BUDAPEST', addressLine: 'OKTÓBER HUSZONHARMADIKA UTCA 18. 2/5.' } }],
      infoDate: '2025-01-15T00:00:00.000Z',
    });
    expect(parseQueryTaxpayerResponse(TAXPAYER_NOT_FOUND)).toBeNull();
  });

  it('GeneralErrorResponse and GeneralExceptionResponse', () => {
    expect(navErrorInfo(GENERAL_ERROR)).toEqual({
      errorCode: 'INVALID_REQUEST',
      message: 'Helytelen kérés!',
      technicalMessages: [{ severity: 'ERROR', code: 'SCHEMA_VIOLATION', message: 'cvc-pattern-valid: login' }],
    });
    expect(navErrorInfo(GENERAL_EXCEPTION)).toEqual({
      errorCode: 'INVALID_REQUEST',
      message: 'Érvénytelen kérés!',
      technicalMessages: [
        {
          severity: 'ERROR',
          code: 'SCHEMA_VIOLATION',
          message: "Request body contains on line: [1] and column: [47] error: [cvc-elt.1.a: Cannot find the declaration of element 'Probe'.]",
        },
      ],
    });
    const funcError = response('QueryTaxpayerResponse', '', '<ns2:result><ns2:funcCode>ERROR</ns2:funcCode><ns2:errorCode>OPERATION_FAILED</ns2:errorCode></ns2:result>');
    expect(navErrorInfo(funcError)?.errorCode).toBe('OPERATION_FAILED');
  });

  it('structural problems raise NavResponseFormatError', () => {
    expect(() => parseNavResponseXml('Undertow message, Generic exception occurred!')).toThrow(NavResponseFormatError);
    expect(() => parseNavResponseXml('<a><b></a>')).toThrow(NavResponseFormatError);
    expect(() => parseManageInvoiceResponse(TOKEN_RESPONSE)).toThrow(NavResponseFormatError);
    expect(() => parseTokenExchangeResponse(response('TokenExchangeResponse', ''))).toThrow(NavResponseFormatError);
    const badStatus = STATUS_RESPONSE.replace('<invoiceStatus>DONE</invoiceStatus>', '<invoiceStatus>WHATEVER</invoiceStatus>');
    expect(() => parseQueryTransactionStatusResponse(badStatus)).toThrow(NavResponseFormatError);
  });
});

describe('secret hygiene helpers', () => {
  it('redactSecrets replaces every occurrence (case-insensitively)', () => {
    expect(redactSecrets('a SeCrEtKey b secretkey c', ['secretkey'])).toBe('a *** b *** c');
    expect(redactSecrets('short ab stays', ['ab'])).toBe('short ab stays');
  });

  it('sanitizeNavXml drops echoed payloads/tokens and masks hashes', () => {
    const hash = passwordHash('pw');
    const xml = `<r xmlns:common="c"><common:passwordHash cryptoType="SHA-512">${hash}</common:passwordHash><common:requestSignature cryptoType="SHA3-512">ABC</common:requestSignature><exchangeToken>tok-123456</exchangeToken><encodedExchangeToken>ZW5j</encodedExchangeToken><originalRequest>PD94bWw+</originalRequest><originalRequest/><note>leaked tok-123456 and MY-SIGNING-KEY</note></r>`;
    const out = sanitizeNavXml(xml, ['MY-SIGNING-KEY', 'tok-123456', hash]);
    expect(out).not.toContain(hash);
    expect(out).not.toContain('tok-123456');
    expect(out).not.toContain('MY-SIGNING-KEY');
    expect(out).not.toContain('originalRequest');
    expect(out).not.toContain('ZW5j');
    expect(out).toContain('<common:passwordHash cryptoType="SHA-512">***</common:passwordHash>');
    expect(out).toContain('<common:requestSignature cryptoType="SHA3-512">***</common:requestSignature>');
    expect(out).toContain('<note>leaked *** and ***</note>');
  });
});
