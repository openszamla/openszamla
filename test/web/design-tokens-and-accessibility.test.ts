/**
 * The page shell and the stylesheet keep the design rules: colour tokens for light and dark with WCAG AA
 * contrast for every text pair, no colour outside the tokens, spacing on the 4 px grid, at least 44 px
 * controls on touch, a visible focus ring, the skip link first, the current page marked in the navigation
 * (not by colour alone), text on every badge, and no external resource (the program works offline).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  return e;
}

function cssOf(body: string): string {
  const m = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(body);
  if (!m?.[1]) throw new Error('no stylesheet');
  return m[1];
}

/** The custom properties of the first `:root{…}` block after `from` in the stylesheet. */
function tokens(css: string, from = 0): Map<string, string> {
  const start = css.indexOf(':root{', from);
  const block = css.slice(start + 6, css.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+):([^;]+)/g)) if (m[1] && m[2]) out.set(m[1], m[2].trim());
  return out;
}

function luminance(hex: string): number {
  const h = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

/** Text colour → the backgrounds it is used on. */
const TEXT_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['text', ['bg', 'surface', 'surface-2']],
  ['muted', ['bg', 'surface', 'surface-2']],
  ['accent', ['bg', 'surface', 'surface-2', 'accent-soft']],
  // Hover states: links and quiet buttons (--accent-hover), hovered count tiles (--warn-fg / --err-fg on --surface-2).
  ['accent-hover', ['bg', 'surface', 'surface-2']],
  ['danger', ['bg', 'surface']],
  ['on-accent', ['accent', 'accent-hover']],
  ['on-danger', ['danger', 'danger-hover']],
  ['ok-fg', ['ok-bg', 'surface']],
  ['warn-fg', ['warn-bg', 'surface', 'surface-2']],
  ['err-fg', ['err-bg', 'surface', 'surface-2']],
  ['info-fg', ['info-bg']],
  ['neutral-fg', ['neutral-bg']],
];

describe('design tokens', () => {
  it('light and dark: every text pair is at least 4.5:1, outlines and the focus ring at least 3:1', async () => {
    const e = await env();
    const css = cssOf((await (await e.loggedIn()).get('/')).body);
    const light = tokens(css);
    const darkAt = css.indexOf('@media (prefers-color-scheme:dark)');
    expect(darkAt).toBeGreaterThan(0);
    const dark = new Map([...light, ...tokens(css, darkAt)]);
    for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
      for (const [fg, bgs] of TEXT_PAIRS) {
        for (const bg of bgs) {
          const ratio = contrast(theme.get(fg) ?? '', theme.get(bg) ?? '');
          expect(ratio, `${name}: --${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const line of ['border-strong', 'focus']) {
        for (const bg of ['bg', 'surface']) expect(contrast(theme.get(line) ?? '', theme.get(bg) ?? ''), `${name}: --${line} on --${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('colours only through the tokens, spacing on the 4 px grid, nothing loaded from elsewhere', async () => {
    const e = await env();
    const css = cssOf((await (await e.loggedIn()).get('/')).body);
    // Hex colours appear only in the token blocks (shadows use rgba(); print is plain black on white).
    const outsideTokens = css.replace(/:root\{[^}]*\}/g, '').replace(/@media print\{[\s\S]*$/, '');
    expect(outsideTokens.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    for (const m of css.matchAll(/(?:^|[;{])\s*(margin|padding|gap|row-gap|column-gap)(?:-[a-z]+)?:([^;}]+)/g)) {
      for (const v of (m[2] ?? '').trim().split(/\s+/)) {
        if (v === '0' || v === 'auto' || v === '!important') continue;
        const n = /^(-?\d*\.?\d+)(rem|px)$/.exec(v);
        expect(n, `${m[1]}: ${v}`).not.toBeNull();
        const px = Number(n?.[1]) * (n?.[2] === 'rem' ? 16 : 1);
        expect(Math.abs(px) % 4, `${m[1]}: ${v} is off the 4 px grid`).toBe(0);
      }
    }
    expect(css).not.toMatch(/@import|url\(|https?:/);
  });

  it('touch: controls are at least 44 px; the focus ring is 3 px; hidden really hides', async () => {
    const e = await env();
    const css = cssOf((await (await e.loggedIn()).get('/')).body);
    expect(css).toContain('@media (pointer:coarse),(max-width:640px){:root{--tap:2.75rem}}');
    for (const rule of ['.btn{', 'input,select,textarea{', 'nav.main a{', 'details>summary{']) {
      const at = css.indexOf(rule);
      expect(at, rule).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf('}', at)), rule).toContain('min-height:var(--tap)');
    }
    expect(css).toContain(':focus-visible{outline:3px solid var(--focus);outline-offset:2px}');
    expect(css).toContain('[hidden]{display:none!important}');
  });
});

describe('page shell', () => {
  it('skip link first, the current page marked once (bold, bar, aria-current), the new-invoice item highlighted', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const pages = [['/', '/'], ['/invoices', '/invoices'], ['/invoices/inv_00000000a1', '/invoices'], ['/invoices/new', '/invoices/new'], ['/customers', '/customers'], ['/products', '/products'], ['/export', '/export'], ['/settings', '/settings']] as const;
    for (const [path, current] of pages) {
      const body = (await b.get(path)).body;
      const afterBody = body.slice(body.indexOf('<body>'));
      expect(afterBody.indexOf('<a class="skip" href="#main">Ugrás a tartalomra</a>'), path).toBe('<body>\n'.length);
      expect(body, path).toContain('<main id="main" tabindex="-1">');
      expect(body.match(/aria-current="page"/g) ?? [], path).toHaveLength(1);
      expect(body, path).toMatch(new RegExp(`<a href="${current.replace(/[/]/g, '\\/')}"(?: class="nav-new")? aria-current="page">`));
    }
    const css = cssOf((await b.get('/')).body);
    expect(css).toMatch(/nav\.main a\[aria-current=page\]\{[^}]*font-weight:750;[^}]*box-shadow:inset 0 -3px 0 var\(--accent\)/);
    expect((await b.get('/')).body).toMatch(/<a href="\/invoices\/new" class="nav-new"><svg class="i"[^>]*aria-hidden="true" focusable="false"[^>]*>.*?<\/svg>Új számla<\/a>/);
  });

  it('badges carry text next to the icon shape; icons are hidden from screen readers; no inline style or handler', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const body = (await b.get('/invoices')).body;
    for (const m of body.matchAll(/<span class="badge b-(\w+)"[^>]*>([\s\S]*?)<\/span>/g)) {
      const text = (m[2] ?? '').replace(/<svg[\s\S]*?<\/svg>/g, '').trim();
      expect(text.length, `badge ${m[1]}`).toBeGreaterThan(0);
    }
    for (const svg of body.match(/<svg\b[^>]*>/g) ?? []) expect(svg).toContain('aria-hidden="true"');
    expect(body).not.toMatch(/\sstyle="/);
    expect(body).not.toMatch(/\son[a-z]+="/);
  });

  it('the logged-out pages show the name only – no navigation, no logout', async () => {
    const e = await env();
    const login = await e.browser().get('/login');
    expect(login.body).toContain('<header class="top"><div class="top-inner"><span class="brand">Open<span>Számla</span></span></div></header>');
    expect(login.body).not.toContain('aria-label="Főmenü"');
    expect(login.body).not.toContain('action="/logout"');
    expect(login.body).toContain('A legegyszerűbb a program indításakor kiírt teljes belépési címet');
  });
});
