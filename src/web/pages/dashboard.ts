/**
 * "/" – overview: the first-run guide while the setup is incomplete, seller, NAV connection, counts, next
 * steps, this month, receivables, latest documents. On a first run (nothing issued, no draft) only the guide
 * and the seller / NAV cards.
 */
import type { OpenSzamla, SetupTodo, SetupTodoCode } from '../../service/app.ts';
import { badge, checkboxField, dataTable, day, emptyState, huf, invoiceTable, overdueAmong, postForm, refundedAmong, timestamp, vatLabel } from '../components.ts';
import { attempt, failure, redirect, renderPage, sectionError, type Ctx } from '../context.ts';
import { html, type HtmlValue, type SafeHtml } from '../html.ts';
import { icon } from '../icons.ts';
import type { Flash } from '../layout.ts';
import { NAV_STATUS } from '../labels.ts';
import { navResultText, SEND_BUTTON, thisDocument } from '../nav-text.ts';
import { COPY_SCRIPT, navSetupHelp, setupGuide } from '../setup-guide.ts';

export interface NavConnection {
  /** Usable: credentials given and valid. */
  configured: boolean;
  environment: 'test' | 'production' | null;
  source: 'env' | 'file' | null;
  autoSubmit: boolean;
  /** Why the given settings cannot be used (never contains a credential). */
  problem: string | null;
}

/** NAV connection summary for display: environment and source only – never any credential. */
export function navConnection(app: OpenSzamla): NavConnection {
  const nav = app.config.nav;
  const problem = nav ? app.config.navProblem : null;
  return { configured: nav !== null && problem === null, environment: nav?.environment ?? null, source: nav?.source ?? null, autoSubmit: app.config.navAutoSubmit, problem };
}

/** The NAV system the program reports to now (null without a usable connection). */
export function navEnvironmentInUse(c: NavConnection): 'test' | 'production' | null {
  return c.configured ? c.environment : null;
}

export function navConnectionBadge(c: NavConnection): SafeHtml {
  if (c.problem) return badge('hibás beállítás', 'err');
  if (!c.configured) return badge('nincs beállítva', 'warn');
  return c.environment === 'production' ? badge('ÉLES környezet', 'ok') : badge('TESZT környezet', 'info');
}

function stat(href: string, value: number, label: string, tone: '' | 'warn' | 'err' = ''): SafeHtml {
  return html`<a class="stat${tone ? ` ${tone}` : ''}" href="${href}"><span class="v">${value}</span><span class="k">${label}</span></a>`;
}

/** To-dos the dashboard's "Függő számlák beküldése a NAV-nak" button acts on (with its resubmit box for the rejected ones). */
const SENDABLE: ReadonlySet<SetupTodoCode> = new Set<SetupTodoCode>(['NAV_PENDING', 'NAV_PROCESSING', 'NAV_NOT_REPORTED', 'NAV_DUPLICATE', 'NAV_REJECTED', 'NAV_CHECK_BLOCKED']);

interface TodoItem {
  text: HtmlValue;
  link?: { href: string; label: string };
}

/** "SZ-2026-00002, SZ-2026-00003 és további 4" – a number is never broken at its hyphens. */
function numberList(t: SetupTodo): SafeHtml {
  return html`${(t.numbers ?? []).map((n, i) => html`${i > 0 ? ', ' : ''}<span class="nowrap">${n}</span>`)}${t.more ? ` és további ${t.more}` : ''}`;
}

/**
 * A to-do of status() in the words of the web UI, with the page part, list or button that does it. `canSend`: the NAV
 * card offers the send button; `guideNav`: the first-run guide shows the NAV setup step.
 */
function todoItem(t: SetupTodo, o: { nav: NavConnection; canSend: boolean; guideNav: boolean }): TodoItem {
  const setup = o.guideNav ? { href: '#guide-nav', label: 'NAV-kapcsolat beállítása…' } : { href: '/settings#h-nav', label: 'NAV-beállítás megnyitása' };
  const where = o.guideNav ? 'Első lépések, 2. lépés' : 'Beállítások, NAV Online Számla kapcsolat';
  const send = o.canSend ? { link: { href: '#h-nav', label: 'Függő számlák beküldése a NAV-nak…' } } : {};
  const production = o.nav.environment === 'production';
  switch (t.code) {
    case 'SELLER_MISSING':
      return { text: 'Add meg az eladó (saját céged) adatait: név, adószám, cím, ÁFA-státusz és bankszámla – ezek kerülnek minden számlára.', link: { href: '/settings#h-seller', label: 'Eladó adatainak megadása' } };
    case 'SELLER_INVALID':
      return { text: `Az eladói adatok között ${t.count} hibát javítani kell a számlázás előtt.`, link: { href: '/settings#h-seller', label: 'Eladói adatok javítása' } };
    case 'NAV_NOT_CONFIGURED':
      return { text: 'A NAV-kapcsolat nincs beállítva: a kiállított számlákat a törvény szerint azonnal jelenteni kell a NAV-nak.', link: setup };
    case 'NAV_INVALID_CONFIG':
      return { text: `A NAV-kapcsolat beállítása hibás, ezért a program egyetlen számlát sem tud jelenteni: ${t.problem ?? ''}`, link: setup };
    case 'NAV_TEST_ENVIRONMENT':
      return {
        text: 'TESZT környezet: a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás nem történik. Valódi számlázás előtt állítsd át élesre – a parancsot a Beállítások oldal NAV részén másolhatod.',
        link: { href: '/settings#h-nav', label: 'NAV-beállítás megnyitása' },
      };
    case 'NAV_PAUSE': {
      const why = t.pauseCode === 'MAINTENANCE_MODE' ? ' karbantartás miatt' : t.pauseCode === 'TOO_MANY_REQUESTS' ? ' forgalomkorlátozás miatt' : '';
      return { text: `A NAV${why} szünetet kért: a program legkorábban ${timestamp(t.until)}-kor fordul hozzá újra, addig nem küld be és nem kérdez le semmit. Utána kattints a ${SEND_BUTTON} gombra.` };
    }
    case 'NAV_REJECTED':
      return {
        text: `${t.count} számla jelentését a NAV elutasította, vagy végleges hibával zárult: nyisd meg, olvasd el a NAV üzenetét, hárítsd el az okát, majd a számla oldalán küldd újra.`,
        link: { href: '/invoices?nav=problem', label: 'NAV-problémás számlák' },
      };
    case 'NAV_CHECK_BLOCKED':
      return {
        text:
          `${t.count} számla jelentését a program nem tudja egyeztetni a NAV-val, mert a NAV lekérdezése végleges hibát ad: ${(t.reasons ?? []).join('; ')}. Amíg ez fennáll, nem küldi be újra őket. ` +
          `Hárítsd el a hibát (a technikai felhasználó jogosultságai és adatai: onlineszamla.nav.gov.hu), majd küldd be újra a ${SEND_BUTTON} gombbal, „Az elutasított / hibás számlák újraküldése is” jelölővel.`,
        link: { href: '/invoices?nav=problem', label: 'NAV-problémás számlák' },
      };
    case 'NAV_NUMBER_COLLISION':
      return {
        text:
          `${t.count} számla sorszáma a NAV-nál egy másik számláé (sorszám-ütközés): ezek nincsenek jelentve, és a módosító/sztornó számlájuk sem küldhető be. Valószínű ok: egy régebbi mentés visszaállítása, ` +
          `vagy egy másik számlázó program ugyanezzel a sorszámtartománnyal. A teendőt a számlák NAV-üzenetei írják le; a rendezéséhez kérj segítséget (könyvelő).${
            t.nextNumbers?.length ? ` A következő kiadandó sorszám: ${t.nextNumbers.join(', ')} – ellenőrizd a NAV felületén, hogy szabad-e.` : ''
          }`,
        link: { href: '/invoices?nav=problem', label: 'NAV-problémás számlák' },
      };
    case 'NAV_HELD_BY_REJECTED_ORIGINAL':
      return { text: html`${t.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${numberList(t)}) NAV-jelentése elutasítva vagy hibás: hárítsd el az eredeti számla hibáját, és küldd újra – utána ezek is beküldésre kerülnek.` };
    case 'NAV_HELD_BY_COLLISION_ORIGINAL':
      return { text: html`${t.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${numberList(t)}) sorszáma a NAV-nál egy másik számláé (sorszám-ütközés): az újraküldés nem segít, a teendőt az eredeti számla NAV-üzenetei írják le (könyvelő).` };
    case 'NAV_HELD_BY_BLOCKED_ORIGINAL':
      return { text: html`${t.count} módosító/sztornó számla nem jelenthető, mert az eredeti számla (${numberList(t)}) NAV-jelentését a program nem tudja egyeztetni a NAV-val (${(t.reasons ?? []).join('; ')}): a hiba elhárítása után ezek is beküldésre kerülnek.` };
    case 'NAV_OTHER_ENVIRONMENT':
      return production
        ? {
            text: html`${t.count} számla csak a NAV TESZT rendszerébe került, az éles rendszerbe nincs jelentve (${numberList(t)}). Ha valamelyik valódi számla, a számla oldalán olvasható, hogyan küldheted be – a webes felület (a ${SEND_BUTTON} gomb sem) nem teszi meg helyetted.`,
            link: { href: '/invoices?nav=other', label: 'A számlák megnyitása' },
          }
        : { text: html`${t.count} számla az éles NAV-rendszerbe került (${numberList(t)}): a TESZT környezetben ezekkel nincs teendő.`, link: { href: '/invoices?nav=other', label: 'A számlák megnyitása' } };
    case 'NAV_HELD_BY_OTHER_ENVIRONMENT':
      return production
        ? { text: `${t.count} sztornó/módosító számla az eredeti számla éles beküldésére vár (az eredeti csak a TESZT rendszerben van); a webes felület ezeket addig nem küldi be.` }
        : { text: `${t.count} sztornó/módosító számla eredeti számlája az éles NAV-rendszerhez tartozik, ezért a TESZT környezetben nem küldhető be.` };
    case 'NAV_DUPLICATE':
      return { text: `${t.count} számla beküldését a NAV ismétlésként utasította el: a ${SEND_BUTTON} gomb egyezteti a NAV-val.`, ...send };
    case 'NAV_NOT_REPORTED':
      return o.nav.configured
        ? { text: `${t.count} kiállított számla még nincs jelentve a NAV-nak, mert kiállításakor nem volt használható NAV-kapcsolat: a ${SEND_BUTTON} gomb mindet beküldi.`, ...send }
        : { text: `${t.count} kiállított számla még nincs jelentve a NAV-nak, mert nincs NAV-kapcsolat. A beállítás után (${where}) a ${SEND_BUTTON} gomb mindet beküldi.`, link: setup };
    case 'NAV_PENDING':
      return { text: `${t.count} számla jelentésre vár: küldd be a ${SEND_BUTTON} gombbal.`, ...send };
    case 'NAV_PROCESSING':
      return { text: `${t.count} számla feldolgozása a NAV-nál folyamatban: a ${SEND_BUTTON} gomb lekérdezi az állapotukat.`, ...send };
  }
}

export function dashboardPage(ctx: Ctx): void {
  const { app } = ctx;
  const today = app.today();
  const monthStart = `${today.slice(0, 7)}-01`;
  const seller = attempt(() => app.getSeller());
  const status = attempt(() => app.status());
  const nav = navConnection(app);
  const env = navEnvironmentInUse(nav);
  const counts = status.ok ? status.value.counts : null;
  const todos = status.ok ? status.value.todos : [];
  // The first-run guide (seller, NAV, first customer, first invoice) while any of them is open.
  const guide = seller.ok && status.ok
    ? setupGuide({ seller: seller.value, sellerIssues: status.value.sellerIssues, nav, counts: status.value.counts, dataDir: app.config.dataDir })
    : null;
  // A first run – nothing issued, no draft: only the guide and the seller / NAV cards (no zero counts, no empty tables).
  const firstRun = counts !== null && counts.issued === 0 && counts.drafts === 0;
  const report = firstRun ? null : attempt(() => app.report({ from: monthStart, to: today }));
  const overdue = firstRun ? null : attempt(() => app.findInvoices({ overdueOn: today, sort: 'issued_asc', limit: 5, offset: 0 }));
  const latest = firstRun ? null : attempt(() => app.findInvoices({ sort: 'created_desc', limit: 5, offset: 0 }));

  const sellerCard = !seller.ok
    ? sectionError(ctx, seller.error)
    : seller.value
      ? html`<p><strong>${seller.value.name}</strong></p><p class="muted">Adószám: ${seller.value.taxNumber || '–'}<br>${seller.value.address.postalCode} ${seller.value.address.city}, ${seller.value.address.addressLine}</p>${
          status.ok && status.value.sellerIssues.length > 0
            ? html`<p>${badge(`${status.value.sellerIssues.length} javítandó adat`, 'warn')} <a href="/settings#h-seller">Eladói adatok javítása</a></p>`
            : ''
        }`
      : html`<p>${badge('nincs beállítva', 'warn')}</p><p>Számlát csak az eladó (saját cég) adatainak megadása után lehet kiállítani – lásd az Első lépések 1. lépését.</p>`;

  // The send button only where it can do something: not for corrections that wait for an original, nor for the other
  // NAV system's invoices (those are sent only with an explicit confirmation, never from here).
  const canSend = !status.ok || todos.some((t) => SENDABLE.has(t.code));
  const held = todos.some((t) => t.code.startsWith('NAV_HELD_BY_'));
  const navCard = html`<p>${navConnectionBadge(nav)}${nav.configured ? html` <span class="muted small">${nav.autoSubmit ? 'kiállításkor automatikus beküldés' : 'beküldés kézzel, az alábbi gombbal'}</span>` : ''}</p>${
    nav.configured
      ? canSend
        ? postForm(
            ctx,
            '/nav-sync',
            html`<p class="hint">Beküldi a még nem jelentett számlákat, és lekérdezi a feldolgozás alatt állók állapotát.</p>${checkboxField({ name: 'resubmitFailed', label: 'Az elutasított / hibás számlák újraküldése is (csak a hiba javítása után)', checked: false })}<div class="actions"><button class="btn" type="submit">${icon('send')}Függő számlák beküldése a NAV-nak</button></div>`,
            { label: 'Függő számlák beküldése a NAV-nak' },
          )
        : counts && counts.navOtherEnvironment > 0 && nav.environment === 'production'
          ? html`<p>${counts.navOtherEnvironment} számla csak a NAV TESZT rendszerébe került – az éles rendszerbe nincs jelentve. A számla oldalán olvasható, hogyan küldheted be. <a href="/invoices?nav=other">A számlák megnyitása</a></p>`
          : held
            ? html`<p class="muted">Most nincs beküldhető NAV-jelentés: a függő javító számlák az eredeti számlájukra várnak (lásd a Teendőket).</p>`
            : html`<p class="muted">Nincs függő NAV-jelentés.</p>`
      : guide?.navOpen
        ? html`<p>${nav.problem ? 'A NAV-kapcsolat beállítása hibás: amíg nem javul, a program egyetlen számlát sem tud jelenteni.' : 'A kiállított számlákat a törvény szerint azonnal jelenteni kell a NAV-nak.'} A beállítás lépései: <a href="#guide-nav">Első lépések, 2. lépés</a>.</p>`
        : navSetupHelp(app.config.dataDir, 'card-nav', { problem: nav.problem })
  }${nav.configured && nav.environment === 'test' ? html`<p class="muted small">TESZT környezet: a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás nem történik.</p>` : ''}`;

  // NAV-probléma: rejected or failed reports only; an invoice issued without a usable connection waits (a tile of its own).
  const problems = counts ? counts.navProblems - counts.navNotConfigured : 0;
  const statsSection = firstRun
    ? html``
    : counts
      ? html`<div class="stats">
${stat('/invoices?status=draft', counts.drafts, 'piszkozat')}
${stat('/invoices?status=issued_or_cancelled', counts.issued, 'kiállított bizonylat')}
${stat('/invoices?payment=receivable', counts.unpaid, 'nyitott (fizetetlen) számla', counts.unpaid > 0 ? 'warn' : '')}
${stat('/invoices?nav=inprogress', counts.navPending, `NAV: ${NAV_STATUS.pending.label} / folyamatban`, counts.navPending > 0 ? 'warn' : '')}
${
  counts.navNotConfigured > 0
    ? nav.configured
      ? stat('/invoices?nav=not_configured', counts.navNotConfigured, 'NAV-ra vár – a kapcsolat beállítása előtt kiállítva', 'warn')
      : stat(guide?.navOpen ? '#guide-nav' : '/settings#h-nav', counts.navNotConfigured, 'NAV-ra vár – a kapcsolat még nincs beállítva')
    : ''
}
${stat('/invoices?nav=problem', problems, 'NAV-probléma', problems > 0 ? 'err' : '')}
${
  counts.navOtherEnvironment > 0
    ? nav.environment === 'production'
      ? stat('/invoices?nav=other', counts.navOtherEnvironment, 'csak a TESZT rendszerben jelentve', 'warn')
      : stat('/invoices?nav=other', counts.navOtherEnvironment, 'az éles rendszerben jelentve (itt nincs teendő)')
    : ''
}
${stat('/customers', counts.customers, 'vevő')}
${stat('/products', counts.products, 'termék / szolgáltatás')}
</div>`
      : status.ok
        ? html``
        : sectionError(ctx, status.error);

  // The service's to-dos in web words, without those the open guide steps already explain.
  const covered = (t: SetupTodo): boolean =>
    (guide?.sellerOpen === true && (t.code === 'SELLER_MISSING' || t.code === 'SELLER_INVALID')) ||
    (guide?.navOpen === true && (t.code === 'NAV_NOT_CONFIGURED' || t.code === 'NAV_INVALID_CONFIG')) ||
    (guide?.shown === true && t.code === 'NAV_TEST_ENVIRONMENT');
  const items = todos.filter((t) => !covered(t)).map((t) => todoItem(t, { nav, canSend: nav.configured && canSend, guideNav: guide?.navOpen === true }));
  const steps = items.length > 0
    ? html`<section class="card" aria-labelledby="h-steps"><h2 id="h-steps">Teendők</h2><ul class="notes todos">${items.map(
        (i) => html`<li>${i.text}${i.link ? html` <a href="${i.link.href}">${i.link.label}</a>` : ''}</li>`,
      )}</ul></section>`
    : html``;

  const reportError = !report || report.ok ? null : sectionError(ctx, report.error);
  const monthCard = report?.ok
    ? html`<dl class="kv">
<dt>Időszak</dt><dd>${day(report.value.from)} – ${day(report.value.to)} (kelte szerint)</dd>
<dt>Kiállított számlák</dt><dd>${report.value.invoiceCount} db</dd>
<dt>Nettó</dt><dd>${huf(report.value.totalsHuf.net)}</dd>
<dt>ÁFA</dt><dd>${huf(report.value.totalsHuf.vat)}</dd>
<dt>Bruttó</dt><dd><strong>${huf(report.value.totalsHuf.gross)}</strong></dd>
</dl>${report.value.notes.map((n) => html`<p class="hint">${n}</p>`)}${
        report.value.byVatCode.length > 0
          ? dataTable({
              caption: 'ÁFA-kódonként (Ft)',
              rows: report.value.byVatCode,
              columns: [
                { label: 'ÁFA-kód', cell: (r) => vatLabel(r.vatCode) },
                { label: 'Nettó', num: true, cell: (r) => huf(r.net) },
                { label: 'ÁFA', num: true, cell: (r) => huf(r.vat) },
                { label: 'Bruttó', num: true, cell: (r) => huf(r.gross) },
              ],
            })
          : ''
      }${
        report.value.topCustomers.length > 0
          ? dataTable({
              caption: 'Legnagyobb vevők',
              rows: report.value.topCustomers.slice(0, 5),
              columns: [
                { label: 'Vevő', cls: 'grow', cell: (c) => c.name },
                { label: 'Db', num: true, cell: (c) => c.count },
                { label: 'Bruttó (Ft)', num: true, cell: (c) => huf(c.gross) },
              ],
            })
          : ''
      }`
    : reportError;

  const receivablesCard = report?.ok
    ? html`<dl class="kv">
<dt>Nyitott számlák</dt><dd>${report.value.receivables.unpaidCount} db · ${huf(report.value.receivables.unpaidGrossHuf)}</dd>
<dt>Ebből lejárt</dt><dd>${report.value.receivables.overdueCount > 0 ? badge(`${report.value.receivables.overdueCount} db`, 'err') : '0 db'} · ${huf(report.value.receivables.overdueGrossHuf)}</dd>
</dl><p class="hint">A darabszám a fizetendő (pozitív végösszegű), nem rendezett számláké; az összeg a hátralékuk a módosító számláikkal együtt (a jóváírás beszámítva, a túlfizetés átvezetve).</p><div class="actions"><a class="btn" href="/invoices?payment=receivable">Nyitott számlák</a><a class="btn" href="/invoices?overdue=1">Lejárt számlák</a></div>`
    : reportError;

  const tableOpts = { navEnvironment: env };
  const overdueSection = !overdue
    ? html``
    : overdue.ok
      ? overdue.value.items.length > 0
        ? html`<section class="card" aria-labelledby="h-overdue"><h2 id="h-overdue">Lejárt határidejű számlák</h2>${invoiceTable(overdue.value.items, { ...tableOpts, overdue: new Set(overdue.value.items.map((i) => i.id)) })}${
            overdue.value.total > overdue.value.items.length ? html`<p><a href="/invoices?overdue=1">Mind a(z) ${overdue.value.total} lejárt számla</a></p>` : ''
          }</section>`
        : html``
      : html`<section class="card"><h2>Lejárt határidejű számlák</h2>${sectionError(ctx, overdue.error)}</section>`;

  const sellerReady = seller.ok && seller.value !== null;
  const latestSection = !latest
    ? html``
    : html`<section class="card" aria-labelledby="h-latest"><h2 id="h-latest">Legutóbbi bizonylatok</h2>${
        latest.ok
          ? latest.value.items.length > 0
            ? html`${invoiceTable(latest.value.items, { ...tableOpts, overdue: overdueAmong(ctx, latest.value.items), refunded: refundedAmong(ctx, latest.value.items) })}<p><a href="/invoices">${
                latest.value.total > latest.value.items.length ? `Mind a(z) ${latest.value.total} bizonylat` : 'Összes bizonylat'
              }</a></p>`
            : emptyState('Még nincs bizonylat.', sellerReady ? { href: '/invoices/new', label: 'Új számla készítése' } : undefined)
          : sectionError(ctx, latest.error)
      }</section>`;

  const sellerName = seller.ok && seller.value ? seller.value.name : null;
  // One primary action: the guide's next step while it is shown; no new invoice before the seller exists.
  const newInvoice = sellerReady ? html`<a class="btn${guide?.shown ? '' : ' btn-primary'}" href="/invoices/new">${icon('plus')}Új számla készítése</a>` : '';
  renderPage(ctx, {
    title: 'Áttekintés',
    active: 'dashboard',
    ...(guide?.navOpen || !nav.configured ? { script: COPY_SCRIPT } : {}),
    main: html`<div class="page-head"><div><h1>Áttekintés</h1><p class="sub">${sellerName ?? 'Az eladó még nincs beállítva'} · ${day(today)}</p></div>
<div class="action-bar">${newInvoice}</div></div>
${guide?.html ?? ''}
<div class="cols">
<section class="card" aria-labelledby="h-seller"><h2 id="h-seller">Eladó</h2>${sellerCard}</section>
<section class="card" aria-labelledby="h-nav"><h2 id="h-nav">NAV Online Számla</h2>${navCard}</section>
</div>
${statsSection}
${steps}
${
  firstRun
    ? ''
    : html`<div class="cols">
<section class="card" aria-labelledby="h-month"><h2 id="h-month">E havi forgalom</h2>${monthCard}</section>
<section class="card" aria-labelledby="h-recv"><h2 id="h-recv">Kintlévőség</h2>${receivablesCard}</section>
</div>`
}
${overdueSection}
${latestSection}`,
  });
}

/**
 * The time limit of one NAV sync of the web UI (NavRunOptions.budgetMs) – the dashboard's "Függő számlák beküldése a
 * NAV-nak" and the NAV button of an invoice: the page answers within about a minute.
 */
export const NAV_SYNC_BUDGET_MS = 60_000;

/** POST /nav-sync – reports every pending invoice (service: navSync). */
export async function navSyncAll(ctx: Ctx): Promise<void> {
  let flash: Flash;
  try {
    const results = await ctx.app.navSync({ waitSeconds: 8, resubmitFailed: ctx.form.has('resubmitFailed'), budgetMs: NAV_SYNC_BUDGET_MS }, 'web');
    const env = navEnvironmentInUse(navConnection(ctx.app));
    const done = results.filter((r) => r.navStatus === 'done' || r.navStatus === 'done_with_warnings').length;
    const left = results.filter((r) => r.notProcessed !== undefined).length;
    const lines = results.slice(0, 20).map((r) => {
      // A correction left pending waits for its original: the result says for which one and why.
      const wait = r.navStatus === 'pending' && r.notProcessed === undefined ? attempt(() => ctx.app.navWait(r.invoiceId)) : null;
      const doc = wait?.ok && wait.value ? attempt(() => ctx.app.getInvoice(r.invoiceId)) : null;
      return `${r.number ?? r.invoiceId}: ${NAV_STATUS[r.navStatus].label} – ${navResultText(r, env, wait?.ok ? wait.value : null, doc?.ok ? thisDocument(doc.value) : undefined)}`;
    });
    // A double click is harmless: the service runs one sync at a time and never sends an invoice twice.
    const test = ctx.app.config.nav?.environment === 'test' ? ' a NAV TESZT rendszerébe (éles adatszolgáltatás NEM történt)' : '';
    const rest = left > 0 ? ` ${left} számlához ez a futás nem fordult a NAV-hoz (lásd a megjegyzéseket) – később kattints újra a ${SEND_BUTTON} gombra.` : '';
    flash = {
      tone: results.every((r) => r.navStatus === 'done' || r.navStatus === 'done_with_warnings') ? 'ok' : 'warn',
      title: results.length === 0 ? 'Nincs beküldendő számla.' : `${results.length} számla feldolgozva, ebből ${done} sikeresen jelentve${test}.${rest}`,
      lines,
    };
  } catch (e) {
    flash = failure(ctx, e);
  }
  redirect(ctx, '/', flash);
}
