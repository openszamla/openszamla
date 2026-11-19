/**
 * HTTP client for NAV Online Számla v3.0 (invoiceService/v3).
 *
 * CONTRACT FILE – keep the signatures. Implementation notes:
 * - Uses global fetch (injectable for tests), POST application/xml, UTF-8, Accept: application/xml.
 * - Builds request XML (api namespace) with header/user/software blocks per invoiceApi.xsd and the
 *   signature rules in ./crypto.ts (see ./api-xml.ts); parses responses with fast-xml-parser
 *   (namespace prefixes ignored).
 * - Errors: throws NavError. GeneralErrorResponse / GeneralExceptionResponse / funcCode=ERROR →
 *   code from errorCode (HTTP status kept in httpStatus); network errors, timeouts, HTTP 5xx without
 *   a NAV error body and NAV maintenance/OPERATION_FAILED-like codes are retryable=true;
 *   authentication/signature/validation errors are retryable=false (see isRetryableNavError).
 *   A manageInvoice failure after the request may have reached NAV (timeout, connection lost after
 *   connecting, unreadable 2xx answer, gateway timeout) is uncertain=true: NAV may have processed it, so
 *   it must be reconciled (queryTransactionList / queryInvoiceData) before the invoice is sent again.
 *   A request larger than NAV's 10 MB limit is never sent (REQUEST_TOO_LARGE), and HTTP 413 is permanent.
 * - NEVER includes credentials, password hash, signing/exchange keys or the exchange token in
 *   error messages or the returned response XML (secrets are redacted, echoed payloads stripped).
 *   Credentials live in an ES private field, so they do not show up in JSON/inspect output either.
 */
import { AppError } from '../core/errors.ts';
import {
  assertNavCredentials,
  assertNavSoftware,
  buildManageInvoiceRequest,
  buildQueryInvoiceCheckRequest,
  buildQueryInvoiceDataRequest,
  buildQueryTaxpayerRequest,
  buildQueryTransactionListRequest,
  buildQueryTransactionStatusRequest,
  buildTokenExchangeRequest,
  navErrorInfo,
  NavResponseFormatError,
  parseManageInvoiceResponse,
  parseNavResponseXml,
  parseQueryInvoiceCheckResponse,
  parseQueryInvoiceDataResponse,
  parseQueryTaxpayerResponse,
  parseQueryTransactionListResponse,
  parseQueryTransactionStatusResponse,
  parseTokenExchangeResponse,
  redactSecrets,
  sanitizeNavXml,
  type NavRequestContext,
  type NavResponseDoc,
} from './api-xml.ts';
import { decodeExchangeToken, newRequestId, passwordHash, REQUEST_ID_RE } from './crypto.ts';
import { splitHuTaxNumber } from './invoice-data.ts';
import type { NavApiOperation, NavCredentials, NavEnvironment, NavInvoiceDataResult, NavOperation, NavProcessingResult, NavSoftware, NavTransactionInfo, TaxpayerInfo } from './types.ts';
import { NAV_BASE_URLS, NAV_MAX_REQUEST_BYTES } from './types.ts';

export interface NavClientOptions {
  environment: NavEnvironment;
  credentials: NavCredentials;
  software: NavSoftware;
  /** Override base URL (tests / fake server). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per request timeout, default 30 000 ms. */
  timeoutMs?: number;
  now?: () => Date;
}

export class NavError extends AppError {
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  /** NAV errorCode (e.g. INVALID_REQUEST_SIGNATURE) or a local code (NETWORK_ERROR, TIMEOUT). */
  readonly navErrorCode: string;
  /** Server-requested wait before retrying (HTTP 429 / 503 `Retry-After`), if any. */
  readonly retryAfterMs: number | null;
  /**
   * manageInvoice only: the request may have reached NAV and been processed, the outcome is unknown. Sending
   * the invoice again blindly would come back ABORTED with INVOICE_NUMBER_NOT_UNIQUE (spec 1.9.2).
   */
  readonly uncertain: boolean;

  constructor(
    navErrorCode: string,
    message: string,
    opts: { retryable: boolean; httpStatus?: number | null; hint?: string; cause?: unknown; retryAfterMs?: number | null; uncertain?: boolean },
  ) {
    super(`NAV_${navErrorCode}`, message, { hint: opts.hint, cause: opts.cause });
    this.name = 'NavError';
    this.navErrorCode = navErrorCode;
    this.retryable = opts.retryable;
    this.httpStatus = opts.httpStatus ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.uncertain = opts.uncertain ?? false;
  }
}

export interface ManageInvoiceItem {
  /** 1-based index inside the request. */
  index: number;
  operation: NavOperation;
  invoiceDataBase64: string;
}

// ---------------------------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------------------------

/** Transient conditions: repeating the same call later can succeed. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'OPERATION_FAILED',
  'MAINTENANCE_MODE',
  // HTTP 429 since NAV application version 3.49 (2026-08) – wait for Retry-After.
  'TOO_MANY_REQUESTS',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_SERVER_ERROR',
  // A new call uses a new requestId / a fresh token, so these resolve themselves on retry.
  'REQUEST_ID_NOT_UNIQUE',
  'INVALID_EXCHANGE_TOKEN',
  'TIMEOUT',
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
]);

/** Permanent conditions: the configuration or the request must be fixed first. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'INVALID_SECURITY_USER',
  'NOT_REGISTERED_CUSTOMER',
  'INVALID_CUSTOMER',
  'INVALID_USER_RELATION',
  'FORBIDDEN',
  'INVALID_REQUEST_SIGNATURE',
  'INDEX_NOT_SEQUENTIAL',
  'REQUEST_VERSION_NOT_ALLOWED',
  'STATUS_QUERY_NOT_ALLOWED',
  'INVALID_TIMESTAMP',
  'INVALID_PASSWORD_HASH_CRYPTO',
  'INVALID_REQUEST_SIGNATURE_HASH_CRYPTO',
  'INVALID_REQUEST_VERSION',
  'INVALID_HEADER_VERSION',
  'INVALID_PREDECESSOR_TAX_NUMBER',
  'NOT_ALLOWED_EXCEPTION',
  'TOKEN_DECODE_FAILED',
  'INVALID_ARGUMENT',
  // HTTP 500, but asking again gives the same answer until the superfluous report is annulled at NAV.
  'MULTIPLE_QUERY_RESULT_FOUND',
  'REQUEST_TOO_LARGE',
]);

/**
 * Retry policy: explicit transient codes → true, explicit permanent codes (auth, signature,
 * validation – before NAV 3.49 several of them arrived with HTTP 500, since then with 400/403)
 * → false, anything else by HTTP status (5xx, 408, 429 → true).
 */
export function isRetryableNavError(code: string, httpStatus: number | null): boolean {
  if (RETRYABLE_CODES.has(code)) return true;
  if (PERMANENT_CODES.has(code)) return false;
  return httpStatus !== null && (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429);
}

const HINTS: Record<string, string> = {
  INVALID_SECURITY_USER: 'Hibás technikai felhasználó név vagy jelszó. Ellenőrizd a NAV technikai felhasználó adatait (openszamla nav-setup).',
  NOT_REGISTERED_CUSTOMER:
    'Az adószám nincs regisztrálva az Online Számla rendszerben, vagy rossz környezetet használsz (teszt/éles). Ellenőrizd az eladó adószámát és az OPENSZAMLA_NAV_ENV beállítást.',
  INVALID_CUSTOMER: 'Az eladó adószáma nem létezik vagy nem jogosult számlaműveletre. Ellenőrizd az eladó adószámát.',
  INVALID_USER_RELATION: 'A technikai felhasználó nem ehhez az adószámhoz tartozik, vagy le van tiltva. Ellenőrizd a technikai felhasználót az onlineszamla.nav.gov.hu felületén.',
  FORBIDDEN: 'A technikai felhasználónak nincs jogosultsága ehhez a művelethez. Állítsd be a jogosultságait az onlineszamla.nav.gov.hu felületén.',
  INVALID_REQUEST_SIGNATURE: 'Hibás kérés-aláírás: ellenőrizd az XML aláírókulcsot (openszamla nav-setup) és a gép óráját.',
  INVALID_EXCHANGE_TOKEN: 'Érvénytelen vagy lejárt adatszolgáltatási token. Az újrapróbálás új tokent kér; ha a hiba ismétlődik, ellenőrizd az XML cserekulcsot.',
  TOKEN_DECODE_FAILED: 'Ellenőrizd az XML cserekulcsot (openszamla nav-setup): a technikai felhasználóhoz generált 16 karakteres cserekulcs kell.',
  INVALID_TIMESTAMP: 'A gép órája több mint 1 nappal eltér a NAV idejétől – állítsd be a pontos időt.',
  REQUEST_ID_NOT_UNIQUE: 'Ismétlődő kérésazonosító – az újrapróbálás új azonosítót használ.',
  MAINTENANCE_MODE: 'A NAV rendszer karbantartás alatt áll – próbáld újra később (nav_sync).',
  TOO_MANY_REQUESTS: 'A NAV forgalomkorlátozást alkalmazott (HTTP 429) – várd ki a Retry-After időt, majd próbáld újra (nav_sync).',
  OPERATION_FAILED: 'Átmeneti NAV szerverhiba – próbáld újra később (nav_sync).',
  INVALID_REQUEST: 'A NAV formailag hibásnak találta a kérést – ez programhiba, jelezd a fejlesztőknek a hibaüzenettel együtt.',
  STATUS_QUERY_NOT_ALLOWED: 'A lekérdezés verziója alacsonyabb a beküldés verziójánál.',
  MULTIPLE_QUERY_RESULT_FOUND: 'A számlaszám a NAV-nál többször szerepel érvényes adatszolgáltatásként: a fölösleget a NAV felületén (onlineszamla.nav.gov.hu) technikai érvénytelenítéssel kell visszavonni.',
  REQUEST_TOO_LARGE: 'A NAV legfeljebb 10 MB-os kérést fogad el; ekkora számla nem jelenthető – ez programhiba, jelezd a fejlesztőknek.',
  HTTP_413: 'A NAV túl nagynak találta a kérést (legfeljebb 10 MB lehet); ekkora számla nem jelenthető – ez programhiba, jelezd a fejlesztőknek.',
};

const TRANSPORT_HINT = 'Hálózati hiba vagy átmeneti NAV-elérhetetlenség – a művelet később megismételhető (nav_sync).';

/**
 * HTTP 2xx on manageInvoice means NAV has completed the synchronous part and issued a transactionId
 * (spec 1.8.2.2) – even if we cannot read the answer, the invoice is most likely received. A blind
 * resubmission would then come back ABORTED with INVOICE_NUMBER_NOT_UNIQUE (spec 1.9.2).
 */
function receivedNote(operation: NavApiOperation, status: number | null): string {
  return receivedAnswer(operation, status)
    ? ' A NAV HTTP 200-zal válaszolt, tehát a beküldést valószínűleg befogadta – újraküldés előtt ellenőrizni kell a tranzakciólistát, különben a számlaszám ütközhet (INVOICE_NUMBER_NOT_UNIQUE).'
    : '';
}

function receivedAnswer(operation: NavApiOperation, status: number | null): boolean {
  return operation === 'manageInvoice' && status !== null && status >= 200 && status < 300;
}

const UNCERTAIN_NOTE = ' A beküldés eredménye bizonytalan (a NAV a kérést ettől még befogadhatta) – újraküldés előtt a NAV tranzakciólistáján ellenőrizni kell.';

/**
 * Transport failures that happen before anything is sent (connection refused, name resolution, no route,
 * connect timeout, TLS handshake): such a request cannot have reached NAV. Any other failure of a
 * manageInvoice call (connection reset, socket hang up …) may come after NAV received the request.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'UND_ERR_CONNECT_TIMEOUT']);

function neverSent(e: unknown): boolean {
  const code = transportErrorCode(e);
  return code !== null && (NOT_SENT_CODES.has(code) || /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code));
}

const ENDPOINT_HINT = 'Ellenőrizd a NAV végpont címét (környezet: test/production, baseUrl).';

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export class NavClient {
  readonly #credentials: NavCredentials;
  readonly #software: NavSoftware;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #clockOffsetMs: number | null = null;

  /**
   * How far this machine's clock is ahead of NAV's (ms; negative: behind), from the latest NAV response: its HTTP Date
   * header (whole seconds), or the time NAV stamped an exchange token with (tokenValidityFrom) – plus the time the
   * answer took; null before a response that had either. NAV only refuses a
   * request whose time is off by more than a day, so a PC clock some minutes off goes unnoticed – but comparing a
   * time NAV recorded (e.g. when it received a report) with one of ours must correct for it.
   */
  get clockOffsetMs(): number | null {
    return this.#clockOffsetMs;
  }

  constructor(opts: NavClientOptions) {
    if (!opts || (opts.environment !== 'test' && opts.environment !== 'production')) {
      throw new AppError('NAV_INVALID_CONFIG', 'Ismeretlen NAV környezet (test vagy production lehet).');
    }
    assertNavCredentials(opts.credentials);
    assertNavSoftware(opts.software);
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new AppError('NAV_INVALID_CONFIG', 'Nincs elérhető fetch implementáció.');
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AppError('NAV_INVALID_CONFIG', 'A NAV időtúllépési korlát pozitív szám legyen (ms).');
    this.#credentials = { ...opts.credentials };
    this.#software = { ...opts.software };
    this.#baseUrl = (opts.baseUrl ?? NAV_BASE_URLS[opts.environment]).replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Requests a one-time exchange token (valid ~5 minutes) and decodes it. */
  async tokenExchange(): Promise<{ token: string; validFrom: string | null; validTo: string | null }> {
    const doc = await this.#call('tokenExchange', buildTokenExchangeRequest(this.#context()));
    const parsed = this.#parse('tokenExchange', () => parseTokenExchangeResponse(doc));
    let token: string;
    try {
      token = decodeExchangeToken(parsed.encodedExchangeToken, this.#credentials.exchangeKey).trim();
    } catch {
      token = '';
    }
    if (!token || /[^\x20-\x7E]/.test(token)) {
      // Garbage after decryption means a wrong exchange key; never include key or token material.
      throw new NavError('TOKEN_DECODE_FAILED', 'A NAV adatszolgáltatási tokenjét nem sikerült visszafejteni az XML cserekulccsal.', {
        retryable: false,
        httpStatus: null,
        hint: HINTS.TOKEN_DECODE_FAILED,
      });
    }
    // NAV stamps the token with its own clock, to the millisecond: a reading that needs no HTTP Date header.
    const stamped = Date.parse(parsed.tokenValidityFrom ?? '');
    if (Number.isFinite(stamped)) this.#clockOffsetMs = this.#now().getTime() - stamped;
    return { token, validFrom: parsed.tokenValidityFrom, validTo: parsed.tokenValidityTo };
  }

  /**
   * Sends up to 100 invoice operations (does its own tokenExchange). Returns NAV's transactionId.
   * compressedContent: every invoiceData is base64(gzip(xml)) (see encodeInvoiceData). beforeSend runs after the token
   * exchange (so with a fresh clockOffsetMs) and before the request that reports: what it records is there even if
   * the process dies while the report is on its way.
   */
  async manageInvoice(items: ManageInvoiceItem[], opts: { compressedContent?: boolean; beforeSend?: () => void } = {}): Promise<{ transactionId: string; requestId: string }> {
    const ops = checkItems(items);
    const { token } = await this.tokenExchange();
    opts.beforeSend?.();
    const ctx = this.#context();
    const doc = await this.#call('manageInvoice', buildManageInvoiceRequest(ctx, token, ops, opts.compressedContent === true), [token]);
    const { transactionId } = this.#parse('manageInvoice', () => parseManageInvoiceResponse(doc), [token]);
    return { transactionId, requestId: ctx.requestId };
  }

  /**
   * Processing results of a transaction. returnOriginalRequest adds the invoiceData NAV received for each index
   * (to recognise our own submission); the returned responseXml never contains it.
   */
  async queryTransactionStatus(transactionId: string, opts: { returnOriginalRequest?: boolean } = {}): Promise<{ results: NavProcessingResult[]; responseXml: string }> {
    if (typeof transactionId !== 'string' || !REQUEST_ID_RE.test(transactionId)) {
      throw new NavError('INVALID_ARGUMENT', `Érvénytelen NAV tranzakcióazonosító: ${String(transactionId)}`, { retryable: false });
    }
    const doc = await this.#call('queryTransactionStatus', buildQueryTransactionStatusRequest(this.#context(), transactionId, opts.returnOriginalRequest === true));
    const results = this.#parse('queryTransactionStatus', () => parseQueryTransactionStatusResponse(doc));
    return { results, responseXml: sanitizeNavXml(doc.raw, this.#secrets()) };
  }

  /** One page of the transactions NAV received between `from` and `to` (insDate, at most 35 days apart). */
  async queryTransactionList(from: Date, to: Date, page = 1): Promise<{ currentPage: number; availablePage: number; transactions: NavTransactionInfo[] }> {
    const valid = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
    if (!valid(from) || !valid(to) || from.getTime() > to.getTime() || to.getTime() - from.getTime() > 35 * 24 * 3600_000) {
      throw new NavError('INVALID_ARGUMENT', 'A tranzakciólista időszaka érvénytelen (a kezdete nem lehet a vége után, és legfeljebb 35 nap lehet).', { retryable: false });
    }
    if (!Number.isInteger(page) || page < 1) throw new NavError('INVALID_ARGUMENT', `Érvénytelen oldalszám: ${String(page)}`, { retryable: false });
    const doc = await this.#call('queryTransactionList', buildQueryTransactionListRequest(this.#context(), page, from, to));
    return this.#parse('queryTransactionList', () => parseQueryTransactionListResponse(doc, this.#credentials.login));
  }

  /** Whether `invoiceNumber`, issued by this taxpayer, is valid at NAV exactly once (it was reported and accepted). */
  async queryInvoiceCheck(invoiceNumber: string): Promise<boolean> {
    checkInvoiceNumber(invoiceNumber);
    const doc = await this.#call('queryInvoiceCheck', buildQueryInvoiceCheckRequest(this.#context(), invoiceNumber));
    return this.#parse('queryInvoiceCheck', () => parseQueryInvoiceCheckResponse(doc));
  }

  /**
   * The invoice `invoiceNumber` of this taxpayer (OUTBOUND) as NAV holds it: its InvoiceData XML (decompressed)
   * and audit data when it is valid there exactly once, 'not_found' when NAV has no valid invoice with that
   * number, 'multiple' when it is valid more than once (MULTIPLE_QUERY_RESULT_FOUND). The invoice data is
   * never part of an error or of returned response XML.
   */
  async queryInvoiceData(invoiceNumber: string): Promise<NavInvoiceDataResult> {
    checkInvoiceNumber(invoiceNumber);
    let doc: NavResponseDoc;
    try {
      doc = await this.#call('queryInvoiceData', buildQueryInvoiceDataRequest(this.#context(), invoiceNumber));
    } catch (e) {
      if (e instanceof NavError && e.navErrorCode === 'MULTIPLE_QUERY_RESULT_FOUND') return { status: 'multiple' };
      throw e;
    }
    const r = this.#parse('queryInvoiceData', () => parseQueryInvoiceDataResponse(doc));
    return r.found ? { status: 'found', invoiceData: r.invoiceData, compressed: r.compressed, audit: r.audit } : { status: 'not_found' };
  }

  /** Looks up a Hungarian taxpayer by the 8-digit törzsszám. Returns null if NAV does not know it. */
  async queryTaxpayer(taxpayerId: string): Promise<TaxpayerInfo | null> {
    const parts = splitHuTaxNumber(taxpayerId);
    if (!parts) {
      throw new NavError('INVALID_ARGUMENT', `Érvénytelen adószám: ${String(taxpayerId)}`, {
        retryable: false,
        hint: 'Elég a 8 jegyű törzsszám, pl. 12345676 (vagy a teljes adószám: 12345676-1-23).',
      });
    }
    const doc = await this.#call('queryTaxpayer', buildQueryTaxpayerRequest(this.#context(), parts.taxpayerId));
    return this.#parse('queryTaxpayer', () => parseQueryTaxpayerResponse(doc));
  }

  // -------------------------------------------------------------------------------------------

  /** The timeout of the request about to start (a subclass with a time limit may cut it). */
  protected requestTimeoutMs(): number {
    return this.#timeoutMs;
  }

  #context(): NavRequestContext {
    return { requestId: newRequestId(), timestamp: this.#now(), credentials: this.#credentials, software: this.#software };
  }

  #secrets(extra: readonly string[] = []): string[] {
    const c = this.#credentials;
    return [c.password, passwordHash(c.password), c.signingKey, c.exchangeKey, ...extra];
  }

  #parse<T>(operation: NavApiOperation, fn: () => T, extraSecrets: readonly string[] = []): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof NavResponseFormatError) {
        throw new NavError('INVALID_RESPONSE', redactSecrets(`Váratlan NAV válasz (${operation}): ${e.message}${receivedNote(operation, 200)}`, this.#secrets(extraSecrets)), {
          retryable: isRetryableNavError('INVALID_RESPONSE', null),
          httpStatus: 200,
          uncertain: receivedAnswer(operation, 200),
        });
      }
      throw e;
    }
  }

  /** POSTs one request; returns the parsed successful response or throws a NavError. */
  async #call(operation: NavApiOperation, requestXml: string, extraSecrets: readonly string[] = []): Promise<NavResponseDoc> {
    const secrets = this.#secrets(extraSecrets);
    const size = Buffer.byteLength(requestXml, 'utf8');
    if (size > NAV_MAX_REQUEST_BYTES) {
      // NAV refuses it anyway, and a server dropping an oversized upload would make the outcome look uncertain.
      throw new NavError('REQUEST_TOO_LARGE', `A NAV-kérés (${operation}) mérete ${size} bájt, a NAV legfeljebb ${NAV_MAX_REQUEST_BYTES} bájtot fogad el – nem küldtük el.`, {
        retryable: false,
        httpStatus: null,
        hint: HINTS.REQUEST_TOO_LARGE,
      });
    }
    const url = `${this.#baseUrl}/${operation}`;
    const controller = new AbortController();
    const timeoutMs = this.requestTimeoutMs();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let body: string;
    let retryAfterMs: number | null = null;
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml; charset=UTF-8', Accept: 'application/xml' },
        body: requestXml,
        signal: controller.signal,
      });
      status = res.status;
      retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after') ?? null, this.#now());
      const navTime = Date.parse(res.headers?.get?.('date') ?? '');
      if (Number.isFinite(navTime)) this.#clockOffsetMs = this.#now().getTime() - navTime;
      body = await res.text();
    } catch (e) {
      if (controller.signal.aborted) {
        const uncertain = operation === 'manageInvoice';
        throw new NavError('TIMEOUT', `A NAV nem válaszolt ${timeoutMs} ms alatt (${operation}).${uncertain ? UNCERTAIN_NOTE : ''}`, {
          retryable: true,
          httpStatus: null,
          hint: TRANSPORT_HINT,
          uncertain,
        });
      }
      const uncertain = operation === 'manageInvoice' && !neverSent(e);
      throw new NavError('NETWORK_ERROR', redactSecrets(`Hálózati hiba a NAV elérésekor (${operation}): ${describeTransportError(e)}${uncertain ? UNCERTAIN_NOTE : ''}`, secrets), {
        retryable: true,
        httpStatus: null,
        hint: TRANSPORT_HINT,
        uncertain,
      });
    } finally {
      clearTimeout(timer);
    }

    let doc: NavResponseDoc | null = null;
    try {
      doc = parseNavResponseXml(body);
    } catch {
      doc = null;
    }
    const wait = retryAfterMs !== null ? ` Újrapróbálás legkorábban ${Math.ceil(retryAfterMs / 1000)} mp múlva (Retry-After).` : '';
    if (doc) {
      const err = navErrorInfo(doc);
      if (err) {
        const details = err.technicalMessages.map((m) => `${m.code}: ${m.message}`).join('; ');
        const message = `NAV hiba (${operation}, HTTP ${status}): ${err.errorCode}${err.message ? ` – ${err.message}` : ''}${details ? ` [${details}]` : ''}${wait}`;
        throw new NavError(err.errorCode, redactSecrets(message, secrets), {
          retryable: isRetryableNavError(err.errorCode, status),
          httpStatus: status,
          hint: HINTS[err.errorCode] ?? (status >= 500 ? TRANSPORT_HINT : undefined),
          retryAfterMs,
        });
      }
    }
    if (status < 200 || status >= 300) {
      const code = status === 429 ? 'TOO_MANY_REQUESTS' : `HTTP_${status}`;
      // A gateway error (no NAV answer) may come after the NAV backend received the request.
      const uncertain = operation === 'manageInvoice' && (status === 502 || status === 504);
      throw new NavError(code, `A NAV szerver HTTP ${status} választ adott (${operation}).${wait}${uncertain ? UNCERTAIN_NOTE : ''}`, {
        retryable: isRetryableNavError(code, status),
        httpStatus: status,
        hint: HINTS[code] ?? (status === 404 || status === 405 || status === 415 ? ENDPOINT_HINT : status >= 500 ? TRANSPORT_HINT : undefined),
        retryAfterMs,
        uncertain,
      });
    }
    if (!doc) {
      throw new NavError('INVALID_RESPONSE', `A NAV válasza nem értelmezhető XML (${operation}).${receivedNote(operation, status)}`, {
        retryable: isRetryableNavError('INVALID_RESPONSE', status),
        httpStatus: status,
        hint: TRANSPORT_HINT,
        uncertain: receivedAnswer(operation, status),
      });
    }
    return doc;
  }
}

/** Retry-After header: delay-seconds or an HTTP-date (RFC 9110). */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

/** The system/undici error code of a failed fetch (`cause.code`, e.g. ECONNRESET), if any. */
function transportErrorCode(e: unknown): string | null {
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  return cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : null;
}

function describeTransportError(e: unknown): string {
  const code = transportErrorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  return code ? `${msg} (${code})` : msg;
}

/** An invoice number NAV can be asked about (common:SimpleText50NotBlankType without surrounding whitespace). */
function checkInvoiceNumber(invoiceNumber: string): void {
  if (typeof invoiceNumber !== 'string' || invoiceNumber.trim() === '' || invoiceNumber !== invoiceNumber.trim() || Array.from(invoiceNumber).length > 50 || /[\r\n\t]/.test(invoiceNumber)) {
    throw new NavError('INVALID_ARGUMENT', `Érvénytelen számlaszám: ${String(invoiceNumber)}`, { retryable: false });
  }
}

function checkItems(items: ManageInvoiceItem[]): ManageInvoiceItem[] {
  const bad = (message: string): NavError => new NavError('INVALID_ARGUMENT', message, { retryable: false });
  if (!Array.isArray(items) || items.length === 0) throw bad('A manageInvoice kérésben legalább egy számlának kell lennie.');
  if (items.length > 100) throw bad('Egy manageInvoice kérésben legfeljebb 100 számla küldhető.');
  const ops = [...items].sort((a, b) => a.index - b.index);
  ops.forEach((o, i) => {
    if (o.index !== i + 1) throw bad('A számlák indexének 1-től kezdődő, hézagmentes sorozatnak kell lennie.');
    if (o.operation !== 'CREATE' && o.operation !== 'MODIFY' && o.operation !== 'STORNO') throw bad(`Ismeretlen számlaművelet: ${String(o.operation)}`);
    if (typeof o.invoiceDataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.invoiceDataBase64)) {
      throw bad(`A(z) ${o.index}. számla adata nem érvényes base64.`);
    }
  });
  return ops;
}
