/**
 * Minimal web UI served next to the MCP endpoint in HTTP mode.
 * CONTRACT FILE – keep the exported signature (the HTTP server calls it for every non-/mcp request).
 *
 * Every page needs the access token: "/<any page>?token=…" (the link printed by `openszamla serve`,
 * accepted only as a top-level navigation) or the login form starts a session – an HttpOnly,
 * SameSite=Strict cookie holding an HMAC-signed random session id (never the token) – and the token is
 * stripped from the address by a redirect.
 * Every POST needs the per-session CSRF token AND must come from our own origin (Sec-Fetch-Site /
 * Origin / Referer); bodies are urlencoded forms of at most 256 kB. Pages carry a strict CSP with a
 * per-response nonce, every interpolated value is escaped (./html.ts), and every page passes through
 * sendPage, which masks the access token and the NAV credentials should one ever reach the output.
 * Each user action calls exactly one service method; business rules stay in src/service.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAppError } from '../core/errors.ts';
import type { OpenSzamla } from '../service/app.ts';
import { csrfInput } from './components.ts';
import { errorFlash, errorPage, logUnexpected, notFoundPage, renderPage, sendPage, takeFlashes, type Ctx, type WebState } from './context.ts';
import { html } from './html.ts';
import { clearSessionCookieHeader, HttpError, parseCookies, plainHeaders, readForm, sendRedirect, sessionCookieHeader } from './io.ts';
import type { Flash } from './layout.ts';
import { customerDetailPage, customerListPage, createCustomer, updateCustomer } from './pages/customers.ts';
import { dashboardPage, navSyncAll } from './pages/dashboard.ts';
import { exportPage, runExport, runTaxAuditExport } from './pages/export.ts';
import { INVOICE_ACTIONS, invoiceAction, invoiceDetailPage, invoicePdf, type InvoiceAction } from './pages/invoice.ts';
import { createInvoice, editInvoicePage, newInvoicePage, updateInvoice } from './pages/invoice-form.ts';
import { invoiceListPage } from './pages/invoices.ts';
import { bareMessagePage, loginPage } from './pages/login.ts';
import { createProduct, productDetailPage, productListPage, updateProduct } from './pages/products.ts';
import { makeBackup, saveDefaults, saveSeller, settingsPage, verifyDatabase } from './pages/settings.ts';
import {
  csrfTokenFor,
  deriveKeys,
  isSameOriginRequest,
  isSecureRequest,
  isTopLevelNavigation,
  AddressThrottle,
  clientAddress,
  mintSession,
  type ThrottleWait,
  OnceIds,
  RevokedSessions,
  secretList,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  tokenMatches,
  verifyCsrf,
  verifySession,
  type Session,
} from './security.ts';

export type WebHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

type Method = 'GET' | 'POST';

interface Route {
  method: Method;
  re: RegExp;
  run: (ctx: Ctx, params: readonly string[]) => void | Promise<void>;
}

const INV = 'inv_[0-9a-f]{1,32}';
const CUS = 'cus_[0-9a-f]{1,32}';
const PRD = 'prd_[0-9a-f]{1,32}';
const at = (p: readonly string[], i: number): string => p[i] ?? '';

const ROUTES: readonly Route[] = [
  { method: 'GET', re: /^\/$/, run: (c) => dashboardPage(c) },
  { method: 'POST', re: /^\/nav-sync$/, run: (c) => navSyncAll(c) },
  { method: 'GET', re: /^\/invoices$/, run: (c) => invoiceListPage(c) },
  { method: 'GET', re: /^\/invoices\/new$/, run: (c) => newInvoicePage(c) },
  { method: 'POST', re: /^\/invoices\/new$/, run: (c) => createInvoice(c) },
  { method: 'GET', re: new RegExp(`^/invoices/(${INV})\\.pdf$`), run: (c, p) => invoicePdf(c, at(p, 0)) },
  { method: 'GET', re: new RegExp(`^/invoices/(${INV})$`), run: (c, p) => invoiceDetailPage(c, at(p, 0)) },
  { method: 'GET', re: new RegExp(`^/invoices/(${INV})/edit$`), run: (c, p) => editInvoicePage(c, at(p, 0)) },
  { method: 'POST', re: new RegExp(`^/invoices/(${INV})/edit$`), run: (c, p) => updateInvoice(c, at(p, 0)) },
  {
    method: 'POST',
    re: new RegExp(`^/invoices/(${INV})/(${INVOICE_ACTIONS.join('|')})$`),
    run: (c, p) => invoiceAction(c, at(p, 0), at(p, 1) as InvoiceAction),
  },
  { method: 'GET', re: /^\/customers$/, run: (c) => customerListPage(c) },
  { method: 'POST', re: /^\/customers$/, run: (c) => createCustomer(c) },
  { method: 'GET', re: new RegExp(`^/customers/(${CUS})$`), run: (c, p) => customerDetailPage(c, at(p, 0)) },
  { method: 'POST', re: new RegExp(`^/customers/(${CUS})$`), run: (c, p) => updateCustomer(c, at(p, 0)) },
  { method: 'GET', re: /^\/products$/, run: (c) => productListPage(c) },
  { method: 'POST', re: /^\/products$/, run: (c) => createProduct(c) },
  { method: 'GET', re: new RegExp(`^/products/(${PRD})$`), run: (c, p) => productDetailPage(c, at(p, 0)) },
  { method: 'POST', re: new RegExp(`^/products/(${PRD})$`), run: (c, p) => updateProduct(c, at(p, 0)) },
  { method: 'GET', re: /^\/settings$/, run: (c) => settingsPage(c) },
  { method: 'POST', re: /^\/settings\/seller$/, run: (c) => saveSeller(c) },
  { method: 'POST', re: /^\/settings\/defaults$/, run: (c) => saveDefaults(c) },
  { method: 'POST', re: /^\/settings\/backup$/, run: (c) => makeBackup(c) },
  { method: 'POST', re: /^\/settings\/verify$/, run: (c) => verifyDatabase(c) },
  { method: 'GET', re: /^\/export$/, run: (c) => exportPage(c) },
  { method: 'POST', re: /^\/export$/, run: (c) => runExport(c) },
  { method: 'POST', re: /^\/export\/tax-audit$/, run: (c) => runTaxAuditExport(c) },
  { method: 'GET', re: /^\/logout$/, run: (c) => logoutPage(c) },
  { method: 'POST', re: /^\/logout$/, run: (c) => logout(c) },
];

type Match = { kind: 'route'; route: Route; params: string[] } | { kind: 'method'; allow: Method[] } | { kind: 'none' };

function findRoute(method: Method, path: string): Match {
  const allow = new Set<Method>();
  for (const route of ROUTES) {
    const m = route.re.exec(path);
    if (!m) continue;
    if (route.method === method) return { kind: 'route', route, params: m.slice(1).map((g) => g ?? '') };
    allow.add(route.method);
  }
  return allow.size > 0 ? { kind: 'method', allow: [...allow] } : { kind: 'none' };
}

const PREFIXES = ['/invoices', '/customers', '/products', '/settings', '/export', '/login', '/logout', '/nav-sync'];

/** Paths the web UI owns; everything else is left to the HTTP server (404). */
function isWebPath(path: string): boolean {
  return path === '/' || PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

/** A local path to continue to after login (never another site, never the token, never login/logout). */
function safeNext(value: string | null | undefined): string {
  if (!value || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const u = new URL(value, 'http://localhost');
    if (u.origin !== 'http://localhost') return '/';
    u.searchParams.delete('token');
    const path = normalizePath(u.pathname);
    if (!isWebPath(path) || path === '/login' || path === '/logout') return '/';
    return `${path}${u.search}`;
  } catch {
    return '/';
  }
}

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

const INVALID_TOKEN: Flash = { tone: 'err', title: 'A hozzáférési kulcs érvénytelen.', hint: 'Másold be pontosan az indításkor kiírt kulcsot, vagy használd a kiírt teljes belépési címet.' };
/** Too many wrong tokens – from this address, or (past the global cap) from everywhere: when to try again. */
function tooMany(wait: ThrottleWait): Flash {
  return {
    tone: 'err',
    title: wait.cause === 'address' ? 'Túl sok sikertelen belépési kísérlet erről a gépről.' : 'Túl sok sikertelen belépési kísérlet érkezett a szerverre.',
    hint: `Próbáld újra ${wait.seconds} másodperc múlva. A helyes belépési címet a szerver az indításakor írja ki.`,
  };
}
const NOT_A_NAVIGATION: Flash = {
  tone: 'err',
  title: 'A belépési cím csak közvetlenül, a böngésző címsorából nyitható meg.',
  hint: 'Képként, keretben vagy szkriptből betöltött belépési kérést nem fogadunk el.',
};
const EXPIRED: Flash = { tone: 'warn', title: 'A munkamenet lejárt vagy érvénytelen. Lépj be újra, majd ismételd meg a műveletet.' };

function currentSession(st: WebState, req: IncomingMessage, now: number): Session | null {
  for (const value of parseCookies(req.headers.cookie).get(SESSION_COOKIE) ?? []) {
    const session = verifySession(st.keys, value, now);
    if (session && !st.revoked.has(session.id, now)) return session;
  }
  return null;
}

function startSession(st: WebState, res: ServerResponse, location: string, now: number, secure: boolean): void {
  const { cookieValue } = mintSession(st.keys, now);
  sendRedirect(res, location, { 'set-cookie': sessionCookieHeader(cookieValue, SESSION_TTL_SECONDS, secure) });
}

/**
 * "/path?token=…": constant-time check, session cookie, redirect to the same address without the token.
 * Only for top-level navigations: a token URL planted as <img>/<iframe>/fetch on another site is refused
 * without looking at the token and without counting as a failed attempt.
 */
function tokenLogin(st: WebState, req: IncomingMessage, res: ServerResponse, url: URL, path: string, nonce: string, now: number, secure: boolean): void {
  const rest = new URLSearchParams(url.search);
  rest.delete('token');
  const query = rest.toString();
  const location = safeNext(`${path}${query ? `?${query}` : ''}`);
  if (!isTopLevelNavigation(req)) {
    sendPage(st, res, 403, bareMessagePage({ nonce, title: 'Belépés', flash: NOT_A_NAVIGATION }), nonce);
    return;
  }
  const client = clientAddress(req, st.trustProxy);
  const wait = st.throttle.check(client, now);
  if (wait) {
    sendPage(st, res, 429, loginPage({ nonce, next: location, flash: tooMany(wait) }), nonce, { 'retry-after': String(wait.seconds) });
    return;
  }
  if (!tokenMatches(st.keys, url.searchParams.get('token') ?? '')) {
    st.throttle.fail(client, now);
    sendPage(st, res, 401, loginPage({ nonce, next: location, flash: INVALID_TOKEN }), nonce);
    return;
  }
  st.throttle.succeed(client, now);
  startSession(st, res, location, now, secure);
}

async function loginPost(st: WebState, req: IncomingMessage, res: ServerResponse, nonce: string, now: number, secure: boolean): Promise<void> {
  if (!isSameOriginRequest(req)) {
    req.resume();
    sendPage(st, res, 403, loginPage({ nonce, next: '/', flash: { tone: 'err', title: 'A belépési kérés nem erről az oldalról érkezett, ezért elutasítottuk.' } }), nonce);
    return;
  }
  let form: URLSearchParams;
  try {
    form = await readForm(req, 8 * 1024);
  } catch (e) {
    res.setHeader('connection', 'close');
    sendPage(st, res, e instanceof HttpError ? e.status : 400, loginPage({ nonce, next: '/', flash: errorFlash(e) }), nonce);
    return;
  }
  const next = safeNext(form.get('next'));
  const client = clientAddress(req, st.trustProxy);
  const wait = st.throttle.check(client, now);
  if (wait) {
    sendPage(st, res, 429, loginPage({ nonce, next, flash: tooMany(wait) }), nonce, { 'retry-after': String(wait.seconds) });
    return;
  }
  if (!tokenMatches(st.keys, form.get('token') ?? '')) {
    st.throttle.fail(client, now);
    sendPage(st, res, 401, loginPage({ nonce, next, flash: INVALID_TOKEN }), nonce);
    return;
  }
  st.throttle.succeed(client, now);
  startSession(st, res, next, now, secure);
}

function logoutPage(ctx: Ctx): void {
  renderPage(ctx, {
    title: 'Kilépés',
    main: html`<h1>Kilépés</h1><form method="post" action="/logout">${csrfInput(ctx)}<p>Biztosan kilépsz a webes felületről?</p><div class="actions"><button class="btn btn-primary" type="submit">Kilépés</button><a class="btn btn-quiet" href="/">Mégsem</a></div></form>`,
  });
}

function logout(ctx: Ctx): void {
  ctx.st.revoked.revoke(ctx.session);
  takeFlashes(ctx.st, ctx.session.id);
  sendRedirect(ctx.res, '/login?out=1', { 'set-cookie': clearSessionCookieHeader(isSecureRequest(ctx.req)) });
}

// ---------------------------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------------------------

function statusOf(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (isAppError(e)) return e.code === 'NOT_FOUND' ? 404 : 400;
  return 500;
}

async function handle(st: WebState, req: IncomingMessage, res: ServerResponse, url: URL, path: string, nonce: string): Promise<void> {
  const now = Date.now();
  const secure = isSecureRequest(req);
  const rawMethod = (req.method ?? 'GET').toUpperCase();
  if (rawMethod !== 'GET' && rawMethod !== 'HEAD' && rawMethod !== 'POST') {
    req.resume();
    res.writeHead(405, { ...plainHeaders(), allow: 'GET, HEAD, POST', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Nem támogatott HTTP-metódus.');
    return;
  }
  const method: Method = rawMethod === 'POST' ? 'POST' : 'GET';

  if (method === 'GET' && url.searchParams.has('token')) return tokenLogin(st, req, res, url, path, nonce, now, secure);

  if (path === '/login') {
    if (method === 'POST') return loginPost(st, req, res, nonce, now, secure);
    const next = safeNext(url.searchParams.get('next'));
    if (currentSession(st, req, now)) return sendRedirect(res, next);
    const flash: Flash | undefined = url.searchParams.get('out') === '1' ? { tone: 'ok', title: 'Kiléptél.' } : undefined;
    sendPage(st, res, 200, loginPage({ nonce, next, ...(flash ? { flash } : {}) }), nonce);
    return;
  }

  const session = currentSession(st, req, now);
  if (!session) {
    if (method === 'GET') {
      sendPage(st, res, 401, loginPage({ nonce, next: safeNext(`${path}${url.search}`) }), nonce);
    } else {
      req.resume();
      sendPage(st, res, 401, loginPage({ nonce, next: '/', flash: EXPIRED }), nonce);
    }
    return;
  }

  const ctxBase = { st, app: st.app, req, res, url, method, path, nonce, now, session, csrf: csrfTokenFor(st.keys, session.id) };
  const ctx: Ctx = { ...ctxBase, form: new URLSearchParams() };
  const match = findRoute(method, path);
  if (match.kind !== 'route') {
    req.resume();
    if (match.kind === 'none') return notFoundPage(ctx, 'Az oldal nem található.');
    res.setHeader('allow', match.allow.join(', ').replace('GET', 'GET, HEAD'));
    return errorPage(ctx, 405, { tone: 'err', title: 'Ez a cím ezzel a módszerrel nem használható.' });
  }

  let form = ctx.form;
  if (method === 'POST') {
    if (!isSameOriginRequest(req)) {
      req.resume();
      return errorPage(ctx, 403, { tone: 'err', title: 'A kérés nem erről az oldalról érkezett, ezért elutasítottuk.', hint: 'Más weboldalról nem lehet műveletet indítani ezen a felületen.' });
    }
    try {
      form = await readForm(req);
    } catch (e) {
      res.setHeader('connection', 'close');
      return errorPage(ctx, statusOf(e), errorFlash(e));
    }
    if (!verifyCsrf(st.keys, session.id, form.get('_csrf'))) {
      return errorPage(ctx, 403, { tone: 'err', title: 'Hiányzó vagy érvénytelen biztonsági token (CSRF), a műveletet nem hajtottuk végre.', hint: 'Töltsd újra az oldalt, és próbáld meg ismét.' });
    }
  }

  const routeCtx: Ctx = { ...ctxBase, form };
  try {
    await match.route.run(routeCtx, match.params);
  } catch (e) {
    logUnexpected(method, path, e);
    if (res.headersSent) {
      res.end();
      return;
    }
    errorPage(routeCtx, statusOf(e), errorFlash(e));
  }
}

/** Returns a request handler; it resolves true when it handled the request, false to let others 404. */
export function createWebHandler(app: OpenSzamla, opts: { token: string; trustProxy?: boolean }): WebHandler {
  // NAV credentials saved by nav-setup while the server runs reach app.config at once: the mask follows them (and
  // keeps masking the earlier ones).
  const known = new Set<string>([opts.token]);
  let maskedFor: unknown = null;
  let secrets: readonly string[] = secretList([...known]);
  const st: WebState = {
    app,
    keys: deriveKeys(opts.token),
    revoked: new RevokedSessions(),
    throttle: new AddressThrottle(),
    trustProxy: opts.trustProxy === true,
    flashes: new Map(),
    once: new OnceIds(),
    // Masked in every rendered page (sendPage); never read for display.
    get secrets(): readonly string[] {
      const nav = app.config.nav?.credentials;
      if (nav && nav !== maskedFor) {
        maskedFor = nav;
        for (const v of [nav.login, nav.password, nav.signingKey, nav.exchangeKey]) known.add(v);
        secrets = secretList([...known]);
      }
      return secrets;
    },
  };
  return async (req, res, url) => {
    const path = normalizePath(url.pathname);
    if (!isWebPath(path)) return false;
    const nonce = randomBytes(16).toString('base64');
    try {
      await handle(st, req, res, url, path, nonce);
    } catch (e) {
      logUnexpected(req.method ?? 'GET', path, e);
      if (!res.headersSent) sendPage(st, res, statusOf(e), bareMessagePage({ nonce, title: 'Hiba', flash: errorFlash(e), link: { href: '/', label: 'Vissza' } }), nonce);
      else res.end();
    }
    return true;
  };
}
