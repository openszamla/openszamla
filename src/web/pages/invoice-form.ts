/**
 * "/invoices/new" (createDraft) and "/invoices/<id>/edit" (updateDraft): the draft form.
 * Works without JavaScript (5 line rows, a product list in each row when there are saved products, the new-buyer
 * fields in a disclosure); a tiny inline script hides the empty spare rows until "Új tételsor hozzáadása" asks for
 * one, fills a row from the product chosen in it, and opens / closes the new-buyer fields when the saved-customer
 * choice changes.
 */
import { isAppError } from '../../core/errors.ts';
import type { Customer, Invoice, Product } from '../../core/types.ts';
import { COMMON_UNITS } from '../../core/units.ts';
import { invoiceContentHash, type OpenSzamla } from '../../service/app.ts';
import {
  attrs,
  checkboxField,
  csrfInput,
  day,
  hiddenInput,
  inputField,
  invoiceHref,
  invoiceName,
  money,
  quantity,
  selectField,
  selectOptions,
  textareaField,
  vatOptions,
} from '../components.ts';
import { attempt, failure, forRedisplay, isNotFound, notFoundPage, redirect, renderPage, withWithheldFields, type Ctx } from '../context.ts';
import {
  CUSTOMER_ID_RE,
  DRAFT_DOCUMENT_TYPES,
  draftEditableInWeb,
  draftFormFields,
  draftInputFrom,
  draftStateFromForm,
  draftStateFromInvoice,
  localizeLineRefs,
  manualRateValue,
  numberValue,
  MAX_LINES,
  newDraftState,
  PRODUCT_ID_RE,
  spareRowsFrom,
  withoutUnchangedPrefill,
  type DraftFormState,
  type LineValues,
  type ParsedDraft,
} from '../forms.ts';
import { html, type SafeHtml } from '../html.ts';
import { icon } from '../icons.ts';
import type { Flash } from '../layout.ts';
import { CUSTOMER_VAT_STATUS, DOCUMENT_TYPE, LANGUAGE, PAYMENT_METHOD, PRICE_BASIS, keysOf } from '../labels.ts';

const CUSTOMER_LIST_LIMIT = 500;
const PRODUCT_LIST_LIMIT = 500;

/**
 * Line rows: the empty spare rows (tr.spare) are hidden, and "Új tételsor hozzáadása" shows the next one – or adds a
 * row (clones the <template>) when none is left. A product chosen in a row (select[data-pick]) fills the row from the
 * option's data: name, unit, price (only in the document's currency), price basis and VAT code. The form works without it.
 */
const ADD_LINE_SCRIPT = `(function () {
  var body = document.getElementById('lines-body');
  var tpl = document.getElementById('line-template');
  var btn = document.getElementById('add-line');
  if (!body || !tpl || !btn || !('content' in tpl)) return;
  var empty = function (row) {
    var fields = row.querySelectorAll('input:not([type=hidden]), select[data-pick]');
    for (var i = 0; i < fields.length; i++) if ((fields[i].value || '').trim() !== '') return false;
    return true;
  };
  body.querySelectorAll('tr.spare').forEach(function (row) { if (empty(row)) row.hidden = true; });
  btn.hidden = false;
  btn.addEventListener('click', function () {
    var row = body.querySelector('tr.spare[hidden]');
    if (row) {
      row.hidden = false;
    } else {
      var count = body.getElementsByTagName('tr').length;
      if (count >= ${MAX_LINES}) return;
      row = tpl.content.firstElementChild.cloneNode(true);
      var idx = String(count), no = String(count + 1);
      row.querySelectorAll('[name]').forEach(function (el) { el.setAttribute('name', el.getAttribute('name').replace('__I__', idx)); });
      row.querySelectorAll('[aria-label]').forEach(function (el) { el.setAttribute('aria-label', el.getAttribute('aria-label').replace('__N__', no)); });
      var cell = row.querySelector('.c-no');
      if (cell) cell.textContent = no + '.';
      body.appendChild(row);
    }
    var first = row.querySelector('select[data-pick], input:not([type=hidden])');
    if (first) first.focus();
  });
})();
(function () {
  var currency = document.getElementById('f-currency');
  document.addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel || !sel.matches || !sel.matches('select[data-pick]')) return;
    var o = sel.options[sel.selectedIndex];
    var row = sel.closest('tr');
    if (!o || !o.value || !row) return;
    var set = function (name, value) {
      var el = row.querySelector('[name$="].' + name + '"]');
      if (el) el.value = value;
    };
    var same = !currency || (currency.value || '').trim().toUpperCase() === o.getAttribute('data-currency');
    set('description', o.getAttribute('data-name') || '');
    set('unit', o.getAttribute('data-unit') || '');
    set('unitPrice', same ? o.getAttribute('data-price') || '' : '');
    set('priceBasis', o.getAttribute('data-basis') || 'net');
    set('vatCode', o.getAttribute('data-vat') || '');
    set('nature', '');
    set('natureUnit', '');
    var qty = row.querySelector('[name$="].quantity"]');
    if (qty && !(qty.value || '').trim()) qty.value = '1';
  });
})();
(function () {
  var pick = document.getElementById('f-customerId');
  var inline = document.getElementById('new-buyer');
  if (!pick || !inline) return;
  pick.addEventListener('change', function () { inline.open = pick.value === ''; });
})();`;

function defaultVatCode(app: OpenSzamla): string {
  const seller = attempt(() => app.getSeller());
  return seller.ok && seller.value?.vatStatus === 'aam' ? 'AAM' : '27';
}

/** The saved products a line row offers (the first PRODUCT_LIST_LIMIT, and any product the rows already name). */
function productChoices(ctx: Ctx, lines: readonly LineValues[]): Product[] {
  const page = attempt(() => ctx.app.findProducts({ limit: PRODUCT_LIST_LIMIT, offset: 0 }));
  const items: Product[] = page.ok ? [...page.value.items] : [];
  for (const id of new Set(lines.map((l) => l.productId.trim()).filter((id) => PRODUCT_ID_RE.test(id)))) {
    if (items.some((p) => p.id === id)) continue;
    const extra = attempt(() => ctx.app.getProduct(id));
    if (extra.ok) items.push(extra.value);
  }
  return items;
}

/** The product list of a row: the first option is a line typed by hand; each product carries what the script fills in. */
function productSelect(name: string, n: string, selected: string, products: readonly Product[]): SafeHtml {
  return html`<select name="${name}" data-pick aria-label="${n}. tétel – termék a listából"><option value=""${selected === '' ? html` selected` : ''}>Válassz terméket…</option>${products.map(
    (p) => html`<option${attrs({
      value: p.id,
      selected: p.id === selected,
      'data-name': p.name,
      'data-unit': p.unit,
      'data-price': numberValue(p.unitPrice),
      'data-basis': p.priceBasis,
      'data-vat': p.vatCode,
      'data-currency': p.currency,
    })}>${p.name} – ${money(p.unitPrice, p.currency)} / ${p.unit}${p.priceBasis === 'gross' ? ' (bruttó)' : ''}${p.archived ? ' – archivált' : ''}</option>`,
  )}</select>`;
}

/** One line row. `products`: the row offers them (null: none saved – the product link of the line is kept hidden). */
function lineRow(index: number | null, v: LineValues, vat: ReadonlyArray<readonly [string, string]>, products: readonly Product[] | null, spare = false): SafeHtml {
  const i = index === null ? '__I__' : String(index);
  const n = index === null ? '__N__' : String(index + 1);
  const name = (f: string): string => `lines[${i}].${f}`;
  return html`<tr${spare ? html` class="spare"` : ''}>
<td class="c-no">${n}.</td>
<td class="c-desc" data-label="${products ? 'Termék / megnevezés' : 'Megnevezés'}"><div class="desc-cell">${
    products ? productSelect(name('productId'), n, v.productId, products) : html`<input type="hidden" name="${name('productId')}" value="${v.productId}">`
  }<input name="${name('description')}" value="${v.description}" maxlength="512" placeholder="megnevezés" aria-label="${n}. tétel – megnevezés"><input type="hidden" name="${name('nature')}" value="${v.nature}"><input type="hidden" name="${name('natureUnit')}" value="${v.natureUnit}"></div></td>
<td data-label="Mennyiség"><input name="${name('quantity')}" value="${v.quantity}" inputmode="decimal" autocomplete="off" aria-label="${n}. tétel – mennyiség"></td>
<td data-label="Egység"><input name="${name('unit')}" value="${v.unit}" list="units" placeholder="pl. db" maxlength="50" aria-label="${n}. tétel – mennyiségi egység"></td>
<td data-label="Egységár"><input name="${name('unitPrice')}" value="${v.unitPrice}" inputmode="decimal" autocomplete="off" aria-label="${n}. tétel – egységár"></td>
<td data-label="Ár"><select name="${name('priceBasis')}" aria-label="${n}. tétel – ár típusa">${selectOptions(Object.entries(PRICE_BASIS), v.priceBasis || 'net')}</select></td>
<td data-label="ÁFA"><select name="${name('vatCode')}" aria-label="${n}. tétel – ÁFA-kód">${selectOptions(vat, v.vatCode)}</select></td>
</tr>`;
}

function customerOptions(ctx: Ctx, selected: string): { options: Array<readonly [string, string]>; truncated: boolean } {
  const page = attempt(() => ctx.app.findCustomers({ limit: CUSTOMER_LIST_LIMIT, offset: 0 }));
  const items: Customer[] = page.ok ? [...page.value.items] : [];
  if (selected && !items.some((c) => c.id === selected)) {
    const extra = attempt(() => ctx.app.getCustomer(selected));
    if (extra.ok) items.unshift(extra.value);
  }
  const options: Array<readonly [string, string]> = [
    ['', '— új vevő (az adatait lent add meg) —'],
    ...items.map((c) => [c.id, `${c.name}${c.taxNumber ? ` (${c.taxNumber})` : c.euVatNumber ? ` (${c.euVatNumber})` : ''}${c.archived ? ' – archivált' : ''}`] as const),
  ];
  return { options, truncated: page.ok && page.value.total > page.value.items.length };
}

interface FormOptions {
  mode: 'new' | 'edit';
  invoice?: Invoice;
  state: DraftFormState;
  status?: number;
  error?: Flash;
}

type ErrorPlace = 'cust' | 'lines';

const PLACE_LINK: Readonly<Record<ErrorPlace, { href: string; label: string }>> = {
  cust: { href: '#h-cust', label: 'Ugrás a Vevő részhez' },
  lines: { href: '#h-lines', label: 'Ugrás a Tételek részhez' },
};

/** The part of the form an error message is about (by its wording: a line, or the buyer), if any. */
function errorPlace(f: Flash): ErrorPlace | null {
  if (/tétel/i.test(f.title)) return 'lines';
  if (/vevő/i.test(f.title)) return 'cust';
  return null;
}

/** The error message at the top of the page, with a link to the part of the form it is about. */
function withPlaceLink(f: Flash): Flash {
  const place = errorPlace(f);
  return place && !f.link ? { ...f, link: PLACE_LINK[place] } : f;
}

/**
 * Neither a saved customer nor any new-buyer data: said here in web terms (the service's message names the
 * MCP fields). The service still checks every draft; this only words the most common slip of the form.
 */
/** The draft form without seller data: nothing can be saved yet (U7). */
const NO_SELLER: Flash = {
  tone: 'warn',
  title: 'Számlát csak az eladó (saját céged) adatainak megadása után készíthetsz.',
  hint: 'Az eladó adatai (név, adószám, cím, ÁFA-státusz) kerülnek minden számlára; add meg őket, utána itt mentheted a piszkozatot.',
  link: { href: '/settings#h-seller', label: 'Eladó adatainak megadása' },
};

const MISSING_BUYER: Flash = {
  tone: 'err',
  title: 'Hiányzik a vevő.',
  hint: 'Válassz egy mentett vevőt a „Vevő a vevőlistából” mezőben, vagy add meg az új vevő adatait (név és cím; cégnél az adószám is).',
};

function renderDraftForm(ctx: Ctx, o: FormOptions): void {
  const { app } = ctx;
  const v = (name: string): string => o.state.values[name] ?? '';
  const defaults = attempt(() => app.getDefaults());
  const paymentDays = defaults.ok ? defaults.value.paymentDays : null;
  const vat = vatOptions();
  const customers = customerOptions(ctx, v('customerId'));
  // The product list of the line rows: only when there is something to choose (or a line names a product).
  const productList = productChoices(ctx, o.state.lines);
  const products = productList.length > 0 ? productList : null;
  const spareFrom = spareRowsFrom(o.state.lines);
  // Without the seller nothing can be saved (SELLER_NOT_CONFIGURED): said before anything is typed.
  const sellerState = attempt(() => app.getSeller());
  const noSeller = sellerState.ok && sellerState.value === null;
  const action = o.mode === 'new' ? '/invoices/new' : `${invoiceHref(o.invoice?.id ?? '')}/edit`;
  const title = o.mode === 'new' ? 'Új számla' : `Piszkozat szerkesztése`;
  const moreBuyer = ['c_phone', 'c_bankAccount', 'c_groupMemberTaxNumber', 'c_region'].some((n) => v(n) !== '');
  const inv = o.invoice;
  const mnbRate = inv && inv.currency !== 'HUF' && inv.exchangeRateSource === 'MNB' && inv.exchangeRate !== '0'
    ? `Jelenleg MNB-árfolyam: 1 ${inv.currency} = ${quantity(inv.exchangeRate)} Ft${inv.exchangeRateDate ? ` (${day(inv.exchangeRateDate)})` : ''}. `
    : '';
  // The edit form is pre-filled with the stored due date: say which kind it is (forms.ts withoutUnchangedPrefill).
  const dueHint = o.mode === 'edit' && inv?.dueDate
    ? inv.dueDateExplicit === true
      ? 'Megadott határidő: kiállításkor sem változik (üresen hagyva is megmarad).'
      : 'A fizetési feltételből számolt határidő: ha nem írod át (vagy kiüríted), a kiállítás napjával együtt eltolódik.'
    : paymentDays === null ? 'Üresen hagyva az alapértelmezés szerint.' : `Üresen hagyva: átutalásnál a kelte + ${paymentDays} nap, egyébként a kelte.`;
  const rateNote = o.mode === 'edit' && inv && manualRateValue(inv) !== ''
    ? ' Ez a kézi árfolyam a teljesítés napjáé: ha a teljesítés dátumát vagy a pénznemet módosítod, és az árfolyamot nem írod át, nem marad meg (MNB-beállításnál az MNB-árfolyam lép a helyére, kézi beállításnál add meg újra).'
    : '';

  // Where a form error belongs: shown there too, next to the fields (the message stays at the top as well).
  const place = o.error ? errorPlace(o.error) : null;
  const inlineError = (where: ErrorPlace): SafeHtml => (o.error && place === where ? html`<p class="field-error">${icon('alert')}<span>${o.error.title}</span></p>` : html``);

  const typeSection = html`<section class="card" aria-labelledby="h-type"><h2 id="h-type">Bizonylat típusa</h2><div class="grid">
${selectField({ name: 'documentType', label: 'Bizonylat típusa', value: v('documentType') || 'invoice', options: DRAFT_DOCUMENT_TYPES.map((t) => [t, DOCUMENT_TYPE[t]] as const), required: true, hint: 'Díjbekérő: fizetési felszólítás, nem számla – a NAV-nak nem jelentendő; fizetés után számla készíthető belőle.' })}
</div></section>`;

  const docSection = html`<section class="card" aria-labelledby="h-doc"><h2 id="h-doc">Dátumok, fizetés, pénznem</h2><div class="grid">
${inputField({ name: 'fulfillmentDate', label: 'Teljesítés dátuma', type: 'date', value: v('fulfillmentDate'), required: true })}
${inputField({ name: 'dueDate', label: 'Fizetési határidő', type: 'date', value: v('dueDate'), hint: dueHint })}
${selectField({ name: 'paymentMethod', label: 'Fizetési mód', value: v('paymentMethod'), options: Object.entries(PAYMENT_METHOD) })}
${inputField({ name: 'currency', label: 'Pénznem', value: v('currency') || 'HUF', required: true, extra: { maxlength: 3, list: 'currencies', autocomplete: 'off', pattern: '[A-Za-z]{3}' } })}
${inputField({ name: 'exchangeRate', label: 'Árfolyam (devizás számlánál)', value: v('exchangeRate'), hint: `${mnbRate}Kézi árfolyam: 1 egység = ? Ft. Üresen hagyva az MNB-árfolyam (ha a beállítás MNB).${rateNote}`, extra: { inputmode: 'decimal', autocomplete: 'off' } })}
${selectField({ name: 'language', label: 'Nyelv', value: v('language'), options: Object.entries(LANGUAGE) })}
${inputField({ name: 'orderNumber', label: 'Megrendelésszám', value: v('orderNumber'), extra: { maxlength: 100 } })}
</div>
<datalist id="currencies">${['HUF', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'PLN', 'RON'].map((c) => html`<option value="${c}">`)}</datalist>
</section>`;

  // The new-buyer fields are open when no saved customer is chosen, or when they hold what the user typed.
  const inlineBuyer = v('customerId') === '' || ['c_name', 'c_taxNumber', 'c_euVatNumber', 'c_postalCode', 'c_city', 'c_addressLine', 'c_email'].some((n) => v(n) !== '');
  const customerSection = html`<section class="card" aria-labelledby="h-cust"><h2 id="h-cust">Vevő</h2>${inlineError('cust')}
<div class="grid">${selectField({
    name: 'customerId',
    label: 'Vevő a vevőlistából',
    value: v('customerId'),
    options: customers.options,
    wide: true,
    hint: customers.truncated ? `Csak az első ${CUSTOMER_LIST_LIMIT} vevő látszik; a többit a Vevők oldalon keresd meg, és onnan indíts új számlát.` : 'Válassz a mentett vevők közül, vagy hagyd az első sort, és add meg az új vevő adatait alább.',
  })}</div>
<details id="new-buyer"${inlineBuyer ? html` open` : ''}><summary>Új vevő adatai (ha nincs a listában)</summary><div class="grid">
${selectField({ name: 'c_vatStatus', label: 'Vevő típusa', value: v('c_vatStatus') || 'DOMESTIC', wide: true, options: keysOf(CUSTOMER_VAT_STATUS).map((k) => [k, CUSTOMER_VAT_STATUS[k]] as const) })}
${inputField({ name: 'c_name', label: 'Név', value: v('c_name'), extra: { maxlength: 512, autocomplete: 'off' } })}
${inputField({ name: 'c_taxNumber', label: 'Adószám', value: v('c_taxNumber'), hint: 'Belföldi áfaalanynál kötelező, pl. 12345676‑1‑23.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_euVatNumber', label: 'Közösségi adószám', value: v('c_euVatNumber'), hint: 'Uniós vevőnél, pl. DE123456789.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_thirdStateTaxId', label: 'Harmadik országbeli adóazonosító', value: v('c_thirdStateTaxId'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_countryCode', label: 'Ország (kód)', value: v('c_countryCode') || 'HU', extra: { maxlength: 2, autocomplete: 'off' } })}
${inputField({ name: 'c_postalCode', label: 'Irányítószám', value: v('c_postalCode'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_city', label: 'Település', value: v('c_city'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_addressLine', label: 'Cím (utca, házszám)', value: v('c_addressLine'), wide: true, extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_email', label: 'E-mail', type: 'email', value: v('c_email'), extra: { autocomplete: 'off' } })}
${o.mode === 'new' ? checkboxField({ name: 'saveCustomer', label: 'Mentés a vevők közé is', checked: v('saveCustomer') !== '' }) : ''}
</div>
<details${moreBuyer ? html` open` : ''}><summary>További vevőadatok (telefon, bankszámla, csoporttagi adószám, régió)</summary><div class="grid">
${inputField({ name: 'c_phone', label: 'Telefon', type: 'tel', value: v('c_phone'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_bankAccount', label: 'Bankszámlaszám', value: v('c_bankAccount'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_groupMemberTaxNumber', label: 'Csoporttagi adószám', value: v('c_groupMemberTaxNumber'), hint: 'Csak ÁFA-csoport tagjánál; ilyenkor az adószám a csoportazonosító.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'c_region', label: 'Régió / tartomány', value: v('c_region'), hint: 'Külföldi címnél, ha szükséges.', extra: { maxlength: 50, autocomplete: 'off' } })}
</div></details></details>
</section>`;

  const linesSection = html`<section class="card" aria-labelledby="h-lines"><h2 id="h-lines">Tételek</h2>${inlineError('lines')}
<p class="hint">Az üresen hagyott sorok nem kerülnek a bizonylatra. Tizedesjel: vessző vagy pont (pl. 1,5). Az egységár a bizonylat pénznemében értendő.${
    products ? ' Termék választásakor a sor a termék adataival töltődik ki; amit üresen hagysz, azt mentéskor is a termékből veszi.' : ''
  }</p>
<div class="table-wrap"><table class="lines-table stack">
<thead><tr><th scope="col" class="num" aria-label="Sorszám">#</th><th scope="col">${products ? 'Termék / megnevezés' : 'Megnevezés'}</th><th scope="col">Mennyiség</th><th scope="col">Egység</th><th scope="col">Egységár</th><th scope="col">Ár</th><th scope="col">ÁFA</th></tr></thead>
<tbody id="lines-body">${o.state.lines.map((l, i) => lineRow(i, l, vat, products, i >= spareFrom))}</tbody>
</table></div>
<datalist id="units">${COMMON_UNITS.map((u) => html`<option value="${u}">`)}</datalist>
<template id="line-template">${lineRow(null, { description: '', quantity: '', unit: '', unitPrice: '', priceBasis: 'net', vatCode: o.state.lines[0]?.vatCode ?? '27', productId: '', nature: '', natureUnit: '' }, vat, products)}</template>
<div class="actions"><button class="btn" type="button" id="add-line" hidden>${icon('plus')}Új tételsor hozzáadása</button></div>
</section>`;

  const notesSection = html`<section class="card" aria-labelledby="h-notes"><h2 id="h-notes">Megjegyzések</h2><div class="grid">
${textareaField({ name: 'comment', label: 'Megjegyzés (a bizonylatra kerül)', value: v('comment'), maxlength: 2000 })}
${textareaField({ name: 'internalNote', label: 'Belső megjegyzés (nem kerül a bizonylatra)', value: v('internalNote'), maxlength: 2000 })}
</div></section>`;

  renderPage(ctx, {
    title,
    active: o.mode === 'new' ? 'new' : 'invoices',
    ...(o.status === undefined ? {} : { status: o.status }),
    flashes: [...(noSeller ? [NO_SELLER] : []), ...(o.error ? [withPlaceLink(o.error)] : [])],
    script: ADD_LINE_SCRIPT,
    main: html`<div class="page-head"><div><h1>${title}</h1><p class="sub">${
      o.mode === 'new' ? 'A mentés piszkozatot hoz létre – a kiállítás külön, megerősítéssel történik.' : o.invoice ? invoiceName(o.invoice) : ''
    }</p></div></div>
<form method="post" action="${action}" aria-label="${title}">${csrfInput(ctx)}${o.mode === 'edit' && inv ? hiddenInput('draftVersion', v('draftVersion') || invoiceContentHash(inv)) : ''}
${typeSection}
${customerSection}
${linesSection}
${docSection}
${notesSection}
<div class="form-actions"><button class="btn btn-primary" type="submit"${noSeller ? html` disabled aria-describedby="no-seller"` : ''}>${icon('check')}Piszkozat mentése</button><a class="btn btn-quiet" href="${o.mode === 'new' ? '/invoices' : invoiceHref(o.invoice?.id ?? '')}">Mégsem</a><p class="hint"${noSeller ? html` id="no-seller"` : ''}>${noSeller ? 'Mentés előtt add meg az eladó (saját céged) adatait a Beállítások oldalon.' : 'A mentés még nem állít ki számlát: utána ellenőrizheted, és külön lépésben, megerősítéssel állíthatod ki.'}</p></div>
</form>`,
  });
}

function localized(f: Flash, rowNumbers: readonly number[]): Flash {
  const out: Flash = { ...f, title: localizeLineRefs(f.title, rowNumbers) };
  if (f.hint) out.hint = localizeLineRefs(f.hint, rowNumbers);
  return out;
}

function parse(ctx: Ctx): { ok: true; parsed: ParsedDraft } | { ok: false; error: Flash } {
  try {
    return { ok: true, parsed: draftInputFrom(ctx.form) };
  } catch (e) {
    return { ok: false, error: failure(ctx, e) };
  }
}

// ---------------------------------------------------------------------------------------------

export function newInvoicePage(ctx: Ctx): void {
  const requested = ctx.url.searchParams.get('customerId') ?? '';
  const productId = ctx.url.searchParams.get('productId') ?? '';
  const product = PRODUCT_ID_RE.test(productId) ? attempt(() => ctx.app.getProduct(productId)) : null;
  const defaults = ctx.app.getDefaults();
  const state = newDraftState({
    defaults,
    today: ctx.app.today(),
    defaultVatCode: defaultVatCode(ctx.app),
    ...(CUSTOMER_ID_RE.test(requested) ? { customerId: requested } : {}),
    ...(product?.ok ? { product: product.value } : {}),
  });
  renderDraftForm(ctx, { mode: 'new', state });
}

export async function createInvoice(ctx: Ctx): Promise<void> {
  const formState = (): DraftFormState => draftStateFromForm(forRedisplay(ctx), defaultVatCode(ctx.app));
  const p = parse(ctx);
  if (!p.ok) return renderDraftForm(ctx, { mode: 'new', state: formState(), status: 422, error: p.error });
  if (!p.parsed.input.customerId && !p.parsed.input.customer) return renderDraftForm(ctx, { mode: 'new', state: formState(), status: 422, error: MISSING_BUYER });
  try {
    const view = await ctx.app.createDraft(p.parsed.input, 'web');
    const errors = view.issues.filter((i) => i.severity === 'error').length;
    redirect(ctx, invoiceHref(view.invoice.id), errors > 0
      ? { tone: 'warn', title: `Piszkozat létrehozva, de ${errors} hibát javítani kell a kiállítás előtt.` }
      : { tone: 'ok', title: 'Piszkozat létrehozva. Nézd át az adatokat, és ha minden rendben, állítsd ki.' });
  } catch (e) {
    renderDraftForm(ctx, { mode: 'new', state: formState(), status: isAppError(e) ? 422 : 500, error: localized(failure(ctx, e), p.parsed.rowNumbers) });
  }
}

/** Why a draft has no web form, and what to do instead (the draft page says the same). */
export const DRAFT_NOT_EDITABLE_HINT =
  'Előleglevonást, módosított tételt vagy egyedi mentességi okot tartalmaz (vagy módosító, illetve sztornó számla piszkozata), amelyhez a webes űrlapon nincs mező: az AI-asszisztenssel javíttasd, vagy töröld, és készíts újat.';

function loadEditable(ctx: Ctx, id: string): Invoice | null {
  const found = attempt(() => ctx.app.getInvoice(id));
  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFoundPage(ctx, 'A bizonylat nem található.', { href: '/invoices', label: 'Vissza a számlákhoz' });
      return null;
    }
    throw found.error;
  }
  const inv = found.value;
  if (!draftEditableInWeb(inv)) {
    redirect(ctx, invoiceHref(inv.id), {
      tone: 'err',
      title: inv.status === 'draft' ? 'Ez a piszkozat a webes felületen nem szerkeszthető.' : 'Kiállított bizonylat nem módosítható.',
      hint: inv.status === 'draft' ? DRAFT_NOT_EDITABLE_HINT : 'Kiállított számlát sztornóval vagy módosító számlával lehet javítani.',
    });
    return null;
  }
  return inv;
}

export function editInvoicePage(ctx: Ctx, id: string): void {
  const inv = loadEditable(ctx, id);
  if (!inv) return;
  renderDraftForm(ctx, { mode: 'edit', invoice: inv, state: draftStateFromInvoice(inv, defaultVatCode(ctx.app)) });
}

const DRAFT_CHANGED: Flash = {
  tone: 'warn',
  title: 'A piszkozat az űrlap megnyitása óta megváltozott, ezért ezt a mentést nem hajtottam végre.',
  hint: 'Például ugyanez az űrlap már el lett küldve, vagy máshol (MCP-n, másik ablakban) módosították. Nézd meg a mentett állapotot, és ha még kell, nyisd meg újra a szerkesztést.',
};

export async function updateInvoice(ctx: Ctx, id: string): Promise<void> {
  const inv = loadEditable(ctx, id);
  if (!inv) return;
  // The pre-filled fields are compared with the draft the form was rendered from: a second submit of the same
  // form, or a form older than a change made elsewhere, must not write its old values over the draft.
  const version = ctx.form.get('draftVersion');
  if (version !== null && version !== invoiceContentHash(inv)) return redirect(ctx, invoiceHref(inv.id), DRAFT_CHANGED);
  // A field the page could not show (it contains a secret) was not submitted: it keeps its stored value.
  const stored = draftFormFields(draftStateFromInvoice(inv, defaultVatCode(ctx.app)));
  ctx = withWithheldFields(ctx, stored);
  const formState = (): DraftFormState => draftStateFromForm(forRedisplay(ctx, stored), defaultVatCode(ctx.app));
  const p = parse(ctx);
  if (!p.ok) return renderDraftForm(ctx, { mode: 'edit', invoice: inv, state: formState(), status: 422, error: p.error });
  try {
    const { input, droppedRate } = withoutUnchangedPrefill(p.parsed.input, ctx.form, inv);
    const view = await ctx.app.updateDraft(inv.id, input, 'web');
    const errors = view.issues.filter((i) => i.severity === 'error').length;
    const mustFix = errors > 0 ? ` ${errors} hibát javítani kell a kiállítás előtt.` : '';
    redirect(ctx, invoiceHref(inv.id), droppedRate !== null
      ? {
          tone: 'warn',
          title: `Piszkozat mentve; a korábbi kézi árfolyamot (1 ${inv.currency} = ${quantity(droppedRate)} Ft) nem vettem át.${mustFix}`,
          hint: 'A teljesítés dátuma vagy a pénznem megváltozott, a kézi árfolyam pedig a teljesítés napjáé (Áfa tv. 80. §). MNB-beállításnál az MNB-árfolyam lépett a helyére; kézi beállításnál add meg az új árfolyamot – akkor is, ha ugyanannyi.',
        }
      : errors > 0
        ? { tone: 'warn', title: `Piszkozat mentve, de ${errors} hibát javítani kell a kiállítás előtt.` }
        : { tone: 'ok', title: 'Piszkozat mentve.' });
  } catch (e) {
    renderDraftForm(ctx, { mode: 'edit', invoice: inv, state: formState(), status: isAppError(e) ? 422 : 500, error: localized(failure(ctx, e), p.parsed.rowNumbers) });
  }
}
