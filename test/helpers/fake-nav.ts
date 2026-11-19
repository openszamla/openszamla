/**
 * Fake NAV Online Számla v3.0 server for tests (node:http on 127.0.0.1, random port).
 *
 * It behaves like invoiceService/v3 for the operations OpenSzámla uses:
 * - tokenExchange: issues a random token, AES-128-ECB encrypted with the exchange key (5 min, single use).
 * - manageInvoice: checks login/passwordHash/taxNumber, requestId uniqueness, the ±1 day timestamp
 *   window, the requestSignature (incl. the per-invoice SHA3-512 hashes), the exchange token and the
 *   index sequence; decodes every invoiceData and validates it against invoiceData.xsd
 *   (→ technicalValidationMessages SCHEMA_VIOLATION) plus the blocking business rules of the real
 *   system that an invoicing program can trip (→ businessValidationMessages, spec 3.3.2), e.g.
 *   INVALID_LINE_OPERATION, CUSTOMER_DATA_NOT_EXPECTED, INVALID_INVOICE_REFERENCE,
 *   INVOICE_LINE_ALREADY_EXISTS, MODIFICATION_INDEX_NOT_UNIQUE, MANDATORY_LINE_CONTENT_MISSING,
 *   INVALID_VAT_DATA. Injected messages (addBusinessMessage) simulate anything else.
 * Authentication is checked with the fake's OWN implementation of spec chapter 1.5 (node:crypto),
 * never with src/nav/crypto.ts – a wrong client algorithm cannot pass.
 * - queryTransactionStatus: RECEIVED for the first `receivedPolls` polls, then DONE / ABORTED;
 *   returnOriginalRequest=true adds the invoiceData of every index (as sent: compressed when it was).
 * - queryTransactionList: the transactions received in the insDate interval (paged, newest first), with the
 *   technical user who sent them (insCusUser); addTransactions adds other users' (e.g. a webshop's).
 * - queryInvoiceCheck: true when the (OUTBOUND) invoice number was accepted (DONE) exactly once.
 * - queryInvoiceData: the invoiceData (as sent) and audit data of an (OUTBOUND) invoice number accepted exactly
 *   once; no result when there is none, HTTP 500 MULTIPLE_QUERY_RESULT_FOUND when there are several. The audit
 *   source is MGM, or the channel addInvoice gave (e.g. WEB: entered on the NAV web interface, no transaction id).
 * - queryTaxpayer: canned taxpayers (FAKE_NAV_TAXPAYERS); unknown numbers → taxpayerValidity=false.
 * compressedContent=true invoiceData is gunzipped before validation (spec 1.6.5); a body over 10 MiB gets
 * HTTP 413. Every request is validated against invoiceApi.xsd (INVALID_REQUEST + SCHEMA_VIOLATION like NAV),
 * every XML answer is schema-valid. Fault switches (failNext) simulate INVALID_REQUEST_SIGNATURE,
 * plain HTTP 500, maintenance (HTTP 503), rate limiting (HTTP 429 + Retry-After), timeouts (no
 * answer), a request processed but its answer lost (connection dropped), garbled (HTTP 200 with a
 * non-XML body), late (a slow NAV) or never sent (a NAV that hangs), or any GeneralErrorResponse.
 * HTTP statuses follow NAV application version 3.49 (e.g. INVALID_USER_RELATION → 400).
 *
 *   const nav = await startFakeNav();
 *   const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
 *   …
 *   await stopFakeNav(nav);
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { NAV_NAMESPACES, type NavApiOperation, type NavCredentials, type NavSoftware } from '../../src/nav/types.ts';
import { el, leaf, normalizeXmlText, opt, serializeXml, type XmlChild, type XmlElement } from '../../src/nav/xml.ts';
import type { NavRuntimeConfig } from '../../src/service/config.ts';
import { validateNavXml } from './nav-xsd.ts';

// ---------------------------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------------------------

/** Technical user of the fake server. taxNumber matches SELLER_NORMAL (12345676-2-42) of test/fixtures. */
export const FAKE_NAV_CREDENTIALS: Readonly<NavCredentials> = Object.freeze({
  login: 'fakeuser2026',
  password: 'Fake-Jelszo#2026!',
  signingKey: 'fa-ke12-3456789abcdef01FAKESIGNKEY',
  exchangeKey: 'FAKEEXCHANGEK3Y1',
  taxNumber: '12345676',
});

export const FAKE_NAV_SOFTWARE: Readonly<NavSoftware> = Object.freeze({
  softwareId: 'HU12345676-TESZT01',
  softwareName: 'OpenSzámla teszt',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: '0.1.0',
  softwareDevName: 'OpenSzámla közreműködők',
  softwareDevContact: 'teszt@example.com',
  softwareDevCountryCode: 'HU',
});

export interface FakeTaxpayerAddress {
  type: 'HQ' | 'SITE' | 'BRANCH';
  countryCode: string;
  region?: string;
  postalCode: string;
  city: string;
  streetName: string;
  publicPlaceCategory: string;
  number?: string;
  building?: string;
  staircase?: string;
  floor?: string;
  door?: string;
  lotNumber?: string;
}

export interface FakeTaxpayer {
  name: string;
  shortName?: string;
  /** Full tax number "12345678-1-23" (or just the 8-digit törzsszám). */
  taxNumber: string;
  incorporation: 'ORGANIZATION' | 'SELF_EMPLOYED' | 'TAXABLE_PERSON';
  vatGroupMembership?: string;
  /** taxpayerValidity (default true). false = the number exists but is not valid (e.g. revoked). */
  valid?: boolean;
  infoDate?: string;
  addresses: FakeTaxpayerAddress[];
}

/** Canned queryTaxpayer data, keyed by törzsszám. Any other number is "not found". */
export const FAKE_NAV_TAXPAYERS: Readonly<Record<string, FakeTaxpayer>> = Object.freeze({
  '12345676': {
    name: 'Példa Szoftver Korlátolt Felelősségű Társaság',
    shortName: 'Példa Szoftver Kft.',
    taxNumber: '12345676-2-42',
    incorporation: 'ORGANIZATION',
    infoDate: '2024-03-01T00:00:00.000Z',
    addresses: [{ type: 'HQ', countryCode: 'HU', postalCode: '1117', city: 'BUDAPEST', streetName: 'Irinyi József', publicPlaceCategory: 'utca', number: '4-20' }],
  },
  '87654323': {
    name: 'Árvíztűrő Tükörfúrógép Zártkörűen Működő Részvénytársaság',
    taxNumber: '87654323-2-13',
    incorporation: 'ORGANIZATION',
    infoDate: '2025-01-15T00:00:00.000Z',
    addresses: [
      { type: 'HQ', countryCode: 'HU', postalCode: '1117', city: 'BUDAPEST', streetName: 'Október huszonharmadika', publicPlaceCategory: 'utca', number: '18', floor: '2', door: '5' },
      { type: 'SITE', countryCode: 'HU', postalCode: '2040', city: 'BUDAÖRS', streetName: 'Gyár', publicPlaceCategory: 'utca', number: '2', building: 'B' },
    ],
  },
  '11223346': {
    name: 'Kovács Anna egyéni vállalkozó',
    taxNumber: '11223346-1-06',
    incorporation: 'SELF_EMPLOYED',
    addresses: [{ type: 'HQ', countryCode: 'HU', postalCode: '6720', city: 'SZEGED', streetName: 'Kárász', publicPlaceCategory: 'utca', number: '5' }],
  },
  '24681353': {
    name: 'Megszűnt Példa Betéti Társaság',
    taxNumber: '24681353-2-41',
    incorporation: 'ORGANIZATION',
    valid: false,
    addresses: [{ type: 'HQ', countryCode: 'HU', postalCode: '1051', city: 'BUDAPEST', streetName: 'Nádor', publicPlaceCategory: 'utca', number: '1' }],
  },
});

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type FakeNavOperation = NavApiOperation;

export type FakeNavFault =
  /** GeneralErrorResponse 400 INVALID_REQUEST_SIGNATURE even for a correct signature. */
  | { kind: 'INVALID_REQUEST_SIGNATURE' }
  /** Plain HTTP 500 without XML (what NAV's front end returns for unexpected failures). */
  | { kind: 'HTTP_500' }
  /** GeneralErrorResponse MAINTENANCE_MODE with HTTP 503 (and a Retry-After header when retryAfterSeconds is given). */
  | { kind: 'MAINTENANCE'; retryAfterSeconds?: number }
  /** GeneralErrorResponse TOO_MANY_REQUESTS with HTTP 429 and a Retry-After header (NAV 3.49+). */
  | { kind: 'RATE_LIMIT'; retryAfterSeconds?: number }
  /** Never answers – the client has to time out. The connection is dropped on stop(). */
  | { kind: 'TIMEOUT' }
  /** Processes the request like a successful call, then drops the connection without answering (lost answer). */
  | { kind: 'LOST_RESPONSE' }
  /** Processes the request like a successful call, then answers HTTP 200 with a non-XML body (e.g. a proxy page). */
  | { kind: 'GARBLED_RESPONSE' }
  /** Processes the request like a successful call, but answers only after `ms` (a slow NAV); no answer once the client gave up. */
  | { kind: 'DELAY'; ms: number }
  /** Processes the request like a successful call, then never answers (a NAV that hangs after receiving it). The connection is dropped on stop(). */
  | { kind: 'HANG' }
  /** Any GeneralErrorResponse. `message` may be computed when the answer is produced. */
  | { kind: 'GENERAL_ERROR'; errorCode: string; httpStatus?: number; message?: string | ((nav: FakeNavServer) => string) };

export interface FakeNavMessage {
  result: 'ERROR' | 'WARN' | 'INFO';
  code: string;
  message: string;
  tag?: string;
  value?: string;
  line?: number;
}

export interface FakeNavRequestLog {
  operation: string;
  requestId: string | null;
  /** HTTP status of the answer (0 while pending / for timeouts). */
  status: number;
  /** errorCode of a GeneralErrorResponse, if any. */
  errorCode: string | null;
  requestXml: string;
  responseXml: string | null;
}

export interface FakeNavInvoiceRecord {
  transactionId: string;
  index: number;
  operation: string;
  invoiceNumber: string | null;
  /** The invoiceData as sent (base64 of gzip when compressed). */
  invoiceDataBase64: string;
  /** Sent with compressedContent=true. */
  compressed: boolean;
  /** Decoded (decompressed) invoiceData XML. */
  xml: string;
  invoiceStatus: 'DONE' | 'ABORTED';
  technical: FakeNavMessage[];
  business: FakeNavMessage[];
}

export interface FakeNavOptions {
  credentials?: NavCredentials;
  taxpayers?: Record<string, FakeTaxpayer>;
  /** queryTransactionStatus answers RECEIVED this many times before the final status (default 1). */
  receivedPolls?: number;
  /** Validate every request against invoiceApi.xsd (default true). */
  validateRequests?: boolean;
  /** MODIFY/STORNO must reference an invoice the fake already accepted (default true, like NAV). */
  checkInvoiceReferences?: boolean;
  /** Exchange token validity (default 5 minutes). */
  tokenTtlMs?: number;
  /** Transactions per page of queryTransactionList (default 100, like NAV's maximum). */
  transactionListPageSize?: number;
  /**
   * NAV's clock (default: the real one): when it receives transactions (insDate), the ±1 day check of request
   * timestamps, exchange tokens and the HTTP Date header of every answer. A test that moves the program's clock
   * moves this one too, so the two stay as far apart as a PC clock and NAV's.
   */
  now?: () => Date;
  /** Send the HTTP Date header (default true); false: as behind a proxy that drops it. */
  dateHeader?: boolean;
}

interface PendingFault {
  fault: FakeNavFault;
  operation: FakeNavOperation | null;
  remaining: number;
}

/** Where an invoice came to NAV from (SourceType): MGM – the machine interface; WEB, XML, OSZ, OPG – other channels. */
export type FakeNavSource = 'MGM' | 'WEB' | 'XML' | 'OSZ' | 'OPG';

interface FakeTransaction {
  id: string;
  taxNumber: string;
  /** The technical user who sent it (insCusUser). */
  user: string;
  /** The channel (source): MGM for manageInvoice and addTransactions. */
  source: FakeNavSource;
  /** When the request was received (UTC timestamp). */
  insDate: string;
  polls: number;
  items: FakeNavInvoiceRecord[];
}

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------------------------

const requestParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
});

const dataParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true, ignoreDeclaration: true });

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const o = obj(v);
  return o && '#text' in o ? str(o['#text']) : null;
}

function attr(v: unknown, name: string): string | null {
  const o = obj(v);
  return o ? str(o[`@_${name}`]) : null;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

const ENTITY_ID = /^[+a-zA-Z0-9_]{1,30}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ROOTS: Record<FakeNavOperation, string> = {
  tokenExchange: 'TokenExchangeRequest',
  manageInvoice: 'ManageInvoiceRequest',
  queryTransactionStatus: 'QueryTransactionStatusRequest',
  queryTransactionList: 'QueryTransactionListRequest',
  queryInvoiceCheck: 'QueryInvoiceCheckRequest',
  queryInvoiceData: 'QueryInvoiceDataRequest',
  queryTaxpayer: 'QueryTaxpayerRequest',
};

function randomAlnum(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
}

/** The request body, or null when it is over `limit` bytes (the rest is read and dropped, then HTTP 413 follows). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) chunks.length = 0;
      else chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------
// NAV's side of the cryptography – deliberately NOT imported from src/nav/crypto.ts, so that the
// fake is an independent oracle of the specification (chapter 1.5, 1.3.2, 1.8.10).
// ---------------------------------------------------------------------------------------------

function upperHash(algorithm: 'sha512' | 'sha3-512', text: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex').toUpperCase();
}

/** Spec 1.5.1: the header timestamp VALUE masked to YYYYMMDDhhmmss (separators, fraction and zone dropped). */
export function navTimestampMask(timestamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(timestamp);
  if (!m) throw new Error(`Not a NAV GenericTimestampType value: ${timestamp}`);
  return m.slice(1, 7).join('');
}

/**
 * requestSignature as the NAV server computes it: SHA3-512 (uppercase hex) of requestId + masked
 * timestamp + signing key, followed – for manageInvoice/manageAnnulment – by the uppercase
 * SHA3-512 of (operation literal + base64 content) of every item, in index order (spec 1.5.1/1.5.2).
 */
export function navExpectedSignature(
  requestId: string,
  timestamp: string,
  signingKey: string,
  itemsInIndexOrder: ReadonlyArray<{ operation: string; data: string }> = [],
): string {
  const partial = requestId + navTimestampMask(timestamp) + signingKey;
  return upperHash('sha3-512', partial + itemsInIndexOrder.map((i) => upperHash('sha3-512', i.operation + i.data)).join(''));
}

/** Spec 1.3.2: passwordHash = SHA-512 of the password, in capital letters. */
function navPasswordHash(password: string): string {
  return upperHash('sha512', password);
}

/** Spec 1.8.10.2: the token encoded with AES-128-ECB (PKCS#5 padding) using the technical user's exchange key. */
function navEncodeToken(token: string, exchangeKey: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
  return Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]).toString('base64');
}

function splitTaxNumber(s: string): { taxpayerId: string; vatCode: string | null; countyCode: string | null } {
  const m = /^(\d{8})(?:-(\d)-(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Invalid fake taxpayer tax number: ${s}`);
  return { taxpayerId: m[1] as string, vatCode: m[2] ?? null, countyCode: m[3] ?? null };
}

/** Thrown inside the request pipeline to answer with a GeneralErrorResponse. */
class Reject extends Error {
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly technical: Array<{ code: string; message: string }>;
  readonly headers: Record<string, string>;
  constructor(httpStatus: number, errorCode: string, message: string, technical: Array<{ code: string; message: string }> = [], headers: Record<string, string> = {}) {
    super(message);
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.technical = technical;
    this.headers = headers;
  }
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

export class FakeNavServer {
  /** Base URL to pass as NavClient baseUrl, e.g. http://127.0.0.1:53211/invoiceService/v3 */
  readonly url: string;
  readonly credentials: NavCredentials;
  readonly software: NavSoftware = { ...FAKE_NAV_SOFTWARE };
  /** Every request received, in order (incl. faults). */
  readonly requests: FakeNavRequestLog[] = [];
  /** Every invoice received through manageInvoice, in order. */
  readonly invoices: FakeNavInvoiceRecord[] = [];
  /** The plain value of the most recently issued exchange token (for redaction tests). */
  lastIssuedToken: string | null = null;

  private readonly server: Server;
  private readonly taxpayers: Record<string, FakeTaxpayer>;
  private readonly validateRequests: boolean;
  private readonly checkInvoiceReferences: boolean;
  private readonly tokenTtlMs: number;
  private readonly listPageSize: number;
  private now: () => Date;
  private readonly startNow: () => Date;
  private readonly dateHeader: boolean;
  private receivedPolls: number;
  private faults: PendingFault[] = [];
  private injected = new Map<string, FakeNavMessage[]>();
  private tokens = new Map<string, { expiresAt: number; used: boolean }>();
  private usedRequestIds = new Set<string>();
  private transactions = new Map<string, FakeTransaction>();
  /** Accepted invoice chains by original invoice number: line numbers and modificationIndex values in use. */
  private chains = new Map<string, { lines: Set<number>; modificationIndexes: Set<number> }>();

  private constructor(server: Server, url: string, opts: FakeNavOptions) {
    this.server = server;
    this.url = url;
    this.credentials = { ...(opts.credentials ?? FAKE_NAV_CREDENTIALS) };
    this.taxpayers = { ...(opts.taxpayers ?? FAKE_NAV_TAXPAYERS) };
    this.validateRequests = opts.validateRequests ?? true;
    this.checkInvoiceReferences = opts.checkInvoiceReferences ?? true;
    this.tokenTtlMs = opts.tokenTtlMs ?? 5 * 60_000;
    this.listPageSize = Math.max(1, Math.floor(opts.transactionListPageSize ?? 100));
    this.receivedPolls = opts.receivedPolls ?? 1;
    this.now = opts.now ?? (() => new Date());
    this.startNow = this.now;
    this.dateHeader = opts.dateHeader !== false;
  }

  static async start(opts: FakeNavOptions = {}): Promise<FakeNavServer> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const nav = new FakeNavServer(server, `http://127.0.0.1:${port}/invoiceService/v3`, opts);
    server.on('request', (req, res) => {
      void nav.handle(req, res);
    });
    return nav;
  }

  /** NavRuntimeConfig for the service layer (AppConfig.nav) pointing to this fake server. */
  runtimeConfig(): NavRuntimeConfig {
    const { taxNumber: _taxNumber, ...credentials } = this.credentials;
    void _taxNumber;
    return { environment: 'test', credentials, source: 'env', baseUrl: this.url };
  }

  /** Answers the next `times` (default 1) requests – of `operation`, or of any operation – with a fault. */
  failNext(fault: FakeNavFault, opts: { operation?: FakeNavOperation; times?: number } = {}): this {
    this.faults.push({ fault, operation: opts.operation ?? null, remaining: opts.times ?? 1 });
    return this;
  }

  /** Drops the fault switches not used up yet (failNext) – "NAV works again"; everything else is kept. */
  clearFaults(): this {
    this.faults = [];
    return this;
  }

  /** Adds a business validation message to every future report of `invoiceNumber` (ERROR → ABORTED). */
  addBusinessMessage(invoiceNumber: string, msg: FakeNavMessage): this {
    const list = this.injected.get(invoiceNumber) ?? [];
    list.push(msg);
    this.injected.set(invoiceNumber, list);
    return this;
  }

  /** Drops the injected business messages of `invoiceNumber` (of every invoice without it) – "the cause was fixed". */
  clearBusinessMessages(invoiceNumber?: string): this {
    if (invoiceNumber === undefined) this.injected.clear();
    else this.injected.delete(invoiceNumber);
    return this;
  }

  /**
   * Records `count` transactions of the taxpayer received now, sent by `user` (default: another technical user,
   * e.g. a webshop's), each with one accepted invoice `${prefix}1`, `${prefix}2` … They are listed by
   * queryTransactionList and answer queryTransactionStatus, but are not among `invoices`. Returns their ids.
   */
  addTransactions(count: number, opts: { user?: string; prefix?: string } = {}): string[] {
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const id = randomAlnum(16);
      const number = `${opts.prefix ?? 'WEB-'}${i}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<InvoiceData xmlns="${NAV_NAMESPACES.data}"><invoiceNumber>${number}</invoiceNumber></InvoiceData>`;
      const item: FakeNavInvoiceRecord = { transactionId: id, index: 1, operation: 'CREATE', invoiceNumber: number, invoiceDataBase64: Buffer.from(xml).toString('base64'), compressed: false, xml, invoiceStatus: 'DONE', technical: [], business: [] };
      this.transactions.set(id, { id, taxNumber: this.credentials.taxNumber, user: opts.user ?? 'webshopuser1', source: 'MGM', insDate: this.now().toISOString(), polls: 0, items: [item] });
      ids.push(id);
    }
    return ids;
  }

  /**
   * Records the InvoiceData `xml` (CREATE) as if it reached NAV through another channel than a program's
   * manageInvoice (`source`, default WEB – entered on the NAV web interface – by `user`, a primary user): it gets
   * NAV's checks and, accepted, takes the number (queryInvoiceCheck, queryInvoiceData with that source and no
   * transaction id, INVOICE_NUMBER_NOT_UNIQUE for a later report). Returns the record.
   */
  async addInvoice(xml: string, opts: { source?: FakeNavSource; user?: string } = {}): Promise<FakeNavInvoiceRecord> {
    const id = randomAlnum(16);
    const record = await this.processInvoice(id, 1, 'CREATE', Buffer.from(xml, 'utf8').toString('base64'), false);
    this.transactions.set(id, { id, taxNumber: this.credentials.taxNumber, user: opts.user ?? 'elsodleges01', source: opts.source ?? 'WEB', insDate: this.now().toISOString(), polls: 0, items: [record] });
    return record;
  }

  /** How many queryTransactionStatus polls answer RECEIVED before the final status. */
  setReceivedPolls(n: number): this {
    this.receivedPolls = Math.max(0, Math.floor(n));
    return this;
  }

  /** Forgets everything (logs, invoices, tokens, transactions, faults, injected messages). */
  /**
   * NAV's clock from now on (FakeNavOptions.now), until reset(): a test that lets time pass by moving the program's
   * clock moves NAV's with it – time passes for both.
   */
  setNow(now: () => Date): this {
    this.now = now;
    return this;
  }

  reset(): void {
    this.now = this.startNow;
    this.requests.length = 0;
    this.invoices.length = 0;
    this.lastIssuedToken = null;
    this.faults = [];
    this.injected.clear();
    this.tokens.clear();
    this.usedRequestIds.clear();
    this.transactions.clear();
    this.chains.clear();
  }

  /** Stops the server and drops open connections (including requests held by a TIMEOUT fault). */
  async stop(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  // -------------------------------------------------------------------------------------------

  private takeFault(operation: string): FakeNavFault | null {
    const i = this.faults.findIndex((f) => f.operation === null || f.operation === operation);
    if (i < 0) return null;
    const pending = this.faults[i] as PendingFault;
    pending.remaining -= 1;
    if (pending.remaining <= 0) this.faults.splice(i, 1);
    return pending.fault;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/invoiceService\/v3\/([A-Za-z]+)$/.exec(url.pathname);
    const operation = m?.[1] ?? '';
    if (!m || !(operation in ROOTS)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('NOT_FOUND');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' }).end('METHOD_NOT_ALLOWED');
      return;
    }
    let body: string | null;
    try {
      body = await readBody(req, 10 * 1024 * 1024);
    } catch {
      return; // the client went away
    }
    if (body === null) {
      this.requests.push({ operation, requestId: null, status: 413, errorCode: null, requestXml: '', responseXml: null });
      res.writeHead(413, { 'Content-Type': 'text/plain' }).end('PAYLOAD_TOO_LARGE');
      return;
    }
    const log: FakeNavRequestLog = { operation, requestId: null, status: 0, errorCode: null, requestXml: body, responseXml: null };
    this.requests.push(log);

    const fault = this.takeFault(operation);
    if (fault?.kind === 'TIMEOUT') return; // keep the request open until the client gives up
    if (fault?.kind === 'HTTP_500') {
      log.status = 500;
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Undertow message, Generic exception occurred!');
      return;
    }

    let root: Obj = {};
    try {
      try {
        const parsed = obj(requestParser.parse(body, true));
        root = obj(parsed?.[ROOTS[operation as FakeNavOperation]]) ?? {};
        if (!parsed) throw new Error('empty');
      } catch {
        this.sendException(res, log, 'INVALID_REQUEST', 'Érvénytelen kérés!', 'Request body is not well-formed XML.');
        return;
      }
      log.requestId = str(obj(root.header)?.requestId);

      const afterProcessing =
        fault?.kind === 'LOST_RESPONSE' || fault?.kind === 'GARBLED_RESPONSE' || fault?.kind === 'DELAY' || fault?.kind === 'HANG' ? fault : null;
      if (fault && fault.kind !== 'LOST_RESPONSE' && fault.kind !== 'GARBLED_RESPONSE' && fault.kind !== 'DELAY' && fault.kind !== 'HANG') {
        // A signature failure uses up the requestId like a successful call (spec 1.3.1).
        if (fault.kind === 'INVALID_REQUEST_SIGNATURE' && log.requestId) this.usedRequestIds.add(log.requestId);
        throw this.faultToReject(fault);
      }

      if (this.validateRequests) {
        const r = await validateNavXml(body, 'api');
        if (!r.valid) throw new Reject(400, 'INVALID_REQUEST', 'A kérés nem felel meg az invoiceApi sémának.', r.errors.map((e) => ({ code: 'SCHEMA_VIOLATION', message: normalizeXmlText(e, 1000) ?? 'Séma hiba' })));
      }
      if (Object.keys(root).length === 0) throw new Reject(500, 'OPERATION_FAILED', 'Váratlan kérés ezen a végponton.');

      const xml = await this.process(operation as FakeNavOperation, root);
      if (afterProcessing?.kind === 'LOST_RESPONSE') {
        // Processed (a manageInvoice is received and gets its transaction), but the answer never arrives.
        log.responseXml = xml;
        res.destroy();
        return;
      }
      if (afterProcessing?.kind === 'HANG') {
        // Processed, but the answer never comes: the request stays open until the client gives up (or stop()).
        log.responseXml = xml;
        return;
      }
      if (afterProcessing?.kind === 'DELAY') {
        await new Promise((resolve) => setTimeout(resolve, afterProcessing.ms));
        this.send(res, log, 200, xml); // nothing when the client went away meanwhile
        return;
      }
      if (afterProcessing?.kind === 'GARBLED_RESPONSE') {
        log.status = 200;
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Gateway page</body></html>');
        return;
      }
      this.send(res, log, 200, xml);
    } catch (e) {
      if (e instanceof Reject) {
        log.errorCode = e.errorCode;
        this.send(res, log, e.httpStatus, this.generalErrorXml(root, e), e.headers);
        return;
      }
      log.status = 500;
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Fake NAV internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private faultToReject(fault: Exclude<FakeNavFault, { kind: 'TIMEOUT' | 'HTTP_500' | 'LOST_RESPONSE' | 'GARBLED_RESPONSE' | 'DELAY' | 'HANG' }>): Reject {
    switch (fault.kind) {
      case 'INVALID_REQUEST_SIGNATURE':
        return new Reject(400, 'INVALID_REQUEST_SIGNATURE', 'Helytelen kérés aláírás!');
      case 'MAINTENANCE':
        return new Reject(503, 'MAINTENANCE_MODE', 'A rendszer karbantartás alatt áll.', [], fault.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(fault.retryAfterSeconds) });
      case 'RATE_LIMIT':
        return new Reject(429, 'TOO_MANY_REQUESTS', 'Túl sok kérés.', [], { 'Retry-After': String(fault.retryAfterSeconds ?? 2) });
      case 'GENERAL_ERROR': {
        const message = typeof fault.message === 'function' ? fault.message(this) : (fault.message ?? `Hiba: ${fault.errorCode}`);
        return new Reject(fault.httpStatus ?? 400, fault.errorCode, message);
      }
    }
  }

  /** Authentication + operation; returns the success response XML or throws Reject. */
  private async process(operation: FakeNavOperation, root: Obj): Promise<string> {
    const header = obj(root.header) ?? {};
    const user = obj(root.user) ?? {};
    const c = this.credentials;

    if (str(header.requestVersion) !== '3.0') throw new Reject(400, 'INVALID_REQUEST_VERSION', 'Érvénytelen requestVersion.');
    if (present(header.headerVersion) && str(header.headerVersion) !== '1.0') throw new Reject(400, 'INVALID_HEADER_VERSION', 'Érvénytelen headerVersion.');
    if (attr(user.passwordHash, 'cryptoType') !== 'SHA-512') throw new Reject(400, 'INVALID_PASSWORD_HASH_CRYPTO', 'A passwordHash cryptoType értéke SHA-512 kell legyen.');
    if (attr(user.requestSignature, 'cryptoType') !== 'SHA3-512') throw new Reject(400, 'INVALID_REQUEST_SIGNATURE_HASH_CRYPTO', 'A requestSignature cryptoType értéke SHA3-512 kell legyen.');
    if (str(user.login) !== c.login || str(user.passwordHash) !== navPasswordHash(c.password)) throw new Reject(401, 'INVALID_SECURITY_USER', 'Helytelen authentikációs adatok!');
    // HTTP 400 since NAV 3.49 (2026-08); it was 500 before – the client handles both.
    if (str(user.taxNumber) !== c.taxNumber) throw new Reject(400, 'INVALID_USER_RELATION', 'A technikai felhasználó nem ehhez az adószámhoz tartozik.');

    const requestId = str(header.requestId) ?? '';
    const tsText = str(header.timestamp) ?? '';
    const ts = new Date(tsText);
    if (!TIMESTAMP.test(tsText) || Number.isNaN(ts.getTime()) || Math.abs(this.now().getTime() - ts.getTime()) > 24 * 3600_000) {
      throw new Reject(400, 'INVALID_TIMESTAMP', 'A kérés időbélyege kívül esik a megengedett ±1 napos tartományon.');
    }
    if (this.usedRequestIds.has(requestId)) throw new Reject(400, 'REQUEST_ID_NOT_UNIQUE', 'A kérés azonosítója nem egyedi.');

    const ops = operation === 'manageInvoice' ? asArray(obj(root.invoiceOperations)?.invoiceOperation).map((o) => obj(o) ?? {}) : [];
    // The item hashes follow the INDEX order (spec 1.5.1), whatever order the elements came in.
    const byIndex = [...ops].sort((a, b) => Number(str(a.index)) - Number(str(b.index)));
    const items = byIndex.map((o) => ({ operation: str(o.invoiceOperation) ?? '', data: str(o.invoiceData) ?? '' }));
    if (str(user.requestSignature) !== navExpectedSignature(requestId, tsText, c.signingKey, items)) {
      // The requestId of a request rejected for its signature counts as used (spec 1.3.1).
      this.usedRequestIds.add(requestId);
      throw new Reject(400, 'INVALID_REQUEST_SIGNATURE', 'Helytelen kérés aláírás!');
    }

    const xml = await this.execute(operation, root, ops);
    // Otherwise only successfully processed (HTTP 200) requests use up their requestId (spec 1.3.1).
    this.usedRequestIds.add(requestId);
    return xml;
  }

  /** The operation itself, after successful authentication. */
  private async execute(operation: FakeNavOperation, root: Obj, ops: Obj[]): Promise<string> {
    const c = this.credentials;
    const ok = (rootName: string, body: XmlChild[]): string => this.responseXml(rootName, root, { funcCode: 'OK' }, body);
    switch (operation) {
      case 'tokenExchange': {
        const token = `${randomUUID()}${randomAlnum(12)}`;
        const from = this.now();
        const to = new Date(from.getTime() + this.tokenTtlMs);
        this.tokens.set(token, { expiresAt: to.getTime(), used: false });
        this.lastIssuedToken = token;
        return ok('TokenExchangeResponse', [
          leaf('encodedExchangeToken', navEncodeToken(token, c.exchangeKey)),
          leaf('tokenValidityFrom', from.toISOString()),
          leaf('tokenValidityTo', to.toISOString()),
        ]);
      }
      case 'manageInvoice': {
        const token = str(root.exchangeToken) ?? '';
        const t = this.tokens.get(token);
        if (!t || t.used || t.expiresAt < this.now().getTime()) throw new Reject(400, 'INVALID_EXCHANGE_TOKEN', 'Érvénytelen vagy lejárt adatszolgáltatási token.');
        ops.forEach((o, i) => {
          if (Number(str(o.index)) !== i + 1) throw new Reject(400, 'INDEX_NOT_SEQUENTIAL', 'Az indexek nem folytonosak.');
        });
        t.used = true;
        const compressed = str(obj(root.invoiceOperations)?.compressedContent) === 'true';
        const tx: FakeTransaction = { id: randomAlnum(16), taxNumber: c.taxNumber, user: c.login, source: 'MGM', insDate: this.now().toISOString(), polls: 0, items: [] };
        for (const [i, o] of ops.entries()) tx.items.push(await this.processInvoice(tx.id, i + 1, str(o.invoiceOperation) ?? '', str(o.invoiceData) ?? '', compressed));
        this.transactions.set(tx.id, tx);
        return ok('ManageInvoiceResponse', [leaf('transactionId', tx.id)]);
      }
      case 'queryTransactionStatus': {
        const tx = this.transactions.get(str(root.transactionId) ?? '');
        if (!tx || tx.taxNumber !== c.taxNumber) return ok('QueryTransactionStatusResponse', []);
        tx.polls += 1;
        const pending = tx.polls <= this.receivedPolls;
        const withOriginal = str(root.returnOriginalRequest) === 'true';
        return ok('QueryTransactionStatusResponse', [
          el('processingResults', [
            tx.items.map((it) =>
              el('processingResult', [
                leaf('index', it.index),
                leaf('invoiceStatus', pending ? 'RECEIVED' : it.invoiceStatus),
                !pending && it.technical.map((m) => technicalEl(m)),
                !pending && it.business.map((m) => businessEl(m)),
                leaf('compressedContentIndicator', it.compressed),
                withOriginal && leaf('originalRequest', it.invoiceDataBase64),
              ]),
            ),
            leaf('originalRequestVersion', '3.0'),
          ]),
        ]);
      }
      case 'queryTransactionList': {
        const page = Number(str(root.page));
        const range = obj(root.insDate) ?? {};
        const from = Date.parse(str(range.dateTimeFrom) ?? '');
        const to = Date.parse(str(range.dateTimeTo) ?? '');
        if (from > to) throw new Reject(400, 'BAD_QUERY_PARAM_OVERLAP', 'A lekérdezési időszak kezdete későbbi a végénél.');
        if (to - from > 35 * 24 * 3600_000) throw new Reject(400, 'BAD_QUERY_PARAM_RANGE_EXCEEDED', 'A lekérdezési időszak legfeljebb 35 nap lehet.');
        const all = [...this.transactions.values()]
          .filter((t) => t.taxNumber === c.taxNumber && Date.parse(t.insDate) >= from && Date.parse(t.insDate) <= to)
          .sort((a, b) => b.insDate.localeCompare(a.insDate));
        const pages = Math.ceil(all.length / this.listPageSize);
        return ok('QueryTransactionListResponse', [
          el('transactionListResult', [
            leaf('currentPage', page),
            leaf('availablePage', pages),
            all.slice((page - 1) * this.listPageSize, page * this.listPageSize).map((t) =>
              el('transaction', [
                leaf('insDate', t.insDate),
                leaf('insCusUser', t.user),
                leaf('source', t.source),
                leaf('transactionId', t.id),
                leaf('requestStatus', t.polls < this.receivedPolls ? 'RECEIVED' : 'FINISHED'),
                leaf('technicalAnnulment', false),
                leaf('originalRequestVersion', '3.0'),
                leaf('itemCount', t.items.length),
              ]),
            ),
          ]),
        ]);
      }
      case 'queryInvoiceCheck': {
        const query = obj(root.invoiceNumberQuery) ?? {};
        const number = str(query.invoiceNumber);
        // Our records are all issued by the technical user's taxpayer: only OUTBOUND queries can find them.
        const valid = str(query.invoiceDirection) === 'OUTBOUND' ? this.invoices.filter((r) => r.invoiceStatus === 'DONE' && r.invoiceNumber === number).length : 0;
        return ok('QueryInvoiceCheckResponse', [leaf('invoiceCheckResult', valid === 1)]);
      }
      case 'queryInvoiceData': {
        const query = obj(root.invoiceNumberQuery) ?? {};
        const number = str(query.invoiceNumber);
        const outbound = str(query.invoiceDirection) === 'OUTBOUND';
        if (outbound && present(query.supplierTaxNumber)) throw new Reject(400, 'BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED', 'Kiállítói lekérdezésnél nem adható meg a kiállító adószáma.');
        // Our records are all issued by the technical user's taxpayer: only OUTBOUND queries can find them.
        const valid = outbound ? this.invoices.filter((r) => r.invoiceStatus === 'DONE' && r.invoiceNumber === number) : [];
        if (valid.length > 1) throw new Reject(500, 'MULTIPLE_QUERY_RESULT_FOUND', 'A lekérdezés több érvényes számlát talált.');
        const hit = valid[0];
        const tx = hit ? this.transactions.get(hit.transactionId) : undefined;
        if (!hit || !tx) return ok('QueryInvoiceDataResponse', []);
        return ok('QueryInvoiceDataResponse', [
          el('invoiceDataResult', [
            leaf('invoiceData', hit.invoiceDataBase64),
            el('auditData', [
              leaf('insdate', tx.insDate),
              leaf('insCusUser', tx.user),
              leaf('source', tx.source),
              // Only an invoice sent through the machine interface has a transaction (AuditDataType).
              tx.source === 'MGM' && leaf('transactionId', tx.id),
              tx.source === 'MGM' && leaf('index', hit.index),
              leaf('originalRequestVersion', '3.0'),
            ]),
            leaf('compressedContentIndicator', hit.compressed),
          ]),
        ]);
      }
      case 'queryTaxpayer': {
        const id = str(root.taxNumber) ?? '';
        const tp = this.taxpayers[id];
        if (!tp) return ok('QueryTaxpayerResponse', [leaf('taxpayerValidity', false)]);
        const tax = splitTaxNumber(tp.taxNumber);
        return ok('QueryTaxpayerResponse', [
          opt('infoDate', tp.infoDate),
          leaf('taxpayerValidity', tp.valid ?? true),
          el('taxpayerData', [
            leaf('taxpayerName', tp.name),
            opt('taxpayerShortName', tp.shortName),
            el('taxNumberDetail', [leaf('base:taxpayerId', tax.taxpayerId), opt('base:vatCode', tax.vatCode), opt('base:countyCode', tax.countyCode)]),
            leaf('incorporation', tp.incorporation),
            opt('vatGroupMembership', tp.vatGroupMembership),
            tp.addresses.length > 0 &&
              el(
                'taxpayerAddressList',
                tp.addresses.map((a) =>
                  el('taxpayerAddressItem', [
                    leaf('taxpayerAddressType', a.type),
                    el('taxpayerAddress', [
                      leaf('base:countryCode', a.countryCode),
                      opt('base:region', a.region),
                      leaf('base:postalCode', a.postalCode),
                      leaf('base:city', a.city),
                      leaf('base:streetName', a.streetName),
                      leaf('base:publicPlaceCategory', a.publicPlaceCategory),
                      opt('base:number', a.number),
                      opt('base:building', a.building),
                      opt('base:staircase', a.staircase),
                      opt('base:floor', a.floor),
                      opt('base:door', a.door),
                      opt('base:lotNumber', a.lotNumber),
                    ]),
                  ]),
                ),
              ),
          ]),
        ]);
      }
    }
    throw new Reject(500, 'OPERATION_FAILED', 'Ismeretlen művelet.');
  }

  private async processInvoice(transactionId: string, index: number, operation: string, b64: string, compressed: boolean): Promise<FakeNavInvoiceRecord> {
    const record: FakeNavInvoiceRecord = {
      transactionId,
      index,
      operation,
      invoiceNumber: null,
      invoiceDataBase64: b64,
      compressed,
      xml: '',
      invoiceStatus: 'ABORTED',
      technical: [],
      business: [],
    };
    try {
      let buf = Buffer.from(b64, 'base64');
      if (compressed) buf = gunzipSync(buf);
      record.xml = buf.toString('utf8');
    } catch {
      record.technical.push({ result: 'ERROR', code: 'DECOMPRESSION_ERROR', message: 'A számla adat nem dekódolható.' });
    }
    if (!record.technical.length) {
      const xsd = await validateNavXml(record.xml, 'data');
      if (!xsd.valid) {
        for (const e of xsd.errors) record.technical.push({ result: 'ERROR', code: 'SCHEMA_VIOLATION', message: normalizeXmlText(e, 1000) ?? 'Séma hiba' });
      }
    }
    let data: Obj = {};
    if (!record.technical.length) {
      data = obj(obj(dataParser.parse(record.xml))?.InvoiceData) ?? {};
      record.business.push(...this.businessChecks(record, operation, data));
    }
    const blocking = record.technical.length > 0 || record.business.some((m) => m.result === 'ERROR');
    record.invoiceStatus = blocking ? 'ABORTED' : 'DONE';
    if (record.invoiceStatus === 'DONE') this.recordChain(operation, data);
    this.invoices.push(record);
    return record;
  }

  /** Remembers the line numbers / modification indexes an accepted invoice adds to its chain. */
  private recordChain(operation: string, data: Obj): void {
    const invoice = obj(obj(data.invoiceMain)?.invoice) ?? {};
    const lines = asArray(obj(invoice.invoiceLines)?.line).map((l) => obj(l) ?? {});
    if (operation === 'CREATE') {
      const number = str(data.invoiceNumber);
      if (number) this.chains.set(number, { lines: new Set(lines.map((l) => Number(str(l.lineNumber)))), modificationIndexes: new Set() });
      return;
    }
    const ref = obj(invoice.invoiceReference);
    const original = str(ref?.originalInvoiceNumber);
    if (!ref || !original) return;
    const chain = this.chains.get(original) ?? { lines: new Set<number>(), modificationIndexes: new Set<number>() };
    for (const l of lines) {
      const lmr = obj(l.lineModificationReference);
      if (lmr && str(lmr.lineOperation) === 'CREATE') chain.lines.add(Number(str(lmr.lineNumberReference)));
    }
    chain.modificationIndexes.add(Number(str(ref.modificationIndex)));
    this.chains.set(original, chain);
  }

  /** NAV's blocking business validations (spec 3.3.2) that an invoicing program can trip. */
  private businessChecks(record: FakeNavInvoiceRecord, operation: string, data: Obj): FakeNavMessage[] {
    const msgs: FakeNavMessage[] = [];
    const invoiceNumber = str(data.invoiceNumber);
    record.invoiceNumber = invoiceNumber;
    const invoice = obj(obj(data.invoiceMain)?.invoice) ?? {};
    const head = obj(invoice.invoiceHead) ?? {};
    const supplier = obj(head.supplierInfo) ?? {};
    const detail = obj(head.invoiceDetail) ?? {};
    const deliveryDate = str(detail.invoiceDeliveryDate) ?? '';
    const isCreate = operation === 'CREATE';
    const isStorno = operation === 'STORNO';
    const error = (code: string, message: string, extra: Partial<FakeNavMessage> = {}): void => {
      msgs.push({ result: 'ERROR', code, message, ...extra });
    };
    const accepted = (n: string | null, op?: string): boolean =>
      this.invoices.some((r) => r.invoiceStatus === 'DONE' && r.invoiceNumber === n && (op === undefined || r.operation === op));

    if (str(obj(supplier.supplierTaxNumber)?.taxpayerId) !== this.credentials.taxNumber) {
      msgs.push({ result: 'ERROR', code: 'SUPPLIER_TAX_NUMBER_MISMATCH', message: 'Az eladó adószáma nem egyezik a technikai felhasználó adószámával.' });
    }
    if (accepted(invoiceNumber)) {
      msgs.push({ result: 'ERROR', code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.', tag: 'invoiceNumber', value: invoiceNumber ?? '' });
    }

    // 77 INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF (CREATE, MODIFY): HUF ⇒ exchangeRate = 1.
    if (!isStorno && str(detail.currencyCode) === 'HUF' && Number(str(detail.exchangeRate)) !== 1) {
      error('INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF', 'HUF pénznemnél az árfolyam csak 1 lehet.', { tag: 'exchangeRate', value: str(detail.exchangeRate) ?? '' });
    }

    const ref = obj(invoice.invoiceReference);
    const original = str(ref?.originalInvoiceNumber);
    if (isCreate && ref) error('INVOICE_REFERENCE_NOT_EXPECTED', 'Alapszámlánál nem adható meg számlahivatkozás.');
    if (!isCreate && !ref) error('INVOICE_REFERENCE_EXPECTED', 'Módosító / érvénytelenítő okiratnál kötelező a számlahivatkozás.');
    if (operation === 'MODIFY' && ref && original === invoiceNumber) {
      error('INCORRECT_HEAD_DATA_MOD_REF_INVOICE_NUMBER', 'A módosító okirat sorszáma megegyezik az eredeti számláéval.', { tag: 'invoiceNumber', value: invoiceNumber ?? '' });
    }
    const chain = ref && this.checkInvoiceReferences ? this.chains.get(original ?? '') : undefined;
    if (ref && this.checkInvoiceReferences) {
      const withoutMaster = str(ref.modifyWithoutMaster) === 'true';
      const known = accepted(original, 'CREATE');
      if (!withoutMaster && !known) {
        error('INVALID_INVOICE_REFERENCE', 'A hivatkozott számla nem található.', { tag: 'originalInvoiceNumber', value: original ?? '' });
      }
      if (withoutMaster && known) error('MODIFY_WITHOUT_MASTER_MISMATCH', 'A hivatkozott számla létezik, modifyWithoutMaster nem lehet true.');
      const modificationIndex = Number(str(ref.modificationIndex));
      if (chain?.modificationIndexes.has(modificationIndex)) {
        error('MODIFICATION_INDEX_NOT_UNIQUE', 'Ezzel a módosítási sorszámmal már érkezett adatszolgáltatás.', { tag: 'modificationIndex', value: String(modificationIndex) });
      }
    }

    const customer = obj(head.customerInfo);
    const status = str(customer?.customerVatStatus);
    const lines = asArray(obj(invoice.invoiceLines)?.line).map((l) => obj(l) ?? {});
    if (lines.length === 0 && operation !== 'MODIFY') error('INVOICE_LINE_MISSING', 'A számla nem tartalmaz tételt.');
    const lineRefs = new Set<number>();
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      if (Number(str(line.lineNumber)) !== lineNo) error('LINE_NUMBER_NOT_SEQUENTIAL', 'A tételsorszámok nem folytonosak.', { line: lineNo });
      const lmr = obj(line.lineModificationReference);
      if (isCreate && lmr) error('LINE_MODIFICATION_NOT_EXPECTED', 'Alapszámla tételén nem adható meg módosítási hivatkozás.', { line: lineNo });
      if (!isCreate && !lmr) error('LINE_MODIFICATION_EXPECTED', 'Módosító okirat tételén kötelező a lineModificationReference.', { line: lineNo });
      if (lmr) {
        const refNo = Number(str(lmr.lineNumberReference));
        if (lineRefs.has(refNo)) error('LINE_NUMBER_REFERENCE_NOT_UNIQUE', 'Ugyanarra a tételsorszámra több tétel hivatkozik.', { tag: 'lineNumberReference', value: String(refNo), line: lineNo });
        lineRefs.add(refNo);
        if (str(lmr.lineOperation) === 'MODIFY') {
          error('INVALID_LINE_OPERATION', 'A lineOperation értéke csak CREATE lehet.', { tag: 'lineOperation', value: 'MODIFY', line: lineNo });
        } else if (chain?.lines.has(refNo)) {
          error('INVOICE_LINE_ALREADY_EXISTS', 'A létrehozandó tételsorszám már létezik a számlaláncban.', { tag: 'lineNumberReference', value: String(refNo), line: lineNo });
        }
      }
      // 13 MANDATORY_LINE_CONTENT_MISSING
      const expressed = str(line.lineExpressionIndicator) === 'true';
      const missing = !present(line.lineDescription) || (expressed && (!present(line.quantity) || !present(line.unitOfMeasure) || !present(line.unitPrice)));
      if (missing) error('MANDATORY_LINE_CONTENT_MISSING', 'A tétel kötelező adata (megnevezés, mennyiség, egység, egységár) hiányzik.', { line: lineNo });
      msgs.push(...vatRateChecks(obj(line.lineAmountsNormal) ?? {}, 'line', operation, deliveryDate, status, lineNo));
    });
    for (const row of asArray(obj(obj(invoice.invoiceSummary)?.summaryNormal)?.summaryByVatRate)) {
      msgs.push(...vatRateChecks(obj(row) ?? {}, 'summary', operation, deliveryDate, status, undefined));
    }

    if (isCreate && !customer) error('CUSTOMER_INFO_MISSING', 'A vevő adatai (customerInfo) kötelezők.');
    if (customer && status === 'PRIVATE_PERSON' && (present(customer.customerVatData) || present(customer.customerName) || present(customer.customerAddress))) {
      error('CUSTOMER_DATA_NOT_EXPECTED', 'Magánszemély vevő adatai nem küldhetők.');
    }
    if (customer && status !== 'PRIVATE_PERSON' && (!present(customer.customerName) || !present(customer.customerAddress))) {
      error('CUSTOMER_DATA_EXPECTED', 'A vevő neve és címe kötelező.');
    }
    if (customer && status === 'DOMESTIC' && !present(obj(customer.customerVatData)?.customerTaxNumber)) {
      error('MISSING_CUSTOMER_DOMESTIC_TAXNUMBER', 'Belföldi áfaalany vevőnél kötelező az adószám.');
    }

    if (invoiceNumber) msgs.push(...(this.injected.get(invoiceNumber) ?? []));
    return msgs;
  }

  // -------------------------------------------------------------------------------------------
  // Response XML

  /** header/software are echoed from the request when they are valid (like NAV does). */
  private responseXml(rootName: string, request: Obj, result: { funcCode: 'OK' | 'ERROR'; errorCode?: string; message?: string }, body: XmlChild[]): string {
    const header = obj(request.header) ?? {};
    const requestId = str(header.requestId);
    const timestamp = str(header.timestamp);
    return serializeXml(
      el(
        rootName,
        [
          el('common:header', [
            leaf('common:requestId', requestId && ENTITY_ID.test(requestId) ? requestId : `FAKE${randomAlnum(12)}`),
            leaf('common:timestamp', timestamp && TIMESTAMP.test(timestamp) ? timestamp : this.now().toISOString()),
            leaf('common:requestVersion', '3.0'),
            leaf('common:headerVersion', '1.0'),
          ]),
          el('common:result', [leaf('common:funcCode', result.funcCode), opt('common:errorCode', result.errorCode), opt('common:message', result.message)]),
          this.softwareEcho(obj(request.software)),
          body,
        ],
        { xmlns: NAV_NAMESPACES.api, 'xmlns:common': NAV_NAMESPACES.common, 'xmlns:base': NAV_NAMESPACES.base },
      ),
    );
  }

  private softwareEcho(sw: Obj | null): XmlElement {
    const fields = ['softwareId', 'softwareName', 'softwareOperation', 'softwareMainVersion', 'softwareDevName', 'softwareDevContact'] as const;
    const s = sw && fields.every((f) => str(sw[f])) && /^[0-9A-Z-]{18}$/.test(str(sw.softwareId) ?? '') ? sw : null;
    const v = (f: string, fallback: string | undefined): string | undefined => (s ? (str(s[f]) ?? undefined) : fallback);
    const d = FAKE_NAV_SOFTWARE;
    return el('software', [
      leaf('softwareId', v('softwareId', d.softwareId) as string),
      leaf('softwareName', v('softwareName', d.softwareName) as string),
      leaf('softwareOperation', v('softwareOperation', d.softwareOperation) as string),
      leaf('softwareMainVersion', v('softwareMainVersion', d.softwareMainVersion) as string),
      leaf('softwareDevName', v('softwareDevName', d.softwareDevName) as string),
      leaf('softwareDevContact', v('softwareDevContact', d.softwareDevContact) as string),
      opt('softwareDevCountryCode', v('softwareDevCountryCode', d.softwareDevCountryCode)),
      opt('softwareDevTaxNumber', v('softwareDevTaxNumber', d.softwareDevTaxNumber)),
    ]);
  }

  private generalErrorXml(request: Obj, e: Reject): string {
    return this.responseXml(
      'GeneralErrorResponse',
      request,
      { funcCode: 'ERROR', errorCode: e.errorCode, message: e.message },
      e.technical.map((t) =>
        el('technicalValidationMessages', [leaf('common:validationResultCode', 'ERROR'), leaf('common:validationErrorCode', t.code), opt('common:message', t.message)]),
      ),
    );
  }

  /** GeneralExceptionResponse (common namespace) as the live API sends it, with a SCHEMA_VIOLATION notification. */
  private sendException(res: ServerResponse, log: FakeNavRequestLog, errorCode: string, message: string, detail: string): void {
    log.errorCode = errorCode;
    const xml = serializeXml(
      el(
        'GeneralExceptionResponse',
        [
          leaf('funcCode', 'ERROR'),
          leaf('errorCode', errorCode),
          leaf('message', message),
          el('notifications', el('notification', [leaf('notificationCode', 'SCHEMA_VIOLATION'), leaf('notificationText', detail)])),
        ],
        { xmlns: NAV_NAMESPACES.common, 'xmlns:ns2': NAV_NAMESPACES.api },
      ),
    );
    this.send(res, log, 400, xml);
  }

  private send(res: ServerResponse, log: FakeNavRequestLog, status: number, xml: string, headers: Record<string, string> = {}): void {
    log.status = status;
    log.responseXml = xml;
    if (res.headersSent || res.destroyed) return;
    res.sendDate = false; // only the fake's own clock, or no Date header at all
    res.writeHead(status, { 'Content-Type': 'application/xml;charset=UTF-8', ...(this.dateHeader ? { Date: this.now().toUTCString() } : {}), ...headers }).end(xml);
  }
}

function technicalEl(m: FakeNavMessage): XmlElement {
  return el('technicalValidationMessages', [leaf('common:validationResultCode', 'ERROR'), leaf('common:validationErrorCode', m.code), opt('common:message', m.message)]);
}

function businessEl(m: FakeNavMessage): XmlElement {
  const pointer = m.tag !== undefined || m.value !== undefined || m.line !== undefined;
  return el('businessValidationMessages', [
    leaf('validationResultCode', m.result),
    leaf('validationErrorCode', m.code),
    opt('message', m.message),
    pointer && el('pointer', [opt('tag', m.tag), opt('value', m.value), m.line !== undefined && leaf('line', m.line)]),
  ]);
}

/** VAT rates NAV accepts on normal invoices in any case (spec 3.3.2 #14). */
const VAT_PERCENTAGES: ReadonlySet<number> = new Set([0.05, 0.07, 0.12, 0.18, 0.27]);

/**
 * Blocking validations on one VatRateType occurrence of a line (lineAmountsNormal) or of a summary
 * row (summaryByVatRate), spec 3.3.2: 14 INVALID_VAT_DATA; 67–70 and 73 VAT case vs. customer VAT
 * status (CREATE, MODIFY); 71/72 VAT on an exempt (CREATE, MODIFY) / out-of-scope (all) line;
 * 80/74 VAT in an exempt / out-of-scope summary row (CREATE, MODIFY).
 */
function vatRateChecks(
  amounts: Obj,
  where: 'line' | 'summary',
  operation: string,
  deliveryDate: string,
  customerStatus: string | null,
  line: number | undefined,
): FakeNavMessage[] {
  const out: FakeNavMessage[] = [];
  const error = (code: string, message: string): void => {
    out.push(line === undefined ? { result: 'ERROR', code, message } : { result: 'ERROR', code, message, line });
  };
  const isStorno = operation === 'STORNO';
  const rate = obj(where === 'line' ? amounts.lineVatRate : amounts.vatRate) ?? {};
  const vatData = obj(where === 'line' ? amounts.lineVatData : amounts.vatRateVatData) ?? {};
  const vatValues = where === 'line' ? [vatData.lineVatAmount, vatData.lineVatAmountHUF] : [vatData.vatRateVatAmount, vatData.vatRateVatAmountHUF];
  const hasVat = vatValues.some((v) => Number(str(v) ?? '0') !== 0);

  const pct = str(rate.vatPercentage);
  if (pct !== null) {
    const p = Number(pct);
    const allowed = VAT_PERCENTAGES.has(p) || ((p === 0.2 || p === 0.25) && (operation !== 'CREATE' || deliveryDate < '2013-01-01')) || (p === 0 && deliveryDate >= '2024-01-01');
    if (!allowed) error('INVALID_VAT_DATA', `Nem megengedett ÁFA-kulcs: ${pct}.`);
  }
  const exemption = str(obj(rate.vatExemption)?.case);
  const outOfScope = str(obj(rate.vatOutOfScope)?.case);
  if (where === 'line' && !isStorno) {
    const status = customerStatus ?? '';
    if (exemption === 'KBAET' && status !== 'OTHER') error('INCORRECT_LINE_DATA_VAT_STATUS_VAT_DATA_MISMATCH_KBAET', 'KBAET tételnél a vevő státusza csak OTHER lehet.');
    if (exemption === 'KBAUK' && status === 'DOMESTIC') error('INCORRECT_LINE_DATA_VAT_STATUS_VAT_DATA_MISMATCH_KBAUK', 'KBAUK tételnél a vevő státusza csak PRIVATE_PERSON vagy OTHER lehet.');
    if ((outOfScope === 'EUFAD37' || outOfScope === 'EUFADE') && status !== 'OTHER') {
      error(`INCORRECT_LINE_DATA_VAT_STATUS_VAT_DATA_MISMATCH_${outOfScope}`, `${outOfScope} tételnél a vevő státusza csak OTHER lehet.`);
    }
    if (str(rate.vatDomesticReverseCharge) === 'true' && status !== 'DOMESTIC') {
      error('INCORRECT_LINE_DATA_VAT_DOMESTIC_REVERSE_CHARGE', 'Belföldi fordított adózásnál a vevő csak belföldi áfaalany lehet.');
    }
  }
  if (hasVat) {
    if (where === 'line' && exemption !== null && !isStorno) error('INCORRECT_LINE_DATA_VAT_EXEMPTION_NORMAL', 'Adómentes tétel nem tartalmazhat ÁFA-összeget.');
    if (where === 'line' && outOfScope !== null) error('INCORRECT_LINE_DATA_VAT_OUT_OF_SCOPE_NORMAL', 'ÁFA hatályán kívüli tétel nem tartalmazhat ÁFA-összeget.');
    if (where === 'summary' && exemption !== null && !isStorno) error('INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL', 'Adómentes összesítő sor nem tartalmazhat ÁFA-összeget.');
    if (where === 'summary' && outOfScope !== null && !isStorno) error('INCORRECT_SUMMARY_DATA_VAT_OUT_OF_SCOPE_NORMAL', 'ÁFA hatályán kívüli összesítő sor nem tartalmazhat ÁFA-összeget.');
  }
  return out;
}

/** Starts a fake NAV server on 127.0.0.1 with a random free port. */
export async function startFakeNav(opts: FakeNavOptions = {}): Promise<FakeNavServer> {
  return FakeNavServer.start(opts);
}

export async function stopFakeNav(nav: FakeNavServer | null | undefined): Promise<void> {
  if (nav) await nav.stop();
}
