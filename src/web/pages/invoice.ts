/**
 * "/invoices/<id>" – every detail of one document, and its actions (each maps to one service call):
 * PDF download (naming what the file is: the kept original with its SHA-256, a regenerated one, a draft), record payment,
 * NAV sync (with the time limit of the dashboard sync; an invoice of the other NAV system is never sent from here – the
 * page says how it can be, with the user's explicit confirmation), and for drafts delete / issue; sztornó for issued invoices.
 * Issuing and cancelling need the ticked confirmation box AND a server-issued confirmation value
 * bound to the session and to exactly what was shown (OpenSzamla.issueFingerprint / cancelFingerprint).
 * A díjbekérő is turned into an invoice draft, and an invoice copied into a new draft (createDraft copyFromId), with
 * one click that opens the new draft in the draft form – nothing is issued without the usual confirmation.
 */
import { canonicalJson, sha256Hex } from '../../core/canonical.ts';
import { AppError, isAppError } from '../../core/errors.ts';
import type { Address, AuditEntry, Invoice, InvoiceLine, NavMessage, ValidationIssue, VatSummaryRow } from '../../core/types.ts';
import { REGENERATED_PDF_SUFFIX, type CorrectionChainTotals, type IssueResult, type NavWait } from '../../service/app.ts';
import { PAYMENT_KIND_TEXT, PAYMENT_SOURCE_TEXT, type PaymentHistoryEntry } from '../../service/app.ts';
import { navSendCommandLine, navSetupCommandLine } from '../../service/config.ts';
import {
  badge,
  checkboxField,
  csrfInput,
  dataTable,
  day,
  hiddenInput,
  huf,
  inputField,
  invoiceHref,
  invoiceLink,
  invoiceName,
  money,
  navBadge,
  overdueAmong,
  overdueBadge,
  paymentBadge,
  postForm,
  quantity,
  refundedOnStorno,
  statusBadge,
  timestamp,
  vatLabel,
} from '../components.ts';
import { attempt, emptyNote, failure, isNotFound, notFoundPage, redirect, renderPage, sectionError, takeFlashes, type Ctx } from '../context.ts';
import { draftEditableInWeb, localizeLineRefs, numberInput } from '../forms.ts';
import { webIssueNote, webIssueText } from '../hints.ts';
import { html, type HtmlValue, type SafeHtml } from '../html.ts';
import { icon } from '../icons.ts';
import { sendDownload } from '../io.ts';
import { flashHtml, type Flash } from '../layout.ts';
import {
  ACTOR,
  APPEARANCE,
  auditActionLabel,
  CUSTOMER_VAT_STATUS,
  DOCUMENT_TYPE,
  ISSUE_FIELD_LABELS,
  LANGUAGE,
  NAV_STATUS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  SELLER_VAT_STATUS,
} from '../labels.ts';
import { navResultText, navWaitText, SEND_BUTTON, thisDocument } from '../nav-text.ts';
import { mintConfirmation, OnceIds, verifyConfirmation } from '../security.ts';
import { commandBlock, COPY_SCRIPT } from '../setup-guide.ts';
import { NAV_SYNC_BUDGET_MS, navConnection, navEnvironmentInUse, type NavConnection } from './dashboard.ts';
import { DRAFT_NOT_EDITABLE_HINT } from './invoice-form.ts';

const NOT_FOUND_TEXT = 'A bizonylat nem található.';
const BACK_TO_LIST = { href: '/invoices', label: 'Vissza a számlákhoz' };

function addressText(a: Address): string {
  const base = `${a.postalCode} ${a.city}, ${a.addressLine}${a.region ? `, ${a.region}` : ''}`.trim();
  return a.countryCode && a.countryCode !== 'HU' ? `${base} (${a.countryCode})` : base;
}

function unitPrice(value: string, currency: string): string {
  return `${quantity(value)} ${currency === 'HUF' ? 'Ft' : currency}`;
}

function kv(rows: ReadonlyArray<readonly [string, HtmlValue] | null | false>): SafeHtml {
  return html`<dl class="kv">${rows.map((r) => (r ? html`<dt>${r[0]}</dt><dd>${r[1]}</dd>` : ''))}</dl>`;
}

/** "számla" → "Számla" (button labels start with the document type). */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Hungarian definite article before a word: "a számla", "az előlegszámla". */
function withArticle(word: string): string {
  return `${/^[aáeéiíoóöőuúüű]/i.test(word) ? 'az' : 'a'} ${word}`;
}

/** What the NAV button of the invoice page does, by the invoice's NAV state (one service call: navSync). */
function navActionLabel(inv: Pick<Invoice, 'documentType' | 'navStatus'>): string {
  const what = capital(DOCUMENT_TYPE[inv.documentType]);
  switch (inv.navStatus) {
    case 'processing':
      return 'NAV-feldolgozás állapotának lekérdezése';
    case 'aborted':
    case 'error':
      return `${what} újraküldése a NAV-nak`;
    case 'done':
    case 'done_with_warnings':
      return 'NAV-állapot ellenőrzése';
    default:
      return `${what} beküldése a NAV-nak`;
  }
}

/** A storno or a díjbekérő withdrawal can be started from this document's page (its Sztornózás part is shown). */
function cancellable(inv: Invoice): boolean {
  return inv.status === 'issued' && inv.documentType !== 'storno' && inv.documentType !== 'modification';
}

/**
 * Jump links of the page head to the sections holding the document's actions. `canPay`: the payment section
 * offers its form (paymentSection decides – the link only follows it). `navSendable`: the page offers the NAV
 * button – a usable connection, and the NAV state of the document is not one of the other NAV system's.
 */
function jumpLinks(inv: Invoice, navSendable: boolean, canPay: boolean): HtmlValue {
  const links: SafeHtml[] = [];
  if (inv.status === 'draft') {
    links.push(html`<a class="btn btn-danger-quiet" href="#torles">${icon('trash')}Piszkozat törlése…</a>`);
  } else {
    if (canPay) links.push(html`<a class="btn" href="#h-pay">${icon('card')}${inv.documentType === 'storno' ? 'Visszafizetés rögzítése…' : 'Befizetés rögzítése…'}</a>`);
    // A document NAV has already accepted needs nothing more: its NAV part stays below, without a shortcut here.
    const accepted = inv.navStatus === 'done' || inv.navStatus === 'done_with_warnings';
    if (inv.documentType !== 'proforma' && navSendable && !accepted) {
      links.push(html`<a class="btn" href="#h-nav">${icon(inv.navStatus === 'processing' ? 'refresh' : 'send')}${navActionLabel(inv)}…</a>`);
    }
    if (cancellable(inv)) {
      links.push(html`<a class="btn btn-danger-quiet" href="#h-cancel">${icon('undo')}${inv.documentType === 'proforma' ? 'Díjbekérő visszavonása…' : 'Sztornó számla készítése…'}</a>`);
    }
  }
  return links.length > 0 ? html`<nav class="action-bar" aria-label="Ugrás a bizonylat műveleteihez">${links}</nav>` : '';
}

/**
 * What a new draft can be made from this document with one click (POST …/copy, createDraft copyFromId): a díjbekérő
 * becomes an invoice draft (issuing it carries the payment recorded on the díjbekérő over); an invoice or előlegszámla –
 * also a cancelled one, e.g. to issue it again correctly – is copied. null: nothing (drafts, corrections, végszámla).
 */
function copyKind(inv: Pick<Invoice, 'status' | 'documentType'>): 'convert' | 'copy' | null {
  if (inv.documentType === 'proforma') return inv.status === 'issued' ? 'convert' : null;
  if (inv.documentType !== 'invoice' && inv.documentType !== 'advance') return null;
  return inv.status === 'issued' || inv.status === 'cancelled' ? 'copy' : null;
}

function copyForm(ctx: Ctx, inv: Invoice): HtmlValue {
  const kind = copyKind(inv);
  if (!kind) return '';
  const label = kind === 'convert' ? 'Számla készítése ebből a díjbekérőből' : 'Új számla ennek mintájára';
  return postForm(ctx, `${invoiceHref(inv.id)}/copy`, html`${hiddenInput('formId', OnceIds.mint())}<button class="btn" type="submit">${icon('plus')}${label}</button>`, { cls: 'head-form', label });
}

/**
 * What "PDF letöltése" gives (OpenSzamla.pdfInfo – nothing is rendered for it): an issued document's kept original
 * with its SHA-256, the regenerated PDF of a document issued before originals were kept (not the one handed over), or
 * a draft's TERVEZET. The download link points to it (aria-describedby="pdf-note").
 */
function pdfFact(ctx: Ctx, inv: Invoice): SafeHtml {
  const info = attempt(() => ctx.app.pdfInfo(inv.id));
  if (!info.ok) return html`<p class="facts" id="pdf-note">${badge('a PDF most nem tölthető le', 'err')}<span>${failure(ctx, info.error).title}</span></p>`;
  const { kind, sha256, note } = info.value;
  if (kind === 'draft') return html`<p class="facts" id="pdf-note"><span>PDF: <strong>tervezet</strong> („TERVEZET – NEM SZÁMLA” vízjellel) – nem számla</span></p>`;
  if (kind === 'regenerated') {
    return html`<p class="facts" id="pdf-note">${badge('PDF: újra előállított, nem az eredeti', 'warn')}<span>${note} A letöltött fájl neve: ${inv.number ?? inv.id}${REGENERATED_PDF_SUFFIX}.pdf.</span></p>`;
  }
  return sha256
    ? html`<p class="facts" id="pdf-note"><span>PDF: <strong>a megőrzött eredeti</strong> – a kiállításkor készült, a letöltés bájtra pontosan ezt adja</span><span>SHA-256: <span class="mono">${sha256}</span></span></p>`
    : html`<p class="facts" id="pdf-note"><span>PDF: <strong>eredeti</strong> – ${note}</span></p>`;
}

/** Next to the NAV badge of an invoice whose NAV state belongs to the other NAV system: which system that is. */
function otherSystemBadge(inv: Pick<Invoice, 'navEnvironment'>): SafeHtml {
  return inv.navEnvironment === 'test' ? badge('csak a TESZT rendszerben', 'warn') : badge('az éles rendszerben', 'info');
}

/**
 * The NAV part of an invoice whose NAV state belongs to the other NAV system than the configured one (e.g. reported
 * only to the TEST one): the web UI never sends it there. In production such an invoice is sent only with the user's
 * explicit confirmation – through the AI client (nav_send_to_configured_environment) or the command line
 * (openszamla nav-send-to-configured-environment … --confirm); the page says how, in plain words.
 */
function otherSystemHelp(ctx: Ctx, inv: Invoice, nav: NavConnection): SafeHtml {
  const n = inv.number ?? inv.id;
  const state = NAV_STATUS[inv.navStatus].label;
  if (nav.environment === 'production') {
    return html`<p>Ez a számla a NAV <strong>TESZT</strong> rendszerébe került (ott az állapota: ${state}), az éles rendszerbe nincs jelentve – a tesztrendszerbe küldött számla nem adatszolgáltatás.</p>
<p>A webes felület ilyen számlát nem küld be az éles rendszerbe: az valódi adatszolgáltatás a NAV felé, és nem vonható vissza, ezért csak kifejezett megerősítéssel történhet. Ha ez valódi számla, kétféleképpen küldheted be:</p>
<ol class="notes">
<li><strong>Az AI-asszisztensben</strong> (pl. Claude, Codex): kérd meg, hogy küldje be a(z) ${n} számlát az éles NAV-rendszerbe. Előbb megmutatja, mit jelent a beküldés, és csak a jóváhagyásod után küldi be.</li>
<li><strong>Parancssorban</strong>, azon a gépen, ahol a program fut – a <code>--confirm</code> a kifejezett megerősítés, nélküle a parancs csak kiírja, mit jelentene:${commandBlock('nav-send-cmd', navSendCommandLine(n, ctx.app.config.dataDir))}</li>
</ol>
<p class="hint">A beküldés után frissítsd ezt az oldalt.</p>`;
  }
  return html`<p>Ez a számla az <strong>éles</strong> NAV-rendszerbe került (ott az állapota: ${state}). A program most a NAV TESZT rendszerét használja: itt nincs vele teendő, és a webes felület a tesztrendszerbe sem küldi be. Az éles jelentéséhez állítsd vissza az éles környezetet, azon a gépen, ahol a program fut:</p>${commandBlock('nav-prod-cmd', navSetupCommandLine(ctx.app.config.dataDir, 'production'))}`;
}

/** Audit fingerprint of a confirmation value (the value itself is never stored). */
function fingerprint(confirmation: string): string {
  return sha256Hex(`web|${confirmation}`).slice(0, 32);
}

/**
 * What an issue confirmation is bound to: exactly what the issued invoice will contain – the draft
 * content, the issue date it gets (the page states it) and the seller profile issuing puts on it.
 * Editing the draft, passing midnight or changing the seller data after the page was shown all
 * invalidate the confirmation.
 */
function issueMaterial(ctx: Ctx, draft: Invoice): string {
  return ctx.app.issueFingerprint(draft.id);
}

function confirmedWith(ctx: Ctx, invoiceId: string, confirmation: string): boolean {
  if (!confirmation) return false;
  const fp = fingerprint(confirmation);
  const log = attempt(() => ctx.app.auditLog({ entityId: invoiceId, limit: 100 }));
  return log.ok && log.value.items.some((e) => e.details.confirmFingerprint === fp);
}

/** The Hungarian name of an issue's field: "customer.vatStatus" → "vevő típusa", "lines[1].unitPrice" → "2. tétel – egységár". */
function fieldLabel(field: string, lineNumbers: readonly number[]): string | null {
  if (/^lines\[\d+\]/.test(field)) {
    const local = localizeLineRefs(field, lineNumbers);
    return local === field ? null : local;
  }
  const parts = field.split('.');
  for (let n = parts.length; n > 0; n--) {
    const label = ISSUE_FIELD_LABELS[parts.slice(0, n).join('.')];
    if (label) return label;
  }
  return null;
}

/**
 * Where a draft's issue can be fixed on the web: the part of the draft form, the buyer's or the seller's data; null when
 * the field is not the user's to set (the issue date, the number) or the draft has no web form.
 */
function fixHref(inv: Invoice, field: string): string | null {
  if (field.startsWith('seller')) return '/settings#h-seller';
  if (['issueDate', 'number', 'seriesId', 'reference', 'totals'].some((f) => field === f || field.startsWith(`${f}.`))) return null;
  // A buyer from the customer list follows its record: its data are fixed there.
  const record = inv.customerId && inv.customerFromRecord === true ? `/customers/${encodeURIComponent(inv.customerId)}` : null;
  if (field.startsWith('customer') && record) return record;
  if (!draftEditableInWeb(inv)) return null;
  const edit = `${invoiceHref(inv.id)}/edit`;
  if (field.startsWith('customer')) return `${edit}#h-cust`;
  if (field.startsWith('lines')) return `${edit}#h-lines`;
  if (field === 'documentType') return `${edit}#h-type`;
  if (field === 'comment') return `${edit}#h-notes`;
  return `${edit}#h-doc`;
}

/**
 * Validation issues: the web wording where the service's is written for agents (webIssueText, or `text` of the caller),
 * the field in Hungarian – linked to where it is fixed (`fix`) –, and the web note of the issue code. The same text
 * twice (e.g. one rule for two lines) is shown once.
 */
function issuesList(
  issues: ValidationIssue[],
  lineNumbers: readonly number[],
  o: { inv: Pick<Invoice, 'lines'>; fix?: (field: string) => string | null; text?: (i: ValidationIssue) => string | undefined },
): SafeHtml {
  const seen = new Set<string>();
  const rows: Array<{ i: ValidationIssue; text: string }> = [];
  for (const i of issues) {
    const text = o.text?.(i) ?? webIssueText(i, o.inv) ?? localizeLineRefs(i.message, lineNumbers);
    if (seen.has(`${i.severity}|${text}`)) continue;
    seen.add(`${i.severity}|${text}`);
    rows.push({ i, text });
  }
  return html`<ul class="issues">${rows.map(({ i, text }) => {
    const label = i.field ? fieldLabel(i.field, lineNumbers) : null;
    const href = i.field && o.fix ? o.fix(i.field) : null;
    const note = webIssueNote(i.code);
    return html`<li>${i.severity === 'error' ? badge('hiba', 'err') : badge('figyelmeztetés', 'warn')}<span>${text}${
      label ? html` <span class="muted small">– érintett mező: ${href ? html`<a href="${href}">${label}</a>` : label}</span>` : ''
    }${note ? html`<br><span class="small">${note}</span>` : ''}</span></li>`;
  })}</ul>`;
}

// ---------------------------------------------------------------------------------------------
// GET /invoices/<id>
// ---------------------------------------------------------------------------------------------

export function invoiceDetailPage(ctx: Ctx, id: string): void {
  const { app } = ctx;
  const found = attempt(() => app.getInvoice(id));
  if (!found.ok) {
    if (isNotFound(found.error)) return notFoundPage(ctx, NOT_FOUND_TEXT, BACK_TO_LIST);
    throw found.error;
  }
  let inv = found.value;
  let draftPanel: SafeHtml = html``;
  if (inv.status === 'draft') {
    // The view of a draft is its preview: the dates, seller and buyer data issuing it today gives.
    const view = attempt(() => app.viewInvoice(id));
    if (view.ok) inv = view.value.invoice;
    draftPanel = draftSection(ctx, inv, found.value, view.ok ? view.value : null, view.ok ? null : view.error);
  }
  const foreign = inv.currency !== 'HUF';
  const series = attempt(() => app.listSeries().find((s) => s.id === inv.seriesId) ?? null);
  const related = attempt(() => app.findInvoices({ originalInvoiceId: inv.id, sort: 'issued_asc', limit: 50, offset: 0 }).items);
  const cancelledBy = inv.cancelledById ? attempt(() => app.getInvoice(inv.cancelledById as string)) : null;
  const audit = attempt(() => app.auditLog({ entityId: inv.id, limit: 100 }));
  const nav = navConnection(app);
  // Its NAV state belongs to the other NAV system (e.g. reported only to the TEST one): never sent from this page.
  const otherNote = inv.status === 'draft' ? null : attempt(() => app.navEnvironmentNote(inv));
  const otherSystem = otherNote !== null && otherNote.ok && otherNote.value !== null;
  // A correction waiting for its original: its NAV button could not send it – the page says why, and links the original.
  const waiting = inv.status === 'draft' ? null : attempt(() => app.navWait(inv.id));
  const wait = waiting?.ok ? waiting.value : null;
  // The invoices made from a díjbekérő (its conversion).
  const conversions = inv.documentType === 'proforma' && inv.status !== 'draft' ? attempt(() => app.proformaConversions(inv.id)) : null;
  // A message about the storno form (a refused reason) is shown there, with the form open; every other one on top.
  const pending = takeFlashes(ctx.st, ctx.session.id);
  const atCancel = cancellable(inv) ? pending.filter((f) => f.section === CANCEL_SECTION) : [];
  const c = inv.customer;
  const s = inv.seller;

  const overdue = overdueAmong(ctx, [inv]).has(inv.id);
  const payment = paymentSection(ctx, inv);
  const canPay = String(payment).includes(`action="${invoiceHref(inv.id)}/payment"`);
  // The head says what is to be paid only where something is: an issued document with a positive payable amount.
  const payable = inv.status === 'issued' && inv.documentType !== 'storno' && inv.totals.payableAmount !== '0' && !inv.totals.payableAmount.startsWith('-');
  const head = html`<div class="page-head"><div>
<h1>${invoiceName(inv)}</h1>
<p class="sub">${DOCUMENT_TYPE[inv.documentType]} · ${c.name}</p>
<div class="badges">${statusBadge(inv)} ${inv.status === 'draft' || inv.documentType === 'storno' ? '' : paymentBadge(inv, refundedOnStorno(ctx, inv))}${overdue ? html` ${overdueBadge()}` : ''} ${inv.navStatus === 'not_applicable' ? '' : navBadge(inv.navStatus)}${otherSystem ? html` ${otherSystemBadge(inv)}` : ''}</div>
<p class="facts">${payable ? html`<span>Fizetendő: <strong>${money(inv.totals.payableAmount, inv.currency)}</strong></span>` : html`<span>Bruttó: <strong>${money(inv.totals.grossAmount, inv.currency)}</strong></span>`}${
    payable && inv.dueDate ? html`<span>Fizetési határidő: <strong>${day(inv.dueDate)}</strong></span>` : ''
  }</p>
${pdfFact(ctx, inv)}${
    conversions?.ok && conversions.value.length > 0
      ? html`<p class="facts"><span>Számla készült belőle: ${conversions.value.map((c, i) => html`${i > 0 ? ', ' : ''}${invoiceLink(c)}`)}</span></p>`
      : copyKind(inv) === 'convert'
        ? html`<p class="facts no-print"><span>Fizetés után készíts belőle számlát: a „Számla készítése ebből a díjbekérőből” gomb számlapiszkozatot nyit a díjbekérő adataival, a rögzített befizetés pedig a számla kiállításakor átkerül rá.</span></p>`
        : ''
  }
</div>
<div class="actions no-print">
<a class="btn" aria-describedby="pdf-note" href="${`${invoiceHref(inv.id)}.pdf`}">PDF letöltése</a>
${inv.status === 'draft' && draftEditableInWeb(inv) ? html`<a class="btn" href="${`${invoiceHref(inv.id)}/edit`}">Piszkozat szerkesztése</a>` : ''}
${copyForm(ctx, inv)}
${jumpLinks(inv, nav.configured && !otherSystem && !wait, canPay)}
</div></div>`;

  const cancelledNotice = inv.status === 'cancelled'
    ? html`<div class="flash flash-err" role="status">${icon('x')}<div class="flash-body"><p class="flash-title">${inv.documentType === 'proforma' ? 'Ez a díjbekérő vissza lett vonva.' : 'Ezt a számlát sztornózták.'}</p>${
        cancelledBy?.ok ? html`<p>Sztornó számla: ${invoiceLink(cancelledBy.value)}</p>` : ''
      }</div></div>`
    : '';

  const parties = html`<div class="cols">
<section class="card" aria-labelledby="h-seller"><h2 id="h-seller">Eladó</h2>${kv([
    ['Név', html`<strong>${s.name}</strong>`],
    ['Adószám', s.taxNumber || '–'],
    s.groupMemberTaxNumber ? ['Csoporttagi adószám', s.groupMemberTaxNumber] : null,
    s.euVatNumber ? ['Közösségi adószám', s.euVatNumber] : null,
    ['Cím', addressText(s.address)],
    s.bankAccount ? ['Bankszámla', `${s.bankAccount}${s.bankName ? ` (${s.bankName})` : ''}`] : null,
    s.registrationNumber ? ['Nyilvántartási szám', s.registrationNumber] : null,
    ['ÁFA-státusz', `${SELLER_VAT_STATUS[s.vatStatus] ?? s.vatStatus}${s.cashAccounting ? ', pénzforgalmi elszámolás' : ''}${s.smallBusiness ? ', kisadózó' : ''}`],
  ])}</section>
<section class="card" aria-labelledby="h-buyer"><h2 id="h-buyer">Vevő</h2>${kv([
    ['Név', inv.customerId ? html`<a href="${`/customers/${encodeURIComponent(inv.customerId)}`}"><strong>${c.name}</strong></a>` : html`<strong>${c.name}</strong>`],
    ['Típus', CUSTOMER_VAT_STATUS[c.vatStatus] ?? c.vatStatus],
    c.taxNumber ? ['Adószám', c.taxNumber] : null,
    c.groupMemberTaxNumber ? ['Csoporttagi adószám', c.groupMemberTaxNumber] : null,
    c.euVatNumber ? ['Közösségi adószám', c.euVatNumber] : null,
    c.thirdStateTaxId ? ['Külföldi adóazonosító', c.thirdStateTaxId] : null,
    ['Cím', addressText(c.address)],
    c.email ? ['E-mail', c.email] : null,
    c.phone ? ['Telefon', c.phone] : null,
    c.bankAccount ? ['Bankszámla', c.bankAccount] : null,
  ])}</section>
</div>`;

  const rateText = !foreign
    ? null
    : inv.exchangeRate === '0'
      ? badge('hiányzik', 'err')
      : `1 ${inv.currency} = ${quantity(inv.exchangeRate)} Ft${inv.exchangeRateSource ? ` (${inv.exchangeRateSource === 'MNB' ? 'MNB' : 'kézi'}${inv.exchangeRateDate ? `, ${day(inv.exchangeRateDate)}` : ''})` : ''}`;

  const data = html`<section class="card" aria-labelledby="h-data"><h2 id="h-data">Bizonylat adatai</h2><div class="cols flat">${kv([
    ['Típus', DOCUMENT_TYPE[inv.documentType]],
    ['Sorszám', inv.number ?? html`<span class="muted">kiállításkor kap sorszámot</span>`],
    ['Sorszámtartomány', series.ok && series.value ? series.value.name : inv.seriesId],
    ['Kelte', inv.status === 'draft' ? html`${day(inv.issueDate)} <span class="muted small">(kiállításkor a kiállítás napja lesz)</span>` : day(inv.issueDate)],
    ['Teljesítés dátuma', day(inv.fulfillmentDate)],
    ['Fizetési határidő', day(inv.dueDate)],
    ['Fizetési mód', PAYMENT_METHOD[inv.paymentMethod] ?? inv.paymentMethod],
  ])}${kv([
    ['Pénznem', inv.currency],
    rateText === null ? null : ['Árfolyam', rateText],
    ['Nyelv', LANGUAGE[inv.language] ?? inv.language],
    ['Megjelenési forma', APPEARANCE[inv.appearance] ?? inv.appearance],
    inv.orderNumber ? ['Megrendelésszám', inv.orderNumber] : null,
    ['Létrehozva', timestamp(inv.createdAt)],
    inv.issuedAt ? ['Kiállítva', timestamp(inv.issuedAt)] : null,
    ['Azonosító', html`<span class="mono">${inv.id}</span>`],
    inv.contentHash ? ['Tartalmi lenyomat', html`<span class="mono small">${inv.contentHash}</span>`] : null,
  ])}</div></section>`;

  const lines = html`<section class="card" aria-labelledby="h-lines"><h2 id="h-lines">Tételek</h2>${
    inv.lines.length === 0
      ? emptyNote('Nincs tétel.')
      : dataTable<InvoiceLine>({
          rows: inv.lines,
          columns: [
            { label: '#', num: true, cell: (l) => l.lineNo },
            {
              label: 'Megnevezés',
              cls: 'grow',
              cell: (l) => html`${l.description}${l.vatReason ? html`<br><span class="small muted">${l.vatReason}</span>` : ''}${
                l.advanceDeduction ? html`<br><span class="small muted">Előleg levonása: ${l.advanceDeduction.advanceInvoiceNumber} (${day(l.advanceDeduction.advancePaymentDate)})</span>` : ''
              }${l.modifiesLineNo !== undefined ? html`<br><span class="small muted">Az eredeti számla ${l.modifiesLineNo}. tételét módosítja</span>` : ''}`,
            },
            { label: 'Mennyiség', num: true, cell: (l) => `${quantity(l.quantity)} ${l.unit}` },
            { label: 'Egységár', num: true, cell: (l) => html`${unitPrice(l.unitPrice, inv.currency)}${l.priceBasis === 'gross' ? html` <span class="small muted">(bruttó)</span>` : ''}` },
            { label: 'ÁFA', cell: (l) => vatLabel(l.vatCode) },
            { label: 'Nettó', num: true, cell: (l) => money(l.netAmount, inv.currency) },
            { label: 'ÁFA-összeg', num: true, cell: (l) => money(l.vatAmount, inv.currency) },
            { label: 'Bruttó', num: true, cell: (l) => money(l.grossAmount, inv.currency) },
          ],
        })
  }</section>`;

  const t = inv.totals;
  const vatSummary = html`<section class="card" aria-labelledby="h-vat"><h2 id="h-vat">ÁFA-összesítő és végösszeg</h2>${
    t.byVat.length > 0
      ? dataTable<VatSummaryRow>({
          rows: t.byVat,
          columns: [
            { label: 'ÁFA-kód', cell: (r) => vatLabel(r.vatCode) },
            { label: 'Nettó', num: true, cell: (r) => money(r.netAmount, inv.currency) },
            { label: 'ÁFA', num: true, cell: (r) => money(r.vatAmount, inv.currency) },
            { label: 'Bruttó', num: true, cell: (r) => money(r.grossAmount, inv.currency) },
            ...(foreign
              ? [
                  { label: 'Nettó (Ft)', num: true, cell: (r: VatSummaryRow) => huf(r.netAmountHuf) },
                  { label: 'ÁFA (Ft)', num: true, cell: (r: VatSummaryRow) => huf(r.vatAmountHuf) },
                  { label: 'Bruttó (Ft)', num: true, cell: (r: VatSummaryRow) => huf(r.grossAmountHuf) },
                ]
              : []),
          ],
        })
      : ''
  }
<table class="totals"><tbody>
<tr><th scope="row">Nettó összesen</th><td class="num">${money(t.netAmount, inv.currency)}</td></tr>
<tr><th scope="row">ÁFA összesen</th><td class="num">${money(t.vatAmount, inv.currency)}</td></tr>
<tr><th scope="row">Bruttó összesen</th><td class="num">${money(t.grossAmount, inv.currency)}</td></tr>
${t.roundingDifference !== '0' ? html`<tr><th scope="row">Kerekítés (készpénz)</th><td class="num">${money(t.roundingDifference, inv.currency)}</td></tr>` : ''}
<tr class="grand"><th scope="row">Fizetendő</th><td class="num">${money(t.payableAmount, inv.currency)}</td></tr>
${
  foreign
    ? html`<tr><th scope="row">Nettó (Ft)</th><td class="num">${huf(t.netAmountHuf)}</td></tr><tr><th scope="row">ÁFA (Ft)</th><td class="num">${huf(t.vatAmountHuf)}</td></tr><tr><th scope="row">Bruttó (Ft)</th><td class="num">${huf(t.grossAmountHuf)}</td></tr>`
    : ''
}
</tbody></table></section>`;

  const texts = inv.notations.length > 0 || inv.comment || inv.internalNote
    ? html`<section class="card" aria-labelledby="h-texts"><h2 id="h-texts">Megjegyzések</h2>${
        inv.notations.length > 0 ? html`<h3>Kötelező szöveges megjelölések</h3><ul class="notes">${inv.notations.map((n) => html`<li>${n}</li>`)}</ul>` : ''
      }${inv.comment ? html`<h3>Megjegyzés (a bizonylaton)</h3><p>${inv.comment}</p>` : ''}${
        inv.internalNote ? html`<h3>Belső megjegyzés <span class="muted small">(nem kerül a bizonylatra)</span></h3><p>${inv.internalNote}</p>` : ''
      }</section>`
    : '';

  const relatedItems = related.ok ? related.value : [];
  const relatedSection = inv.reference || relatedItems.length > 0 || !related.ok
    ? html`<section class="card" aria-labelledby="h-related"><h2 id="h-related">Kapcsolódó bizonylatok</h2>${
        inv.reference
          ? inv.documentType === 'storno'
            ? html`<p>Sztornózott számla: <a href="${invoiceHref(inv.reference.originalInvoiceId)}">${inv.reference.originalInvoiceNumber}</a></p>`
            : html`<p>Eredeti számla: <a href="${invoiceHref(inv.reference.originalInvoiceId)}">${inv.reference.originalInvoiceNumber}</a> <span class="muted small">(${inv.reference.modificationIndex}. módosítás)</span></p>`
          : ''
      }${
        related.ok
          ? relatedItems.length > 0
            ? html`<ul class="notes">${relatedItems.map((r) => html`<li>${invoiceLink(r)} – ${DOCUMENT_TYPE[r.documentType]} ${statusBadge(r)} <span class="muted small">${day(r.issueDate)}, ${money(r.totals.grossAmount, r.currency)}</span></li>`)}</ul>`
            : ''
          : sectionError(ctx, related.error)
      }</section>`
    : '';

  // The audit details name series by name and amounts in the document's currency (never a raw id).
  const seriesNames = attempt(() => new Map(app.listSeries().map((x) => [x.id, x.name] as const)));
  const auditCtx: AuditContext = { currency: inv.currency, seriesName: (id) => (seriesNames.ok ? seriesNames.value.get(id) : undefined) };
  renderPage(ctx, {
    title: invoiceName(inv),
    active: 'invoices',
    flashes: pending.filter((f) => !atCancel.includes(f)),
    // The copy buttons of the command shown for an invoice of the other NAV system.
    ...(otherSystem && nav.configured ? { script: COPY_SCRIPT } : {}),
    main: html`${head}${cancelledNotice}${draftPanel}${parties}${data}${lines}${vatSummary}${texts}${relatedSection}${payment}${navSection(ctx, inv, nav, otherSystem, wait)}${cancelSection(ctx, inv, atCancel)}
<section class="card" aria-labelledby="h-audit"><h2 id="h-audit">Napló</h2>${
      audit.ok
        ? audit.value.items.length > 0
          ? dataTable<AuditEntry>({
              rows: audit.value.items,
              columns: [
                { label: 'Időpont', cls: 'nowrap', cell: (e) => timestamp(e.at) },
                { label: 'Ki', cell: (e) => ACTOR[e.actor] ?? e.actor },
                { label: 'Művelet', cell: (e) => auditActionLabel(e.action) },
                { label: 'Részletek', cls: 'small', cell: (e) => auditDetails(e.details, auditCtx) },
              ],
            })
          : emptyNote('Nincs naplóbejegyzés ehhez a bizonylathoz.')
        : sectionError(ctx, audit.error)
    }</section>`,
  });
}

const AUDIT_KEYS: Readonly<Record<string, string>> = {
  number: 'sorszám',
  documentType: 'típus',
  customer: 'vevő',
  gross: 'bruttó',
  currency: 'pénznem',
  original: 'eredeti',
  amount: 'összeg',
  date: 'dátum',
  paymentStatus: 'fizetés',
  previousPaymentStatus: 'korábban',
  open: 'hátralék',
  cause: 'kiváltó bizonylat',
  proforma: 'díjbekérő',
  markPaid: 'kiállításkor fizetve',
  reason: 'ok',
  operation: 'NAV-művelet',
  transactionId: 'tranzakció',
  environment: 'környezet',
  invoiceStatus: 'NAV-eredmény',
  messages: 'üzenetek',
  code: 'kód',
  retryable: 'újrapróbálható',
  fields: 'mezők',
  name: 'név',
  confirmFingerprint: 'megerősítés',
  contentHash: 'tartalmi lenyomat',
  seriesId: 'sorszámtartomány',
  seq: 'sorszámláló',
  year: 'év',
  // The kept original PDF (invoice.document) and a regenerated one (invoice.pdf_regenerated).
  kind: 'fajta',
  sha256: 'SHA-256',
  sha3_512: 'SHA3-512',
  size: 'méret',
  software: 'program',
  file: 'fájl',
  // A kept original that does not match its fingerprints (invoice.document_altered).
  storedSha256: 'tárolt SHA-256',
  storedSize: 'tárolt méret',
  logged: 'naplózott lenyomatok',
  // NAV reconciliation (nav.reconcile).
  insDate: 'a NAV-hoz érkezett',
  differences: 'eltérések',
  match: 'egyezés',
  source: 'forrás',
  via: 'mód',
  received: 'megérkezett a NAV-hoz',
  // An attempt with an unknown outcome (nav.submit.uncertain): the clock difference measured when it was made.
  clockOffsetMs: 'a gép órája a NAV órájához képest',
};

/** Fingerprints: monospaced, and allowed to wrap anywhere (they are long words). */
const HASH_KEYS: ReadonlySet<string> = new Set(['contentHash', 'sha256', 'sha3_512', 'storedSha256']);
/** Amounts, shown in the document's currency. */
const MONEY_KEYS: ReadonlySet<string> = new Set(['gross', 'amount', 'open']);
/** Internal ids the log keeps for the program (the number or the name next to them says the same). */
const HIDDEN_KEYS: ReadonlySet<string> = new Set(['submission', 'proformaId']);

const AUDIT_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  via: { submission: 'egy korábbi beküldése alapján', queryInvoiceData: 'a NAV-tól lekért számlaadat alapján' },
  match: { same: 'azonos', similar: 'egyező kulcsadatok', other: 'másik számla', none: 'nincs ilyen számla', multiple: 'több találat' },
  environment: { test: 'TESZT', production: 'éles' },
  operation: { CREATE: 'számla beküldése (CREATE)', MODIFY: 'módosítás (MODIFY)', STORNO: 'sztornó (STORNO)' },
};

/** The draft fields of an 'invoice.draft.update' entry (`fields`), in Hungarian. */
const DRAFT_FIELD_NAMES: Readonly<Record<string, string>> = {
  ...ISSUE_FIELD_LABELS,
  customerId: 'vevő',
  customer: 'vevő adatai',
  saveCustomer: 'vevő mentése',
  customerFromRecord: 'vevő a vevőlistából',
  internalNote: 'belső megjegyzés',
  paymentDays: 'fizetési határidő (nap)',
  appearance: 'megjelenési forma',
};

interface AuditContext {
  currency: string;
  seriesName: (id: string) => string | undefined;
}

function auditValue(key: string, v: unknown, c: AuditContext): string {
  if ((key === 'paymentStatus' || key === 'previousPaymentStatus') && typeof v === 'string' && Object.hasOwn(PAYMENT_STATUS, v)) return PAYMENT_STATUS[v as keyof typeof PAYMENT_STATUS].label;
  if (key === 'documentType' && typeof v === 'string' && Object.hasOwn(DOCUMENT_TYPE, v)) return DOCUMENT_TYPE[v as keyof typeof DOCUMENT_TYPE];
  if (key === 'confirmFingerprint') return 'megerősítve';
  if (key === 'kind' && v === 'original') return 'eredeti PDF';
  if ((key === 'size' || key === 'storedSize') && typeof v === 'number') return `${v} bájt`;
  if (key === 'received' && v === null) return 'nem ellenőrizhető';
  if (key === 'clockOffsetMs' && typeof v === 'number') {
    const seconds = Math.round(Math.abs(v) / 1000);
    if (seconds < 2) return 'egyezik';
    return `${seconds >= 120 ? `${Math.round(seconds / 60)} perccel` : `${seconds} másodperccel`} ${v > 0 ? 'siet' : 'késik'}`;
  }
  // A date (e.g. of a payment) the way the rest of the page writes it.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return day(v);
  if (MONEY_KEYS.has(key) && (typeof v === 'string' || typeof v === 'number')) return money(String(v), c.currency);
  if (key === 'seriesId' && typeof v === 'string') return c.seriesName(v) ?? 'archivált vagy törölt sorszámtartomány';
  if (typeof v === 'string' && AUDIT_VALUES[key]?.[v] !== undefined) return AUDIT_VALUES[key]?.[v] as string;
  if (key === 'fields' && Array.isArray(v)) return v.map((f) => (typeof f === 'string' ? (DRAFT_FIELD_NAMES[f] ?? f) : String(f))).join(', ');
  if (typeof v === 'boolean') return v ? 'igen' : 'nem';
  const text = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function auditDetails(details: Record<string, unknown>, c: AuditContext): SafeHtml {
  // An entry that names its currency (a draft, an issue) shows its amounts in it; the others (payments) in the document's.
  const own: AuditContext = typeof details.currency === 'string' ? { ...c, currency: details.currency } : c;
  const entries = Object.entries(details).filter(([k, v]) => v !== undefined && v !== '' && !HIDDEN_KEYS.has(k) && (v !== null || k === 'received'));
  return html`${entries.map(
    ([k, v], i) => html`${i > 0 ? '; ' : ''}<span class="muted">${AUDIT_KEYS[k] ?? k}:</span> ${HASH_KEYS.has(k) ? html`<span class="mono">${auditValue(k, v, own)}</span>` : auditValue(k, v, own)}`,
  )}`;
}

/** ISSUE_DATE_WILL_CHANGE in Hungarian dates: the saved draft's issue date, the one issuing gives today, and the due date. */
function issueDateText(saved: Pick<Invoice, 'issueDate' | 'dueDate' | 'dueDateExplicit'>, preview: Pick<Invoice, 'issueDate' | 'dueDate'>): string {
  const due = !saved.dueDate
    ? '.'
    : saved.dueDateExplicit === true
      ? `; a megadott fizetési határidő (${day(saved.dueDate)}) nem változik.`
      : `, a fizetési határidő ugyanennyivel eltolódik: ${day(saved.dueDate)} → ${day(preview.dueDate)}`;
  return `A piszkozat kelte ${day(saved.issueDate)}; kiállításkor a kelte a kiállítás napja (${day(preview.issueDate)}) lesz${due}`;
}

function draftSection(
  ctx: Ctx,
  inv: Invoice,
  saved: Pick<Invoice, 'seller' | 'customer' | 'issueDate' | 'dueDate' | 'dueDateExplicit'>,
  view: { issues: ValidationIssue[]; readyToIssue: boolean; chain?: CorrectionChainTotals } | null,
  viewError: unknown,
): SafeHtml {
  const lineNumbers = inv.lines.map((l) => l.lineNo);
  const proforma = inv.documentType === 'proforma';
  const editable = draftEditableInWeb(inv);
  let body: SafeHtml;
  if (!view) {
    body = sectionError(ctx, viewError);
  } else {
    const errors = view.issues.filter((i) => i.severity === 'error');
    const issues = view.issues.length > 0
      ? issuesList(view.issues, lineNumbers, { inv, fix: (field) => fixHref(inv, field), text: (i) => (i.code === 'ISSUE_DATE_WILL_CHANGE' ? issueDateText(saved, inv) : undefined) })
      : html`<p>${badge('rendben', 'ok')} A piszkozat ellenőrzése nem talált hibát.</p>`;
    // `inv` is the preview (the seller and buyer data issuing puts on it); `saved` what the draft was saved with.
    const partiesChanged = html`${canonicalJson(inv.seller) !== canonicalJson(saved.seller)
      ? flashHtml({
          tone: 'warn',
          title: 'Az eladó adatai a piszkozat mentése óta megváltoztak.',
          hint: 'Kiállításkor a Beállításokban megadott, aktuális eladói adatok kerülnek a bizonylatra; az Eladó résznél már ezek láthatók.',
        })
      : ''}${canonicalJson(inv.customer) !== canonicalJson(saved.customer)
      ? flashHtml({
          tone: 'warn',
          title: 'A vevő adatai a piszkozat mentése óta megváltoztak.',
          hint: 'Kiállításkor a Vevők között tárolt, aktuális vevőadatok kerülnek a bizonylatra; a Vevő résznél már ezek láthatók.',
        })
      : ''}`;
    if (view.readyToIssue) {
      const confirmation = mintConfirmation(ctx.st.keys, ctx.session.id, 'issue', inv.id, issueMaterial(ctx, inv), ctx.now);
      const issue = issueWording(ctx, inv, originalOf(ctx, inv));
      // No edit button in the head: say why, and what to do instead.
      const notEditable = editable ? '' : html`<p class="muted">Ez a piszkozat a webes felületen nem szerkeszthető. ${DRAFT_NOT_EDITABLE_HINT}</p>`;
      body = html`${issues}${partiesChanged}${notEditable}<form method="post" action="${`${invoiceHref(inv.id)}/issue`}" aria-label="Kiállítás megerősítése">${csrfInput(ctx)}${hiddenInput('confirmation', confirmation)}
<div class="consequences"><p>${icon('alert')} A kiállítás végleges – mi történik?</p><ul>
<li>${capital(withArticle(DOCUMENT_TYPE[inv.documentType]))} sorszámot kap, a kelte a kiállítás napja (${day(ctx.app.today())}) lesz.</li>
<li>${proforma ? 'Utána nem módosítható és nem törölhető, csak visszavonható.' : 'Utána nem módosítható és nem törölhető: hibát csak sztornó vagy módosító számlával lehet javítani.'}</li>
<li>${issue.nav}</li>${
        view.chain
          ? html`
<li>A módosító számla tételei különbözetek: a(z) ${view.chain.originalNumber} számla a módosításaival együtt eddig bruttó <strong>${money(view.chain.before.grossAmount, inv.currency)}</strong>, ezzel a módosítással bruttó <strong>${money(view.chain.after.grossAmount, inv.currency)}</strong> lesz.</li>`
          : ''
      }
</ul></div>
${kvSummary(inv)}
${markPaidField(ctx, inv)}
${checkboxField({ name: 'confirm', value: 'yes', required: true, checked: false, label: `Ellenőriztem a fenti adatokat, és kiállítom a ${proforma ? 'díjbekérőt' : 'számlát'}.` })}
<div class="actions"><button class="btn btn-primary" type="submit">${icon('check')}${issue.button}</button></div>
</form>`;
    } else {
      body = html`${issues}${partiesChanged}<p>${badge(`${errors.length} hiba`, 'err')} A piszkozat a hibák javításáig nem állítható ki.${
        editable
          ? html` <a href="${`${invoiceHref(inv.id)}/edit`}">Piszkozat szerkesztése</a>`
          : html` <span class="muted">Ez a piszkozat a webes felületen nem szerkeszthető. ${DRAFT_NOT_EDITABLE_HINT}</span>`
      }</p>`;
    }
  }
  return html`<section class="card final" aria-labelledby="h-draft"><h2 id="h-draft">Kiállítás</h2>${body}
<details class="no-print danger-zone" id="torles"><summary class="btn btn-danger-quiet">${icon('trash')}Piszkozat törlése…</summary>
<p class="muted">A piszkozat még nem számla: véglegesen törölhető, a törlés nem vonható vissza.</p>
${postForm(ctx, `${invoiceHref(inv.id)}/delete`, html`<button class="btn btn-danger" type="submit">Piszkozat végleges törlése</button>`, { label: 'Piszkozat törlése' })}
</details></section>`;
}

/** The original of a correction (draft) – for the issue wording; null for any other document or when it cannot be read. */
function originalOf(ctx: Ctx, inv: Pick<Invoice, 'reference'>): Invoice | null {
  if (!inv.reference) return null;
  const orig = attempt(() => ctx.app.getInvoice(inv.reference?.originalInvoiceId ?? ''));
  return orig.ok ? orig.value : null;
}

/** What a correction of `original` waiting for it means at issue: it is not sent now (NavWait in the issue's words). */
function correctionWaitLine(what: string, w: NavWait, configured: 'test' | 'production' | null): string {
  const n = w.originalNumber ?? w.originalId;
  if (w.reason === 'other_environment') {
    return configured === 'test'
      ? `${what} most nem kerül a NAV-hoz: az eredeti számla (${n}) az éles NAV-rendszerhez tartozik, a TESZT környezetben ez nem küldhető be.`
      : `${what} most nem kerül a NAV-hoz: az eredeti számla (${n}) csak a NAV TESZT rendszerében van, az éles rendszerbe nincs jelentve. A program az eredeti éles beküldése után küldi be.`;
  }
  return `${what} most nem kerül a NAV-hoz: a NAV a javító számlát csak az eredeti számla (${n}) sikeres jelentése után fogadja be – utána a program beküldi.`;
}

/**
 * The issue button and the NAV line of the "what happens" list: they say whether issuing also sends the
 * document to NAV (a usable connection with automatic submission – OPENSZAMLA_NAV_AUTO_SUBMIT; in the TEST environment the
 * button names the test system) or why not – also when a correction (modification, storno) of `original` would have to
 * wait for it (OpenSzamla.navCorrectionWait: e.g. the original is only in the other NAV system).
 */
function issueWording(ctx: Ctx, inv: Pick<Invoice, 'documentType'>, original: Invoice | null = null): { button: string; nav: string } {
  if (inv.documentType === 'proforma') return { button: 'Díjbekérő kiállítása (végleges)', nav: 'A díjbekérő nem számla: a NAV-nak nem jelentendő.' };
  const what = capital(DOCUMENT_TYPE[inv.documentType]);
  const nav = navConnection(ctx.app);
  const waits = nav.configured && original ? attempt(() => ctx.app.navCorrectionWait(original.id)) : null;
  if (waits?.ok && waits.value) {
    return { button: `${what} kiállítása (végleges)`, nav: correctionWaitLine(capital(withArticle(DOCUMENT_TYPE[inv.documentType])), waits.value, navEnvironmentInUse(nav)) };
  }
  if (nav.configured && nav.autoSubmit) {
    return nav.environment === 'production'
      ? { button: `${what} kiállítása és beküldése a NAV-nak`, nav: 'Kiállításkor a program azonnal beküldi a NAV-nak (éles adatszolgáltatás).' }
      : { button: `${what} kiállítása és beküldése a NAV TESZT rendszerébe`, nav: 'Kiállításkor a program azonnal beküldi a NAV TESZT rendszerébe – éles adatszolgáltatás nem történik.' };
  }
  return {
    button: `${what} kiállítása (végleges)`,
    nav: nav.configured
      ? 'Az automatikus NAV-beküldés ki van kapcsolva: a kiállítás után a bizonylat oldalán küldd be a NAV-nak.'
      : nav.problem
        ? 'A NAV-kapcsolat beállítása hibás, ezért most nem kerül a NAV-hoz: a beállítás javítása után azonnal be kell küldeni (törvényi kötelezettség).'
        : 'A NAV-kapcsolat nincs beállítva, ezért most nem kerül a NAV-hoz: a beállítás után azonnal be kell küldeni (törvényi kötelezettség).',
  };
}

/**
 * Issue form: "the buyer has paid" (markPaid – records what is still open as paid on the issue day). Offered
 * and ticked as OpenSzamla.markPaidHint says: for a document something is payable on, not a díjbekérő;
 * ticked for cash and card, the usual on-the-spot payments.
 */
function markPaidField(ctx: Ctx, inv: Invoice): HtmlValue {
  const hint = ctx.app.markPaidHint(inv);
  if (!hint) return '';
  return checkboxField({
    name: 'markPaid',
    value: 'yes',
    checked: hint === 'suggested',
    label: 'A vevő kifizette (befizetés a kiállítás napjával)',
    hint: 'Bejelölve a kiállításkor a még nyitott összeg befizetésként kerül rögzítésre, a kiállítás napjával. Készpénzes és bankkártyás fizetésnél alapból be van jelölve.',
  });
}

function kvSummary(inv: Invoice): SafeHtml {
  return kv([
    ['Vevő', inv.customer.name],
    ['Bruttó', html`<strong>${money(inv.totals.grossAmount, inv.currency)}</strong>`],
    ['Fizetendő', money(inv.totals.payableAmount, inv.currency)],
    ['Teljesítés', day(inv.fulfillmentDate)],
    ['Fizetési határidő', day(inv.dueDate)],
  ]);
}

function paymentSection(ctx: Ctx, inv: Invoice): HtmlValue {
  if (inv.status === 'draft') return '';
  if (inv.documentType === 'storno') return stornoRefundSection(ctx, inv);
  // What is still open, settled with the invoice's modifications (credit set off, overpayment carried);
  // null on an issued document: a modification of a cancelled invoice – its storno negated it, nothing is paid on it.
  const open = attempt(() => ctx.app.openAmount(inv));
  const negated = inv.status === 'issued' && open.ok && open.value === null;
  const canPay = inv.status === 'issued' && inv.paymentStatus !== 'paid' && !negated;
  // An empty amount records what the whole chain still owes (OpenSzamla.defaultPaymentAmount): say so when it is more.
  const byDefault = canPay ? attempt(() => ctx.app.defaultPaymentAmount(inv)) : null;
  const amountHint = byDefault?.ok && byDefault.value !== null && open.ok && byDefault.value !== open.value
    ? `Üresen hagyva a teljes hátralék kerül rögzítésre – a számla és módosító számlái együtt: ${money(byDefault.value, inv.currency)}.`
    : 'Üresen hagyva a teljes hátralék kerül rögzítésre.';
  // A cancelled document is not to be paid: what was paid on it is due back to the buyer (or set off elsewhere).
  const cancelled = inv.status === 'cancelled';
  const proforma = inv.documentType === 'proforma';
  // A paid, cancelled invoice: the refund to the buyer is recorded on its storno (stornoRefundSection) – linked here.
  const storno = cancelled && !proforma && inv.paymentStatus !== 'unpaid' && inv.cancelledById ? attempt(() => ctx.app.getInvoice(inv.cancelledById as string)) : null;
  const refunded = storno?.ok === true && storno.value.paymentStatus === 'paid';
  const stornoLink = storno?.ok ? html`<a href="${invoiceHref(storno.value.id)}">${storno.value.number ?? storno.value.id}</a>` : '';
  const cancelledNote: HtmlValue = !cancelled
    ? ''
    : inv.paymentStatus === 'unpaid'
      ? proforma ? 'A díjbekérőt visszavonták, nem kell kifizetni.' : 'A számlát sztornózták, nem kell kifizetni.'
      : proforma
        ? 'A díjbekérőt visszavonták: a befizetett összeg a vevőnek visszajár, vagy egy új számlába beszámítható.'
        : refunded
          ? html`A számlát sztornózták, a befizetett összeget a vevőnek visszafizették (rögzítve a(z) ${stornoLink} sztornó számlán).`
          : html`A számlát sztornózták: a befizetett összeg a vevőnek visszajár, vagy a helyette kiállított számlába beszámítható.${
              storno?.ok ? html` Mindkét esetben a(z) ${stornoLink} sztornó számlán rögzítsd visszafizetésként – beszámításnál az új számlán befizetésként is.` : ''
            }`;
  return html`<section class="card" aria-labelledby="h-pay"><h2 id="h-pay">Fizetés</h2>${kv([
    ['Állapot', paymentBadge(inv, refunded)],
    [cancelled ? 'Eredetileg fizetendő' : 'Fizetendő', money(inv.totals.payableAmount, inv.currency)],
    ['Befizetve', money(inv.paidAmount, inv.currency)],
    open.ok && open.value !== null
      ? open.value.startsWith('-') ? ['Visszafizetendő a vevőnek', money(open.value.slice(1), inv.currency)] : ['Hátralék', money(open.value, inv.currency)]
      : null,
    ['Teljes kifizetés napja', day(inv.paidDate)],
  ])}${cancelledNote ? html`<p class="muted">${cancelledNote}</p>` : ''}${negated ? html`<p class="muted">Az eredeti számlát sztornózták: a sztornó számla ezt a módosító számlát is semlegesítette, ezért rá fizetés nem rögzíthető.</p>` : ''}${
    canPay
      ? postForm(
          ctx,
          `${invoiceHref(inv.id)}/payment`,
          html`${hiddenInput('formId', OnceIds.mint())}<h3>Befizetés rögzítése</h3><div class="grid">
${inputField({ name: 'amount', label: `Összeg (${inv.currency})`, hint: amountHint, extra: { inputmode: 'decimal', autocomplete: 'off' } })}
${inputField({ name: 'date', label: 'Befizetés dátuma', type: 'date', value: ctx.app.today(), required: true })}
${checkboxField({ name: 'overpay', checked: false, label: 'Túlfizetést rögzítek', hint: 'Csak akkor jelöld be, ha a vevő valóban többet fizetett a hátraléknál: enélkül a hátraléknál nagyobb összeget a program nem rögzíti (elgépelés ellen).' })}
</div><div class="actions"><button class="btn btn-primary" type="submit">${icon('card')}Befizetés rögzítése</button></div>`,
          { label: 'Befizetés rögzítése' },
        )
      : ''
  }${reversalForm(ctx, inv, negated)}${paymentHistory(ctx, inv)}</section>`;
}

/**
 * Taking back a payment recorded by mistake (a wrong amount, the wrong invoice): on an issued document that has payments
 * of its own – also when it is fully paid, where the payment form is not shown. The amount is typed as a positive number
 * (empty: everything recorded on this document) and recorded with the opposite sign; the mistaken payment stays in the
 * history with its reversal – the ledger only grows.
 */
function reversalForm(ctx: Ctx, inv: Invoice, negated: boolean): HtmlValue {
  if (inv.status !== 'issued' || negated) return '';
  const recorded = attempt(() => ctx.app.recordedOn(inv));
  if (!recorded.ok || recorded.value === '0') return '';
  const refund = recorded.value.startsWith('-'); // a crediting document: what was recorded is a refund to the buyer
  const amount = recorded.value.replace(/^-/, '');
  const what = refund ? 'visszafizetés' : 'befizetés';
  return html`<details class="no-print"><summary class="btn btn-quiet">${icon('undo')}Téves ${what} visszavonása…</summary>${postForm(
    ctx,
    `${invoiceHref(inv.id)}/payment-reversal`,
    html`${hiddenInput('formId', OnceIds.mint())}<p class="muted">Ha egy ${what}t tévesen rögzítettél (rossz összeggel vagy rossz bizonylatra), itt vonhatod vissza. A téves tétel a visszavonásával együtt a befizetések között marad – a napló nem törölhető. Ezen a bizonylaton rögzítve: ${money(amount, inv.currency)}.</p><div class="grid">
${inputField({ name: 'amount', label: `Visszavont összeg (${inv.currency})`, hint: `Pozitív számként. Üresen hagyva az ezen a bizonylaton rögzített teljes összeg (${money(amount, inv.currency)}).`, extra: { inputmode: 'decimal', autocomplete: 'off' } })}
${inputField({ name: 'date', label: 'Visszavonás dátuma', type: 'date', value: ctx.app.today(), required: true })}
</div><div class="actions"><button class="btn" type="submit">${icon('undo')}Visszavonás rögzítése</button></div>`,
    { label: `Téves ${what} visszavonása` },
  )}</details>`;
}

/**
 * The payment history of a document (OpenSzamla.paymentHistory): the payments recorded on it and those recorded on
 * another document of its invoice chain that it received part of – the payment date, what came to this document, the
 * kind and where it comes from –, by payment date. Nothing when there is none.
 */
function paymentHistory(ctx: Ctx, inv: Invoice): HtmlValue {
  const history = attempt(() => ctx.app.paymentHistory(inv.id));
  if (!history.ok) return sectionError(ctx, history.error);
  if (history.value.length === 0) return '';
  const origin = (p: PaymentHistoryEntry): HtmlValue => {
    const source = `${PAYMENT_SOURCE_TEXT[p.source]}${p.reference ? ` (${p.reference})` : ''}`;
    if (p.recordedOn.id === inv.id) return source;
    return html`${source}, a(z) <a href="${invoiceHref(p.recordedOn.id)}">${p.recordedOn.number ?? p.recordedOn.id}</a> bizonylaton (${money(p.paymentAmount, inv.currency)})`;
  };
  return dataTable<PaymentHistoryEntry>({
    caption: 'Befizetések (a befizetés dátuma szerint)',
    rows: history.value,
    columns: [
      { label: 'Dátum', cls: 'nowrap', cell: (p) => day(p.date) },
      { label: 'Erre a bizonylatra', num: true, cell: (p) => money(p.amount, inv.currency) },
      { label: 'Fajta', cell: (p) => PAYMENT_KIND_TEXT[p.kind] },
      { label: 'Forrás', cls: 'grow', cell: origin },
    ],
  });
}

/**
 * The payment part of a storno: what the buyer paid on the cancelled invoice (and its modifications) is refunded on it.
 * Shown once that invoice received money (OpenSzamla.openAmount is not null): what was refunded, what is still to refund,
 * the refunds (paymentHistory) and, while something is still to refund, the refund form (a negative amount; empty: all of it).
 */
function stornoRefundSection(ctx: Ctx, inv: Invoice): HtmlValue {
  const open = attempt(() => ctx.app.openAmount(inv));
  if (!open.ok || open.value === null) return '';
  const toRefund = open.value.startsWith('-') ? open.value.slice(1) : '0';
  const refunded = inv.paidAmount.startsWith('-') ? inv.paidAmount.slice(1) : inv.paidAmount;
  const original = inv.reference?.originalInvoiceNumber ?? '';
  return html`<section class="card" aria-labelledby="h-pay"><h2 id="h-pay">Visszafizetés a vevőnek</h2>${kv([
    ['Visszafizetve', money(refunded, inv.currency)],
    ['Visszafizetendő a vevőnek', money(toRefund, inv.currency)],
    inv.paidDate ? ['Teljes visszafizetés napja', day(inv.paidDate)] : null,
  ])}<p class="muted">A sztornózott ${original} számlára (és módosító számláira) befizetett összeg visszafizetését ezen a sztornó számlán kell rögzíteni, negatív összeggel; ha mindet visszafizették, a számla láncának egyenlege nulla.</p>${
    inv.status === 'issued' && toRefund !== '0'
      ? postForm(
          ctx,
          `${invoiceHref(inv.id)}/payment`,
          html`${hiddenInput('formId', OnceIds.mint())}<h3>Visszafizetés rögzítése</h3><div class="grid">
${inputField({ name: 'amount', label: `Visszafizetett összeg (${inv.currency})`, hint: `Negatív összeg, pl. -${toRefund}. Üresen hagyva a teljes visszafizetendő összeg (${money(toRefund, inv.currency)}) kerül rögzítésre.`, extra: { inputmode: 'decimal', autocomplete: 'off' } })}
${inputField({ name: 'date', label: 'Visszafizetés dátuma', type: 'date', value: ctx.app.today(), required: true })}
</div><div class="actions"><button class="btn btn-primary" type="submit">${icon('card')}Visszafizetés rögzítése</button></div>`,
          { label: 'Visszafizetés rögzítése' },
        )
      : ''
  }${paymentHistory(ctx, inv)}</section>`;
}

/**
 * The NAV part of an issued document. `otherSystem`: its NAV state belongs to the other NAV system (navEnvironmentNote) –
 * the web UI never sends such an invoice, so it gets no NAV button, only what it means and how it can be sent. `wait`: a
 * correction that waits for its original (OpenSzamla.navWait) – its button could not send it either: the part says why and
 * links the original instead.
 */
function navSection(ctx: Ctx, inv: Invoice, nav: NavConnection, otherSystem: boolean, wait: NavWait | null): HtmlValue {
  if (inv.status === 'draft' || inv.documentType === 'proforma') return '';
  const configured = nav.configured;
  const waitText = wait
    ? html`<p>${navWaitText(wait, thisDocument(inv), navEnvironmentInUse(nav))} <a href="${invoiceHref(wait.originalId)}">Az eredeti számla (${wait.originalNumber ?? wait.originalId}) megnyitása</a></p>`
    : '';
  return html`<section class="card" aria-labelledby="h-nav"><h2 id="h-nav">NAV Online Számla</h2>${kv([
    ['Állapot', otherSystem ? html`${navBadge(inv.navStatus)} ${otherSystemBadge(inv)}` : navBadge(inv.navStatus)],
    inv.navTransactionId ? ['Tranzakcióazonosító', html`<span class="mono">${inv.navTransactionId}</span>`] : null,
  ])}${otherSystem ? otherSystemHelp(ctx, inv, nav) : ''}${waitText}${
    inv.navMessages.length > 0
      ? dataTable<NavMessage>({
          caption: 'A NAV üzenetei',
          rows: inv.navMessages,
          columns: [
            { label: 'Súlyosság', cell: (m) => badge(m.severity === 'ERROR' ? 'hiba' : m.severity === 'WARN' ? 'figyelmeztetés' : 'információ', m.severity === 'ERROR' ? 'err' : m.severity === 'WARN' ? 'warn' : 'info') },
            { label: 'Kód', cls: 'mono nowrap', cell: (m) => m.code },
            { label: 'Üzenet', cls: 'grow', cell: (m) => m.message },
            { label: 'Hely', cls: 'mono small', cell: (m) => m.pointer ?? '' },
          ],
        })
      : ''
  }${
    !configured
      ? html`<p class="muted">A NAV-kapcsolat nincs beállítva. A számlát a beállítás után azonnal be kell küldeni a NAV-nak – a beállítás lépései az Áttekintés oldalon (Első lépések) és a Beállítások oldalon olvashatók.</p>`
      : otherSystem || wait
        ? ''
        : postForm(
            ctx,
            `${invoiceHref(inv.id)}/nav-sync`,
            html`<p class="hint">${NAV_ACTION_HINT[inv.navStatus] ?? NAV_ACTION_HINT.pending}</p><div class="actions"><button class="btn" type="submit">${icon(inv.navStatus === 'done' || inv.navStatus === 'done_with_warnings' || inv.navStatus === 'processing' ? 'refresh' : 'send')}${navActionLabel(inv)}</button></div>`,
            { label: navActionLabel(inv) },
          )
  }</section>`;
}

/** What the NAV button of a document does, by its NAV state (the same navSync call for every state). */
const NAV_ACTION_HINT: Readonly<Partial<Record<Invoice['navStatus'], string>>> = {
  pending: 'Beküldi a bizonylatot a NAV-nak, és megvárja a NAV válaszát (legfeljebb néhány másodpercig).',
  not_configured: 'Beküldi a bizonylatot a NAV-nak, és megvárja a NAV válaszát (legfeljebb néhány másodpercig).',
  processing: 'Lekérdezi, hol tart a NAV a bizonylat feldolgozásával.',
  aborted: 'Csak a hiba javítása után küldd újra: a NAV a fenti üzenetekben írja le, mi volt a gond.',
  error: 'Csak a hiba elhárítása után küldd újra: a hiba oka a fenti üzenetekben olvasható.',
  done: 'A NAV már befogadta a bizonylatot; a gomb csak megerősíti az állapotát, újra nem küldi be.',
  done_with_warnings: 'A NAV már befogadta a bizonylatot (figyelmeztetéssel); a gomb csak megerősíti az állapotát, újra nem küldi be.',
};

/** The id of the storno part of the invoice page: a refused storno reason is shown there (Flash.section). */
const CANCEL_SECTION = 'h-cancel';

/**
 * The storno (díjbekérő: withdrawal) part. `errors`: messages about the reason last given (a refused reason): shown
 * here, above the reason field, with the part open – the preview request redirects to it (#h-cancel).
 */
function cancelSection(ctx: Ctx, inv: Invoice, errors: readonly Flash[]): HtmlValue {
  if (!cancellable(inv)) return '';
  const proforma = inv.documentType === 'proforma';
  return html`<section class="card no-print" aria-labelledby="${CANCEL_SECTION}"><h2 id="${CANCEL_SECTION}">${proforma ? 'Díjbekérő visszavonása' : 'Sztornózás'}</h2>
${proforma ? '' : html`<p>Kisebb hibát (ár, mennyiség, engedmény) módosító számlával is javíthatsz: ezt az AI-asszisztens készíti el (pl. „Az ${invoiceName(inv)} számlán adj 10% engedményt.”), a kész piszkozatot pedig itt, a webes felületen is kiállíthatod. A sztornó a teljes számlát érvényteleníti.</p>`}
<details${errors.length > 0 ? html` open` : ''}><summary class="btn btn-danger-quiet">${icon('undo')}${proforma ? 'Díjbekérő visszavonása…' : 'Sztornó számla készítése…'}</summary>
<p class="muted">${
    proforma
      ? 'A díjbekérő nem számla: visszavonáskor nem készül sztornó bizonylat.'
      : 'A sztornó számla új sorszámot kap, az eredeti számla (és módosításai) tételeit ellentétes előjellel tartalmazza, és – mint minden számla – a NAV-nak jelentendő. A művelet nem vonható vissza.'
  } Első lépésként előnézetet kérsz: az még nem végleges, a következő oldalon ellenőrizheted, és csak ott erősíted meg.</p>
${errors.map(flashHtml)}
${postForm(
    ctx,
    `${invoiceHref(inv.id)}/cancel-preview`,
    html`${inputField({ name: 'reason', label: proforma ? 'A visszavonás oka' : 'A sztornó oka (a sztornó számlára kerül)', required: true, extra: { minlength: 3, maxlength: 200 } })}<div class="actions"><button class="btn" type="submit">${proforma ? 'Visszavonás előnézete (még nem végleges)' : 'Sztornó előnézete (még nem végleges)'}</button></div>`,
    { label: proforma ? 'Visszavonás előnézete' : 'Sztornó előnézete' },
  )}
</details></section>`;
}

// ---------------------------------------------------------------------------------------------
// GET /invoices/<id>.pdf
// ---------------------------------------------------------------------------------------------

export async function invoicePdf(ctx: Ctx, id: string): Promise<void> {
  const found = attempt(() => ctx.app.getInvoice(id));
  if (!found.ok) {
    if (isNotFound(found.error)) return notFoundPage(ctx, NOT_FOUND_TEXT, BACK_TO_LIST);
    throw found.error;
  }
  const inv = found.value;
  // An issued document's kept original; a document issued before originals were kept: the regenerated file, named so.
  const r = await ctx.app.pdf(inv.id, { base64: true }, 'web');
  const name = inv.number ? `${inv.number}${r.kind === 'regenerated' ? REGENERATED_PDF_SUFFIX : ''}.pdf` : `TERVEZET_${inv.id}.pdf`;
  sendDownload(ctx.res, 'application/pdf', name, Buffer.from(r.base64 ?? '', 'base64'));
}

// ---------------------------------------------------------------------------------------------
// POST /invoices/<id>/<action>
// ---------------------------------------------------------------------------------------------

export const INVOICE_ACTIONS = ['payment', 'payment-reversal', 'nav-sync', 'delete', 'issue', 'cancel-preview', 'cancel', 'copy'] as const;
export type InvoiceAction = (typeof INVOICE_ACTIONS)[number];

export async function invoiceAction(ctx: Ctx, id: string, action: InvoiceAction): Promise<void> {
  switch (action) {
    case 'payment':
      return recordPayment(ctx, id);
    case 'payment-reversal':
      return reversePayment(ctx, id);
    case 'nav-sync':
      return navSyncOne(ctx, id);
    case 'delete':
      return deleteDraft(ctx, id);
    case 'issue':
      return issueDraft(ctx, id);
    case 'cancel-preview':
      return cancelPreview(ctx, id);
    case 'cancel':
      return cancelInvoice(ctx, id);
    case 'copy':
      return copyToDraft(ctx, id);
  }
}

/** Redirect target after a failed action: the invoice page, or the list when it does not exist. */
function backAfter(ctx: Ctx, id: string, e: unknown): void {
  redirect(ctx, isNotFound(e) ? '/invoices' : invoiceHref(id), failure(ctx, e));
}

const PAYMENT_REPEATED: Flash = {
  tone: 'info',
  title: 'Ezt a befizetést már rögzítettük, nem rögzítjük még egyszer.',
  hint: 'Az űrlap kétszer lett elküldve (pl. dupla kattintással). Újabb befizetéshez használd az oldalon lévő friss űrlapot.',
};

function recordPayment(ctx: Ctx, id: string): void {
  let amount: string;
  try {
    amount = numberInput(ctx.form.get('amount'), 'Összeg');
  } catch (e) {
    return backAfter(ctx, id, e);
  }
  const date = (ctx.form.get('date') ?? '').trim();
  const input: { amount?: string; date?: string; allowOverpayment?: boolean } = {};
  if (amount) input.amount = amount;
  if (date) input.date = date;
  if (ctx.form.has('overpay')) input.allowOverpayment = true;
  // The same rendered form must not record a payment twice (double click, re-sent POST).
  const formId = ctx.form.get('formId');
  const once = OnceIds.isWellFormed(formId) ? `${ctx.session.id}|payment|${id}|${formId}` : null;
  if (once && !ctx.st.once.claim(once, ctx.now)) return redirect(ctx, invoiceHref(id), PAYMENT_REPEATED);
  try {
    const inv = ctx.app.recordPayment(id, input, 'web');
    if (inv.documentType === 'storno') {
      // A refund of what the cancelled invoice received: what was refunded so far and what is still to refund.
      const left = ctx.app.openAmount(inv) ?? '0';
      return redirect(ctx, invoiceHref(inv.id), {
        tone: 'ok',
        title: `Visszafizetés rögzítve: eddig visszafizetve ${money(inv.paidAmount.replace(/^-/, ''), inv.currency)}, még visszafizetendő ${money(left.replace(/^-/, ''), inv.currency)}.`,
      });
    }
    redirect(ctx, invoiceHref(inv.id), {
      tone: 'ok',
      title: `Befizetés rögzítve: ${PAYMENT_STATUS[inv.paymentStatus].label} (${money(inv.paidAmount, inv.currency)} / ${money(inv.totals.payableAmount, inv.currency)}).`,
    });
  } catch (e) {
    if (once) ctx.st.once.release(once);
    backAfter(ctx, id, e);
  }
}

/** Takes back what was recorded on the document by mistake: the amount typed (positive), or all of it, with the opposite sign. */
function reversePayment(ctx: Ctx, id: string): void {
  let typed: string;
  try {
    typed = numberInput(ctx.form.get('amount'), 'Visszavont összeg');
  } catch (e) {
    return backAfter(ctx, id, e);
  }
  if (typed.startsWith('-')) {
    return redirect(ctx, invoiceHref(id), { tone: 'err', title: 'A visszavont összeget pozitív számként add meg.', hint: 'Pl. 12700 – a program a befizetéssel ellentétes előjellel rögzíti.' });
  }
  const date = (ctx.form.get('date') ?? '').trim();
  const formId = ctx.form.get('formId');
  const once = OnceIds.isWellFormed(formId) ? `${ctx.session.id}|payment-reversal|${id}|${formId}` : null;
  if (once && !ctx.st.once.claim(once, ctx.now)) return redirect(ctx, invoiceHref(id), PAYMENT_REPEATED);
  try {
    const before = ctx.app.getInvoice(id);
    const recorded = ctx.app.recordedOn(before);
    if (recorded === '0') throw new AppError('INVALID_INPUT', 'Ezen a bizonylaton nincs visszavonható befizetés.');
    const refund = recorded.startsWith('-');
    const amount = typed || recorded.replace(/^-/, '');
    const inv = ctx.app.recordPayment(id, { amount: refund ? amount : `-${amount}`, ...(date ? { date } : {}) }, 'web');
    redirect(ctx, invoiceHref(inv.id), {
      tone: 'ok',
      title: `Visszavonás rögzítve: ${PAYMENT_STATUS[inv.paymentStatus].label} (${money(inv.paidAmount, inv.currency)} / ${money(inv.totals.payableAmount, inv.currency)}).`,
    });
  } catch (e) {
    if (once) ctx.st.once.release(once);
    backAfter(ctx, id, e);
  }
}

async function navSyncOne(ctx: Ctx, id: string): Promise<void> {
  try {
    // The same time limit as the dashboard's sync: the page answers within about a minute even when NAV hangs.
    const [r] = await ctx.app.navSync({ invoiceId: id, waitSeconds: 8, budgetMs: NAV_SYNC_BUDGET_MS }, 'web');
    if (!r) return redirect(ctx, invoiceHref(id), { tone: 'info', title: 'Nincs teendő.' });
    const ok = r.navStatus === 'done' || r.navStatus === 'done_with_warnings';
    const bad = r.navStatus === 'aborted' || r.navStatus === 'error';
    // In web words (navResultText); a correction left pending says which original it waits for.
    const doc = attempt(() => ctx.app.getInvoice(id));
    const wait = r.navStatus === 'pending' && r.notProcessed === undefined ? attempt(() => ctx.app.navWait(id)) : null;
    const text = navResultText(r, navEnvironmentInUse(navConnection(ctx.app)), wait?.ok ? wait.value : null, doc.ok ? thisDocument(doc.value) : undefined);
    redirect(ctx, invoiceHref(id), {
      tone: ok && r.navStatus === 'done' ? 'ok' : bad ? 'err' : 'warn',
      title: `NAV-állapot: ${NAV_STATUS[r.navStatus].label}. ${text}`,
      lines: r.messages.slice(0, 20).map((m) => `${m.code}: ${m.message}`),
    });
  } catch (e) {
    backAfter(ctx, id, e);
  }
}

function deleteDraft(ctx: Ctx, id: string): void {
  try {
    ctx.app.deleteDraft(id, 'web');
    redirect(ctx, '/invoices', { tone: 'ok', title: 'A piszkozat törölve.' });
  } catch (e) {
    backAfter(ctx, id, e);
  }
}

async function issueDraft(ctx: Ctx, id: string): Promise<void> {
  const { app } = ctx;
  const confirmation = (ctx.form.get('confirmation') ?? '').trim();
  try {
    const inv = app.getInvoice(id);
    if (inv.status !== 'draft') {
      if (confirmedWith(ctx, inv.id, confirmation)) {
        return redirect(ctx, invoiceHref(inv.id), { tone: 'info', title: `Ez a bizonylat már ki van állítva ezzel a megerősítéssel: ${inv.number ?? inv.id}.` });
      }
      return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: `A(z) ${inv.number ?? inv.id} már ki van állítva.` });
    }
    if (ctx.form.get('confirm') !== 'yes') {
      return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: 'A kiállításhoz jelöld be a megerősítő négyzetet.', hint: 'A kiállított számla nem módosítható és nem törölhető.' });
    }
    const view = app.viewInvoice(inv.id);
    if (!view.readyToIssue) {
      return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: 'A piszkozat hibás, nem állítható ki.', hint: 'Javítsd a jelzett hibákat, majd próbáld újra.' });
    }
    if (!verifyConfirmation(ctx.st.keys, ctx.session.id, 'issue', inv.id, issueMaterial(ctx, view.invoice), confirmation, ctx.now)) {
      return redirect(ctx, invoiceHref(inv.id), {
        tone: 'err',
        title: 'A megerősítés lejárt, vagy a piszkozat időközben megváltozott.',
        hint: 'Nézd át újra az adatokat ezen az oldalon, és erősítsd meg ismét a kiállítást.',
      });
    }
    const markPaid = ctx.form.get('markPaid') === 'yes';
    const r = await app.issue(inv.id, { auditDetails: { confirmFingerprint: fingerprint(confirmation) }, ...(markPaid ? { markPaid } : {}) }, 'web');
    redirect(ctx, invoiceHref(r.invoice.id), issueResultFlash(ctx, inv, r, `Kiállítva: ${r.invoice.number ?? r.invoice.id} – ${r.invoice.customer.name}, bruttó ${money(r.invoice.totals.grossAmount, r.invoice.currency)}.`));
  } catch (e) {
    backAfter(ctx, id, e);
  }
}

/**
 * The result of issuing (or of a storno / withdrawal) in web words: the coded notes of IssueResult.notices that name MCP
 * tools or ISO dates (the new issue date, the PDF, the NAV ones) are said here, with the page or button that helps; the
 * others (the series, a carried díjbekérő payment, "the buyer has paid") as the service gives them. Without a usable NAV
 * connection the message is a warning: the invoice must still be reported. `draft`: what was issued (its due date kind).
 */
function issueResultFlash(ctx: Ctx, draft: Invoice | null, r: IssueResult, title: string): Flash {
  const nav = navConnection(ctx.app);
  const issued = r.invoice;
  const lines: string[] = [];
  let unreported: 'not_configured' | 'invalid' | null = null;
  for (const n of r.notices) {
    switch (n.code) {
      case 'ISSUE_DATE_CHANGED': {
        const due = !issued.dueDate
          ? '.'
          : draft?.dueDateExplicit === true
            ? `; a megadott fizetési határidő (${day(issued.dueDate)}) nem változott.`
            : `; a fizetési határidő ehhez igazodott: ${day(issued.dueDate)}`;
        lines.push(`A kelte a kiállítás napja (${day(issued.issueDate)}) lett${due}`);
        break;
      }
      case 'PDF_FAILED':
        lines.push('A PDF előállítása nem sikerült; a „PDF letöltése” gomb később újra megpróbálja.');
        break;
      case 'NAV_NOT_CONFIGURED':
        unreported = 'not_configured';
        break;
      case 'NAV_INVALID_CONFIG':
        unreported = 'invalid';
        break;
      case 'NAV_TEST_ENVIRONMENT':
        lines.push('TESZT környezet: a bizonylat csak a NAV tesztrendszerébe kerül, éles adatszolgáltatás nem történik.');
        break;
      case 'NAV_BUSY':
        lines.push(`Egy másik NAV-beküldés éppen fut, ezért a kiállítás nem várt rá: a bizonylat NAV-jelentése függőben van – küldd be a bizonylat oldalán, vagy az Áttekintés ${SEND_BUTTON} gombjával.`);
        break;
      case 'NAV_NOT_STARTED':
        lines.push(`A NAV-beküldés nem indult el${n.detail ? `: ${n.detail}` : '.'} A hiba elhárítása után küldd be a bizonylat oldalán.`);
        break;
      case 'NAV_NOT_SUBMITTED':
        lines.push('Az automatikus NAV-beküldés ki van kapcsolva: küldd be a bizonylatot a NAV-nak a bizonylat oldalán (NAV Online Számla rész).');
        break;
      case 'PROFORMA_WITHDRAWN':
        break;
      default:
        lines.push(n.text);
    }
  }
  if (r.nav) {
    const wait = r.nav.navStatus === 'pending' && r.nav.notProcessed === undefined ? attempt(() => ctx.app.navWait(issued.id)) : null;
    lines.push(`NAV: ${NAV_STATUS[r.nav.navStatus].label} – ${navResultText(r.nav, navEnvironmentInUse(nav), wait?.ok ? wait.value : null, thisDocument(issued))}`);
  }
  const navFailed = r.nav !== null && (r.nav.navStatus === 'aborted' || r.nav.navStatus === 'error');
  const flash: Flash = { tone: unreported || r.pdfError || navFailed ? 'warn' : 'ok', title, lines };
  if (unreported) {
    const why = unreported === 'invalid' ? 'a NAV-kapcsolat beállítása hibás' : 'nincs beállítva a NAV-kapcsolat';
    const fix = unreported === 'invalid' ? 'Javítsd a beállítást' : 'Állítsd be a kapcsolatot';
    flash.hint = `Ez a bizonylat még nincs jelentve a NAV-nak, mert ${why} – a törvény szerint azonnal jelenteni kell. ${fix} (Áttekintés → Első lépések, 2. lépés); utána az Áttekintés ${SEND_BUTTON} gombja beküldi.`;
    flash.link = { href: '/#guide-nav', label: 'NAV-kapcsolat beállítása' };
  }
  return flash;
}

const COPY_REPEATED: Flash = {
  tone: 'info',
  title: 'Ebből az űrlapból már készült piszkozat, nem készítünk még egyet.',
  hint: 'Az űrlap kétszer lett elküldve (pl. dupla kattintással). A piszkozatokat a Számlák listájában találod (Állapot: piszkozat).',
};

/**
 * POST …/copy: a new draft made from this document (createDraft copyFromId) – a díjbekérő's conversion into an invoice,
 * or a copy of an invoice –, opened in the draft form (the draft page when the web form cannot edit it). Nothing is issued.
 */
async function copyToDraft(ctx: Ctx, id: string): Promise<void> {
  const formId = ctx.form.get('formId');
  const once = OnceIds.isWellFormed(formId) ? `${ctx.session.id}|copy|${id}|${formId}` : null;
  if (once && !ctx.st.once.claim(once, ctx.now)) return redirect(ctx, '/invoices?status=draft', COPY_REPEATED);
  try {
    const src = ctx.app.getInvoice(id);
    const kind = copyKind(src);
    if (!kind) {
      if (once) ctx.st.once.release(once);
      return redirect(ctx, invoiceHref(src.id), {
        tone: 'err',
        title: 'Ebből a bizonylatból a webes felületen nem készíthető új piszkozat.',
        hint: 'Kiállított díjbekérőből számla, számlából és előlegszámlából új számla készíthető a mintájára.',
      });
    }
    const view = await ctx.app.createDraft({ copyFromId: src.id }, 'web');
    const draft = view.invoice;
    const name = src.number ?? src.id;
    const after = 'Mentés után a piszkozat oldalán ellenőrizheted, és külön lépésben, megerősítéssel állíthatod ki.';
    const flash: Flash = kind === 'convert'
      ? {
          tone: 'ok',
          title: `Számlapiszkozat készült a(z) ${name} díjbekérőből – még nem számla.`,
          lines: [
            'A teljesítés dátuma a mai nap lett: ha a teljesítés máskor történt (vagy még nem történt meg), írd át.',
            'Ha a vevő a teljesítés előtt fizetett, előlegszámla kellhet (Bizonylat típusa: előlegszámla) – ebben a könyvelőd segít.',
            'A díjbekérőre rögzített befizetés a kiállításkor átkerül a számlára; ha valamiért nem, a piszkozat oldala jelzi.',
          ],
          hint: after,
        }
      : {
          tone: 'ok',
          title: `Új piszkozat készült a(z) ${name} mintájára – még nem számla.`,
          lines: ['A teljesítés dátuma a mai nap lett, a fizetési határidő a mintáéval azonos hosszú. Nézd át és javítsd az adatokat, majd mentsd.'],
          hint: after,
        };
    redirect(ctx, draftEditableInWeb(draft) ? `${invoiceHref(draft.id)}/edit` : invoiceHref(draft.id), flash);
  } catch (e) {
    if (once) ctx.st.once.release(once);
    backAfter(ctx, id, e);
  }
}

function cancellability(inv: Invoice): string | null {
  if (inv.status === 'draft') return 'Piszkozatot nem kell sztornózni – egyszerűen töröld.';
  if (inv.status === 'cancelled') return `A(z) ${inv.number ?? inv.id} már sztornózva / visszavonva van.`;
  if (inv.documentType === 'storno' || inv.documentType === 'modification') {
    return 'Sztornó vagy módosító számlát nem lehet sztornózni; az eredeti számlát sztornózd.';
  }
  return null;
}

function reasonOf(ctx: Ctx): string {
  return (ctx.form.get('reason') ?? '').trim();
}

const REASON_ERROR: Flash = { tone: 'err', title: 'Add meg a sztornó okát (3–200 karakter).' };
const WITHDRAWAL_REASON_ERROR: Flash = { tone: 'err', title: 'Add meg a visszavonás okát (3–200 karakter).' };

function reasonError(inv: Pick<Invoice, 'documentType'>): Flash {
  return inv.documentType === 'proforma' ? WITHDRAWAL_REASON_ERROR : REASON_ERROR;
}

/** Back to the storno part of the invoice page (#h-cancel), the message about the reason shown there, the part open. */
function reasonRefused(ctx: Ctx, id: string, flash: Flash): void {
  redirect(ctx, `${invoiceHref(id)}#${CANCEL_SECTION}`, { ...flash, section: CANCEL_SECTION });
}

function cancelPreview(ctx: Ctx, id: string): void {
  const found = attempt(() => ctx.app.getInvoice(id));
  if (!found.ok) return backAfter(ctx, id, found.error);
  const inv = found.value;
  const given = reasonOf(ctx);
  const blocked = cancellability(inv);
  if (blocked) return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: blocked });
  if (given.length < 3 || given.length > 200) return reasonRefused(ctx, inv.id, reasonError(inv));
  // The reason as the storno will carry it (on one line, at least 3 visible characters – the service decides).
  const normalized = attempt(() => ctx.app.cancelReason(inv.id, given));
  if (!normalized.ok) {
    // A reason the service refuses (INVALID_INPUT: fewer than 3 visible characters) is shown at the reason field.
    if (isAppError(normalized.error) && normalized.error.code === 'INVALID_INPUT') return reasonRefused(ctx, inv.id, failure(ctx, normalized.error));
    return backAfter(ctx, inv.id, normalized.error);
  }
  const reason = normalized.value;
  const proforma = inv.documentType === 'proforma';
  // The storno negates the original together with its issued modifications: show the amount it will have.
  const planned = proforma ? null : attempt(() => ctx.app.stornoPreview(inv.id, reason));
  if (planned && !planned.ok) return backAfter(ctx, inv.id, planned.error);
  const p = planned?.value ?? null;
  const original = money(inv.totals.grossAmount, inv.currency);
  const stornoGross = p ? money(p.storno.totals.grossAmount, p.storno.currency) : '';
  const negates = p?.negates.length
    ? `az eredeti számla (bruttó ${original}) és ${p.negates.length} módosító számlája (${p.negates.map((m) => `${m.number ?? m.id}: bruttó ${money(m.totals.grossAmount, m.currency)}`).join(', ')}) együttes ellentéte`
    : 'az eredeti számla ellentéte';
  // The storno takes the invoice's current fulfilment date: after a date-correcting modification not the original's.
  const stornoFulfilment = p
    ? `${day(p.storno.fulfillmentDate)}${p.storno.fulfillmentDate === inv.fulfillmentDate ? '' : ` (javított; az eredeti számláé: ${day(inv.fulfillmentDate)})`}`
    : '';
  // A storno with errors cannot be issued: no confirmation is offered, only what to do first.
  const errors = p ? p.issues.filter((i) => i.severity === 'error').length : 0;
  const confirmation = errors ? '' : mintConfirmation(ctx.st.keys, ctx.session.id, 'cancel', inv.id, ctx.app.cancelFingerprint(inv.id, reason), ctx.now);
  renderPage(ctx, {
    title: proforma ? 'Díjbekérő visszavonása' : 'Sztornó előnézet',
    active: 'invoices',
    main: html`<div class="page-head"><div><h1>${proforma ? 'Díjbekérő visszavonása' : 'Sztornó előnézet'}: ${invoiceName(inv)}</h1><p class="sub">${inv.customer.name}</p></div></div>
<section class="card final">
<p>${
      proforma
        ? `A(z) ${invoiceName(inv)} díjbekérő visszavonásra kerül (nem számla, nincs sztornó bizonylat).`
        : `Sztornó számla készül a(z) ${invoiceName(inv)} számlához (${inv.customer.name}): bruttó ${stornoGross} – ${negates}, új sorszámmal.`
    }</p>
${p && p.issues.length ? issuesList(p.issues, p.storno.lines.map((l) => l.lineNo), { inv: p.storno }) : ''}
${kv([
  ['Ok', reason],
  ['Vevő', inv.customer.name],
  [proforma ? 'Bruttó' : 'Az eredeti számla bruttó', original],
  p ? ['A sztornó számla bruttó', stornoGross] : null,
  p ? ['A sztornó számla teljesítési dátuma', stornoFulfilment] : null,
  [proforma ? 'Kelte' : 'Az eredeti számla kelte', day(inv.issueDate)],
])}
${errors ? html`<p>${badge(`${errors} hiba`, 'err')} A sztornó most nem állítható ki: előbb a fenti hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), utána kérj új sztornó-előnézetet.</p>
<div class="actions"><a class="btn" href="${invoiceHref(inv.id)}">Vissza a számlához</a></div>` : html`<form method="post" action="${`${invoiceHref(inv.id)}/cancel`}" aria-label="Sztornó megerősítése">${csrfInput(ctx)}${hiddenInput('reason', reason)}${hiddenInput('confirmation', confirmation)}
<div class="consequences"><p>${icon('alert')} A művelet végleges – mi történik?</p><ul>${
      proforma
        ? html`<li>A díjbekérő visszavont állapotba kerül (nem számla: sztornó bizonylat nem készül, a NAV-nak nem jelentendő).</li><li>A visszavonás nem vonható vissza.</li>`
        : html`<li>Új sorszámú sztornó számla készül, az eredeti számla ezután sztornózott.</li><li>${issueWording(ctx, { documentType: 'storno' }, inv).nav}</li><li>A művelet nem vonható vissza: a sztornó számla sem módosítható és nem törölhető.</li>`
    }</ul></div>
${checkboxField({ name: 'confirm', value: 'yes', required: true, checked: false, label: proforma ? 'Visszavonom a díjbekérőt.' : 'Megértettem, hogy a művelet nem vonható vissza, és sztornózom a számlát.' })}
<div class="actions"><button class="btn btn-danger" type="submit">${icon('undo')}${proforma ? 'Díjbekérő visszavonása (végleges)' : issueWording(ctx, { documentType: 'storno' }, inv).button}</button><a class="btn btn-quiet" href="${invoiceHref(inv.id)}">${proforma ? 'Mégsem, vissza a díjbekérőhöz' : 'Mégsem, vissza a számlához'}</a></div>
</form>`}</section>`,
  });
}

async function cancelInvoice(ctx: Ctx, id: string): Promise<void> {
  const { app } = ctx;
  const reason = reasonOf(ctx);
  const confirmation = (ctx.form.get('confirmation') ?? '').trim();
  try {
    const inv = app.getInvoice(id);
    if (inv.status === 'cancelled' && confirmation) {
      const stornos = app.findInvoices({ originalInvoiceId: inv.id, documentType: ['storno'], limit: 10, offset: 0 }).items;
      const prior = stornos.find((s) => confirmedWith(ctx, s.id, confirmation));
      if (prior || (inv.documentType === 'proforma' && confirmedWith(ctx, inv.id, confirmation))) {
        const shown = prior ?? inv;
        return redirect(ctx, invoiceHref(shown.id), { tone: 'info', title: `Már végrehajtva ezzel a megerősítéssel: ${shown.number ?? shown.id}.` });
      }
    }
    const blocked = cancellability(inv);
    if (blocked) return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: blocked });
    if (ctx.form.get('confirm') !== 'yes') {
      return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: 'A sztornóhoz jelöld be a megerősítő négyzetet.', hint: 'Kérj új előnézetet a Sztornózás résznél.' });
    }
    if (reason.length < 3 || reason.length > 200) return redirect(ctx, invoiceHref(inv.id), reasonError(inv));
    // What the confirmation binds; the service checks it again inside the storno's transaction (STORNO_CHAIN_CHANGED).
    const confirmed = ctx.app.cancelFingerprint(inv.id, reason);
    if (!verifyConfirmation(ctx.st.keys, ctx.session.id, 'cancel', inv.id, confirmed, confirmation, ctx.now)) {
      return redirect(ctx, invoiceHref(inv.id), { tone: 'err', title: 'A megerősítés lejárt vagy érvénytelen.', hint: 'Kérj új sztornó-előnézetet, és erősítsd meg ismét.' });
    }
    const r = await app.cancel(inv.id, { reason, auditDetails: { confirmFingerprint: fingerprint(confirmation) }, confirmedFingerprint: confirmed }, 'web');
    const title = r.invoice.documentType === 'proforma'
      ? `Díjbekérő visszavonva: ${r.invoice.number ?? r.invoice.id}.`
      : `Sztornó számla kiállítva: ${r.invoice.number ?? r.invoice.id} (eredeti: ${inv.number ?? inv.id}).`;
    redirect(ctx, invoiceHref(r.invoice.id), issueResultFlash(ctx, null, r, title));
  } catch (e) {
    backAfter(ctx, id, e);
  }
}
