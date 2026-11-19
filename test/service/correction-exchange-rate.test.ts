/**
 * The exchange rate of a correction (TAX-3): a módosító and a sztornó számla use the rate of the invoice
 * they correct – the rate of that supply's tax point. Another rate on a modification draft is refused
 * (CORRECTION_EXCHANGE_RATE_FIXED; a wrong rate is corrected with a storno and a new invoice), the same
 * value changes nothing, and a stored draft with another rate (older version) cannot be issued. So a
 * modification followed by a storno nets the chain to exactly 0, in the invoice currency and in HUF.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { dec, sumDec, toDec } from '../../src/core/decimal.ts';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const errorCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);

/** MNB reply with EUR 391,5 published on 2026-10-26 and 402,25 on 2026-10-22; counts the requests. */
function mnb(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const days = [['2026-10-26', '391,5'], ['2026-10-22', '402,25']].map(([d, r]) => `&lt;Day date="${d}"&gt;&lt;Rate unit="1" curr="EUR"&gt;${r}&lt;/Rate&gt;&lt;/Day&gt;`).join('');
  const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;${days}&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
  const f = (async () => {
    calls++;
    return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => calls };
}

function setup(fetchImpl?: typeof fetch): OpenSzamla {
  t = makeTestApp({ now: () => new Date('2026-10-27T09:00:00.000Z'), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const LICENCE = [{ description: 'Licenc', quantity: '10', unit: 'db', unitPrice: '100', vatCode: '27' as const }];
const RETURN = [{ description: 'Licenc visszáru', quantity: '-2', unit: 'db', unitPrice: '100', vatCode: '27' as const }];

async function original(app: OpenSzamla, extra: Record<string, unknown>): Promise<Invoice> {
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, currency: 'EUR', fulfillmentDate: '2026-10-26', lines: LICENCE, ...extra });
  expect(errorCodes(d.issues), JSON.stringify(d.issues)).toEqual([]);
  return (await app.issue(d.invoice.id)).invoice;
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected CORRECTION_EXCHANGE_RATE_FIXED');
}

/** Σ over the documents of a chain, per amount field – each must be exactly 0 after the storno. */
function chainSums(docs: Invoice[]): Record<string, string> {
  const fields = ['netAmount', 'vatAmount', 'grossAmount', 'netAmountHuf', 'vatAmountHuf', 'grossAmountHuf'] as const;
  return Object.fromEntries(fields.map((f) => [f, toDec(sumDec(docs.map((d) => d.totals[f])))]));
}
const ZERO = { netAmount: '0', vatAmount: '0', grossAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0' };

describe('a correction uses the exchange rate of its original', () => {
  for (const policy of ['MNB', 'manual'] as const) {
    it(`${policy} policy: another rate is refused, the same one is accepted; modification + storno net to 0 in EUR and HUF`, async () => {
      const m = mnb();
      const app = setup(m.fetch);
      if (policy === 'manual') app.updateDefaults({ exchangeRateSource: 'manual' });
      const orig = await original(app, policy === 'manual' ? { exchangeRate: '391.5' } : {});
      expect([orig.exchangeRate, orig.exchangeRateSource]).toEqual(['391.5', policy]);
      const fetched = m.calls();

      const corr = await app.createCorrectionDraft(orig.id, { lines: RETURN, comment: 'Visszáru' });
      expect([corr.invoice.exchangeRate, corr.invoice.exchangeRateDate, corr.invoice.exchangeRateSource]).toEqual([orig.exchangeRate, orig.exchangeRateDate, orig.exchangeRateSource]);
      expect(corr.readyToIssue, JSON.stringify(corr.issues)).toBe(true);

      // What the old exchangeRate description told agents to do: refused, the draft stays as it was.
      const e = await refusal(app.updateDraft(corr.invoice.id, { exchangeRate: '402.25' }));
      expect(e.code).toBe('CORRECTION_EXCHANGE_RATE_FIXED');
      expect(e.message).toContain('az eredeti számla (SZ-2026-00001) árfolyamát használja (1 EUR = 391.5 HUF)');
      expect(e.message).toContain('megadva: 402.25');
      expect(e.hint).toMatch(/sztornózd a számlát/);
      expect((await refusal(app.updateDraft(corr.invoice.id, { fulfillmentDate: '2026-10-22', exchangeRate: '402.25' }))).code).toBe('CORRECTION_EXCHANGE_RATE_FIXED');
      expect([app.getInvoice(corr.invoice.id).exchangeRate, app.getInvoice(corr.invoice.id).fulfillmentDate]).toEqual(['391.5', '2026-10-26']);

      // The same value (in another notation) changes nothing; a new fulfilment date keeps the rate.
      const same = await app.updateDraft(corr.invoice.id, { exchangeRate: '391.50' });
      expect([same.invoice.exchangeRate, same.invoice.exchangeRateSource]).toEqual(['391.5', policy]);
      expect(errorCodes(same.issues)).toEqual([]);
      const moved = await app.updateDraft(corr.invoice.id, { fulfillmentDate: '2026-10-22' });
      expect([moved.invoice.exchangeRate, moved.invoice.exchangeRateDate]).toEqual(['391.5', orig.exchangeRateDate]);
      expect(errorCodes(moved.issues)).toEqual([]);
      await app.updateDraft(corr.invoice.id, { fulfillmentDate: '2026-10-26' });
      expect(m.calls()).toBe(fetched);

      const mod = (await app.issue(corr.invoice.id)).invoice;
      expect([mod.exchangeRate, mod.totals.vatAmount, mod.totals.vatAmountHuf]).toEqual(['391.5', '-54', '-21141']);
      const xml = buildInvoiceDataXml(mod);
      expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
      expect(/<exchangeRate>([^<]*)<\/exchangeRate>/.exec(xml)?.[1]).toBe('391.5');

      const storno = (await app.cancel(orig.id, { reason: 'Szerződés felbontva' })).invoice;
      expect(storno.exchangeRate).toBe('391.5');
      expect(chainSums([orig, mod, storno])).toEqual(ZERO);
    });
  }

  it('HUF: only rate 1 can be given on a correction draft', async () => {
    const app = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const orig = (await app.issue((await app.createDraft({ customerId, lines: LICENCE })).invoice.id)).invoice;
    const corr = await app.createCorrectionDraft(orig.id, { lines: RETURN, comment: 'Visszáru' });
    expect((await app.updateDraft(corr.invoice.id, { exchangeRate: '1' })).invoice.exchangeRate).toBe('1');
    const e = await refusal(app.updateDraft(corr.invoice.id, { exchangeRate: '400' }));
    expect(e.code).toBe('CORRECTION_EXCHANGE_RATE_FIXED');
    expect(e.message).toContain('forintos számla, árfolyama 1');
  });

  it('a stored modification draft with another rate (older version) is not issued; the next save takes the original rate', async () => {
    const app = setup(mnb().fetch);
    const orig = await original(app, {});
    const corr = await app.createCorrectionDraft(orig.id, { lines: RETURN, comment: 'Visszáru' });
    // What an older version stored after invoice_draft { draftId, exchangeRate: 402.25 }.
    app.store.updateDraft({ ...app.getInvoice(corr.invoice.id), exchangeRate: '402.25', exchangeRateDate: '2026-10-26', exchangeRateSource: 'manual' });

    const view = app.viewInvoice(corr.invoice.id);
    expect(view.readyToIssue).toBe(false);
    const problem = view.issues.find((i) => i.code === 'CORRECTION_EXCHANGE_RATE_FIXED');
    expect(problem).toMatchObject({ severity: 'error', field: 'exchangeRate' });
    expect(problem?.message).toContain('árfolyama (402.25) eltér az eredeti számláétól (391.5)');
    expect(app.stornoPreview(orig.id, 'Téves').issues.map((i) => i.code)).not.toContain('CORRECTION_EXCHANGE_RATE_FIXED');
    await expect(app.issue(corr.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(app.getInvoice(corr.invoice.id).status).toBe('draft');

    const saved = await app.updateDraft(corr.invoice.id, { comment: 'Visszáru (2 db)' });
    expect([saved.invoice.exchangeRate, saved.invoice.exchangeRateSource]).toEqual(['391.5', 'MNB']);
    expect(saved.readyToIssue, JSON.stringify(saved.issues)).toBe(true);
    const mod = (await app.issue(corr.invoice.id)).invoice;
    // No number was used up by the refused attempt.
    expect(mod.number).toBe('SZ-2026-00002');
    expect(dec(mod.totals.vatAmountHuf).eq(dec(mod.totals.vatAmount).times('391.5'))).toBe(true);
  });
});
