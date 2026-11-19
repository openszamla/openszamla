/** "/customers" (search, list, create – saveCustomer) and "/customers/<id>" (details, edit, invoices). */
import { isAppError } from '../../core/errors.ts';
import type { Customer } from '../../core/types.ts';
import {
  badge,
  checkboxField,
  csrfInput,
  dataTable,
  emptyState,
  inputField,
  invoiceTable,
  overdueAmong,
  PAGE_SIZE,
  pageParam,
  pager,
  pastLastPage,
  queryString,
  refundedAmong,
  selectField,
  textareaField,
} from '../components.ts';
import { attempt, emptyNote, failure, forRedisplay, isNotFound, notFoundPage, redirect, renderPage, sectionError, withWithheldFields, type Ctx } from '../context.ts';
import { customerInputFrom, customerValues } from '../forms.ts';
import { html, type SafeHtml } from '../html.ts';
import { icon } from '../icons.ts';
import type { Flash } from '../layout.ts';
import { CUSTOMER_VAT_STATUS, keysOf } from '../labels.ts';
import { navConnection, navEnvironmentInUse } from './dashboard.ts';

function customerHref(id: string): string {
  return `/customers/${encodeURIComponent(id)}`;
}

function formValues(f: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of f) if (k !== '_csrf' && !(k in out)) out[k] = v;
  return out;
}

function customerFields(values: Record<string, string>, opts: { withArchived?: boolean } = {}): SafeHtml {
  const v = (n: string): string => values[n] ?? '';
  return html`<div class="grid">
${selectField({ name: 'vatStatus', label: 'Vevő típusa', value: v('vatStatus') || 'DOMESTIC', required: true, wide: true, options: keysOf(CUSTOMER_VAT_STATUS).map((k) => [k, CUSTOMER_VAT_STATUS[k]] as const) })}
${inputField({ name: 'name', label: 'Név', value: v('name'), required: true, extra: { maxlength: 512, autocomplete: 'off' } })}
${inputField({ name: 'taxNumber', label: 'Adószám', value: v('taxNumber'), hint: 'Belföldi áfaalanynál kötelező, pl. 12345676‑1‑23.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'groupMemberTaxNumber', label: 'Csoporttagi adószám', value: v('groupMemberTaxNumber'), hint: 'Csak ÁFA-csoport tagjánál; ilyenkor az adószám a csoportazonosító.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'euVatNumber', label: 'Közösségi adószám', value: v('euVatNumber'), hint: 'Uniós vevőnél, pl. DE123456789.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'thirdStateTaxId', label: 'Harmadik országbeli adóazonosító', value: v('thirdStateTaxId'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'countryCode', label: 'Ország (kód)', value: v('countryCode') || 'HU', required: true, extra: { maxlength: 2, autocomplete: 'off' } })}
${inputField({ name: 'postalCode', label: 'Irányítószám', value: v('postalCode'), required: true, extra: { autocomplete: 'off' } })}
${inputField({ name: 'city', label: 'Település', value: v('city'), required: true, extra: { autocomplete: 'off' } })}
${inputField({ name: 'region', label: 'Régió / tartomány', value: v('region'), hint: 'Külföldi címnél, ha szükséges.', extra: { maxlength: 50, autocomplete: 'off' } })}
${inputField({ name: 'addressLine', label: 'Cím (utca, házszám)', value: v('addressLine'), required: true, wide: true, extra: { autocomplete: 'off' } })}
${inputField({ name: 'email', label: 'E-mail', type: 'email', value: v('email'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'phone', label: 'Telefon', type: 'tel', value: v('phone'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'bankAccount', label: 'Bankszámlaszám', value: v('bankAccount'), extra: { autocomplete: 'off' } })}
${textareaField({ name: 'note', label: 'Belső megjegyzés', value: v('note'), maxlength: 2000 })}
${opts.withArchived ? checkboxField({ name: 'archived', label: 'Archivált (nem jelenik meg a vevőválasztóban és a keresésben)', checked: v('archived') !== '' }) : ''}
</div>`;
}

function taxIdOf(c: Customer): string {
  return c.taxNumber ?? c.euVatNumber ?? c.thirdStateTaxId ?? '–';
}

// ---------------------------------------------------------------------------------------------

export function customerListPage(ctx: Ctx, form?: { values: Record<string, string>; error: Flash; status: number }): void {
  const { app, url } = ctx;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const archived = url.searchParams.get('archived') === '1';
  const page = pageParam(url);
  const result = attempt(() => app.findCustomers({ ...(q ? { text: q } : {}), includeArchived: archived, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }));
  const params: Array<readonly [string, string]> = [['q', q], ['archived', archived ? '1' : '']];
  const hrefFor = (n: number): string => `/customers${queryString([...params, ['page', n === 1 ? '' : String(n)]])}`;

  const list = result.ok
    ? result.value.items.length > 0
      ? html`${dataTable<Customer>({
          rows: result.value.items,
          columns: [
            { label: 'Név', cls: 'grow', cell: (c) => html`<a href="${customerHref(c.id)}">${c.name}</a>${c.archived ? html` ${badge('archivált', 'neutral')}` : ''}` },
            { label: 'Típus', cell: (c) => CUSTOMER_VAT_STATUS[c.vatStatus] ?? c.vatStatus },
            { label: 'Adószám', cls: 'nowrap', cell: (c) => taxIdOf(c) },
            { label: 'Település', cell: (c) => c.address.city },
            { label: 'E-mail', cell: (c) => c.email ?? '' },
          ],
        })}${pager({
          total: result.value.total,
          offset: result.value.offset,
          count: result.value.items.length,
          page,
          hrefFor,
        })}`
      : result.value.total > 0
        ? pastLastPage({ total: result.value.total, hrefFor })
        : q
          ? emptyNote('Nincs a keresésnek megfelelő vevő.')
          : emptyState('Még nincs elmentett vevő.', NEW_CUSTOMER)
    : sectionError(ctx, result.error);

  // "?new=1" (the "Új vevő felvétele" button, the first-run guide) opens the form without JavaScript.
  const openForm = !!form || url.searchParams.get('new') === '1' || (result.ok && result.value.total === 0 && !q);
  renderPage(ctx, {
    title: 'Vevők',
    active: 'customers',
    ...(form ? { status: form.status, flashes: [form.error] } : {}),
    main: html`<div class="page-head"><div><h1>Vevők</h1><p class="sub">${result.ok ? `${result.value.total} vevő` : ''}</p></div>
<div class="action-bar"><a class="btn btn-primary" href="${NEW_CUSTOMER.href}">${icon('plus')}${NEW_CUSTOMER.label}</a></div></div>
<form class="card filters" method="get" action="/customers" role="search" aria-label="Vevők keresése"><div class="grid">
${inputField({ name: 'q', label: 'Keresés', type: 'search', value: q, hint: 'Név, adószám, közösségi adószám, e-mail vagy település.', extra: { maxlength: 200 } })}
${checkboxField({ name: 'archived', label: 'Archivált vevők is', checked: archived })}
</div><div class="actions"><button class="btn" type="submit">${icon('search')}Keresés</button>${q || archived ? html`<a class="btn btn-quiet" href="/customers">Szűrők törlése</a>` : ''}</div></form>
<section class="card" aria-labelledby="h-list"><h2 class="sr-only" id="h-list">Vevőlista</h2>${list}</section>
<section class="card" aria-labelledby="h-new"><details${openForm ? html` open` : ''}><summary id="h-new"><h2>Új vevő felvétele</h2></summary>
<form method="post" action="/customers" aria-label="Új vevő">${csrfInput(ctx)}${customerFields(form?.values ?? customerValues(null))}
<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}Vevő mentése</button></div></form></details></section>`,
  });
}

const NEW_CUSTOMER = { href: '/customers?new=1#h-new', label: 'Új vevő felvétele' };

export function createCustomer(ctx: Ctx): void {
  try {
    const { customer, issues } = ctx.app.saveCustomer(customerInputFrom(ctx.form), 'web');
    redirect(ctx, customerHref(customer.id), {
      tone: issues.length > 0 ? 'warn' : 'ok',
      title: `Vevő mentve: ${customer.name}.`,
      lines: issues.map((i) => i.message),
    });
  } catch (e) {
    customerListPage(ctx, { values: formValues(forRedisplay(ctx)), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}

export function customerDetailPage(ctx: Ctx, id: string, form?: { values: Record<string, string>; error: Flash; status: number }): void {
  const { app } = ctx;
  const found = attempt(() => app.getCustomer(id));
  if (!found.ok) {
    if (isNotFound(found.error)) return notFoundPage(ctx, 'A vevő nem található.', { href: '/customers', label: 'Vissza a vevőkhöz' });
    throw found.error;
  }
  const c = found.value;
  const invoices = attempt(() => app.findInvoices({ customerId: c.id, sort: 'issued_desc', limit: PAGE_SIZE, offset: 0 }));
  const details = html`<dl class="kv">
<dt>Típus</dt><dd>${CUSTOMER_VAT_STATUS[c.vatStatus] ?? c.vatStatus}</dd>
${c.taxNumber ? html`<dt>Adószám</dt><dd>${c.taxNumber}</dd>` : ''}
${c.groupMemberTaxNumber ? html`<dt>Csoporttagi adószám</dt><dd>${c.groupMemberTaxNumber}</dd>` : ''}
${c.euVatNumber ? html`<dt>Közösségi adószám</dt><dd>${c.euVatNumber}</dd>` : ''}
${c.thirdStateTaxId ? html`<dt>Külföldi adóazonosító</dt><dd>${c.thirdStateTaxId}</dd>` : ''}
<dt>Cím</dt><dd>${c.address.postalCode} ${c.address.city}, ${c.address.addressLine}${c.address.region ? `, ${c.address.region}` : ''}${c.address.countryCode !== 'HU' ? ` (${c.address.countryCode})` : ''}</dd>
${c.email ? html`<dt>E-mail</dt><dd>${c.email}</dd>` : ''}
${c.phone ? html`<dt>Telefon</dt><dd>${c.phone}</dd>` : ''}
${c.bankAccount ? html`<dt>Bankszámla</dt><dd>${c.bankAccount}</dd>` : ''}
${c.note ? html`<dt>Megjegyzés</dt><dd>${c.note}</dd>` : ''}
<dt>Azonosító</dt><dd class="mono">${c.id}</dd>
</dl>`;
  renderPage(ctx, {
    title: c.name,
    active: 'customers',
    ...(form ? { status: form.status, flashes: [form.error] } : {}),
    main: html`<div class="page-head"><div><h1>${c.name}</h1><p class="sub">Vevő${c.archived ? html` ${badge('archivált', 'neutral')}` : ''}</p></div>
<div class="action-bar"><a class="btn btn-primary" href="${`/invoices/new${queryString([['customerId', c.id]])}`}">${icon('plus')}Új számla ennek a vevőnek</a><a class="btn btn-quiet" href="/customers">${icon('back')}Vissza a vevőlistához</a></div></div>
<section class="card" aria-labelledby="h-data"><h2 id="h-data">Adatok</h2>${details}
<details${form ? html` open` : ''}><summary class="btn">${icon('pencil')}Adatok módosítása</summary>
<form method="post" action="${customerHref(c.id)}" aria-label="Vevő adatainak módosítása">${csrfInput(ctx)}${customerFields(form?.values ?? customerValues(c), { withArchived: true })}
<p class="hint">A módosítás a már kiállított számlákat nem érinti (azokon a kiállításkori adatok maradnak).</p>
<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}Vevő adatainak mentése</button></div></form></details></section>
<section class="card" aria-labelledby="h-inv"><h2 id="h-inv">Bizonylatai</h2>${
      invoices.ok
        ? invoices.value.items.length > 0
          ? html`${invoiceTable(invoices.value.items, { showCustomer: false, overdue: overdueAmong(ctx, invoices.value.items), refunded: refundedAmong(ctx, invoices.value.items), navEnvironment: navEnvironmentInUse(navConnection(app)) })}${
              invoices.value.total > invoices.value.items.length ? html`<p class="muted">A legutóbbi ${invoices.value.items.length} látszik a(z) ${invoices.value.total} bizonylatból.</p>` : ''
            }`
          : emptyNote('Ennek a vevőnek még nincs bizonylata.')
        : sectionError(ctx, invoices.error)
    }</section>`,
  });
}

export function updateCustomer(ctx: Ctx, id: string): void {
  let stored: Record<string, string> = {};
  try {
    stored = customerValues(ctx.app.getCustomer(id));
    // A field the page could not show (it contains a secret) was not submitted: it keeps its stored value.
    ctx = withWithheldFields(ctx, stored);
    const input = customerInputFrom(ctx.form, '', { withArchived: true });
    input.id = id;
    const { customer, issues } = ctx.app.saveCustomer(input, 'web');
    redirect(ctx, customerHref(customer.id), { tone: issues.length > 0 ? 'warn' : 'ok', title: 'Vevő adatai mentve.', lines: issues.map((i) => i.message) });
  } catch (e) {
    if (isNotFound(e)) return notFoundPage(ctx, 'A vevő nem található.', { href: '/customers', label: 'Vissza a vevőkhöz' });
    customerDetailPage(ctx, id, { values: formValues(forRedisplay(ctx, stored)), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}
