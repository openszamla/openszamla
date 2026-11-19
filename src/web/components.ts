/** Reusable markup pieces: badges, amounts, form fields, pagination, invoice tables. */
import { formatDate, formatMoney, formatQuantity } from '../core/format.ts';
import type { Invoice, NavStatus } from '../core/types.ts';
import { getVatInfo, listVatCodes } from '../core/vat.ts';
import { attempt, type Ctx } from './context.ts';
import { escapeHtml, html, SafeHtml, type HtmlValue } from './html.ts';
import { icon, type IconName } from './icons.ts';
import { DOCUMENT_TYPE, INVOICE_STATUS, NAV_STATUS, PAYMENT_STATUS, type Tone } from './labels.ts';

// ---------------------------------------------------------------------------------------------
// Formatting (never throws – a malformed value is shown as it is)
// ---------------------------------------------------------------------------------------------

export function money(value: string, currency: string): string {
  try {
    return formatMoney(value, currency, 'hu');
  } catch {
    return `${value} ${currency}`;
  }
}

export function huf(value: string): string {
  return money(value, 'HUF');
}

export function quantity(value: string): string {
  try {
    return formatQuantity(value, 'hu');
  } catch {
    return value;
  }
}

export function day(iso: string | null | undefined): string {
  return iso ? formatDate(iso, 'hu') : '–';
}

/** "2026-10-27T09:00:00.000Z" → "2026. 10. 27. 10:00" (Budapest time). */
export function timestamp(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function vatLabel(code: string): string {
  try {
    return getVatInfo(code as Parameters<typeof getVatInfo>[0]).label;
  } catch {
    return code;
  }
}

/** Options of the VAT code select: "27% általános adókulcs", "AAM – Alanyi adómentes", … */
export function vatOptions(): Array<readonly [string, string]> {
  return listVatCodes().map((v) => [v.code, v.nameHu.startsWith(v.label) ? v.nameHu : `${v.code} – ${v.nameHu}`] as const);
}

// ---------------------------------------------------------------------------------------------
// Badges and links
// ---------------------------------------------------------------------------------------------

/** A second cue next to the colour: the shape of the badge's icon (the text stays the meaning). */
const BADGE_ICON: Readonly<Record<Tone, IconName | null>> = { ok: 'check', warn: 'alert', err: 'x', info: 'info', neutral: null };

export function badge(label: string, tone: Tone): SafeHtml {
  const shape = BADGE_ICON[tone];
  return html`<span class="badge b-${tone}">${shape ? icon(shape) : ''}${label}</span>`;
}

export function statusBadge(inv: Pick<Invoice, 'status'>): SafeHtml {
  const s = INVOICE_STATUS[inv.status];
  return badge(s.label, s.tone);
}

export function navBadge(status: NavStatus): SafeHtml {
  const s = NAV_STATUS[status];
  const shape = BADGE_ICON[s.tone];
  return html`<span class="badge b-${s.tone}" title="NAV-állapot">${shape ? icon(shape) : ''}<span class="pfx">NAV: </span>${s.label}</span>`;
}

/**
 * The NAV badge of a document whose NAV state belongs to the other NAV system than the configured one (`configured`):
 * the system is named, e.g. "NAV (TESZT): rendben" in production – not reported there. null when it is not such a document.
 */
export function otherNavBadge(inv: Pick<Invoice, 'navStatus' | 'navEnvironment'>, configured: 'test' | 'production' | null | undefined): SafeHtml | null {
  if (!configured || inv.navEnvironment === undefined || inv.navEnvironment === configured || inv.navStatus === 'not_applicable') return null;
  const label = NAV_STATUS[inv.navStatus].label;
  return inv.navEnvironment === 'test'
    ? html`<span class="badge b-warn" title="Az éles rendszerbe nincs jelentve">${icon('alert')}NAV (TESZT): ${label}</span>`
    : html`<span class="badge b-info" title="A NAV éles rendszerébe jelentve">${icon('info')}NAV (éles): ${label}</span>`;
}

/** "lejárt" – shown next to the payment state of an overdue receivable. */
export function overdueBadge(): SafeHtml {
  return badge('lejárt', 'err');
}

/**
 * Which of `rows` are overdue receivables, by the service's own rule (the overdueOn filter of
 * findInvoices) – one query over the issue dates the rows span. Empty when the lookup fails.
 */
export function overdueAmong(ctx: Ctx, rows: readonly Invoice[]): ReadonlySet<string> {
  const dates = rows.filter((r) => r.status === 'issued' && r.dueDate !== null).map((r) => r.issueDate).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return new Set();
  const found = attempt(() => ctx.app.findInvoices({ overdueOn: ctx.app.today(), issueDateFrom: first, issueDateTo: last, sort: 'issued_asc', limit: 500, offset: 0 }));
  return new Set(found.ok ? found.value.items.map((i) => i.id) : []);
}

/**
 * Whether what the buyer paid on the cancelled invoice `inv` has been refunded in full: its storno, where the refund is
 * recorded, is settled ('paid' by refund). False for anything else, and when the storno cannot be read.
 */
export function refundedOnStorno(ctx: Ctx, inv: Pick<Invoice, 'status' | 'documentType' | 'paymentStatus' | 'cancelledById'>): boolean {
  if (inv.status !== 'cancelled' || inv.documentType === 'proforma' || inv.paymentStatus === 'unpaid' || !inv.cancelledById) return false;
  const storno = attempt(() => ctx.app.getInvoice(inv.cancelledById as string));
  return storno.ok && storno.value.paymentStatus === 'paid';
}

/** The ids of the cancelled invoices among `rows` whose payment has been refunded in full on their storno (refundedOnStorno). */
export function refundedAmong(ctx: Ctx, rows: readonly Invoice[]): ReadonlySet<string> {
  return new Set(rows.filter((r) => refundedOnStorno(ctx, r)).map((r) => r.id));
}

/**
 * The payment state of a document: a cancelled one is not to be paid (what was paid on it is due back – until the refund
 * is recorded on its storno: `refunded`), a credit note (a modification with a negative payable amount) is not paid by the
 * buyer – neither is called "fizetetlen" / "fizetve".
 */
export function paymentBadge(inv: Pick<Invoice, 'status' | 'documentType' | 'paymentStatus' | 'totals'>, refunded = false): SafeHtml {
  if (inv.status === 'draft' || inv.documentType === 'storno') return html`<span class="muted dash">–</span>`;
  if (inv.status === 'cancelled') {
    const done = inv.documentType === 'proforma' ? 'visszavonva' : 'sztornózva';
    if (inv.paymentStatus === 'unpaid') return badge(`nem fizetendő (${done})`, 'neutral');
    return refunded ? badge(`befizetve – ${done}, visszafizetve`, 'neutral') : badge(`befizetve – ${done}, visszajár`, 'warn');
  }
  if (inv.documentType === 'modification' && inv.totals.payableAmount.startsWith('-')) return badge('jóváírás – nem fizetendő', 'neutral');
  const s = PAYMENT_STATUS[inv.paymentStatus];
  return badge(s.label, s.tone);
}

export function invoiceHref(id: string): string {
  return `/invoices/${encodeURIComponent(id)}`;
}

export function invoiceName(inv: Pick<Invoice, 'number' | 'documentType' | 'status'>): string {
  if (inv.number) return inv.number;
  return inv.documentType === 'proforma' ? 'Díjbekérő-piszkozat' : 'Piszkozat';
}

export function invoiceLink(inv: Pick<Invoice, 'id' | 'number' | 'documentType' | 'status'>): SafeHtml {
  return html`<a href="${invoiceHref(inv.id)}">${invoiceName(inv)}</a>`;
}

export interface Column<T> {
  label: string;
  cell: (row: T) => HtmlValue;
  /** Right-aligned numeric column. */
  num?: boolean;
  /** Extra class of the cells (e.g. "nowrap", "grow", "mono"). */
  cls?: string;
}

/**
 * Data table with column headers; every cell carries its column name in data-label, so on narrow
 * screens the stylesheet can show each row as a labelled card (table.stack) instead of scrolling.
 */
export function dataTable<T>(o: { columns: ReadonlyArray<Column<T>>; rows: readonly T[]; caption?: string; cls?: string; stack?: boolean }): SafeHtml {
  const cls = [o.stack === false ? '' : 'stack', o.cls ?? ''].filter(Boolean).join(' ');
  return html`<div class="table-wrap"><table${attrs({ class: cls || undefined })}>${o.caption ? html`<caption>${o.caption}</caption>` : ''}
<thead><tr>${o.columns.map((c) => html`<th scope="col"${c.num ? html` class="num"` : ''}>${c.label}</th>`)}</tr></thead>
<tbody>${o.rows.map(
    (row) => html`<tr>${o.columns.map((c) => {
      const tdClass = [c.num ? 'num' : '', c.cls ?? ''].filter(Boolean).join(' ');
      return html`<td${attrs({ class: tdClass || undefined, 'data-label': c.label })}><span class="cv">${c.cell(row)}</span></td>`;
    })}</tr>`,
  )}</tbody></table></div>`;
}

/**
 * Compact invoice table used by the list, the dashboard and the customer page. On a phone every row is a
 * small card (table.inv, the c-* cell classes): number and gross amount, buyer, the badges, the dates.
 * `overdue`: ids of the overdue receivables among the rows (overdueAmong) – they get a "lejárt" badge. `refunded`: ids of
 * the cancelled invoices whose payment was refunded on their storno (refundedAmong). `navEnvironment`: the configured NAV
 * system – a row whose NAV state belongs to the other one names that system (otherNavBadge).
 */
export function invoiceTable(
  invoices: Invoice[],
  opts: { caption?: string; showCustomer?: boolean; overdue?: ReadonlySet<string>; refunded?: ReadonlySet<string>; navEnvironment?: 'test' | 'production' | null } = {},
): SafeHtml {
  const overdue = opts.overdue ?? new Set<string>();
  const refunded = opts.refunded ?? new Set<string>();
  const columns: Array<Column<Invoice>> = [
    { label: 'Sorszám', cls: 'nowrap c-no', cell: (inv) => html`${invoiceLink(inv)}<br><span class="small muted">${DOCUMENT_TYPE[inv.documentType]}</span>` },
    { label: 'Állapot', cls: 'c-st', cell: (inv) => statusBadge(inv) },
    { label: 'Kelte', cls: 'nowrap c-date', cell: (inv) => day(inv.issueDate) },
    { label: 'Határidő', cls: 'nowrap c-date', cell: (inv) => day(inv.dueDate) },
  ];
  if (opts.showCustomer ?? true) columns.push({ label: 'Vevő', cls: 'grow c-cust', cell: (inv) => inv.customer.name });
  columns.push(
    { label: 'Bruttó', num: true, cls: 'c-gross', cell: (inv) => money(inv.totals.grossAmount, inv.currency) },
    { label: 'Fizetés', cls: 'c-pay', cell: (inv) => html`${paymentBadge(inv, refunded.has(inv.id))}${overdue.has(inv.id) ? html` ${overdueBadge()}` : ''}` },
    {
      label: 'NAV',
      cls: 'c-nav',
      cell: (inv) => (inv.navStatus === 'not_applicable' ? html`<span class="muted dash">–</span>` : (otherNavBadge(inv, opts.navEnvironment) ?? navBadge(inv.navStatus))),
    },
  );
  return dataTable({ columns, rows: invoices, cls: 'inv', ...(opts.caption ? { caption: opts.caption } : {}) });
}

/** An empty list: the sentence that says so, and the button to the next step (secondary: the page head has the primary). */
export function emptyState(text: string, action?: { href: string; label: string }): SafeHtml {
  return html`<div class="empty-state"><p class="empty">${text}</p>${action ? html`<a class="btn" href="${action.href}">${icon('plus')}${action.label}</a>` : ''}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Form fields (every input has a <label>; hints are linked with aria-describedby)
// ---------------------------------------------------------------------------------------------

type AttrValue = string | number | boolean | null | undefined;

/** Builds ` name="value"` pairs; names come from code, values are escaped; true → bare attribute. */
export function attrs(a: Readonly<Record<string, AttrValue>>): SafeHtml {
  let out = '';
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === false) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(k)) throw new Error(`Invalid attribute name: ${k}`);
    out += v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`;
  }
  return new SafeHtml(out);
}

export function fieldId(name: string): string {
  return `f-${name.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

export interface InputOptions {
  name: string;
  label: string;
  value?: string | null;
  type?: string;
  required?: boolean;
  hint?: string;
  wide?: boolean;
  id?: string;
  /** Extra input attributes (placeholder, maxlength, inputmode, list, autocomplete, min, max, step, pattern…). */
  extra?: Readonly<Record<string, AttrValue>>;
}

function labelHtml(id: string, label: string, required?: boolean): SafeHtml {
  return html`<label for="${id}">${label}${required ? html` <span class="req" aria-hidden="true">*</span>` : ''}</label>`;
}

function hintHtml(id: string, hint: string | undefined): HtmlValue {
  return hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : '';
}

export function inputField(o: InputOptions): SafeHtml {
  const id = o.id ?? fieldId(o.name);
  return html`<div class="field${o.wide ? ' wide' : ''}">${labelHtml(id, o.label, o.required)}<input${attrs({
    id,
    name: o.name,
    type: o.type ?? 'text',
    value: o.value ?? '',
    required: o.required,
    'aria-describedby': o.hint ? `${id}-hint` : undefined,
    ...(o.extra ?? {}),
  })}>${hintHtml(id, o.hint)}</div>`;
}

export interface SelectOptions {
  name: string;
  label: string;
  value?: string | null;
  options: ReadonlyArray<readonly [string, string]>;
  required?: boolean;
  hint?: string;
  wide?: boolean;
  id?: string;
}

export function selectOptions(options: ReadonlyArray<readonly [string, string]>, value: string | null | undefined): SafeHtml {
  return html`${options.map(([v, l]) => html`<option value="${v}"${v === (value ?? '') ? html` selected` : ''}>${l}</option>`)}`;
}

export function selectField(o: SelectOptions): SafeHtml {
  const id = o.id ?? fieldId(o.name);
  return html`<div class="field${o.wide ? ' wide' : ''}">${labelHtml(id, o.label, o.required)}<select${attrs({
    id,
    name: o.name,
    required: o.required,
    'aria-describedby': o.hint ? `${id}-hint` : undefined,
  })}>${selectOptions(o.options, o.value)}</select>${hintHtml(id, o.hint)}</div>`;
}

export function textareaField(o: { name: string; label: string; value?: string | null; hint?: string; rows?: number; maxlength?: number; wide?: boolean }): SafeHtml {
  const id = fieldId(o.name);
  return html`<div class="field${o.wide === false ? '' : ' wide'}">${labelHtml(id, o.label)}<textarea${attrs({
    id,
    name: o.name,
    rows: o.rows ?? 3,
    maxlength: o.maxlength,
    'aria-describedby': o.hint ? `${id}-hint` : undefined,
  })}>${o.value ?? ''}</textarea>${hintHtml(id, o.hint)}</div>`;
}

export function checkboxField(o: { name: string; label: string; checked: boolean; value?: string; required?: boolean; hint?: string; wide?: boolean }): SafeHtml {
  const id = fieldId(o.name);
  return html`<div class="field check${o.wide ? ' wide' : ''}"><input${attrs({
    id,
    name: o.name,
    type: 'checkbox',
    value: o.value ?? '1',
    checked: o.checked,
    required: o.required,
    'aria-describedby': o.hint ? `${id}-hint` : undefined,
  })}><div>${labelHtml(id, o.label)}${hintHtml(id, o.hint)}</div></div>`;
}

export function csrfInput(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

export function hiddenInput(name: string, value: string): SafeHtml {
  return html`<input type="hidden" name="${name}" value="${value}">`;
}

/** A POST form carrying the CSRF token. `action` must be a fixed local path. */
export function postForm(ctx: Ctx, action: string, inner: HtmlValue, opts: { cls?: string; label?: string } = {}): SafeHtml {
  return html`<form method="post" action="${action}"${attrs({ class: opts.cls, 'aria-label': opts.label })}>${csrfInput(ctx)}${inner}</form>`;
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

export const PAGE_SIZE = 25;

/** 1-based page number from the query (bounded). */
export function pageParam(url: URL): number {
  const n = Number(url.searchParams.get('page') ?? '1');
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

export function pager(o: { total: number; offset: number; count: number; page: number; hrefFor: (page: number) => string }): SafeHtml {
  if (o.total === 0) return html``;
  const from = o.offset + 1;
  const to = o.offset + o.count;
  const last = Math.max(1, Math.ceil(o.total / PAGE_SIZE));
  return html`<nav class="pager" aria-label="Lapozás"><span class="muted">${from}–${to} / ${o.total} találat</span><span class="actions">${
    o.page > 1 ? html`<a class="btn" href="${o.hrefFor(o.page - 1)}" rel="prev" aria-label="Előző oldal">${icon('back')}Előző</a>` : ''
  }${o.page < last ? html`<a class="btn" href="${o.hrefFor(o.page + 1)}" rel="next" aria-label="Következő oldal">Következő${icon('next')}</a>` : ''}</span></nav>`;
}

/** Instead of the table, when the requested page is past the last page of a non-empty list (e.g. an old link). */
export function pastLastPage(o: { total: number; hrefFor: (page: number) => string }): SafeHtml {
  const last = Math.max(1, Math.ceil(o.total / PAGE_SIZE));
  return html`<p class="empty">Ez az oldal üres – utolsó oldal: ${last}. <a href="${o.hrefFor(last)}">Ugrás az utolsó oldalra</a></p>`;
}

/** Query string from the given parameters (empty values dropped). */
export function queryString(params: ReadonlyArray<readonly [string, string]>): string {
  const q = new URLSearchParams();
  for (const [k, v] of params) if (v !== '') q.append(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}
