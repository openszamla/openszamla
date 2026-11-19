/** "/invoices" – filterable, paginated list of every document. */
import { isIsoDate } from '../../core/dates.ts';
import type { DocumentType, InvoiceStatus, NavStatus, PaymentStatus } from '../../core/types.ts';
import type { InvoiceFilter } from '../../db/store.ts';
import { checkboxField, emptyState, inputField, invoiceTable, overdueAmong, PAGE_SIZE, pageParam, pager, pastLastPage, queryString, refundedAmong, selectField } from '../components.ts';
import { attempt, emptyNote, renderPage, sectionError, type Ctx } from '../context.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import type { Flash } from '../layout.ts';
import { DOCUMENT_TYPE, INVOICE_STATUS, NAV_STATUS, PAYMENT_STATUS, keysOf } from '../labels.ts';
import { navConnection, navEnvironmentInUse } from './dashboard.ts';

interface FilterOption<T> {
  label: string;
  values: T[];
}

function single<K extends string>(rec: Readonly<Record<K, string | { label: string }>>): Record<string, FilterOption<K>> {
  const out: Record<string, FilterOption<K>> = {};
  for (const k of keysOf(rec)) {
    const v = rec[k];
    out[k] = { label: typeof v === 'string' ? v : v.label, values: [k] };
  }
  return out;
}

const STATUS_FILTER: Readonly<Record<string, FilterOption<InvoiceStatus>>> = {
  ...single(INVOICE_STATUS),
  issued_or_cancelled: { label: 'kiállított vagy sztornózott', values: ['issued', 'cancelled'] },
};

const TYPE_FILTER: Readonly<Record<string, FilterOption<DocumentType>>> = {
  ...single(DOCUMENT_TYPE),
  payable: { label: 'számlák (díjbekérő és sztornó nélkül)', values: ['invoice', 'advance', 'final', 'modification'] },
};

const PAYMENT_FILTER: Readonly<Record<string, FilterOption<PaymentStatus>>> = {
  ...single(PAYMENT_STATUS),
  open: { label: 'nyitott (fizetetlen vagy részben fizetve)', values: ['unpaid', 'partial'] },
  // What the dashboard counts as open: only documents something is owed on (InvoiceFilter.receivable).
  receivable: { label: 'kintlévőség (fizetendő, nem vagy csak részben fizetett számla)', values: ['unpaid', 'partial'] },
};

/** Every NAV status of a document reported (or to be reported) to NAV. */
const REPORTABLE: NavStatus[] = ['not_configured', 'pending', 'processing', 'done', 'done_with_warnings', 'aborted', 'error'];

/**
 * The NAV filters: with a usable connection they select the documents of the configured NAV system (or of none yet), as
 * the dashboard's counts do; "other" the ones whose NAV state belongs to the other system (e.g. only in TESZT).
 */
const NAV_FILTER: Readonly<Record<string, FilterOption<NavStatus>>> = {
  ...single(NAV_STATUS),
  inprogress: { label: 'folyamatban (függő vagy feldolgozás alatt)', values: ['pending', 'processing'] },
  problem: { label: 'NAV-probléma (elutasítva vagy hiba)', values: ['aborted', 'error'] },
  other: { label: 'a másik NAV-rendszerhez tartozik (pl. csak a TESZT rendszerben jelentve)', values: REPORTABLE },
};

const SORTS: Readonly<Record<NonNullable<InvoiceFilter['sort']>, string>> = {
  issued_desc: 'kelte szerint, legújabb elöl',
  issued_asc: 'kelte szerint, legrégebbi elöl',
  created_desc: 'létrehozás szerint, legújabb elöl',
};

function options<T>(rec: Readonly<Record<string, FilterOption<T>>>, all: string): Array<readonly [string, string]> {
  return [['', all], ...Object.entries(rec).map(([k, v]) => [k, v.label] as const)];
}

function pick<T>(rec: Readonly<Record<string, FilterOption<T>>>, value: string): string {
  return Object.hasOwn(rec, value) ? value : '';
}

export function invoiceListPage(ctx: Ctx): void {
  const { app, url } = ctx;
  const p = url.searchParams;
  const q = (p.get('q') ?? '').trim().slice(0, 200);
  const status = pick(STATUS_FILTER, p.get('status') ?? '');
  const type = pick(TYPE_FILTER, p.get('type') ?? '');
  const payment = pick(PAYMENT_FILTER, p.get('payment') ?? '');
  const nav = pick(NAV_FILTER, p.get('nav') ?? '');
  const sortParam = p.get('sort') ?? '';
  const sort = (Object.hasOwn(SORTS, sortParam) ? sortParam : 'issued_desc') as NonNullable<InvoiceFilter['sort']>;
  const overdue = p.get('overdue') === '1';
  const flashes: Flash[] = [];
  const date = (name: string): string => {
    const v = (p.get(name) ?? '').trim();
    if (v && !isIsoDate(v)) {
      flashes.push({ tone: 'warn', title: `Érvénytelen dátum a szűrőben (${v}); ez a feltétel nem lett figyelembe véve.`, hint: 'Formátum: ÉÉÉÉ-HH-NN.' });
      return '';
    }
    return v;
  };
  const from = date('from');
  const to = date('to');
  const page = pageParam(url);

  const filter: Partial<InvoiceFilter> = { sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
  if (q) filter.text = q;
  if (status) filter.status = STATUS_FILTER[status]?.values;
  if (type) filter.documentType = TYPE_FILTER[type]?.values;
  if (payment) filter.paymentStatus = PAYMENT_FILTER[payment]?.values;
  if (payment === 'receivable') filter.receivable = true;
  const env = navEnvironmentInUse(navConnection(app));
  const navValues = nav ? (NAV_FILTER[nav]?.values ?? []) : [];
  if (nav === 'other') filter.navSelect = env ? [{ navStatus: navValues, otherEnvironment: env }] : [];
  else if (nav) filter.navSelect = [{ navStatus: navValues, ...(env ? { environment: env } : {}) }];
  if (from) filter.issueDateFrom = from;
  if (to) filter.issueDateTo = to;
  if (overdue) filter.overdueOn = app.today();

  const params: Array<readonly [string, string]> = [
    ['q', q], ['status', status], ['type', type], ['payment', payment], ['nav', nav], ['from', from], ['to', to],
    ['overdue', overdue ? '1' : ''], ['sort', sort === 'issued_desc' ? '' : sort],
  ];
  const result = attempt(() => app.findInvoices(filter));
  const filtered = params.some(([k, v]) => v !== '' && k !== 'sort');
  const hrefFor = (n: number): string => `/invoices${queryString([...params, ['page', n === 1 ? '' : String(n)]])}`;

  const advanced = [type, payment, nav, from, to, overdue ? '1' : '', sort === 'issued_desc' ? '' : sort].filter((v) => v !== '').length;
  const filterForm = html`<form class="card filters" method="get" action="/invoices" role="search" aria-label="Szűrés">
<div class="grid">
${inputField({ name: 'q', label: 'Keresés', value: q, type: 'search', hint: 'Sorszám, vevő neve, megjegyzés vagy rendelésszám.', extra: { maxlength: 200 } })}
${selectField({ name: 'status', label: 'Állapot', value: status, options: options(STATUS_FILTER, 'mind') })}
</div>
<details${advanced > 0 ? html` open` : ''}><summary>További szűrők${advanced > 0 ? ` (${advanced} aktív)` : ''}</summary><div class="grid">
${selectField({ name: 'type', label: 'Típus', value: type, options: options(TYPE_FILTER, 'mind') })}
${selectField({ name: 'payment', label: 'Fizetés', value: payment, options: options(PAYMENT_FILTER, 'mind') })}
${selectField({ name: 'nav', label: 'NAV-állapot', value: nav, options: options(NAV_FILTER, 'mind') })}
${inputField({ name: 'from', label: 'Kelte ettől', value: from, type: 'date' })}
${inputField({ name: 'to', label: 'Kelte eddig', value: to, type: 'date' })}
${selectField({ name: 'sort', label: 'Rendezés', value: sort, options: Object.entries(SORTS) })}
${checkboxField({ name: 'overdue', label: 'Csak a lejárt határidejű, nem fizetett számlák', checked: overdue })}
</div></details>
<div class="actions"><button class="btn" type="submit">${icon('search')}Szűrés</button>${filtered ? html`<a class="btn btn-quiet" href="/invoices">Szűrők törlése</a>` : ''}</div>
</form>`;

  const listing = result.ok
    ? result.value.items.length > 0
      ? html`${invoiceTable(result.value.items, { overdue: overdueAmong(ctx, result.value.items), refunded: refundedAmong(ctx, result.value.items), navEnvironment: env })}${pager({
          total: result.value.total,
          offset: result.value.offset,
          count: result.value.items.length,
          page,
          hrefFor,
        })}`
      : result.value.total > 0
        ? pastLastPage({ total: result.value.total, hrefFor })
        : filtered
          ? emptyNote('Nincs a szűrésnek megfelelő bizonylat.')
          : emptyState('Még nincs bizonylat.', { href: '/invoices/new', label: 'Új számla készítése' })
    : sectionError(ctx, result.error);

  renderPage(ctx, {
    title: 'Számlák',
    active: 'invoices',
    flashes,
    main: html`<div class="page-head"><div><h1>Számlák és bizonylatok</h1><p class="sub">${result.ok ? `${result.value.total} találat` : ''}</p></div>
<div class="action-bar"><a class="btn btn-primary" href="/invoices/new">${icon('plus')}Új számla készítése</a></div></div>
${filterForm}
<section class="card" aria-label="Találatok">${listing}</section>`,
  });
}
