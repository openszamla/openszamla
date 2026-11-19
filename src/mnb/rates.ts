/**
 * MNB (Magyar Nemzeti Bank) official exchange rates via its public SOAP web service.
 * CONTRACT FILE – keep the signatures; endpoint/format per docs/research/06-adatformatumok.md.
 * Rates are "HUF per `unit` units"; MnbRate.rate is normalised to HUF per 1 unit.
 *
 * Wire format – checked against the live service on 2026-10-27 (recorded replies:
 * test/fixtures/mnb/) and MNB's "Documentation on the MNB's web service on current and historic
 * exchange rates":
 * - Endpoint http://www.mnb.hu/arfolyamok.asmx – plain HTTP on purpose. Over HTTPS the same URL
 *   serves the WSDL (GET ?wsdl) but answers every SOAP POST with an empty 404, and the WSDL's own
 *   soap:address is the http:// URL.
 * - SOAP 1.1: POST, Content-Type "text/xml; charset=utf-8",
 *   SOAPAction "http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/<Operation>", body element
 *   <Operation xmlns="http://www.mnb.hu/webservices/"> with namespace-qualified string parameters.
 *   Both matter: MNB dispatches on the SOAPAction (a GetInfo SOAPAction with a GetExchangeRates body
 *   answers GetInfo), and it silently ignores unqualified parameters (the reply is then the whole
 *   history since 1949 without a single rate, ~400 kB).
 * - A reply carries ONE string, <OperationResponse><OperationResult>, whose text is itself an XML
 *   document, escaped as &lt;…&gt;. The envelope parse unescapes it; then it is parsed again.
 * - GetExchangeRates(startDate, endDate: "YYYY-MM-DD"; currencyNames: "EUR,USD", case-sensitive)
 *   → <MNBExchangeRates><Day date="2026-10-22"><Rate unit="1" curr="EUR">366,52000</Rate></Day>…
 *   Newest day first, only days with a publication (none on weekends and public holidays).
 *   DECIMAL COMMA with a varying number of decimals ("367,14", "366,52000", "42"); `unit` is the
 *   number of currency units the figure is for (100 for JPY, IDR, KRW; 1000 for ITL in the past). A
 *   currency without rates (unknown, discontinued or lower-case code) yields bare <Day date="…" />
 *   elements; a window without any publication yields <MNBExchangeRates />; an unparsable date is an
 *   HTTP 500 Fault. Old data can list a date twice (a bare <Day date="d" /> next to the <Day date="d">
 *   with the rates) and uses "0,00" as a placeholder for a missing quotation (GRD and YUD on
 *   1988-05-27). Since 1990 the longest gap between two publications is 7 days (Christmas); in older
 *   periods MNB quoted less often (e.g. monthly in 1981).
 * - GetCurrentExchangeRates() → <MNBCurrentExchangeRates><Day date="…"><Rate …>…</Rate>…</Day>:
 *   the latest publication, i.e. exactly the currencies MNB currently quotes.
 * - MNB fixes the rates at 11:00 on working days; a rate is valid until the next publication.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { EntityDecoderOptions, X2jOptions } from 'fast-xml-parser';
import { addDays, assertIsoDate, huDate, isIsoDate } from '../core/dates.ts';
import { dec, toDec } from '../core/decimal.ts';
import type { DecValue } from '../core/decimal.ts';
import { AppError } from '../core/errors.ts';
import type { Dec, IsoDate } from '../core/types.ts';
import { VERSION } from '../version.ts';

export interface MnbRate {
  currency: string;
  /** Publication date of the rate actually used (may be earlier than requested on weekends/holidays). */
  date: IsoDate;
  /** HUF per 1 unit of currency. */
  rate: Dec;
  /** Units the published figure refers to (e.g. 100 for JPY). */
  unit: number;
  /** Rate exactly as published (HUF per `unit` units). */
  publishedRate: Dec;
}

export interface MnbClientOptions {
  fetch?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  /** Clock that decides which day is "today" in Budapest (future dates have no rate yet). Default: system clock. */
  now?: () => Date;
}

const DEFAULT_ENDPOINT = 'http://www.mnb.hu/arfolyamok.asmx';
const SERVICE_NS = 'http://www.mnb.hu/webservices/';
const SOAP_ACTION_PREFIX = 'http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/';
const DEFAULT_TIMEOUT_MS = 10_000;
/** setTimeout's limit: Node fires a longer delay after 1 ms, which would be an instant "timeout". */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** getRate searches [date − LOOKBACK_DAYS, date] for the last publication. */
const LOOKBACK_DAYS = 14;
/** Real replies are a few kB; anything far bigger is not the MNB service. */
const MAX_REPLY_CHARS = 2_000_000;

const CURRENCY_RE = /^[A-Z]{3}$/;
/** A published figure: digits with an optional DECIMAL COMMA ("366,52000", "42"). */
const PUBLISHED_NUMBER_RE = /^\d+(?:,\d+)?$/;
const UNIT_RE = /^[1-9]\d{0,8}$/;

const MANUAL_RATE_HINT = 'Az árfolyamot kézzel is megadhatod (exchangeRate: 1 egység = ? HUF).';

type Operation = 'GetExchangeRates' | 'GetCurrentExchangeRates';

export class MnbClient {
  private readonly fetchFn: typeof fetch | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: MnbClientOptions = {}) {
    this.fetchFn = opts.fetch;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? (() => new Date());
    if (!URL.canParse(this.endpoint)) {
      throw new AppError('INVALID_ARGUMENT', `Érvénytelen MNB végpont: ${this.endpoint}`, {
        hint: `Teljes URL-t adj meg, vagy hagyd el (alapértelmezés: ${DEFAULT_ENDPOINT}).`,
      });
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new AppError('INVALID_ARGUMENT', `Érvénytelen MNB időkorlát: ${this.timeoutMs} ms`, {
        hint: `Pozitív számot adj meg ezredmásodpercben, legfeljebb ${MAX_TIMEOUT_MS}-ot (alapértelmezés: ${DEFAULT_TIMEOUT_MS}).`,
      });
    }
  }

  /**
   * Official MNB rate valid on `date`, as Áfa tv. 80. § (2) b) requires ("the last rate valid at that
   * time"): the rate MNB published on `date`, or, when it published none that day (weekend, holiday),
   * the last one before it. Looks back up to 14 days.
   * A date after today (Budapest) has no official rate yet: MNB_RATE_NOT_FOUND without a request – a
   * rate published earlier is NOT the one valid on that day. For today, before MNB fixes the day's rates
   * (11:00 on working days), the result is the previous publication, which is valid until then.
   * Throws AppError('MNB_RATE_NOT_FOUND') if there is no rate, ('MNB_UNAVAILABLE') on network errors,
   * timeouts, HTTP errors and SOAP faults, ('MNB_BAD_RESPONSE') if the reply cannot be understood, and
   * ('INVALID_CURRENCY' / 'INVALID_DATE') for malformed input. HUF yields rate 1 without a request.
   */
  async getRate(currency: string, date: IsoDate): Promise<MnbRate> {
    const cur = normalizeCurrency(currency);
    const day = assertIsoDate(date, 'date');
    if (cur === 'HUF') return { currency: 'HUF', date: day, rate: '1', unit: 1, publishedRate: '1' };
    const today = huDate(this.now());
    if (day > today) throw futureDate(cur, day, today);

    const from = addDays(day, -LOOKBACK_DAYS);
    const xml = await this.call('GetExchangeRates', { startDate: from, endDate: day, currencyNames: cur });
    const days = readDays(parseDocument(xml, 'MNBExchangeRates'), 'MNBExchangeRates');

    let best: { date: IsoDate; rate: PublishedRate } | undefined;
    for (const d of days) {
      if (d.date < from || d.date > day) continue; // never use a rate published after `date`
      for (const r of d.rates) {
        // "0,00" is MNB's placeholder for a missing quotation: that day has no rate for the currency.
        if (r.currency !== cur || r.value.isZero()) continue;
        if (best && best.date === d.date && !(best.rate.unit === r.unit && best.rate.value.eq(r.value))) {
          throw badResponse(`két eltérő ${cur} árfolyam ugyanarra a napra (${d.date})`);
        }
        if (!best || d.date > best.date) best = { date: d.date, rate: r };
      }
    }
    if (!best) throw rateNotFound(cur, day, from, days.length > 0);

    const published = best.rate.value;
    return {
      currency: cur,
      date: best.date,
      rate: toDec(published.div(best.rate.unit)),
      unit: best.rate.unit,
      publishedRate: toDec(published),
    };
  }

  /**
   * Currencies MNB publishes rates for: the ones in its latest publication (GetCurrentExchangeRates),
   * sorted. HUF itself and discontinued currencies (e.g. HRK, BGN) are not included.
   */
  async listCurrencies(): Promise<string[]> {
    const xml = await this.call('GetCurrentExchangeRates');
    const days = readDays(parseDocument(xml, 'MNBCurrentExchangeRates'), 'MNBCurrentExchangeRates');
    const codes = new Set<string>();
    for (const d of days) for (const r of d.rates) if (!r.value.isZero()) codes.add(r.currency);
    if (codes.size === 0) throw badResponse('az aktuális árfolyamtábla üres');
    return [...codes].sort();
  }

  /** Calls one SOAP operation and returns the embedded XML document (already unescaped). */
  private async call(operation: Operation, params: Readonly<Record<string, string>> = {}): Promise<string> {
    const reply = await this.post(operation, params);
    const ok = reply.status >= 200 && reply.status < 300;
    const tooBig = reply.text.length > MAX_REPLY_CHARS;
    const body = tooBig ? null : parseSoapBody(reply.text);
    const fault = body && isNode(body.Fault) ? body.Fault : null;
    const context = { operation, endpoint: this.endpoint, httpStatus: reply.status, ...(reply.redirectedTo ? { redirectedTo: reply.redirectedTo } : {}) };

    if (!ok || fault) {
      const faultString = fault ? text(fault.faultstring) : undefined;
      throw new AppError(
        'MNB_UNAVAILABLE',
        faultString
          ? `Az MNB árfolyam-szolgáltatása hibát jelzett (HTTP ${reply.status}): ${faultString}`
          : `Az MNB árfolyam-szolgáltatása hibával válaszolt (HTTP ${reply.status}).`,
        {
          hint:
            reply.status >= 400 && reply.status < 500 && !fault
              ? `Ellenőrizd a végpontot (${this.endpoint}): az MNB a http://www.mnb.hu/arfolyamok.asmx címen fogad ` +
                `SOAP-hívást, HTTPS-en ugyanez a cím 404-et ad. ${MANUAL_RATE_HINT}`
              : `Valószínűleg átmeneti hiba az MNB oldalán – próbáld újra később. ${MANUAL_RATE_HINT}`,
          details: { ...context, ...(fault ? { faultCode: text(fault.faultcode), faultString } : {}) },
        },
      );
    }
    if (tooBig) throw badResponse(`túl nagy válasz (${reply.text.length} karakter)`, context);
    if (!body) throw badResponse('a válasz nem érvényes SOAP XML', { ...context, snippet: snippet(reply.text) });

    const response = body[`${operation}Response`];
    const result = isNode(response) ? response[`${operation}Result`] : undefined;
    if (result === undefined) throw badResponse(`hiányzik a ${operation}Result elem`, { ...context, snippet: snippet(reply.text) });
    if (typeof result !== 'string') throw badResponse(`a ${operation}Result nem beágyazott XML-szöveg`, { ...context, snippet: snippet(reply.text) });
    return result;
  }

  /** The HTTP round trip, bounded by the timeout (AbortController) including the body download. */
  private async post(operation: Operation, params: Readonly<Record<string, string>>): Promise<Reply> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${SOAP_ACTION_PREFIX}${operation}"`,
          Accept: 'text/xml',
          'User-Agent': `OpenSzamla/${VERSION}`,
        },
        body: soapRequest(operation, params),
        signal: controller.signal,
      });
      const replyText = await res.text();
      return { status: res.status, text: replyText, redirectedTo: res.redirected ? res.url : null };
    } catch (e) {
      const details = { operation, endpoint: this.endpoint, timeoutMs: this.timeoutMs };
      if (timedOut) {
        const seconds = String(this.timeoutMs / 1000).replace('.', ',');
        throw new AppError('MNB_UNAVAILABLE', `Az MNB árfolyam-szolgáltatása nem válaszolt ${seconds} másodpercen belül.`, {
          hint: `Próbáld újra később. ${MANUAL_RATE_HINT}`,
          details,
          cause: e,
        });
      }
      throw new AppError('MNB_UNAVAILABLE', `Nem sikerült elérni az MNB árfolyam-szolgáltatását: ${describeError(e)}`, {
        hint:
          `Ellenőrizd az internetkapcsolatot, és hogy a ${this.endpoint} elérhető-e` +
          `${this.endpoint.startsWith('http:') ? ' (titkosítatlan HTTP – proxy vagy tűzfal tilthatja)' : ''}. ${MANUAL_RATE_HINT}`,
        details,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SOAP request
// ---------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  text: string;
  redirectedTo: string | null;
}

function soapRequest(operation: Operation, params: Readonly<Record<string, string>>): string {
  const args = Object.entries(params)
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${operation} xmlns="${SERVICE_NS}">${args}</${operation}></soap:Body>` +
    '</soap:Envelope>'
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

function isNode(v: unknown): v is XmlNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY_RE = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([\da-fA-F]{1,6}));/g;

function isXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/**
 * Standard XML unescaping in ONE pass (so "&amp;lt;" stays "&lt;"): the five predefined entities
 * and character references, which fast-xml-parser's default decoder leaves untouched. Entities
 * declared in a DOCTYPE are ignored, never expanded. CDATA content is not passed here.
 */
const xmlEntityDecoder: EntityDecoderOptions = {
  setExternalEntities: () => undefined,
  addInputEntities: () => undefined,
  reset: () => undefined,
  setXmlVersion: () => undefined,
  decode: (s) =>
    s.includes('&')
      ? s.replace(ENTITY_RE, (whole: string, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
          if (name !== undefined) return PREDEFINED_ENTITIES[name] ?? whole;
          const cp = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
          return isXmlChar(cp) ? String.fromCodePoint(cp) : whole;
        })
      : s,
};

const COMMON_OPTIONS: X2jOptions = {
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: true,
  entityDecoder: xmlEntityDecoder,
};

/** SOAP envelope: namespace prefixes dropped (s:Envelope → Envelope), attributes ignored. */
const envelopeParser = new XMLParser({ ...COMMON_OPTIONS, removeNSPrefix: true, ignoreAttributes: true });

const ARRAY_TAGS = new Set(['Day', 'Rate']);
/** The embedded MNB document: attributes as "@_name", <Day> and <Rate> always arrays. */
const documentParser = new XMLParser({
  ...COMMON_OPTIONS,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name, _path, _isLeaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

/** Validates and parses a SOAP reply; returns the Body element, or null if it is not one. */
function parseSoapBody(xml: string): XmlNode | null {
  if (xml.trim() === '' || XMLValidator.validate(xml) !== true) return null;
  let doc: unknown;
  try {
    doc = envelopeParser.parse(xml);
  } catch {
    return null;
  }
  const envelope = isNode(doc) ? doc.Envelope : undefined;
  const body = isNode(envelope) ? envelope.Body : undefined;
  return isNode(body) ? body : null;
}

/**
 * Parses the embedded document and returns the content of its root element ('' for MNB's blank
 * document <MNBExchangeRates />, i.e. no data). An empty …Result is NOT a blank document – MNB never
 * sends one – so it is MNB_BAD_RESPONSE rather than "nothing published".
 */
function parseDocument(xml: string, root: string): unknown {
  const doc = xml.trim();
  if (doc === '') throw badResponse(`üres eredmény érkezett a(z) ${root} dokumentum helyett`);
  const validation = XMLValidator.validate(doc);
  if (validation !== true) {
    throw badResponse(`a beágyazott XML-dokumentum hibás (${validation.err.msg})`, { snippet: snippet(doc) });
  }
  let parsed: unknown;
  try {
    parsed = documentParser.parse(doc);
  } catch (e) {
    throw badResponse(`a beágyazott XML-dokumentum nem dolgozható fel (${describeError(e)})`, { snippet: snippet(doc) });
  }
  if (!isNode(parsed) || !Object.hasOwn(parsed, root)) {
    throw badResponse(`a beágyazott dokumentum gyökéreleme nem ${root}`, { snippet: snippet(doc) });
  }
  return parsed[root];
}

interface PublishedRate {
  currency: string;
  unit: number;
  /** The published figure (HUF per `unit` units); zero is MNB's "no quotation" placeholder. */
  value: DecValue;
}

interface PublishedDay {
  date: IsoDate;
  rates: PublishedRate[];
}

/** Reads <Day date><Rate unit curr>…</Rate></Day> elements, strictly: anything odd is MNB_BAD_RESPONSE. */
function readDays(root: unknown, rootName: string): PublishedDay[] {
  if (root === '') return []; // <MNBExchangeRates />
  if (!isNode(root)) throw badResponse(`a(z) ${rootName} elem tartalma érvénytelen`, { snippet: snippet(String(root)) });
  const days = root.Day;
  if (days === undefined) return [];
  if (!Array.isArray(days)) throw badResponse(`a(z) ${rootName}/Day elem szerkezete érvénytelen`);
  return days.map((day: unknown): PublishedDay => {
    const date = isNode(day) ? day['@_date'] : undefined;
    if (!isNode(day) || typeof date !== 'string' || !isIsoDate(date)) {
      throw badResponse(`érvénytelen Day elem (date: ${shown(date)})`);
    }
    const rates = day.Rate === undefined ? [] : day.Rate;
    if (!Array.isArray(rates)) throw badResponse(`a(z) ${date} napi Rate elemek szerkezete érvénytelen`);
    return { date, rates: rates.map((r: unknown) => readRate(r, date)) };
  });
}

function readRate(rate: unknown, date: IsoDate): PublishedRate {
  if (!isNode(rate)) throw badResponse(`attribútumok nélküli Rate elem (${date}): ${String(rate)}`);
  const currency = rate['@_curr'];
  const unit = rate['@_unit'];
  const value = rate['#text'];
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
    throw badResponse(`érvénytelen devizakód (${date}): ${shown(currency)}`);
  }
  if (typeof unit !== 'string' || !UNIT_RE.test(unit)) {
    throw badResponse(`érvénytelen egység (unit) a(z) ${currency} árfolyamnál (${date}): ${shown(unit)}`);
  }
  if (typeof value !== 'string' || !PUBLISHED_NUMBER_RE.test(value)) {
    throw badResponse(`érvénytelen ${currency} árfolyam (${date}): ${shown(value)}`, {
      expected: 'számjegyek, tizedesvesszővel (pl. 366,52)',
    });
  }
  // Never negative (the pattern has no sign); "0,00" is kept: the callers treat it as "not quoted that day".
  return { currency, unit: Number(unit), value: dec(value.replace(',', '.')) };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function normalizeCurrency(currency: string): string {
  const cur = String(currency).trim().toUpperCase();
  if (!CURRENCY_RE.test(cur)) {
    throw new AppError('INVALID_CURRENCY', `Érvénytelen devizakód: "${String(currency)}"`, {
      hint: 'Háromjegyű ISO 4217 devizakódot adj meg, pl. EUR, USD, CHF.',
    });
  }
  return cur;
}

function rateNotFound(currency: string, date: IsoDate, from: IsoDate, hadPublications: boolean): AppError {
  const details = { currency, date, searchedFrom: from, searchedTo: date };
  if (hadPublications) {
    return new AppError('MNB_RATE_NOT_FOUND', `Az MNB ${from} és ${date} között nem tett közzé ${currency} árfolyamot.`, {
      hint:
        'Ellenőrizd a devizakódot: az MNB csak bizonyos devizákra jegyez hivatalos árfolyamot, a megszűntekre ' +
        `(pl. HRK, BGN) már nem. ${MANUAL_RATE_HINT}`,
      details,
    });
  }
  return new AppError('MNB_RATE_NOT_FOUND', `Az MNB ${from} és ${date} között nem tett közzé árfolyamot.`, {
    hint:
      `Ellenőrizd a dátumot: az MNB adatai 1949-01-03-tól érhetők el, és a keresés ${LOOKBACK_DAYS} napra megy vissza ` +
      `(régebbi időszakokban az MNB ritkábban, pl. havonta jegyzett). ${MANUAL_RATE_HINT}`,
    details,
  });
}

/** A date after today (Budapest): MNB cannot have published the rate valid on it yet. */
function futureDate(currency: string, date: IsoDate, today: IsoDate): AppError {
  return new AppError(
    'MNB_RATE_NOT_FOUND',
    `Az MNB még nem tett közzé ${currency} árfolyamot a(z) ${date} napra: a dátum a jövőben van (ma ${today} van).`,
    {
      hint:
        'Jövőbeli napra még nincs hivatalos árfolyam (az MNB munkanapokon 11 órakor jegyez, és az árfolyam a következő ' +
        'jegyzésig érvényes): az adott napon vagy azután kérd le újra, vagy add meg kézzel (exchangeRate: 1 egység = ? HUF).',
      details: { currency, date, today },
    },
  );
}

function badResponse(reason: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('MNB_BAD_RESPONSE', `Az MNB árfolyam-szolgáltatása váratlan választ adott: ${reason}.`, {
    hint:
      'Valószínűleg megváltozott az MNB szolgáltatása, vagy egy proxy módosította a választ; próbáld újra később. ' +
      `${MANUAL_RATE_HINT} Ha tartósan fennáll, jelezd az OpenSzámla fejlesztőinek.`,
    details: { reason, ...details },
  });
}

/** A value from the reply for an error message ("(hiányzik)" when the attribute/text is absent). */
function shown(v: unknown): string {
  return v === undefined ? '(hiányzik)' : String(v);
}

function snippet(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error && e.cause.message !== e.message ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`;
}
