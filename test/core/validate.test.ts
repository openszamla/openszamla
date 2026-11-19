/**
 * Validators on REAL, publicly listed identifiers (looked up and verified on 2026-10-27) and the
 * business validation of parties and invoices (Áfa tv. 169. § rules, NAV blocking validations).
 */
import { describe, expect, it } from 'vitest';
import { computeLines, computeTotals } from '../../src/core/calc.ts';
import type { CustomerData, Invoice, InvoiceLineInput, SellerProfile, ValidationIssue } from '../../src/core/types.ts';
import { isValidPostalCode, parseBankAccount, parseEuVatNumber, parseHuTaxNumber, validateCustomer, validateInvoice, validateSeller } from '../../src/core/validate.ts';
import {
  CUSTOMER_DOMESTIC,
  CUSTOMER_EU,
  CUSTOMER_PRIVATE,
  INVOICE_DOMESTIC,
  INVOICE_EU_SERVICE,
  INVOICE_PRIVATE_AAM,
  INVOICE_STORNO,
  SELLER_AAM,
  SELLER_NORMAL,
} from '../fixtures/invoices.ts';
import { NAV_ACCOUNTS, NAV_IBANS } from './fixtures/nav-accounts.ts';

const errors = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);
const warnings = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'warning').map((i) => i.code);

// ---------------------------------------------------------------------------------------------
// Adószám
// ---------------------------------------------------------------------------------------------

/**
 * Real tax numbers with the public source each was read from (2026-10-27). Three of them have the
 * "10 → 0" check digit. The algorithm (weights 9,7,3,1,9,7,3 on the first 7 digits, check digit =
 * 10 − last digit of the sum, 10 → 0) is the one described by the Céginformációs Szolgálat
 * (quoted by hu.wikipedia.org/wiki/Adószám) and research 06 §1.2.
 */
const REAL_TAX_NUMBERS: Array<[string, string]> = [
  ['15789934-2-51', 'Nemzeti Adó- és Vámhivatal – parlament.hu, XVI. fejezet zárszámadás (1054 Budapest, Széchenyi u. 2.)'],
  ['15789460-2-51', 'NAV Bűnügyi Főigazgatóság – parlament.hu, XVI. fejezet 02. cím (check digit 0)'],
  ['15789477-2-51', 'NAV Képzési, Egészségügyi és Kulturális Intézet – parlament.hu, XVI. fejezet 03. cím'],
  ['10537914-4-44', 'OTP Bank Nyrt. – otpbank.hu cégbizonyítvány (2026-06-19)'],
  ['17780010-5-44', 'OTP áfacsoport csoportazonosító – otpbank.hu (check digit 0)'],
  ['10773381-2-44', 'Magyar Telekom Nyrt. – telekom.hu adatkezelési tájékoztató; VIES: valid'],
  ['10625790-4-44', 'MOL Nyrt. – MOL éves jelentés (statisztikai számjel 10625790-…) (check digit 0)'],
  ['10901232-2-44', 'Magyar Posta Zrt. – posta.hu számlaigénylési adatkezelési tájékoztató'],
  ['10931246-2-42', 'OPUS GLOBAL Nyrt. – bet.hu közgyűlési határozatok (2019); VIES: valid'],
  ['10856417-4-44', 'MÁV Zrt. (csoporttag, 2025-10-01-től) – mavcsoport.hu'],
  ['10856417-2-44', 'MÁV Zrt. (2025-09-30-ig) – mavcsoport.hu'],
  ['32694422-4-43', 'MÁV Pályaműködtetési Zrt. – mavcsoport.hu'],
  ['17784447-5-44', 'MÁV áfacsoport csoportazonosító – mavcsoport.hu; VIES: valid'],
  ['26713111-2-44', 'MVM NEXT Energiakereskedelmi Zrt. – MTA közbeszerzési adatszolgáltatás (2023)'],
  ['12011069', '4iG Nyrt. törzsszám – bet.hu (statisztikai számjel 12011069-6201-114-01)'],
];

describe('parseHuTaxNumber', () => {
  it.each(REAL_TAX_NUMBERS)('accepts the real tax number %s (%s)', (n) => {
    const r = parseHuTaxNumber(n);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.formatted).toBe(n);
      expect(r.value.taxpayerId).toBe(n.slice(0, 8));
    }
  });

  it('detects EVERY single-digit error in the törzsszám of every real number', () => {
    for (const [n] of REAL_TAX_NUMBERS) {
      for (let pos = 0; pos < 8; pos++) {
        for (let d = 0; d <= 9; d++) {
          if (String(d) === n[pos]) continue;
          const mutated = n.slice(0, pos) + String(d) + n.slice(pos + 1);
          const r = parseHuTaxNumber(mutated);
          expect(r.ok, mutated).toBe(false);
          if (!r.ok) expect(r.error).toMatch(/ellenőrző/);
        }
      }
    }
  });

  it('accepted input forms', () => {
    expect(parseHuTaxNumber('10773381244')).toEqual(parseHuTaxNumber('10773381-2-44'));
    expect(parseHuTaxNumber(' 10773381 2 44 ')).toEqual(parseHuTaxNumber('10773381-2-44'));
    expect(parseHuTaxNumber('10773381.2.44')).toEqual(parseHuTaxNumber('10773381-2-44'));
    expect(parseHuTaxNumber('10773381')).toEqual({ ok: true, value: { formatted: '10773381', taxpayerId: '10773381', vatCode: null, countyCode: null } });
    expect(parseHuTaxNumber('HU10773381')).toEqual(parseHuTaxNumber('10773381'));
    expect(parseHuTaxNumber('hu 1077 3381')).toEqual(parseHuTaxNumber('10773381'));
    expect(parseHuTaxNumber('10773381-2-44')).toEqual({ ok: true, value: { formatted: '10773381-2-44', taxpayerId: '10773381', vatCode: '2', countyCode: '44' } });
  });

  it('VAT code 1–5 and county codes 02–20, 22–44, 51', () => {
    for (const vat of ['1', '2', '3', '4', '5']) expect(parseHuTaxNumber(`15789934-${vat}-51`).ok, vat).toBe(true);
    for (const vat of ['0', '6', '9']) expect(parseHuTaxNumber(`15789934-${vat}-51`).ok, vat).toBe(false);
    for (const county of ['02', '13', '20', '22', '40', '41', '44', '51']) expect(parseHuTaxNumber(`15789934-2-${county}`).ok, county).toBe(true);
    for (const county of ['00', '01', '21', '45', '50', '52', '99']) expect(parseHuTaxNumber(`15789934-2-${county}`).ok, county).toBe(false);
  });

  it('rejects malformed input with a Hungarian explanation', () => {
    for (const bad of ['', '   ', 'abc', '1578993-2-51', '15789934-2-5', '15789934-22-51', '157899342510', 'DE123456789', '15789934/2/51']) {
      const r = parseHuTaxNumber(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
    expect(parseHuTaxNumber(undefined as unknown as string).ok).toBe(false);
  });

  it('fixture and test tax numbers', () => {
    for (const n of ['12345676-2-42', '11223346-1-06', '87654323-2-13', '22222222']) expect(parseHuTaxNumber(n).ok, n).toBe(true);
    expect(parseHuTaxNumber('87654321-2-13').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Közösségi adószám
// ---------------------------------------------------------------------------------------------

/** Checked live against the VIES REST API (check-vat-number) on 2026-10-27: all "valid": true. */
const VIES_VALID: Array<[string, string]> = [
  ['IE6388047V', 'Google Ireland Limited'],
  ['IE9692928F', 'Meta Platforms Ireland Limited'],
  ['IE8256796U', 'Microsoft Ireland Operations Limited'],
  ['LU26375245', 'Amazon Europe Core S.à r.l.'],
  ['NL805734958B01', 'Booking.com B.V.'],
  ['SE556703748501', 'Spotify AB'],
  ['FR40303265045', 'SA Sodimas'],
  ['PL5260250995', 'Orange Polska S.A.'],
  ['SK2020317068', 'ESET, spol. s r.o.'],
  ['CZ00177041', 'Škoda Auto a.s.'],
  ['DE811569869', 'valid (Germany does not disclose the name)'],
  ['HU10773381', 'Magyar Telekom Nyrt.'],
  ['HU10931246', 'OPUS GLOBAL Nyrt.'],
  ['HU17784447', 'Áfa csoport (MÁV)'],
];

describe('parseEuVatNumber', () => {
  it.each(VIES_VALID)('accepts the VIES-valid number %s (%s)', (n) => {
    const r = parseEuVatNumber(n);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.value.formatted).toBe(n);
      expect(r.value.countryCode).toBe(n.slice(0, 2));
      expect(r.value.formatted).toMatch(/^[A-Z]{2}[0-9A-Z]{2,13}$/); // NAV CommunityVatNumberType
    }
  });

  it('format table of every member state (VIES) incl. EL and XI', () => {
    for (const v of ['ATU12345678', 'BE0123456749', 'BE1234567890', 'BG123456789', 'BG1234567890', 'CY12345678L', 'CZ12345678', 'CZ1234567890', 'DE123456789',
      'DK12345678', 'EE123456789', 'EL123456789', 'ESX1234567X', 'ES12345678Z', 'ESA1234567B', 'FI12345678', 'FRXX123456789', 'FR12345678901', 'HR12345678901',
      'IE1234567WA', 'IE1A23456B', 'IT12345678901', 'LT123456789', 'LT123456789012', 'LU12345678', 'LV12345678901', 'MT12345678', 'NL123456789B01',
      'PL1234567890', 'PT123456789', 'RO12', 'RO1234567890', 'SE123456789001', 'SI12345678', 'SK1234567890', 'XI123456789', 'XIGD123', 'XIHA123']) {
      const r = parseEuVatNumber(v);
      expect(r.ok, `${v}: ${r.ok ? '' : r.error}`).toBe(true);
    }
  });

  it('normalises case and separators', () => {
    expect(parseEuVatNumber('hu 1077 3381')).toEqual({ ok: true, value: { countryCode: 'HU', number: '10773381', formatted: 'HU10773381' } });
    expect(parseEuVatNumber('DE 123.456.789')).toMatchObject({ ok: true, value: { formatted: 'DE123456789' } });
    expect(parseEuVatNumber('atu-12345678')).toMatchObject({ ok: true, value: { formatted: 'ATU12345678' } });
  });

  it('EU small-enterprise scheme numbers with the EX suffix (Áfa tv. 195/I. §)', () => {
    expect(parseEuVatNumber('HU12345676EX')).toEqual({ ok: true, value: { countryCode: 'HU', number: '12345676EX', formatted: 'HU12345676EX' } });
    expect(parseEuVatNumber('HU12345675EX').ok).toBe(false);
  });

  it('rejects wrong numbers with a reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['HU10773382', /ellenőrző/],
      ['GR123456789', /EL/],
      ['GB123456789', /thirdStateTaxId|XI/],
      ['ES123456789', /formátum/],
      ['ATU1234567', /formátum/],
      ['HU1077338', /formátum/],
      ['DE12345678', /formátum/],
      ['XX123456', /tagállami/],
      ['123456789', /előtag/],
      ['IE1+23456A', /NAV/],
      ['', /üres/],
    ];
    for (const [v, re] of cases) {
      const r = parseEuVatNumber(v);
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error, v).toMatch(re);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Bankszámlaszám
// ---------------------------------------------------------------------------------------------

/** Independent IBAN check-digit computation for the test (ISO 7064 mod 97-10). */
function ibanCheckDigits(cc: string, bban: string): string {
  let rem = 0;
  for (const ch of `${bban}${cc}00`) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return String(98 - rem).padStart(2, '0');
}

/** The "three separate 8-digit blocks" check found in many tools – NOT what the MNB decree says. */
function legacyThreeBlocks(digits: string): boolean {
  const ok = (b: string): boolean => {
    const w = [9, 7, 3, 1];
    let s = 0;
    for (let i = 0; i < 7; i++) s += Number(b[i]) * (w[i % 4] as number);
    return (10 - (s % 10)) % 10 === Number(b[7]);
  };
  return ok(digits.slice(0, 8)) && ok(digits.slice(8, 16)) && ok(digits.slice(16, 24));
}

describe('parseBankAccount', () => {
  it(`accepts all ${NAV_ACCOUNTS.length} official NAV collection accounts (16 and 24 digits)`, () => {
    expect(NAV_ACCOUNTS.length).toBe(123);
    for (const a of NAV_ACCOUNTS) {
      const r = parseBankAccount(a);
      expect(r, a).toEqual({ ok: true, value: { kind: 'giro', formatted: a } });
    }
  });

  it(`accepts all ${NAV_IBANS.length} official NAV IBANs, and every NAV account maps to one of them`, () => {
    for (const iban of NAV_IBANS) expect(parseBankAccount(iban), iban).toEqual({ ok: true, value: { kind: 'iban', formatted: iban } });
    const ibans = new Set(NAV_IBANS);
    for (const a of NAV_ACCOUNTS) {
      const bban = a.replace(/-/g, '').padEnd(24, '0');
      expect(ibans.has(`HU${ibanCheckDigits('HU', bban)}${bban}`), a).toBe(true);
    }
  });

  it('24-digit accounts: digit 16 is free – one check over digits 9–24, not three 8-digit blocks', () => {
    const special = '10032000-00009722-05020029';
    expect(NAV_ACCOUNTS).toContain(special);
    expect(parseBankAccount(special).ok).toBe(true);
    expect(legacyThreeBlocks(special.replace(/-/g, ''))).toBe(false);
  });

  it('every single-digit error of a NAV account is detected', () => {
    for (const a of ['10032000-01076019', '10032000-01070044-09060018']) {
      const digits = a.replace(/-/g, '');
      for (let pos = 0; pos < digits.length; pos++) {
        if (digits.length === 24 && pos === 15) continue; // free digit: covered by the 9–24 check digit anyway
        for (let d = 0; d <= 9; d++) {
          if (String(d) === digits[pos]) continue;
          const m = digits.slice(0, pos) + String(d) + digits.slice(pos + 1);
          expect(parseBankAccount(m).ok, m).toBe(false);
        }
      }
    }
  });

  it('input forms and formatting', () => {
    expect(parseBankAccount('1003200001076019')).toEqual({ ok: true, value: { kind: 'giro', formatted: '10032000-01076019' } });
    expect(parseBankAccount(' 10032000 01076019 ')).toEqual({ ok: true, value: { kind: 'giro', formatted: '10032000-01076019' } });
    expect(parseBankAccount('12345676-11111111').ok).toBe(true);
    expect(parseBankAccount('HU42 1177 3016 1111 1018 0000 0000')).toEqual({ ok: true, value: { kind: 'iban', formatted: 'HU42117730161111101800000000' } });
    expect(parseBankAccount('hu57100320000107601900000000')).toEqual({ ok: true, value: { kind: 'iban', formatted: 'HU57100320000107601900000000' } });
  });

  it('foreign IBANs (ISO 13616 registry examples)', () => {
    for (const iban of ['DE89370400440532013000', 'GB82WEST12345698765432', 'AT611904300234573201', 'NL91ABNA0417164300', 'FR1420041010050500013M02606',
      'BE68539007547034', 'CH9300762011623852957', 'NO9386011117947', 'SK3112000000198742637541', 'PL61109010140000071219812874']) {
      expect(parseBankAccount(iban), iban).toEqual({ ok: true, value: { kind: 'iban', formatted: iban } });
    }
  });

  it('rejects wrong numbers', () => {
    const goodBban = '100320000107601900000000';
    const badGiroBban = '100320010107601900000000'; // CDV of digits 1–8 wrong, IBAN check digits correct
    const cases: Array<[string, RegExp]> = [
      ['10032001-01076019', /első 8 jegy/],
      ['10032000-01076018', /9–16/],
      ['10032000-01070044-09060019', /9–24/],
      ['10032000-0107601', /16 \(2×8\) vagy 24/],
      ['HU58100320000107601900000000', /IBAN ellenőrző/],
      ['GB82WEST12345698765433', /IBAN ellenőrző/],
      ['DE8937040044053201300', /hossza/],
      [`HU${ibanCheckDigits('HU', badGiroBban)}${badGiroBban}`, /belföldi számlaszám/],
      ['HU00ABCD', /hossza/],
      ['', /üres/],
      ['bankszámla', /nem bankszámlaszám/],
    ];
    expect(parseBankAccount(`HU${ibanCheckDigits('HU', goodBban)}${goodBban}`).ok).toBe(true);
    for (const [v, re] of cases) {
      const r = parseBankAccount(v);
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error, v).toMatch(re);
    }
  });
});

describe('isValidPostalCode', () => {
  it('Hungary: 4 digits, first 1–9 (Budapest PO-box codes such as 1438 included)', () => {
    for (const pc of ['1117', '1007', '1438', '2000', '6720', '9985', ' 1051 ']) expect(isValidPostalCode('HU', pc), pc).toBe(true);
    for (const pc of ['0123', '123', '12345', '1O11', '', 'H-1117']) expect(isValidPostalCode('HU', pc), pc).toBe(false);
    expect(isValidPostalCode('hu', '1117')).toBe(true);
  });

  it('frequent partner countries and the generic NAV pattern', () => {
    const ok: Array<[string, string]> = [['DE', '10115'], ['AT', '1010'], ['SK', '811 01'], ['CZ', '11000'], ['PL', '00-950'], ['RO', '010011'], ['NL', '1012 AB'], ['GB', 'SW1A 1AA'], ['IE', 'D02 X285'], ['US', '10001-1234'], ['XX', 'AB12']];
    for (const [cc, pc] of ok) expect(isValidPostalCode(cc, pc), `${cc} ${pc}`).toBe(true);
    const bad: Array<[string, string]> = [['DE', '1011'], ['PL', '00950'], ['AT', '10101'], ['XX', '!!'], ['XX', 'A'], ['DE', '']];
    for (const [cc, pc] of bad) expect(isValidPostalCode(cc, pc), `${cc} ${pc}`).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------------------------

describe('validateSeller', () => {
  it('the fixture sellers are valid', () => {
    expect(errors(validateSeller(SELLER_NORMAL))).toEqual([]);
    expect(errors(validateSeller(SELLER_AAM))).toEqual([]);
  });

  it('VAT groups: group identifier + member tax number (Art. 30. § (2)), real MÁV numbers', () => {
    const base: SellerProfile = { ...SELLER_NORMAL, euVatNumber: 'HU17784447', bankAccount: undefined };
    expect(errors(validateSeller({ ...base, taxNumber: '17784447-5-44', groupMemberTaxNumber: '10856417-4-44' }))).toEqual([]);
    expect(errors(validateSeller({ ...base, taxNumber: '17784447-5-44' }))).toEqual(['SELLER_GROUP_MEMBER_TAX_NUMBER_REQUIRED']);
    expect(errors(validateSeller({ ...base, euVatNumber: 'HU10856417', taxNumber: '10856417-4-44' }))).toEqual(['SELLER_TAX_NUMBER_GROUP_MEMBER']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, groupMemberTaxNumber: '10856417-4-44' }))).toEqual(['SELLER_GROUP_MEMBER_WITHOUT_GROUP']);
  });

  it('tax number, community VAT number, bank account, status combinations', () => {
    expect(errors(validateSeller({ ...SELLER_NORMAL, taxNumber: '' }))).toEqual(['SELLER_TAX_NUMBER_REQUIRED']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, taxNumber: '12345675-2-42' }))).toEqual(['SELLER_TAX_NUMBER_INVALID']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, taxNumber: '12345676' }))).toEqual(['SELLER_TAX_NUMBER_INCOMPLETE']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, euVatNumber: 'HU10773381' }))).toEqual(['SELLER_EU_VAT_NUMBER_MISMATCH']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, euVatNumber: 'DE123456789' }))).toEqual(['SELLER_EU_VAT_NUMBER_NOT_HU']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, bankAccount: '12345676-11111112' }))).toEqual(['SELLER_BANK_ACCOUNT_INVALID']);
    expect(errors(validateSeller({ ...SELLER_AAM, cashAccounting: true }))).toEqual(['SELLER_AAM_CASH_ACCOUNTING']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, vatStatus: 'kata' as never }))).toEqual(['SELLER_VAT_STATUS_INVALID']);
  });

  it('name and address', () => {
    expect(errors(validateSeller({ ...SELLER_NORMAL, name: '  ' }))).toEqual(['SELLER_NAME_REQUIRED']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, name: 'x'.repeat(513) }))).toEqual(['SELLER_NAME_TOO_LONG']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, postalCode: '0117' } }))).toEqual(['SELLER_POSTAL_CODE_INVALID']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, postalCode: '' } }))).toEqual(['SELLER_POSTAL_CODE_REQUIRED']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, city: '', addressLine: '' } }))).toEqual(['SELLER_CITY_REQUIRED', 'SELLER_ADDRESS_LINE_REQUIRED']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, address: { ...SELLER_NORMAL.address, countryCode: 'HUN' } }))).toEqual(['SELLER_COUNTRY_INVALID']);
    expect(errors(validateSeller({ ...SELLER_NORMAL, address: undefined as never }))).toEqual(['SELLER_ADDRESS_REQUIRED']);
    expect(errors(validateSeller(null as never))).toEqual(['SELLER_MISSING']);
  });

  it('sole proprietors (megyekód 22–40): "e.v." designation and registration number (Evtv. 16. § (4))', () => {
    const ev: SellerProfile = { ...SELLER_NORMAL, name: 'Kovács Anna', taxNumber: '12345676-1-26', euVatNumber: undefined };
    expect(warnings(validateSeller(ev))).toEqual(expect.arrayContaining(['SELLER_EV_DESIGNATION_MISSING', 'SELLER_REGISTRATION_NUMBER_MISSING']));
    expect(warnings(validateSeller({ ...ev, name: 'Kovács Anna e.v.', registrationNumber: '12345678' }))).toEqual([]);
    expect(warnings(validateSeller({ ...ev, name: 'Kovács Anna egyéni vállalkozó', registrationNumber: '12345678' }))).toEqual([]);
    expect(warnings(validateSeller({ ...SELLER_NORMAL, taxNumber: '12345676-2-13', euVatNumber: undefined, smallBusiness: true }))).toContain('SELLER_KATA_NOT_SOLE_PROPRIETOR');
  });
});

describe('validateCustomer', () => {
  it('fixture customers are valid', () => {
    for (const c of [CUSTOMER_DOMESTIC, CUSTOMER_PRIVATE, CUSTOMER_EU]) expect(validateCustomer(c), c.name).toEqual([]);
  });

  it('DOMESTIC needs a valid Hungarian tax number', () => {
    const { taxNumber: _t, ...noTax } = CUSTOMER_DOMESTIC;
    expect(errors(validateCustomer(noTax))).toEqual(['CUSTOMER_TAX_NUMBER_REQUIRED']);
    expect(errors(validateCustomer({ ...CUSTOMER_DOMESTIC, taxNumber: '87654321-2-13' }))).toEqual(['CUSTOMER_TAX_NUMBER_INVALID']);
    expect(warnings(validateCustomer({ ...CUSTOMER_DOMESTIC, taxNumber: '87654323' }))).toEqual(['CUSTOMER_TAX_NUMBER_SHORT']);
    expect(warnings(validateCustomer({ ...CUSTOMER_DOMESTIC, taxNumber: '10856417-4-44' }))).toEqual(['CUSTOMER_TAX_NUMBER_GROUP_MEMBER']);
    expect(validateCustomer({ ...CUSTOMER_DOMESTIC, taxNumber: '17784447-5-44', groupMemberTaxNumber: '10856417-4-44' })).toEqual([]);
  });

  it('OTHER and PRIVATE_PERSON', () => {
    expect(errors(validateCustomer({ ...CUSTOMER_EU, euVatNumber: 'DE12345678' }))).toEqual(['CUSTOMER_EU_VAT_NUMBER_INVALID']);
    expect(warnings(validateCustomer({ ...CUSTOMER_EU, euVatNumber: undefined, taxNumber: '10773381-2-44', address: CUSTOMER_DOMESTIC.address }))).toEqual(['CUSTOMER_OTHER_DOMESTIC_TAXPAYER']);
    expect(warnings(validateCustomer({ ...CUSTOMER_EU, euVatNumber: 'HU10773381' }))).toEqual(['CUSTOMER_OTHER_WITH_HU_VAT_NUMBER']);
    expect(warnings(validateCustomer({ ...CUSTOMER_EU, thirdStateTaxId: '12-3456789' }))).toEqual(['CUSTOMER_MULTIPLE_TAX_IDS']);
    expect(validateCustomer({ ...CUSTOMER_EU, euVatNumber: undefined, thirdStateTaxId: '12-3456789', address: { countryCode: 'US', postalCode: '10001', city: 'New York', addressLine: '5th Ave 1' } })).toEqual([]);
    expect(errors(validateCustomer({ ...CUSTOMER_EU, euVatNumber: undefined, thirdStateTaxId: 'x'.repeat(51) }))).toEqual(['CUSTOMER_THIRD_STATE_TAX_ID_TOO_LONG']);
    expect(warnings(validateCustomer({ ...CUSTOMER_PRIVATE, taxNumber: '10773381-2-44' }))).toEqual(['CUSTOMER_PRIVATE_PERSON_TAX_ID']);
    expect(errors(validateCustomer({ ...CUSTOMER_PRIVATE, name: '' }))).toEqual(['CUSTOMER_NAME_REQUIRED']);
    expect(errors(validateCustomer({ ...CUSTOMER_PRIVATE, vatStatus: 'PERSON' as never }))).toEqual(['CUSTOMER_VAT_STATUS_INVALID']);
    expect(warnings(validateCustomer({ ...CUSTOMER_EU, address: { ...CUSTOMER_EU.address, postalCode: '1011' } }))).toEqual(['CUSTOMER_POSTAL_CODE_FORMAT']);
  });
});

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

const TODAY = '2026-10-27';

function line(over: Partial<InvoiceLineInput> = {}): InvoiceLineInput {
  return { description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', priceBasis: 'net', vatCode: '27', nature: 'SERVICE', ...over };
}

/** A draft built exactly like the service does (lines and totals from calc). */
function draft(inputs: InvoiceLineInput[], over: Partial<Invoice> = {}): Invoice {
  const currency = over.currency ?? 'HUF';
  const exchangeRate = over.exchangeRate ?? '1';
  const paymentMethod = over.paymentMethod ?? 'TRANSFER';
  const ctx = { currency, exchangeRate: exchangeRate === '0' ? '1' : exchangeRate };
  const lines = computeLines(inputs, ctx);
  const totals = computeTotals(lines, { ...ctx, paymentMethod });
  return {
    ...INVOICE_DOMESTIC,
    id: 'inv_test000001',
    status: 'draft',
    number: null,
    issuedAt: null,
    navStatus: 'not_applicable',
    issueDate: TODAY,
    fulfillmentDate: TODAY,
    dueDate: '2026-11-04',
    exchangeRateDate: currency === 'HUF' ? null : TODAY,
    exchangeRateSource: currency === 'HUF' ? null : 'MNB',
    orderNumber: null,
    notations: [],
    ...over,
    currency,
    exchangeRate,
    paymentMethod,
    lines: over.lines ?? lines,
    totals: over.totals ?? totals,
  };
}

const check = (inv: Invoice, ctx: { today?: string; original?: Invoice | null } = {}): ValidationIssue[] => validateInvoice(inv, { today: ctx.today ?? TODAY, original: ctx.original ?? null });

const EU_DE: CustomerData = CUSTOMER_EU;
const REF = { originalInvoiceId: INVOICE_DOMESTIC.id, originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false };

describe('validateInvoice – fixtures and service-like drafts', () => {
  it('the hand-computed fixtures are valid', () => {
    expect(errors(check(INVOICE_DOMESTIC))).toEqual([]);
    expect(errors(check(INVOICE_PRIVATE_AAM))).toEqual([]);
    expect(errors(check(INVOICE_EU_SERVICE))).toEqual([]);
    expect(errors(check(INVOICE_STORNO, { today: '2026-10-28', original: INVOICE_DOMESTIC }))).toEqual([]);
  });

  it('a plain domestic draft is ready to issue (no warnings either)', () => {
    const inv = draft([line(), line({ description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '2000', vatCode: '5', nature: 'PRODUCT' })]);
    expect(check(inv)).toEqual([]);
  });

  it('never throws on garbage, reports instead', () => {
    const garbage = { ...draft([line()]), lines: [{ lineNo: 1 }, null], totals: null, currency: 7, issueDate: 'tegnap', seller: null, customer: undefined } as unknown as Invoice;
    const issues = check(garbage);
    expect(errors(issues)).toEqual(expect.arrayContaining(['SELLER_MISSING', 'CUSTOMER_MISSING', 'CURRENCY_INVALID', 'ISSUE_DATE_INVALID', 'LINE_DESCRIPTION_REQUIRED', 'LINE_INVALID', 'TOTALS_MISSING']));
    expect(() => check(null as unknown as Invoice)).not.toThrow();
  });
});

describe('validateInvoice – lines', () => {
  it('at least one line – a modification too (NAV needs a VAT summary row; header data: a zero-amount line)', () => {
    expect(errors(check(draft([])))).toContain('LINES_REQUIRED');
    const mod = check(draft([], { documentType: 'modification', reference: REF, comment: 'Teljesítési dátum javítása' }), { original: INVOICE_DOMESTIC });
    expect(errors(mod)).toEqual(['MODIFICATION_WITHOUT_LINES']);
    expect(mod.find((i) => i.code === 'MODIFICATION_WITHOUT_LINES')?.message).toMatch(/0 összegű különbözeti tételt.*sztornózd/);
    const zeroLine = check(draft([line({ description: 'Teljesítési dátum javítása: 2026-10-20', quantity: '1', unitPrice: '0' })], { documentType: 'modification', reference: REF, comment: 'Teljesítési dátum javítása' }), { original: INVOICE_DOMESTIC });
    expect(errors(zeroLine)).toEqual([]);
  });

  it('description, quantity, unit and number precision', () => {
    expect(errors(check(draft([line({ quantity: '0' })])))).toEqual(['LINE_QUANTITY_ZERO']);
    expect(errors(check(draft([line({ description: '   ' })])))).toEqual(['LINE_DESCRIPTION_REQUIRED']);
    expect(errors(check(draft([line({ description: 'é'.repeat(513) })])))).toEqual(['LINE_DESCRIPTION_TOO_LONG']);
    expect(errors(check(draft([line({ description: 'é'.repeat(512) })])))).toEqual([]);
    expect(errors(check(draft([line({ unit: '' })])))).toEqual(['LINE_UNIT_REQUIRED']);
    expect(errors(check(draft([line({ unit: 'u'.repeat(51) })])))).toEqual(['LINE_UNIT_TOO_LONG']);
    expect(errors(check(draft([line({ quantity: '1.12345678901' })])))).toEqual(['LINE_QUANTITY_PRECISION']);
    expect(errors(check(draft([line({ quantity: '1.123456' })])))).toEqual([]);
    expect(errors(check(draft([line({ quantity: '1', unitPrice: '0.00000000001' })])))).toEqual(expect.arrayContaining(['LINE_UNIT_PRICE_PRECISION']));
  });

  it('amounts beyond NAV MonetaryType (18 digits) are refused before issuing', () => {
    const issues = errors(check(draft([line({ quantity: '10000000000', unitPrice: '10000000000' })])));
    expect(issues).toContain('LINE_AMOUNT_NOT_REPRESENTABLE');
    expect(issues).toContain('TOTAL_AMOUNT_NOT_REPRESENTABLE');
    expect(errors(check(draft([line({ quantity: '1000000', unitPrice: '99999999999' })])))).toEqual([]);
  });

  it('unknown VAT code', () => {
    const inv = draft([line()]);
    const bad = { ...inv, lines: inv.lines.map((l) => ({ ...l, vatCode: 'XX' as never })) };
    expect(errors(check(bad))).toContain('LINE_VAT_CODE_INVALID');
  });

  it('VAT code vs seller status: AAM sellers cannot charge VAT, normal sellers cannot use AAM', () => {
    expect(errors(check(draft([line({ vatCode: '27' })], { seller: SELLER_AAM })))).toEqual(['LINE_VAT_CODE_NOT_ALLOWED']);
    expect(errors(check(draft([line({ vatCode: 'FAD' })], { seller: SELLER_AAM })))).toEqual(['LINE_VAT_CODE_NOT_ALLOWED']);
    const sale = check(draft([line({ vatCode: '27', vatReason: 'Áfa tv. 193. § – tárgyi eszköz értékesítése' })], { seller: SELLER_AAM }));
    expect(errors(sale)).toEqual([]);
    expect(warnings(sale)).toContain('LINE_VAT_CODE_AAM_EXCEPTION');
    expect(errors(check(draft([line({ vatCode: 'AAM' })])))).toEqual(['LINE_VAT_CODE_NOT_ALLOWED']);
    for (const code of ['AAM', 'TAM', 'EUE', 'HO', 'ATK'] as const) {
      expect(errors(check(draft([line({ vatCode: code, vatReason: code === 'TAM' ? 'Áfa tv. 85. § (1) e)' : undefined })], { seller: SELLER_AAM, customer: CUSTOMER_PRIVATE }))), code).toEqual([]);
    }
  });

  it('0% rate only for fulfilment from 2024-01-01 (NAV INVALID_VAT_DATA)', () => {
    expect(errors(check(draft([line({ vatCode: '0' })], { fulfillmentDate: '2023-12-31' })))).toEqual(['LINE_ZERO_RATE_BEFORE_2024']);
    expect(errors(check(draft([line({ vatCode: '0' })], { fulfillmentDate: '2024-01-01' })))).toEqual([]);
  });

  it('exempt / out-of-scope lines: VAT must be 0, reason ≤ 200 characters', () => {
    const inv = draft([line({ vatCode: 'TAM', vatReason: 'Áfa tv. 85. § (1) e)' })]);
    const tampered = { ...inv, lines: inv.lines.map((l) => ({ ...l, vatAmount: '1', grossAmount: '150001', vatAmountHuf: '1', grossAmountHuf: '150001' })) };
    expect(errors(check(tampered))).toContain('LINE_VAT_NOT_ZERO');
    expect(errors(check(draft([line({ vatCode: 'TAM', vatReason: 'x'.repeat(201) })])))).toEqual(['LINE_VAT_REASON_TOO_LONG']);
    expect(warnings(check(draft([line({ vatCode: 'TAM' })])))).toContain('LINE_EXEMPTION_REFERENCE_RECOMMENDED');
  });

  it('travel agency margin scheme is refused from 2026 (210/A. § (3) needs margin data)', () => {
    expect(errors(check(draft([line({ vatCode: 'KUL_UTAZAS' })], { customer: CUSTOMER_PRIVATE })))).toEqual(['LINE_TRAVEL_MARGIN_UNSUPPORTED']);
    expect(errors(check(draft([line({ vatCode: 'KUL_HASZNALT', nature: 'PRODUCT' })], { customer: CUSTOMER_PRIVATE })))).toEqual([]);
  });

  it('stale or tampered amounts are caught', () => {
    const inv = draft([line(), line({ vatCode: '5', unitPrice: '2000', quantity: '2' })]);
    const l0 = inv.lines[0]!;
    expect(errors(check({ ...inv, lines: [{ ...l0, vatAmount: '40501', grossAmount: '190501', vatAmountHuf: '40501', grossAmountHuf: '190501' }, inv.lines[1]!] }))).toContain('LINE_AMOUNTS_STALE');
    expect(errors(check({ ...inv, lines: [{ ...l0, grossAmount: '1' }, inv.lines[1]!] }))).toContain('LINE_AMOUNTS_INCONSISTENT');
    expect(errors(check({ ...inv, lines: [{ ...l0, quantity: '11' }, inv.lines[1]!] }))).toContain('LINE_AMOUNTS_STALE');
    expect(errors(check({ ...inv, totals: { ...inv.totals, netAmount: '1' } }))).toEqual(expect.arrayContaining(['TOTALS_MISMATCH', 'TOTALS_INCONSISTENT']));
    expect(errors(check({ ...inv, totals: { ...inv.totals, byVat: inv.totals.byVat.slice(0, 1) } }))).toEqual(expect.arrayContaining(['VAT_SUMMARY_MISSING_ROW', 'VAT_SUMMARY_TOTAL_MISMATCH']));
    expect(errors(check({ ...inv, totals: { ...inv.totals, payableAmount: '194705', roundingDifference: '5' } }))).toEqual(['PAYABLE_MISMATCH']);
    expect(errors(check({ ...inv, lines: inv.lines.map((l, i) => ({ ...l, lineNo: i + 2 })) }))).toEqual(['LINE_NUMBER_NOT_SEQUENTIAL', 'LINE_NUMBER_NOT_SEQUENTIAL']);
  });

  it('cash payment in HUF: payable rounded to 0/5 Ft', () => {
    const inv = draft([line({ unitPrice: '12499', quantity: '2', vatCode: 'AAM', priceBasis: 'gross' })], { seller: SELLER_AAM, customer: CUSTOMER_PRIVATE, paymentMethod: 'CASH', dueDate: TODAY });
    expect(inv.totals.payableAmount).toBe('25000');
    expect(errors(check(inv))).toEqual([]);
  });

  it('the tax base of an invoice cannot be negative', () => {
    expect(errors(check(draft([line({ unitPrice: '-15000' })])))).toEqual(['NEGATIVE_TAX_BASE']);
    expect(errors(check(draft([line(), line({ unitPrice: '-1000', description: 'Kedvezmény' })])))).toEqual([]);
  });
});

describe('validateInvoice – currency and exchange rate (NAV ERROR 77, 78)', () => {
  const eur = (rate: string, over: Partial<Invoice> = {}): Invoice =>
    draft([line({ vatCode: 'EUFAD37', unitPrice: '80' })], { currency: 'EUR', exchangeRate: rate, customer: EU_DE, ...over });

  it('HUF → exactly 1', () => {
    expect(errors(check(draft([line()], { exchangeRate: '2' })))).toEqual(['EXCHANGE_RATE_HUF_NOT_ONE']);
    expect(errors(check(draft([line()], { exchangeRate: '1.000' })))).toEqual([]);
  });

  it('foreign currency: positive, ≤ 6 decimals, inside the watched band', () => {
    expect(errors(check(eur('390.12')))).toEqual([]);
    expect(errors(check(eur('0')))).toEqual(['EXCHANGE_RATE_MISSING']);
    expect(errors(check(eur('-1')))).toEqual(['EXCHANGE_RATE_MISSING']);
    expect(errors(check(eur('249.99')))).toEqual(['EXCHANGE_RATE_EXTREME']);
    expect(errors(check(eur('600.01')))).toEqual(['EXCHANGE_RATE_EXTREME']);
    expect(errors(check(eur('250')))).toEqual([]);
    expect(errors(check(eur('600')))).toEqual([]);
    expect(errors(check(eur('390.1234567')))).toEqual(['EXCHANGE_RATE_PRECISION']);
    expect(errors(check(draft([line({ vatCode: 'EUFAD37' })], { currency: 'JPY', exchangeRate: '2.0889', customer: EU_DE })))).toEqual([]);
    expect(errors(check(draft([line()], { currency: 'EURO', exchangeRate: '390' })))).toContain('CURRENCY_INVALID');
  });

  it('storno is outside the band check (NAV removed STORNO from ERROR 78)', () => {
    const inv = eur('700', { documentType: 'storno', reference: REF, number: 'SZ-2026-00009' });
    expect(errors(check(inv))).not.toContain('EXCHANGE_RATE_EXTREME');
  });

  it('exchange-rate date: the rate valid at the tax point', () => {
    expect(warnings(check(eur('390.12', { exchangeRateDate: '2026-10-28', fulfillmentDate: '2026-10-27' })))).toContain('EXCHANGE_RATE_DATE_AFTER_TAX_POINT');
    expect(warnings(check(eur('390.12', { exchangeRateDate: '2026-10-01', fulfillmentDate: '2026-10-27' })))).toContain('EXCHANGE_RATE_DATE_OLD');
    expect(warnings(check(eur('390.12', { exchangeRateDate: '2026-10-23', fulfillmentDate: '2026-10-25' })))).toEqual([]);
  });

  it('a rate without its date cannot be checked against the tax point (e.g. carried over by a copy) – warning', () => {
    expect(warnings(check(eur('380', { exchangeRateDate: null, exchangeRateSource: 'manual' })))).toEqual(['EXCHANGE_RATE_DATE_MISSING']);
    // Corrections keep the original's rate: no date check.
    expect(warnings(check(eur('380', { exchangeRateDate: null, documentType: 'storno', reference: REF, number: 'SZ-2026-00009' })))).not.toContain('EXCHANGE_RATE_DATE_MISSING');
  });

  it('a missing rate is ONE issue, worded by the rate policy (MNB lookup failed / enter the rate)', () => {
    const missing = (policy?: 'MNB' | 'manual'): ValidationIssue[] =>
      validateInvoice(eur('0', { exchangeRateDate: null, exchangeRateSource: null }), { today: TODAY, original: null, ...(policy ? { exchangeRatePolicy: policy } : {}) }).filter((i) => i.code === 'EXCHANGE_RATE_MISSING');
    expect(missing('manual')).toHaveLength(1);
    expect(missing('manual')[0]?.message).toMatch(/kézi árfolyam-beállítás.*bankod/);
    expect(missing('MNB')).toHaveLength(1);
    expect(missing('MNB')[0]?.message).toMatch(/Nem sikerült lekérni az MNB EUR/);
    expect(missing()[0]?.message).toMatch(/pozitív árfolyam kell/);
  });
});

describe('validateInvoice – buyer rules per VAT code (169. § d), NAV ERROR 50, 67–70, 73)', () => {
  it('KBAET / EUFAD37 / EUFADE: OTHER buyer with an EU VAT number of another member state', () => {
    for (const code of ['KBAET', 'EUFAD37', 'EUFADE'] as const) {
      const nature = code === 'EUFAD37' ? 'SERVICE' : 'PRODUCT';
      expect(errors(check(draft([line({ vatCode: code, nature })], { customer: EU_DE }))), code).toEqual([]);
      expect(errors(check(draft([line({ vatCode: code, nature })], { customer: CUSTOMER_DOMESTIC }))), code).toEqual(['EU_CODE_CUSTOMER_NOT_OTHER', 'EU_CODE_CUSTOMER_EU_VAT_REQUIRED']);
      expect(errors(check(draft([line({ vatCode: code, nature })], { customer: CUSTOMER_PRIVATE }))), code).toEqual(['EU_CODE_CUSTOMER_NOT_OTHER', 'EU_CODE_CUSTOMER_EU_VAT_REQUIRED']);
      expect(errors(check(draft([line({ vatCode: code, nature })], { customer: { ...EU_DE, euVatNumber: undefined } }))), code).toEqual(['EU_CODE_CUSTOMER_EU_VAT_REQUIRED']);
      expect(errors(check(draft([line({ vatCode: code, nature })], { customer: { ...EU_DE, euVatNumber: 'HU10773381' } }))), code).toEqual(['EU_CODE_CUSTOMER_HU_VAT']);
    }
  });

  it('KBAUK: never a DOMESTIC buyer', () => {
    expect(errors(check(draft([line({ vatCode: 'KBAUK', nature: 'PRODUCT' })], { customer: CUSTOMER_DOMESTIC })))).toEqual(['KBAUK_CUSTOMER_DOMESTIC']);
    expect(errors(check(draft([line({ vatCode: 'KBAUK', nature: 'PRODUCT' })], { customer: { ...CUSTOMER_PRIVATE, address: EU_DE.address } })))).toEqual([]);
  });

  it('FAD (domestic reverse charge): DOMESTIC buyer with full tax number, "fordított adózás" printed', () => {
    expect(errors(check(draft([line({ vatCode: 'FAD' })])))).toEqual([]);
    expect(errors(check(draft([line({ vatCode: 'FAD' })], { customer: EU_DE })))).toEqual(['FAD_CUSTOMER_NOT_DOMESTIC']);
    expect(errors(check(draft([line({ vatCode: 'FAD' })], { customer: { ...CUSTOMER_DOMESTIC, taxNumber: '87654323' } })))).toEqual(['FAD_CUSTOMER_TAX_NUMBER_REQUIRED']);
  });

  it('a storno mirrors its original – no buyer-status errors (NAV checks CREATE/MODIFY only)', () => {
    const st = draft([line({ vatCode: 'KBAET', quantity: '-1', nature: 'PRODUCT' })], { documentType: 'storno', reference: REF, customer: CUSTOMER_DOMESTIC });
    expect(errors(check(st)).filter((c) => c.startsWith('EU_CODE'))).toEqual([]);
  });

  it('helpful warnings: Hungarian VAT on EU B2B services, 0% to foreign buyers, export to EU address', () => {
    expect(warnings(check(draft([line()], { customer: EU_DE })))).toContain('EU_B2B_SERVICE_WITH_HU_VAT');
    expect(warnings(check(draft([line({ vatCode: '0', nature: 'PRODUCT' })], { customer: EU_DE })))).toContain('ZERO_RATE_FOREIGN_CUSTOMER');
    expect(warnings(check(draft([line({ vatCode: 'EAM', nature: 'PRODUCT' })], { customer: EU_DE })))).toContain('NON_EU_CODE_EU_CUSTOMER');
  });
});

describe('validateInvoice – dates and deadlines', () => {
  it('issue date not in the future, fulfilment ≤ issue + 5 years, due date ≥ issue date', () => {
    expect(errors(check(draft([line()], { issueDate: '2026-10-28', dueDate: '2026-11-05' })))).toEqual(['ISSUE_DATE_IN_FUTURE']);
    expect(errors(check(draft([line()], { fulfillmentDate: '2031-10-28' })))).toEqual(['FULFILLMENT_DATE_TOO_LATE']);
    expect(errors(check(draft([line()], { dueDate: '2026-10-26' })))).toEqual(['DUE_DATE_BEFORE_ISSUE_DATE']);
    expect(errors(check(draft([line()], { fulfillmentDate: '2009-12-31' })))).toEqual(['FULFILLMENT_DATE_INVALID']);
    expect(errors(check(draft([line()], { issueDate: '2026-02-30' })))).toContain('ISSUE_DATE_INVALID');
  });

  it('Áfa tv. 163. §: 8 days for VAT invoices, 15th of the next month for KBAET / 37. § services', () => {
    expect(warnings(check(draft([line()], { fulfillmentDate: '2026-10-18' })))).toContain('ISSUE_DEADLINE_MISSED');
    expect(warnings(check(draft([line()], { fulfillmentDate: '2026-10-19' })))).not.toContain('ISSUE_DEADLINE_MISSED');
    const eu = (f: string): string[] => warnings(check(draft([line({ vatCode: 'KBAET', nature: 'PRODUCT' })], { customer: EU_DE, fulfillmentDate: f })));
    expect(eu('2026-09-14')).toContain('ISSUE_DEADLINE_MISSED'); // deadline 2026-10-15
    expect(eu('2026-10-01')).not.toContain('ISSUE_DEADLINE_MISSED');
  });
});

describe('validateInvoice – corrections (Áfa tv. 170. §, NAV ERROR 19, 60, 66, 76, 79)', () => {
  const mod = (over: Partial<Invoice> = {}): Invoice =>
    draft([line({ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000' })], { documentType: 'modification', reference: REF, comment: 'Utólagos árengedmény', ...over });

  it('a correct modification is accepted', () => {
    expect(errors(check(mod(), { original: INVOICE_DOMESTIC }))).toEqual([]);
  });

  it('reference rules', () => {
    expect(errors(check(mod({ reference: null })))).toEqual(['REFERENCE_REQUIRED']);
    expect(errors(check(draft([line()], { reference: REF })))).toEqual(['REFERENCE_NOT_EXPECTED']);
    expect(errors(check(mod({ reference: { ...REF, originalInvoiceNumber: ' SZ-2026-00001' } })))).toEqual(['REFERENCE_NUMBER_WHITESPACE']);
    expect(errors(check(mod({ reference: { ...REF, modificationIndex: 1001 } })))).toEqual(['MODIFICATION_INDEX_TOO_LARGE']);
    expect(errors(check(mod({ reference: { ...REF, modificationIndex: 0 } })))).toEqual(['MODIFICATION_INDEX_INVALID']);
    expect(errors(check(mod({ number: 'SZ-2026-00001', status: 'issued' })))).toEqual(['REFERENCE_SAME_NUMBER']);
    expect(errors(check(mod(), { original: { ...INVOICE_DOMESTIC, status: 'cancelled' } }))).toEqual(['ORIGINAL_CANCELLED']);
    expect(errors(check(mod(), { original: { ...INVOICE_DOMESTIC, currency: 'EUR', exchangeRate: '390' } }))).toEqual(['CURRENCY_DIFFERS_FROM_ORIGINAL']);
    expect(errors(check(mod(), { original: INVOICE_STORNO }))).toEqual(expect.arrayContaining(['ORIGINAL_IS_CORRECTION']));
    expect(warnings(check(mod({ comment: null }), { original: INVOICE_DOMESTIC }))).toContain('MODIFICATION_REASON_MISSING');
  });

  it('reference.originalDocumentType must be the real type of the original (advance data in the NAV report)', () => {
    expect(errors(check(mod({ reference: { ...REF, originalDocumentType: 'invoice' } }), { original: INVOICE_DOMESTIC }))).toEqual([]);
    expect(errors(check(mod({ reference: { ...REF, originalDocumentType: 'advance' } }), { original: INVOICE_DOMESTIC }))).toEqual(['REFERENCE_DOCUMENT_TYPE_MISMATCH']);
    expect(errors(check(mod({ reference: { ...REF, originalDocumentType: 'storno' } })))).toEqual(['REFERENCE_DOCUMENT_TYPE_INVALID']);
    const advanceOriginal: Invoice = { ...INVOICE_DOMESTIC, documentType: 'advance' };
    expect(errors(check(mod({ reference: { ...REF, originalDocumentType: 'advance' } }), { original: advanceOriginal }))).toEqual([]);
  });

  it('line references: CREATE only, unique, only on corrections', () => {
    const m = mod();
    const withRef = (refs: Array<{ lineNumberReference: number; lineOperation: 'CREATE' | 'MODIFY' }>): Invoice => ({
      ...m,
      lines: refs.map((r, i) => ({ ...m.lines[0]!, lineNo: i + 1, modificationRef: r })),
      totals: computeTotals(refs.map((_, i) => ({ ...m.lines[0]!, lineNo: i + 1 })), { currency: 'HUF', exchangeRate: '1', paymentMethod: 'TRANSFER' }),
    });
    expect(errors(check(withRef([{ lineNumberReference: 3, lineOperation: 'CREATE' }])))).toEqual([]);
    expect(errors(check(withRef([{ lineNumberReference: 3, lineOperation: 'MODIFY' }])))).toEqual(['LINE_OPERATION_NOT_CREATE']);
    expect(errors(check(withRef([{ lineNumberReference: 3, lineOperation: 'CREATE' }, { lineNumberReference: 3, lineOperation: 'CREATE' }])))).toEqual(['LINE_REFERENCE_DUPLICATE']);
    const inv = draft([line()]);
    expect(errors(check({ ...inv, lines: inv.lines.map((l) => ({ ...l, modificationRef: { lineNumberReference: 1, lineOperation: 'CREATE' as const } })) }))).toEqual(['LINE_MODIFICATION_REF_NOT_EXPECTED']);
  });

  it('a correction follows the VAT regime of its original, even after the seller status changed', () => {
    const aamOriginal: Invoice = { ...INVOICE_PRIVATE_AAM, id: INVOICE_DOMESTIC.id, number: 'SZ-2026-00001' };
    const aamSeller: SellerProfile = { ...SELLER_NORMAL, vatStatus: 'aam', cashAccounting: false };
    const storno = (seller: SellerProfile): Invoice =>
      draft([line({ vatCode: 'AAM', quantity: '-1' })], { documentType: 'storno', reference: REF, number: 'SZ-2026-00002', customer: CUSTOMER_PRIVATE, seller });
    // The seller is 'normal' today, the storno carries the original's 'aam' regime: AAM lines are fine.
    expect(errors(check(storno(aamSeller), { original: aamOriginal }))).toEqual([]);
    // A storno composed with today's regime instead is refused (it would drop individualExemption).
    expect(errors(check(storno(SELLER_NORMAL), { original: aamOriginal }))).toEqual(['CORRECTION_SELLER_REGIME_MISMATCH']);
    const cash = check(mod({ seller: { ...SELLER_NORMAL, cashAccounting: true } }), { original: INVOICE_DOMESTIC });
    expect(errors(cash)).toEqual(['CORRECTION_SELLER_REGIME_MISMATCH']);
  });

  it('invoice number: no surrounding whitespace, ≤ 50 characters (NAV ERROR 51)', () => {
    const issued = (n: string): Invoice => ({ ...draft([line()]), status: 'issued', number: n });
    expect(errors(check(issued('SZ-2026-00001')))).toEqual([]);
    expect(errors(check(issued('SZ-2026-00001 ')))).toEqual(['NUMBER_WHITESPACE']);
    expect(errors(check(issued('S'.repeat(51))))).toEqual(['NUMBER_TOO_LONG']);
  });
});

describe('validateInvoice – advance and final invoices', () => {
  const deduction = { advanceInvoiceNumber: 'SZ-2026-00007', advancePaymentDate: '2026-10-01', advanceExchangeRate: '1' };

  it('a final invoice deducts the advance with a negative line', () => {
    expect(errors(check(draft([line(), line({ description: 'Előleg levonása', quantity: '-1', unitPrice: '50000', advanceDeduction: deduction })], { documentType: 'final' })))).toEqual([]);
    expect(errors(check(draft([line()], { documentType: 'final' })))).toEqual(['FINAL_WITHOUT_ADVANCE_DEDUCTION']);
    expect(errors(check(draft([line(), line({ quantity: '1', unitPrice: '50000', advanceDeduction: deduction })], { documentType: 'final' })))).toEqual(['LINE_ADVANCE_DEDUCTION_NOT_NEGATIVE']);
    expect(errors(check(draft([line(), line({ quantity: '-1', unitPrice: '50000', advanceDeduction: { ...deduction, advanceInvoiceNumber: '' } })], { documentType: 'final' })))).toEqual(['LINE_ADVANCE_NUMBER_REQUIRED']);
    expect(errors(check(draft([line({ quantity: '-1', unitPrice: '200000', advanceDeduction: deduction }), line()], { documentType: 'final' })))).toEqual(['NEGATIVE_TAX_BASE']);
  });

  it('advance invoices cannot deduct advances', () => {
    expect(errors(check(draft([line(), line({ quantity: '-1', unitPrice: '1000', advanceDeduction: deduction })], { documentType: 'advance' })))).toContain('LINE_ADVANCE_DEDUCTION_ON_ADVANCE');
  });

  it('foreign-currency final invoice: the advance rate is required, and 1 is suspicious (NAV advanceExchangeRate)', () => {
    const eurFinal = (rate: string): ValidationIssue[] =>
      check(draft([line({ vatCode: 'EUFAD37', unitPrice: '800' }), line({ vatCode: 'EUFAD37', description: 'Előleg levonása', quantity: '-1', unitPrice: '1000', advanceDeduction: { ...deduction, advanceExchangeRate: rate } })], { documentType: 'final', currency: 'EUR', exchangeRate: '390', customer: EU_DE }));
    expect(errors(eurFinal('0'))).toEqual(['LINE_ADVANCE_RATE_MISSING']);
    expect(errors(eurFinal(''))).toEqual(['LINE_ADVANCE_RATE_MISSING']);
    expect(errors(eurFinal('385'))).toEqual([]);
    expect(warnings(eurFinal('385'))).not.toContain('LINE_ADVANCE_RATE_ONE');
    expect(errors(eurFinal('1'))).toEqual([]);
    expect(warnings(eurFinal('1'))).toContain('LINE_ADVANCE_RATE_ONE');
  });
});

describe('validateInvoice – seller status rules', () => {
  it('KATA seller invoicing a payer (kifizető) – status ends (KATA 5. § (1) g))', () => {
    const kata: SellerProfile = { ...SELLER_NORMAL, smallBusiness: true, taxNumber: '12345676-1-26', euVatNumber: undefined, name: 'Kovács Anna e.v.', registrationNumber: '123' };
    expect(warnings(check(draft([line({ vatCode: '27' })], { seller: kata })))).toContain('KATA_PAYER_CUSTOMER');
    expect(warnings(check(draft([line({ vatCode: '27' })], { seller: kata, customer: CUSTOMER_PRIVATE })))).not.toContain('KATA_PAYER_CUSTOMER');
    expect(warnings(check(draft([line({ vatCode: 'EUFAD37' })], { seller: kata, customer: EU_DE })))).not.toContain('KATA_PAYER_CUSTOMER');
  });

  it('AAM threshold 2026: 20 000 000 Ft', () => {
    const big = (amount: string): string[] =>
      warnings(check(draft([line({ vatCode: 'AAM', quantity: '1', unitPrice: amount })], { seller: SELLER_AAM, customer: CUSTOMER_PRIVATE })));
    expect(big('20000001')).toContain('AAM_THRESHOLD_EXCEEDED');
    expect(big('20000000')).not.toContain('AAM_THRESHOLD_EXCEEDED');
  });

  it('seller and buyer issues are reported with prefixed field pointers', () => {
    const issues = check(draft([line()], { seller: { ...SELLER_NORMAL, taxNumber: 'x' }, customer: { ...CUSTOMER_DOMESTIC, address: { ...CUSTOMER_DOMESTIC.address, postalCode: '' } } }));
    expect(issues.find((i) => i.code === 'SELLER_TAX_NUMBER_INVALID')?.field).toBe('seller.taxNumber');
    expect(issues.find((i) => i.code === 'CUSTOMER_POSTAL_CODE_REQUIRED')?.field).toBe('customer.address.postalCode');
  });
});
