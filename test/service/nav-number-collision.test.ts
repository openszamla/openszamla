/**
 * NAV-1: a duplicate rejection (INVOICE_NUMBER_NOT_UNIQUE) is reconciled with what NAV holds under the number
 * (queryInvoiceData), not with the number alone. Another invoice's data under our number – after a restored
 * backup or from another invoicing program – is a number collision: the invoice stays aborted, is counted,
 * and its corrections are held back (NAV would attach them to the other invoice). A report entered by hand
 * with the same key data still reconciles. NAV-2 (duplicate side): a permanent NAV error of the check is a
 * configuration problem, never "try later".
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { NavClient } from '../../src/nav/client.ts';
import { buildInvoiceDataXml, navOperationFor } from '../../src/nav/invoice-data.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FAKE_NAV_SOFTWARE, FakeNavServer } from '../helpers/fake-nav.ts';

const OTHER_BUYER = {
  vatStatus: 'DOMESTIC' as const,
  name: 'Kovács Anna egyéni vállalkozó',
  taxNumber: '11223346-1-06',
  address: { countryCode: 'HU', postalCode: '6720', city: 'Szeged', addressLine: 'Kárász utca 5.' },
};
const NOT_UNIQUE = { severity: 'ERROR' as const, code: 'INVOICE_NUMBER_NOT_UNIQUE', message: 'A számlaszám már szerepel a rendszerben.' };

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

function open(dir?: string): OpenSzamla {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'openszamla-collision-'));
  if (!dir) dirs.push(dataDir);
  const config = loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: () => new Date() });
  apps.push(app);
  if (!app.getSeller()) app.updateSeller(SELLER_INPUT);
  return app;
}

async function issueTo(app: OpenSzamla, buyer: typeof DOMESTIC_CUSTOMER_INPUT, unitPrice: string, opts: { submitToNav?: boolean } = {}) {
  const customer = app.findCustomers({ taxNumber: buyer.taxNumber }).items[0] ?? app.saveCustomer(buyer).customer;
  const view = await app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
  expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return app.issue(view.invoice.id, opts);
}

/** Reports `inv` to the fake NAV directly – another program, another installation, or the NAV web form. */
async function reportElsewhere(inv: Invoice): Promise<void> {
  const client = new NavClient({ environment: 'test', baseUrl: nav.url, credentials: nav.credentials, software: FAKE_NAV_SOFTWARE });
  const { transactionId } = await client.manageInvoice([{ index: 1, operation: navOperationFor(inv), invoiceDataBase64: Buffer.from(buildInvoiceDataXml(inv), 'utf8').toString('base64') }]);
  expect((await client.queryTransactionStatus(transactionId)).results[0]?.invoiceStatus).toBe('DONE');
}

const codes = (inv: Invoice): string[] => inv.navMessages.map((m) => m.code);
const operations = (): string[] => nav.invoices.map((i) => `${i.operation} ${i.invoiceNumber} ${i.invoiceStatus}`);
const manageCalls = (): number => nav.requests.filter((r) => r.operation === 'manageInvoice').length;
const year = new Date().getFullYear();

describe('NAV-1: what NAV holds under the number decides, not the number alone', () => {
  it('restored backup: the number is issued again to another buyer – a number collision, not "reported"', async () => {
    const app = open();
    const dir = app.config.dataDir;
    expect((await issueTo(app, DOMESTIC_CUSTOMER_INPUT, '100000')).invoice.navStatus).toBe('done');
    const backup = join(dir, 'mentes.db');
    app.store.backup(backup);
    const lost = await issueTo(app, DOMESTIC_CUSTOMER_INPUT, '500000');
    expect(lost.invoice.navStatus).toBe('done');
    app.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${app.config.dbPath}${suffix}`)) rmSync(`${app.config.dbPath}${suffix}`);
    copyFileSync(backup, app.config.dbPath);

    const restored = open(dir);
    const again = await issueTo(restored, OTHER_BUYER, '2000000');
    expect(again.invoice.number).toBe(lost.invoice.number);
    expect(again.invoice.navStatus).toBe('aborted');
    expect(codes(again.invoice)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    const collision = again.invoice.navMessages[1]?.message ?? '';
    expect(collision).toMatch(/egy másik számláé/);
    expect(collision).toMatch(/vevő, nettó összeg \(HUF\), ÁFA \(HUF\), bruttó összeg \(HUF\)/);
    expect(collision).toMatch(/mentés visszaállítása|másik számlázó program/);
    expect(collision).toContain(`SZ-${year}-00003`); // the series' next number
    expect(again.nav?.note).toMatch(/Sorszám-ütközés/);
    expect(nav.requests.map((q) => q.operation)).toContain('queryInvoiceData');

    const status = restored.status();
    expect(status.counts).toMatchObject({ navPending: 0, navProblems: 1 });
    const steps = status.nextSteps.join('\n');
    expect(steps).toMatch(/1 számla sorszáma a NAV-nál egy másik számláé/);
    expect(steps).toContain(`SZ-${year}-00003`);
    expect(steps).not.toMatch(/ismétlésként utasította el/);

    // Its storno would land on the other buyer's invoice at NAV: it is held back.
    const storno = await restored.cancel(again.invoice.id, { reason: 'Téves sorszám' });
    expect(storno.invoice.navStatus).toBe('pending');
    expect(storno.nav?.note).toMatch(/sorszáma a NAV-nál egy másik számláé/);
    const before = manageCalls();
    await restored.navSync({ waitSeconds: 1 });
    expect(manageCalls()).toBe(before);
    expect(operations().filter((o) => o.startsWith('STORNO'))).toEqual([]);
    expect(restored.getInvoice(again.invoice.id).navStatus).toBe('aborted');
    expect(restored.status().nextSteps.join('\n')).toMatch(/1 módosító\/sztornó számla nem jelenthető/);
  });

  it('another program reported the number first: collision; the plain nav_sync leaves it alone afterwards', async () => {
    const app = open();
    const ours = await issueTo(app, OTHER_BUYER, '3000000', { submitToNav: false });
    // The previous invoicing program's SZ-…-00001: same seller, another buyer and amount.
    await reportElsewhere({ ...ours.invoice, customer: { ...DOMESTIC_CUSTOMER_INPUT }, lines: ours.invoice.lines.map((l) => ({ ...l, description: 'Régi program' })), totals: { ...ours.invoice.totals, netAmountHuf: '10000', vatAmountHuf: '2700', grossAmountHuf: '12700' } });
    const sync = await app.navSync({ waitSeconds: 3 });
    expect(sync[0]?.navStatus).toBe('aborted');
    expect(codes(app.getInvoice(ours.invoice.id))).toContain('OPENSZAMLA_NUMBER_COLLISION');
    expect(app.getInvoice(ours.invoice.id).navMessages.some((m) => m.code === 'OPENSZAMLA_RECONCILED')).toBe(false);
    const calls = nav.requests.length;
    expect(await app.navSync({ waitSeconds: 1 })).toEqual([]); // nothing a plain run can do about it
    expect(nav.requests.length).toBe(calls);
  });

  it('entered by hand on the NAV web interface (other details, same key data): reported, with a note; its modification goes out', async () => {
    const app = open();
    const ours = await issueTo(app, DOMESTIC_CUSTOMER_INPUT, '150000', { submitToNav: false });
    const byHand: Invoice = {
      ...ours.invoice,
      customer: { ...ours.invoice.customer, address: { ...ours.invoice.customer.address, addressLine: 'Fő tér 1/A.' } },
      lines: ours.invoice.lines.map((l) => ({ ...l, description: 'Tanácsadási szolgáltatás (kézi rögzítés)' })),
    };
    expect((await nav.addInvoice(buildInvoiceDataXml(byHand), { source: 'WEB' })).invoiceStatus).toBe('DONE');
    const res = (await app.navSync({ waitSeconds: 3 }))[0];
    expect(res?.navStatus).toBe('done');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_RECONCILED']);
    expect(res?.messages[0]?.message).toMatch(/kulcsadatai egyeznek/);
    expect(app.auditLog({ entityId: ours.invoice.id }).items.find((e) => e.action === 'nav.reconcile')?.details).toMatchObject({ via: 'queryInvoiceData', match: 'similar' });
    const corr = await app.createCorrectionDraft(ours.invoice.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-10000', vatCode: '27' }], comment: 'Engedmény' });
    expect((await app.issue(corr.invoice.id)).invoice.navStatus).toBe('done');
  });

  it('valid at NAV more than once (MULTIPLE_QUERY_RESULT_FOUND): stays aborted with the technical-annulment hint, never sent again', async () => {
    const app = open();
    const r = await issueTo(app, DOMESTIC_CUSTOMER_INPUT, '20000', { submitToNav: false });
    app.store.patchInvoice(r.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'MULTIPLE_QUERY_RESULT_FOUND', httpStatus: 500 }, { operation: 'queryInvoiceData', times: 10 });
    const res = (await app.navSync({ resubmitFailed: true, waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('aborted');
    expect(res?.messages.find((m) => m.code === 'OPENSZAMLA_HINT')?.message).toMatch(/többször is érvényes.*technikai érvénytelenítéssel/);
    expect(manageCalls()).toBe(0);
    expect(app.status().nextSteps.join('\n')).toMatch(/1 számla NAV-jelentését a NAV elutasította/);
  });

  it('the check answers FORBIDDEN: a configuration problem named in the note, the messages and the next steps; after the fix it is sent', async () => {
    const app = open();
    const r = await issueTo(app, DOMESTIC_CUSTOMER_INPUT, '30000', { submitToNav: false });
    app.store.patchInvoice(r.invoice.id, { navStatus: 'aborted', navMessages: [NOT_UNIQUE] });
    nav.failNext({ kind: 'GENERAL_ERROR', errorCode: 'FORBIDDEN', httpStatus: 403, message: 'Nincs jogosultság.' }, { operation: 'queryInvoiceData', times: 2 });
    const res = (await app.navSync({ waitSeconds: 1 }))[0];
    expect(res?.navStatus).toBe('aborted');
    expect(res?.note).toMatch(/nincs lekérdezési jogosultsága/);
    expect(res?.note).not.toMatch(/később/);
    expect(res?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'FORBIDDEN', 'OPENSZAMLA_RECONCILE_BLOCKED']);
    const steps = app.status().nextSteps.join('\n');
    expect(steps).toMatch(/1 számla NAV-jelentését a program nem tudja egyeztetni a NAV-val.*nincs lekérdezési jogosultsága/);
    expect(steps).not.toMatch(/ismétlésként utasította el/);
    // A plain run does not keep asking; the second fault is used by the explicit resubmission.
    expect(await app.navSync({ waitSeconds: 1 })).toEqual([]);
    const blocked = (await app.navSync({ resubmitFailed: true, waitSeconds: 1 }))[0];
    expect(blocked?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'FORBIDDEN', 'OPENSZAMLA_RECONCILE_BLOCKED']); // not piled up
    expect(manageCalls()).toBe(0);
    // Permission granted: NAV holds nothing under the number, so it is sent – once.
    const fixed = (await app.navSync({ resubmitFailed: true, waitSeconds: 3 }))[0];
    expect(fixed?.navStatus).toBe('done');
    expect(manageCalls()).toBe(1);
  });
});
