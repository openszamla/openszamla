/** Request context, per-process web state (flash messages) and response helpers for the pages. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAppError } from '../core/errors.ts';
import type { OpenSzamla } from '../service/app.ts';
import { webErrorHint, webFieldMessage } from './hints.ts';
import { html, type SafeHtml } from './html.ts';
import { HttpError, sendHtml, sendRedirect } from './io.ts';
import { documentHtml, flashHtml, type Flash, type NavKey } from './layout.ts';
import { containsSecret, redactSecrets, type AddressThrottle, type OnceIds, type RevokedSessions, type Session, type WebKeys } from './security.ts';

export interface WebState {
  readonly app: OpenSzamla;
  readonly keys: WebKeys;
  readonly revoked: RevokedSessions;
  /** Wrong login tokens per client address (with a global cap). */
  readonly throttle: AddressThrottle;
  /** The client address comes from X-Forwarded-For of a loopback connection (OPENSZAMLA_TRUST_PROXY). */
  readonly trustProxy: boolean;
  /** Pending flash messages per session id (in memory; lost on restart, which is fine). */
  readonly flashes: Map<string, Flash[]>;
  /** Used one-time form ids (double-submit guard). */
  readonly once: OnceIds;
  /**
   * Values that must never appear on a page: the access token and the NAV credentials. Only used to
   * mask them in the final HTML (sendPage) – nothing reads them for display.
   */
  readonly secrets: readonly string[];
}

/** The only way HTML leaves the web UI: secrets are masked, then the page is sent with the security headers. */
export function sendPage(st: WebState, res: ServerResponse, status: number, body: string, nonce: string, extra: Record<string, string | string[]> = {}): void {
  sendHtml(res, status, redactSecrets(body, st.secrets), nonce, extra);
}

/** Everything a route handler needs. Only authenticated requests reach the handlers. */
export interface Ctx {
  readonly st: WebState;
  readonly app: OpenSzamla;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Per-response CSP nonce for the inline <style>/<script> blocks. */
  readonly nonce: string;
  readonly now: number;
  readonly session: Session;
  readonly csrf: string;
  /** Parsed POST body (empty for GET). */
  readonly form: URLSearchParams;
}

const MAX_FLASH_SESSIONS = 1000;
const MAX_FLASHES_PER_SESSION = 10;

export function pushFlash(st: WebState, sessionId: string, flash: Flash): void {
  const list = st.flashes.get(sessionId) ?? [];
  list.push(flash);
  while (list.length > MAX_FLASHES_PER_SESSION) list.shift();
  st.flashes.delete(sessionId);
  st.flashes.set(sessionId, list);
  while (st.flashes.size > MAX_FLASH_SESSIONS) {
    const oldest = st.flashes.keys().next().value;
    if (oldest === undefined) break;
    st.flashes.delete(oldest);
  }
}

export function takeFlashes(st: WebState, sessionId: string): Flash[] {
  const list = st.flashes.get(sessionId) ?? [];
  st.flashes.delete(sessionId);
  return list;
}

// ---------------------------------------------------------------------------------------------
// Form fields the page cannot show: sendPage renders a control whose value contains a secret masked
// and disabled, so the browser leaves that field out of the submit. Masking must never feed back into
// stored data – these two keep it that way.
// ---------------------------------------------------------------------------------------------

/**
 * An edit form takes the fields the page could not show back from the stored record: saving the form
 * never changes or clears such a field. `stored`: the values (by field name) the form is rendered from.
 */
export function withWithheldFields(ctx: Ctx, stored: Readonly<Record<string, string>>): Ctx {
  let form: URLSearchParams | null = null;
  for (const [name, value] of Object.entries(stored)) {
    if (ctx.form.has(name) || !containsSecret(value, ctx.st.secrets)) continue;
    form ??= new URLSearchParams(ctx.form);
    form.set(name, value);
  }
  return form === null ? ctx : { ...ctx, form };
}

const NOT_REDISPLAYED: Flash = {
  tone: 'warn',
  title: 'Egy beírt érték a hozzáférési tokent vagy egy NAV-hitelesítő adatot tartalmaz, ezért az űrlapon nem jeleníthető meg újra.',
  hint: 'Az érintett mező a tárolt értékét mutatja (új adatnál üres). Ha ezt az értéket szeretnéd menteni, írd be újra.',
};

/**
 * The submitted form to show again after a failed save. A typed value containing a secret could only be
 * shown masked and withheld – and would then be lost on the next save –, so the field shows its stored
 * value instead (`stored`; a new record: empty), and the page says so.
 */
export function forRedisplay(ctx: Ctx, stored: Readonly<Record<string, string>> = {}): URLSearchParams {
  let replaced = false;
  const out = new URLSearchParams();
  for (const [name, value] of ctx.form) {
    const kept = Object.hasOwn(stored, name) ? (stored[name] ?? '') : '';
    const drop = value !== kept && containsSecret(value, ctx.st.secrets);
    replaced ||= drop;
    out.append(name, drop ? kept : value);
  }
  if (!replaced) return ctx.form;
  pushFlash(ctx.st, ctx.session.id, NOT_REDISPLAYED);
  return out;
}

export interface PageOptions {
  title: string;
  active?: NavKey | null;
  main: SafeHtml;
  status?: number;
  /** Shown in addition to the pending flash messages of the session. */
  flashes?: Flash[];
  /** Inline script (a constant of the page module). */
  script?: string;
}

export function renderPage(ctx: Ctx, o: PageOptions): void {
  const flashes = [...takeFlashes(ctx.st, ctx.session.id), ...(o.flashes ?? [])];
  const doc = documentHtml({
    nonce: ctx.nonce,
    title: o.title,
    csrf: ctx.csrf,
    active: o.active ?? null,
    flashes,
    main: o.main,
    ...(o.script === undefined ? {} : { script: o.script }),
  });
  sendPage(ctx.st, ctx.res, o.status ?? 200, doc.html, ctx.nonce);
}

/** POST → redirect → GET, with an optional message for the next page. `location` must be a local path. */
export function redirect(ctx: Ctx, location: string, flash?: Flash): void {
  if (flash) pushFlash(ctx.st, ctx.session.id, flash);
  sendRedirect(ctx.res, location);
}

export function isNotFound(e: unknown): boolean {
  return isAppError(e) && e.code === 'NOT_FOUND';
}

/** Logs unexpected (non-AppError) failures to stderr – method and path only, never the query or body. */
export function logUnexpected(method: string, path: string, e: unknown): void {
  if (isAppError(e) || e instanceof HttpError) return;
  const detail = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
  process.stderr.write(`[openszamla web] ${method} ${path}: ${detail}\n`);
}

const UNEXPECTED: Flash = {
  tone: 'err',
  title: 'Váratlan hiba történt, a művelet nem sikerült.',
  hint: 'A részleteket a szerver naplója tartalmazza. Próbáld újra később, vagy jelezd a hibát.',
};

/** Friendly Hungarian message for any failure; raw exception texts are never shown. */
export function errorFlash(e: unknown): Flash {
  // A hint written for MCP / CLI callers is replaced by one that can be followed in the web UI.
  const web = isAppError(e) ? webErrorHint(e.code) : undefined;
  // …and an API field name quoted in the message by the label of the form field.
  const title = isAppError(e) ? webFieldMessage(e.message) : '';
  if (isAppError(e) && web) return { tone: 'err', title, ...web };
  if (isAppError(e)) return e.hint ? { tone: 'err', title, hint: e.hint } : { tone: 'err', title };
  if (e instanceof HttpError) return e.hint ? { tone: 'err', title: e.message, hint: e.hint } : { tone: 'err', title: e.message };
  return UNEXPECTED;
}

/** errorFlash + logging of unexpected errors. */
export function failure(ctx: Ctx, e: unknown): Flash {
  logUnexpected(ctx.method, ctx.path, e);
  return errorFlash(e);
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs a read for one section of a page, so that one failing part does not break the whole page. */
export function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Inline notice for a section that could not be loaded. */
export function sectionError(ctx: Ctx, e: unknown): SafeHtml {
  logUnexpected(ctx.method, ctx.path, e);
  if (!isAppError(e) && !(e instanceof HttpError)) {
    return flashHtml({ tone: 'warn', title: 'Ez a rész most nem jeleníthető meg: váratlan hiba történt.', hint: 'A részleteket a szerver naplója tartalmazza.' });
  }
  const f = errorFlash(e);
  return flashHtml({ tone: 'warn', title: `Ez a rész most nem jeleníthető meg: ${f.title}`, ...(f.hint ? { hint: f.hint } : {}), ...(f.link ? { link: f.link } : {}) });
}

/** A single-line paragraph used for empty lists. */
export function emptyNote(text: string): SafeHtml {
  return html`<p class="empty">${text}</p>`;
}

/** Full-page error (404 for unknown records, 4xx/5xx otherwise) with a way back. */
export function errorPage(ctx: Ctx, status: number, flash: Flash, back: { href: string; label: string } = { href: '/', label: 'Vissza az áttekintéshez' }): void {
  renderPage(ctx, {
    title: status === 404 ? 'Nem található' : 'Hiba',
    status,
    flashes: [flash],
    main: html`<h1>${status === 404 ? 'Nem található' : 'A művelet nem sikerült'}</h1><p><a class="btn" href="${back.href}">${back.label}</a></p>`,
  });
}

export function notFoundPage(ctx: Ctx, what: string, back?: { href: string; label: string }): void {
  errorPage(ctx, 404, { tone: 'err', title: what, hint: 'Ellenőrizd a címet, vagy keresd meg a listában.' }, back);
}
