/**
 * Characters the invoice PDF cannot show. The PDF embeds one font (Roboto): a buyer's name in Chinese, Arabic or Hebrew,
 * an emoji or a sign like "→ ✓ ㎡" in a description was printed as empty boxes, without a word – on a document that cannot
 * be changed once issued. The draft's check now names such characters: an error where the invoice must carry the data
 * (names, addresses, descriptions, units), a warning elsewhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { describeCharacter, missingGlyphs } from '../../src/pdf/glyphs.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

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

const LINE = { description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '10000', vatCode: '27' as const };

describe('missingGlyphs', () => {
  it('Hungarian, Central European, Cyrillic and Greek text, the usual signs: all printable', () => {
    const printable = [
      'Árvíztűrő tükörfúrógép ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP',
      'Łódź Žďár Škoda Müller Ångström Çelik Niño',
      'Київ Москва София Αθήνα',
      '€ $ £ ° ± × ÷ ² ³ ½ § % & @ # „idézet” – — … 10 m² 5 °C',
      'sor1\nsor2\tvége',
    ];
    for (const text of printable) expect(missingGlyphs(text), text).toEqual([]);
  });

  it('names what Roboto has no glyph for, once each, in order', () => {
    expect(missingGlyphs('株式会社 株式')).toEqual(['株', '式', '会', '社']);
    expect(missingGlyphs('Csomag 🎄 → kész ✓')).toEqual(['🎄', '→', '✓']);
    expect(missingGlyphs('شركة').length).toBeGreaterThan(0);
    expect(missingGlyphs('חברה').length).toBeGreaterThan(0);
    expect(missingGlyphs('บริษัท').length).toBeGreaterThan(0);
    expect(describeCharacter('株')).toBe('„株” (U+682A)');
    expect(describeCharacter('🎄')).toBe('„🎄” (U+1F384)');
  });
});

describe('a draft with text the PDF cannot print', () => {
  it('a buyer name in Japanese and a description with an arrow: errors naming the characters; the draft cannot be issued', async () => {
    const app = setup();
    const view = await app.createDraft({
      customer: { ...DOMESTIC_CUSTOMER_INPUT, name: '株式会社サンプル' },
      lines: [{ ...LINE, description: 'Szállítás Budapest → Wien' }],
    });
    const found = view.issues.filter((i) => i.code === 'PDF_UNPRINTABLE_CHARACTERS');
    expect(found.map((i) => [i.severity, i.field])).toEqual([['error', 'customer.name'], ['error', 'lines[0].description']]);
    expect(found[0]?.message).toContain('A vevő neve olyan karaktert tartalmaz, amelyet a számla PDF-je nem tud megjeleníteni – üres négyzet kerülne a helyére: „株” (U+682A), „式” (U+5F0F)');
    expect(found[1]?.message).toContain('A(z) 1. tétel megnevezése olyan karaktert tartalmaz');
    expect(found[1]?.message).toContain('„→” (U+2192)');
    expect(view.readyToIssue).toBe(false);
    await expect(app.issue(view.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Written in Latin letters it is fine.
    const fixed = await app.updateDraft(view.invoice.id, { customer: { ...DOMESTIC_CUSTOMER_INPUT, name: 'Sample Kabushiki Kaisha' }, lines: [{ ...LINE, description: 'Szállítás Budapest – Wien' }] });
    expect(fixed.issues.filter((i) => i.code === 'PDF_UNPRINTABLE_CHARACTERS')).toEqual([]);
    expect(fixed.readyToIssue).toBe(true);
  });

  it('in a comment it is a warning: the draft can be issued', async () => {
    const app = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const view = await app.createDraft({ customerId, lines: [LINE], comment: 'Köszönjük a megrendelést ✓' });
    const found = view.issues.filter((i) => i.code === 'PDF_UNPRINTABLE_CHARACTERS');
    expect(found.map((i) => [i.severity, i.field])).toEqual([['warning', 'comment']]);
    expect(found[0]?.message).toContain('A megjegyzés olyan karaktert tartalmaz');
    expect(view.readyToIssue).toBe(true);
  });

  it('ordinary Hungarian, Polish and Ukrainian data raise nothing', async () => {
    const app = setup();
    const view = await app.createDraft({
      customer: { vatStatus: 'OTHER', name: 'Żółć Sp. z o.o. / ТОВ «Приклад»', euVatNumber: 'PL1234567890', address: { countryCode: 'PL', postalCode: '90-001', city: 'Łódź', addressLine: 'ul. Piotrkowska 1' } },
      lines: [{ ...LINE, description: 'Tanácsadás – 10 m², 5 °C, ½ nap', vatCode: 'EUFAD37' }],
      comment: '„Köszönjük!” – 100% elégedettség',
    });
    expect(view.issues.filter((i) => i.code === 'PDF_UNPRINTABLE_CHARACTERS')).toEqual([]);
  });
});
