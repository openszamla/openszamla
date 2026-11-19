/**
 * NAV-6: `verify` derives the numbering periods of a series from its history – the year logged with each
 * issuance and the switches of its yearly restart (series_manage) – instead of the current setting. A
 * documented switch no longer reads as tampering; real gaps are still found in every year.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

/** An app whose clock is set by `at(date)`; `issue()` issues one invoice (in `seriesId`, else the default series) and returns its number. */
function setup(): { app: OpenSzamla; at(day: string): void; issue(seriesId?: string): Promise<string> } {
  let now = new Date('2026-06-01T10:00:00.000Z');
  t = makeTestApp({ now: () => now });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  return {
    app,
    at(day) {
      now = new Date(`${day}T10:00:00.000Z`);
    },
    async issue(seriesId) {
      const d = await app.createDraft({ customerId, ...(seriesId ? { seriesId } : {}), lines: [{ description: 'Tétel', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: '27' }] });
      return (await app.issue(d.invoice.id)).invoice.number as string;
    },
  };
}

function defaultSeriesId(app: OpenSzamla): string {
  return (app.listSeries('invoice').find((s) => s.isDefault) ?? { id: '' }).id;
}

function expectClean(app: OpenSzamla): void {
  const r = app.verifyIntegrity();
  expect(r.numberingGaps).toEqual([]);
  expect(r.ok).toBe(true);
}

/** Removes the issuance log entries of these numbers (as a tamperer would; the chain breaks, the numbering check must still see the hole). */
function dropIssuanceLog(app: OpenSzamla, ...numbers: string[]): void {
  const db = app.store.unsafeRawDatabaseForTests();
  const guard = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_delete_guard'`).get()?.sql);
  db.exec('DROP TRIGGER audit_log_delete_guard');
  for (const n of numbers) {
    expect(db.prepare(`DELETE FROM audit_log WHERE action = 'invoice.issue' AND json_extract(details, '$.number') = ?`).run(n).changes, n).toBe(1);
  }
  db.exec(guard);
}

describe('verify follows the yearly restart through its switches (NAV-6)', () => {
  it('yearly restart switched off after a restart: no false alarm, the numbering continues into the next year', async () => {
    const { app, at, issue } = setup();
    at('2026-12-30');
    expect([await issue(), await issue(), await issue(), await issue()]).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003', 'SZ-2026-00004']);
    at('2027-01-04');
    expect(await issue()).toBe('SZ-2027-00001');
    expectClean(app);
    app.updateSeries(defaultSeriesId(app), { yearlyReset: false });
    expectClean(app);
    expect(await issue()).toBe('SZ-2027-00002');
    expectClean(app);
    at('2028-01-05');
    expect(await issue()).toBe('SZ-2028-00003');
    expectClean(app);
  });

  it('on → off → on: every period checked from its own start', async () => {
    const { app, at, issue } = setup();
    const id = defaultSeriesId(app);
    at('2026-11-02');
    for (let i = 0; i < 3; i++) await issue();
    at('2027-02-01');
    expect(await issue()).toBe('SZ-2027-00001');
    app.updateSeries(id, { yearlyReset: false });
    expectClean(app);
    expect(await issue()).toBe('SZ-2027-00002');
    at('2028-03-01');
    expect(await issue()).toBe('SZ-2028-00003');
    expectClean(app);
    app.updateSeries(id, { yearlyReset: true });
    expectClean(app);
    expect(await issue()).toBe('SZ-2028-00004');
    at('2029-01-02');
    expect(await issue()).toBe('SZ-2029-00001');
    expectClean(app);
    // The restarted year is checked from 1 again, after all the switches.
    expect(await issue()).toBe('SZ-2029-00002');
    dropIssuanceLog(app, 'SZ-2029-00001');
    expect(app.verifyIntegrity().numberingGaps).toEqual(['Számlák: hiányzik a(z) SZ-2029-00001 sorszám.']);
  });

  it('a continuous series switched to yearly restart and back (logged at creation)', async () => {
    const { app, at, issue } = setup();
    at('2026-06-01');
    const s = app.createSeries({ kind: 'invoice', name: 'Folyamatos', pattern: 'F-{YYYY}-{SEQ:5}', yearlyReset: false });
    expect(app.auditLog({ entityId: s.id }).items.find((e) => e.action === 'series.create')?.details).toMatchObject({ yearlyReset: false, startSeq: 1 });
    await issue(s.id);
    at('2027-06-01');
    expect(await issue(s.id)).toBe('F-2027-00002');
    app.updateSeries(s.id, { yearlyReset: true });
    expect(await issue(s.id)).toBe('F-2027-00003');
    at('2028-06-01');
    expect(await issue(s.id)).toBe('F-2028-00001');
    app.updateSeries(s.id, { yearlyReset: false });
    expectClean(app);
  });

  it('a series whose creation was logged without the setting (older version): inferred from the numbers', async () => {
    for (const yearlyReset of [false, true]) {
      const { app, at, issue } = setup();
      at('2026-06-01');
      const id = `ser_regi${yearlyReset ? 'evente' : 'folyamatos'}`;
      app.store.insertSeries({ id, kind: 'invoice', name: 'Régi', pattern: 'R-{YYYY}-{SEQ:4}', yearlyReset, nextSeq: 1, seqYear: null, isDefault: false, archived: false, createdAt: '2026-06-01T10:00:00.000Z' });
      app.store.audit({ actor: 'cli', action: 'series.create', entityType: 'series', entityId: id, details: { name: 'Régi', pattern: 'R-{YYYY}-{SEQ:4}', kind: 'invoice', startSeq: 1 } });
      await issue(id);
      await issue(id);
      at('2027-06-01');
      expect(await issue(id)).toBe(yearlyReset ? 'R-2027-0001' : 'R-2027-0003');
      app.updateSeries(id, { yearlyReset: !yearlyReset });
      expectClean(app);
      expect(await issue(id)).toBe(yearlyReset ? 'R-2027-0002' : 'R-2027-0004');
      at('2028-06-01');
      expect(await issue(id)).toBe(yearlyReset ? 'R-2028-0003' : 'R-2028-0001');
      expectClean(app);
      t?.cleanup();
      t = null;
    }
  });
});

describe('real gaps are still found in every year (NAV-6)', () => {
  it('in a closed year, in a continued period – also across the year boundary – and at the end', async () => {
    const { app, at, issue } = setup();
    const id = defaultSeriesId(app);
    at('2026-11-02');
    for (let i = 0; i < 3; i++) await issue(); // SZ-2026-00001…3
    at('2027-02-01');
    for (let i = 0; i < 3; i++) await issue(); // SZ-2027-00001…3
    app.updateSeries(id, { yearlyReset: false });
    at('2028-03-01');
    await issue(); // SZ-2028-00004
    await issue(); // SZ-2028-00005
    app.updateSeries(id, { yearlyReset: true });
    at('2029-01-02');
    await issue(); // SZ-2029-00001
    await issue(); // SZ-2029-00002
    expectClean(app);
    dropIssuanceLog(app, 'SZ-2026-00002', 'SZ-2027-00002', 'SZ-2028-00004', 'SZ-2029-00002');
    expect(app.verifyIntegrity().numberingGaps).toEqual([
      'Számlák: hiányzik a(z) SZ-2026-00002 sorszám.',
      'Számlák: hiányzik a(z) SZ-2027-00002 sorszám.',
      'Számlák: hiányzik a(z) 4. sorszám a(z) SZ-2027-00003 és a(z) SZ-2028-00005 között.',
      'Számlák: hiányzik a(z) SZ-2029-00002 sorszám.',
    ]);
  });

  it('a missing start of a restarted year, and a counter set back outside the program (shown with the logged number)', async () => {
    const { app, at, issue } = setup();
    const id = defaultSeriesId(app);
    at('2026-11-02');
    await issue();
    at('2027-02-01');
    await issue(); // SZ-2027-00001
    await issue(); // SZ-2027-00002
    app.updateSeries(id, { yearlyReset: false });
    dropIssuanceLog(app, 'SZ-2027-00001');
    expect(app.verifyIntegrity().numberingGaps).toEqual(['Számlák: hiányzik a(z) SZ-2027-00001 sorszám.']);
    app.store.unsafeRawDatabaseForTests().prepare('UPDATE series SET next_seq = 1 WHERE id = ?').run(id);
    expect(app.verifyIntegrity().numberingGaps).toEqual([
      'Számlák: hiányzik a(z) SZ-2027-00001 sorszám.',
      'Számlák: a következő kiadandó sorszám (SZ-2027-00001) nem követi a már kiadott SZ-2027-00002 sorszámot.',
    ]);
  });

  it('numbers given out after the last logged one in a new year with the restart on (the end of the log cut off)', async () => {
    const { app, at, issue } = setup();
    at('2026-11-02');
    await issue();
    at('2027-02-01');
    await issue(); // SZ-2027-00001 – its log entry is the last one
    dropIssuanceLog(app, 'SZ-2027-00001');
    expect(app.verifyIntegrity().numberingGaps).toEqual(['Számlák: hiányzik a(z) SZ-2027-00001 sorszám.']);
  });
});
