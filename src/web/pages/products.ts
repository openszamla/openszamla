/** "/products" (search, list, create – saveProduct) and "/products/<id>" (edit). */
import { isAppError } from '../../core/errors.ts';
import type { Product } from '../../core/types.ts';
import { COMMON_UNITS } from '../../core/units.ts';
import { inferNature } from '../../service/app.ts';
import {
  badge,
  checkboxField,
  csrfInput,
  dataTable,
  emptyState,
  inputField,
  money,
  PAGE_SIZE,
  pageParam,
  pager,
  pastLastPage,
  queryString,
  selectField,
  textareaField,
  vatLabel,
  vatOptions,
} from '../components.ts';
import { attempt, emptyNote, failure, forRedisplay, isNotFound, notFoundPage, redirect, renderPage, sectionError, withWithheldFields, type Ctx } from '../context.ts';
import { numberValue, productInputFrom } from '../forms.ts';
import { html, type SafeHtml } from '../html.ts';
import { icon } from '../icons.ts';
import type { Flash } from '../layout.ts';
import { LINE_NATURE, PRICE_BASIS } from '../labels.ts';

const NEW_PRODUCT = { href: '/products?new=1#h-new', label: 'Új termék / szolgáltatás felvétele' };

function productHref(id: string): string {
  return `/products/${encodeURIComponent(id)}`;
}

function formValues(f: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of f) if (k !== '_csrf' && !(k in out)) out[k] = v;
  return out;
}

function productValues(p: Product | null, defaultVat: string): Record<string, string> {
  if (!p) return { priceBasis: 'net', currency: 'HUF', vatCode: defaultVat, unit: 'db' };
  return {
    name: p.name,
    unit: p.unit,
    unitPrice: numberValue(p.unitPrice),
    priceBasis: p.priceBasis,
    currency: p.currency,
    vatCode: p.vatCode,
    // The nature the unit gives shows as "automatikus": saved so, it follows a changed unit (as product_save
    // without nature); a nature chosen otherwise (e.g. OTHER, or SERVICE in db) is selected, so it is kept.
    nature: p.nature === inferNature(p.unit) ? '' : p.nature,
    sku: p.sku ?? '',
    description: p.description ?? '',
    archived: p.archived ? '1' : '',
  };
}

function productFields(values: Record<string, string>, opts: { withArchived?: boolean } = {}): SafeHtml {
  const v = (n: string): string => values[n] ?? '';
  return html`<div class="grid">
${inputField({ name: 'name', label: 'Megnevezés', value: v('name'), required: true, wide: true, extra: { maxlength: 512, autocomplete: 'off' } })}
${inputField({ name: 'unit', label: 'Mennyiségi egység', value: v('unit'), extra: { list: 'units', maxlength: 50, autocomplete: 'off' } })}
${inputField({ name: 'unitPrice', label: 'Egységár', value: v('unitPrice'), required: true, extra: { inputmode: 'decimal', autocomplete: 'off' } })}
${selectField({ name: 'priceBasis', label: 'Az ár', value: v('priceBasis') || 'net', options: Object.entries(PRICE_BASIS) })}
${inputField({ name: 'currency', label: 'Pénznem', value: v('currency') || 'HUF', extra: { maxlength: 3, pattern: '[A-Za-z]{3}', autocomplete: 'off' } })}
${selectField({ name: 'vatCode', label: 'ÁFA', value: v('vatCode'), options: vatOptions(), required: true })}
${selectField({ name: 'nature', label: 'Jelleg', value: v('nature'), options: [['', 'automatikus (az egység alapján)'], ...Object.entries(LINE_NATURE)] })}
${inputField({ name: 'sku', label: 'Cikkszám', value: v('sku'), extra: { maxlength: 100, autocomplete: 'off' } })}
${textareaField({ name: 'description', label: 'Leírás', value: v('description'), maxlength: 2000 })}
${opts.withArchived ? checkboxField({ name: 'archived', label: 'Archivált', checked: v('archived') !== '' }) : ''}
</div>
<datalist id="units">${COMMON_UNITS.map((u) => html`<option value="${u}">`)}</datalist>`;
}

function defaultVat(ctx: Ctx): string {
  const seller = attempt(() => ctx.app.getSeller());
  return seller.ok && seller.value?.vatStatus === 'aam' ? 'AAM' : '27';
}

// ---------------------------------------------------------------------------------------------

export function productListPage(ctx: Ctx, form?: { values: Record<string, string>; error: Flash; status: number }): void {
  const { app, url } = ctx;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const archived = url.searchParams.get('archived') === '1';
  const page = pageParam(url);
  const result = attempt(() => app.findProducts({ ...(q ? { text: q } : {}), includeArchived: archived, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }));
  const params: Array<readonly [string, string]> = [['q', q], ['archived', archived ? '1' : '']];
  const hrefFor = (n: number): string => `/products${queryString([...params, ['page', n === 1 ? '' : String(n)]])}`;

  const list = result.ok
    ? result.value.items.length > 0
      ? html`${dataTable<Product>({
          rows: result.value.items,
          columns: [
            { label: 'Megnevezés', cls: 'grow', cell: (p) => html`<a href="${productHref(p.id)}">${p.name}</a>${p.archived ? html` ${badge('archivált', 'neutral')}` : ''}` },
            { label: 'Egység', cell: (p) => p.unit },
            { label: 'Egységár', num: true, cell: (p) => html`${money(p.unitPrice, p.currency)} <span class="small muted">${PRICE_BASIS[p.priceBasis]}</span>` },
            { label: 'ÁFA', cell: (p) => vatLabel(p.vatCode) },
            { label: 'Jelleg', cell: (p) => LINE_NATURE[p.nature] },
            { label: 'Cikkszám', cell: (p) => p.sku ?? '' },
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
          ? emptyNote('Nincs a keresésnek megfelelő termék.')
          : emptyState('Még nincs elmentett termék vagy szolgáltatás.', NEW_PRODUCT)
    : sectionError(ctx, result.error);

  // "?new=1" (the "Új termék / szolgáltatás felvétele" button) opens the form without JavaScript.
  const openForm = !!form || url.searchParams.get('new') === '1' || (result.ok && result.value.total === 0 && !q);
  renderPage(ctx, {
    title: 'Termékek',
    active: 'products',
    ...(form ? { status: form.status, flashes: [form.error] } : {}),
    main: html`<div class="page-head"><div><h1>Termékek és szolgáltatások</h1><p class="sub">${result.ok ? `${result.value.total} tétel` : ''}</p></div>
<div class="action-bar"><a class="btn btn-primary" href="${NEW_PRODUCT.href}">${icon('plus')}${NEW_PRODUCT.label}</a></div></div>
<form class="card filters" method="get" action="/products" role="search" aria-label="Termékek keresése"><div class="grid">
${inputField({ name: 'q', label: 'Keresés', type: 'search', value: q, hint: 'Megnevezés, cikkszám vagy leírás.', extra: { maxlength: 200 } })}
${checkboxField({ name: 'archived', label: 'Archivált tételek is', checked: archived })}
</div><div class="actions"><button class="btn" type="submit">${icon('search')}Keresés</button>${q || archived ? html`<a class="btn btn-quiet" href="/products">Szűrők törlése</a>` : ''}</div></form>
<section class="card" aria-labelledby="h-list"><h2 class="sr-only" id="h-list">Terméklista</h2>${list}</section>
<section class="card" aria-labelledby="h-new"><details${openForm ? html` open` : ''}><summary id="h-new"><h2>Új termék / szolgáltatás felvétele</h2></summary>
<form method="post" action="/products" aria-label="Új termék">${csrfInput(ctx)}${productFields(form?.values ?? productValues(null, defaultVat(ctx)))}
<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}Termék mentése</button></div></form></details></section>`,
  });
}

export function createProduct(ctx: Ctx): void {
  try {
    const p = ctx.app.saveProduct(productInputFrom(ctx.form), 'web');
    redirect(ctx, '/products', { tone: 'ok', title: `Mentve: ${p.name}.` });
  } catch (e) {
    productListPage(ctx, { values: formValues(forRedisplay(ctx)), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}

export function productDetailPage(ctx: Ctx, id: string, form?: { values: Record<string, string>; error: Flash; status: number }): void {
  const found = attempt(() => ctx.app.getProduct(id));
  if (!found.ok) {
    if (isNotFound(found.error)) return notFoundPage(ctx, 'A termék nem található.', { href: '/products', label: 'Vissza a termékekhez' });
    throw found.error;
  }
  const p = found.value;
  renderPage(ctx, {
    title: p.name,
    active: 'products',
    ...(form ? { status: form.status, flashes: [form.error] } : {}),
    main: html`<div class="page-head"><div><h1>${p.name}</h1><p class="sub">${money(p.unitPrice, p.currency)} / ${p.unit} (${PRICE_BASIS[p.priceBasis]}), ÁFA: ${vatLabel(p.vatCode)}${
      p.archived ? html` ${badge('archivált', 'neutral')}` : ''
    }</p></div><div class="action-bar">${
      p.archived ? '' : html`<a class="btn" href="${`/invoices/new${queryString([['productId', p.id]])}`}">${icon('plus')}Új számla ezzel a termékkel</a>`
    }<a class="btn btn-quiet" href="/products">${icon('back')}Vissza a terméklistához</a></div></div>
<section class="card" aria-labelledby="h-edit"><h2 id="h-edit">Adatok módosítása</h2>
<form method="post" action="${productHref(p.id)}" aria-label="Termék módosítása">${csrfInput(ctx)}${productFields(form?.values ?? productValues(p, defaultVat(ctx)), { withArchived: true })}
<p class="hint">A módosítás a már elkészült bizonylatokat nem érinti.</p>
<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}Termék adatainak mentése</button></div></form></section>`,
  });
}

export function updateProduct(ctx: Ctx, id: string): void {
  let stored: Record<string, string> = {};
  try {
    stored = productValues(ctx.app.getProduct(id), defaultVat(ctx));
    // A field the page could not show (it contains a secret) was not submitted: it keeps its stored value.
    ctx = withWithheldFields(ctx, stored);
    const p = ctx.app.saveProduct(productInputFrom(ctx.form, { id, withArchived: true }), 'web');
    redirect(ctx, productHref(p.id), { tone: 'ok', title: 'Mentve.' });
  } catch (e) {
    if (isNotFound(e)) return notFoundPage(ctx, 'A termék nem található.', { href: '/products', label: 'Vissza a termékekhez' });
    productDetailPage(ctx, id, { values: formValues(forRedisplay(ctx, stored)), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}
