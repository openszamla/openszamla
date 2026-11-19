/**
 * U10: the phone layout (≤ 640 px). Table captions take the full width; an invoice card opens anywhere on it (the number
 * link is stretched over the card), shows the document type next to the number and the two dates together on a muted
 * line of their own; a validation row wraps its badge and text; the log's details read left-aligned under their label.
 * The draft form's product list and name share the name cell; a copy / conversion button stretches like the others.
 * On every width: the dashboard's eight tiles fit in one desktop row and a tile's "›" never stands alone on a line; a
 * date field focused from the keyboard (its date or its calendar button) gets the same 3 px focus ring as the other
 * controls; a control reached with Tab is scrolled clear of the sticky save bar instead of being hidden under it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

/** The page's stylesheet. */
async function styles(): Promise<string> {
  const e = await startWeb();
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  const body = (await (await e.loggedIn()).get('/')).body;
  return body.slice(body.indexOf('<style'), body.indexOf('</style>'));
}

/** The rules of the phone media query of the page's stylesheet. */
async function phoneRules(): Promise<string> {
  const css = await styles();
  const start = css.indexOf('@media (max-width:640px){');
  return css.slice(start, css.indexOf('@media (max-width:1100px){', start));
}

/** The rules that make the invoice lists cards up to 1100 px (a phone, a tablet, a small or half-screen window). */
async function invoiceCardRules(): Promise<string> {
  const css = await styles();
  const start = css.indexOf('@media (max-width:1100px){');
  expect(start, 'the invoice card block comes after the phone rules (so it wins there)').toBeGreaterThan(css.indexOf('@media (max-width:640px){'));
  return css.slice(start, css.indexOf('@media print', start));
}

describe('the phone layout', () => {
  it('captions, cards, validation rows, the log and the head buttons', async () => {
    const css = await phoneRules();
    for (const rule of ['table.stack caption{display:block}', '.issues li{flex-wrap:wrap}', 'table.stack td.small{display:block;text-align:left}', '.actions form.head-form{display:flex;flex:1 1 auto}']) {
      expect(css, rule).toContain(rule);
    }
    // An invoice card opens anywhere on it, shows the type next to the number and the two dates on a muted line.
    const cards = await invoiceCardRules();
    for (const rule of [
      'table.inv tbody tr{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;padding:.75rem 0;border-bottom:1px solid var(--border);position:relative}',
      'table.inv td.c-no a::after{content:"";position:absolute;inset:0}',
      'table.inv tbody tr::after{content:"";order:4;flex-basis:100%;height:0}',
      'table.inv td.c-no br{display:none}',
      'table.inv td.c-date{order:5;color:var(--muted);font-size:.8125rem;margin-right:.5rem}',
    ]) {
      expect(cards, rule).toContain(rule);
    }
    // The second date is no longer pushed in by a margin of its own.
    expect(css + cards).not.toContain('table.inv td.c-date+td.c-date{margin-left:.5rem}');
  });

  it('the invoice lists are cards up to 1100 px; as a table above that, the NAV column drops the "NAV:" before the state', async () => {
    const cards = await invoiceCardRules();
    expect(cards).toContain('@media (max-width:1100px){table.inv thead{position:absolute;');
    const css = await styles();
    expect(css).toContain('@media (min-width:1101px){table.inv .badge .pfx{display:none}}');
    expect(css).toContain('table.inv th,table.inv td{padding-left:.5rem;padding-right:.5rem}');
  });
});

describe('every width', () => {
  it('the tiles share one row, their "›" keeps to the last word; focus: the date field ring, clear of the save bar', async () => {
    const css = await styles();
    expect(css).toContain('.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,8.5rem),1fr));');
    // A no-break space before the arrow: "termék / szolgáltatás ›" wraps before "szolgáltatás", not before "›".
    expect(css).toContain('a.stat .k::after{content:"\u00a0›";');
    // The date field's own parts (the date and the calendar button) take the focus: :focus-visible does not mark the
    // field itself.
    expect(css).toContain('input[type=date]:focus-within{outline:3px solid var(--focus);outline-offset:2px}');
    // The save bar (.form-actions) sticks to the bottom of the window: the browser scrolls a focused control at least
    // 6rem above the bottom edge, so the bar (about 4.5rem high) never covers it.
    expect(css).toContain('.form-actions{position:sticky;bottom:0;');
    expect(css).toContain('html{scroll-padding-bottom:6rem}');
  });
});
