import { describe, expect, it } from 'vitest';
import { escapeHtml, html, joinHtml, SafeHtml, trustedConstant } from '../../src/web/html.ts';
import { attrs, inputField, selectField, textareaField } from '../../src/web/components.ts';

const XSS = '<script>alert(1)</script>';

describe('escapeHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&\`</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;');
    expect(escapeHtml('Árvíztűrő tükörfúrógép – 1 000 Ft')).toBe('Árvíztűrő tükörfúrógép – 1 000 Ft');
  });

  it('is not idempotent by accident (double escaping is visible)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('html`` template', () => {
  it('escapes every interpolated string and number', () => {
    const out = html`<p title="${XSS}">${XSS} ${42}</p>`;
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.html).toBe('<p title="&lt;script&gt;alert(1)&lt;/script&gt;">&lt;script&gt;alert(1)&lt;/script&gt; 42</p>');
  });

  it('cannot be broken out of a quoted attribute', () => {
    const out = html`<input value="${'" onfocus="alert(1)" x="'}">`.html;
    expect(out).toBe('<input value="&quot; onfocus=&quot;alert(1)&quot; x=&quot;">');
    expect(out).not.toContain('" onfocus');
  });

  it('does not re-escape nested templates, flattens arrays, drops null/undefined/booleans', () => {
    const items = ['a<b', 'c&d'];
    const out = html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>${null}${undefined}${false}${true}`;
    expect(out.html).toBe('<ul><li>a&lt;b</li><li>c&amp;d</li></ul>');
  });

  it('only trustedConstant / SafeHtml bypass escaping', () => {
    expect(html`${trustedConstant('<b>x</b>')}`.html).toBe('<b>x</b>');
    expect(html`${new SafeHtml('<i>y</i>')}`.html).toBe('<i>y</i>');
    expect(html`${'<b>x</b>'}`.html).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  it('joinHtml escapes items and separator', () => {
    expect(joinHtml(['<a>', html`<b>ok</b>`], ' & ').html).toBe('&lt;a&gt; &amp; <b>ok</b>');
  });
});

describe('form components escape values', () => {
  it('inputField / selectField / textareaField', () => {
    const input = inputField({ name: 'n', label: XSS, value: XSS, hint: XSS }).html;
    expect(input).not.toContain('<script>');
    expect(input).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;"');
    const select = selectField({ name: 's', label: 'x', value: XSS, options: [[XSS, XSS]] }).html;
    expect(select).not.toContain('<script>');
    expect(select).toContain('selected');
    const area = textareaField({ name: 't', label: 'x', value: `</textarea>${XSS}` }).html;
    expect(area).toContain('&lt;/textarea&gt;&lt;script&gt;');
  });

  it('attrs rejects invalid attribute names and escapes values', () => {
    expect(attrs({ title: '"x"', hidden: true, skip: false, none: undefined }).html).toBe(' title="&quot;x&quot;" hidden');
    expect(() => attrs({ 'onclick"x': 'y' })).toThrow();
  });
});
