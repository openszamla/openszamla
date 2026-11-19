/**
 * NS2: only a report typed by hand on the NAV web interface (auditData source WEB – the outage procedure of
 * docs/nav-beallitas.md 5.) is matched on its key data alone. A report made in NAV's own online invoicing program
 * (OSZ), by an online cash register (OPG) or uploaded as an XML file (XML) was made by a program, like one sent
 * through the machine interface (MGM): it is this invoice only when its lines agree too. A sale of other goods at the
 * same price to another private person under our number is a number collision from each of them – our sale is not
 * reported –, while our own data uploaded by hand still match, because their lines are ours.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import type { CustomerInput } from '../../src/service/inputs.ts';
import { navManualSource, navOtherChannel } from '../../src/service/nav-match.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer, type FakeNavSource } from '../helpers/fake-nav.ts';

const PERSON: CustomerInput = { vatStatus: 'PRIVATE_PERSON', name: 'Kiss Erzsébet', address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 9.' } };

/** How the messages name each channel. */
const CHANNEL: Record<'XML' | 'OSZ' | 'OPG', string> = {
  XML: 'kézi XML-feltöltéssel került a NAV-hoz (XML)',
  OSZ: 'a NAV Online Számlázó programjában állították ki (OSZ)',
  OPG: 'online pénztárgépről érkezett (OPG)',
};

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

function open(): OpenSzamla {
  const dataDir = mkdtempSync(join(tmpdir(), 'openszamla-channels-'));
  dirs.push(dataDir);
  const config = loadConfig({ dataDir, env: {}, overrides: { nav: nav.runtimeConfig(), confirmMode: 'code', navWaitSeconds: 3 } });
  const app = OpenSzamla.open({ config, now: () => new Date() });
  apps.push(app);
  app.updateSeller(SELLER_INPUT);
  return app;
}

/** One cash sale of one line at a gross price, not sent to NAV yet. */
async function sale(app: OpenSzamla, customer: CustomerInput, description: string, gross: string): Promise<Invoice> {
  const view = await app.createDraft({ customer, paymentMethod: 'CASH', lines: [{ description, quantity: '1', unit: 'db', unitPrice: gross, priceBasis: 'gross', vatCode: '27' }] });
  expect(view.issues.filter((i) => i.severity === 'error')).toEqual([]);
  return (await app.issue(view.invoice.id, { submitToNav: false })).invoice;
}

const reconcileAudit = (app: OpenSzamla, inv: Invoice): Record<string, unknown> | undefined => app.auditLog({ entityId: inv.id }).items.find((e) => e.action === 'nav.reconcile')?.details;
const heldAtNav = (number: string | null): string[] => nav.invoices.filter((r) => r.invoiceNumber === number && r.invoiceStatus === 'DONE').map((r) => /<lineDescription>([^<]*)</.exec(r.xml)?.[1] ?? '');

describe('the channels of a report (auditData source)', () => {
  it('only WEB is matched on its key data alone; XML, OSZ, OPG and MGM are not typed by hand', () => {
    expect(['WEB', 'web', ' Web '].map(navManualSource)).toEqual([true, true, true]);
    expect(['XML', 'OSZ', 'OPG', 'MGM', ''].map(navManualSource)).toEqual([false, false, false, false, false]);
    expect(['WEB', 'XML', 'osz', 'OPG'].map(navOtherChannel)).toEqual([true, true, true, true]);
    expect(['MGM', '', 'ABC'].map(navOtherChannel)).toEqual([false, false, false]);
  });
});

describe.each(['OSZ', 'OPG', 'XML', 'MGM'] as const)('a report from %s under our number', (source: Exclude<FakeNavSource, 'WEB'>) => {
  it('another private person, other goods, the same price: a number collision – our sale is not "reported"', async () => {
    const app = open();
    const ours = await sale(app, PERSON, 'Férfi hajvágás és szakálligazítás', '8000');
    const other = { ...ours, lines: ours.lines.map((l) => ({ ...l, description: 'Női hajvágás' })) };
    expect((await nav.addInvoice(buildInvoiceDataXml(other), { source })).invoiceStatus).toBe('DONE');

    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('aborted');
    expect(res?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_NUMBER_COLLISION']);
    expect(res?.messages[1]?.message).toContain('az ezzel a sorszámmal ott tárolt számla adatai eltérnek ettől a számlától (1. tétel megnevezése)');
    expect(reconcileAudit(app, ours)).toMatchObject({ match: 'other', differences: ['1. tétel megnevezése'] });
    expect(heldAtNav(ours.number)).toEqual(['Női hajvágás']);
    expect(app.status().counts).toMatchObject({ navProblems: 1, navPending: 0 });
  });

  it('our lines with other details (due date, address): reconciled as done, naming the channel', async () => {
    const app = open();
    const ours = await sale(app, DOMESTIC_CUSTOMER_INPUT, 'Szerviz', '12700');
    const uploaded = { ...ours, dueDate: '2099-12-31', customer: { ...ours.customer, address: { ...ours.customer.address, addressLine: 'Fő tér 1/A.' } } };
    expect((await nav.addInvoice(buildInvoiceDataXml(uploaded), { source })).invoiceStatus).toBe('DONE');

    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.messages.map((m) => m.code)).toEqual(['OPENSZAMLA_RECONCILED']);
    expect(reconcileAudit(app, ours)).toMatchObject({ match: 'similar', source });
    if (source === 'MGM') {
      expect(res?.messages[0]?.message).toMatch(/gépi interfészen \(MGM\) érkezett.*tételei.*is egyeznek/);
    } else {
      expect(res?.messages[0]?.message).toContain(`nem gépi interfészen került a NAV-hoz – ${CHANNEL[source]} –, és nem bájtra azonos egyik itt nyilvántartott beküldéssel sem, de a kulcsadatai`);
      expect(res?.messages[0]?.message).toMatch(/és a tételei \(tételenként a megnevezés, .*\) is egyeznek ezzel a számlával, ezért a számla jelentve van\./);
    }
  });
});

describe('our own invoice uploaded by hand as an XML file (XML)', () => {
  it('matches on its lines; a later check of the duplicate names the channel in its note', async () => {
    const app = open();
    const ours = await sale(app, DOMESTIC_CUSTOMER_INPUT, 'Nyomtatópatron', '50000');
    expect((await nav.addInvoice(buildInvoiceDataXml({ ...ours, dueDate: '2099-12-31' }), { source: 'XML' })).invoiceStatus).toBe('DONE');
    nav.failNext({ kind: 'MAINTENANCE' }, { operation: 'queryInvoiceData' });
    const [first] = await app.navSync({ waitSeconds: 3 });
    expect(first?.navStatus).toBe('aborted');
    expect(first?.messages.map((m) => m.code)).toEqual(['INVOICE_NUMBER_NOT_UNIQUE', 'OPENSZAMLA_RECONCILE_RETRY']);

    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.note).toBe(`A NAV-nál ellenőrizve: ezzel a sorszámmal azonos kulcs- és tételadatú számla szerepel – ${CHANNEL.XML} –, tehát jelentve van – lásd az üzenetet.`);
    expect(reconcileAudit(app, ours)).toMatchObject({ match: 'similar', source: 'XML' });
  });
});

describe('a report typed by hand on the NAV web interface (WEB)', () => {
  it('with other line texts and units: still reported on its key data', async () => {
    const app = open();
    const ours = await sale(app, PERSON, 'Férfi hajvágás', '8000');
    const byHand = { ...ours, lines: ours.lines.map((l) => ({ ...l, description: 'Hajvágás (kézi rögzítés)', unit: 'alkalom' })) };
    expect((await nav.addInvoice(buildInvoiceDataXml(byHand), { source: 'WEB' })).invoiceStatus).toBe('DONE');
    const [res] = await app.navSync({ waitSeconds: 3 });
    expect(res?.navStatus).toBe('done');
    expect(res?.messages[0]?.message).toMatch(/nem gépi interfészen került a NAV-hoz – a NAV webes felületén rögzítették \(WEB\) –, és a kulcsadatai egyeznek/);
    expect(reconcileAudit(app, ours)).toMatchObject({ match: 'similar', source: 'WEB' });
  });
});
