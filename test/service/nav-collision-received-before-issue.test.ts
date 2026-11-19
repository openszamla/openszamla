/**
 * NS1: NAV holds a report under our number that it received before this invoice was issued (auditData insDate more
 * than 5 minutes – the clock difference tolerated between this machine and NAV – before issuedAt). That report existed
 * before the invoice did, so it is another invoice whatever its data. After a restored backup the re-issued number can
 * go to the same goods at the same price for another private person: NAV gets no data of private persons, so the two
 * reports are byte for byte the same, and the byte comparison with our own (rejected) re-send used to call it
 * "reported". It is a number collision (OPENSZAMLA_NUMBER_COLLISION) whose message gives both times. Genuine re-sends
 * still reconcile – an answer that was lost, and a backup taken after the issue but before the send: NAV received
 * those after the invoice was issued.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import type { CustomerInput } from '../../src/service/inputs.ts';
import { navReceivedBeforeIssue } from '../../src/service/nav-match.ts';
import { SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';

const MINUTE = 60_000;
const PERSON_1: CustomerInput = { vatStatus: 'PRIVATE_PERSON', name: 'Nagy Péter', address: { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Bartók Béla út 1.' } };
const PERSON_2: CustomerInput = { vatStatus: 'PRIVATE_PERSON', name: 'Kiss Erzsébet', address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 9.' } };

let nav: FakeNavServer;
const dirs: string[] = [];
const apps: OpenSzamla[] = [];
/** Time that passed since the test began (ms) – for NAV and for this machine alike. */
let passed = 0;
/** This machine's clock: the real time plus what `passed`, plus `skew` when the PC clock itself is fast (> 0) or slow. */
const pcNow = (skew = 0) => (): Date => new Date(Date.now() + passed + skew);

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0, now: () => new Date(Date.now() + passed) });
});
afterAll(async () => {
  await nav.stop();
});
afterEach(() => {
  for (const a of apps.splice(0)) {
    try {
      a.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  nav.reset();
  passed = 0;
});

// The fake NAV stamps what it receives with its clock (the real time plus `passed`), and accepts requests within a day of it.
function open(dir?: string, opts: { now?: () => Date; fetch?: typeof fetch } = {}): OpenSzamla {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'openszamla-insdate-'));
  if (!dir) dirs.push(dataDir);
  const config = loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: opts.now ?? (() => new Date()), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  apps.push(app);
  if (!app.getSeller()) app.updateSeller(SELLER_INPUT);
  return app;
}

/** One cash sale of one line at a gross price. */
async function sale(app: OpenSzamla, customer: CustomerInput, description: string, gross: string, opts: { submitToNav?: boolean } = {}) {
  const view = await app.createDraft({ customer, paymentMethod: 'CASH', lines: [{ description, quantity: '1', unit: 'db', unitPrice: gross, priceBasis: 'gross', vatCode: '27' }] });
  expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return app.issue(view.invoice.id, opts);
}

/** The backup is restored: what was issued after it is lost here, NAV still holds it. */
function restore(app: OpenSzamla, backup: string, opts: { now?: () => Date; fetch?: typeof fetch } = {}): OpenSzamla {
  const { dataDir, dbPath } = app.config;
  app.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
  copyFileSync(backup, dbPath);
  return open(dataDir, opts);
}

/** The time in Hungary as the messages write it, e.g. "2026.11.14. 16:39:47". */
function huTime(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day}. ${p.hour}:${p.minute}:${p.second}`;
}

const codes = (inv: Invoice): string[] => inv.navMessages.map((m) => m.code);
const reconcileAudit = (app: OpenSzamla, inv: Invoice): Record<string, unknown> | undefined => app.auditLog({ entityId: inv.id }).items.find((e) => e.action === 'nav.reconcile')?.details;

describe('navReceivedBeforeIssue: NAV received the report more than the clock margin before the invoice was issued', () => {
  const inv = { issuedAt: '2026-11-14T15:00:00.000Z' };
  const margin = 5 * MINUTE;

  it('only more than the margin before counts', () => {
    expect(navReceivedBeforeIssue(inv, '2026-11-14T14:54:59.999Z', margin)).toBe(true);
    expect(navReceivedBeforeIssue(inv, '2026-11-13T15:00:00Z', margin)).toBe(true);
    expect(navReceivedBeforeIssue(inv, ' 2026-11-14T14:00:00.12Z\n', margin)).toBe(true);
    expect(navReceivedBeforeIssue(inv, '2026-11-14T14:55:00.000Z', margin)).toBe(false); // exactly the margin
    expect(navReceivedBeforeIssue(inv, '2026-11-14T14:57:30Z', margin)).toBe(false); // this machine's clock is fast
    expect(navReceivedBeforeIssue(inv, '2026-11-14T15:00:00.500Z', margin)).toBe(false); // sent right after the issue
    expect(navReceivedBeforeIssue(inv, '2026-11-15T09:00:00Z', margin)).toBe(false); // sent a day later
  });

  it('a missing or unreadable time keeps the comparison of the data', () => {
    for (const insDate of [null, undefined, '', 'tegnap', '2026-11-14T14:00:00', '2026-11-14T14:00:00+01:00', '2026-11-14', '2026-13-45T99:99:99Z']) {
      expect(navReceivedBeforeIssue(inv, insDate, margin), String(insDate)).toBe(false);
    }
    expect(navReceivedBeforeIssue({ issuedAt: null }, '2026-11-14T14:00:00Z', margin)).toBe(false);
    expect(navReceivedBeforeIssue({ issuedAt: 'nem időpont' }, '2026-11-14T14:00:00Z', margin)).toBe(false);
  });
});

describe('NS1: a byte-identical repeat sale after a restored backup is a number collision', () => {
  it('the re-issued number, the same goods at the same price to another private person: not "reported"', async () => {
    let app = open();
    await sale(app, PERSON_1, 'Nyitó számla', '1000');
    const backup = join(app.config.dataDir, 'mentes.db');
    app.store.backup(backup);
    const lost = await sale(app, PERSON_1, 'Belépőjegy', '2000');
    expect(lost.invoice.navStatus).toBe('done');

    // The backup is restored half an hour later, and the next sale gets the lost sale's number.
    passed = 30 * MINUTE;
    app = restore(app, backup, { now: pcNow() });
    const again = await sale(app, PERSON_2, 'Belépőjegy', '2000');
    expect(again.invoice.number).toBe(lost.invoice.number);
    // NAV gets nothing about private persons: on the same day the two reports are the same bytes.
    const sent = nav.invoices.filter((r) => r.invoiceNumber === again.invoice.number).map((r) => r.xml);
    expect(sent).toHaveLength(2);
    if (again.invoice.issueDate === lost.invoice.issueDate) expect(sent[1]).toBe(sent[0]);

    expect(again.invoice.navStatus).toBe('aborted');
    expect(codes(again.invoice)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    const details = reconcileAudit(app, again.invoice);
    expect(details).toMatchObject({ via: 'queryInvoiceData', match: 'other' });
    const insDate = details?.insDate as string;
    const issuedAt = again.invoice.issuedAt as string;
    expect(Date.parse(issuedAt) - Date.parse(insDate)).toBeGreaterThan(25 * MINUTE);
    expect(details?.differences).toEqual([`a NAV ${huTime(insDate)}-kor kapta meg, ez a számla csak ${huTime(issuedAt)}-kor készült`]);
    expect(again.invoice.navMessages[1]?.message).toContain(
      `A(z) ${again.invoice.number} sorszám a NAV-nál egy másik számláé: az ezzel a sorszámmal ott tárolt számlát a NAV ${huTime(insDate)}-kor kapta meg, ` +
        `ez a számla pedig csak ${huTime(issuedAt)}-kor készült (e gép órája szerint), így az nem ez a számla – akkor sem, ha az adatai egyeznek vele`,
    );
    expect(again.invoice.navMessages[1]?.message).toContain('Ez a számla tehát NINCS jelentve');
    expect(again.nav?.note).toMatch(/^Sorszám-ütközés: a NAV TESZT rendszere ezzel a sorszámmal egy másik számlát tárol, ez a számla nincs jelentve/);
    expect(app.status().counts).toMatchObject({ navProblems: 1, navPending: 0 });
  });

  it('the same after an attempt with an unknown outcome, looked up by its number: a collision, and nothing is adopted', async () => {
    let app = open();
    await sale(app, PERSON_1, 'Nyitó számla', '1000');
    const backup = join(app.config.dataDir, 'mentes.db');
    app.store.backup(backup);
    const lost = await sale(app, PERSON_1, 'Parkolás 1 óra', '600');
    expect(lost.invoice.navStatus).toBe('done');

    passed = 30 * MINUTE;
    let drop = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (drop && String(input).endsWith('/manageInvoice')) {
        drop = false; // the connection broke: the outcome is unknown (here it never reached NAV)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return fetch(input, init);
    };
    app = restore(app, backup, { now: pcNow(), fetch: fetchImpl });
    const again = await sale(app, PERSON_2, 'Parkolás 1 óra', '600');
    expect(again.invoice.number).toBe(lost.invoice.number);
    expect(again.invoice.navStatus).toBe('pending');
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    passed += 6 * MINUTE;
    const [res] = await app.navSync({ waitSeconds: 1 });
    expect(res?.navStatus).toBe('aborted');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_NUMBER_COLLISION']);
    expect(res?.messages[0]?.message).toMatch(/kapta meg, ez a számla pedig csak .*-kor készült \(e gép órája szerint\)/);
    expect(res?.note).toMatch(/^Sorszám-ütközés: .*\(eltérés: a NAV .*-kor kapta meg, ez a számla csak .*-kor készült\) – ez a számla nincs jelentve, és nem küldtük be\./);
    expect(res?.transactionId).toBeNull(); // the lost sale's transaction is not taken over
    expect(reconcileAudit(app, again.invoice)).toMatchObject({ via: 'queryInvoiceData', match: 'other' });
    expect(nav.requests.filter((q) => q.operation === 'manageInvoice')).toHaveLength(2); // the two first sales only
  });
});

describe('NS1: genuine re-sends still reconcile', () => {
  it('(a) the answer to the submission was lost: NAV received it after the issue – done, even with a clock 4 minutes fast', async () => {
    const skew = 4 * MINUTE; // this machine's clock is fast
    const app = open(undefined, { now: pcNow(skew) });
    nav.failNext({ kind: 'LOST_RESPONSE' }, { operation: 'manageInvoice' });
    const ours = await sale(app, PERSON_2, 'Belépőjegy', '2000');
    expect(ours.invoice.navStatus).toBe('pending');
    expect(codes(ours.invoice)).toContain('OPENSZAMLA_UNCERTAIN');
    expect(nav.invoices.map((r) => r.invoiceStatus)).toEqual(['DONE']); // NAV has it; the answer was lost
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    passed += 6 * MINUTE;
    const [res] = await app.navSync({ waitSeconds: 1 });
    expect(res?.navStatus).toBe('done');
    expect(res?.note).toMatch(/a NAV-nál a számla szerepel \(azonos adattartalommal\), ezért nem küldtük újra/);
    expect(reconcileAudit(app, ours.invoice)).toMatchObject({ via: 'queryInvoiceData', match: 'same' });
    expect(nav.requests.filter((q) => q.operation === 'manageInvoice')).toHaveLength(1);
  });

  it('(b) a backup taken after the issue but before the send was restored: the re-send, hours after the issue, is done', async () => {
    passed = -2 * 60 * MINUTE; // issued two hours ago
    const now = pcNow();
    let app = open(undefined, { now });
    const ours = await sale(app, PERSON_2, 'Belépőjegy', '2000', { submitToNav: false });
    const backup = join(app.config.dataDir, 'mentes.db');
    app.store.backup(backup);
    passed = 0; // sent two hours after the issue
    expect((await app.navSync({ waitSeconds: 3 }))[0]?.navStatus).toBe('done');

    app = restore(app, backup, { now });
    const restored = app.getInvoice(ours.invoice.id);
    expect([restored.navStatus, restored.issuedAt]).toEqual(['pending', ours.invoice.issuedAt]);
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_RECONCILED']);
    expect(res?.messages[0]?.message).toMatch(/bájtra azonos/);
    expect(reconcileAudit(app, ours.invoice)).toMatchObject({ via: 'queryInvoiceData', match: 'same' });
    expect(app.status().counts).toMatchObject({ navProblems: 0, navPending: 0 });
  });
});
