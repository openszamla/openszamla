/** Page shell of the web UI: stylesheet, header navigation, flash messages, footer. */
import { VERSION } from '../version.ts';
import { html, trustedConstant, type SafeHtml } from './html.ts';
import { icon, type IconName } from './icons.ts';
import type { Tone } from './labels.ts';

/** A message shown once at the top of the next page (after a POST → redirect) or of the current one. */
export interface Flash {
  tone: Tone;
  title: string;
  lines?: string[];
  hint?: string;
  /** A page of the web UI that helps fixing it (`href` must be a fixed local path). */
  link?: { href: string; label: string };
  /**
   * The id of the part of the page the message is about (e.g. "h-cancel", the storno form of the invoice page): a page
   * that has that part shows the message there, next to the form it is about, instead of at the top.
   */
  section?: string;
}

export type NavKey = 'dashboard' | 'invoices' | 'new' | 'customers' | 'products' | 'export' | 'settings';

const NAV: ReadonlyArray<readonly [NavKey, string, string]> = [
  ['dashboard', '/', 'Áttekintés'],
  ['invoices', '/invoices', 'Számlák'],
  ['new', '/invoices/new', 'Új számla'],
  ['customers', '/customers', 'Vevők'],
  ['products', '/products', 'Termékek'],
  ['export', '/export', 'Export'],
  ['settings', '/settings', 'Beállítások'],
];

/**
 * Design tokens (light, and dark under prefers-color-scheme): every text colour is at least 4.5:1 on the
 * surfaces it is used on, outlines (--border-strong, --focus) at least 3:1. Spacing on a 4 px grid (rem
 * multiples of .25), radius 6/10/14 px, system fonts only. Touch: controls are at least 44 px (--tap).
 */
const CSS = `
:root{color-scheme:light dark;--bg:#f4f6f9;--surface:#fff;--surface-2:#eef1f5;--text:#1a1f29;--muted:#566174;--border:#d5dbe3;--border-strong:#7c8698;
--accent:#2456c4;--accent-hover:#1b44a0;--accent-soft:#e6eefc;--on-accent:#fff;--danger:#b3261e;--danger-hover:#8f1d17;--on-danger:#fff;--focus:#2456c4;
--ok-bg:#e5f4ea;--ok-fg:#14613a;--warn-bg:#fff3d4;--warn-fg:#6b4600;--err-bg:#fde7e6;--err-fg:#9f2219;
--info-bg:#e6eefc;--info-fg:#1d4795;--neutral-bg:#eaedf2;--neutral-fg:#454f61;
--radius-sm:6px;--radius:10px;--radius-lg:14px;--tap:2.5rem;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.07)}
@media (prefers-color-scheme:dark){:root{--bg:#0e1117;--surface:#161b23;--surface-2:#1d232e;--text:#e6e9ef;--muted:#a3acbb;--border:#2a3140;--border-strong:#6b7689;
--accent:#82a8ff;--accent-hover:#a5c0ff;--accent-soft:#14254a;--on-accent:#0e1117;--danger:#ff8f86;--danger-hover:#ffb0a9;--on-danger:#1b0d0c;--focus:#a5c0ff;
--ok-bg:#11301e;--ok-fg:#8ee0a8;--warn-bg:#382b0a;--warn-fg:#f1cd6a;--err-bg:#3b1613;--err-fg:#ffaba4;
--info-bg:#14254a;--info-fg:#aac5ff;--neutral-bg:#242a35;--neutral-fg:#c4cbd7;--shadow:none}}
@media (pointer:coarse),(max-width:640px){:root{--tap:2.75rem}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent);text-underline-offset:3px}a:hover{color:var(--accent-hover)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
svg.i{width:1.15em;height:1.15em;flex:none}
.skip{position:absolute;left:-9999px;top:0;z-index:30;padding:.75rem 1rem;background:var(--surface);color:var(--accent);border:2px solid var(--focus);border-radius:var(--radius);font-weight:700}
.skip:focus{left:1rem;top:.5rem}
.top{background:var(--surface);border-bottom:1px solid var(--border)}
.top-inner{max-width:1240px;margin:0 auto;padding:.5rem 1rem;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem}
.brand{display:inline-flex;align-items:center;min-height:var(--tap);font-weight:750;font-size:1.15rem;color:var(--text);text-decoration:none;letter-spacing:-.01em}
.brand span{color:var(--accent)}
nav.main{flex:1 1 auto;min-width:0}
nav.main ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.25rem}
nav.main a{display:flex;align-items:center;justify-content:center;gap:.25rem;min-height:var(--tap);padding:0 .75rem;border-radius:var(--radius);color:var(--muted);text-decoration:none;font-weight:600}
nav.main a:hover{background:var(--surface-2);color:var(--text)}
nav.main a.nav-new{color:var(--accent)}
nav.main a[aria-current=page]{background:var(--accent-soft);color:var(--accent);font-weight:750;box-shadow:inset 0 -3px 0 var(--accent)}
.logout{margin:0 0 0 auto}
main{display:block;max-width:1240px;margin:0 auto;padding:1.5rem 1rem 3rem}
main:focus{outline:none}
.foot{max-width:1240px;margin:0 auto;padding:0 1rem 2rem;color:var(--muted);font-size:.8125rem}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .25rem;letter-spacing:-.01em}
h2{font-size:1.15rem;line-height:1.3;margin:0 0 .75rem;scroll-margin-top:1rem}
h3{font-size:1rem;margin:1rem 0 .5rem}
p{margin:.25rem 0 .75rem}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.875em;overflow-wrap:anywhere}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:.75rem 1.5rem;margin-bottom:1.25rem}
.page-head>div:first-child{min-width:0}
.page-head .sub{margin:0;color:var(--muted)}
.page-head .badges{margin-top:.5rem}
.facts{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;margin:.5rem 0 0;color:var(--muted)}
.facts strong{color:var(--text)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.25rem 1.5rem;margin:0 0 1rem;box-shadow:var(--shadow);min-width:0}
.card>:last-child{margin-bottom:0}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1rem;margin-bottom:.75rem}
.card-head h2{margin:0}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr));gap:1rem;margin-bottom:1rem}
.cols>.card{margin:0}
.cols.flat{margin:0;gap:.25rem 1.5rem}
.muted{color:var(--muted)}.small{font-size:.8125rem}.nowrap{white-space:nowrap}
.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.85em;word-break:break-all}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -.25rem;padding:0 .25rem}
table{width:100%;border-collapse:collapse}
caption{text-align:left;font-weight:650;padding:.75rem 0 .5rem}
th,td{padding:.5rem .75rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
thead th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:650;white-space:nowrap}
tbody tr:hover{background:var(--surface-2)}
tfoot th,tfoot td{border-bottom:none;font-weight:650}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.grow{min-width:12rem}
/* Invoice tables as tables (above 1100 px, see the cards below): tighter cells, a narrower buyer column, and under the NAV
   heading the state without its "NAV:" prefix (the cards and the page head keep it). */
table.inv th,table.inv td{padding-left:.5rem;padding-right:.5rem}
table.inv td.grow{min-width:8rem}
@media (min-width:1101px){table.inv .badge .pfx{display:none}}
.empty{color:var(--muted);padding:.5rem 0;margin:0}
.empty-state{display:flex;flex-direction:column;align-items:flex-start;gap:.75rem;padding:.5rem 0}
.empty-state .empty{padding:0}
.badge{display:inline-flex;align-items:center;gap:.25rem;padding:0 .5rem;border-radius:999px;font-size:.8125rem;font-weight:650;line-height:1.6;white-space:nowrap;background:var(--neutral-bg);color:var(--neutral-fg)}
.badge svg.i{width:.95em;height:.95em}
.b-ok{background:var(--ok-bg);color:var(--ok-fg)}.b-warn{background:var(--warn-bg);color:var(--warn-fg)}
.b-err{background:var(--err-bg);color:var(--err-fg)}.b-info{background:var(--info-bg);color:var(--info-fg)}
.badges{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.flash{display:flex;gap:.75rem;align-items:flex-start;border-radius:var(--radius);border-left:4px solid currentColor;padding:.75rem 1rem;margin:0 0 1rem;background:var(--neutral-bg);color:var(--neutral-fg)}
.flash>svg.i{width:1.35em;height:1.35em;margin-top:.25rem}
.flash-body{min-width:0;flex:1}
.flash ul{margin:.25rem 0 0;padding-left:1.25rem}.flash p{margin:.25rem 0}
.flash a{color:inherit;font-weight:650}
.flash-title{font-weight:700}.flash-hint{font-size:.9rem}
.flash-ok{background:var(--ok-bg);color:var(--ok-fg)}.flash-warn{background:var(--warn-bg);color:var(--warn-fg)}
.flash-err{background:var(--err-bg);color:var(--err-fg)}.flash-info{background:var(--info-bg);color:var(--info-fg)}
.field-error{display:flex;gap:.5rem;align-items:flex-start;margin:0 0 1rem;padding:.5rem .75rem;border-radius:var(--radius);background:var(--err-bg);color:var(--err-fg);font-weight:650}
.field-error svg.i{margin-top:.25rem}
.issues{list-style:none;margin:0 0 .75rem;padding:0;display:grid;gap:.5rem}
.issues li{display:flex;gap:.5rem;align-items:baseline}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr));gap:.75rem;margin-bottom:1rem}
.stat{display:flex;flex-direction:column;gap:.25rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:.75rem 1rem;color:inherit;text-decoration:none;box-shadow:var(--shadow)}
a.stat:hover{border-color:var(--accent);background:var(--surface-2)}
.stat .v{display:block;font-size:1.6rem;font-weight:750;line-height:1.2;font-variant-numeric:tabular-nums}
.stat .k{display:block;color:var(--muted);font-size:.875rem}
a.stat .k::after{content:"\u00a0›";color:var(--accent);font-weight:750}
.stat.warn .v{color:var(--warn-fg)}.stat.err .v{color:var(--err-fg)}
dl.kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.25rem 1rem;margin:0}
dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.totals{margin:.75rem 0 0 auto;max-width:26rem}
.totals td,.totals th{border-bottom:1px dashed var(--border)}
.totals .grand th,.totals .grand td{font-size:1.1rem;border-bottom:none}
form{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14.5rem),1fr));gap:1rem}
.field{min-width:0}.field.wide{grid-column:1/-1}
dl.kv+.field,dl.kv+form{margin-top:1rem}
label{display:block;font-weight:600;font-size:.875rem;margin:0 0 .25rem}
.req{color:var(--danger)}
input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius);padding:.5rem .75rem;min-height:var(--tap)}
::placeholder{color:var(--muted);opacity:1}
textarea{min-height:4.5rem;resize:vertical}
input:focus,select:focus,textarea:focus{border-color:var(--focus)}
input[type=date]:focus-within{outline:3px solid var(--focus);outline-offset:2px}
input[type=checkbox]{width:1.25rem;height:1.25rem;min-height:0;margin:.25rem 0 0;flex:none;accent-color:var(--accent)}
.check{display:flex;gap:.75rem;align-items:flex-start}.check label{font-weight:500;font-size:.95rem;margin:0}
.hint{color:var(--muted);font-size:.8125rem;margin:.25rem 0 0}
input:disabled,select:disabled,textarea:disabled{opacity:.75;cursor:not-allowed}
.withheld{display:block;margin:.25rem 0 0;padding:.25rem .5rem;border-radius:var(--radius-sm);background:var(--warn-bg);color:var(--warn-fg);font-size:.8125rem}
fieldset{border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem 1rem;margin:0 0 1rem;min-width:0}
legend{font-weight:650;padding:0 .25rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font:inherit;font-weight:650;line-height:1.25;text-align:center;border-radius:var(--radius);border:1px solid var(--border-strong);
background:var(--surface);color:var(--text);padding:.5rem 1rem;min-height:var(--tap);cursor:pointer;text-decoration:none}
.btn:hover{background:var(--surface-2);border-color:var(--accent);color:var(--text)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn-primary:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--on-accent)}
.btn-danger{background:var(--danger);border-color:var(--danger);color:var(--on-danger)}
.btn-danger:hover{background:var(--danger-hover);border-color:var(--danger-hover);color:var(--on-danger)}
.btn-danger-quiet{background:var(--surface);border-color:var(--danger);color:var(--danger)}
.btn-danger-quiet:hover{background:var(--err-bg);border-color:var(--danger);color:var(--err-fg)}
.btn-quiet{background:transparent;border-color:transparent;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.btn-quiet:hover{background:var(--surface-2);border-color:transparent;color:var(--accent-hover)}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:1rem}
.actions form{display:inline}
.action-bar,.page-head>.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:flex-end;margin-top:0}
.form-actions{position:sticky;bottom:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:1rem 0 0;padding:.75rem 0;background:var(--surface);border-top:1px solid var(--border)}
main>form>.form-actions{padding:.75rem 1rem;border:1px solid var(--border-strong);border-radius:var(--radius-lg);box-shadow:0 -4px 16px rgba(16,24,40,.12)}
html{scroll-padding-bottom:6rem}
.form-actions .hint{margin:0}
details>summary{cursor:pointer;font-weight:650;display:flex;align-items:center;gap:.5rem;min-height:var(--tap);list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸";font-size:.9em}
details[open]>summary::before{content:"▾"}
details>summary.btn{display:inline-flex}
details>summary.btn::before{content:none}
details[open]>summary{margin-bottom:.75rem}
details>summary h2{margin:0;font-size:inherit;font-weight:inherit;line-height:inherit}
.grid+details{margin-top:1rem}
.filters{margin-bottom:1rem}
.filters details{margin-top:.75rem}
.pager{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;margin-top:1rem}
.lines-table input,.lines-table select{min-width:5.5rem}
.lines-table td{padding:.25rem;border-bottom:none}
.lines-table .c-desc{min-width:15rem}.lines-table .c-desc input,.lines-table .c-desc select{min-width:15rem}
.desc-cell{display:grid;gap:.25rem}
.lines-table .c-no{color:var(--muted);text-align:right;padding-top:.75rem}
.login-wrap{max-width:28rem;margin:3rem auto 0}
.notes{margin:0;padding-left:1.25rem}.notes li+li{margin-top:.25rem}
.guide{border-color:var(--accent)}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:.75rem;counter-reset:step}
.step{display:grid;grid-template-columns:2.5rem minmax(0,1fr);gap:.25rem 1rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.step::before{counter-increment:step;content:counter(step);grid-row:1/span 4;display:flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:750}
.step.done::before{background:var(--ok-bg);color:var(--ok-fg)}
.step.next{border-color:var(--accent)}
.step-title{margin:0;font-weight:700;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.step p{margin:0}
.step .actions{margin-top:.5rem}
.step ol{margin:.25rem 0 0;padding-left:1.25rem}
.cmd{display:block;margin:.5rem 0;padding:.75rem 1rem;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);font-size:.8125rem;white-space:pre;overflow-x:auto;overflow-wrap:normal}
.cmd-alt{margin:.5rem 0 0}
.copy-row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.final{border-left:4px solid var(--warn-fg)}
.consequences{margin:.75rem 0 1rem;padding:.75rem 1rem;border-radius:var(--radius);background:var(--warn-bg);color:var(--warn-fg)}
.consequences p{margin:0;font-weight:700}
.consequences ul{margin:.25rem 0 0;padding-left:1.25rem}
.danger-zone{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)}
@media (max-width:760px){.top-inner{gap:0 .75rem}.brand{order:1}.logout{order:2}nav.main{order:3;flex:1 0 100%;padding-bottom:.25rem}
nav.main ul{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
nav.main a{padding:0 .25rem;font-size:.875rem;line-height:1.2;text-align:center}nav.main a svg.i{display:none}
.page-head{flex-direction:column}.action-bar,.page-head>.actions{justify-content:flex-start}}
@media (max-width:640px){body{font-size:14.5px}h1{font-size:1.35rem}main{padding:1.25rem 1rem 3rem}.card{padding:1rem}
dl.kv{grid-template-columns:1fr;gap:0}dl.kv dd{margin-bottom:.5rem}
main a:not(.btn):not(.stat){display:inline-block;padding:.25rem 0}input[type=checkbox]{width:1.5rem;height:1.5rem;margin:.75rem 0 0}
.check label{display:flex;align-items:center;min-height:var(--tap)}
.actions .btn,.action-bar .btn{flex:1 1 auto}
.actions form.head-form{display:flex;flex:1 1 auto}
table.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.stack,table.stack tbody,table.stack tr{display:block}
table.stack tr{padding:.5rem 0;border-bottom:1px solid var(--border)}
table.stack tbody tr:hover{background:none}
table.stack td{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;border:none;padding:.25rem 0;text-align:right;white-space:normal;min-width:0}
table.stack td::before{content:attr(data-label);flex:none;color:var(--muted);font-size:.8125rem;text-align:left}
table.stack td>.cv{min-width:0;overflow-wrap:anywhere}
table.stack caption{display:block}
table.stack td.small{display:block;text-align:left}
table.stack td.small::before{display:block}
.issues li{flex-wrap:wrap}
.lines-table.stack td{display:grid;grid-template-columns:6.5rem minmax(0,1fr);align-items:center;text-align:left;padding:.25rem 0}
.lines-table.stack td.c-no{display:block;padding-top:.5rem;font-weight:650;color:var(--text)}
.lines-table.stack td.c-no::before{content:none}
.lines-table.stack input,.lines-table.stack select,.lines-table .c-desc,.lines-table .c-desc input{min-width:0}
.step{grid-template-columns:minmax(0,1fr)}.step::before{grid-row:auto}
main>form>.form-actions{margin:1rem -.5rem 0;padding:.75rem}.form-actions .btn{flex:1 1 auto}.form-actions .hint{display:none}
.page-head>.actions>.action-bar{flex:1 1 100%}}
/* The invoice lists – number, buyer, amount, three badges, two dates – are cards below 1100 px as on a phone: a tablet, a
   small laptop or half of a full-HD screen would otherwise scroll them sideways. After the phone rules, so these win there. */
@media (max-width:1100px){table.inv thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.inv,table.inv tbody,table.inv tr{display:block}
table.inv caption{display:block}
table.inv tbody tr{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;padding:.75rem 0;border-bottom:1px solid var(--border);position:relative}
table.inv tbody tr:hover{background:none}
table.inv td{display:block;border:none;padding:0;text-align:left;white-space:normal;min-width:0}
table.inv td::before{content:none}
table.inv td>.cv{min-width:0;overflow-wrap:anywhere}
table.inv .dash{display:none}
table.inv td.c-no{order:1;flex:1 1 auto}
table.inv td.c-gross{order:2;margin-left:auto;font-weight:700;text-align:right}
table.inv td.c-cust{order:3;flex:1 0 100%}
table.inv td.c-st,table.inv td.c-pay,table.inv td.c-nav{order:4}
table.inv td.c-date{order:5;color:var(--muted);font-size:.8125rem;margin-right:.5rem}
table.inv td.c-date::before{content:attr(data-label) ": ";display:inline;font-size:.8125rem}
table.inv tbody tr::after{content:"";order:4;flex-basis:100%;height:0}
table.inv td.c-no a::after{content:"";position:absolute;inset:0}
table.inv td.c-no br{display:none}
table.inv td.c-no .small{margin-left:.5rem}}
@media print{.top,.foot,.no-print,form,.skip,.action-bar{display:none!important}body{background:#fff;color:#000}.card{border:none;box-shadow:none;padding:0}}
`;

function navHtml(active: NavKey | null, csrf: string): SafeHtml {
  return html`<header class="top"><div class="top-inner">
<a class="brand" href="/">Open<span>Számla</span></a>
<nav class="main" aria-label="Főmenü"><ul>${NAV.map(
    ([key, href, label]) =>
      html`<li><a href="${href}"${key === 'new' ? html` class="nav-new"` : ''}${key === active ? html` aria-current="page"` : ''}>${key === 'new' ? icon('plus') : ''}${label}</a></li>`,
  )}</ul></nav>
<form class="logout" method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn-quiet" type="submit">${icon('logout')}Kilépés</button></form>
</div></header>`;
}

/** The header of the logged-out pages (login, errors before authentication): the name only. */
const BRAND_ONLY = html`<header class="top"><div class="top-inner"><span class="brand">Open<span>Számla</span></span></div></header>`;

const FLASH_ICON: Readonly<Record<Tone, IconName>> = { ok: 'check', warn: 'alert', err: 'alert', info: 'info', neutral: 'info' };

export function flashHtml(f: Flash): SafeHtml {
  return html`<div class="flash flash-${f.tone}" role="${f.tone === 'err' ? 'alert' : 'status'}">${icon(FLASH_ICON[f.tone])}<div class="flash-body"><p class="flash-title">${f.title}</p>${
    f.lines && f.lines.length > 0 ? html`<ul>${f.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ''
  }${f.hint ? html`<p class="flash-hint">${f.hint}</p>` : ''}${f.link ? html`<p class="flash-hint"><a href="${f.link.href}">${f.link.label}</a></p>` : ''}</div></div>`;
}

export interface DocumentOptions {
  nonce: string;
  title: string;
  /** null → logged-out shell (no navigation). */
  csrf: string | null;
  active?: NavKey | null;
  flashes?: Flash[];
  main: SafeHtml;
  /** Inline script – a constant from the page module, never data. */
  script?: string;
}

export function documentHtml(o: DocumentOptions): SafeHtml {
  return html`<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${o.title} – OpenSzámla</title>
<link rel="icon" href="data:,">
<style nonce="${o.nonce}">${trustedConstant(CSS)}</style>
</head>
<body>
<a class="skip" href="#main">Ugrás a tartalomra</a>
${o.csrf === null ? BRAND_ONLY : navHtml(o.active ?? null, o.csrf)}
<main id="main" tabindex="-1">
${(o.flashes ?? []).map(flashHtml)}
${o.main}
</main>
<footer class="foot">OpenSzámla ${VERSION} – nyílt forráskódú számlázó program</footer>
${o.script ? html`<script nonce="${o.nonce}">${trustedConstant(o.script)}</script>` : ''}
</body>
</html>`;
}
