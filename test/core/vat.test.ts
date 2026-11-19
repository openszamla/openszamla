/** VAT catalog: NAV representation, mandatory texts (Áfa tv. 169. §, research 02 §20) and seller statuses. */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { VatCode } from '../../src/core/types.ts';
import { getVatInfo, isPercentageCode, isVatCode, listVatCodes, VAT_CODES } from '../../src/core/vat.ts';

describe('VAT catalog', () => {
  it('maps every code to exactly one NAV VatRateType branch with a valid case / rate', () => {
    const exemption = new Set(['AAM', 'TAM', 'KBAET', 'KBAUK', 'EAM', 'NAM']);
    const outOfScope = new Set(['ATK', 'EUFAD37', 'EUFADE', 'EUE', 'HO']);
    for (const info of listVatCodes()) {
      const nav = info.nav;
      if (nav.kind === 'vatPercentage') {
        // NAV INVALID_VAT_DATA: 0.05, 0.18, 0.27 and 0 (from 2024) are the rates of 2026
        expect(['0.05', '0.18', '0.27', '0'], info.code).toContain(nav.value);
        expect(info.rate).toBe(nav.value);
      } else {
        expect(info.rate, info.code).toBe('0');
        if (nav.kind === 'vatExemption') expect(exemption.has(nav.case) && nav.case === info.code, info.code).toBe(true);
        if (nav.kind === 'vatOutOfScope') expect(outOfScope.has(nav.case) && nav.case === info.code, info.code).toBe(true);
      }
    }
    expect(getVatInfo('FAD').nav).toEqual({ kind: 'vatDomesticReverseCharge' });
    expect(getVatInfo('KUL_UTAZAS').nav).toEqual({ kind: 'marginSchemeIndicator', value: 'TRAVEL_AGENCY' });
    expect(getVatInfo('KUL_REGISEG').nav).toEqual({ kind: 'marginSchemeIndicator', value: 'ANTIQUES' });
  });

  it('every non-percentage code has a Hungarian and English notation; NAV reasons stay ≤ 200 characters', () => {
    for (const info of listVatCodes()) {
      if (info.nav.kind === 'vatPercentage') {
        expect(info.notationHu, info.code).toBeNull();
        continue;
      }
      expect(info.notationHu, info.code).toBeTruthy();
      expect(info.notationEn, info.code).toBeTruthy();
      expect(Array.from(info.notationHu as string).length, info.code).toBeLessThanOrEqual(200);
    }
  });

  it('statutory expressions verbatim (169. § n, p, q) – "régiségek", not the njt typo "régisek"', () => {
    for (const code of ['FAD', 'EUFAD37', 'EUFADE'] as VatCode[]) expect(getVatInfo(code).notationHu, code).toMatch(/^fordított adózás/);
    expect(getVatInfo('KUL_UTAZAS').notationHu).toBe('különbözet szerinti szabályozás – utazási irodák');
    expect(getVatInfo('KUL_HASZNALT').notationHu).toBe('különbözet szerinti szabályozás – használt cikkek');
    expect(getVatInfo('KUL_MUALKOTAS').notationHu).toBe('különbözet szerinti szabályozás – műalkotások');
    expect(getVatInfo('KUL_REGISEG').notationHu).toBe('különbözet szerinti szabályozás – gyűjteménydarabok és régiségek');
  });

  it('exemption notations carry a legal reference (169. § m), research 02 §20)', () => {
    const refs: Partial<Record<VatCode, RegExp>> = {
      AAM: /XIII\. fejezet/,
      TAM: /85–86\. §/,
      KBAET: /89\. §/,
      KBAUK: /89\. § \(2\)/,
      EAM: /98–109\. §/,
      NAM: /110–118\. §/,
    };
    for (const [code, re] of Object.entries(refs) as Array<[VatCode, RegExp]>) expect(getVatInfo(code).notationHu, code).toMatch(re);
  });

  it('seller statuses: alanyi adómentes sellers never charge VAT, never reverse-charge, no margin scheme', () => {
    for (const info of listVatCodes()) {
      const forAam = info.allowedFor.includes('aam');
      if (info.nav.kind === 'vatPercentage' || info.code === 'FAD' || info.code === 'KBAET' || info.nav.kind === 'marginSchemeIndicator') {
        expect(forAam, info.code).toBe(false);
      }
      if (info.code === 'AAM') expect(info.allowedFor).toEqual(['aam']);
      else expect(info.allowedFor, info.code).toContain('normal');
    }
  });

  it('regression: Object.prototype keys are not VAT codes', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(isVatCode(k), k).toBe(false);
      expect(() => getVatInfo(k as VatCode), k).toThrow(AppError);
    }
    expect(isVatCode(undefined as unknown as string)).toBe(false);
    expect(VAT_CODES).toHaveLength(20);
    expect([...VAT_CODES.filter(isPercentageCode)].sort()).toEqual(['0', '18', '27', '5']);
  });
});
