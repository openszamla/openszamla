/** Service-layer behaviour (without NAV): drafts, issuing, numbering, corrections, payments, reports. */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import { OpenSzamla, invoiceContentHash } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';
import { validateSzamla2013Xml } from '../helpers/szamla2013-xsd.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { VERSION } from '../../src/version.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(now = '2026-10-27T09:00:00.000Z', opts: { fetch?: typeof fetch } = {}): { app: OpenSzamla; clock: { now: Date } } {
  const clock = { now: new Date(now) };
  t = makeTestApp({ now: () => clock.now, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, clock };
}

const LINES = [
  { description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' as const },
  { description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '2000', vatCode: '5' as const },
];

async function issued(app: OpenSzamla, extra: Record<string, unknown> = {}) {
  const customerId = (app.findCustomers({ taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber }).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const d = await app.createDraft({ customerId, lines: LINES, ...extra });
  expect(d.issues.filter((i) => i.severity === 'error'), JSON.stringify(d.issues)).toEqual([]);
  return app.issue(d.invoice.id);
}

describe('drafts and issuing', () => {
  it('requires the seller profile', async () => {
    t = makeTestApp();
    await expect(t.app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, lines: LINES })).rejects.toMatchObject({ code: 'SELLER_NOT_CONFIGURED' });
  });

  it('computes, numbers sequentially and freezes issued invoices', async () => {
    const { app } = setup();
    const a = await issued(app);
    const b = await issued(app);
    expect(a.invoice.number).toBe('SZ-2026-00001');
    expect(b.invoice.number).toBe('SZ-2026-00002');
    expect(a.invoice.totals.grossAmount).toBe('194700');
    expect(a.invoice.status).toBe('issued');
    expect(a.invoice.navStatus).toBe('not_configured');
    expect(a.notes.join(' ')).toMatch(/NAV/);
    expect(a.pdfPath && existsSync(a.pdfPath)).toBe(true);
    expect(readFileSync(a.pdfPath as string).subarray(0, 4).toString()).toBe('%PDF');
    await expect(app.updateDraft(a.invoice.id, { comment: 'x' })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
    expect(() => app.deleteDraft(a.invoice.id)).toThrow(AppError);
  });

  it('sets the issue date to the day of issuing and shifts the due date', async () => {
    const { app, clock } = setup('2026-10-20T09:00:00.000Z');
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, lines: LINES });
    expect(d.invoice.issueDate).toBe('2026-10-20');
    expect(d.invoice.dueDate).toBe('2026-10-28');
    clock.now = new Date('2026-10-27T09:00:00.000Z');
    const r = await app.issue(d.invoice.id);
    expect(r.invoice.issueDate).toBe('2026-10-27');
    expect(r.invoice.dueDate).toBe('2026-11-04');
    expect(r.notes.join(' ')).toMatch(/kelte/);
  });

  it('restarts numbering in a new year and refuses to go back', async () => {
    const { app, clock } = setup('2026-12-31T10:00:00.000Z');
    expect((await issued(app)).invoice.number).toBe('SZ-2026-00001');
    clock.now = new Date('2027-01-02T10:00:00.000Z');
    expect((await issued(app)).invoice.number).toBe('SZ-2027-00001');
    expect((await issued(app)).invoice.number).toBe('SZ-2027-00002');
  });

  it('never wastes a number when issuing fails validation', async () => {
    const { app } = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const bad = await app.createDraft({ customerId, lines: [{ description: 'Hibás', quantity: '0', unitPrice: '100', vatCode: '27' }] });
    expect(bad.readyToIssue).toBe(false);
    await expect(app.issue(bad.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await issued(app)).invoice.number).toBe('SZ-2026-00001');
  });

  it('turns a díjbekérő into an invoice and duplicates invoices', async () => {
    const { app } = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const pro = await app.createDraft({ documentType: 'proforma', customerId, lines: LINES });
    const proIssued = await app.issue(pro.invoice.id);
    expect(proIssued.invoice.number).toBe('DB-2026-00001');
    expect(proIssued.invoice.navStatus).toBe('not_applicable');
    const conv = await app.createDraft({ copyFromId: proIssued.invoice.id });
    expect(conv.invoice.documentType).toBe('invoice');
    expect(conv.invoice.internalNote).toContain('DB-2026-00001');
    expect((await app.issue(conv.invoice.id)).invoice.number).toBe('SZ-2026-00001');
    const dup = await app.createDraft({ copyFromId: 'SZ-2026-00001', comment: 'Novemberi díj' });
    expect(dup.invoice.lines).toHaveLength(2);
    expect(dup.invoice.comment).toBe('Novemberi díj');
  });

  it('issues storno and modification invoices with chain line references', async () => {
    const { app } = setup();
    const orig = await issued(app);
    const corr = await app.createCorrectionDraft('SZ-2026-00001', { lines: [{ description: 'Árengedmény', quantity: '1', unitPrice: '-10000', vatCode: '27', unit: 'db' }], comment: 'Kedvezmény' });
    expect(corr.invoice.documentType).toBe('modification');
    expect(corr.invoice.reference?.originalInvoiceNumber).toBe('SZ-2026-00001');
    const mod = await app.issue(corr.invoice.id);
    expect(mod.invoice.lines[0]?.modificationRef).toEqual({ lineNumberReference: 3, lineOperation: 'CREATE' });
    expect(mod.invoice.reference?.modificationIndex).toBe(1);
    const st = await app.cancel(orig.invoice.id, { reason: 'Téves' });
    expect(st.invoice.documentType).toBe('storno');
    expect(st.invoice.reference?.modificationIndex).toBe(2);
    expect(st.invoice.lines).toHaveLength(3);
    expect(st.invoice.totals.grossAmount).toBe('-182000');
    expect(app.getInvoice(orig.invoice.id).status).toBe('cancelled');
    await expect(app.cancel(orig.invoice.id, { reason: 'Megint' })).rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
    await expect(app.createCorrectionDraft(st.invoice.id, { lines: LINES })).rejects.toBeInstanceOf(AppError);
  });

  it('records payments and builds reports and exports', async () => {
    const { app } = setup();
    const a = await issued(app);
    const p1 = app.recordPayment(a.invoice.id, { amount: '100000' });
    expect(p1.paymentStatus).toBe('partial');
    const p2 = app.recordPayment(a.invoice.id, {});
    expect(p2.paymentStatus).toBe('paid');
    expect(p2.paidAmount).toBe('194700');
    await issued(app);
    const rep = app.report({ from: '2026-10-01', to: '2026-10-31' });
    expect(rep.invoiceCount).toBe(2);
    expect(rep.totalsHuf.gross).toBe('389400');
    expect(rep.byVatCode.map((r) => r.vatCode)).toEqual(['27', '5']);
    expect(rep.receivables.unpaidCount).toBe(1);
    for (const format of ['csv', 'json', 'xml'] as const) {
      const exp = app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format });
      expect(exp.count).toBe(2);
      expect(existsSync(exp.path)).toBe(true);
    }
    const csv = readFileSync(app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'csv' }).path, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // In words, as the web UI names them – not the internal codes.
    expect(csv).toContain('SZ-2026-00001;számla;kiállított;');
    expect(csv).toContain(';átutalás;fizetve;nincs beállítva;');
    expect(csv).not.toMatch(/;(invoice|issued|TRANSFER|unpaid|paid|not_configured);/);
    const integrity = app.verifyIntegrity();
    expect(integrity.invoicesChecked).toBe(2);
    expect(integrity.invoiceMismatches).toEqual([]);
    expect(integrity.audit.ok).toBe(true);
  });

  it('uses the MNB rate for foreign currency (mocked) and keeps it on corrections', async () => {
    const mnbXml = (date: string, rate: string) =>
      `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="${date}"&gt;&lt;Rate unit="1" curr="EUR"&gt;${rate}&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return new Response(mnbXml('2026-10-23', '390,12'), { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
    }) as unknown as typeof fetch;
    const { app } = setup('2026-10-27T09:00:00.000Z', { fetch: fetchMock });
    const eu = app.saveCustomer({ vatStatus: 'OTHER', name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } }).customer;
    const d = await app.createDraft({
      customerId: eu.id, currency: 'EUR', fulfillmentDate: '2026-10-25',
      lines: [{ description: 'Consulting', quantity: '10', unit: 'óra', unitPrice: '80', vatCode: 'EUFAD37' }],
    });
    expect(d.invoice.exchangeRate).toBe('390.12');
    expect(d.invoice.exchangeRateSource).toBe('MNB');
    expect(d.invoice.totals.netAmountHuf).toBe('312096');
    expect(calls).toBeGreaterThan(0);
    const r = await app.issue(d.invoice.id);
    const corr = await app.createCorrectionDraft(r.invoice.id, { lines: [{ description: 'Discount', quantity: '1', unit: 'db', unitPrice: '-80', vatCode: 'EUFAD37' }] });
    expect(corr.invoice.exchangeRate).toBe('390.12');
  });

  it('takes the exchange rate of an advance invoice from the day the advance was received', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;&lt;Day date="2026-10-20"&gt;&lt;Rate unit="1" curr="EUR"&gt;380,00&lt;/Rate&gt;&lt;/Day&gt;&lt;Day date="2026-10-26"&gt;&lt;Rate unit="1" curr="EUR"&gt;390,00&lt;/Rate&gt;&lt;/Day&gt;&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
    const fetchMock = (async () => new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } })) as unknown as typeof fetch;
    const { app } = setup('2026-10-27T09:00:00.000Z', { fetch: fetchMock });
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({
      customerId, documentType: 'advance', currency: 'EUR', fulfillmentDate: '2026-10-21',
      lines: [{ description: 'Előleg a tervezési munkára', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }],
    });
    expect(d.invoice.exchangeRateDate).toBe('2026-10-20');
    expect(d.invoice.exchangeRate).toMatch(/^380(\.0+)?$/);
  });

  it('binds issue and storno confirmations to the content, the seller, the day and the correction chain', async () => {
    const { app, clock } = setup('2026-10-27T21:50:00.000Z'); // 22:50 in Budapest
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, lines: LINES });
    const f0 = app.issueFingerprint(d.invoice.id);
    expect(app.issueFingerprint(d.invoice.id)).toBe(f0);
    app.updateSeller({ email: 'uj@teszt.hu' });
    const f1 = app.issueFingerprint(d.invoice.id);
    expect(f1).not.toBe(f0);
    await app.updateDraft(d.invoice.id, { comment: 'Megjegyzés' });
    const f2 = app.issueFingerprint(d.invoice.id);
    expect(f2).not.toBe(f1);
    clock.now = new Date('2026-10-27T23:10:00.000Z'); // 00:10 the next day in Budapest
    expect(app.issueFingerprint(d.invoice.id)).not.toBe(f2);

    const orig = await app.issue(d.invoice.id);
    const c0 = app.cancelFingerprint(orig.invoice.id, 'Téves');
    expect(app.cancelFingerprint(orig.invoice.id, ' Téves ')).toBe(c0);
    expect(app.cancelFingerprint(orig.invoice.id, 'Más ok')).not.toBe(c0);
    const corr = await app.createCorrectionDraft(orig.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] });
    await app.issue(corr.invoice.id);
    expect(app.cancelFingerprint(orig.invoice.id, 'Téves')).not.toBe(c0);
  });

  it('neutralises spreadsheet formulas in the CSV export but keeps negative amounts numeric', async () => {
    const { app } = setup();
    const c = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, name: '=HYPERLINK("http://x.example","katt")' }).customer;
    const d = await app.createDraft({ customerId: c.id, lines: LINES });
    const r = await app.issue(d.invoice.id);
    await app.cancel(r.invoice.id, { reason: 'Téves' });
    const csv = readFileSync(app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'csv' }).path, 'utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://x.example"",""katt"")"`);
    expect(csv).not.toMatch(/;"?=HYPERLINK/);
    expect(csv).toContain(';-194700;');
    expect(csv).not.toContain("'-");
  });

  it('supports the manual exchange-rate policy', async () => {
    const { app } = setup();
    app.updateDefaults({ exchangeRateSource: 'manual' });
    const eu = app.saveCustomer({ vatStatus: 'OTHER', name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } }).customer;
    const lines = [{ description: 'Consulting', quantity: '1', unit: 'óra', unitPrice: '100', vatCode: 'EUFAD37' as const }];
    const missing = await app.createDraft({ customerId: eu.id, currency: 'EUR', lines });
    expect(missing.issues.some((i) => i.code === 'EXCHANGE_RATE_MISSING')).toBe(true);
    expect(missing.readyToIssue).toBe(false);
    const fixed = await app.updateDraft(missing.invoice.id, { exchangeRate: '395.5' });
    expect(fixed.invoice.exchangeRateSource).toBe('manual');
    expect(fixed.issues.some((i) => i.code === 'EXCHANGE_RATE_MISSING')).toBe(false);
  });

  it('produces the tax-audit export (adóhatósági ellenőrzési adatszolgáltatás) by date and by number range', async () => {
    const { app } = setup();
    const a = await issued(app);
    await issued(app);
    await app.cancel(a.invoice.id, { reason: 'Téves' });
    const byDate = await app.taxAuditExport({ from: '2026-10-01', to: '2026-10-31' });
    expect(byDate.count).toBe(3);
    const xml = readFileSync(join(byDate.path, 'szamlak.xml'), 'utf8');
    const xsd = await validateSzamla2013Xml(xml);
    expect(xsd.errors).toEqual([]);
    expect(xml).toContain('SZ-2026-00003');
    expect(readdirSync(join(byDate.path, 'pdf'))).toHaveLength(3);
    const osa = readdirSync(join(byDate.path, 'nav-osa'));
    expect(osa).toHaveLength(3);
    for (const f of osa) expect((await validateNavXml(readFileSync(join(byDate.path, 'nav-osa', f), 'utf8'), 'data')).errors).toEqual([]);
    expect(readFileSync(join(byDate.path, 'OLVASSEL.txt'), 'utf8')).toContain('Adóhatósági ellenőrzési adatszolgáltatás');
    const byNumber = await app.taxAuditExport({ fromNumber: 'SZ-2026-00002', toNumber: 'SZ-2026-00003' });
    expect(byNumber.count).toBe(2);
    expect(byNumber.numberFrom).toBe('SZ-2026-00002');
    await expect(app.taxAuditExport({ fromNumber: 'SZ-2026-00003', toNumber: 'SZ-2026-00001' })).rejects.toBeInstanceOf(AppError);
    await expect(app.taxAuditExport({ from: '2025-01-01', to: '2025-01-31' })).rejects.toMatchObject({ code: 'NO_INVOICES' });
  });

  it('rejects duplicate customers and validates tax numbers', () => {
    const { app } = setup();
    app.saveCustomer(DOMESTIC_CUSTOMER_INPUT);
    expect(() => app.saveCustomer(DOMESTIC_CUSTOMER_INPUT)).toThrow(/Már létezik/);
    expect(() => app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, taxNumber: '87654321-2-13' })).toThrow(AppError);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes: corrections, exchange rates of copies, advance deductions, series, previews
// ---------------------------------------------------------------------------------------------

const EU_CUSTOMER = { vatStatus: 'OTHER' as const, name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } };
const EU_LINES = [{ description: 'Consulting', quantity: '10', unit: 'óra', unitPrice: '100', vatCode: 'EUFAD37' as const }];
const ZERO_TOTALS = { netAmount: '0', vatAmount: '0', grossAmount: '0', netAmountHuf: '0', vatAmountHuf: '0', grossAmountHuf: '0', byVat: [], payableAmount: '0', roundingDifference: '0' };

const errorCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);
const warningCodes = (issues: ValidationIssue[]): string[] => issues.filter((i) => i.severity === 'warning').map((i) => i.code);

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_APP_ERROR';
  }
}

/** MNB SOAP reply with these EUR rates (date → "390,12"); the client takes the last one on or before the requested day. */
function mnbFetch(rates: Record<string, string>): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const days = Object.entries(rates).map(([d, r]) => `&lt;Day date="${d}"&gt;&lt;Rate unit="1" curr="EUR"&gt;${r}&lt;/Rate&gt;&lt;/Day&gt;`).join('');
  const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;${days}&lt;/MNBExchangeRates&gt;</GetExchangeRatesResult></GetExchangeRatesResponse></soap:Body></soap:Envelope>`;
  const f = (async () => {
    calls++;
    return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => calls };
}

const unreachable = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;

type SeriesRow = ReturnType<OpenSzamla['listSeries']>[number];

describe('modifications need at least one line (LEGAL-1)', () => {
  it('refuses a line-less modification; header data is corrected with a zero-amount line, reported XSD-valid', async () => {
    const { app } = setup();
    const orig = await issued(app);
    await expect(app.createCorrectionDraft(orig.invoice.id, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(app.createCorrectionDraft(orig.invoice.id, { lines: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.findInvoices({ status: ['draft'] }).total).toBe(0);
    const corr = await app.createCorrectionDraft(orig.invoice.id, {
      lines: [{ description: 'Teljesítési dátum javítása: 2026-10-20', quantity: '1', unit: 'db', unitPrice: '0', vatCode: '27' }],
      fulfillmentDate: '2026-10-20',
      comment: 'A teljesítés dátuma helyesen 2026-10-20.',
    });
    await expect(app.updateDraft(corr.invoice.id, { lines: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(corr.readyToIssue, JSON.stringify(corr.issues)).toBe(true);
    const mod = await app.issue(corr.invoice.id);
    expect(mod.invoice.totals.grossAmount).toBe('0');
    expect((await validateNavXml(buildInvoiceDataXml(mod.invoice), 'data')).errors).toEqual([]);
  });

  it('a stored line-less modification draft (older version) cannot be issued and wastes no number', async () => {
    const { app } = setup();
    const orig = await issued(app);
    const corr = await app.createCorrectionDraft(orig.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] });
    app.store.updateDraft({ ...app.getInvoice(corr.invoice.id), lines: [], totals: ZERO_TOTALS });
    const view = app.viewInvoice(corr.invoice.id);
    expect(view.readyToIssue).toBe(false);
    expect(errorCodes(view.issues)).toContain('MODIFICATION_WITHOUT_LINES');
    await expect(app.issue(corr.invoice.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await issued(app)).invoice.number).toBe('SZ-2026-00002');
  });

  it('one broken issued document never aborts the tax-audit export or the NAV XML export', async () => {
    const { app } = setup();
    const orig = await issued(app);
    // A line-less modification issued by an older version: NAV XML and the 3. melléklet cannot represent it.
    const draft: Invoice = {
      ...orig.invoice, id: 'inv_00legacy01', documentType: 'modification', status: 'draft', number: null, issuedAt: null, contentHash: null,
      navStatus: 'not_applicable', navMessages: [], navTransactionId: null, cancelledById: null, lines: [], totals: ZERO_TOTALS, notations: [],
      reference: { originalInvoiceId: orig.invoice.id, originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false, originalDocumentType: 'invoice' },
    };
    app.store.insertDraft(draft);
    const broken: Invoice = { ...draft, status: 'issued', number: 'SZ-2026-00002', issuedAt: '2026-10-27T09:30:00.000Z', navStatus: 'error' };
    app.store.markIssued({ ...broken, contentHash: invoiceContentHash(broken) });

    const audit = await app.taxAuditExport({ from: '2026-10-01', to: '2026-10-31' });
    expect(audit.count).toBe(1);
    expect(audit.warnings.filter((w) => w.invoiceNumber === 'SZ-2026-00002').map((w) => w.field)).toEqual(expect.arrayContaining(['lines', 'nav-osa']));
    const xml = readFileSync(join(audit.path, 'szamlak.xml'), 'utf8');
    expect((await validateSzamla2013Xml(xml)).errors).toEqual([]);
    expect(xml).not.toContain('SZ-2026-00002');
    expect(readdirSync(join(audit.path, 'nav-osa'))).toEqual(['SZ-2026-00001.xml']);
    expect(readFileSync(join(audit.path, 'OLVASSEL.txt'), 'utf8')).toContain('SZ-2026-00002');

    const nav = app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'xml' });
    expect(nav.count).toBe(1);
    expect(nav.warnings.map((w) => w.invoiceNumber)).toEqual(['SZ-2026-00002']);
    expect(readdirSync(nav.path)).toEqual(['SZ-2026-00001.xml']);
    expect(app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'csv' })).toMatchObject({ count: 2, warnings: [] });
  });
});

describe('corrections keep the VAT regime of the original (LEGAL-2)', () => {
  it('AAM invoice, then the seller becomes normal: modification and storno stay AAM (individualExemption) with the current name', async () => {
    const { app } = setup();
    app.updateSeller({ vatStatus: 'aam' });
    const orig = await issued(app, { lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '100000' }] });
    expect(orig.invoice.lines[0]?.vatCode).toBe('AAM');
    app.updateSeller({ vatStatus: 'normal', name: 'Új Név Kft.' });
    const corr = await app.createCorrectionDraft(orig.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000' }], comment: 'Kedvezmény' });
    expect(errorCodes(corr.issues)).toEqual([]);
    expect(corr.invoice.lines[0]?.vatCode).toBe('AAM');
    const mod = await app.issue(corr.invoice.id);
    const st = await app.cancel(orig.invoice.id, { reason: 'Téves' });
    for (const inv of [mod.invoice, st.invoice]) {
      expect(inv.seller).toMatchObject({ vatStatus: 'aam', name: 'Új Név Kft.' });
      expect(inv.lines.every((l) => l.vatCode === 'AAM')).toBe(true);
      const xml = buildInvoiceDataXml(inv);
      expect(xml).toContain('<individualExemption>true</individualExemption>');
      expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
    }
  });

  it('a normal 27% invoice, then the seller opts into AAM: the storno is a normal-regime document', async () => {
    const { app } = setup();
    const orig = await issued(app);
    app.updateSeller({ vatStatus: 'aam' });
    const st = await app.cancel(orig.invoice.id, { reason: 'Téves' });
    expect(st.invoice.seller.vatStatus).toBe('normal');
    const xml = buildInvoiceDataXml(st.invoice);
    expect(xml).not.toContain('individualExemption');
    expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
  });

  it('leaving cash accounting: the storno keeps „pénzforgalmi elszámolás” and cashAccountingIndicator', async () => {
    const { app } = setup();
    app.updateSeller({ cashAccounting: true });
    const orig = await issued(app);
    expect(orig.invoice.notations).toContain('pénzforgalmi elszámolás');
    app.updateSeller({ cashAccounting: false });
    expect(app.stornoPreview(orig.invoice.id, 'Téves').storno.notations).toContain('pénzforgalmi elszámolás');
    const st = await app.cancel(orig.invoice.id, { reason: 'Téves' });
    expect(st.invoice.notations).toContain('pénzforgalmi elszámolás');
    const xml = buildInvoiceDataXml(st.invoice);
    expect(xml).toContain('<cashAccountingIndicator>true</cashAccountingIndicator>');
    expect((await validateNavXml(xml, 'data')).errors).toEqual([]);
  });
});

describe('a copy never keeps a stale manual exchange rate (LEGAL-3, BIZ-3, MCP-UX-1, MCP-UX-12)', () => {
  it('MNB policy: the copy gets the MNB rate of its new fulfilment date; a rate given in the same call wins', async () => {
    const mnb = mnbFetch({ '2026-08-13': '400,00', '2026-10-26': '390,12' });
    const { app, clock } = setup('2026-08-14T09:00:00.000Z', { fetch: mnb.fetch });
    const eu = app.saveCustomer(EU_CUSTOMER).customer;
    const src = await app.createDraft({ customerId: eu.id, currency: 'EUR', exchangeRate: '398.5', lines: EU_LINES });
    expect([src.invoice.exchangeRateSource, src.invoice.exchangeRateDate]).toEqual(['manual', '2026-08-14']);
    const srcIssued = await app.issue(src.invoice.id);
    expect(mnb.calls()).toBe(0);
    clock.now = new Date('2026-10-27T09:00:00.000Z');
    const copy = await app.createDraft({ copyFromId: srcIssued.invoice.number as string });
    expect(copy.invoice.fulfillmentDate).toBe('2026-10-27');
    expect([copy.invoice.exchangeRate, copy.invoice.exchangeRateDate, copy.invoice.exchangeRateSource]).toEqual(['390.12', '2026-10-26', 'MNB']);
    expect(copy.invoice.totals.netAmountHuf).toBe('390120');
    // The documented recurring flow: copy, then update the dates.
    const moved = await app.updateDraft(copy.invoice.id, { fulfillmentDate: '2026-10-26' });
    expect([moved.invoice.exchangeRate, moved.invoice.exchangeRateSource]).toEqual(['390.12', 'MNB']);
    const given = await app.createDraft({ copyFromId: srcIssued.invoice.id, exchangeRate: '391' });
    expect([given.invoice.exchangeRate, given.invoice.exchangeRateSource, given.invoice.exchangeRateDate]).toEqual(['391', 'manual', '2026-10-27']);
  });

  it('manual policy: a copied invoice or a converted díjbekérő needs a new rate (one EXCHANGE_RATE_MISSING)', async () => {
    const { app, clock } = setup('2026-08-14T09:00:00.000Z', { fetch: unreachable });
    app.updateDefaults({ exchangeRateSource: 'manual' });
    const eu = app.saveCustomer(EU_CUSTOMER).customer;
    const inv = await app.issue((await app.createDraft({ customerId: eu.id, currency: 'EUR', exchangeRate: '398.5', lines: EU_LINES })).invoice.id);
    const pro = await app.issue((await app.createDraft({ documentType: 'proforma', customerId: eu.id, currency: 'EUR', exchangeRate: '398.5', lines: EU_LINES })).invoice.id);
    clock.now = new Date('2026-10-27T09:00:00.000Z');
    for (const source of [inv.invoice, pro.invoice]) {
      const copy = await app.createDraft({ copyFromId: source.id });
      expect(copy.invoice.documentType).toBe('invoice');
      expect(copy.invoice.exchangeRate).toBe('0');
      expect(copy.readyToIssue).toBe(false);
      const missing = copy.issues.filter((i) => i.code === 'EXCHANGE_RATE_MISSING');
      expect(missing).toHaveLength(1);
      expect(missing[0]?.message).toMatch(/kézi árfolyam-beállítás/);
      expect(app.viewInvoice(copy.invoice.id).issues.filter((i) => i.code === 'EXCHANGE_RATE_MISSING')).toEqual(missing);
      const fixed = await app.updateDraft(copy.invoice.id, { exchangeRate: '390.5' });
      expect(fixed.readyToIssue, JSON.stringify(fixed.issues)).toBe(true);
    }
  });

  it('a manual rate belongs to its fulfilment date: moving the date drops it (MNB policy: MNB rate; manual policy: enter a new one)', async () => {
    const mnb = mnbFetch({ '2026-10-20': '395,00', '2026-10-26': '390,12' });
    const { app } = setup('2026-10-27T09:00:00.000Z', { fetch: mnb.fetch });
    const eu = app.saveCustomer(EU_CUSTOMER).customer;
    const d = await app.createDraft({ customerId: eu.id, currency: 'EUR', exchangeRate: '398.5', lines: EU_LINES });
    expect((await app.updateDraft(d.invoice.id, { comment: 'Megjegyzés' })).invoice.exchangeRate).toBe('398.5');
    const moved = await app.updateDraft(d.invoice.id, { fulfillmentDate: '2026-10-21' });
    expect([moved.invoice.exchangeRate, moved.invoice.exchangeRateDate, moved.invoice.exchangeRateSource]).toEqual(['395', '2026-10-20', 'MNB']);

    app.updateDefaults({ exchangeRateSource: 'manual' });
    const m = await app.createDraft({ customerId: eu.id, currency: 'EUR', exchangeRate: '398.5', lines: EU_LINES });
    const dropped = await app.updateDraft(m.invoice.id, { fulfillmentDate: '2026-10-21' });
    expect(dropped.invoice.exchangeRate).toBe('0');
    expect(errorCodes(dropped.issues)).toContain('EXCHANGE_RATE_MISSING');
    const both = await app.updateDraft(m.invoice.id, { fulfillmentDate: '2026-10-20', exchangeRate: '395.5' });
    expect([both.invoice.exchangeRate, both.invoice.exchangeRateDate, both.invoice.exchangeRateSource]).toEqual(['395.5', '2026-10-20', 'manual']);
  });

  it('MNB unreachable: one specific EXCHANGE_RATE_MISSING, the same in the draft response and in its view', async () => {
    const { app } = setup('2026-10-27T09:00:00.000Z', { fetch: unreachable });
    const eu = app.saveCustomer(EU_CUSTOMER).customer;
    const d = await app.createDraft({ customerId: eu.id, currency: 'EUR', lines: EU_LINES });
    const missing = d.issues.filter((i) => i.code === 'EXCHANGE_RATE_MISSING');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toMatch(/Nem sikerült lekérni az MNB EUR/);
    expect(app.viewInvoice(d.invoice.id).issues.filter((i) => i.code === 'EXCHANGE_RATE_MISSING')).toEqual(missing);
  });
});

describe('advance deductions are checked against the előlegszámla (LEGAL-4, LEGAL-5)', () => {
  const finalLines = (advanceInvoiceNumber: string, amount = '100000', vatCode: '27' | '5' = '27', total = '300000') => [
    { description: 'Tervezési munka – teljes díj', quantity: '1', unit: 'db', unitPrice: total, vatCode: '27' as const },
    { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: amount, vatCode, advanceDeduction: { advanceInvoiceNumber, advancePaymentDate: '2026-10-20' } },
  ];

  async function withAdvance() {
    const ctx = setup();
    const customerId = ctx.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const adv = await ctx.app.createDraft({ customerId, documentType: 'advance', fulfillmentDate: '2026-10-20', lines: [{ description: 'Előleg', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
    const advance = await ctx.app.issue(adv.invoice.id);
    expect(advance.invoice.number).toBe('SZ-2026-00001');
    return { ...ctx, customerId };
  }

  it('a correct deduction passes; an unknown advance number is only a warning (an earlier program may have issued it)', async () => {
    const { app, customerId } = await withAdvance();
    const ok = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001') });
    expect(ok.issues.filter((i) => i.code.startsWith('ADVANCE_'))).toEqual([]);
    expect(ok.readyToIssue).toBe(true);
    const unknown = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2025-99999') });
    expect(unknown.readyToIssue).toBe(true);
    expect(warningCodes(unknown.issues)).toContain('ADVANCE_INVOICE_NOT_FOUND');
  });

  it('errors: not an advance invoice, a cancelled advance; warnings: another buyer, more than the advance, a double deduction, another VAT code', async () => {
    const { app, customerId } = await withAdvance();
    const normal = await issued(app);
    const notAdvance = await app.createDraft({ customerId, documentType: 'final', lines: finalLines(normal.invoice.number as string) });
    expect(errorCodes(notAdvance.issues)).toContain('ADVANCE_INVOICE_NOT_ADVANCE');
    const other = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, name: 'Másik Kft.', taxNumber: '10773381-2-44' }).customer.id;
    const otherBuyer = await app.createDraft({ customerId: other, documentType: 'final', lines: finalLines('SZ-2026-00001', '500000', '27', '600000') });
    expect(warningCodes(otherBuyer.issues)).toEqual(expect.arrayContaining(['ADVANCE_INVOICE_OTHER_CUSTOMER', 'ADVANCE_DEDUCTION_EXCEEDS_ADVANCE']));
    const vat5 = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001', '1000', '5') });
    expect(warningCodes(vat5.issues)).toContain('ADVANCE_DEDUCTION_VAT_CODE');

    const first = await app.issue((await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001') })).invoice.id);
    const copy = await app.createDraft({ copyFromId: first.invoice.id });
    expect(copy.invoice.documentType).toBe('final');
    expect(warningCodes(copy.issues)).toContain('ADVANCE_DEDUCTION_EXCEEDS_ADVANCE');
    // A cancelled végszámla's deduction is reversed by its storno: the advance can be deducted again.
    await app.cancel(first.invoice.id, { reason: 'Téves végszámla' });
    const again = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001') });
    expect(warningCodes(again.issues)).not.toContain('ADVANCE_DEDUCTION_EXCEEDS_ADVANCE');

    await app.cancel('SZ-2026-00001', { reason: 'Téves előleg' });
    const cancelled = await app.createDraft({ customerId, documentType: 'final', lines: finalLines('SZ-2026-00001') });
    expect(errorCodes(cancelled.issues)).toContain('ADVANCE_INVOICE_CANCELLED');
    expect(cancelled.readyToIssue).toBe(false);
  });

  it('foreign-currency végszámla: the advance rate comes from the előlegszámla, never a made-up 1', async () => {
    const { app } = setup('2026-10-27T09:00:00.000Z', { fetch: unreachable });
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const eur = { customerId, currency: 'EUR', exchangeRate: '390' } as const;
    const adv = await app.issue((await app.createDraft({ ...eur, exchangeRate: '385', documentType: 'advance', fulfillmentDate: '2026-10-20', lines: [{ description: 'Advance', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }] })).invoice.id);
    const lines = (advanceInvoiceNumber: string, advanceExchangeRate?: string) => [
      { description: 'Design work', quantity: '1', unit: 'db', unitPrice: '3000', vatCode: '27' as const },
      { description: 'Advance deducted', quantity: '-1', unit: 'db', unitPrice: '1000', vatCode: '27' as const, advanceDeduction: { advanceInvoiceNumber, advancePaymentDate: '2026-10-20', ...(advanceExchangeRate ? { advanceExchangeRate } : {}) } },
    ];
    const final = await app.createDraft({ ...eur, documentType: 'final', lines: lines(adv.invoice.number as string) });
    expect(final.invoice.lines[1]?.advanceDeduction?.advanceExchangeRate).toBe('385');
    expect(final.readyToIssue, JSON.stringify(final.issues)).toBe(true);
    const xml = buildInvoiceDataXml((await app.issue(final.invoice.id)).invoice);
    expect(xml).toContain('<advanceExchangeRate>385</advanceExchangeRate>');
    expect((await validateNavXml(xml, 'data')).errors).toEqual([]);

    const unknown = await app.createDraft({ ...eur, documentType: 'final', lines: lines('R-2025-0007') });
    expect(unknown.readyToIssue).toBe(false);
    expect(errorCodes(unknown.issues)).toContain('LINE_ADVANCE_RATE_MISSING');
    const given = await app.createDraft({ ...eur, documentType: 'final', lines: lines('R-2025-0007', '380') });
    expect(given.invoice.lines[1]?.advanceDeduction?.advanceExchangeRate).toBe('380');
    expect(errorCodes(given.issues)).toEqual([]);
  });
});

describe('number series never share numbers (NUM-1, BIZ-7, BIZ-13)', () => {
  it('rejects a pattern that can produce numbers of another active series, of either kind', () => {
    const { app } = setup();
    expect(codeOf(() => app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'SZ-{YYYY}-{SEQ:5}' }))).toBe('SERIES_PATTERN_OVERLAP');
    expect(codeOf(() => app.createSeries({ kind: 'invoice', name: 'Migráció', pattern: 'SZ-{YYYY}-0{SEQ:4}', startSeq: 2 }))).toBe('SERIES_PATTERN_OVERLAP');
    expect(codeOf(() => app.createSeries({ kind: 'proforma', name: 'Díjbekérő 2', pattern: 'SZ-{YYYY}-{SEQ:6}' }))).toBe('SERIES_PATTERN_OVERLAP');
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:5}' });
    expect(codeOf(() => app.updateSeries(web.id, { pattern: 'SZ-{YYYY}-{SEQ:5}' }))).toBe('SERIES_PATTERN_OVERLAP');
    expect(app.updateSeries(web.id, { name: 'Webáruház' }).name).toBe('Webáruház');
    expect(app.listSeries().map((s) => s.pattern).sort()).toEqual(['DB-{YYYY}-{SEQ:5}', 'SZ-{YYYY}-{SEQ:5}', 'WEB-{YYYY}-{SEQ:5}']);
  });

  it('a new series whose next number an archived series already issued must start after it', async () => {
    const { app } = setup();
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:5}' });
    expect((await issued(app, { seriesId: web.id })).invoice.number).toBe('WEB-2026-00001');
    app.updateSeries(web.id, { archived: true });
    expect(codeOf(() => app.createSeries({ kind: 'invoice', name: 'Webshop 2', pattern: 'WEB-{YYYY}-{SEQ:5}' }))).toBe('SERIES_NUMBER_TAKEN');
    const web2 = app.createSeries({ kind: 'invoice', name: 'Webshop 2', pattern: 'WEB-{YYYY}-{SEQ:5}', startSeq: 2 });
    expect((await issued(app, { seriesId: web2.id })).invoice.number).toBe('WEB-2026-00002');
    // Bringing the old series back would share numbers with the new one.
    expect(codeOf(() => app.updateSeries(web.id, { archived: false }))).toBe('SERIES_PATTERN_OVERLAP');
  });

  it('the default series cannot be switched off; another series takes over the default role', () => {
    const { app } = setup();
    const def = app.listSeries('invoice').find((s) => s.isDefault) as SeriesRow;
    expect(codeOf(() => app.updateSeries(def.id, { isDefault: false }))).toBe('INVALID_INPUT');
    expect(codeOf(() => app.updateSeries(def.id, { archived: true }))).toBe('INVALID_INPUT');
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:5}', isDefault: true });
    expect(app.listSeries('invoice').find((s) => s.isDefault)?.id).toBe(web.id);
    expect(app.updateSeries(def.id, { archived: true }).archived).toBe(true);
  });

  it('a database left without a default series by an older version gets its series back, never a colliding new one', async () => {
    const { app, clock } = setup();
    await issued(app);
    await issued(app);
    const def = app.listSeries('invoice').find((s) => s.isDefault) as SeriesRow;
    // What older versions allowed: switching off the only default series …
    app.store.updateSeries({ ...def, isDefault: false });
    let restarted = new OpenSzamla(app.store, app.config, { now: () => clock.now });
    expect(restarted.listSeries('invoice').map((s) => [s.id, s.isDefault])).toEqual([[def.id, true]]);
    // … and then archiving it.
    app.store.updateSeries({ ...def, isDefault: false, archived: true });
    restarted = new OpenSzamla(app.store, app.config, { now: () => clock.now });
    expect(restarted.listSeries('invoice').map((s) => [s.id, s.isDefault, s.archived])).toEqual([[def.id, true, false]]);
    expect((await issued(restarted)).invoice.number).toBe('SZ-2026-00003');
  });

  it('numbers starting with "inv_" are found by number too', async () => {
    const { app } = setup();
    const s = app.createSeries({ kind: 'invoice', name: 'Belső', pattern: 'inv_{YYYY}_{SEQ:4}' });
    const r = await issued(app, { seriesId: s.id });
    expect(r.invoice.number).toBe('inv_2026_0001');
    expect(app.getInvoice('inv_2026_0001').id).toBe(r.invoice.id);
    expect(app.getInvoice(` ${r.invoice.id} `).number).toBe('inv_2026_0001');
    expect(app.recordPayment('inv_2026_0001', {}).paymentStatus).toBe('paid');
    expect((await app.taxAuditExport({ fromNumber: 'inv_2026_0001', toNumber: 'inv_2026_0001' })).count).toBe(1);
  });
});

describe('previews show what issuing gives (MCP-UX-3, MCP-UX-4)', () => {
  it('a derived due date moves with the issue date, an explicit one stays – the preview and the issued invoice agree', async () => {
    const { app, clock } = setup('2026-10-26T09:00:00.000Z');
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const derived = await app.createDraft({ customerId, lines: LINES });
    const explicit = await app.createDraft({ customerId, lines: LINES, dueDate: '2026-11-15' });
    expect(derived.invoice.dueDate).toBe('2026-11-03');
    clock.now = new Date('2026-10-27T09:00:00.000Z');
    const dv = app.viewInvoice(derived.invoice.id);
    expect([dv.invoice.issueDate, dv.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-04']);
    expect(dv.issues.find((i) => i.code === 'ISSUE_DATE_WILL_CHANGE')?.message).toMatch(/2026-11-03 → 2026-11-04/);
    const ev = app.viewInvoice(explicit.invoice.id);
    expect([ev.invoice.issueDate, ev.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-15']);
    expect(ev.issues.find((i) => i.code === 'ISSUE_DATE_WILL_CHANGE')?.message).toMatch(/2026-11-15\) nem változik/);
    // Changing the issue date of the draft keeps an explicit due date too.
    expect((await app.updateDraft(explicit.invoice.id, { issueDate: '2026-10-27' })).invoice.dueDate).toBe('2026-11-15');
    // The draft PDF (TERVEZET) shows the same dates as the preview.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(readFileSync((await app.pdf(derived.invoice.id)).path)) });
    try {
      const text = (await parser.getText()).text.replace(/\s+/g, ' ');
      expect(text).toContain('2026.11.04.');
      expect(text).not.toContain('2026.11.03.');
    } finally {
      await parser.destroy();
    }
    const di = await app.issue(derived.invoice.id);
    const ei = await app.issue(explicit.invoice.id);
    expect([di.invoice.issueDate, di.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-04']);
    expect([ei.invoice.issueDate, ei.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-15']);
    expect(ei.invoice.dueDateExplicit).toBeUndefined();
  });

  it('a draft dated in the past is previewed with today’s issue date right when it is saved', async () => {
    const { app } = setup();
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, lines: LINES, issueDate: '2026-10-20', fulfillmentDate: '2026-10-20', dueDate: '2026-11-15' });
    expect(app.getInvoice(d.invoice.id).issueDate).toBe('2026-10-20');
    expect([d.invoice.issueDate, d.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-15']);
    expect(warningCodes(d.issues)).toContain('ISSUE_DATE_WILL_CHANGE');
    const r = await app.issue(d.invoice.id);
    expect([r.invoice.issueDate, r.invoice.dueDate]).toEqual(['2026-10-27', '2026-11-15']);
    expect(r.notes.join(' ')).toMatch(/megadott fizetési határidő \(2026-11-15\) nem változott/);
  });

  it('stornoPreview is exactly the storno cancel() issues: the original and its corrections, negated', async () => {
    const { app } = setup();
    const orig = await issued(app);
    const corr = await app.createCorrectionDraft(orig.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }], comment: 'Kedvezmény' });
    const mod = await app.issue(corr.invoice.id);
    const p = app.stornoPreview(orig.invoice.id, 'Téves');
    expect(p.storno.totals.grossAmount).toBe('-182000');
    expect(p.negates.map((m) => m.number)).toEqual([mod.invoice.number]);
    expect(errorCodes(p.issues)).toEqual([]);
    const st = await app.cancel(orig.invoice.id, { reason: 'Téves' });
    expect(st.invoice.totals).toEqual(p.storno.totals);
    expect(() => app.stornoPreview(orig.invoice.id)).toThrow(AppError);
  });

  it('the issue confirmation of a correction is bound to its modification index', async () => {
    const { app } = setup();
    const orig = await issued(app);
    const line = { description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' as const };
    const a = await app.createCorrectionDraft(orig.invoice.id, { lines: [line] });
    const b = await app.createCorrectionDraft(orig.invoice.id, { lines: [line] });
    const fb = app.issueFingerprint(b.invoice.id);
    await app.issue(a.invoice.id);
    expect(app.issueFingerprint(b.invoice.id)).not.toBe(fb);
    expect(app.viewInvoice(b.invoice.id).invoice.reference?.modificationIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes: files, exports, reports, payments, customers, integrity check
// ---------------------------------------------------------------------------------------------

describe('invoice files: local copies only, never overwritten, clash-free names (SEC-1, SEC-2, BIZ-10, BIZ-11, DOC-7)', () => {
  it('copyToDir refuses UNC and device paths before touching the file system; a local folder works, no file is overwritten', async () => {
    const { app } = setup();
    const r = await issued(app);
    for (const dir of ['\\\\192.0.2.1\\share', '//192.0.2.1/share', '\\\\?\\UNC\\192.0.2.1\\s', '\\\\.\\C:\\x', '\\\\?\\C:\\x', '/\\192.0.2.1\\share']) {
      const started = Date.now();
      await expect(app.pdf(r.invoice.id, { copyToDir: dir }), dir).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Hálózati (UNC) vagy eszközútvonalra') });
      // Merely checking that \\host\share exists takes ~20 s on Windows: it connects to the host (SMB).
      expect(Date.now() - started, dir).toBeLessThan(500);
    }
    const target = mkdtempSync(join(tmpdir(), 'openszamla-copy-'));
    try {
      const first = await app.pdf(r.invoice.id, { copyToDir: target });
      expect(first.copiedTo).toBe(join(realpathSync(target), 'SZ-2026-00001.pdf'));
      expect(readFileSync(first.copiedTo as string).equals(readFileSync(first.path))).toBe(true);
      // The same PDF again is fine; another file of that name stays untouched.
      expect((await app.pdf(r.invoice.id, { copyToDir: target })).copiedTo).toBe(first.copiedTo);
      writeFileSync(first.copiedTo as string, 'nem a számla');
      await expect(app.pdf(r.invoice.id, { copyToDir: target })).rejects.toMatchObject({ code: 'FILE_EXISTS' });
      expect(readFileSync(first.copiedTo as string, 'utf8')).toBe('nem a számla');
      await expect(app.pdf(r.invoice.id, { copyToDir: 'relativ-mappa' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('without file copying the hint offers the resource link only – there is no base64 option (DOC-7)', async () => {
    const { app } = setup();
    const r = await issued(app);
    (app.config as { allowFileCopy: boolean }).allowFileCopy = false;
    const e = await app.pdf(r.invoice.id, { copyToDir: tmpdir() }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'FILE_COPY_DISABLED' });
    expect((e as AppError).hint).toContain('resource link');
    expect((e as AppError).hint).not.toMatch(/base64/);
  });

  it('numbers that give the same file name get files of their own; the one issued first keeps the plain name', async () => {
    const { app, clock } = setup();
    const later = (): void => {
      clock.now = new Date(clock.now.getTime() + 60_000);
    };
    const slash = app.createSeries({ kind: 'invoice', name: 'Perjeles', pattern: 'AB/{YYYY}/{SEQ}' });
    const underscore = app.createSeries({ kind: 'invoice', name: 'Aláhúzásos', pattern: 'AB_{YYYY}_{SEQ}' });
    const lower = app.createSeries({ kind: 'invoice', name: 'Kisbetűs', pattern: 'ab-{YYYY}-{SEQ}' });
    const a = await issued(app, { seriesId: slash.id });
    later();
    const b = await issued(app, { seriesId: underscore.id });
    later();
    const c = await issued(app, { seriesId: lower.id });
    later();
    // An archived series does not block the case variant of its pattern (NTFS and macOS ignore case).
    app.updateSeries(lower.id, { archived: true });
    const d = await issued(app, { seriesId: app.createSeries({ kind: 'invoice', name: 'Nagybetűs', pattern: 'AB-{YYYY}-{SEQ}' }).id });
    const all = [a, b, c, d];
    expect(all.map((r) => r.invoice.number)).toEqual(['AB/2026/1', 'AB_2026_1', 'ab-2026-1', 'AB-2026-1']);
    expect(all.map((r) => basename(r.pdfPath as string))).toEqual(['AB_2026_1.pdf', `AB_2026_1_${b.invoice.id}.pdf`, 'ab-2026-1.pdf', `AB-2026-1_${d.invoice.id}.pdf`]);
    // Every pdfPath returned on issuing still holds that invoice's own PDF.
    const softwareName = `${app.config.software.softwareName} ${VERSION}`;
    for (const r of all) {
      expect(readFileSync(r.pdfPath as string).equals(await renderInvoicePdf(app.getInvoice(r.invoice.id), { softwareName })), r.invoice.number as string).toBe(true);
    }
    expect((await app.pdf(b.invoice.id)).path).toBe(b.pdfPath);

    const xml = app.exportInvoices({ from: '2026-10-01', to: '2026-10-31', format: 'xml' });
    expect(xml.count).toBe(4);
    expect(readdirSync(xml.path).sort()).toEqual(['AB-2026-1_' + d.invoice.id + '.xml', 'AB_2026_1.xml', `AB_2026_1_${b.invoice.id}.xml`, 'ab-2026-1.xml'].sort());
    expect(xml.warnings.map((w) => [w.invoiceNumber, w.field])).toEqual([['AB_2026_1', 'file'], ['AB-2026-1', 'file']]);

    const audit = await app.taxAuditExport({ from: '2026-10-01', to: '2026-10-31' });
    expect(audit.count).toBe(4);
    expect(readdirSync(join(audit.path, 'nav-osa'))).toHaveLength(4);
    expect(readdirSync(join(audit.path, 'pdf'))).toHaveLength(4);
    expect(audit.warnings.filter((w) => w.field === 'file').map((w) => w.invoiceNumber)).toEqual(['AB_2026_1', 'AB-2026-1']);
    expect(readFileSync(join(audit.path, 'OLVASSEL.txt'), 'utf8')).toContain(`AB_2026_1_${b.invoice.id}`);

    // A MÁSOLAT render is a file of its own: the issued invoice's PDF stays as it was.
    const original = readFileSync(a.pdfPath as string);
    const copy = await app.pdf(a.invoice.id, { copy: true });
    expect(basename(copy.path)).toBe('AB_2026_1_MASOLAT.pdf');
    expect(readFileSync(a.pdfPath as string).equals(original)).toBe(true);
    expect(readFileSync(copy.path).equals(original)).toBe(false);
  });

  it('a tax-audit export by a number range given as ids holds the invoice numbers in its header, folder and OLVASSEL.txt (BIZ-11)', async () => {
    const { app } = setup();
    const a = await issued(app);
    const b = await issued(app);
    const exp = await app.taxAuditExport({ fromNumber: a.invoice.id, toNumber: b.invoice.id });
    expect([exp.count, exp.numberFrom, exp.numberTo]).toEqual([2, 'SZ-2026-00001', 'SZ-2026-00002']);
    const xml = readFileSync(join(exp.path, 'szamlak.xml'), 'utf8');
    expect(xml).toContain('<kezdo_szla_szam>SZ-2026-00001</kezdo_szla_szam>');
    expect(xml).toContain('<zaro_szla_szam>SZ-2026-00002</zaro_szla_szam>');
    expect((await validateSzamla2013Xml(xml)).errors).toEqual([]);
    expect(basename(exp.path)).toMatch(/^adohatosagi-ellenorzes_SZ-2026-00001_SZ-2026-00002_/);
    expect(readFileSync(join(exp.path, 'OLVASSEL.txt'), 'utf8')).toContain('Sorszámtartomány: SZ-2026-00001 – SZ-2026-00002');
  });
});

describe('payments and receivables (BIZ-8, BIZ-9)', () => {
  it('a negative amount only takes back what was paid; back at 0 the invoice is unpaid without a payment date', async () => {
    const { app } = setup();
    const r = await issued(app); // 194 700 Ft
    expect(codeOf(() => app.recordPayment(r.invoice.id, { amount: '-5000' }))).toBe('INVALID_INPUT');
    expect(codeOf(() => app.recordPayment(r.invoice.id, { amount: '0' }))).toBe('INVALID_INPUT');
    const part = app.recordPayment(r.invoice.id, { amount: '4000', date: '2026-10-20' });
    // Paid in part: no payment date yet (paidDate is the day it became fully paid).
    expect([part.paymentStatus, part.paidAmount, part.paidDate]).toEqual(['partial', '4000', null]);
    expect(() => app.recordPayment(r.invoice.id, { amount: '-4001' })).toThrow(/nem lehet nagyobb a befizetettnél/);
    const back = app.recordPayment(r.invoice.id, { amount: '-4000' });
    expect([back.paymentStatus, back.paidAmount, back.paidDate]).toEqual(['unpaid', '0', null]);
    // An overpayment is recorded only when confirmed; then the default amount has nothing left to record.
    expect(() => app.recordPayment(r.invoice.id, { amount: '200000' })).toThrowError(expect.objectContaining({ code: 'OVERPAYMENT_NOT_CONFIRMED' }));
    const over = app.recordPayment(r.invoice.id, { amount: '200000', allowOverpayment: true });
    expect([over.paymentStatus, over.paidAmount]).toEqual(['paid', '200000']);
    expect(() => app.recordPayment(r.invoice.id, {})).toThrow(/teljesen ki van fizetve/);
    expect(app.recordPayment(r.invoice.id, { amount: '-5300' })).toMatchObject({ paymentStatus: 'paid', paidAmount: '194700' });
    expect(app.report({ from: '2026-10-01', to: '2026-10-31' }).receivables).toMatchObject({ unpaidCount: 0, unpaidGrossHuf: '0' });
  });

  it('a crediting modification: the refund is negative and a positive amount takes it back', async () => {
    const { app } = setup();
    const orig = await issued(app);
    // Paid in full before the credit: the credit is to be refunded (unpaid, it is not set off – MCP-6).
    app.recordPayment(orig.invoice.id, {});
    const corr = await app.createCorrectionDraft(orig.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }] });
    const mod = (await app.issue(corr.invoice.id)).invoice;
    expect(mod.totals.payableAmount).toBe('-12700');
    expect(mod.paymentStatus).toBe('unpaid');
    expect(codeOf(() => app.recordPayment(mod.id, { amount: '100' }))).toBe('INVALID_INPUT');
    expect(app.recordPayment(mod.id, {})).toMatchObject({ paymentStatus: 'paid', paidAmount: '-12700' });
    expect(app.recordPayment(mod.id, { amount: '12700' })).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0', paidDate: null });
  });

  it('receivables count what is owed – the documents the unpaid and overdue lists show – and net credit notes against their invoice', async () => {
    const { app, clock } = setup('2026-10-01T09:00:00.000Z');
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const line = (unitPrice: string) => [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' as const }];
    const credited = (await app.issue((await app.createDraft({ customerId, lines: line('20000') })).invoice.id)).invoice; // 25 400 Ft, due 10-09
    const zero = (await app.issue((await app.createDraft({ customerId, lines: line('0') })).invoice.id)).invoice;
    expect(zero.totals.grossAmount).toBe('0');
    clock.now = new Date('2026-10-27T09:00:00.000Z');
    const full = await app.createCorrectionDraft(credited.id, { lines: [{ description: 'Teljes jóváírás', quantity: '1', unit: 'db', unitPrice: '-20000', vatCode: '27' }] });
    expect((await app.issue(full.invoice.id)).invoice.totals.grossAmount).toBe('-25400');
    await issued(app); // 194 700 Ft, due 11-04: open, not overdue
    const today = app.today();
    const r = app.report({ from: '2026-10-01', to: '2026-10-31' }).receivables;
    expect(r.unpaidCount).toBe(app.findInvoices({ receivable: true, paymentStatus: ['unpaid', 'partial'] }).total);
    expect(r.unpaidCount).toBe(app.status().counts.unpaid);
    expect(r.overdueCount).toBe(app.findInvoices({ overdueOn: today }).total);
    // The full credit settles the credited invoice (MCP-6: nothing is owed on its chain, so it is not overdue
    // either); the 0 Ft invoice and the credit note itself owe nothing.
    expect(app.getInvoice(credited.id).paymentStatus).toBe('paid');
    expect(app.findInvoices({ overdueOn: today }).items.map((i) => i.id)).toEqual([]);
    expect([r.unpaidCount, r.overdueCount]).toEqual([1, 0]);
    expect([r.unpaidGrossHuf, r.overdueGrossHuf]).toEqual(['194700', '0']);
    // A 0 Ft invoice is closed by marking it paid (it takes no amount).
    expect(codeOf(() => app.recordPayment(zero.id, { amount: '10' }))).toBe('INVALID_INPUT');
    expect(app.recordPayment(zero.id, {}).paymentStatus).toBe('paid');
    expect(() => app.recordPayment(zero.id, {})).toThrow(/teljesen ki van fizetve/);
  });
});

describe('periods by issue date or by fulfilment date (MCP-UX-6)', () => {
  it('an invoice for September issued in October belongs to September by fulfilment date (the VAT tax point)', async () => {
    const { app } = setup('2026-10-05T09:00:00.000Z');
    const r = await issued(app, { fulfillmentDate: '2026-09-30' });
    expect([r.invoice.issueDate, r.invoice.fulfillmentDate]).toEqual(['2026-10-05', '2026-09-30']);
    const sept = { from: '2026-09-01', to: '2026-09-30' };
    expect(app.report(sept)).toMatchObject({ dateBasis: 'issue', invoiceCount: 0 });
    const vat = app.report({ ...sept, dateBasis: 'fulfillment' });
    expect(vat).toMatchObject({ dateBasis: 'fulfillment', invoiceCount: 1, totalsHuf: { vat: '40700' } });
    expect(vat.byMonth.map((m) => m.month)).toEqual(['2026-09']);
    expect(app.report({ from: '2026-10-01', to: '2026-10-31', dateBasis: 'fulfillment' }).invoiceCount).toBe(0);
    expect(app.exportInvoices({ ...sept, format: 'csv' }).count).toBe(0);
    const exp = app.exportInvoices({ ...sept, format: 'csv', dateBasis: 'fulfillment' });
    expect(exp).toMatchObject({ count: 1, from: '2026-09-01', to: '2026-09-30', dateBasis: 'fulfillment' });
    expect(basename(exp.path)).toBe('szamlak_teljesites_2026-09-01_2026-09-30.csv');
    expect(codeOf(() => app.report({ ...sept, dateBasis: 'kelt' as never }))).toBe('INVALID_INPUT');
  });
});

describe('customer and product updates change only the given fields (MCP-UX-7)', () => {
  it('customer: a field left out keeps its value, null or "" clears it, an address without country keeps the country', () => {
    const { app } = setup();
    const c = app.saveCustomer({ ...EU_CUSTOMER, email: 'info@beispiel.de', phone: '+49 30 1234567', bankAccount: 'DE89370400440532013000', note: 'Fontos' }).customer;
    const email = app.saveCustomer({ id: c.id, email: 'uj@beispiel.de' }).customer;
    expect(email).toMatchObject({ vatStatus: 'OTHER', name: 'Beispiel GmbH', euVatNumber: 'DE123456789', phone: '+49 30 1234567', email: 'uj@beispiel.de', note: 'Fontos' });
    expect(email.bankAccount).toBeTruthy();
    const cleared = app.saveCustomer({ id: c.id, phone: null, bankAccount: '' }).customer;
    expect([cleared.phone, cleared.bankAccount, cleared.euVatNumber]).toEqual([undefined, undefined, 'DE123456789']);
    const moved = app.saveCustomer({ id: c.id, address: { countryCode: '', postalCode: '10117', city: 'Berlin', addressLine: 'Unter den Linden 1' } }).customer;
    expect(moved.address).toEqual({ countryCode: 'DE', postalCode: '10117', city: 'Berlin', addressLine: 'Unter den Linden 1' });
    expect(app.saveCustomer({ id: c.id, archived: true }).customer).toMatchObject({ archived: true, email: 'uj@beispiel.de' });
    expect(codeOf(() => app.saveCustomer({ id: c.id, name: '' }))).toBe('INVALID_INPUT');
    expect(codeOf(() => app.saveCustomer({ name: 'Új vevő', address: DOMESTIC_CUSTOMER_INPUT.address }))).toBe('INVALID_INPUT');
    expect(app.getCustomer(c.id).euVatNumber).toBe('DE123456789');
  });

  it('product: currency, price basis and nature left out keep their value', () => {
    const { app } = setup();
    const p = app.saveProduct({ name: 'Consulting', unit: 'óra', unitPrice: '100', currency: 'EUR', priceBasis: 'gross', vatCode: 'EUFAD37', nature: 'OTHER' });
    expect(app.saveProduct({ id: p.id, name: 'Consulting', unit: 'óra', unitPrice: '120', vatCode: 'EUFAD37' })).toMatchObject({ currency: 'EUR', priceBasis: 'gross', nature: 'OTHER', unitPrice: '120' });
    // A new unit infers the nature again unless it is given.
    expect(app.saveProduct({ id: p.id, name: 'Consulting', unit: 'db', unitPrice: '120', vatCode: 'EUFAD37' }).nature).toBe('PRODUCT');
  });
});

describe('verify finds changes made to the database outside the program (BIZ-6)', () => {
  /** Runs `change` with the named protective triggers dropped; `restore` puts them back unchanged. */
  function withoutTriggers(app: OpenSzamla, names: string[], change: () => void, restore = true): void {
    const db = app.store.unsafeRawDatabaseForTests();
    const saved = names.map((n) => String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(n)?.sql));
    for (const n of names) db.exec(`DROP TRIGGER ${n}`);
    change();
    if (restore) for (const sql of saved) db.exec(sql);
  }

  it('a deleted issued invoice and a rewritten one with a recomputed hash (the triggers put back)', async () => {
    const { app } = setup();
    for (let i = 0; i < 3; i++) await issued(app);
    const before = app.verifyIntegrity();
    expect(before).toMatchObject({ ok: true, invoicesChecked: 3, invoiceMismatches: [], auditMismatches: [], unauditedInvoices: [], numberingGaps: [], alteredTriggers: [], audit: { ok: true } });
    expect(before.audit.head?.hash).toMatch(/^[0-9a-f]{64}$/);
    const db = app.store.unsafeRawDatabaseForTests();
    const third = app.getInvoice('SZ-2026-00003');
    withoutTriggers(app, ['invoices_delete_guard', 'invoices_immutable_columns', 'invoice_documents_delete_guard'], () => {
      // Its kept original PDF references it: removed first.
      expect(db.prepare('DELETE FROM invoice_documents WHERE invoice_id = (SELECT id FROM invoices WHERE number = ?)').run('SZ-2026-00002').changes).toBe(1);
      expect(db.prepare('DELETE FROM invoices WHERE number = ?').run('SZ-2026-00002').changes).toBe(1);
      // Another buyer, with the content hash recomputed (it is a plain SHA-256 of the content).
      const changed: Invoice = { ...third, customer: { ...third.customer, name: 'Valaki Más Kft.' } };
      const contentHash = invoiceContentHash(changed);
      const doc = JSON.parse(String(db.prepare('SELECT doc FROM invoices WHERE id = ?').get(third.id)?.doc)) as Record<string, unknown>;
      db.prepare('UPDATE invoices SET doc = ?, customer_name = ?, content_hash = ? WHERE id = ?').run(JSON.stringify({ ...doc, customer: changed.customer, contentHash }), 'Valaki Más Kft.', contentHash, third.id);
    });
    expect(app.getInvoice('SZ-2026-00003').customer.name).toBe('Valaki Más Kft.');
    const after = app.verifyIntegrity();
    expect(after).toMatchObject({ ok: false, invoicesChecked: 2, invoiceMismatches: [], alteredTriggers: [], audit: { ok: true } });
    expect(after.auditMismatches).toEqual([
      expect.stringMatching(/^SZ-2026-00002: .*hiányzik az adatbázisból/),
      expect.stringMatching(/^SZ-2026-00003: a tartalma eltér a kiállításkor naplózottól/),
    ]);
    expect(after.documentMismatches).toEqual([expect.stringMatching(/^SZ-2026-00002: az eredeti PDF megőrzése naplózva van .*hiányzik az adatbázisból/)]);
  });

  it('the last invoice deleted with its log entry (the chain stays intact), a dropped trigger and an invoice inserted without the program', async () => {
    const { app } = setup();
    await issued(app);
    await issued(app);
    const head = app.verifyIntegrity().audit.head;
    const db = app.store.unsafeRawDatabaseForTests();
    withoutTriggers(app, ['audit_log_delete_guard'], () => {
      // The issuance of SZ-2026-00002 and the keeping of its PDF are the last entries: cutting them off leaves the rest of the chain intact.
      expect(db.prepare(`SELECT action FROM audit_log WHERE id > (SELECT MAX(id) FROM audit_log WHERE action = 'invoice.issue') ORDER BY id`).all().map((r) => r.action)).toEqual(['invoice.document']);
      expect(db.prepare(`DELETE FROM audit_log WHERE id >= (SELECT MAX(id) FROM audit_log WHERE action = 'invoice.issue')`).run().changes).toBe(2);
    });
    withoutTriggers(app, ['invoice_documents_delete_guard'], () => db.prepare('DELETE FROM invoice_documents WHERE invoice_id = (SELECT id FROM invoices WHERE number = ?)').run('SZ-2026-00002'));
    withoutTriggers(app, ['invoices_delete_guard'], () => db.prepare('DELETE FROM invoices WHERE number = ?').run('SZ-2026-00002'), false);
    const outside: Invoice = { ...app.getInvoice('SZ-2026-00001'), id: 'inv_0000outside', status: 'draft', number: null, issuedAt: null, contentHash: null };
    app.store.insertDraft(outside);
    const inserted: Invoice = { ...outside, status: 'issued', number: 'KULSO-1', issuedAt: '2026-10-27T09:30:00.000Z' };
    app.store.markIssued({ ...inserted, contentHash: invoiceContentHash(inserted) });
    const r = app.verifyIntegrity();
    expect(r.audit.ok).toBe(true);
    expect(r.audit.head?.id).toBeLessThan(head?.id as number);
    expect(r).toMatchObject({ ok: false, auditMismatches: [], unauditedInvoices: ['KULSO-1'], alteredTriggers: ['invoices_delete_guard'] });
    expect(r.numberingGaps).toEqual(['Számlák: hiányzik a(z) SZ-2026-00002 sorszám.']);
  });
});
