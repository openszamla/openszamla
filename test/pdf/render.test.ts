import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sumDec, toDec } from '../../src/core/decimal.ts';
import type { DocumentType, Invoice, InvoiceLine, VatSummaryRow } from '../../src/core/types.ts';
import { getVatInfo } from '../../src/core/vat.ts';
import { bankAccountText, buildInvoiceDocument, effectiveNotations, wrapLong } from '../../src/pdf/document.ts';
import { FONT_DIR, fontFiles, localAccessPolicy, renderPdfBuffer, urlAccessPolicy } from '../../src/pdf/engine.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import {
  ALL_FIXTURES,
  CUSTOMER_DOMESTIC,
  INVOICE_DOMESTIC,
  INVOICE_EU_SERVICE,
  INVOICE_PRIVATE_AAM,
  INVOICE_STORNO,
  SELLER_NORMAL,
} from '../fixtures/invoices.ts';
import { outsideContentBox, pdfBoxes, textRows, type Box } from './pdf-geometry.ts';

const SOFTWARE = 'OpenSzámla 0.1.0';
const SAMPLE_DIR = fileURLToPath(new URL('../../.tmp/pdf-samples/', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Parsed {
  /** Whitespace-normalised text (NBSP, tabs and line breaks → one space). */
  text: string;
  pages: number;
}

/** Text of a PDF via pdf-parse v2 (pdf.js). */
async function parsePdf(buf: Buffer): Promise<Parsed> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return { text: norm(res.text), pages: res.total };
  } finally {
    await parser.destroy();
  }
}

async function pdfInfo(buf: Buffer): Promise<Record<string, unknown>> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getInfo();
    return (res.info ?? {}) as Record<string, unknown>;
  } finally {
    await parser.destroy();
  }
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function render(inv: Invoice, opts: Parameters<typeof renderInvoicePdf>[1] = {}): Promise<Parsed & { buf: Buffer }> {
  const buf = await renderInvoicePdf(inv, { softwareName: SOFTWARE, ...opts });
  return { buf, ...(await parsePdf(buf)) };
}

function saveSample(name: string, buf: Buffer): void {
  mkdirSync(SAMPLE_DIR, { recursive: true });
  writeFileSync(join(SAMPLE_DIR, `${name}.pdf`), buf);
}

/** Horizontal content box of the invoice layout: A4 with 40 pt left and right page margins. */
const CONTENT_LEFT = 40;
const CONTENT_RIGHT = 595.28 - 40;

type LineSpec = Partial<InvoiceLine> & Pick<InvoiceLine, 'description' | 'netAmount' | 'vatAmount' | 'grossAmount'>;

/**
 * A HUF invoice (based on `base`) with the given lines – 1 db at 27% unless specified, net unit price =
 * net amount – and totals / VAT summary that are the sums of the lines.
 */
function withLines(base: Invoice, specs: LineSpec[]): Invoice {
  const lines: InvoiceLine[] = specs.map((s, i) => ({
    ...INVOICE_DOMESTIC.lines[0]!,
    quantity: '1',
    unit: 'db',
    vatCode: '27',
    netUnitPrice: s.netAmount,
    netAmountHuf: s.netAmount,
    vatAmountHuf: s.vatAmount,
    grossAmountHuf: s.grossAmount,
    ...s,
    lineNo: i + 1,
  }));
  const sum = (ls: InvoiceLine[], key: 'netAmount' | 'vatAmount' | 'grossAmount'): string => toDec(sumDec(ls.map((l) => l[key])));
  const row = (ls: InvoiceLine[]): Omit<VatSummaryRow, 'vatCode'> => {
    const [net, vat, gross] = [sum(ls, 'netAmount'), sum(ls, 'vatAmount'), sum(ls, 'grossAmount')];
    return { netAmount: net, vatAmount: vat, grossAmount: gross, netAmountHuf: net, vatAmountHuf: vat, grossAmountHuf: gross };
  };
  const codes = [...new Set(lines.map((l) => l.vatCode))];
  const all = row(lines);
  return {
    ...base,
    lines,
    totals: {
      ...all,
      byVat: codes.map((vatCode) => ({ vatCode, ...row(lines.filter((l) => l.vatCode === vatCode)) })),
      payableAmount: all.grossAmount,
      roundingDifference: '0',
    },
  };
}

/** A whole amount as drawn in one table cell: "150 000", "-4 200", "27%", "1,234.50" (no trailing space). */
const AMOUNT = /^[-+]?\d[\d .,]*%?$/;

/**
 * Neighbouring amounts on one baseline that are neither part of the same text run (touching) nor
 * clearly separated (≥ 10 pt): with the narrow no-break-space grouping such pairs read as one number.
 */
function crampedAmounts(boxes: Box[]): string[] {
  const out: string[] = [];
  for (const row of textRows(boxes)) {
    for (let i = 1; i < row.length; i++) {
      const [a, b] = [row[i - 1]!, row[i]!];
      const gap = b.x0 - a.x1;
      if (AMOUNT.test(a.text) && AMOUNT.test(b.text) && gap > 0.5 && gap < 10) out.push(`${a.text} | ${b.text}: ${gap.toFixed(1)} pt`);
    }
  }
  return out;
}

/** INVOICE_DOMESTIC with `n` lines (alternating its two lines). Totals are irrelevant for layout. */
function manyLines(n: number): Invoice {
  const base = INVOICE_DOMESTIC.lines;
  const lines: InvoiceLine[] = Array.from({ length: n }, (_, i) => {
    const src = base[i % base.length]!;
    return { ...src, lineNo: i + 1, description: `${src.description} – tétel ${i + 1}` };
  });
  return { ...INVOICE_DOMESTIC, id: 'inv_many', number: 'SZ-2026-00070', lines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderInvoicePdf – shared fixtures', () => {
  const fixtures = Object.entries(ALL_FIXTURES);

  it.each(fixtures)('%s renders a one-page A4 PDF (sample saved to .tmp/pdf-samples)', async (name, inv) => {
    const { buf, pages, text } = await render(inv);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.subarray(-6).toString('latin1')).toContain('%%EOF');
    expect(pages).toBe(1);
    expect(text).toContain(inv.number as string);
    expect(text).toContain(SOFTWARE);
    expect(text).toContain('1/1. oldal');
    saveSample(name, buf);
  });

  it('domestic B2B invoice: parties, tax numbers, dates, lines, VAT summary, totals', async () => {
    const { text } = await render(INVOICE_DOMESTIC);
    expect(text).toContain('SZÁMLA');
    expect(text).toContain('Sorszám SZ-2026-00001');
    // parties – Hungarian accents (ő, ű, Ő) survive font embedding and text extraction
    expect(text).toContain('Eladó (szállító) Példa Szoftver Kft.');
    expect(text).toContain('Vevő Árvíztűrő Tükörfúrógép Zrt.');
    expect(text).toContain('1117 Budapest, Irinyi József utca 4-20.');
    expect(text).toContain('Adószám: 12345676-2-42');
    expect(text).toContain('Közösségi adószám: HU12345676');
    expect(text).toContain('Bankszámla: 12345676-11111111 (OTP Bank)');
    expect(text).toContain('E-mail: szamlazas@pelda.hu');
    expect(text).toContain('Adószám: 87654323-2-13');
    // dates, payment, order number
    expect(text).toContain('Számla kelte 2026.10.27.');
    expect(text).toContain('Teljesítés dátuma 2026.10.27.');
    expect(text).toContain('Fizetési határidő 2026.11.04.');
    expect(text).toContain('Fizetési mód Átutalás');
    expect(text).toContain('Pénznem HUF');
    expect(text).toContain('Megrendelésszám PO-7781');
    // lines: description, quantity + unit, net unit price, net, VAT label, VAT, gross
    expect(text).toContain('1 Szoftverfejlesztés – október 10 óra 15 000 150 000 27% 40 500 190 500');
    expect(text).toContain('2 Szakkönyv: Őszi útmutató 2 db 2 000 4 000 5% 200 4 200');
    // VAT summary per VAT code with catalog labels
    expect(text).toContain('ÁFA-összesítő');
    expect(text).toContain('27% 27% általános adókulcs 150 000 40 500 190 500');
    expect(text).toContain('5% 5% kedvezményes adókulcs 4 000 200 4 200');
    // totals (formatted with no-break spaces, normalised above)
    expect(text).toContain('Nettó összesen 154 000 Ft');
    expect(text).toContain('ÁFA összesen 40 700 Ft');
    expect(text).toContain('Bruttó összesen 194 700 Ft');
    // nothing that belongs to other variants
    expect(text).not.toContain('Kerekítés');
    expect(text).not.toContain('MÁSOLAT');
    expect(text).not.toContain('TERVEZET');
    expect(text).not.toContain('Árfolyam');
    expect(text).not.toContain('Kötelező megjelölések');
  });

  it('amounts are never broken across lines (no-break space grouping)', async () => {
    // Roboto maps U+00A0 to the space glyph, so extraction yields a plain space – what matters is
    // that "194 700 Ft" stays on one line even in the narrowest cell.
    const { PDFParse } = await import('pdf-parse');
    const buf = await renderInvoicePdf(manyLines(3));
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const raw = (await parser.getText()).text;
    await parser.destroy();
    // [^\S\n] = any whitespace (space, tab, U+00A0) except a line break
    expect(raw).toMatch(/Bruttó összesen[^\S\n]+194[^\S\n]700[^\S\n]Ft/);
    expect(raw).toMatch(/15[^\S\n]000[^\S\n]+150[^\S\n]000[^\S\n]+27%[^\S\n]+40[^\S\n]500[^\S\n]+190[^\S\n]500/);
  });

  it('AAM seller → private person, cash: no buyer tax number, no VAT amounts, cash rounding lines', async () => {
    const { text } = await render(INVOICE_PRIVATE_AAM);
    expect(text).toContain('Kovács Anna e.v.');
    expect(text).toContain('Vevő Szőke Őrs 4025 Debrecen, Piac utca 20.');
    // private person: name and address only – the only tax number on the page is the seller's
    const buyerBlock = text.slice(text.indexOf('Vevő Szőke Őrs'), text.indexOf('Számla kelte'));
    expect(buyerBlock).not.toMatch(/adószám|adóazonosító/i);
    expect(count(text, 'Adószám:')).toBe(1);
    expect(text).toContain('Fizetési mód Készpénz');
    // AAM: the VAT label is the exemption code, no VAT amount / rate (Áfa tv. 187. § (2) c))
    expect(text).toContain('1 Kerámia bögre, kézzel festett 2 db 12 499 24 998 AAM – 24 998');
    expect(text).toContain('AAM Alanyi adómentes 24 998 – 24 998');
    expect(text).not.toContain('ÁFA összesen');
    expect(text).not.toMatch(/\d+%/);
    expect(text).toContain('Összesen 24 998 Ft');
    // 2008. évi III. tv. cash rounding: 24 998 → 25 000
    expect(text).toContain('Kerekítés +2 Ft');
    expect(text).toContain('Fizetendő (kerekítve) 25 000 Ft');
    // mandatory notation
    expect(text).toContain('Kötelező megjelölések Alanyi adómentes (Áfa tv. XIII. fejezet)');
  });

  it('EUR invoice to an EU business (hu-en): bilingual labels, exchange rate, HUF amounts, notation', async () => {
    const { text } = await render(INVOICE_EU_SERVICE);
    expect(text).toContain('SZÁMLA INVOICE');
    expect(text).toContain('Sorszám / Number SZ-2026-00003');
    expect(text).toContain('Eladó (szállító) / Seller Példa Szoftver Kft.');
    expect(text).toContain('Vevő / Buyer Beispiel GmbH');
    expect(text).toContain('Invalidenstraße 1 10115 Berlin Németország / Germany');
    expect(text).toContain('Közösségi adószám / EU VAT number: DE123456789');
    expect(text).toContain('Fizetési határidő / Due date 2026.11.10.');
    expect(text).toContain('Fizetési mód / Payment method Átutalás / Bank transfer');
    expect(text).toContain('Pénznem / Currency EUR');
    // exchange rate with source and date
    expect(text).toContain('Árfolyam / Exchange rate 1 EUR = 390,12 Ft MNB hivatalos árfolyam / official MNB rate, 2026.10.23.');
    // line and totals in EUR
    expect(text).toContain('1 Consulting services / Tanácsadás 10 óra 80,00 800,00 EUFAD37 – 800,00');
    expect(text).toContain('Bruttó összesen / Gross total 800,00 EUR');
    // HUF: per VAT code and totals (Áfa tv. 172. §)
    expect(text).toContain('EUFAD37 Más tagállamban teljesített szolgáltatás');
    expect(text).toContain('800,00 – 800,00 312 096 Ft –');
    expect(text).toContain('Forintban / In HUF – 1 EUR = 390,12 Ft');
    expect(text).toContain('Nettó összesen / Net total (HUF) 312 096 Ft');
    expect(text).toContain('ÁFA összesen / VAT total (HUF) 0 Ft');
    expect(text).toContain('Bruttó összesen / Gross total (HUF) 312 096 Ft');
    // notation printed verbatim
    expect(text).toContain(norm(INVOICE_EU_SERVICE.notations[0]!));
    expect(text).toContain('1/1. oldal / Page 1/1');
  });

  it('HUF equivalents with fillér are printed with 2 decimals', async () => {
    const t = INVOICE_EU_SERVICE.totals;
    const inv: Invoice = {
      ...INVOICE_EU_SERVICE,
      totals: {
        ...t,
        netAmountHuf: '312096.45',
        grossAmountHuf: '312096.45',
        byVat: t.byVat.map((r) => ({ ...r, netAmountHuf: '312096.45', grossAmountHuf: '312096.45' })),
      },
    };
    const { text } = await render(inv);
    expect(text).toContain('Nettó összesen / Net total (HUF) 312 096,45 Ft');
    expect(text).toContain('ÁFA összesen / VAT total (HUF) 0,00 Ft');
  });

  it('storno invoice: title, reference to the original invoice, negative amounts, comment', async () => {
    const { text } = await render(INVOICE_STORNO);
    expect(text).toContain('SZTORNÓ SZÁMLA Érvénytelenítő számla');
    expect(text).toContain('Sorszám SZ-2026-00004');
    expect(text).toContain('Az eredeti számla sorszáma: SZ-2026-00001');
    expect(text).toContain('Módosítási index: 1');
    expect(text).toContain('1 Szoftverfejlesztés – október -10 óra 15 000 -150 000 27% -40 500 -190 500');
    expect(text).toContain('Bruttó összesen -194 700 Ft');
    expect(text).toContain('Érvénytelenítő (sztornó) számla – az eredeti számla sorszáma: SZ-2026-00001');
    expect(text).toContain('Megjegyzés: Sztornó oka: hibás vevő adatok');
    expect(text).not.toContain('Megrendelésszám');
  });
});

describe('renderInvoicePdf – document types, languages and options', () => {
  const titles: Array<[DocumentType, string]> = [
    ['invoice', 'SZÁMLA'],
    ['advance', 'ELŐLEGSZÁMLA'],
    ['final', 'VÉGSZÁMLA'],
    ['modification', 'MÓDOSÍTÓ SZÁMLA'],
    ['storno', 'SZTORNÓ SZÁMLA'],
    ['proforma', 'DÍJBEKÉRŐ'],
  ];

  it.each(titles)('documentType %s → title %s', async (documentType, title) => {
    const { text, buf } = await render({ ...INVOICE_DOMESTIC, documentType });
    expect(text.startsWith(title)).toBe(true);
    expect(text).toContain(`${title} SZ-2026-00001 · ${SOFTWARE}`); // footer
    if (documentType === 'proforma') {
      saveSample('PROFORMA', buf);
      expect(text).toContain('Ez nem számla');
      expect(text).toContain('Kelt 2026.10.27.');
      expect(text).toContain('Várható teljesítés 2026.10.27.');
    } else {
      expect(text).not.toContain('Ez nem számla');
    }
  });

  it('draft option: diagonal "TERVEZET – NEM SZÁMLA" watermark', async () => {
    const issued = await render(INVOICE_DOMESTIC);
    expect(issued.text).not.toContain('TERVEZET – NEM SZÁMLA');
    const { text } = await render(INVOICE_DOMESTIC, { draft: true });
    expect(text).toContain('TERVEZET – NEM SZÁMLA');
    expect(text).toContain('Tervezet – nem számla.');
    const en = await render({ ...INVOICE_DOMESTIC, language: 'en' }, { draft: true });
    expect(en.text).toContain('DRAFT – NOT AN INVOICE');
  });

  it('a numberless draft invoice is always watermarked and shows TERVEZET instead of a number', async () => {
    const draft: Invoice = { ...INVOICE_DOMESTIC, status: 'draft', number: null, issuedAt: null };
    const { text, buf } = await render(draft, { draft: false });
    expect(text).toContain('TERVEZET – NEM SZÁMLA');
    expect(text).toContain('Sorszám TERVEZET');
    expect(text).toContain('Tervezet – sorszámot a kiállításkor kap, így nem számla.');
    saveSample('DRAFT', buf);
  });

  it('an empty draft (no lines yet, no due date, foreign currency without rate source) still renders', async () => {
    const empty: Invoice = {
      ...INVOICE_EU_SERVICE,
      status: 'draft',
      number: null,
      issuedAt: null,
      dueDate: null,
      exchangeRateDate: null,
      exchangeRateSource: null,
      comment: '  ',
      lines: [],
      notations: [],
      totals: { ...INVOICE_EU_SERVICE.totals, byVat: [], netAmount: '0', vatAmount: '0', grossAmount: '0', payableAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0' },
    };
    const { text, pages } = await render(empty);
    expect(pages).toBe(1);
    expect(text).toContain('TERVEZET – NEM SZÁMLA');
    expect(text).toContain('Árfolyam / Exchange rate 1 EUR = 390,12 Ft');
    expect(text).not.toContain('Fizetési határidő');
    expect(text).not.toContain('ÁFA-összesítő');
    expect(text).not.toContain('Megjegyzés');
    expect(text).toContain('Bruttó összesen / Gross total 0,00 EUR');
  });

  it('copy option: "MÁSOLAT" in the header and in the footer of every page', async () => {
    const { text, buf } = await render(INVOICE_DOMESTIC, { copy: true });
    expect(text).toContain('SZ-2026-00001 MÁSOLAT');
    expect(text).toContain(`MÁSOLAT · SZÁMLA SZ-2026-00001 · ${SOFTWARE}`);
    expect(count(text, 'MÁSOLAT')).toBe(2);
    saveSample('COPY', buf);
  });

  it("language 'en': English labels, English number and date format, translated units", async () => {
    const { text, buf } = await render({ ...INVOICE_DOMESTIC, language: 'en' }, { copy: true });
    saveSample('LANG_EN_COPY', buf);
    expect(text.startsWith('INVOICE Number SZ-2026-00001 COPY')).toBe(true);
    expect(text).toContain('Seller Példa Szoftver Kft.');
    expect(text).toContain('Buyer Árvíztűrő Tükörfúrógép Zrt.');
    expect(text).toContain('Tax number: 87654323-2-13');
    expect(text).toContain('Issue date 2026-10-27');
    expect(text).toContain('Due date 2026-11-04');
    expect(text).toContain('Payment method Bank transfer');
    expect(text).toContain('1 Szoftverfejlesztés – október 10 h 15,000 150,000 27% 40,500 190,500');
    expect(text).toContain('2 Szakkönyv: Őszi útmutató 2 pcs 2,000');
    expect(text).toContain('27% standard rate');
    expect(text).toContain('Gross total HUF 194,700');
    expect(text).toContain('Page 1/1');
    expect(text).not.toMatch(/Számla kelte|Vevő|oldal/);
  });

  it("language 'hu-en' on a HUF invoice: stacked bilingual table headers", async () => {
    const { text } = await render({ ...INVOICE_DOMESTIC, language: 'hu-en' });
    expect(text).toContain('Megnevezés Description');
    expect(text).toContain('Számla kelte / Issue date 2026.10.27.');
    expect(text).toContain('Bruttó összesen / Gross total 194 700 Ft');
    expect(text).toContain('27% 27% általános adókulcs / 27% standard rate');
  });

  it('modification and final invoices print line references (Áfa tv. 170. § e), advance deduction)', async () => {
    const [l1, l2] = INVOICE_DOMESTIC.lines as [InvoiceLine, InvoiceLine];
    const modification: Invoice = {
      ...INVOICE_DOMESTIC,
      documentType: 'modification',
      number: 'SZ-2026-00005',
      reference: { originalInvoiceId: 'inv_00000000a1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 2, modifyWithoutMaster: true },
      lines: [{ ...l1, modifiesLineNo: 1 }],
    };
    const mod = await render(modification);
    expect(mod.text).toContain('MÓDOSÍTÓ SZÁMLA Helyesbítő számla');
    expect(mod.text).toContain('Az eredeti számla sorszáma: SZ-2026-00001');
    expect(mod.text).toContain('Módosítási index: 2');
    expect(mod.text).toContain('Az eredeti számláról nem történt NAV-adatszolgáltatás');
    expect(mod.text).toContain('1 Szoftverfejlesztés – október Az eredeti számla 1. tételének módosítása 10 óra');

    const final: Invoice = {
      ...INVOICE_DOMESTIC,
      documentType: 'final',
      lines: [
        l1,
        {
          ...l2,
          description: 'Előleg',
          advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00000', advancePaymentDate: '2026-10-01', advanceExchangeRate: '1' },
        },
      ],
    };
    const fin = await render(final);
    expect(fin.text).toContain('VÉGSZÁMLA Előleg levonásával');
    expect(fin.text).toContain('2 Előleg Előleg levonása – előlegszámla: SZ-2026-00000 (előleg fizetése: 2026.10.01.) 2 db');
  });

  it('seller identifiers: VAT group, company registration number, IBAN, sole trader registration number', async () => {
    const group: Invoice = {
      ...INVOICE_DOMESTIC,
      seller: {
        ...SELLER_NORMAL,
        taxNumber: '17781823-5-44',
        groupMemberTaxNumber: '12345676-4-42',
        registrationNumber: '01-09-123456',
        bankAccount: 'HU42117730161111101800000000',
        swift: 'OTPVHUHB',
      },
      customer: { ...INVOICE_DOMESTIC.customer, groupMemberTaxNumber: '24680246-4-13' },
    };
    const g = await render(group);
    expect(g.text).toContain('Csoportazonosító szám: 17781823-5-44 Csoporttag adószáma: 12345676-4-42');
    expect(g.text).toContain('Cégjegyzékszám: 01-09-123456');
    expect(g.text).toContain('Bankszámla: HU42 1177 3016 1111 1018 0000 0000 (OTP Bank)');
    expect(g.text).toContain('SWIFT: OTPVHUHB');
    expect(g.text).toContain('Csoportazonosító szám: 87654323-2-13 Csoporttag adószáma: 24680246-4-13');
    expect(bankAccountText('12345676-11111111')).toBe('12345676-11111111');
    const nbsp = String.fromCharCode(0xa0);
    expect(bankAccountText('hu42 1177 3016 1111 1018 0000 0000')).toBe(['HU42', '1177', '3016', '1111', '1018', '0000', '0000'].join(nbsp));

    const ev = await render({ ...INVOICE_PRIVATE_AAM, seller: { ...INVOICE_PRIVATE_AAM.seller, registrationNumber: '52012345' } });
    expect(ev.text).toContain('Nyilvántartási szám: 52012345');
  });

  it('mandatory notations fall back to the VAT catalog (and pénzforgalmi elszámolás) when the invoice has none', async () => {
    expect(effectiveNotations(INVOICE_EU_SERVICE)).toEqual(INVOICE_EU_SERVICE.notations);
    const aam = getVatInfo('AAM');
    const legacy: Invoice = { ...INVOICE_PRIVATE_AAM, notations: [] };
    expect(effectiveNotations(legacy)).toEqual([aam.notationHu]);
    // English invoices keep the statutory Hungarian expression next to the translation
    const fadInfo = getVatInfo('FAD');
    const [l1, l2] = INVOICE_DOMESTIC.lines as [InvoiceLine, InvoiceLine];
    const fad: Invoice = {
      ...INVOICE_DOMESTIC,
      language: 'en',
      notations: [],
      lines: [{ ...l1, vatCode: 'FAD' }, l2],
      seller: { ...SELLER_NORMAL, cashAccounting: true },
    };
    expect(effectiveNotations(fad)).toEqual([
      `${fadInfo.notationHu} / ${fadInfo.notationEn}`,
      'pénzforgalmi elszámolás / Cash accounting',
    ]);
    // the cash accounting scheme does not apply to reverse-charge / exempt lines (Áfa tv. 196/B. §)
    expect(effectiveNotations({ ...fad, lines: [{ ...l1, vatCode: 'FAD' }] })).toEqual([`${fadInfo.notationHu} / ${fadInfo.notationEn}`]);
    const cash: Invoice = { ...INVOICE_DOMESTIC, notations: [], seller: { ...SELLER_NORMAL, cashAccounting: true } };
    const { text } = await render(cash);
    // the statutory expression verbatim (Áfa tv. 169. § h))
    expect(text).toContain('Kötelező megjelölések pénzforgalmi elszámolás');
  });

  it('text stays extractable: no "fi"/"fl" ligatures swallow letters', async () => {
    const inv: Invoice = {
      ...INVOICE_DOMESTIC,
      lines: [{ ...INVOICE_DOMESTIC.lines[0]!, description: 'Profi fiókkezelés, official workflow' }],
    };
    const { text } = await render(inv);
    expect(text).toContain('Profi fiókkezelés, official workflow');
  });
});

describe('renderInvoicePdf – pagination, determinism, performance', () => {
  it('a 70-line invoice spans multiple pages with "n/N. oldal" page numbers and repeated table header', async () => {
    const inv = manyLines(70);
    const t0 = performance.now();
    const buf = await renderInvoicePdf(inv, { softwareName: SOFTWARE });
    const ms = performance.now() - t0;
    const { text, pages } = await parsePdf(buf);
    saveSample('MANY_LINES_70', buf);
    expect(pages).toBeGreaterThanOrEqual(2);
    for (let p = 1; p <= pages; p++) expect(text).toContain(`${p}/${pages}. oldal`);
    expect(count(text, 'Megnevezés')).toBeGreaterThanOrEqual(2); // header row repeated on the next page
    expect(text).toContain('Szoftverfejlesztés – október – tétel 1 ');
    expect(text).toContain('Szakkönyv: Őszi útmutató – tétel 70 ');
    expect(text).toContain('Bruttó összesen 194 700 Ft');
    expect(ms).toBeLessThan(2000);
  });

  it('is deterministic: identical bytes for identical input; metadata from the invoice', async () => {
    const a = await renderInvoicePdf(INVOICE_DOMESTIC, { softwareName: SOFTWARE });
    const b = await renderInvoicePdf(structuredClone(INVOICE_DOMESTIC), { softwareName: SOFTWARE });
    expect(Buffer.compare(a, b)).toBe(0);
    const info = await pdfInfo(a);
    expect(info['Title']).toBe('SZ-2026-00001');
    expect(info['Author']).toBe('Példa Szoftver Kft.');
    expect(info['Creator']).toBe(SOFTWARE);
    expect(info['Producer']).toBe(SOFTWARE);
    expect(String(info['CreationDate'])).toMatch(/^D:20261027080000/);
    // a different issuance timestamp changes the metadata (and only that)
    const c = await renderInvoicePdf({ ...INVOICE_DOMESTIC, issuedAt: '2026-10-27T09:00:00.000Z' }, { softwareName: SOFTWARE });
    expect(Buffer.compare(a, c)).not.toBe(0);
  });

  it('does not mutate the invoice', async () => {
    const inv = structuredClone(INVOICE_EU_SERVICE);
    await renderInvoicePdf(inv, { draft: true, copy: true });
    expect(inv).toEqual(INVOICE_EU_SERVICE);
  });
});

describe('renderInvoicePdf – layout robustness (every line and amount stays visible)', () => {
  it('the geometry check has teeth: a table pushed off the page is detected', async () => {
    const buf = await renderPdfBuffer({ content: [{ table: { widths: ['*', 'auto'], body: [['W'.repeat(120), '190 500']] } }] });
    expect(outsideContentBox(pdfBoxes(buf), CONTENT_LEFT, CONTENT_RIGHT).length).toBeGreaterThan(0);
  });

  it('long URLs, IDs, e-mail addresses, names and units wrap in their cells – no column is pushed off the page', async () => {
    const url = 'https://projektek.pelda-szoftverfejleszto.hu/ugyfelek/arvizturo-tukorfurogep-zrt/projektek/2026-117/merfoldkovek/4';
    const id = `SN${'0123456789'.repeat(12)}`; // 122 characters without any break opportunity
    const inv = withLines(
      {
        ...INVOICE_DOMESTIC,
        number: 'SZAMLA2026SZEGEDIFIOKTELEPKOZPONTISOROZAT000000001',
        orderNumber: 'MEGRENDELES2026000000000000000000012345678',
        seller: { ...SELLER_NORMAL, email: 'szamlazas.konyveles.ugyfelszolgalat.kozponti@peldaszoftverfejleszto.hu' },
        customer: { ...CUSTOMER_DOMESTIC, name: 'ÁRVÍZTŰRŐTÜKÖRFÚRÓGÉPGYÁRTÓÉSFORGALMAZÓZRT' },
        notations: [`Tárgyi adómentes (Áfa tv. 85. § (1) e) pont) – ${id}`],
      },
      [
        { description: `Integrációs modul – hivatkozás: ${url}`, netAmount: '4850000', vatAmount: '1309500', grossAmount: '6159500' },
        { description: id, netAmount: '1', vatAmount: '0', grossAmount: '1' },
        {
          description: 'Mért fogyasztás',
          quantity: '1234567.125',
          unit: 'kilowattóra (mért fogyasztás, csúcsidőn kívül)',
          netUnitPrice: '98.123456',
          netAmount: '121139993',
          vatAmount: '32707798',
          grossAmount: '153847791',
        },
      ],
    );
    const buf = await renderInvoicePdf(inv, { softwareName: SOFTWARE });
    saveSample('LONG_TOKENS', buf);
    const boxes = pdfBoxes(buf);
    expect(outsideContentBox(boxes, CONTENT_LEFT, CONTENT_RIGHT)).toEqual([]);
    // every amount cell is drawn – and, per the check above, inside the page
    const drawn = boxes.map((b) => b.text.replace(/ /g, ' '));
    for (const cell of ['4 850 000', '1 309 500', '6 159 500', '121 139 993', '32 707 798', '153 847 791', '1 234 567,125', '98,123456']) {
      expect(drawn).toContain(cell);
    }
    // wrapped, not truncated
    const { text } = await parsePdf(buf);
    const compactText = text.replace(/\s/g, '');
    expect(compactText).toContain(url);
    expect(compactText.split(id).length - 1).toBe(2); // description + notation
    expect(compactText).toContain(inv.number as string);
  });

  it('line numbers of 100 and above stay on one line; the table header repeats on every page', async () => {
    const lines = Array.from({ length: 120 }, (_, i): LineSpec => ({ description: `Tétel ${i + 1}`, netAmount: '1000', vatAmount: '270', grossAmount: '1270' }));
    const { text, pages, buf } = await render(withLines(INVOICE_DOMESTIC, lines));
    saveSample('LINES_120', buf);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(text).toContain('99 Tétel 99 1 db');
    expect(text).toContain('100 Tétel 100 1 db');
    expect(text).toContain('120 Tétel 120 1 db');
    expect(count(text, 'Megnevezés')).toBe(pages);
    for (let p = 1; p <= pages; p++) expect(text).toContain(`${p}/${pages}. oldal`);
    expect(text).toContain('Bruttó összesen 152 400 Ft');
    expect(outsideContentBox(pdfBoxes(buf), CONTENT_LEFT, CONTENT_RIGHT)).toEqual([]);
  });

  it('a line item taller than a page is printed across pages instead of being dropped', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `bekezdés-${i + 1}: részletes műszaki leírás a megrendelő igényei szerint`).join(' ');
    const inv = withLines(INVOICE_DOMESTIC, [
      { description: 'Első tétel', netAmount: '1000', vatAmount: '270', grossAmount: '1270' },
      { description: long, netAmount: '5000', vatAmount: '1350', grossAmount: '6350' },
      { description: 'Utolsó tétel', netAmount: '1000', vatAmount: '270', grossAmount: '1270' },
    ]);
    const { text, pages, buf } = await render(inv);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(text).toContain('bekezdés-1: részletes műszaki leírás');
    expect(text).toContain('bekezdés-120: részletes műszaki leírás a megrendelő igényei szerint');
    expect(text).toMatch(/5 000 5 000 27% 1 350 6 350/);
    expect(text).toContain('3 Utolsó tétel 1 db');
    expect(text).toContain('Bruttó összesen 8 890 Ft');
    expect(outsideContentBox(pdfBoxes(buf), CONTENT_LEFT, CONTENT_RIGHT)).toEqual([]);

    // the same with a short text made of many lines (a 90-item list): the height counts, not the length
    const list = Array.from({ length: 90 }, (_, i) => `- alkatrész ${i + 1}`).join('\n');
    const listed = await render(withLines(INVOICE_DOMESTIC, [{ description: list, netAmount: '5000', vatAmount: '1350', grossAmount: '6350' }]));
    expect(list.length).toBeLessThan(1500);
    expect(listed.text).toContain('- alkatrész 1 - alkatrész 2 ');
    expect(listed.text).toContain('- alkatrész 90');
  });

  it('ordinary line items are never split across pages', async () => {
    // 40 two-line descriptions: some row ends at a page boundary – it must move to the next page whole
    const lines = Array.from({ length: 40 }, (_, i): LineSpec => ({
      description: `Tétel ${i + 1}: karbantartási szolgáltatás a 2026/117. számú szerződés alapján, havi átalánydíj`,
      netAmount: '1000',
      vatAmount: '270',
      grossAmount: '1270',
    }));
    const doc = buildInvoiceDocument(withLines(INVOICE_DOMESTIC, lines), { draft: false, copy: false, softwareName: SOFTWARE });
    const content = doc.content as unknown as Array<{ table?: { dontBreakRows?: boolean; headerRows?: number } }>;
    const table = content.find((n) => n.table?.headerRows === 1);
    expect(table?.table?.dontBreakRows).toBe(true);
  });

  it('amounts in neighbouring columns are clearly apart (no "2 522 280 681 015" run-ons)', async () => {
    const big = withLines(
      INVOICE_DOMESTIC,
      Array.from({ length: 6 }, (_, i): LineSpec => ({
        description: `Tétel ${i + 1}`,
        quantity: '7',
        netUnitPrice: '123456',
        netAmount: '864192',
        vatCode: i % 2 ? '27' : '5',
        vatAmount: i % 2 ? '233332' : '43210',
        grossAmount: i % 2 ? '1097524' : '907402',
      })),
    );
    for (const inv of [INVOICE_DOMESTIC, INVOICE_EU_SERVICE, { ...INVOICE_DOMESTIC, language: 'en' as const }, big]) {
      const boxes = pdfBoxes(await renderInvoicePdf(inv));
      expect(crampedAmounts(boxes)).toEqual([]);
      // the check does see the amount columns
      expect(textRows(boxes).some((r) => r.filter((b) => AMOUNT.test(b.text)).length >= 4)).toBe(true);
    }
  });

  it('amounts are printed with their stored decimals – never silently rounded', async () => {
    const inv = withLines(INVOICE_DOMESTIC, [{ description: 'Fillér', netAmount: '1000.5', vatAmount: '270.14', grossAmount: '1270.64' }]);
    const { text } = await render(inv);
    expect(text).toContain('1 Fillér 1 db 1 000,50 1 000,50 27% 270,14 1 270,64');
    expect(text).toContain('27% 27% általános adókulcs 1 000,50 270,14 1 270,64');
    expect(text).toContain('Nettó összesen 1 000,50 Ft');
    expect(text).toContain('Bruttó összesen 1 270,64 Ft');
  });

  it('foreign currency: the HUF totals sit beside the invoice-currency totals, so the notations stay on page 1', async () => {
    const eur = (net: string, vat: string, gross: string, rate = '389.4567'): Pick<InvoiceLine, 'netAmountHuf' | 'vatAmountHuf' | 'grossAmountHuf'> => {
      const huf = (v: string): string => toDec(sumDec([v]).times(rate).toDecimalPlaces(2));
      return { netAmountHuf: huf(net), vatAmountHuf: huf(vat), grossAmountHuf: toDec(sumDec([huf(net), huf(vat)])) };
    };
    const base = INVOICE_EU_SERVICE.lines[0]!;
    const lines: InvoiceLine[] = [
      { ...base, lineNo: 1, description: 'Szoftverlicenc – éves díj / Software licence – annual fee', quantity: '1', unit: 'db', netUnitPrice: '12450.5', vatCode: '27', netAmount: '12450.5', vatAmount: '3361.64', grossAmount: '15812.14', ...eur('12450.5', '3361.64', '15812.14') },
      { ...base, lineNo: 2, description: 'Oktatás / Training', quantity: '16', unit: 'óra', netUnitPrice: '95', vatCode: 'TAM', netAmount: '1520', vatAmount: '0', grossAmount: '1520', ...eur('1520', '0', '1520') },
      { ...base, lineNo: 3, description: 'Szakkönyv / Handbook', quantity: '3', unit: 'db', netUnitPrice: '42.9', vatCode: '5', netAmount: '128.7', vatAmount: '6.44', grossAmount: '135.14', ...eur('128.7', '6.44', '135.14') },
    ];
    const sum = (key: keyof Pick<InvoiceLine, 'netAmount' | 'vatAmount' | 'grossAmount' | 'netAmountHuf' | 'vatAmountHuf' | 'grossAmountHuf'>, ls = lines): string =>
      toDec(sumDec(ls.map((l) => l[key])));
    const inv: Invoice = {
      ...INVOICE_EU_SERVICE,
      exchangeRate: '389.4567',
      customer: { ...CUSTOMER_DOMESTIC, groupMemberTaxNumber: '24680246-4-13', phone: '+36 1 987 6543' },
      seller: {
        ...SELLER_NORMAL,
        name: 'Példa Szoftverfejlesztő és Informatikai Szolgáltató Korlátolt Felelősségű Társaság',
        taxNumber: '17781823-5-44',
        groupMemberTaxNumber: '12345676-4-42',
        registrationNumber: '01-09-123456',
        bankAccount: 'HU42117730161111101800000000',
        swift: 'OTPVHUHB',
        phone: '+36 1 234 5678',
        website: 'https://www.pelda-szoftverfejleszto.hu/kapcsolat',
      },
      lines,
      totals: {
        netAmount: sum('netAmount'),
        vatAmount: sum('vatAmount'),
        grossAmount: sum('grossAmount'),
        netAmountHuf: sum('netAmountHuf'),
        vatAmountHuf: sum('vatAmountHuf'),
        grossAmountHuf: sum('grossAmountHuf'),
        byVat: lines.map((l) => ({
          vatCode: l.vatCode,
          netAmount: l.netAmount,
          vatAmount: l.vatAmount,
          grossAmount: l.grossAmount,
          netAmountHuf: l.netAmountHuf,
          vatAmountHuf: l.vatAmountHuf,
          grossAmountHuf: l.grossAmountHuf,
        })),
        payableAmount: sum('grossAmount'),
        roundingDifference: '0',
      },
      comment: 'Megjegyzés / Comment',
      notations: ['pénzforgalmi elszámolás / Cash accounting', 'Tárgyi adómentes (Áfa tv. 85. § (1) e) pont) / VAT exempt (§ 85 (1) e))'],
    };
    const buf = await renderInvoicePdf(inv, { softwareName: SOFTWARE });
    saveSample('EUR_FULL_SELLER', buf);
    const boxes = pdfBoxes(buf);
    const rows = textRows(boxes).map((r) => r.map((b) => b.text).join('').replace(/ /g, ' '));
    // HUF and EUR totals on the same baselines
    expect(rows.find((r) => r.includes('Net total (HUF)'))).toMatch(/Net total \(HUF\).+ Ft.*Net total.+ EUR$/);
    expect(rows.find((r) => r.includes('VAT total (HUF)'))).toMatch(/VAT total \(HUF\)1 311 721,32 Ft.*VAT total3 368,08 EUR$/);
    // the mandatory notations and the comment are printed on the first page together with the totals
    const pagesOf = (prefix: string): number[] => [...new Set(boxes.filter((b) => b.text.startsWith(prefix)).map((b) => b.page))];
    expect(pagesOf('Kötelező')).toEqual([1]);
    expect(pagesOf('Megjegyzés')).toEqual([1]);
    expect(outsideContentBox(boxes, CONTENT_LEFT, CONTENT_RIGHT)).toEqual([]);
  });

  it('wrapLong: only unbreakable runs longer than the limit may break anywhere', () => {
    const url = 'https://projektek.pelda-szoftverfejleszto.hu/ugyfelek/arvizturo-tukorfurogep-zrt';
    expect(wrapLong('Szoftverfejlesztés – október', 22)).toEqual(['Szoftverfejlesztés – október']);
    // natural break points (after "-" or "/" before a letter) are enough: left to pdfmake's line breaker
    expect(wrapLong(`Ref: ${url}`, 22)).toEqual([`Ref: ${url}`]);
    expect(wrapLong(`ID ${'A'.repeat(30)} vége`, 22)).toEqual(['ID ', { text: 'A'.repeat(30), wordBreak: 'break-all' }, ' vége']);
    // only the over-long part of a hyphenated token is force-broken
    expect(wrapLong('PO-2026-000012345678901234-KELET-MAGYARORSZAG', 20)).toEqual([
      { text: 'PO-2026-000012345678901234-', wordBreak: 'break-all' },
      'KELET-MAGYARORSZAG',
    ]);
    // no-break spaces glue a run together for the line breaker, so they count as part of the token
    const nbsp = String.fromCharCode(0xa0);
    const glued = Array.from({ length: 12 }, () => '1234').join(nbsp);
    expect(wrapLong(`IBAN ${glued}`, 36)).toEqual(['IBAN ', { text: glued, wordBreak: 'break-all' }]);
    expect(wrapLong(`Összeg: 1${nbsp}234${nbsp}567 Ft`, 20)).toEqual([`Összeg: 1${nbsp}234${nbsp}567 Ft`]);
    // the style goes on every fragment (pdfmake ignores the style of a wrapper around a text array)
    expect(wrapLong(`Szám: ${'9'.repeat(25)}`, 20, { bold: true })).toEqual([
      { text: 'Szám: ', bold: true },
      { text: '9'.repeat(25), wordBreak: 'break-all', bold: true },
    ]);
    expect(wrapLong('', 20)).toEqual(['']);
  });
});

describe('pdf engine – no network, no file access outside the bundled fonts', () => {
  beforeAll(() => {
    expect(FONT_DIR.replace(/\\/g, '/')).toMatch(/pdfmake\/fonts\/Roboto$/);
  });

  it('access policies', () => {
    expect(urlAccessPolicy('https://example.com/logo.png')).toBe(false);
    expect(urlAccessPolicy('http://localhost/font.ttf')).toBe(false);
    for (const f of Object.values(fontFiles())) expect(localAccessPolicy(f)).toBe(true);
    expect(localAccessPolicy(FONT_DIR)).toBe(false);
    expect(localAccessPolicy(join(FONT_DIR, '..', 'Roboto.js'))).toBe(false);
    expect(localAccessPolicy(join(FONT_DIR, '..', '..', '..', '..', 'package.json'))).toBe(false);
    expect(localAccessPolicy(join(PROJECT_ROOT, 'package.json'))).toBe(false);
  });

  it('rendering every fixture never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network access attempted');
    });
    for (const inv of Object.values(ALL_FIXTURES)) {
      await renderInvoicePdf(inv, { draft: true, copy: true });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('remote resources are refused by the URL policy before any request is made', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      renderPdfBuffer({ content: [{ image: 'logo' }], images: { logo: 'https://example.invalid/logo.png' } }),
    ).rejects.toThrow(/denied/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('local files outside the font directory are refused by the local access policy', async () => {
    const outside = join(dirname(FONT_DIR), 'Roboto.js');
    await expect(renderPdfBuffer({ content: [{ image: outside }] })).rejects.toThrow(/denied/i);
  });
});
