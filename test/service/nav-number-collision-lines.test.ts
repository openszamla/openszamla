/**
 * NV1: what NAV holds under our number counts as this invoice only when it really is this one. A report typed by hand
 * on the NAV web interface (auditData source WEB) matches on its key data, as before. One that came through the
 * machine interface (MGM) – or any other channel, see nav-collision-other-channels.test.ts – was made by a program,
 * so its lines must agree too – line count, and per line the description, quantity, unit, net
 * amount and VAT rate: after a restored same-day backup the re-issued number often goes to another private person at
 * the same price (NAV gets no data of private persons), or to the same company for the same amount but other goods.
 * Those are number collisions, not reports. A genuine re-send of the same invoice still reconciles as done.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CustomerInput } from '../../src/service/inputs.ts';
import type { Invoice } from '../../src/core/types.ts';
import { parseInvoiceDataKeys } from '../../src/nav/api-xml.ts';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import type { NavInvoiceKeys } from '../../src/nav/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { navRecordDifferences } from '../../src/service/nav-match.ts';
import { INVOICE_DOMESTIC, INVOICE_PRIVATE_AAM } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FAKE_NAV_SOFTWARE, FakeNavServer } from '../helpers/fake-nav.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

const PERSON_1: CustomerInput = { vatStatus: 'PRIVATE_PERSON', name: 'Nagy Péter', address: { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Bartók Béla út 1.' } };
const PERSON_2: CustomerInput = { vatStatus: 'PRIVATE_PERSON', name: 'Kiss Erzsébet', address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 9.' } };

let nav: FakeNavServer;
const dirs: string[] = [];
const apps: OpenSzamla[] = [];

beforeAll(async () => {
  nav = await FakeNavServer.start({ receivedPolls: 0 });
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
});

function open(dir?: string, opts: { now?: () => Date; fetch?: typeof fetch } = {}): OpenSzamla {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'openszamla-lines-'));
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

/** The last backup is restored: the invoices issued after it are lost here, NAV still holds them. */
function restore(app: OpenSzamla, backup: string): OpenSzamla {
  const { dataDir, dbPath } = app.config;
  app.close();
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
  copyFileSync(backup, dbPath);
  return open(dataDir);
}

/** Reports `inv` through the machine interface, as another installation or invoicing program would (source MGM). */
async function reportByProgram(inv: Invoice): Promise<void> {
  const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  const { transactionId } = await client.manageInvoice([{ index: 1, operation: navOperationFor(inv), invoiceDataBase64: Buffer.from(buildInvoiceDataXml(inv), 'utf8').toString('base64') }]);
  expect((await client.queryTransactionStatus(transactionId)).results[0]?.invoiceStatus).toBe('DONE');
}

const codes = (inv: Invoice): string[] => inv.navMessages.map((m) => m.code);
const heldAtNav = (number: string | null): string[] => nav.invoices.filter((r) => r.invoiceNumber === number && r.invoiceStatus === 'DONE').map((r) => /<lineDescription>([^<]*)</.exec(r.xml)?.[1] ?? '');

describe('NV1: a report sent through the machine interface (MGM) matches only with the same lines', () => {
  it('restored backup, the number re-issued to another private person at the same price: a collision, not "reported"', async () => {
    let app = open();
    await sale(app, PERSON_1, 'Nyitó számla', '1000');
    const backup = join(app.config.dataDir, 'mentes.db');
    app.store.backup(backup);
    const lost = await sale(app, PERSON_1, 'Női hajvágás', '8000');
    expect(lost.invoice.navStatus).toBe('done');

    app = restore(app, backup);
    const again = await sale(app, PERSON_2, 'Férfi hajvágás és szakálligazítás', '8000');
    expect(again.invoice.number).toBe(lost.invoice.number);
    expect(again.invoice.navStatus).toBe('aborted');
    expect(codes(again.invoice)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    expect(again.invoice.navMessages[1]?.message).toMatch(/egy másik számláé: az ezzel a sorszámmal ott tárolt számla adatai eltérnek ettől a számlától \(1\. tétel megnevezése\)/);
    expect(again.nav?.note).toMatch(/^Sorszám-ütközés/);
    expect(heldAtNav(again.invoice.number)).toEqual(['Női hajvágás']); // NAV still holds the lost sale
    expect(app.status().counts).toMatchObject({ navProblems: 1, navPending: 0 });
  });

  it('the same company, the same amount, other goods (another program reported the number): a collision', async () => {
    const app = open();
    const ours = await sale(app, DOMESTIC_CUSTOMER_INPUT, 'Nyomtatópatron', '50000', { submitToNav: false });
    await reportByProgram({ ...ours.invoice, lines: ours.invoice.lines.map((l) => ({ ...l, description: 'Irodaszer csomag' })) });
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('aborted');
    expect(res?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    expect(res?.messages[1]?.message).toContain('(1. tétel megnevezése)');
    expect(app.auditLog({ entityId: ours.invoice.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ match: 'other', differences: ['1. tétel megnevezése'] });
  });

  it('a genuine re-send through the machine interface – other details, the same key data and lines – reconciles as done', async () => {
    const app = open();
    const ours = await sale(app, DOMESTIC_CUSTOMER_INPUT, 'Szerviz', '12700', { submitToNav: false });
    // E.g. another installation (or version) of the program sent it: same lines, other non-key data (address, due date).
    await reportByProgram({ ...ours.invoice, dueDate: '2099-12-31', customer: { ...ours.invoice.customer, address: { ...ours.invoice.customer.address, addressLine: 'Fő tér 1/A.' } } });
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_RECONCILED']);
    expect(res?.messages[0]?.message).toMatch(/gépi interfészen \(MGM\) érkezett.*tételei.*is egyeznek/);
    expect(app.auditLog({ entityId: ours.invoice.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ match: 'similar', source: 'MGM' });
  });

  it('entered on the NAV web interface (source WEB) with other line texts: still reported on its key data', async () => {
    const app = open();
    const ours = await sale(app, PERSON_2, 'Férfi hajvágás', '8000', { submitToNav: false });
    const byHand = { ...ours.invoice, lines: ours.invoice.lines.map((l) => ({ ...l, description: 'Hajvágás (kézi rögzítés)', unit: 'alkalom' })) };
    expect((await nav.addInvoice(buildInvoiceDataXml(byHand), { source: 'WEB' })).invoiceStatus).toBe('DONE');
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.transactionId).toBeNull(); // a web entry has no transaction
    expect(res?.messages[0]?.message).toMatch(/nem gépi interfészen került a NAV-hoz – a NAV webes felületén rögzítették \(WEB\) –, és a kulcsadatai egyeznek/);
    expect(app.auditLog({ entityId: ours.invoice.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ match: 'similar', source: 'WEB' });
  });

  it('an attempt with an unknown outcome, looked up by its number: a report of another program with the same lines counts', async () => {
    let at = Date.now();
    let drop = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (drop && String(input).endsWith('/manageInvoice')) {
        drop = false; // the request never reached NAV
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return fetch(input, init);
    };
    nav.setNow(() => new Date(at)); // time passes for NAV too
    const app = open(undefined, { now: () => new Date(at), fetch: fetchImpl });
    const ours = await sale(app, DOMESTIC_CUSTOMER_INPUT, 'Szerviz', '12700');
    expect(ours.invoice.navStatus).toBe('pending');
    await reportByProgram({ ...ours.invoice, dueDate: '2099-12-31' });
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryTransactionList' });
    at += 6 * 60_000;
    const [res] = await app.navSync({ waitSeconds: 1 });
    expect(res?.navStatus).toBe('done');
    expect(res?.note).toMatch(/a NAV-nál a számla szerepel \(azonos kulcs- és tételadatokkal\), ezért nem küldtük újra/);
    expect(nav.requests.filter((q) => q.operation === 'manageInvoice')).toHaveLength(1); // only the other program's
  });

  it('the restored backup was taken before the invoice was sent: the re-send is byte for byte the same – done', async () => {
    let app = open();
    const a = await sale(app, PERSON_1, 'Női hajvágás', '8000', { submitToNav: false });
    const backup = join(app.config.dataDir, 'mentes.db');
    app.store.backup(backup);
    expect((await app.navSync({ waitSeconds: 3 }))[0]?.navStatus).toBe('done');
    app = restore(app, backup);
    expect(app.getInvoice(a.invoice.id).navStatus).toBe('pending');
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.messages[0]?.message).toMatch(/bájtra azonos/);
  });
});

describe('the fake NAV: an invoice entered through another channel (auditData source)', () => {
  it('queryInvoiceData gives its source and no transaction; every answer is schema-valid', async () => {
    const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
    expect((await nav.addInvoice(buildInvoiceDataXml(INVOICE_DOMESTIC), { source: 'WEB' })).invoiceStatus).toBe('DONE');
    const found = await client.queryInvoiceData(INVOICE_DOMESTIC.number as string);
    expect(found).toMatchObject({ status: 'found', compressed: false, audit: { source: 'WEB', transactionId: null, index: null } });
    expect(found.status === 'found' && found.invoiceData.toString('utf8')).toBe(buildInvoiceDataXml(INVOICE_DOMESTIC));
    // The number is taken: a report of it through the machine interface is a duplicate.
    const { transactionId } = await client.manageInvoice([{ index: 1, operation: 'CREATE', invoiceDataBase64: Buffer.from(buildInvoiceDataXml(INVOICE_DOMESTIC)).toString('base64') }]);
    expect((await client.queryTransactionStatus(transactionId)).results[0]?.messages.map((m) => m.code)).toContain('INVOICE_NUMBER_NOT_UNIQUE');
    const list = await client.queryTransactionList(new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
    expect(list.transactions.map((t) => [t.source, t.ownUser]).sort()).toEqual([['MGM', true], ['WEB', false]]);
    for (const r of nav.requests) expect((await validateNavXml(r.responseXml ?? '', 'api')).errors, `${r.operation} response`).toEqual([]);
  });
});

describe('navRecordDifferences: the line comparison', () => {
  const keysOf = (inv: Invoice): NavInvoiceKeys => parseInvoiceDataKeys(buildInvoiceDataXml(inv));
  const withLine = (keys: NavInvoiceKeys, i: number, patch: Partial<NavInvoiceKeys['lines'][number]>): NavInvoiceKeys => ({ ...keys, lines: keys.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });

  it('our own report matches from every source; other line texts match only when typed on the NAV web interface', () => {
    for (const source of ['MGM', 'WEB', 'XML', 'OSZ', 'OPG']) expect(navRecordDifferences(INVOICE_DOMESTIC, keysOf(INVOICE_DOMESTIC), source), source).toEqual([]);
    const otherTexts = keysOf({ ...INVOICE_DOMESTIC, lines: INVOICE_DOMESTIC.lines.map((l) => ({ ...l, description: `${l.description} (kézi)` })) });
    expect(navRecordDifferences(INVOICE_DOMESTIC, otherTexts, 'MGM')).toEqual(['1., 2. tétel megnevezése']);
    expect(navRecordDifferences(INVOICE_DOMESTIC, otherTexts, '')).toEqual(['1., 2. tétel megnevezése']); // unknown source: compared like MGM
    for (const source of ['WEB', 'web']) expect(navRecordDifferences(INVOICE_DOMESTIC, otherTexts, source), source).toEqual([]);
    for (const source of ['XML', 'OSZ', 'OPG']) expect(navRecordDifferences(INVOICE_DOMESTIC, otherTexts, source), source).toEqual(['1., 2. tétel megnevezése']);
  });

  it('each line field: description by its key, numbers as decimals, unit, net amount and VAT rate exactly', () => {
    const keys = keysOf(INVOICE_DOMESTIC);
    const mgm = (k: NavInvoiceKeys): string[] => navRecordDifferences(INVOICE_DOMESTIC, k, 'MGM');
    expect(mgm(withLine(keys, 0, { description: 'SZOFTVERFEJLESZTES  –  oktober' }))).toEqual([]);
    expect(mgm(withLine(keys, 0, { quantity: '10.000', netAmount: '150000.00', vatValue: '0.270' }))).toEqual([]);
    expect(mgm(withLine(keys, 1, { quantity: '3' }))).toEqual(['2. tétel mennyisége']);
    expect(mgm(withLine(keys, 0, { unit: 'OWN:óra' }))).toEqual(['1. tétel mennyiségi egysége']);
    expect(mgm(withLine(keys, 0, { netAmount: '149999' }))).toEqual(['1. tétel nettó összege']);
    expect(mgm(withLine(keys, 1, { vatValue: '0.18' }))).toEqual(['2. tétel ÁFA-kulcsa']);
    expect(mgm(withLine(keys, 1, { vatKind: 'vatExemption', vatValue: 'TAM' }))).toEqual(['2. tétel ÁFA-kulcsa']);
    expect(mgm({ ...keys, lines: keys.lines.slice(0, 1) })).toEqual(['tételek száma']);
    // A difference in the key data is reported as such (the lines are not listed then).
    expect(mgm({ ...withLine(keys, 0, { description: 'Más' }), issueDate: '2026-10-26' })).toEqual(['kelte']);
  });

  it('a private person: NAV has only the status, so a same-price sale of other goods differs only in its lines', () => {
    const otherSale = keysOf({ ...INVOICE_PRIVATE_AAM, customer: { ...INVOICE_PRIVATE_AAM.customer, name: 'Bárki' }, lines: INVOICE_PRIVATE_AAM.lines.map((l) => ({ ...l, description: 'Fonott kosár' })) });
    expect(navRecordDifferences(INVOICE_PRIVATE_AAM, otherSale, 'MGM')).toEqual(['1. tétel megnevezése']);
    expect(navRecordDifferences(INVOICE_PRIVATE_AAM, otherSale, 'WEB')).toEqual([]);
    expect(parseInvoiceDataKeys(buildInvoiceDataXml(INVOICE_PRIVATE_AAM)).lines[0]).toEqual({
      description: 'Kerámia bögre, kézzel festett',
      quantity: '2',
      unit: 'PIECE',
      netAmount: '24998',
      vatKind: 'vatExemption',
      vatValue: 'AAM',
    });
  });
});
