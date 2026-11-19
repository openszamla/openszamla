/**
 * Test helpers for the web UI: a real HTTP server (startHttpServer, port 0) on an isolated app, a
 * tiny cookie-keeping "browser" built on node:http (full control over Origin/Sec-Fetch-Site/Host and
 * no automatic redirects), and fixture insertion straight through the store (no calc dependency).
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import type { Customer, Invoice } from '../../src/core/types.ts';
import { startHttpServer, type RunningHttpServer } from '../../src/mcp/http.ts';
import { invoiceContentHash, type OpenSzamla } from '../../src/service/app.ts';
import type { AppConfig } from '../../src/service/config.ts';
import { makeTestApp, type TestApp } from '../helpers/app.ts';

export const TOKEN = 'web-test-token-Zx81-4f9a2c7e5b1d3a6f8e0c';

export interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  buf: Buffer;
}

export function rawRequest(base: string, method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf.toString('utf8'), buf });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function setCookies(res: Res): string[] {
  const h = res.headers['set-cookie'];
  return h === undefined ? [] : h;
}

export function csrfOf(body: string): string | null {
  return /name="_csrf" value="([^"]+)"/.exec(body)?.[1] ?? null;
}

export function hiddenValue(body: string, name: string): string | null {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1] ?? null;
}

/** Form fields; arrays repeat the key. */
export type Fields = Record<string, string | string[]>;

export function encodeForm(fields: Fields): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
}

/** Cookie-keeping client that behaves like a same-origin browser page by default. */
export class Browser {
  readonly base: string;
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(base: string) {
    this.base = base;
  }

  private absorb(res: Res): Res {
    for (const c of setCookies(res)) {
      const m = /^openszamla_session=([^;]*)/.exec(c);
      if (!m) continue;
      this.cookie = m[1] && !/Max-Age=0/i.test(c) ? `openszamla_session=${m[1]}` : null;
    }
    const token = csrfOf(res.body);
    if (token) this.csrf = token;
    return res;
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    return this.absorb(await rawRequest(this.base, 'GET', path, { headers: h }));
  }

  /** POST a form. The CSRF token of the last page is added unless `csrf` is given (null = none); a header given as '' is omitted. */
  async post(path: string, fields: Fields, opts: { csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
    const f: Fields = { ...fields };
    const token = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (token !== null && f._csrf === undefined) f._csrf = token;
    const body = encodeForm(f);
    const h: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
      origin: this.base,
      'sec-fetch-site': 'same-origin',
      ...(opts.headers ?? {}),
    };
    if (this.cookie) h.cookie = this.cookie;
    for (const [k, v] of Object.entries(h)) if (v === '') delete h[k];
    return this.absorb(await rawRequest(this.base, 'POST', path, { headers: h, body }));
  }

  /** GET the Location of a redirect response. */
  async follow(res: Res): Promise<Res> {
    const loc = res.headers.location;
    if (res.status !== 303 && res.status !== 302) throw new Error(`not a redirect: ${res.status}\n${res.body.slice(0, 2000)}`);
    if (!loc) throw new Error('redirect without Location');
    return this.get(loc);
  }

  async login(): Promise<void> {
    const r = await this.get(`/?token=${encodeURIComponent(TOKEN)}`);
    if (r.status !== 303 || !this.cookie) throw new Error(`login failed: ${r.status}`);
    await this.get('/');
  }
}

export interface WebEnv {
  t: TestApp;
  app: OpenSzamla;
  http: RunningHttpServer;
  base: string;
  browser(): Browser;
  loggedIn(): Promise<Browser>;
  close(): Promise<void>;
}

export async function startWeb(opts: { nav?: AppConfig['nav']; now?: () => Date } = {}): Promise<WebEnv> {
  const t = makeTestApp({ ...(opts.nav ? { nav: opts.nav } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const http = await startHttpServer(t.app, { port: 0, token: TOKEN });
  const base = http.url;
  return {
    t,
    app: t.app,
    http,
    base,
    browser: () => new Browser(base),
    async loggedIn() {
      const b = new Browser(base);
      await b.login();
      return b;
    },
    async close() {
      await http.close();
      t.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixtures through the store (no dependency on calc/validate)
// ---------------------------------------------------------------------------------------------

function defaultSeriesId(app: OpenSzamla, kind: 'invoice' | 'proforma' = 'invoice'): string {
  const s = app.listSeries(kind).find((x) => x.isDefault);
  if (!s) throw new Error('no default series');
  return s.id;
}

/** Inserts a fixture as an ISSUED invoice (insertDraft + markIssued). */
export function insertIssued(app: OpenSzamla, fixture: Invoice, overrides: Partial<Invoice> = {}): Invoice {
  const full: Invoice = { ...fixture, seriesId: defaultSeriesId(app, fixture.documentType === 'proforma' ? 'proforma' : 'invoice'), ...overrides, status: 'issued' };
  app.store.insertDraft({ ...full, status: 'draft', number: null, issuedAt: null, contentHash: null, navStatus: 'not_applicable', navMessages: [], navTransactionId: null, cancelledById: null });
  const issued: Invoice = { ...full, cancelledById: null, contentHash: invoiceContentHash(full) };
  app.store.markIssued(issued);
  const stored = app.store.getInvoice(full.id);
  if (!stored) throw new Error('insert failed');
  return stored;
}

/** Inserts a fixture as a DRAFT. */
export function insertDraft(app: OpenSzamla, fixture: Invoice, overrides: Partial<Invoice> = {}): Invoice {
  const draft: Invoice = {
    ...fixture,
    seriesId: defaultSeriesId(app, fixture.documentType === 'proforma' ? 'proforma' : 'invoice'),
    ...overrides,
    status: 'draft',
    number: null,
    issuedAt: null,
    contentHash: null,
    navStatus: 'not_applicable',
    navMessages: [],
    navTransactionId: null,
    cancelledById: null,
    paymentStatus: 'unpaid',
    paidAmount: '0',
    paidDate: null,
  };
  app.store.insertDraft(draft);
  return draft;
}

export function insertCustomer(app: OpenSzamla, c: Omit<Customer, 'id' | 'archived' | 'createdAt' | 'updatedAt'> & { id: string }): Customer {
  const full: Customer = { archived: false, createdAt: '2026-10-27T08:00:00.000Z', updatedAt: '2026-10-27T08:00:00.000Z', ...c };
  app.store.insertCustomer(full);
  return full;
}

/** Every `<script` tag carries the response's CSP nonce. */
export function scriptsHaveNonce(res: Res): boolean {
  const csp = String(res.headers['content-security-policy'] ?? '');
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  if (!nonce) return false;
  const tags = res.body.match(/<script\b[^>]*>/gi) ?? [];
  return tags.every((t) => t.includes(`nonce="${nonce}"`));
}

/** The flash / error message titles of a page (for readable assertion messages). */
export function flashesOf(body: string): string {
  return [...body.matchAll(/<p class="flash-title">([\s\S]*?)<\/p>/g)].map((m) => m[1]).join(' | ') || '(no message)';
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };

function unescapeHtml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (e) => ENTITIES[e] ?? e);
}

function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/g)) {
    if (m[1] !== undefined && !out.has(m[1])) out.set(m[1], unescapeHtml(m[2] ?? ''));
  }
  return out;
}

/**
 * The fields a browser would submit for the form whose action is `action` (submit buttons excluded,
 * <template> content ignored, unchecked checkboxes and disabled controls left out, the selected – or
 * first enabled – option of a select, nothing when that option is disabled).
 */
export function formFields(body: string, action: string): Fields {
  const start = body.indexOf(`action="${action}"`);
  if (start < 0) throw new Error(`no form with action ${action}`);
  const end = body.indexOf('</form>', start);
  const inner = body.slice(start, end).replace(/<template\b[\s\S]*?<\/template>/g, '');
  const fields: Fields = {};
  const add = (name: string, value: string): void => {
    const prev = fields[name];
    fields[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  };
  const re = /<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g;
  for (const m of inner.matchAll(re)) {
    if (m[1] !== undefined) {
      const a = attributesOf(m[1]);
      const name = a.get('name');
      const type = a.get('type') ?? 'text';
      if (!name || type === 'submit' || type === 'button' || a.has('disabled')) continue;
      if ((type === 'checkbox' || type === 'radio') && !a.has('checked')) continue;
      add(name, a.get('value') ?? (type === 'checkbox' ? 'on' : ''));
    } else if (m[2] !== undefined) {
      const select = attributesOf(m[2]);
      const name = select.get('name');
      if (!name || select.has('disabled')) continue;
      const options = [...(m[3] ?? '').matchAll(/<option\b([^>]*)>/g)].map((o) => attributesOf(o[1] ?? ''));
      const chosen = options.find((o) => o.has('selected')) ?? options.find((o) => !o.has('disabled'));
      if (chosen?.has('disabled')) continue;
      add(name, chosen?.get('value') ?? '');
    } else {
      const textarea = attributesOf(m[4] ?? '');
      const name = textarea.get('name');
      if (name && !textarea.has('disabled')) add(name, unescapeHtml(m[5] ?? ''));
    }
  }
  return fields;
}
