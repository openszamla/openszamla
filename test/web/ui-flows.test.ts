/**
 * Web form flows that go through the full service: createDraft / updateDraft / issue / cancel,
 * saveCustomer and updateSeller. These need src/core/calc.ts, validate.ts and numbering.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { navSetupCommandLine } from '../../src/service/config.ts';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { FakeNavServer } from '../helpers/fake-nav.ts';
import { flashesOf, hiddenValue, insertCustomer, startWeb, type Fields, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  return e;
}

const ft = (v: string): string => formatMoney(v, 'HUF');

function line(i: number, l: { description?: string; quantity?: string; unit?: string; unitPrice?: string; priceBasis?: string; vatCode?: string } = {}): Fields {
  return {
    [`lines[${i}].description`]: l.description ?? '',
    [`lines[${i}].quantity`]: l.quantity ?? '',
    [`lines[${i}].unit`]: l.unit ?? '',
    [`lines[${i}].unitPrice`]: l.unitPrice ?? '',
    [`lines[${i}].priceBasis`]: l.priceBasis ?? 'net',
    [`lines[${i}].vatCode`]: l.vatCode ?? '27',
    [`lines[${i}].productId`]: '',
  };
}

/** The draft form as a browser submits it (inline buyer = the test customer, 2 lines + 3 empty rows). */
function draftForm(overrides: Fields = {}): Fields {
  const a = DOMESTIC_CUSTOMER_INPUT.address;
  return {
    documentType: 'invoice',
    customerId: '',
    c_vatStatus: 'DOMESTIC',
    c_name: DOMESTIC_CUSTOMER_INPUT.name,
    c_taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber,
    c_euVatNumber: '',
    c_thirdStateTaxId: '',
    c_countryCode: a.countryCode,
    c_postalCode: a.postalCode,
    c_city: a.city,
    c_addressLine: a.addressLine,
    c_email: '',
    fulfillmentDate: '2026-10-27',
    dueDate: '',
    paymentMethod: 'TRANSFER',
    currency: 'HUF',
    exchangeRate: '',
    language: 'hu',
    orderNumber: 'PO-1',
    comment: 'Köszönjük a megrendelést!',
    internalNote: '',
    ...line(0, { description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }),
    ...line(1, { description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '2 000', vatCode: '5' }),
    ...line(2),
    ...line(3),
    ...line(4),
    ...overrides,
  };
}

describe('draft form: errors are shown with the entered values', () => {
  it('re-displays the form with a Hungarian error and the line number of the form', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    insertCustomer(e.app, { ...DOMESTIC_CUSTOMER_INPUT, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    await b.get('/invoices/new');
    const noBuyer = await b.post('/invoices/new', draftForm({ c_name: '', c_taxNumber: '', c_postalCode: '', c_city: '', c_addressLine: '' }));
    expect(noBuyer.status).toBe(422);
    expect(noBuyer.body).toContain('Hiányzik a vevő.');
    expect(noBuyer.body).toContain('value="Szoftverfejlesztés"');
    expect(noBuyer.body).toContain('value="PO-1"');
    const badQty = await b.post('/invoices/new', draftForm({ customerId: 'cus_00000000c1', ...line(0), ...line(3, { description: 'Hibás sor', quantity: 'sok', unitPrice: '10' }) }));
    expect(badQty.status).toBe(422);
    expect(badQty.body).toContain('4. tétel – mennyiség');
    expect(badQty.body).toContain('value="sok"');
    const incomplete = await b.post('/invoices/new', draftForm({ ...line(2, { description: 'Félkész sor' }) }));
    expect(incomplete.status).toBe(422);
    expect(incomplete.body).toContain('A(z) 3. tételből hiányzik a mennyiség.');
    const noLines = await b.post('/invoices/new', draftForm({ ...line(0), ...line(1) }));
    expect(noLines.status).toBe(422);
    expect(noLines.body).toContain('Adj meg legalább egy tételt');
    expect(noLines.body).toContain('name="lines[4].description"');
    expect(e.app.findInvoices({}).total).toBe(0);
  });
});

describe('form flows through the service (need src/core calc + validate + numbering)', () => {
  it('creates a draft, issues it only with the ticked box AND a valid confirmation bound to the content, then cancels it', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const b = await e.loggedIn();
    await b.get('/invoices/new');
    const created = await b.post('/invoices/new', draftForm({ saveCustomer: '1' }));
    expect(created.status, flashesOf(created.body)).toBe(303);
    const id = /^\/invoices\/(inv_[0-9a-f]+)$/.exec(created.headers.location ?? '')?.[1] ?? '';
    expect(id).not.toBe('');
    const draft = await b.follow(created);
    expect(draft.body).toContain('Piszkozat létrehozva');
    expect(draft.body).toContain(ft('194700'));
    expect(draft.body).toContain('name="confirm" type="checkbox" value="yes" required');
    const confirmation = hiddenValue(draft.body, 'confirmation') ?? '';
    expect(confirmation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const customer = e.app.findCustomers({}).items[0];
    expect(customer?.name).toBe(DOMESTIC_CUSTOMER_INPUT.name);

    let r = await b.follow(await b.post(`/invoices/${id}/issue`, { confirmation }));
    expect(r.body).toContain('A kiállításhoz jelöld be a megerősítő négyzetet.');
    r = await b.follow(await b.post(`/invoices/${id}/issue`, { confirmation: 'A'.repeat(43), confirm: 'yes' }));
    expect(r.body).toContain('A megerősítés lejárt, vagy a piszkozat időközben megváltozott.');
    const other = await e.loggedIn();
    const foreign = hiddenValue((await other.get(`/invoices/${id}`)).body, 'confirmation') ?? '';
    expect(foreign).not.toBe(confirmation);
    r = await b.follow(await b.post(`/invoices/${id}/issue`, { confirmation: foreign, confirm: 'yes' }));
    expect(r.body).toContain('A megerősítés lejárt, vagy a piszkozat időközben megváltozott.');
    expect(e.app.getInvoice(id).status).toBe('draft');

    // Editing the draft after the preview invalidates the earlier confirmation.
    const edit = await b.get(`/invoices/${id}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.body).toContain('value="Szoftverfejlesztés"');
    const saved = await b.post(`/invoices/${id}/edit`, draftForm({ customerId: customer?.id ?? '', ...line(0, { description: 'Szoftverfejlesztés', quantity: '11', unit: 'óra', unitPrice: '15000' }) }));
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    expect(e.app.getInvoice(id).lines[0]?.quantity).toBe('11');
    r = await b.follow(await b.post(`/invoices/${id}/issue`, { confirmation, confirm: 'yes' }));
    expect(r.body).toContain('A megerősítés lejárt, vagy a piszkozat időközben megváltozott.');
    expect(e.app.getInvoice(id).status).toBe('draft');

    const fresh = hiddenValue((await b.get(`/invoices/${id}`)).body, 'confirmation') ?? '';
    const issued = await b.post(`/invoices/${id}/issue`, { confirmation: fresh, confirm: 'yes' });
    expect(issued.status).toBe(303);
    const page = await b.follow(issued);
    expect(page.body).toContain('Kiállítva: SZ-2026-00001');
    // Not reported yet: a warning in web words, with the way to the NAV setup (no MCP tool names).
    expect(page.body).toContain('Ez a bizonylat még nincs jelentve a NAV-nak, mert nincs beállítva a NAV-kapcsolat');
    expect(page.body).toContain('<a href="/#guide-nav">NAV-kapcsolat beállítása</a>');
    expect(page.body).not.toContain('nav_sync');
    const inv = e.app.getInvoice(id);
    expect(inv.status).toBe('issued');
    expect(inv.number).toBe('SZ-2026-00001');
    expect(e.app.auditLog({ entityId: id }).items.some((a) => a.action === 'invoice.issue' && a.actor === 'web' && typeof a.details.confirmFingerprint === 'string')).toBe(true);
    const again = await b.follow(await b.post(`/invoices/${id}/issue`, { confirmation: fresh, confirm: 'yes' }));
    expect(again.body).toContain('már ki van állítva ezzel a megerősítéssel: SZ-2026-00001');
    expect(e.app.findInvoices({ status: ['issued'] }).total).toBe(1);
    expect((await b.get(`/invoices/${id}/edit`)).status).toBe(303);

    const preview = await b.post(`/invoices/${id}/cancel-preview`, { reason: 'Hibás mennyiség' });
    expect(preview.status).toBe(200);
    expect(preview.body).toContain('Sztornó előnézet');
    expect(preview.body).toContain('Hibás mennyiség');
    const cancelConfirmation = hiddenValue(preview.body, 'confirmation') ?? '';
    r = await b.follow(await b.post(`/invoices/${id}/cancel`, { reason: 'Más ok', confirmation: cancelConfirmation, confirm: 'yes' }));
    expect(r.body).toContain('A megerősítés lejárt vagy érvénytelen.');
    r = await b.follow(await b.post(`/invoices/${id}/cancel`, { reason: 'Hibás mennyiség', confirmation: cancelConfirmation }));
    expect(r.body).toContain('A sztornóhoz jelöld be a megerősítő négyzetet.');
    expect(e.app.getInvoice(id).status).toBe('issued');
    const cancelled = await b.post(`/invoices/${id}/cancel`, { reason: 'Hibás mennyiség', confirmation: cancelConfirmation, confirm: 'yes' });
    expect(cancelled.status).toBe(303);
    const storno = await b.follow(cancelled);
    expect(storno.body).toContain('Sztornó számla kiállítva: SZ-2026-00002 (eredeti: SZ-2026-00001).');
    expect(storno.body).toContain('Sztornó oka: Hibás mennyiség');
    expect(e.app.getInvoice(id).status).toBe('cancelled');
    const repeat = await b.follow(await b.post(`/invoices/${id}/cancel`, { reason: 'Hibás mennyiség', confirmation: cancelConfirmation, confirm: 'yes' }));
    expect(repeat.body).toContain('Már végrehajtva ezzel a megerősítéssel: SZ-2026-00002.');
  });

  it('the storno preview shows the amount of the storno: the original and its issued modifications, negated (MCP-UX-3)', async () => {
    const e = await env();
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const lines = [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];
    const orig = await e.app.issue((await e.app.createDraft({ customerId, lines })).invoice.id);
    const mod = await e.app.issue((await e.app.createCorrectionDraft(orig.invoice.id, { lines: [{ ...lines[0]!, description: 'Árengedmény', quantity: '1', unitPrice: '-5000' }] })).invoice.id);
    const b = await e.loggedIn();
    const preview = await b.post(`/invoices/${orig.invoice.id}/cancel-preview`, { reason: 'Hibás vevő' });
    expect(preview.status).toBe(200);
    // 190 500 Ft original, -6 350 Ft modification: the storno is -184 150 Ft, not the original's -190 500 Ft.
    expect(preview.body).toContain(`bruttó ${ft('-184150')}`);
    expect(preview.body).toContain(`${mod.invoice.number}: bruttó ${ft('-6350')}`);
    expect(preview.body).toContain('együttes ellentéte');
    const confirmation = hiddenValue(preview.body, 'confirmation') ?? '';
    const done = await b.follow(await b.post(`/invoices/${orig.invoice.id}/cancel`, { reason: 'Hibás vevő', confirmation, confirm: 'yes' }));
    expect(done.body).toContain('Sztornó számla kiállítva: SZ-2026-00003');
    const storno = e.app.findInvoices({ documentType: ['storno'] }).items[0];
    expect(storno?.totals.grossAmount).toBe('-184150');
  });

  it('creates and updates customers through the form; duplicates are refused with the hint', async () => {
    const e = await env();
    const b = await e.loggedIn();
    await b.get('/customers');
    const a = DOMESTIC_CUSTOMER_INPUT.address;
    const fields: Fields = {
      vatStatus: 'DOMESTIC', name: DOMESTIC_CUSTOMER_INPUT.name, taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber, euVatNumber: '', thirdStateTaxId: '',
      countryCode: a.countryCode, postalCode: a.postalCode, city: a.city, addressLine: a.addressLine, email: 'info@arvizturo.hu', phone: '', bankAccount: '', note: '',
    };
    const created = await b.post('/customers', fields);
    expect(created.status, flashesOf(created.body)).toBe(303);
    const page = await b.follow(created);
    expect(page.body).toContain(`Vevő mentve: ${DOMESTIC_CUSTOMER_INPUT.name}.`);
    const id = /\/customers\/(cus_[0-9a-f]+)$/.exec(created.headers.location ?? '')?.[1] ?? '';
    const dup = await b.post('/customers', fields);
    expect(dup.status).toBe(422);
    expect(dup.body).toContain('Már létezik vevő ezzel az adószámmal');
    expect(dup.body).toContain(`value="${'info@arvizturo.hu'}"`);
    const upd = await b.post(`/customers/${id}`, { ...fields, email: 'szamla@arvizturo.hu', note: 'Fontos partner', archived: '1' });
    expect(upd.status).toBe(303);
    expect(e.app.getCustomer(id)).toMatchObject({ email: 'szamla@arvizturo.hu', note: 'Fontos partner', archived: true });
    const badTax = await b.post('/customers', { ...fields, name: 'Másik Kft.', taxNumber: '12345678-1-11' });
    expect(badTax.status).toBe(422);
    expect(badTax.body).toContain('Érvénytelen vevői adószám');
  });

  it('saves the seller profile through the settings form and shows the remaining issues', async () => {
    const e = await env();
    const b = await e.loggedIn();
    await b.get('/settings');
    const a = SELLER_INPUT.address;
    const fields: Fields = {
      name: SELLER_INPUT.name, taxNumber: SELLER_INPUT.taxNumber, euVatNumber: SELLER_INPUT.euVatNumber, groupMemberTaxNumber: '', vatStatus: 'normal',
      countryCode: a.countryCode, postalCode: a.postalCode, city: a.city, addressLine: a.addressLine, bankAccount: SELLER_INPUT.bankAccount, bankName: '', swift: '',
      email: SELLER_INPUT.email, phone: '', website: '', registrationNumber: '', invoiceFooter: '',
    };
    const bad = await b.post('/settings/seller', { ...fields, taxNumber: '1234' });
    expect(bad.status, flashesOf(bad.body)).toBe(422);
    expect(bad.body).toContain('Érvénytelen adószám');
    expect(bad.body).toContain('value="1234"');
    const ok = await b.post('/settings/seller', fields);
    expect(ok.status).toBe(303);
    expect((await b.follow(ok)).body).toContain('Eladói adatok mentve');
    expect(e.app.getSeller()).toMatchObject({ name: SELLER_INPUT.name, taxNumber: SELLER_INPUT.taxNumber, cashAccounting: false });
    const dash = await b.get('/');
    expect(dash.body).toContain(SELLER_INPUT.name);
    expect(dash.body).not.toContain('Ez a rész most nem jeleníthető meg');
  });
});

describe('NAV through the web UI (fake NAV server)', () => {
  it('reports with the per-invoice and the dashboard NAV-sync buttons, and issuing reports right away', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    try {
      const e = await startWeb({ nav: nav.runtimeConfig(), now: () => new Date() });
      envs.push(e);
      e.app.updateSeller(SELLER_INPUT);
      const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
      const draft = async (): Promise<string> =>
        (await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] })).invoice.id;
      const first = (await e.app.issue(await draft(), { submitToNav: false })).invoice;
      const second = (await e.app.issue(await draft(), { submitToNav: false })).invoice;
      expect(first.navStatus).toBe('pending');
      const b = await e.loggedIn();

      const detail = await b.get(`/invoices/${first.id}`);
      expect(detail.body).toContain('<span class="pfx">NAV: </span>függő');
      expect(detail.body).toContain('Számla beküldése a NAV-nak</button>');
      const one = await b.follow(await b.post(`/invoices/${first.id}/nav-sync`, {}));
      // The test system is named (MCP-UX-5): nothing was reported for real.
      expect(one.body, flashesOf(one.body)).toContain('NAV-állapot: rendben. A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.');
      expect(e.app.getInvoice(first.id).navStatus).toBe('done');
      expect(one.body).toContain(e.app.getInvoice(first.id).navTransactionId ?? 'missing transaction id');

      const dash = await b.get('/');
      expect(dash.body).toContain('TESZT környezet');
      expect(dash.body).toContain('Függő számlák beküldése a NAV-nak</button>');
      const all = await b.follow(await b.post('/nav-sync', {}));
      expect(all.body, flashesOf(all.body)).toContain('1 számla feldolgozva, ebből 1 sikeresen jelentve a NAV TESZT rendszerébe (éles adatszolgáltatás NEM történt).');
      expect(e.app.getInvoice(second.id).navStatus).toBe('done');

      const third = await draft();
      const page = await b.get(`/invoices/${third}`);
      const issued = await b.follow(await b.post(`/invoices/${third}/issue`, { confirmation: hiddenValue(page.body, 'confirmation') ?? '', confirm: 'yes' }));
      expect(issued.body, flashesOf(issued.body)).toContain('NAV: rendben – A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.');
      expect(nav.invoices.map((i) => i.operation)).toEqual(['CREATE', 'CREATE', 'CREATE']);
      for (const s of [nav.credentials.password, nav.credentials.signingKey, nav.credentials.exchangeKey, nav.credentials.login]) {
        for (const r of [detail, one, dash, all, issued]) expect(r.body.includes(s)).toBe(false);
      }
    } finally {
      await nav.stop();
    }
  });

  it('a double click on "Függő számlák beküldése a NAV-nak" or on the per-invoice button reports an invoice once (BIZ-1)', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    try {
      const e = await startWeb({ nav: nav.runtimeConfig(), now: () => new Date() });
      envs.push(e);
      e.app.updateSeller(SELLER_INPUT);
      const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
      const issue = async (): Promise<string> => {
        const d = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
        return (await e.app.issue(d.invoice.id, { submitToNav: false })).invoice.id;
      };
      const first = await issue();
      const b = await e.loggedIn();
      const both = await Promise.all([b.post('/nav-sync', {}), b.post('/nav-sync', {})]);
      expect(both.map((r) => r.status)).toEqual([303, 303]);
      expect(e.app.getInvoice(first).navStatus).toBe('done');
      const second = await issue();
      const again = await Promise.all([b.post(`/invoices/${second}/nav-sync`, {}), b.post(`/invoices/${second}/nav-sync`, {})]);
      expect(again.map((r) => r.status)).toEqual([303, 303]);
      expect(e.app.getInvoice(second).navStatus).toBe('done');
      expect(nav.invoices.map((i) => `${i.operation} ${i.invoiceStatus}`)).toEqual(['CREATE DONE', 'CREATE DONE']);
    } finally {
      await nav.stop();
    }
  });

  it('unusable NAV settings: the dashboard names the problem and the exact setup command (BIZ-5, MCP-UX-10)', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    try {
      const config = nav.runtimeConfig();
      const e = await startWeb({ nav: { ...config, credentials: { ...config.credentials, exchangeKey: 'SHORT-KEY' } } });
      envs.push(e);
      const b = await e.loggedIn();
      const dash = await b.get('/');
      expect(dash.body).toContain('hibás beállítás');
      expect(dash.body).toContain('A NAV technikai felhasználó adatai hibásak: az XML cserekulcs nem 16 karakteres.');
      expect(dash.body).toContain(navSetupCommandLine(e.app.config.dataDir).replace(/"/g, '&quot;'));
      expect(dash.body).not.toContain('Függő számlák beküldése a NAV-nak</button>');
      expect(dash.body).not.toContain('SHORT-KEY');
    } finally {
      await nav.stop();
    }
  });

  it('a storno held up by a rejected original says why on its page (BIZ-2)', async () => {
    const nav = await FakeNavServer.start({ receivedPolls: 0 });
    try {
      const e = await startWeb({ nav: nav.runtimeConfig(), now: () => new Date() });
      envs.push(e);
      e.app.updateSeller(SELLER_INPUT);
      const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
      nav.addBusinessMessage(`SZ-${new Date().getFullYear()}-00001`, { result: 'ERROR', code: 'INCORRECT_TEST_DATA', message: 'Szándékos teszthiba' });
      const d = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
      const original = (await e.app.issue(d.invoice.id)).invoice;
      expect(original.navStatus).toBe('aborted');
      const storno = (await e.app.cancel(original.id, { reason: 'Téves számla' })).invoice;
      const b = await e.loggedIn();
      const page = await b.get(`/invoices/${storno.id}`);
      expect(page.body).toContain(`Ez a sztornó számla az eredeti számlára vár: a(z) ${original.number} NAV-jelentését a NAV elutasította, vagy hibával zárult.`);
      expect(page.body).toContain(`<a href="/invoices/${original.id}">Az eredeti számla (${original.number}) megnyitása</a>`);
      // Its own button could not send it: there is none.
      expect(page.body).not.toContain(`action="/invoices/${storno.id}/nav-sync"`);
      const sync = await b.follow(await b.post(`/invoices/${storno.id}/nav-sync`, {}));
      expect(sync.body, flashesOf(sync.body)).toContain('NAV-állapot: függő. Ez a sztornó számla az eredeti számlára vár');
      const dash = await b.get('/');
      expect(dash.body).toContain('1 módosító/sztornó számla nem jelenthető');
      expect(nav.invoices.map((i) => i.operation)).toEqual(['CREATE']);
    } finally {
      await nav.stop();
    }
  });
});
