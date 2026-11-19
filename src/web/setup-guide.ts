/**
 * First-run guide of the dashboard ("Első lépések"): seller data, NAV connection (test first), first
 * customer, first invoice – each step's state comes from setup_status (OpenSzamla.status) and the NAV
 * connection summary; the actions are the existing pages and forms. The NAV credentials are never entered
 * here: the guide shows the nav-setup command to run on the machine of the program.
 */
import type { SellerProfile, ValidationIssue } from '../core/types.ts';
import { navSetupCommandLine } from '../service/config.ts';
import { html, type SafeHtml } from './html.ts';
import { icon } from './icons.ts';
import { badge } from './components.ts';
import type { NavConnection } from './pages/dashboard.ts';

/** Copies the text of the element named by a button's data-copy attribute (the buttons are hidden without it). */
export const COPY_SCRIPT = `(function () {
  if (!navigator.clipboard) return;
  document.querySelectorAll('button[data-copy]').forEach(function (btn) {
    var target = document.getElementById(btn.getAttribute('data-copy'));
    var status = btn.parentNode ? btn.parentNode.querySelector('[role=status]') : null;
    if (!target) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText((target.textContent || '').trim()).then(function () {
        if (status) status.textContent = 'A parancs a vágólapra került.';
      }, function () {
        if (status) status.textContent = 'A másolás nem sikerült: jelöld ki a parancsot, és másold ki kézzel.';
      });
    });
  });
})();`;

/**
 * The nav-setup command for this data directory (optionally switching to production): the service's own form
 * (navSetupCommandLine – --data-dir only for another data directory than the built-in one), the one the README, the
 * user doc, openszamla setup and openszamla doctor give too.
 */
function setupCommand(dataDir: string, env?: 'production'): string {
  return navSetupCommandLine(dataDir, env);
}

/**
 * A command in its own block, selectable, with a copy button (shown by COPY_SCRIPT; the page must carry it). The block
 * never breaks a command inside a word: a long one scrolls sideways, and the copy button copies it whole.
 */
export function commandBlock(id: string, command: string): SafeHtml {
  return html`<code class="cmd" id="${id}">${command}</code><span class="copy-row"><button class="btn btn-quiet" type="button" data-copy="${id}" hidden>${icon('copy')}Parancs másolása</button><span class="hint" role="status" aria-live="polite"></span></span>`;
}

/**
 * How to set up the NAV connection, in steps a non-developer can follow: one command to run, its npx form folded away
 * for when the command is not found. `id` makes the element ids unique on the page. Used by the first-run guide, the
 * dashboard's NAV card and the settings page.
 */
export function navSetupHelp(dataDir: string, id: string, opts: { problem?: string | null } = {}): SafeHtml {
  return html`${opts.problem ? html`<p class="field-error">${icon('alert')}<span>A NAV-kapcsolat beállítása hibás, ezért a program egyetlen számlát sem tud jelenteni: ${opts.problem}</span></p>` : ''}
<p>A kiállított számlákat a törvény szerint azonnal jelenteni kell a NAV-nak. Ehhez egy NAV <strong>technikai felhasználó</strong> kell, amelyet egyszer kell beállítani:</p>
<ol>
<li>Lépj be a NAV Online Számla rendszerébe (onlineszamla.nav.gov.hu – előbb a <strong>teszt</strong>, valódi számlázás előtt az éles rendszerben), és hozz létre technikai felhasználót aláíró- és cserekulccsal.</li>
<li>Egy új terminálablakban (az <code>openszamla serve</code> ablakát hagyd nyitva) futtasd ezt a parancsot, és add meg a kért adatokat – a jelszót és a kulcsokat a program gépeléskor rejtve kéri be; alapból a TESZT környezetet állítja be:${commandBlock(`${id}-cmd`, setupCommand(dataDir))}
<details class="cmd-alt"><summary>Ha az „openszamla” parancs nem található</summary><p class="hint">Telepítés nélkül (vagy ha a parancs nincs az elérési úton) ugyanez <code>npx -y</code> előtaggal is működik:</p>${commandBlock(`${id}-npx`, `npx -y ${setupCommand(dataDir)}`)}</details></li>
<li>A beállítás után frissítsd ezt az oldalt.</li>
</ol>
<p class="hint">A hitelesítő adatok (jelszó, aláíró- és cserekulcs) biztonsági okból nem a webes felületen adhatók meg, és semmilyen oldalon nem jelennek meg.</p>`;
}

export type StepState = 'done' | 'todo' | 'fix';

interface Step {
  title: string;
  state: StepState;
  body: SafeHtml;
  action: { href: string; label: string } | null;
  /** The step's element id, for the links to it (the NAV step: "#guide-nav"). */
  id?: string;
}

const STATE: Readonly<Record<StepState, readonly [string, 'ok' | 'warn' | 'err']>> = {
  done: ['kész', 'ok'],
  todo: ['teendő', 'warn'],
  fix: ['javítandó', 'err'],
};

export interface GuideInput {
  seller: SellerProfile | null;
  sellerIssues: readonly ValidationIssue[];
  nav: NavConnection;
  counts: { customers: number; issued: number; drafts: number };
  dataDir: string;
}

export interface Guide {
  /** The guide card; null when every step is done. */
  html: SafeHtml | null;
  /** Steps still open – the dashboard leaves out the service's to-dos they already cover. */
  sellerOpen: boolean;
  navOpen: boolean;
  /** The guide's next step has the page's primary button. */
  shown: boolean;
}

export function setupGuide(g: GuideInput): Guide {
  const sellerErrors = g.sellerIssues.filter((i) => i.severity === 'error').length;
  const sellerState: StepState = !g.seller ? 'todo' : sellerErrors > 0 ? 'fix' : 'done';
  const navState: StepState = g.nav.configured ? 'done' : g.nav.problem ? 'fix' : 'todo';
  const steps: Step[] = [
    {
      title: 'Eladó (saját céged) adatai',
      state: sellerState,
      body: sellerState === 'todo'
        ? html`<p>Állítsd be az eladó adatait: név, adószám, cím, bankszámla és ÁFA-státusz. Ezek kerülnek minden számlára.</p>`
        : sellerState === 'fix'
          ? html`<p>Az eladói adatok között ${sellerErrors} hibát javítani kell a számlázás előtt.</p>`
          : html`<p>Megadva: ${g.seller?.name ?? ''}${g.seller?.name.endsWith('.') ? '' : '.'}</p>`,
      action: sellerState === 'done' ? null : { href: '/settings#h-seller', label: sellerState === 'fix' ? 'Eladói adatok javítása' : 'Eladó adatainak megadása' },
    },
    {
      title: 'NAV Online Számla kapcsolat – először a TESZT rendszerrel',
      state: navState,
      body: navState === 'done'
        ? g.nav.environment === 'production'
          ? html`<p>Beállítva: ÉLES környezet – a kiállított számlák a NAV-hoz kerülnek.</p>`
          : html`<p>Beállítva: TESZT környezet – a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás nem történik. Valódi számlázás előtt állítsd éles környezetre:</p>${commandBlock('guide-prod', setupCommand(g.dataDir, 'production'))}`
        : navSetupHelp(g.dataDir, 'guide-nav', { problem: g.nav.problem }),
      action: null,
      id: 'guide-nav',
    },
    {
      title: 'Első vevő',
      state: g.counts.customers > 0 ? 'done' : 'todo',
      body: g.counts.customers > 0
        ? html`<p>Kész: ${g.counts.customers} vevő elmentve.</p>`
        : html`<p>Vedd fel az első vevődet (cég, külföldi partner vagy magánszemély). A vevőt a számla készítésekor is megadhatod – elmentve legközelebb csak kiválasztod a listából.</p>`,
      action: g.counts.customers > 0 ? null : { href: '/customers?new=1#h-new', label: 'Első vevő felvétele' },
    },
    {
      title: 'Első számla',
      state: g.counts.issued > 0 ? 'done' : 'todo',
      body: g.counts.issued > 0
        ? html`<p>Kész: ${g.counts.issued} bizonylat kiállítva.</p>`
        : html`<p>Készíts piszkozatot (vevő, tételek, dátumok). A mentés még nem számla: a kiállítás külön lépés, ellenőrzéssel és megerősítéssel.${
            g.counts.drafts > 0 ? ` Már van ${g.counts.drafts} piszkozatod – nyisd meg, nézd át, és állítsd ki.` : ''
          }${sellerState === 'todo' ? ' Előbb az eladó adatait add meg (1. lépés).' : ''}</p>`,
      action: g.counts.issued > 0 || sellerState === 'todo'
        ? null
        : g.counts.drafts > 0
          ? { href: '/invoices?status=draft', label: 'Piszkozatok megnyitása' }
          : { href: '/invoices/new', label: 'Első számla elkészítése' },
    },
  ];
  const open = steps.filter((s) => s.state !== 'done').length;
  if (open === 0) return { html: null, sellerOpen: false, navOpen: false, shown: false };
  const next = steps.findIndex((s) => s.state !== 'done');
  // The primary button: the first open step that can be done here (the NAV setup runs outside the web UI).
  const primary = steps.findIndex((s) => s.state !== 'done' && s.action !== null);
  const title = g.counts.issued === 0 ? 'Első lépések' : 'Beállítás befejezése';
  const card = html`<section class="card guide" aria-labelledby="h-guide"><div class="card-head"><h2 id="h-guide">${title}</h2><span class="muted">${steps.length - open} / ${steps.length} lépés kész</span></div>
<ol class="steps">${steps.map((s, i) => {
    const [label, tone] = STATE[s.state];
    return html`<li class="step${s.state === 'done' ? ' done' : ''}${i === next ? ' next' : ''}"${s.id ? html` id="${s.id}"` : ''}><p class="step-title">${s.title} ${badge(label, tone)}</p>${s.body}${
      s.action ? html`<div class="actions"><a class="btn${i === primary ? ' btn-primary' : ''}" href="${s.action.href}">${s.action.label}</a></div>` : ''
    }</li>`;
  })}</ol></section>`;
  return { html: card, sellerOpen: sellerState !== 'done', navOpen: navState !== 'done', shown: true };
}
