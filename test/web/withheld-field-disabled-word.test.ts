/**
 * S4: a form control whose value contains a secret is disabled (so the browser never posts the "[rejtett]" mask
 * back) also when the word "disabled" stands inside one of its attribute values – the check looks for the
 * attribute outside the quoted values, so a value like "Account disabled until <secret>" no longer passes for
 * an already disabled control.
 */
import { describe, expect, it } from 'vitest';
import { html } from '../../src/web/html.ts';
import { REDACTED, redactSecrets } from '../../src/web/security.ts';

const SECRET = 'NAVpassword123';
const NOTE = '<span class="withheld" role="note">';

describe('the disabled attribute is looked for outside the attribute values', () => {
  it('an <input> whose value says "disabled" is still disabled', () => {
    for (const value of [`Account disabled until ${SECRET}`, `${SECRET} disabled=yes`, `disabled ${SECRET}`]) {
      const out = redactSecrets(String(html`<form><input name="website" value="${value}"></form>`), [SECRET]);
      expect(/<input[^>]*>/.exec(out)?.[0], value).toMatch(/\sdisabled>$/);
      expect(out).toContain(NOTE);
      expect(out).not.toContain(SECRET);
    }
  });

  it('also when another attribute (double- or single-quoted) holds the word', () => {
    const page = `<form><input title="was disabled once" placeholder='be disabled here' name="email" value="info@${SECRET}.hu"><textarea name="note" title="not disabled yet">${SECRET}</textarea></form>`;
    const out = redactSecrets(page, [SECRET]);
    expect(out).toContain(`<input title="was disabled once" placeholder='be disabled here' name="email" value="info@${REDACTED}.hu" disabled>${NOTE}`);
    expect(out).toContain(`<textarea name="note" title="not disabled yet" disabled>${REDACTED}</textarea>${NOTE}`);
  });

  it('an already disabled control is left as it is', () => {
    const out = redactSecrets(`<form><input disabled value="${SECRET}"><input value="${SECRET}" disabled></form>`, [SECRET]);
    expect(out).toContain(`<input disabled value="${REDACTED}">`);
    expect(out).toContain(`<input value="${REDACTED}" disabled>`);
    expect(out.match(/disabled/g)?.length).toBe(2);
  });
});
