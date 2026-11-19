/**
 * A service message that quotes an API field name ("Érvénytelen dátum a(z) "from" mezőben") is written for MCP and CLI
 * callers; the web UI says it with the label of the form field the user filled in.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { errorFlash } from '../../src/web/context.ts';
import { webFieldMessage } from '../../src/web/hints.ts';

describe('API field names in web messages', () => {
  it('are replaced by the form labels; unknown names stay', () => {
    expect(webFieldMessage('Érvénytelen dátum a(z) "from" mezőben: 2026-13-45')).toBe('Érvénytelen dátum a(z) „Időszak kezdete” mezőben: 2026-13-45');
    expect(webFieldMessage('Érvénytelen szám a(z) "amount" mezőben: abc')).toBe('Érvénytelen szám a(z) „Összeg” mezőben: abc');
    expect(webFieldMessage('Érvénytelen szám a(z) "exchangeRate" mezőben: x')).toBe('Érvénytelen szám a(z) „Árfolyam” mezőben: x');
    for (const other of ['Érvénytelen szám a(z) "constructor" mezőben: 1', 'Érvénytelen szám a(z) "netAmountHuf" mezőben: 1', 'A számla már ki van fizetve.']) {
      expect(webFieldMessage(other)).toBe(other);
    }
  });

  it('errorFlash shows the translated message with the hint', () => {
    const flash = errorFlash(new AppError('INVALID_DATE', 'Érvénytelen dátum a(z) "to" mezőben: holnap', { hint: 'Használd az ÉÉÉÉ-HH-NN formátumot, pl. 2026-10-27.' }));
    expect(flash).toMatchObject({ tone: 'err', title: 'Érvénytelen dátum a(z) „Időszak vége” mezőben: holnap', hint: 'Használd az ÉÉÉÉ-HH-NN formátumot, pl. 2026-10-27.' });
  });
});
