/**
 * Auto-escaping HTML templates for the web UI.
 *
 * `html\`<p>${value}</p>\`` escapes every interpolated value unless it is already a SafeHtml (the
 * result of another html`` template). Rules for templates (keep them, the escaping relies on it):
 * - attribute values are always double-quoted: <a href="${url}">;
 * - never interpolate into <script> or <style> bodies, event handler attributes or unquoted contexts;
 * - URLs in href/action are built from fixed paths plus validated ids or encodeURIComponent'ed values,
 *   never from free user text (no "javascript:" URLs possible).
 */

export class SafeHtml {
  readonly html: string;

  constructor(markup: string) {
    this.html = markup;
  }

  toString(): string {
    return this.html;
  }
}

export type HtmlValue = SafeHtml | string | number | bigint | boolean | null | undefined | readonly HtmlValue[];

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.html;
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return (value as readonly HtmlValue[]).map(render).join('');
  return escapeHtml(String(value));
}

/** Tagged template: static parts are trusted, every interpolated value is escaped (see the file comment). */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** Joins fragments (each escaped unless SafeHtml) with an optional separator. */
export function joinHtml(items: readonly HtmlValue[], separator: HtmlValue = ''): SafeHtml {
  const sep = render(separator);
  return new SafeHtml(items.map(render).join(sep));
}

/**
 * Marks a constant string as markup. ONLY for compile-time constants defined in this module tree
 * (e.g. the stylesheet) – never pass request data or stored data to it.
 */
export function trustedConstant(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
