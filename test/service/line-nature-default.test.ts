/**
 * The nature (termék / szolgáltatás, NAV lineNatureIndicator) of a line given without one (MCP-3):
 * given nature > the product's > the nature a VAT code implies when the unit is missing or "db" >
 * the unit's > OTHER without a unit. The nature warnings point at lines[i].nature.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LineNature, ValidationIssue, VatCode } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  t = makeTestApp();
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const EU_BUSINESS = {
  vatStatus: 'OTHER' as const,
  name: 'Beispiel GmbH',
  euVatNumber: 'DE123456789',
  address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' },
};

const line = (vatCode: VatCode, over: Partial<LineInput> = {}): LineInput => ({ description: 'Tanácsadás (október)', quantity: '1', unitPrice: '1000', vatCode, ...over });

async function natureOf(app: OpenSzamla, l: LineInput, customer = DOMESTIC_CUSTOMER_INPUT as object): Promise<{ nature: LineNature; unit: string; issues: ValidationIssue[] }> {
  const d = await app.createDraft({ customer: customer as typeof DOMESTIC_CUSTOMER_INPUT, lines: [l] });
  const first = d.invoice.lines[0];
  if (!first) throw new Error('no line');
  return { nature: first.nature, unit: first.unit, issues: d.issues };
}

describe('line nature without an explicit one (MCP-3)', () => {
  it('without a unit or with "db": the nature the VAT code implies; otherwise the unit; OTHER without either', async () => {
    const app = setup();
    expect(await natureOf(app, line('EUFAD37'), EU_BUSINESS)).toMatchObject({ nature: 'SERVICE', unit: 'db' });
    expect((await natureOf(app, line('EUFAD37', { unit: 'db' }), EU_BUSINESS)).nature).toBe('SERVICE');
    expect((await natureOf(app, line('HO'), { ...EU_BUSINESS, euVatNumber: undefined, thirdStateTaxId: '12-3456789', address: { ...EU_BUSINESS.address, countryCode: 'US' } })).nature).toBe('SERVICE');
    expect((await natureOf(app, line('KBAET'), EU_BUSINESS)).nature).toBe('PRODUCT');
    expect((await natureOf(app, line('27'))).nature).toBe('OTHER');
    expect((await natureOf(app, line('27', { unit: 'db' }))).nature).toBe('PRODUCT');
    expect((await natureOf(app, line('27', { unit: 'óra' }))).nature).toBe('SERVICE');
    // A unit that tells the nature beats the VAT code (the mismatch is then warned about).
    expect((await natureOf(app, line('EUFAD37', { unit: 'kg' }), EU_BUSINESS)).nature).toBe('PRODUCT');
  });

  it('a given nature and a product\'s nature take precedence', async () => {
    const app = setup();
    expect((await natureOf(app, line('EUFAD37', { nature: 'PRODUCT' }), EU_BUSINESS)).nature).toBe('PRODUCT');
    const p = app.saveProduct({ name: 'Licenc', unit: 'db', unitPrice: '1000', vatCode: '27', nature: 'OTHER' });
    expect((await natureOf(app, { productId: p.id, quantity: '1', vatCode: 'EUFAD37' }, EU_BUSINESS)).nature).toBe('OTHER');
  });

  it('the nature warnings offer setting the nature, and point at lines[i].nature', async () => {
    const app = setup();
    const mismatch = (await natureOf(app, line('EUFAD37', { nature: 'PRODUCT' }), EU_BUSINESS)).issues.find((i) => i.code === 'LINE_NATURE_MISMATCH');
    expect(mismatch).toMatchObject({ severity: 'warning', field: 'lines[0].nature' });
    expect(mismatch?.message).toMatch(/jellegét szolgáltatásra \(SERVICE\)/);
    const service = (await natureOf(app, line('KBAET', { nature: 'SERVICE' }), EU_BUSINESS)).issues.find((i) => i.code === 'LINE_NATURE_MISMATCH');
    expect(service).toMatchObject({ field: 'lines[0].nature' });
    expect(service?.message).toMatch(/jellegét termékre \(PRODUCT\)/);

    const goods = (await natureOf(app, line('27', { unit: 'db' }), EU_BUSINESS)).issues.find((i) => i.code === 'EU_B2B_GOODS_WITH_HU_VAT');
    expect(goods).toMatchObject({ severity: 'warning', field: 'lines[0].nature' });
    expect(goods?.message).toMatch(/jellegét szolgáltatásra \(SERVICE\).*EUFAD37/);
    // Consulting given without a unit, with Hungarian VAT: no hint towards KBAET alone – both cases and the nature.
    const unknown = (await natureOf(app, line('27'), EU_BUSINESS)).issues;
    expect(unknown.map((i) => i.code)).not.toContain('EU_B2B_GOODS_WITH_HU_VAT');
    expect(unknown.find((i) => i.code === 'EU_B2B_OTHER_WITH_HU_VAT')).toMatchObject({ severity: 'warning', field: 'lines[0].nature', message: expect.stringMatching(/EUFAD37.*KBAET.*tétel jellegét/) });
    expect((await natureOf(app, line('27', { unit: 'óra' }), EU_BUSINESS)).issues.map((i) => i.code)).toContain('EU_B2B_SERVICE_WITH_HU_VAT');
  });

  it('inferred SERVICE and OTHER lines are issued and give XSD-valid NAV XML', async () => {
    const app = setup();
    const svc = await app.createDraft({ customer: EU_BUSINESS, currency: 'HUF', lines: [line('EUFAD37')] });
    expect(svc.readyToIssue, JSON.stringify(svc.issues)).toBe(true);
    const other = await app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, lines: [line('27'), line('27', { description: 'Szakkönyv', unit: 'db' })] });
    for (const id of [svc.invoice.id, other.invoice.id]) {
      const r = await app.issue(id);
      const xml = buildInvoiceDataXml(r.invoice);
      const v = await validateNavXml(xml);
      expect(v.errors).toEqual([]);
      expect(v.valid).toBe(true);
    }
    const [a, b] = [app.getInvoice(svc.invoice.id), app.getInvoice(other.invoice.id)];
    expect(buildInvoiceDataXml(a)).toContain('<lineNatureIndicator>SERVICE</lineNatureIndicator>');
    expect(buildInvoiceDataXml(b)).toContain('<lineNatureIndicator>OTHER</lineNatureIndicator>');
    expect(buildInvoiceDataXml(b)).toContain('<lineNatureIndicator>PRODUCT</lineNatureIndicator>');
  });
});
