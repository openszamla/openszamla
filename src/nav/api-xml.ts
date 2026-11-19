/**
 * NAV Online Számla v3.0 API messages (invoiceApi.xsd): request builders and response parsers.
 *
 * Requests: root element in the api namespace (default namespace), `common:` prefix for the
 * header/user blocks (common.xsd), then `software` and the operation specific elements – the same
 * shape as the official samples in vendor/nav-online-invoice/samples/api. Every builder is
 * validated against invoiceApi.xsd in test/nav/api-xml.test.ts.
 *
 * Responses are parsed with fast-xml-parser (namespace prefixes removed, every value kept as a
 * string). Repeated elements are normalised with `asArray`, so one or many occurrences parse alike.
 * Parsers throw NavResponseFormatError for structurally unexpected responses; the client maps that
 * (and GeneralErrorResponse / funcCode=ERROR, see navErrorInfo) to NavError.
 */
import { XMLParser } from 'fast-xml-parser';
import { AppError } from '../core/errors.ts';
import type { Address, NavMessage } from '../core/types.ts';
import { invoiceHash, passwordHash, REQUEST_ID_RE, requestSignature, requestTimestamp } from './crypto.ts';
import { decodeInvoiceData } from './invoice-data.ts';
import {
  NAV_NAMESPACES,
  type NavCredentials,
  type NavInvoiceAuditData,
  type NavInvoiceKeys,
  type NavInvoiceLineKeys,
  type NavInvoiceOperationInput,
  type NavInvoiceStatus,
  type NavProcessingResult,
  type NavRequestStatus,
  type NavSoftware,
  type NavTransactionInfo,
  type TaxpayerInfo,
} from './types.ts';
import { el, leaf, normalizeXmlText, serializeXml, type XmlChild } from './xml.ts';

export const NAV_REQUEST_VERSION = '3.0';
export const NAV_HEADER_VERSION = '1.0';

/** Everything a request needs besides its operation specific content. */
export interface NavRequestContext {
  requestId: string;
  /** Client time of the request (sent as UTC header timestamp and used in the signature). */
  timestamp: Date;
  credentials: NavCredentials;
  software: NavSoftware;
}

// ---------------------------------------------------------------------------------------------
// Input validation (never echoes secret values)
// ---------------------------------------------------------------------------------------------

/**
 * Format problems of the technical user data (common:LoginType, TaxpayerIdType, non-empty keys, a 16-byte
 * exchange key), in Hungarian and without any of the values; [] when they are usable. `taxNumber: false`
 * leaves out the törzsszám (the configuration has none: it comes from the seller profile).
 */
export function navCredentialProblems(c: Partial<NavCredentials> | null | undefined, opts: { taxNumber?: boolean } = {}): string[] {
  if (!c) return ['hiányzik'];
  const problems: string[] = [];
  if (typeof c.login !== 'string' || !/^[a-zA-Z0-9]{6,15}$/.test(c.login)) problems.push('a login név 6–15 betű/szám lehet');
  if (typeof c.password !== 'string' || c.password.length === 0) problems.push('a jelszó üres');
  if (typeof c.signingKey !== 'string' || c.signingKey.length === 0) problems.push('az XML aláírókulcs üres');
  if (typeof c.exchangeKey !== 'string' || Buffer.byteLength(c.exchangeKey, 'utf8') !== 16) problems.push('az XML cserekulcs nem 16 karakteres');
  if ((opts.taxNumber ?? true) && (typeof c.taxNumber !== 'string' || !/^\d{8}$/.test(c.taxNumber))) problems.push('az adószám nem 8 jegyű törzsszám');
  return problems;
}

/** Format checks of the technical user data (see navCredentialProblems). */
export function assertNavCredentials(c: NavCredentials | null | undefined): void {
  const problems = navCredentialProblems(c);
  if (problems.length) {
    throw new AppError('NAV_INVALID_CREDENTIALS', `A NAV technikai felhasználó adatai hibásak: ${problems.join('; ')}.`, {
      hint: 'Add meg újra a technikai felhasználó adatait (openszamla nav-setup vagy OPENSZAMLA_NAV_* környezeti változók).',
    });
  }
}

/** SoftwareType problem (softwareId is exactly 18 characters of [0-9A-Z-]), in Hungarian; null when usable. */
export function navSoftwareProblem(s: NavSoftware | null | undefined): string | null {
  if (!s || !/^[0-9A-Z-]{18}$/.test(s.softwareId ?? '')) {
    return 'A számlázó program azonosítója (softwareId, OPENSZAMLA_SOFTWARE_ID) pontosan 18 karakter lehet: nagybetű, szám vagy kötőjel.';
  }
  if (s.softwareOperation !== 'LOCAL_SOFTWARE' && s.softwareOperation !== 'ONLINE_SERVICE') return 'A softwareOperation értéke LOCAL_SOFTWARE vagy ONLINE_SERVICE lehet.';
  return null;
}

/** SoftwareType checks (see navSoftwareProblem). */
export function assertNavSoftware(s: NavSoftware | null | undefined): void {
  const problem = navSoftwareProblem(s);
  if (problem) {
    throw new AppError('NAV_INVALID_SOFTWARE', problem, { hint: 'Ellenőrizd az OPENSZAMLA_SOFTWARE_ID beállítást (vagy hagyd üresen: akkor a beépített azonosító érvényes).' });
  }
}

// ---------------------------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------------------------

function text(value: string | null | undefined, max: number, fallback: string): string {
  return normalizeXmlText(value, max) ?? fallback;
}

function softwareEl(s: NavSoftware): XmlChild {
  const country = (s.softwareDevCountryCode ?? '').trim().toUpperCase();
  return el('software', [
    leaf('softwareId', s.softwareId),
    leaf('softwareName', text(s.softwareName, 50, 'OpenSzámla')),
    leaf('softwareOperation', s.softwareOperation),
    leaf('softwareMainVersion', text(s.softwareMainVersion, 15, '0')),
    leaf('softwareDevName', text(s.softwareDevName, 512, 'OpenSzámla')),
    leaf('softwareDevContact', text(s.softwareDevContact, 200, '-')),
    /^[A-Z]{2}$/.test(country) && leaf('softwareDevCountryCode', country),
    s.softwareDevTaxNumber && normalizeXmlText(s.softwareDevTaxNumber, 50) ? leaf('softwareDevTaxNumber', normalizeXmlText(s.softwareDevTaxNumber, 50) as string) : null,
  ]);
}

function buildRequest(rootName: string, ctx: NavRequestContext, itemHashes: string[], body: XmlChild[]): string {
  if (!REQUEST_ID_RE.test(ctx.requestId)) {
    throw new AppError('NAV_INVALID_REQUEST_ID', `Érvénytelen NAV requestId: ${ctx.requestId}`, { hint: 'Minta: [+a-zA-Z0-9_]{1,30}' });
  }
  const c = ctx.credentials;
  const root = el(
    rootName,
    [
      el('common:header', [
        leaf('common:requestId', ctx.requestId),
        leaf('common:timestamp', requestTimestamp(ctx.timestamp)),
        leaf('common:requestVersion', NAV_REQUEST_VERSION),
        leaf('common:headerVersion', NAV_HEADER_VERSION),
      ]),
      el('common:user', [
        leaf('common:login', c.login),
        leaf('common:passwordHash', passwordHash(c.password), { cryptoType: 'SHA-512' }),
        leaf('common:taxNumber', c.taxNumber),
        leaf('common:requestSignature', requestSignature(ctx.requestId, ctx.timestamp, c.signingKey, itemHashes), { cryptoType: 'SHA3-512' }),
      ]),
      softwareEl(ctx.software),
      body,
    ],
    { 'xmlns:common': NAV_NAMESPACES.common, xmlns: NAV_NAMESPACES.api },
  );
  return serializeXml(root);
}

/** TokenExchangeRequest – header, user, software only. */
export function buildTokenExchangeRequest(ctx: NavRequestContext): string {
  return buildRequest('TokenExchangeRequest', ctx, [], []);
}

/**
 * ManageInvoiceRequest with the decoded exchange token and up to 100 invoice operations (index
 * 1..n). The signature includes SHA3-512(operation + base64 invoiceData) of every item in order – of the
 * base64 text as sent, so of the compressed data when compressedContent is true (every item is then
 * base64(gzip(xml)), spec 1.6.5).
 */
export function buildManageInvoiceRequest(ctx: NavRequestContext, exchangeToken: string, operations: readonly NavInvoiceOperationInput[], compressedContent = false): string {
  const ops = [...operations].sort((a, b) => a.index - b.index);
  const hashes = ops.map((o) => invoiceHash(o.operation, o.invoiceDataBase64));
  return buildRequest('ManageInvoiceRequest', ctx, hashes, [
    leaf('exchangeToken', exchangeToken),
    el('invoiceOperations', [
      leaf('compressedContent', compressedContent),
      ops.map((o) => el('invoiceOperation', [leaf('index', o.index), leaf('invoiceOperation', o.operation), leaf('invoiceData', o.invoiceDataBase64)])),
    ]),
  ]);
}

/** QueryTransactionStatusRequest (returnOriginalRequest=false unless asked: the echo would carry invoice data). */
export function buildQueryTransactionStatusRequest(ctx: NavRequestContext, transactionId: string, returnOriginalRequest = false): string {
  return buildRequest('QueryTransactionStatusRequest', ctx, [], [leaf('transactionId', transactionId), leaf('returnOriginalRequest', returnOriginalRequest)]);
}

/** QueryTaxpayerRequest for an 8-digit törzsszám. */
export function buildQueryTaxpayerRequest(ctx: NavRequestContext, taxpayerId: string): string {
  return buildRequest('QueryTaxpayerRequest', ctx, [], [leaf('taxNumber', taxpayerId)]);
}

/** QueryInvoiceCheckRequest: is `invoiceNumber`, issued by the requesting taxpayer (OUTBOUND), valid at NAV exactly once? */
export function buildQueryInvoiceCheckRequest(ctx: NavRequestContext, invoiceNumber: string): string {
  return buildRequest('QueryInvoiceCheckRequest', ctx, [], [el('invoiceNumberQuery', [leaf('invoiceNumber', invoiceNumber), leaf('invoiceDirection', 'OUTBOUND')])]);
}

/** QueryInvoiceDataRequest: the data NAV holds for `invoiceNumber`, issued by the requesting taxpayer (OUTBOUND). */
export function buildQueryInvoiceDataRequest(ctx: NavRequestContext, invoiceNumber: string): string {
  return buildRequest('QueryInvoiceDataRequest', ctx, [], [el('invoiceNumberQuery', [leaf('invoiceNumber', invoiceNumber), leaf('invoiceDirection', 'OUTBOUND')])]);
}

/** QueryTransactionListRequest: one page of the transactions NAV received between `from` and `to` (insDate, UTC). */
export function buildQueryTransactionListRequest(ctx: NavRequestContext, page: number, from: Date, to: Date): string {
  return buildRequest('QueryTransactionListRequest', ctx, [], [
    leaf('page', page),
    el('insDate', [leaf('dateTimeFrom', requestTimestamp(from)), leaf('dateTimeTo', requestTimestamp(to))]),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------------------------

/** The response is not what invoiceApi.xsd describes (not XML, wrong root, missing element …). */
export class NavResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavResponseFormatError';
  }
}

type Obj = Record<string, unknown>;

export interface NavResponseDoc {
  /** Root element name without namespace prefix, e.g. "TokenExchangeResponse", "GeneralErrorResponse". */
  rootName: string;
  root: Obj;
  /** The raw response text. */
  raw: string;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  // fast-xml-parser only resolves the five predefined entities by default; numeric character
  // references (&#13; &#x151; – legal in any XML, e.g. in NAV message texts) need this option.
  htmlEntities: true,
});

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

/** Text value of a leaf (string, or `#text` of an element that also had attributes). */
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const o = obj(v);
  if (o && '#text' in o) return str(o['#text']);
  return null;
}

export function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

/** Parses any NAV response body. Throws NavResponseFormatError when it is not well-formed XML. */
export function parseNavResponseXml(xml: string): NavResponseDoc {
  const trimmed = xml.trim();
  if (!trimmed.startsWith('<')) throw new NavResponseFormatError('The response is not XML.');
  let parsed: unknown;
  try {
    parsed = parser.parse(trimmed, true);
  } catch (e) {
    throw new NavResponseFormatError(`The response is not well-formed XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const top = obj(parsed);
  const rootName = top ? Object.keys(top).find((k) => !k.startsWith('?') && !k.startsWith('#')) : undefined;
  if (!top || !rootName) throw new NavResponseFormatError('The response has no root element.');
  return { rootName, root: obj(top[rootName]) ?? {}, raw: xml };
}

function toDoc(input: string | NavResponseDoc): NavResponseDoc {
  return typeof input === 'string' ? parseNavResponseXml(input) : input;
}

function expectRoot(doc: NavResponseDoc, name: string): Obj {
  if (doc.rootName !== name) throw new NavResponseFormatError(`Unexpected response element ${doc.rootName} (expected ${name}).`);
  return doc.root;
}

function required(o: Obj, key: string, where: string): string {
  const v = str(o[key]);
  if (v === null) throw new NavResponseFormatError(`Missing ${key} in ${where}.`);
  return v;
}

export interface NavErrorInfo {
  errorCode: string;
  message: string | null;
  /** technicalValidationMessages of a GeneralErrorResponse (schema violations of the request). */
  technicalMessages: NavMessage[];
}

function technicalMessages(v: unknown): NavMessage[] {
  return asArray(v).map((m) => {
    const o = obj(m) ?? {};
    return {
      severity: 'ERROR' as const,
      code: str(o.validationErrorCode) ?? str(o.validationResultCode) ?? 'TECHNICAL_ERROR',
      message: str(o.message) ?? '',
    };
  });
}

function pointerText(v: unknown): string | undefined {
  const p = obj(v);
  if (!p) return undefined;
  const parts = [
    str(p.tag) && `tag: ${str(p.tag)}`,
    str(p.value) && `value: ${str(p.value)}`,
    str(p.line) && `line: ${str(p.line)}`,
    str(p.originalInvoiceNumber) && `originalInvoiceNumber: ${str(p.originalInvoiceNumber)}`,
  ].filter((x): x is string => typeof x === 'string');
  return parts.length ? parts.join('; ') : undefined;
}

function businessMessages(v: unknown): NavMessage[] {
  return asArray(v).map((m) => {
    const o = obj(m) ?? {};
    const result = str(o.validationResultCode);
    const severity: NavMessage['severity'] = result === 'WARN' ? 'WARN' : result === 'INFO' ? 'INFO' : 'ERROR';
    const msg: NavMessage = { severity, code: str(o.validationErrorCode) ?? result ?? 'UNKNOWN', message: str(o.message) ?? '' };
    const pointer = pointerText(o.pointer);
    if (pointer) msg.pointer = pointer;
    return msg;
  });
}

/** BasicResultType/notifications (e.g. the SCHEMA_VIOLATION details of a GeneralExceptionResponse). */
function notificationMessages(v: unknown): NavMessage[] {
  return asArray(obj(v)?.notification).map((n) => {
    const o = obj(n) ?? {};
    return { severity: 'ERROR' as const, code: str(o.notificationCode) ?? 'NOTIFICATION', message: str(o.notificationText) ?? '' };
  });
}

/**
 * Error content of a response: GeneralExceptionResponse, GeneralErrorResponse, or any response
 * whose result/funcCode is ERROR. null for successful (funcCode=OK) responses.
 */
export function navErrorInfo(input: string | NavResponseDoc): NavErrorInfo | null {
  const doc = toDoc(input);
  if (doc.rootName === 'GeneralExceptionResponse') {
    return {
      errorCode: str(doc.root.errorCode) ?? 'GENERAL_EXCEPTION',
      message: str(doc.root.message),
      technicalMessages: notificationMessages(doc.root.notifications),
    };
  }
  const result = obj(doc.root.result);
  const funcCode = str(result?.funcCode);
  if (doc.rootName === 'GeneralErrorResponse' || funcCode === 'ERROR') {
    return {
      errorCode: str(result?.errorCode) ?? 'UNKNOWN_ERROR',
      message: str(result?.message),
      technicalMessages: [...technicalMessages(doc.root.technicalValidationMessages), ...notificationMessages(result?.notifications)],
    };
  }
  return null;
}

export function parseTokenExchangeResponse(input: string | NavResponseDoc): {
  encodedExchangeToken: string;
  tokenValidityFrom: string | null;
  tokenValidityTo: string | null;
} {
  const root = expectRoot(toDoc(input), 'TokenExchangeResponse');
  return {
    encodedExchangeToken: required(root, 'encodedExchangeToken', 'TokenExchangeResponse'),
    tokenValidityFrom: str(root.tokenValidityFrom),
    tokenValidityTo: str(root.tokenValidityTo),
  };
}

export function parseManageInvoiceResponse(input: string | NavResponseDoc): { transactionId: string } {
  const root = expectRoot(toDoc(input), 'ManageInvoiceResponse');
  const transactionId = required(root, 'transactionId', 'ManageInvoiceResponse');
  if (!REQUEST_ID_RE.test(transactionId)) throw new NavResponseFormatError('Invalid transactionId in ManageInvoiceResponse.');
  return { transactionId };
}

const INVOICE_STATUSES: ReadonlySet<string> = new Set<NavInvoiceStatus>(['RECEIVED', 'PROCESSING', 'SAVED', 'DONE', 'ABORTED']);

/** processingResults → one entry per processingResult (technical + business messages merged). */
export function parseQueryTransactionStatusResponse(input: string | NavResponseDoc): NavProcessingResult[] {
  const root = expectRoot(toDoc(input), 'QueryTransactionStatusResponse');
  const list = obj(root.processingResults);
  if (!list) return [];
  return asArray(list.processingResult).map((item) => {
    const p = obj(item) ?? {};
    const index = Number(required(p, 'index', 'processingResult'));
    const status = required(p, 'invoiceStatus', 'processingResult');
    if (!Number.isInteger(index) || index < 1) throw new NavResponseFormatError('Invalid processingResult/index.');
    if (!INVOICE_STATUSES.has(status)) throw new NavResponseFormatError(`Unknown invoiceStatus ${status}.`);
    const result: NavProcessingResult = {
      index,
      invoiceStatus: status as NavInvoiceStatus,
      messages: [...technicalMessages(p.technicalValidationMessages), ...businessMessages(p.businessValidationMessages)],
    };
    const original = str(p.originalRequest);
    if (original) result.originalRequest = original;
    return result;
  });
}

/** QueryInvoiceCheckResponse → invoiceCheckResult: true when the invoice number is valid at NAV exactly once. */
export function parseQueryInvoiceCheckResponse(input: string | NavResponseDoc): boolean {
  const root = expectRoot(toDoc(input), 'QueryInvoiceCheckResponse');
  const v = required(root, 'invoiceCheckResult', 'QueryInvoiceCheckResponse');
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new NavResponseFormatError(`Invalid invoiceCheckResult ${v}.`);
}

const REQUEST_STATUSES: ReadonlySet<string> = new Set<NavRequestStatus>(['RECEIVED', 'PROCESSING', 'SAVED', 'FINISHED', 'NOTIFIED']);

/**
 * QueryTransactionListResponse → one page of transactions. The submitting user (insCusUser) is only compared
 * with `ownLogin` (case-insensitively; a transaction without it counts as our own), its login is not kept.
 */
export function parseQueryTransactionListResponse(input: string | NavResponseDoc, ownLogin: string): { currentPage: number; availablePage: number; transactions: NavTransactionInfo[] } {
  const root = expectRoot(toDoc(input), 'QueryTransactionListResponse');
  const result = obj(root.transactionListResult);
  if (!result) throw new NavResponseFormatError('Missing transactionListResult in QueryTransactionListResponse.');
  const currentPage = Number(required(result, 'currentPage', 'transactionListResult'));
  const availablePage = Number(required(result, 'availablePage', 'transactionListResult'));
  if (!Number.isInteger(currentPage) || currentPage < 0 || !Number.isInteger(availablePage) || availablePage < 0) {
    throw new NavResponseFormatError('Invalid page numbers in transactionListResult.');
  }
  const transactions = asArray(result.transaction).map((t): NavTransactionInfo => {
    const o = obj(t) ?? {};
    const transactionId = required(o, 'transactionId', 'transaction');
    const requestStatus = required(o, 'requestStatus', 'transaction');
    if (!REQUEST_ID_RE.test(transactionId)) throw new NavResponseFormatError('Invalid transactionId in the transaction list.');
    if (!REQUEST_STATUSES.has(requestStatus)) throw new NavResponseFormatError(`Unknown requestStatus ${requestStatus}.`);
    const user = str(o.insCusUser);
    return {
      transactionId,
      insDate: required(o, 'insDate', 'transaction'),
      ownUser: user === null || user.toLowerCase() === ownLogin.toLowerCase(),
      source: str(o.source) ?? '',
      requestStatus: requestStatus as NavRequestStatus,
      technicalAnnulment: str(o.technicalAnnulment) === 'true',
      itemCount: Number(str(o.itemCount) ?? '0'),
    };
  });
  return { currentPage, availablePage, transactions };
}

/**
 * QueryInvoiceDataResponse → the invoice NAV holds (its InvoiceData XML bytes, decompressed when it was sent
 * compressed, and the audit data), or found: false when there is no invoiceDataResult (no valid invoice with
 * that number). MULTIPLE_QUERY_RESULT_FOUND comes as a GeneralErrorResponse (see NavClient.queryInvoiceData).
 */
export function parseQueryInvoiceDataResponse(
  input: string | NavResponseDoc,
): { found: false } | { found: true; invoiceData: Buffer; compressed: boolean; audit: NavInvoiceAuditData } {
  const root = expectRoot(toDoc(input), 'QueryInvoiceDataResponse');
  const result = obj(root.invoiceDataResult);
  if (!result) return { found: false };
  const flag = required(result, 'compressedContentIndicator', 'invoiceDataResult');
  if (flag !== 'true' && flag !== 'false' && flag !== '1' && flag !== '0') throw new NavResponseFormatError(`Invalid compressedContentIndicator ${flag}.`);
  let invoiceData: Buffer;
  try {
    invoiceData = decodeInvoiceData(required(result, 'invoiceData', 'invoiceDataResult').replace(/\s+/g, ''));
  } catch {
    throw new NavResponseFormatError('The invoiceData of QueryInvoiceDataResponse cannot be decompressed.');
  }
  const audit = obj(result.auditData);
  if (!audit) throw new NavResponseFormatError('Missing auditData in invoiceDataResult.');
  const index = str(audit.index);
  return {
    found: true,
    invoiceData,
    compressed: flag === 'true' || flag === '1',
    // "insdate" with a lower-case d in AuditDataType (unlike insDate everywhere else).
    audit: { insDate: required(audit, 'insdate', 'auditData'), source: str(audit.source) ?? '', transactionId: str(audit.transactionId), index: index === null ? null : Number(index) },
  };
}

/**
 * The key data of an InvoiceData XML (data namespace, as NAV returns it from queryInvoiceData): number, issue
 * date, supplier and customer identification, currency, the HUF totals and the lines. Fields the document does not
 * have (e.g. a simplified invoice's normal summary) – or every field, when it is not an InvoiceData – are null.
 */
export function parseInvoiceDataKeys(xml: Buffer | string): NavInvoiceKeys {
  let data: Obj = {};
  try {
    data = obj(obj(parser.parse(typeof xml === 'string' ? xml : xml.toString('utf8'), true))?.InvoiceData) ?? {};
  } catch {
    data = {};
  }
  const invoice = obj(obj(data.invoiceMain)?.invoice) ?? {};
  const head = obj(invoice.invoiceHead) ?? {};
  const customer = obj(head.customerInfo) ?? {};
  const vatData = obj(customer.customerVatData) ?? {};
  const summary = obj(invoice.invoiceSummary) ?? {};
  const normal = obj(summary.summaryNormal) ?? {};
  return {
    invoiceNumber: str(data.invoiceNumber),
    issueDate: str(data.invoiceIssueDate),
    supplierTaxpayerId: str(obj(obj(head.supplierInfo)?.supplierTaxNumber)?.taxpayerId),
    customerVatStatus: str(customer.customerVatStatus),
    customerTaxpayerId: str(obj(vatData.customerTaxNumber)?.taxpayerId),
    customerCommunityVatNumber: str(vatData.communityVatNumber),
    customerThirdStateTaxId: str(vatData.thirdStateTaxId),
    customerName: str(customer.customerName),
    currency: str(obj(head.invoiceDetail)?.currencyCode),
    netAmountHuf: str(normal.invoiceNetAmountHUF),
    vatAmountHuf: str(normal.invoiceVatAmountHUF),
    grossAmountHuf: str(obj(summary.summaryGrossData)?.invoiceGrossAmountHUF),
    lines: asArray(obj(invoice.invoiceLines)?.line).map((l) => invoiceLineKeys(obj(l) ?? {})),
  };
}

/** VatRateType choices (data namespace) and where their value is. */
const VAT_RATE_CHOICES: ReadonlyArray<[string, (v: unknown) => string | null]> = [
  ['vatPercentage', (v) => str(v)],
  ['vatContent', (v) => str(v)],
  ['vatExemption', (v) => str(obj(v)?.case)],
  ['vatOutOfScope', (v) => str(obj(v)?.case)],
  ['vatDomesticReverseCharge', () => null],
  ['marginSchemeIndicator', (v) => str(v)],
  ['vatAmountMismatch', (v) => [str(obj(v)?.vatRate), str(obj(v)?.case)].filter(Boolean).join(' ') || null],
  ['noVatCharge', () => null],
];

/** One line of an InvoiceData (LineType): description, quantity, unit, net amount and VAT rate. */
function invoiceLineKeys(line: Obj): NavInvoiceLineKeys {
  const unit = str(line.unitOfMeasure);
  const normal = obj(line.lineAmountsNormal);
  const amounts = normal ?? obj(line.lineAmountsSimplified) ?? {};
  const rate = obj(amounts.lineVatRate) ?? {};
  const choice = VAT_RATE_CHOICES.find(([name]) => rate[name] !== undefined);
  return {
    description: str(line.lineDescription),
    quantity: str(line.quantity),
    unit: unit === 'OWN' ? `OWN:${str(line.unitOfMeasureOwn) ?? ''}` : unit,
    netAmount: normal ? str(obj(normal.lineNetAmountData)?.lineNetAmount) : null,
    vatKind: choice?.[0] ?? null,
    vatValue: choice ? choice[1](rate[choice[0]]) : null,
  };
}

function houseNumber(n: string | null): string | null {
  if (!n) return null;
  return /\d$/.test(n) ? `${n}.` : n;
}

/** DetailedAddressType (taxpayer query) → one-line domain Address ("Fő utca 1. A ép. 2/3."). */
function addressFromDetailed(a: Obj): Address {
  const main = [str(a.streetName), str(a.publicPlaceCategory), houseNumber(str(a.number))].filter(Boolean).join(' ');
  const extras: string[] = [];
  const building = str(a.building);
  const staircase = str(a.staircase);
  const floor = str(a.floor);
  const door = str(a.door);
  const lot = str(a.lotNumber);
  if (building) extras.push(`${building} ép.`);
  if (staircase) extras.push(`${staircase} lph.`);
  if (floor && door) extras.push(`${floor}/${door}.`);
  else if (floor) extras.push(`${floor}. em.`);
  else if (door) extras.push(`${door}. ajtó`);
  let line = [main, ...extras].filter(Boolean).join(' ');
  if (lot) line = line ? `${line} (hrsz. ${lot})` : `hrsz. ${lot}`;
  const address: Address = {
    countryCode: str(a.countryCode) ?? 'HU',
    postalCode: str(a.postalCode) ?? '',
    city: str(a.city) ?? '',
    addressLine: line,
  };
  const region = str(a.region);
  if (region) address.region = region;
  return address;
}

/** QueryTaxpayerResponse → TaxpayerInfo, or null when NAV returned no taxpayerData (unknown tax number). */
export function parseQueryTaxpayerResponse(input: string | NavResponseDoc): TaxpayerInfo | null {
  const root = expectRoot(toDoc(input), 'QueryTaxpayerResponse');
  const data = obj(root.taxpayerData);
  if (!data) return null;
  const tax = obj(data.taxNumberDetail) ?? {};
  const taxpayerId = required(tax, 'taxpayerId', 'taxNumberDetail');
  const vatCode = str(tax.vatCode);
  const countyCode = str(tax.countyCode);
  const addressList = obj(data.taxpayerAddressList);
  const addresses = asArray(addressList?.taxpayerAddressItem).map((item) => {
    const i = obj(item) ?? {};
    return { type: str(i.taxpayerAddressType) ?? 'HQ', address: addressFromDetailed(obj(i.taxpayerAddress) ?? {}) };
  });
  return {
    valid: str(root.taxpayerValidity) === 'true',
    name: required(data, 'taxpayerName', 'taxpayerData'),
    shortName: str(data.taxpayerShortName),
    taxpayerId,
    vatCode,
    countyCode,
    formattedTaxNumber: vatCode && countyCode ? `${taxpayerId}-${vatCode}-${countyCode}` : taxpayerId,
    incorporation: str(data.incorporation),
    vatGroupMembership: str(data.vatGroupMembership),
    addresses,
    infoDate: str(root.infoDate),
  };
}

// ---------------------------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces every occurrence of the given secrets (case-insensitively, ≥ 4 chars) with "***". */
export function redactSecrets(textValue: string, secrets: readonly string[]): string {
  let out = textValue;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(s), 'gi'), '***');
  }
  return out;
}

/**
 * Makes a NAV XML safe to store or show: drops echoed invoice payloads and exchange tokens
 * (originalRequest, exchangeToken, encodedExchangeToken), masks passwordHash/requestSignature
 * values and redacts any other known secret.
 */
export function sanitizeNavXml(xml: string, secrets: readonly string[]): string {
  const out = xml
    .replace(/<((?:[A-Za-z_][\w.-]*:)?(?:originalRequest|exchangeToken|encodedExchangeToken))\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g, '')
    .replace(/<((?:[A-Za-z_][\w.-]*:)?(?:passwordHash|requestSignature))\b([^>]*)>[^<]*<\/\1\s*>/g, '<$1$2>***</$1>');
  return redactSecrets(out, secrets);
}
