/**
 * Security primitives of the web UI: access-token check, stateless signed sessions, CSRF tokens,
 * confirmation values for irreversible actions, same-origin checks for POSTs and a login throttle
 * (plus the per-address throttle of the /mcp endpoint).
 *
 * Every key is derived from the access token with HMAC-SHA256 under a distinct label, so
 * - the session cookie never contains the token (a leaked cookie gives no /mcp access, and expires);
 * - changing the token invalidates every session, CSRF token and confirmation value at once;
 * - sessions survive a server restart as long as the token stays the same.
 * Every secret comparison is constant-time (both sides are hashed to 32 bytes first).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { escapeHtml } from './html.ts';

export interface WebKeys {
  /** False when the configured token is empty: then no login can succeed. */
  readonly tokenSet: boolean;
  readonly tokenDigest: Buffer;
  readonly session: Buffer;
  readonly csrf: Buffer;
  readonly confirm: Buffer;
}

export interface Session {
  /** Random id (22 base64url chars); CSRF tokens, flash messages and confirmations are bound to it. */
  id: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

export type ConfirmOperation = 'issue' | 'cancel';

export const SESSION_COOKIE = 'openszamla_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Confirmation values are valid for 10–20 minutes (current or previous 10-minute bucket). */
export const CONFIRM_BUCKET_MS = 10 * 60_000;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function mac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

/** Constant-time string equality (hashing first makes the comparison independent of the lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function deriveKeys(token: string): WebKeys {
  const sub = (label: string): Buffer => createHmac('sha256', token).update(`openszamla/web/${label}/v1`, 'utf8').digest();
  return { tokenSet: token.trim() !== '', tokenDigest: sha256(token), session: sub('session'), csrf: sub('csrf'), confirm: sub('confirm') };
}

export function tokenMatches(keys: WebKeys, candidate: string): boolean {
  const equal = timingSafeEqual(sha256(candidate), keys.tokenDigest);
  return equal && keys.tokenSet && candidate !== '';
}

// ---------------------------------------------------------------------------------------------
// Sessions: cookie value = "<id>.<expiry seconds>.<HMAC(id.expiry)>"
// ---------------------------------------------------------------------------------------------

const SESSION_RE = /^([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export function mintSession(keys: WebKeys, nowMs: number): { session: Session; cookieValue: string } {
  const id = randomBytes(16).toString('base64url');
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payload = `${id}.${exp}`;
  return { session: { id, expiresAt: exp * 1000 }, cookieValue: `${payload}.${mac(keys.session, payload)}` };
}

export function verifySession(keys: WebKeys, cookieValue: string, nowMs: number): Session | null {
  const m = SESSION_RE.exec(cookieValue);
  const id = m?.[1];
  const exp = m?.[2];
  const sig = m?.[3];
  if (id === undefined || exp === undefined || sig === undefined) return null;
  if (!safeEqual(sig, mac(keys.session, `${id}.${exp}`))) return null;
  const expiresAt = Number(exp) * 1000;
  if (!(expiresAt > nowMs)) return null;
  return { id, expiresAt };
}

// ---------------------------------------------------------------------------------------------
// CSRF: per-session token in a hidden form field
// ---------------------------------------------------------------------------------------------

export function csrfTokenFor(keys: WebKeys, sessionId: string): string {
  return mac(keys.csrf, sessionId);
}

export function verifyCsrf(keys: WebKeys, sessionId: string, given: string | null | undefined): boolean {
  return typeof given === 'string' && given.length > 0 && safeEqual(given, csrfTokenFor(keys, sessionId));
}

// ---------------------------------------------------------------------------------------------
// Confirmation values for issuing / cancelling (same idea as src/mcp/confirm.ts): bound to the
// operation, the session, the target and exactly what was shown (draft content hash / storno
// reason); they expire after 10–20 minutes, and a draft changed after the preview invalidates them.
// ---------------------------------------------------------------------------------------------

function confirmationFor(keys: WebKeys, sessionId: string, op: ConfirmOperation, targetId: string, material: string, bucket: number): string {
  return mac(keys.confirm, JSON.stringify([op, sessionId, targetId, material, bucket]));
}

export function mintConfirmation(keys: WebKeys, sessionId: string, op: ConfirmOperation, targetId: string, material: string, nowMs: number): string {
  return confirmationFor(keys, sessionId, op, targetId, material, Math.floor(nowMs / CONFIRM_BUCKET_MS));
}

export function verifyConfirmation(
  keys: WebKeys,
  sessionId: string,
  op: ConfirmOperation,
  targetId: string,
  material: string,
  given: string,
  nowMs: number,
): boolean {
  if (!given) return false;
  const bucket = Math.floor(nowMs / CONFIRM_BUCKET_MS);
  const current = safeEqual(given, confirmationFor(keys, sessionId, op, targetId, material, bucket));
  const previous = safeEqual(given, confirmationFor(keys, sessionId, op, targetId, material, bucket - 1));
  return current || previous;
}

// ---------------------------------------------------------------------------------------------
// Same-origin check for POST requests (defence in depth next to the CSRF token)
// ---------------------------------------------------------------------------------------------

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined ? undefined : s.trim();
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:(80|443)$/, '');
}

function hostOfUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeHost(u.host);
  } catch {
    return null;
  }
}

/**
 * True when a state-changing request comes from one of our own pages: Sec-Fetch-Site (sent by every
 * current browser) must not say cross-site/same-site, and Origin – or, without it, Referer – must
 * name the host the request was sent to (Host header, or X-Forwarded-Host behind a reverse proxy).
 * Requests with neither header (non-browser clients) pass here and still need the CSRF token.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = firstHeader(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const hosts = new Set<string>();
  const host = firstHeader(req, 'host');
  if (host) hosts.add(normalizeHost(host));
  const forwarded = firstHeader(req, 'x-forwarded-host')?.split(',')[0];
  if (forwarded?.trim()) hosts.add(normalizeHost(forwarded));
  if (hosts.size === 0) return false;
  const origin = firstHeader(req, 'origin');
  if (origin !== undefined) {
    const h = hostOfUrl(origin);
    return h !== null && hosts.has(h);
  }
  const referer = firstHeader(req, 'referer');
  if (referer !== undefined) {
    const h = hostOfUrl(referer);
    return h !== null && hosts.has(h);
  }
  return true;
}

/** True when the request arrived over TLS (directly or via a reverse proxy that says so). */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  return firstHeader(req, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * True for a top-level document navigation – the only legitimate way to open a "?token=" login link
 * (or a client without fetch metadata). <img>, <script>, <iframe> and fetch() requests planted on
 * another page are not: they must neither log in nor count as failed attempts (otherwise any web
 * page the owner visits could keep the global login throttle closed).
 */
export function isTopLevelNavigation(req: IncomingMessage): boolean {
  const mode = firstHeader(req, 'sec-fetch-mode');
  const dest = firstHeader(req, 'sec-fetch-dest');
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document');
}

// ---------------------------------------------------------------------------------------------
// Last line of defence: secrets never reach a rendered page
// ---------------------------------------------------------------------------------------------

/** Shown instead of a secret. */
export const REDACTED = '[rejtett]';
/** Shorter values are not treated as secrets (they would mask ordinary text; real keys are longer). */
const MIN_SECRET_LENGTH = 6;

/** The distinct secrets worth redacting (longest first, so a secret containing another one is masked whole). */
export function secretList(values: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) if (typeof v === 'string' && v.trim().length >= MIN_SECRET_LENGTH) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Every way a secret can appear in a rendered page: as it is, HTML-escaped, or URL-encoded inside an attribute. */
function renderedForms(secret: string): string[] {
  const formEncoded = new URLSearchParams([['', secret]]).toString().slice(1);
  return [secret, escapeHtml(secret), escapeHtml(encodeURIComponent(secret)), escapeHtml(formEncoded)];
}

function renderedFormsOf(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap(renderedForms))].sort((a, b) => b.length - a.length);
}

/** True when `value`, rendered into a page (HTML-escaped), would be masked by redactSecrets. */
export function containsSecret(value: string, secrets: readonly string[]): boolean {
  if (value === '' || secrets.length === 0) return false;
  const escaped = escapeHtml(value);
  return renderedFormsOf(secrets).some((f) => escaped.includes(f));
}

/** Tags (whole <script>/<style> elements – trusted constants – are matched as one piece). */
const TAG_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>/gi;
/** The same, with whole <textarea> elements as one piece (their body is the value the control submits). */
const CONTROL_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<textarea\b[^>]*>[\s\S]*?<\/textarea\s*>|<[^>]*>/gi;

/** Shown next to a form control left out of the submit because its value contains a secret. */
const WITHHELD_NOTE =
  '<span class="withheld" role="note">A mező értéke a hozzáférési tokent vagy egy NAV-hitelesítő adatot tartalmaz, ezért rejtve jelenik meg, ' +
  'és itt nem módosítható: az űrlap nem küldi el, mentéskor a mező tárolt értéke változatlan marad.</span>';

/** The tag with a disabled attribute: looked for outside the attribute values (a value may contain the word). */
function disabled(tag: string): string {
  const attributes = tag.replace(/"[^"]*"|'[^']*'/g, '""');
  return /\sdisabled(?=[\s>=])/i.test(attributes) ? tag : `${tag.slice(0, -1)} disabled>`;
}

/**
 * A form control whose value would be masked must not be submitted: the browser would post the mask
 * back as the value of a field nobody touched, and the record would be saved with "[rejtett]" in it.
 * Such a control (<input>, <option>, <textarea>) is disabled – browsers leave disabled controls out
 * of the submit, and the edit forms then keep the stored value (context.ts withWithheldFields) – and
 * gets a visible note. The value itself is masked afterwards like any other attribute or text.
 */
function withholdSecretControls(page: string, hasSecret: (text: string) => boolean): string {
  let out = '';
  let last = 0;
  let notePending = false;
  for (const m of page.matchAll(CONTROL_RE)) {
    const tag = m[0];
    out += page.slice(last, m.index);
    last = m.index + tag.length;
    if (m[1] !== undefined) {
      out += tag;
      continue;
    }
    if (/^<textarea\b/i.test(tag)) {
      // The first ">" ends the opening tag: attribute values are always escaped.
      const open = tag.indexOf('>') + 1;
      const body = tag.slice(open, tag.search(/<\/textarea\s*>$/i));
      out += hasSecret(body) ? `${disabled(tag.slice(0, open))}${tag.slice(open)}${WITHHELD_NOTE}` : tag;
      continue;
    }
    const control = /^<(input|option)\b/i.exec(tag)?.[1]?.toLowerCase();
    const value = control === undefined ? undefined : /\svalue="([^"]*)"/i.exec(tag)?.[1];
    if (value !== undefined && hasSecret(value)) {
      out += disabled(tag);
      // An <option> cannot hold markup: its note follows the list.
      if (control === 'input') out += WITHHELD_NOTE;
      else notePending = true;
      continue;
    }
    out += tag;
    if (notePending && /^<\/(?:select|datalist)\s*>$/i.test(tag)) {
      out += WITHHELD_NOTE;
      notePending = false;
    }
  }
  return out + page.slice(last);
}

/**
 * Replaces every occurrence of a secret with REDACTED in a rendered page – in text and in attribute
 * values only, so markup and the constant <style>/<script> blocks are never altered (even if a
 * secret happens to be an ordinary word like "button"). Form controls whose value contains a secret
 * are also disabled first (withholdSecretControls), so the masked value is only shown, never posted.
 */
export function redactSecrets(page: string, secrets: readonly string[]): string {
  const forms = renderedFormsOf(secrets);
  if (forms.length === 0 || !forms.some((f) => page.includes(f))) return page;
  const hasSecret = (text: string): boolean => forms.some((f) => text.includes(f));
  const mask = (text: string): string => {
    let out = text;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join(REDACTED);
    return out;
  };
  const withheld = withholdSecretControls(page, hasSecret);
  let out = '';
  let last = 0;
  for (const m of withheld.matchAll(TAG_RE)) {
    out += mask(withheld.slice(last, m.index));
    out += m[1] !== undefined ? m[0] : m[0].replace(/="([^"]*)"/g, (_all: string, value: string) => `="${mask(value)}"`);
    last = m.index + m[0].length;
  }
  return out + mask(withheld.slice(last));
}

// ---------------------------------------------------------------------------------------------
// Login throttle and logout revocation (in memory)
// ---------------------------------------------------------------------------------------------

/** Why an address must wait before it may present a token again (AddressThrottle.check). */
export interface ThrottleWait {
  /** Whole seconds until it may (for Retry-After), at least 1. */
  seconds: number;
  /**
   * 'address': this address sent `perAddress` wrong tokens in the window; 'global': all addresses together sent
   * `global` wrong tokens in it, and this address has not authenticated successfully in the last `successMs`.
   */
  cause: 'address' | 'global';
}

/**
 * Failed token checks per client address (clientAddress) in a sliding window, with a global cap – the guard
 * against token guessing of the /mcp endpoint (src/mcp/http.ts) and of the web login (src/web/ui.ts). An address with `perAddress`
 * failures in the window is refused. Once all addresses together have `global` failures in it, only an
 * address that authenticated successfully in the last `successMs` (default 60 minutes) may still present
 * a token – within its own `perAddress` limit –, every other address is refused until the total falls
 * below the cap: a guess spread over many addresses (or over forged ones) gets at most `global` tries
 * per window, while a client that already works with the right token (e.g. the claude.ai connector)
 * is not locked out by attempts made from other addresses. Memory is bounded (the addresses that failed,
 * or succeeded, longest ago are forgotten first).
 */
export class AddressThrottle {
  private readonly perAddress: number;
  private readonly global: number;
  private readonly windowMs: number;
  private readonly successMs: number;
  private readonly maxAddresses: number;
  /** The last `perAddress` failure times of each address (oldest first; map order: least recently failed first). */
  private readonly failures = new Map<string, number[]>();
  /** The last `global` failure times of all addresses (oldest first). */
  private readonly recent: number[] = [];
  /** The last successful authentication of each address (map order: least recently succeeded first). */
  private readonly successes = new Map<string, number>();

  constructor(opts: { perAddress?: number; global?: number; windowMs?: number; successMs?: number; maxAddresses?: number } = {}) {
    this.perAddress = opts.perAddress ?? 10;
    this.global = opts.global ?? 100;
    this.windowMs = opts.windowMs ?? 60_000;
    this.successMs = opts.successMs ?? 60 * 60_000;
    this.maxAddresses = opts.maxAddresses ?? 10_000;
  }

  /** The failures of `address` still inside the window. */
  private own(address: string, nowMs: number): number[] {
    const list = this.failures.get(address) ?? [];
    while (list.length > 0 && (list[0] ?? 0) <= nowMs - this.windowMs) list.shift();
    if (list.length === 0) this.failures.delete(address);
    return list;
  }

  /** The number of failures (up to `global`) of all addresses still inside the window. */
  private total(nowMs: number): number {
    while (this.recent.length > 0 && (this.recent[0] ?? 0) <= nowMs - this.windowMs) this.recent.shift();
    return this.recent.length;
  }

  /** True when `address` authenticated successfully in the last `successMs`. */
  private succeededRecently(address: string, nowMs: number): boolean {
    const at = this.successes.get(address);
    if (at === undefined) return false;
    if (at > nowMs - this.successMs) return true;
    this.successes.delete(address);
    return false;
  }

  /** null when `address` may present a token now; otherwise how long it must wait, and why. */
  check(address: string, nowMs: number): ThrottleWait | null {
    const own = this.own(address, nowMs);
    const ownUntil = own.length >= this.perAddress ? (own[own.length - this.perAddress] ?? nowMs) + this.windowMs : 0;
    // Past the cap only a recently authenticated address may try; the others are free when the total falls below it.
    const capUntil =
      this.total(nowMs) >= this.global && !this.succeededRecently(address, nowMs)
        ? (this.recent[this.recent.length - this.global] ?? nowMs) + this.windowMs
        : 0;
    const until = Math.max(ownUntil, capUntil);
    if (until <= nowMs) return null;
    return { seconds: Math.ceil((until - nowMs) / 1000), cause: ownUntil >= capUntil ? 'address' : 'global' };
  }

  /** 0 when `address` may try now; otherwise the whole seconds until it may (for Retry-After). */
  retryAfterSeconds(address: string, nowMs: number): number {
    return this.check(address, nowMs)?.seconds ?? 0;
  }

  /** Records a successful authentication of `address` (it may go on presenting its token past the global cap). */
  succeed(address: string, nowMs: number): void {
    this.successes.delete(address);
    this.successes.set(address, nowMs);
    while (this.successes.size > this.maxAddresses) {
      const oldest = this.successes.keys().next().value;
      if (oldest === undefined) break;
      this.successes.delete(oldest);
    }
  }

  fail(address: string, nowMs: number): void {
    const own = this.own(address, nowMs);
    own.push(nowMs);
    while (own.length > this.perAddress) own.shift();
    this.failures.delete(address);
    this.failures.set(address, own);
    while (this.failures.size > this.maxAddresses) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
    this.total(nowMs);
    this.recent.push(nowMs);
    while (this.recent.length > this.global) this.recent.shift();
  }
}

function isLoopbackIp(ip: string): boolean {
  return ip === '::1' || /^(?:::ffff:)?127\./i.test(ip);
}

/** "1.2.3.4", "1.2.3.4:5678", "2001:db8::1" or "[2001:db8::1]:443" → the address, or null. */
function forwardedIp(entry: string): string | null {
  const s = entry.trim();
  const ip = /^\[([^\]]+)\](?::\d+)?$/.exec(s)?.[1] ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s)?.[1] ?? s;
  return isIP(ip) === 0 ? null : ip;
}

/** IPv4-mapped IPv6 as IPv4; other IPv6 addresses by their /64 network (one host usually holds a whole /64). */
function addressKey(ip: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (v4 !== undefined) return v4;
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail] = ip.replace(/%.*$/, '').toLowerCase().split('::');
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const width = (g: readonly string[]): number => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const t = groups(tail ?? '');
  const all = tail === undefined ? h : [...h, ...new Array<string>(Math.max(0, 8 - width(h) - width(t))).fill('0'), ...t];
  return `${all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The address a request's attempts are counted against: the connecting peer. Only with `trustProxy`
 * (OPENSZAMLA_TRUST_PROXY, for a reverse proxy on this machine that sets the header, e.g. Caddy, or nginx
 * with $proxy_add_x_forwarded_for) and only when the peer is this machine, the last X-Forwarded-For entry
 * instead – the one that proxy appended. Without it the header is ignored: any local program, a TCP
 * tunnel (ssh -R, frp, ngrok) or a proxy that passes the client's own header through would otherwise let
 * the client pick a fresh address for every guess.
 */
export function clientAddress(req: IncomingMessage, trustProxy = false): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!trustProxy || !isLoopbackIp(peer)) return addressKey(peer);
  const header = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',');
  return addressKey(forwardedIp(entries[entries.length - 1] ?? '') ?? peer);
}

/**
 * One-time ids of forms that must not take effect twice (a double click or a re-sent POST would
 * otherwise record the same payment twice). In memory, bounded; an id is kept for a session's lifetime.
 */
export class OnceIds {
  private readonly used = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlMs = SESSION_TTL_SECONDS * 1000, max = 10_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  /** A fresh id to put into a form. */
  static mint(): string {
    return randomBytes(16).toString('base64url');
  }

  static isWellFormed(id: string | null | undefined): id is string {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);
  }

  /** Marks the id used; false when it has already been used. */
  claim(key: string, nowMs: number): boolean {
    const exp = this.used.get(key);
    if (exp !== undefined && exp > nowMs) return false;
    this.used.delete(key);
    this.used.set(key, nowMs + this.ttlMs);
    while (this.used.size > this.max) {
      const oldest = this.used.keys().next().value;
      if (oldest === undefined) break;
      this.used.delete(oldest);
    }
    return true;
  }

  /** Makes the id usable again (the action failed, nothing was recorded). */
  release(key: string): void {
    this.used.delete(key);
  }
}

/** Sessions ended with "Kilépés" (kept until they would expire anyway). */
export class RevokedSessions {
  private readonly ids = new Map<string, number>();

  revoke(session: Session): void {
    this.ids.set(session.id, session.expiresAt);
    if (this.ids.size > 10_000) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  has(id: string, nowMs: number): boolean {
    const exp = this.ids.get(id);
    if (exp === undefined) return false;
    if (exp <= nowMs) {
      this.ids.delete(id);
      return false;
    }
    return true;
  }
}
