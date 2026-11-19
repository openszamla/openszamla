/**
 * An archived number series never allocates a new number (TAX-5): invoices of an archived series stay
 * correctable – their modification and storno are numbered from the current default invoice series,
 * with a warning naming it –, while a new document cannot be numbered from an archived series.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
const LINES = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' as const }];
const DISCOUNT = [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' as const }];

async function caught(p: Promise<unknown>): Promise<{ code?: string; message?: string; hint?: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message?: string; hint?: string };
  }
  throw new Error('expected a rejection');
}

/** SZ-2026-00001 and SZ-2026-00002 from the default series "Számlák"; on 2027-01-02 "A{YYYY}/{SEQ:4}" becomes the default and "Számlák" is archived. */
async function setup(): Promise<{ app: OpenSzamla; clock: { now: Date }; customerId: string; first: Invoice; second: Invoice; oldId: string; newId: string }> {
  const clock = { now: new Date('2026-12-15T09:00:00.000Z') };
  t = makeTestApp({ now: () => clock.now });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const issue = async (): Promise<Invoice> => (await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice;
  const first = await issue();
  const second = await issue();
  const oldId = first.seriesId;
  clock.now = new Date('2027-01-02T09:00:00.000Z');
  const fresh = app.createSeries({ kind: 'invoice', name: 'Számlák 2027', pattern: 'A{YYYY}/{SEQ:4}', isDefault: true });
  app.updateSeries(oldId, { archived: true });
  return { app, clock, customerId, first, second, oldId, newId: fresh.id };
}

describe('corrections of invoices from an archived series', () => {
  it('a modification is numbered from the default series, with a warning naming it in the preview', async () => {
    const { app, first, oldId, newId } = await setup();
    const corr = await app.createCorrectionDraft(first.id, { lines: DISCOUNT, comment: 'Utólagos árengedmény' });
    expect(corr.readyToIssue).toBe(true);
    expect(corr.invoice.seriesId).toBe(newId);
    const warning = corr.issues.find((i) => i.code === 'CORRECTION_SERIES_ARCHIVED');
    expect(warning).toMatchObject({ severity: 'warning', field: 'seriesId' });
    expect(warning?.message).toBe('Az eredeti számla sorszámtartománya („Számlák”) archivált, ezért a(z) „Számlák 2027” sorszámtartományból kap sorszámot.');
    const r = await app.issue(corr.invoice.id);
    expect(r.invoice.number).toBe('A2027/0001');
    expect(r.invoice.seriesId).toBe(newId);
    expect(r.invoice.reference?.originalInvoiceNumber).toBe(first.number);
    expect(r.notes).toContain(warning?.message);
    expect((await validateNavXml(buildInvoiceDataXml(r.invoice), 'data')).errors).toEqual([]);
    // The archived series gave out nothing.
    expect(app.store.getSeries(oldId)?.nextSeq).toBe(3);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, numberingGaps: [] });
  });

  it('a storno is numbered from the default series too, and the preview says so', async () => {
    const { app, second, oldId, newId } = await setup();
    const preview = app.stornoPreview(second.id, 'Téves számla');
    expect(preview.storno.seriesId).toBe(newId);
    expect(preview.issues.map((i) => i.code)).toEqual(['CORRECTION_SERIES_ARCHIVED']);
    const r = await app.cancel(second.id, { reason: 'Téves számla' });
    expect([r.invoice.number, r.invoice.seriesId]).toEqual(['A2027/0001', newId]);
    expect(app.getInvoice(second.id).status).toBe('cancelled');
    expect(app.store.getSeries(oldId)?.nextSeq).toBe(3);
    expect((await validateNavXml(buildInvoiceDataXml(r.invoice), 'data')).errors).toEqual([]);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, numberingGaps: [] });
  });

  it('a correction drafted before the series was archived is numbered from the default series when issued', async () => {
    const clock = { now: new Date('2026-12-15T09:00:00.000Z') };
    t = makeTestApp({ now: () => clock.now });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice;
    const corr = await app.createCorrectionDraft(original.id, { lines: DISCOUNT, comment: 'Utólagos árengedmény' });
    expect(corr.issues.map((i) => i.code)).not.toContain('CORRECTION_SERIES_ARCHIVED');
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:4}', isDefault: true });
    app.updateSeries(original.seriesId, { archived: true });
    const view = app.viewInvoice(corr.invoice.id);
    expect(view.issues.map((i) => i.code)).toContain('CORRECTION_SERIES_ARCHIVED');
    const r = await app.issue(corr.invoice.id);
    expect([r.invoice.number, r.invoice.seriesId]).toEqual(['WEB-2026-0001', web.id]);
  });

  it('no dead end when the successor series repeats the archived pattern', async () => {
    const clock = { now: new Date('2026-11-08T09:00:00.000Z') };
    t = makeTestApp({ now: () => clock.now });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const original = (await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice;
    // Replacing the series by one with the same pattern, continuing after it (6.3: startSeq).
    app.createSeries({ kind: 'invoice', name: 'Átmeneti', pattern: 'TMP-{SEQ}', isDefault: true });
    app.updateSeries(original.seriesId, { archived: true });
    const successor = app.createSeries({ kind: 'invoice', name: 'Számlák (új)', pattern: 'SZ-{YYYY}-{SEQ:5}', startSeq: 2, isDefault: true });
    expect((await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice.number).toBe('SZ-2026-00002');
    // The archived series cannot come back (it would share numbers), and it is not needed for corrections.
    expect(codeOfSync(() => app.updateSeries(original.seriesId, { archived: false }))).toBe('SERIES_PATTERN_OVERLAP');
    const corr = await app.createCorrectionDraft(original.id, { lines: DISCOUNT, comment: 'Utólagos árengedmény' });
    expect((await app.issue(corr.invoice.id)).invoice).toMatchObject({ number: 'SZ-2026-00003', seriesId: successor.id });
    const storno = await app.cancel(original.id, { reason: 'Téves számla' });
    expect(storno.invoice).toMatchObject({ number: 'SZ-2026-00004', seriesId: successor.id });
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, numberingGaps: [] });
  });
});

describe('a new document is never numbered from an archived series', () => {
  it('choosing an archived series fails with SERIES_ARCHIVED and a hint', async () => {
    const { app, customerId, oldId } = await setup();
    const e = await caught(app.createDraft({ customerId, seriesId: oldId, lines: LINES }));
    expect(e).toMatchObject({ code: 'SERIES_ARCHIVED', message: 'A(z) "Számlák" sorszámtartomány archivált.' });
    expect(e.hint).toBe('Válassz aktív sorszámtartományt (új piszkozat az alapértelmezettet kapja), vagy szüntesd meg ennek a sorszámtartománynak az archiválását.');
    expect(e).toMatchObject({ details: { seriesId: oldId } });
    // Editing the draft of a series archived since needs a series as well.
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:4}' });
    const d = await app.createDraft({ customerId, seriesId: web.id, lines: LINES });
    app.updateSeries(web.id, { archived: true });
    expect(await caught(app.updateDraft(d.invoice.id, { comment: 'Megjegyzés' }))).toMatchObject({ code: 'SERIES_ARCHIVED' });
    const moved = await app.updateDraft(d.invoice.id, { seriesId: newIdOf(app), comment: 'Megjegyzés' });
    expect(moved.readyToIssue).toBe(true);
  });

  it('a draft whose series was archived since cannot be issued until it gets an active series', async () => {
    const clock = { now: new Date('2026-11-08T09:00:00.000Z') };
    t = makeTestApp({ now: () => clock.now });
    const app = t.app;
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const web = app.createSeries({ kind: 'invoice', name: 'Webshop', pattern: 'WEB-{YYYY}-{SEQ:4}' });
    const d = await app.createDraft({ customerId, seriesId: web.id, lines: LINES });
    app.updateSeries(web.id, { archived: true });
    const view = app.viewInvoice(d.invoice.id);
    expect(view.readyToIssue).toBe(false);
    expect(errorCodes(view.issues)).toEqual(['SERIES_ARCHIVED']);
    expect(view.issues[0]?.message).toMatch(/^A\(z\) "Webshop" sorszámtartomány archivált\. Válassz aktív sorszámtartományt/);
    const e = await caught(app.issue(d.invoice.id));
    expect(e.code).toBe('SERIES_ARCHIVED');
    expect(app.store.getSeries(web.id)?.nextSeq).toBe(1);
    expect(app.getInvoice(d.invoice.id).status).toBe('draft');
    const moved = await app.updateDraft(d.invoice.id, { seriesId: newIdOf(app) });
    expect(moved.readyToIssue).toBe(true);
    expect((await app.issue(d.invoice.id)).invoice.number).toBe('SZ-2026-00001');
  });
});

/** The current default invoice series. */
function newIdOf(app: OpenSzamla): string {
  return app.listSeries('invoice').find((s) => s.isDefault)?.id as string;
}

function codeOfSync(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  }
}
