/**
 * Invoice arithmetic: the hand-computed fixtures, targeted rounding/edge cases, deterministic
 * property-based checks over hundreds of random invoices, and the mandatory notations.
 */
import { describe, expect, it } from 'vitest';
import { amountDecimals, buildNotations, cashRoundHuf, computeLine, computeLines, computeTotals, stornoLineInputs, type NotationContext } from '../../src/core/calc.ts';
import { D, dec, normDec, toDec } from '../../src/core/decimal.ts';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice, InvoiceLine, InvoiceLineInput, InvoiceTotals, PaymentMethod, VatCode } from '../../src/core/types.ts';
import { validateInvoice } from '../../src/core/validate.ts';
import { getVatInfo, VAT_CODES } from '../../src/core/vat.ts';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM, INVOICE_STORNO, SELLER_AAM, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { CANONICAL_DEC, CURRENCIES, exchangeRate, int, line as randomLine, mulberry32, pick } from './gen.ts';

const AMOUNT_FIELDS = ['netUnitPrice', 'netAmount', 'vatAmount', 'grossAmount', 'netAmountHuf', 'vatAmountHuf', 'grossAmountHuf'] as const;
const DEC_TOTAL_FIELDS = ['netAmount', 'vatAmount', 'grossAmount', 'netAmountHuf', 'vatAmountHuf', 'grossAmountHuf'] as const;

function inputsOf(lines: InvoiceLine[]): InvoiceLineInput[] {
  return lines.map(({ description, quantity, unit, unitPrice, priceBasis, vatCode, nature, vatReason }) => ({
    description, quantity, unit, unitPrice, priceBasis, vatCode, nature, ...(vatReason ? { vatReason } : {}),
  }));
}

function amounts(l: InvoiceLine): Record<string, string> {
  return Object.fromEntries(AMOUNT_FIELDS.map((k) => [k, l[k]]));
}

function line(over: Partial<InvoiceLineInput>): InvoiceLineInput {
  return { description: 'Tétel', quantity: '1', unit: 'db', unitPrice: '1000', priceBasis: 'net', vatCode: '27', nature: 'SERVICE', ...over };
}

const HUF = { currency: 'HUF', exchangeRate: '1' };

describe('fixtures (hand-computed sample invoices) are reproduced exactly', () => {
  for (const inv of [INVOICE_DOMESTIC, INVOICE_PRIVATE_AAM, INVOICE_EU_SERVICE]) {
    it(`${inv.id} ${inv.currency} ${inv.lines.map((l) => l.vatCode).join('+')}`, () => {
      const ctx = { currency: inv.currency, exchangeRate: inv.exchangeRate };
      const lines = computeLines(inputsOf(inv.lines), ctx);
      expect(lines.map(amounts)).toEqual(inv.lines.map(amounts));
      expect(computeTotals(lines, { ...ctx, paymentMethod: inv.paymentMethod })).toEqual(inv.totals);
    });
  }

  it('storno of INVOICE_DOMESTIC equals INVOICE_STORNO (every amount negated)', () => {
    const ctx = { currency: 'HUF', exchangeRate: '1' };
    const lines = computeLines(stornoLineInputs(INVOICE_DOMESTIC.lines), ctx);
    expect(lines.map(amounts)).toEqual(INVOICE_STORNO.lines.map(amounts));
    expect(lines.map((l) => l.quantity)).toEqual(['-10', '-2']);
    expect(computeTotals(lines, { ...ctx, paymentMethod: 'TRANSFER' })).toEqual(INVOICE_STORNO.totals);
  });

  it('fixture notations: AAM and storno', () => {
    const ctx = (inv: Invoice): NotationContext => ({ documentType: inv.documentType, seller: inv.seller, customer: inv.customer, lines: inv.lines, language: inv.language, reference: inv.reference });
    expect(buildNotations(ctx(INVOICE_PRIVATE_AAM))).toEqual(INVOICE_PRIVATE_AAM.notations);
    expect(buildNotations(ctx(INVOICE_STORNO))).toEqual(INVOICE_STORNO.notations);
    expect(buildNotations(ctx(INVOICE_DOMESTIC))).toEqual([]);
  });
});

describe('computeLine – rounding rules', () => {
  it('net basis: whole forints, ties away from zero, storno symmetric', () => {
    const a = computeLine(line({ quantity: '1', unitPrice: '50' }), 1, HUF); // VAT 13.5 → 14
    expect([a.netAmount, a.vatAmount, a.grossAmount]).toEqual(['50', '14', '64']);
    const s = computeLine(line({ quantity: '-1', unitPrice: '50' }), 1, HUF); // −13.5 → −14
    expect([s.netAmount, s.vatAmount, s.grossAmount]).toEqual(['-50', '-14', '-64']);
    const b = computeLine(line({ quantity: '3', unitPrice: '333.5' }), 1, HUF); // 1000.5 → 1001
    expect(b.netAmount).toBe('1001');
    expect(b.vatAmount).toBe('270'); // 270.27
  });

  it('gross basis: VAT extracted from the rounded gross, net is the remainder', () => {
    const l = computeLine(line({ quantity: '3', unitPrice: '100', priceBasis: 'gross' }), 1, HUF);
    expect([l.grossAmount, l.vatAmount, l.netAmount, l.netUnitPrice]).toEqual(['300', '64', '236', '78.666667']);
    const five = computeLine(line({ quantity: '1', unitPrice: '1050', priceBasis: 'gross', vatCode: '5' }), 1, HUF);
    expect([five.netAmount, five.vatAmount, five.grossAmount, five.netUnitPrice]).toEqual(['1000', '50', '1050', '1000']);
  });

  it('non-percentage codes never carry VAT, whatever the price basis', () => {
    for (const code of VAT_CODES.filter((c) => getVatInfo(c).nav.kind !== 'vatPercentage')) {
      for (const priceBasis of ['net', 'gross'] as const) {
        const l = computeLine(line({ vatCode: code, priceBasis, quantity: '3', unitPrice: '333.33' }), 1, HUF);
        expect([l.vatAmount, l.vatAmountHuf, l.netAmount, l.grossAmount], code).toEqual(['0', '0', '1000', '1000']);
      }
    }
  });

  it('foreign currency: HUF amounts with 2 decimals, gross HUF = net HUF + VAT HUF', () => {
    const l = computeLine(line({ quantity: '1', unitPrice: '99.99' }), 1, { currency: 'EUR', exchangeRate: '391.456789' });
    expect([l.netAmount, l.vatAmount, l.grossAmount]).toEqual(['99.99', '27', '126.99']);
    expect(l.netAmountHuf).toBe('39141.76'); // 99.99 × 391.456789 = 39141.7643…
    expect(l.vatAmountHuf).toBe('10569.33'); // 27 × 391.456789 = 10569.333303
    expect(l.grossAmountHuf).toBe('49711.09');
  });

  it('0-decimal currencies (JPY): whole units, HUF with 2 decimals', () => {
    const l = computeLine(line({ quantity: '1', unitPrice: '1234.5' }), 1, { currency: 'JPY', exchangeRate: '2.0889' });
    expect([l.netAmount, l.vatAmount, l.grossAmount]).toEqual(['1235', '333', '1568']); // 333.45 → 333
    expect(l.netAmountHuf).toBe('2579.79'); // 1235 × 2.0889 = 2579.7915
  });

  it('regression: 3-decimal currencies are rounded to 0.01 (NAV MonetaryType has 2 fraction digits)', () => {
    expect(amountDecimals('KWD')).toBe(2);
    expect(amountDecimals('HUF')).toBe(0);
    expect(amountDecimals('EUR')).toBe(2);
    const l = computeLine(line({ quantity: '1', unitPrice: '10.123' }), 1, { currency: 'KWD', exchangeRate: '1100.5' });
    expect([l.netAmount, l.vatAmount, l.grossAmount]).toEqual(['10.12', '2.73', '12.85']);
  });

  it('6-decimal quantities and unit prices with many decimals', () => {
    const l = computeLine(line({ quantity: '1.123456', unitPrice: '1000' }), 1, HUF);
    expect(l.netAmount).toBe('1123');
    const m = computeLine(line({ quantity: '3', unitPrice: '0.333333333333' }), 1, HUF);
    expect(m.netAmount).toBe('1');
    expect(m.netUnitPrice).toBe('0.333333333333');
  });

  it('very large amounts stay exact and never use exponent notation', () => {
    const l = computeLine(line({ quantity: '1000000', unitPrice: '99999999999.99' }), 1, HUF);
    expect(l.netAmount).toBe('99999999999990000');
    expect(l.vatAmount).toBe('26999999999997300');
    expect(l.grossAmount).toBe('126999999999987300');
    const e = computeLine(line({ quantity: '123456789012', unitPrice: '987654321.123456' }), 1, { currency: 'EUR', exchangeRate: '400.123456' });
    for (const k of AMOUNT_FIELDS) expect(e[k], k).toMatch(CANONICAL_DEC);
  });

  it('negative quantities and prices (corrections, discounts)', () => {
    const l = computeLine(line({ quantity: '-2', unitPrice: '1234.5', priceBasis: 'gross' }), 1, HUF);
    expect([l.grossAmount, l.vatAmount, l.netAmount, l.netUnitPrice]).toEqual(['-2469', '-525', '-1944', '972']);
    const d = computeLine(line({ quantity: '1', unitPrice: '-10000' }), 1, HUF);
    expect([d.netAmount, d.vatAmount, d.grossAmount]).toEqual(['-10000', '-2700', '-12700']);
  });

  it('regression: currency codes with stray whitespace / lower case still round HUF to whole forints', () => {
    const l = computeLine(line({ quantity: '1', unitPrice: '99.5' }), 1, { currency: ' huf ', exchangeRate: '1' });
    expect([l.netAmount, l.vatAmount, l.grossAmount, l.netAmountHuf]).toEqual(['100', '27', '127', '100']);
    expect(amountDecimals(' huf ')).toBe(0);
  });

  it('regression: quantity and unit price are returned canonical', () => {
    const l = computeLine(line({ quantity: ' 1.50 ', unitPrice: '15000.00' }), 1, HUF);
    expect(l.quantity).toBe('1.5');
    expect(l.unitPrice).toBe('15000');
    expect(l.netUnitPrice).toBe('15000');
  });

  it('regression: gross-priced lines with huge quantities keep quantity × netUnitPrice ≈ net (NAV 740)', () => {
    const l = computeLine(line({ quantity: '2000000', unitPrice: '0.33', priceBasis: 'gross' }), 1, HUF);
    expect([l.grossAmount, l.vatAmount, l.netAmount]).toEqual(['660000', '140315', '519685']);
    expect(dec(l.quantity).times(l.netUnitPrice).toDecimalPlaces(0).toFixed()).toBe(l.netAmount);
    expect(l.netUnitPrice).toBe('0.2598425');
  });

  it('quantity 0 does not crash the preview', () => {
    const l = computeLine(line({ quantity: '0', unitPrice: '127', priceBasis: 'gross' }), 1, HUF);
    expect([l.netAmount, l.vatAmount, l.grossAmount, l.netUnitPrice]).toEqual(['0', '0', '0', '100']);
  });

  it('strict number parsing: whitespace is trimmed, separators and exponents are rejected', () => {
    expect(computeLine(line({ quantity: ' 2 ', unitPrice: '\t100 ' }), 1, HUF).netAmount).toBe('200');
    for (const bad of ['1 000', '1,5', '1e3', '', 'NaN', '+5', '.5', '5.']) {
      expect(() => computeLine(line({ unitPrice: bad }), 1, HUF), bad).toThrow(AppError);
    }
  });

  it('unknown VAT codes throw INVALID_VAT_CODE – also for Object.prototype keys (regression)', () => {
    for (const code of ['99', 'XYZ', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      try {
        computeLine(line({ vatCode: code as VatCode }), 1, HUF);
        expect.unreachable(code);
      } catch (e) {
        expect(e, code).toBeInstanceOf(AppError);
        expect((e as AppError).code, code).toBe('INVALID_VAT_CODE');
      }
    }
  });
});

describe('computeTotals', () => {
  it('empty lines array → zero totals, no VAT rows', () => {
    expect(computeTotals([], { ...HUF, paymentMethod: 'CASH' })).toEqual({
      netAmount: '0', vatAmount: '0', grossAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0',
      byVat: [], payableAmount: '0', roundingDifference: '0',
    });
  });

  it('VAT summary rows in first-appearance order, one per code', () => {
    const lines = computeLines([line({ vatCode: '5' }), line({ vatCode: '27' }), line({ vatCode: '5', unitPrice: '1' }), line({ vatCode: 'TAM' })], HUF);
    const t = computeTotals(lines, { ...HUF, paymentMethod: 'TRANSFER' });
    expect(t.byVat.map((r) => [r.vatCode, r.netAmount, r.vatAmount])).toEqual([['5', '1001', '50'], ['27', '1000', '270'], ['TAM', '1000', '0']]);
  });

  it('cash rounding only for HUF + CASH, on the payable amount only', () => {
    const lines = computeLines([line({ unitPrice: '99', vatCode: 'AAM' })], HUF);
    expect(computeTotals(lines, { ...HUF, paymentMethod: 'CASH' })).toMatchObject({ grossAmount: '99', payableAmount: '100', roundingDifference: '1' });
    for (const pm of ['TRANSFER', 'CARD', 'VOUCHER', 'OTHER'] as PaymentMethod[]) {
      expect(computeTotals(lines, { ...HUF, paymentMethod: pm }), pm).toMatchObject({ payableAmount: '99', roundingDifference: '0' });
    }
    const eur = computeLines([line({ unitPrice: '1.01' })], { currency: 'EUR', exchangeRate: '400' });
    expect(computeTotals(eur, { currency: 'EUR', exchangeRate: '400', paymentMethod: 'CASH' })).toMatchObject({ payableAmount: '1.28', roundingDifference: '0' });
  });
});

describe('cashRoundHuf (2008. évi III. tv. 2. §)', () => {
  const cases: Array<[string, string]> = [
    ['127', '125'], ['128', '130'], ['122.49', '120'], ['122.5', '125'], ['1234', '1235'], ['1236', '1235'], ['1237.49', '1235'],
    ['1237.5', '1240'], ['1240', '1240'], ['1245', '1245'], ['1241', '1240'], ['1242.49', '1240'], ['1249.99', '1250'], ['0.01', '0'],
    ['125.01', '125'], ['0', '0'], ['-127', '-125'], ['-122.5', '-125'], ['-24998', '-25000'], ['24998', '25000'],
  ];
  for (const [inp, out] of cases) it(`${inp} → ${out}`, () => expect(cashRoundHuf(inp)).toBe(out));
});

// ---------------------------------------------------------------------------------------------
// Property-based checks (seeded – every run checks the same 400 invoices)
// ---------------------------------------------------------------------------------------------

interface Generated {
  currency: string;
  exchangeRate: string;
  paymentMethod: PaymentMethod;
  inputs: InvoiceLineInput[];
  lines: InvoiceLine[];
  totals: InvoiceTotals;
}

function generate(seed: number, count: number): Generated[] {
  const rnd = mulberry32(seed);
  const out: Generated[] = [];
  for (let n = 0; n < count; n++) {
    const currency = pick(rnd, CURRENCIES);
    const rate = exchangeRate(rnd, currency);
    const paymentMethod = pick<PaymentMethod>(rnd, ['TRANSFER', 'CASH', 'CASH', 'CARD']);
    const inputs = Array.from({ length: int(rnd, 0, 12) }, () => randomLine(rnd));
    const ctx = { currency, exchangeRate: rate };
    const lines = computeLines(inputs, ctx);
    out.push({ currency, exchangeRate: rate, paymentMethod, inputs, lines, totals: computeTotals(lines, { ...ctx, paymentMethod }) });
  }
  return out;
}

const SAMPLES = generate(20261027, 400);
const sum = (vals: string[]): string => toDec(vals.reduce((a, v) => a.plus(v), new D(0)));

describe('property-based: 400 random invoices (seed 20261027)', () => {
  it('generates a meaningful mix (currencies, codes, gross prices, negatives, empty invoices)', () => {
    const all = SAMPLES.flatMap((s) => s.lines);
    expect(all.length).toBeGreaterThan(2000);
    expect(new Set(SAMPLES.map((s) => s.currency)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(all.map((l) => l.vatCode)).size).toBe(VAT_CODES.length);
    expect(all.some((l) => l.priceBasis === 'gross' && dec(l.quantity).isNegative())).toBe(true);
    expect(SAMPLES.some((s) => s.lines.length === 0)).toBe(true);
  });

  it('every output is a canonical decimal string (no float leakage)', () => {
    for (const s of SAMPLES) {
      for (const l of s.lines) for (const k of [...AMOUNT_FIELDS, 'quantity', 'unitPrice'] as const) expect(l[k], k).toMatch(CANONICAL_DEC);
      for (const k of [...DEC_TOTAL_FIELDS, 'payableAmount', 'roundingDifference'] as const) expect(s.totals[k], k).toMatch(CANONICAL_DEC);
      for (const r of s.totals.byVat) for (const k of DEC_TOTAL_FIELDS) expect(r[k], k).toMatch(CANONICAL_DEC);
    }
  });

  it('per line: net + VAT = gross (currency and HUF), amount decimals, HUF identity for HUF invoices', () => {
    for (const s of SAMPLES) {
      const dp = amountDecimals(s.currency);
      for (const l of s.lines) {
        expect(dec(l.netAmount).plus(l.vatAmount).eq(l.grossAmount)).toBe(true);
        expect(dec(l.netAmountHuf).plus(l.vatAmountHuf).eq(l.grossAmountHuf)).toBe(true);
        for (const k of ['netAmount', 'vatAmount', 'grossAmount'] as const) expect(dec(l[k]).decimalPlaces()).toBeLessThanOrEqual(dp);
        for (const k of ['netAmountHuf', 'vatAmountHuf', 'grossAmountHuf'] as const) expect(dec(l[k]).decimalPlaces()).toBeLessThanOrEqual(s.currency === 'HUF' ? 0 : 2);
        if (s.currency === 'HUF') expect([l.netAmountHuf, l.vatAmountHuf, l.grossAmountHuf]).toEqual([l.netAmount, l.vatAmount, l.grossAmount]);
      }
    }
  });

  it('per line: the price basis amount is exactly round(quantity × unit price); VAT matches the rate', () => {
    for (const s of SAMPLES) {
      const dp = amountDecimals(s.currency);
      const unit = new D(10).pow(-dp);
      for (const l of s.lines) {
        const base = dec(l.quantity).times(l.unitPrice).toDecimalPlaces(dp, D.ROUND_HALF_UP);
        const info = getVatInfo(l.vatCode);
        expect(dec(l.priceBasis === 'gross' ? l.grossAmount : l.netAmount).eq(base)).toBe(true);
        if (info.nav.kind !== 'vatPercentage') {
          expect([l.vatAmount, l.vatAmountHuf]).toEqual(['0', '0']);
          continue;
        }
        const r = dec(info.rate);
        const dev = dec(l.vatAmount).minus(dec(l.netAmount).times(r)).abs();
        // net basis: VAT = round(net × r) → ≤ ½ unit; gross basis: VAT = round(gross·r/(1+r)) → ≤ (1+r)·½ unit
        expect(dev.lte(unit.times(l.priceBasis === 'gross' ? r.plus(1) : 1).div(2)), `${l.vatCode} ${l.priceBasis} ${l.quantity}×${l.unitPrice}`).toBe(true);
      }
    }
  });

  it('gross-priced lines: quantity × netUnitPrice rounds back to the net amount (NAV 740), ≤ 10 decimals', () => {
    for (const s of SAMPLES) {
      const dp = amountDecimals(s.currency);
      for (const l of s.lines.filter((x) => x.priceBasis === 'gross')) {
        expect(dec(l.netUnitPrice).decimalPlaces()).toBeLessThanOrEqual(10);
        expect(dec(l.quantity).times(l.netUnitPrice).toDecimalPlaces(dp, D.ROUND_HALF_UP).eq(l.netAmount), `${l.quantity} × ${l.netUnitPrice} vs ${l.netAmount}`).toBe(true);
      }
    }
  });

  it('HUF conversion: within ½ fillér of amount × rate per line – far inside NAV tolerance (1 %, ≥ 1 HUF)', () => {
    for (const s of SAMPLES.filter((x) => x.currency !== 'HUF')) {
      for (const l of s.lines) {
        for (const [huf, amt] of [[l.netAmountHuf, l.netAmount], [l.vatAmountHuf, l.vatAmount]] as const) {
          expect(dec(huf).minus(dec(amt).times(s.exchangeRate)).abs().lte('0.005')).toBe(true);
        }
        const exact = dec(l.grossAmount).times(s.exchangeRate);
        const tolerance = D.max(exact.abs().times('0.01'), 1);
        expect(dec(l.grossAmountHuf).minus(exact).abs().lte('0.01')).toBe(true);
        expect(dec(l.grossAmountHuf).minus(exact).abs().lte(tolerance)).toBe(true);
      }
      // invoice level (NAV 1070/1071): totals × rate vs HUF totals
      for (const [amt, hufAmt] of [['netAmount', 'netAmountHuf'], ['vatAmount', 'vatAmountHuf'], ['grossAmount', 'grossAmountHuf']] as const) {
        const exact = dec(s.totals[amt]).times(s.exchangeRate);
        const tolerance = D.max(exact.abs().times('0.01'), 1);
        expect(dec(s.totals[hufAmt]).minus(exact).abs().lte(tolerance), `${amt} ${s.currency}`).toBe(true);
      }
    }
  });

  it('totals = Σ lines, VAT rows = Σ lines per code, Σ VAT rows = totals; net + VAT = gross everywhere', () => {
    for (const s of SAMPLES) {
      for (const k of DEC_TOTAL_FIELDS) {
        expect(s.totals[k], k).toBe(sum(s.lines.map((l) => l[k])));
        expect(s.totals[k], k).toBe(sum(s.totals.byVat.map((r) => r[k])));
      }
      expect(dec(s.totals.netAmount).plus(s.totals.vatAmount).eq(s.totals.grossAmount)).toBe(true);
      expect(dec(s.totals.netAmountHuf).plus(s.totals.vatAmountHuf).eq(s.totals.grossAmountHuf)).toBe(true);
      const firstSeen = [...new Set(s.lines.map((l) => l.vatCode))];
      expect(s.totals.byVat.map((r) => r.vatCode)).toEqual(firstSeen);
      for (const r of s.totals.byVat) {
        const of = s.lines.filter((l) => l.vatCode === r.vatCode);
        for (const k of DEC_TOTAL_FIELDS) expect(r[k], `${r.vatCode}.${k}`).toBe(sum(of.map((l) => l[k])));
        expect(dec(r.netAmount).plus(r.vatAmount).eq(r.grossAmount)).toBe(true);
      }
    }
  });

  it('payable: HUF + CASH rounded to 0/5 Ft (|diff| ≤ 2.5), otherwise exactly the gross total', () => {
    for (const s of SAMPLES) {
      const gross = dec(s.totals.grossAmount);
      const payable = dec(s.totals.payableAmount);
      expect(dec(s.totals.roundingDifference).eq(payable.minus(gross))).toBe(true);
      if (s.currency === 'HUF' && s.paymentMethod === 'CASH') {
        expect(payable.mod(5).isZero()).toBe(true);
        expect(payable.minus(gross).abs().lte('2.5')).toBe(true);
      } else {
        expect(payable.eq(gross)).toBe(true);
      }
    }
  });

  it('storno of any invoice sums to exactly −original (every line, every total, payable)', () => {
    for (const s of SAMPLES) {
      const ctx = { currency: s.currency, exchangeRate: s.exchangeRate };
      const st = computeLines(stornoLineInputs(s.lines), ctx);
      st.forEach((l, i) => {
        const o = s.lines[i] as InvoiceLine;
        for (const k of ['netAmount', 'vatAmount', 'grossAmount', 'netAmountHuf', 'vatAmountHuf', 'grossAmountHuf'] as const) expect(l[k], k).toBe(normDec(dec(o[k]).neg()));
        expect(l.netUnitPrice).toBe(o.netUnitPrice);
      });
      const t = computeTotals(st, { ...ctx, paymentMethod: s.paymentMethod });
      for (const k of [...DEC_TOTAL_FIELDS, 'payableAmount', 'roundingDifference'] as const) expect(t[k], k).toBe(normDec(dec(s.totals[k]).neg()));
      expect(t.byVat.map((r) => r.vatCode)).toEqual(s.totals.byVat.map((r) => r.vatCode));
    }
  });

  it('a storno of original + modification nets the whole chain to zero', () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 50; n++) {
      const currency = pick(rnd, CURRENCIES);
      const ctx = { currency, exchangeRate: exchangeRate(rnd, currency) };
      const original = computeLines(Array.from({ length: int(rnd, 1, 6) }, () => randomLine(rnd)), ctx);
      const modification = computeLines(Array.from({ length: int(rnd, 1, 3) }, () => randomLine(rnd)), ctx);
      const storno = computeLines(stornoLineInputs([...original, ...modification]), ctx);
      for (const k of DEC_TOTAL_FIELDS) expect(sum([...original, ...modification, ...storno].map((l) => l[k])), k).toBe('0');
    }
  });

  it('cross-check with validateInvoice: computed invoices never trip an amount-consistency rule', () => {
    const amountCodes = new Set([
      'LINE_AMOUNTS_STALE', 'LINE_AMOUNTS_INCONSISTENT', 'LINE_AMOUNTS_INVALID', 'LINE_VAT_NOT_ZERO', 'LINE_NET_UNIT_PRICE_INVALID',
      'TOTALS_MISMATCH', 'TOTALS_INCONSISTENT', 'PAYABLE_MISMATCH', 'VAT_SUMMARY_MISMATCH', 'VAT_SUMMARY_MISSING_ROW',
      'VAT_SUMMARY_EXTRA_ROW', 'VAT_SUMMARY_TOTAL_MISMATCH', 'VAT_SUMMARY_VAT_NOT_ZERO', 'VAT_SUMMARY_INCONSISTENT',
    ]);
    for (const s of SAMPLES) {
      const inv: Invoice = {
        ...INVOICE_DOMESTIC,
        currency: s.currency,
        exchangeRate: s.exchangeRate,
        exchangeRateDate: s.currency === 'HUF' ? null : '2026-10-27',
        paymentMethod: s.paymentMethod,
        lines: s.lines,
        totals: s.totals,
      };
      const bad = validateInvoice(inv, { today: '2026-10-27' }).filter((i) => amountCodes.has(i.code));
      expect(bad, JSON.stringify(bad.slice(0, 2))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Notations
// ---------------------------------------------------------------------------------------------

function notations(codes: Array<VatCode | [VatCode, string]>, over: Partial<NotationContext> = {}): string[] {
  const lines = computeLines(codes.map((c) => (Array.isArray(c) ? line({ vatCode: c[0], vatReason: c[1] }) : line({ vatCode: c }))), HUF);
  return buildNotations({ documentType: 'invoice', seller: SELLER_NORMAL, customer: CUSTOMER_DOMESTIC, lines, language: 'hu', reference: null, ...over });
}

const STATUTORY: Partial<Record<VatCode, string>> = {
  FAD: 'fordított adózás',
  EUFAD37: 'fordított adózás',
  EUFADE: 'fordított adózás',
  KUL_UTAZAS: 'különbözet szerinti szabályozás – utazási irodák',
  KUL_HASZNALT: 'különbözet szerinti szabályozás – használt cikkek',
  KUL_MUALKOTAS: 'különbözet szerinti szabályozás – műalkotások',
  KUL_REGISEG: 'különbözet szerinti szabályozás – gyűjteménydarabok és régiségek',
};

describe('buildNotations', () => {
  it('statutory expressions are printed verbatim in every language (169. § n, p, q)', () => {
    for (const [code, expr] of Object.entries(STATUTORY) as Array<[VatCode, string]>) {
      for (const language of ['hu', 'en', 'hu-en'] as const) {
        const out = notations([code], { language });
        expect(out.length, `${code} ${language}`).toBe(1);
        expect(out[0], `${code} ${language}`).toContain(expr);
      }
    }
  });

  it('regression: English invoices keep the Hungarian expression ("magyar / English")', () => {
    expect(notations(['FAD'], { language: 'en' })).toEqual(['fordított adózás / Reverse charge']);
    expect(notations(['EUFAD37'], { language: 'en' })).toEqual(['fordított adózás / Reverse charge (Article 196 of Directive 2006/112/EC)']);
    expect(notations(['KUL_HASZNALT'], { language: 'en' })).toEqual(['különbözet szerinti szabályozás – használt cikkek / Margin scheme – second-hand goods']);
    const cash = { ...SELLER_NORMAL, cashAccounting: true };
    expect(notations(['27'], { language: 'en', seller: cash })).toEqual(['pénzforgalmi elszámolás / Cash accounting']);
    expect(notations(['27'], { language: 'hu', seller: cash })).toEqual(['pénzforgalmi elszámolás']);
    // exemptions only need an unambiguous indication (169. § m) – English is enough there
    expect(notations(['KBAET'], { language: 'en' })).toEqual(['Exempt intra-Community supply of goods (Article 138 of Directive 2006/112/EC)']);
  });

  it('hu and hu-en texts', () => {
    expect(notations(['FAD'])).toEqual(['fordított adózás']);
    expect(notations(['EUFAD37'], { language: 'hu-en' })).toEqual([
      'fordított adózás – a teljesítés helye az Áfa tv. 37. § (1) bekezdése alapján a vevő tagállama / Reverse charge (Article 196 of Directive 2006/112/EC)',
    ]);
    expect(notations(['AAM'], { seller: SELLER_AAM })).toEqual(['Alanyi adómentes (Áfa tv. XIII. fejezet)']);
    expect(notations(['KUL_REGISEG'])[0]).toContain('régiségek');
    expect(notations(['KUL_REGISEG'])[0]).not.toContain('régisek');
    expect(notations(['NAM'])).toEqual(['Adómentes nemzetközi ügylet (Áfa tv. 110–118. §)']);
  });

  it('vatReason overrides exemption texts but never removes a statutory expression', () => {
    expect(notations([['TAM', 'Áfa tv. 85. § (1) e) – oktatás']])).toEqual(['Áfa tv. 85. § (1) e) – oktatás']);
    expect(notations([['FAD', 'Áfa tv. 142. § (1) b)']])).toEqual(['fordított adózás – Áfa tv. 142. § (1) b)']);
    expect(notations([['FAD', 'Fordított adózás – Áfa tv. 142. § (1) b)']])).toEqual(['Fordított adózás – Áfa tv. 142. § (1) b)']);
    expect(notations([['FAD', 'Áfa tv. 142. § (1) b)']], { language: 'en' })).toEqual(['fordított adózás / Reverse charge – Áfa tv. 142. § (1) b)']);
    expect(notations([['FAD', 'Reverse charge – Art. 199 Directive 2006/112/EC']], { language: 'en' })).toEqual(['fordított adózás / Reverse charge – Art. 199 Directive 2006/112/EC']);
    expect(notations([['KUL_HASZNALT', '222. §']])).toEqual(['különbözet szerinti szabályozás – használt cikkek – 222. §']);
  });

  it('deduplicated, stable order: document type, VAT notations in line order, cash accounting last', () => {
    const cash = { ...SELLER_NORMAL, cashAccounting: true };
    const ref = { originalInvoiceId: 'inv_1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 2, modifyWithoutMaster: false };
    expect(notations(['FAD', '27', 'TAM', 'FAD'], { seller: cash, documentType: 'modification', reference: ref })).toEqual([
      'Módosító számla – az eredeti számla sorszáma: SZ-2026-00001, módosítás sorszáma: 2',
      'fordított adózás',
      'Tárgyi adómentes (Áfa tv. 85–86. §)',
      'pénzforgalmi elszámolás',
    ]);
  });

  it('pénzforgalmi elszámolás only when a line is taxed at a percentage rate', () => {
    const cash = { ...SELLER_NORMAL, cashAccounting: true };
    expect(notations(['KBAET'], { seller: cash })).not.toContain('pénzforgalmi elszámolás');
    expect(notations(['FAD'], { seller: cash })).not.toContain('pénzforgalmi elszámolás');
    expect(notations(['0'], { seller: cash })).toContain('pénzforgalmi elszámolás');
  });

  it('advance and final invoices', () => {
    expect(notations(['27'], { documentType: 'advance' })[0]).toMatch(/^Előlegszámla/);
    const lines = computeLines(
      [line({}), line({ quantity: '-1', advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00007', advancePaymentDate: '2026-10-01', advanceExchangeRate: '1' } })],
      HUF,
    );
    expect(buildNotations({ documentType: 'final', seller: SELLER_NORMAL, customer: CUSTOMER_DOMESTIC, lines, language: 'hu', reference: null })).toEqual([
      'Végszámla – a levont előlegszámla sorszáma: SZ-2026-00007',
    ]);
  });

  it('unknown codes are skipped (validateInvoice reports them)', () => {
    const bad = { ...computeLine(line({}), 1, HUF), vatCode: 'XX' as VatCode };
    expect(buildNotations({ documentType: 'invoice', seller: SELLER_NORMAL, customer: CUSTOMER_DOMESTIC, lines: [bad], language: 'hu', reference: null })).toEqual([]);
  });
});
