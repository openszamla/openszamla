/**
 * WEB-4: masking a secret on a page must never feed back into stored data. A form control whose value
 * contains the access token (or a NAV credential) is shown masked but disabled – the browser leaves it
 * out of the submit – with a visible note, and saving the edit form keeps the stored value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type RunningHttpServer } from '../../src/mcp/http.ts';
import { containsSecret, REDACTED, redactSecrets, secretList } from '../../src/web/security.ts';
import { makeTestApp, SELLER_INPUT, type TestApp } from '../helpers/app.ts';
import { Browser, flashesOf, formFields, type Res } from './helpers.ts';

/** A token the owner chose that also occurs in the seller's (and others') data. */
const T = 'kovacsbt-szamlazo-2026-webkulcs';
const NOTE = 'A mező értéke a hozzáférési tokent vagy egy NAV-hitelesítő adatot tartalmaz, ezért rejtve jelenik meg';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function start(): Promise<{ t: TestApp; http: RunningHttpServer; b: Browser }> {
  const t = makeTestApp();
  const http = await startHttpServer(t.app, { port: 0, token: T });
  cleanups.push(async () => {
    await http.close();
    t.cleanup();
  });
  const b = new Browser(http.url);
  const login = await b.get(`/?token=${encodeURIComponent(T)}`);
  expect(login.status).toBe(303);
  return { t, http, b };
}

function expectNoToken(r: Res): void {
  expect(r.body.includes(T), 'the token is on the page').toBe(false);
}

/** The opening tag of the form control named `name`. */
function controlTag(body: string, name: string): string {
  const tag = new RegExp(`<(?:input|textarea|select)\\b[^>]*\\sname="${name.replace(/[[\]]/g, '\\$&')}"[^>]*>`).exec(body)?.[0];
  if (!tag) throw new Error(`no control named ${name}`);
  return tag;
}

describe('a form control whose value contains a secret is shown masked, disabled and with a note', () => {
  const secrets = secretList([T]);

  it('input, textarea and option: masked for display, left out of the submit; links and text only masked', () => {
    const page = `<form><input name="email" value="info@${T}.hu"><textarea name="note">jegyzet: ${T}</textarea><select name="s"><option value="a">A</option><option value="x${T}" selected>${T}</option></select><input name="other" value="semmi"></form><a href="/customers?q=${T}">${T}</a>`;
    const out = redactSecrets(page, secrets);
    expect(out).not.toContain(T);
    expect(out).toContain(`<input name="email" value="info@${REDACTED}.hu" disabled><span class="withheld" role="note">`);
    expect(out).toContain(`<textarea name="note" disabled>jegyzet: ${REDACTED}</textarea><span class="withheld" role="note">`);
    expect(out).toContain(`<option value="x${REDACTED}" selected disabled>${REDACTED}</option></select><span class="withheld" role="note">`);
    expect(out).toContain('<input name="other" value="semmi">');
    expect(out).toContain(`<a href="/customers?q=${REDACTED}">${REDACTED}</a>`);
    expect(out.match(/class="withheld"/g)).toHaveLength(3);
  });

  it('containsSecret is the same test the page masking applies', () => {
    expect(containsSecret(`info@${T}.hu`, secrets)).toBe(true);
    expect(containsSecret('info@kovacsbt.hu', secrets)).toBe(false);
    expect(containsSecret('', secrets)).toBe(false);
    expect(containsSecret(`x ${T}`, [])).toBe(false);
  });
});

describe('saving an edit form keeps a stored value the page could not show', () => {
  it('settings: the seller e-mail and web site stay when only the bank name is changed (and new invoices carry them)', async () => {
    const { t, b } = await start();
    t.app.updateSeller({ ...SELLER_INPUT, email: `${T}@kovacsbt.hu`, website: `https://kovacsbt.hu/${T}` });
    const page = await b.get('/settings');
    expect(page.status).toBe(200);
    expectNoToken(page);
    expect(controlTag(page.body, 'email')).toContain(`value="${REDACTED}@kovacsbt.hu"`);
    expect(controlTag(page.body, 'email')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'website')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'bankName')).not.toContain('disabled');
    expect(page.body).toContain(NOTE);

    const fields = formFields(page.body, '/settings/seller');
    expect(fields.email).toBeUndefined();
    expect(fields.website).toBeUndefined();
    const saved = await b.post('/settings/seller', { ...fields, bankName: 'OTP Bank' });
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    const seller = t.app.getSeller();
    expect(seller?.email).toBe(`${T}@kovacsbt.hu`);
    expect(seller?.website).toBe(`https://kovacsbt.hu/${T}`);
    expect(seller?.bankName).toBe('OTP Bank');
    expect(JSON.stringify(seller)).not.toContain(REDACTED);
  });

  it('customer: the e-mail and the note stay when only the phone number is changed', async () => {
    const { t, b } = await start();
    t.app.updateSeller(SELLER_INPUT);
    const { customer } = t.app.saveCustomer({
      vatStatus: 'DOMESTIC',
      name: 'Árvíztűrő Tükörfúrógép Zrt.',
      taxNumber: '87654323-2-13',
      address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
      email: `beszerzes@${T}.hu`,
      note: `Kapcsolat: ${T}`,
    });
    const action = `/customers/${customer.id}`;
    const page = await b.get(action);
    expect(page.status).toBe(200);
    expectNoToken(page);
    expect(controlTag(page.body, 'email')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'note')).toMatch(/\sdisabled>$/);

    const fields = formFields(page.body, action);
    expect(fields.email).toBeUndefined();
    const saved = await b.post(action, { ...fields, phone: '+36 1 234 5678' });
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    const after = t.app.getCustomer(customer.id);
    expect(after.email).toBe(`beszerzes@${T}.hu`);
    expect(after.note).toBe(`Kapcsolat: ${T}`);
    expect(after.phone).toBe('+36 1 234 5678');
  });

  it('product: the name and the description stay when only the price is changed', async () => {
    const { t, b } = await start();
    t.app.updateSeller(SELLER_INPUT);
    const p = t.app.saveProduct({ name: `Licenc (${T})`, unit: 'db', unitPrice: '10000', vatCode: '27', description: `Telepítés: ${T}` });
    const action = `/products/${p.id}`;
    const page = await b.get(action);
    expect(page.status).toBe(200);
    expectNoToken(page);
    expect(controlTag(page.body, 'name')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'description')).toMatch(/\sdisabled>$/);

    const saved = await b.post(action, { ...formFields(page.body, action), unitPrice: '12000' });
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    const after = t.app.getProduct(p.id);
    expect(after.name).toBe(`Licenc (${T})`);
    expect(after.description).toBe(`Telepítés: ${T}`);
    expect(after.unitPrice).toBe('12000');
  });

  it('draft: a line description, the inline buyer e-mail and the comment stay when only the order number is changed', async () => {
    const { t, b } = await start();
    t.app.updateSeller(SELLER_INPUT);
    const view = await t.app.createDraft({
      customer: {
        vatStatus: 'DOMESTIC',
        name: 'Árvíztűrő Tükörfúrógép Zrt.',
        taxNumber: '87654323-2-13',
        address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
        email: `szamla@${T}.hu`,
      },
      comment: `Hivatkozás: ${T}`,
      lines: [
        { description: `Üzemeltetés – ${T}`, quantity: '1', unit: 'hó', unitPrice: '50000', vatCode: '27' },
        { description: 'Szakkönyv', quantity: '2', unit: 'db', unitPrice: '2000', vatCode: '5' },
      ],
    });
    const id = view.invoice.id;
    const action = `/invoices/${id}/edit`;
    const page = await b.get(action);
    expect(page.status).toBe(200);
    expectNoToken(page);
    expect(controlTag(page.body, 'lines[0].description')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'lines[1].description')).not.toContain('disabled');
    expect(controlTag(page.body, 'c_email')).toMatch(/\sdisabled>$/);
    expect(controlTag(page.body, 'comment')).toMatch(/\sdisabled>$/);

    const before = t.app.getInvoice(id);
    const saved = await b.post(action, { ...formFields(page.body, action), orderNumber: 'PO-77' });
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    const after = t.app.getInvoice(id);
    expect(after.orderNumber).toBe('PO-77');
    expect(after.comment).toBe(`Hivatkozás: ${T}`);
    expect(after.customer.email).toBe(`szamla@${T}.hu`);
    expect(after.lines.map((l) => [l.description, l.quantity, l.unit, l.unitPrice, l.vatCode, l.nature])).toEqual(
      before.lines.map((l) => [l.description, l.quantity, l.unit, l.unitPrice, l.vatCode, l.nature]),
    );
    expect(JSON.stringify(after)).not.toContain(REDACTED);
  });
});

describe('a typed value with a secret in a form shown again after an error', () => {
  const NOT_SHOWN = 'Egy beírt érték a hozzáférési tokent vagy egy NAV-hitelesítő adatot tartalmaz, ezért az űrlapon nem jeleníthető meg újra.';

  it('edit form: the field shows its stored value again (not masked and withheld), so the next save cannot lose it', async () => {
    const { t, b } = await start();
    t.app.updateSeller(SELLER_INPUT);
    const { customer } = t.app.saveCustomer({
      vatStatus: 'DOMESTIC',
      name: 'Árvíztűrő Tükörfúrógép Zrt.',
      taxNumber: '87654323-2-13',
      address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
      email: 'regi@arvizturo.hu',
    });
    const action = `/customers/${customer.id}`;
    const fields = formFields((await b.get(action)).body, action);
    const failed = await b.post(action, { ...fields, email: `uj@${T}.hu`, taxNumber: '1234' });
    expect(failed.status).toBe(422);
    expectNoToken(failed);
    expect(failed.body).toContain(NOT_SHOWN);
    expect(controlTag(failed.body, 'email')).toContain('value="regi@arvizturo.hu"');
    expect(controlTag(failed.body, 'email')).not.toContain('disabled');
    expect(controlTag(failed.body, 'taxNumber')).toContain('value="1234"');

    const saved = await b.post(action, { ...formFields(failed.body, action), taxNumber: '87654323-2-13', phone: '+36 1 111 2222' });
    expect(saved.status, flashesOf(saved.body)).toBe(303);
    expect(t.app.getCustomer(customer.id)).toMatchObject({ email: 'regi@arvizturo.hu', phone: '+36 1 111 2222' });
  });

  it('new record: the field is shown empty with the same warning', async () => {
    const { t, b } = await start();
    t.app.updateSeller(SELLER_INPUT);
    const fields = formFields((await b.get('/customers')).body, '/customers');
    const failed = await b.post('/customers', {
      ...fields, vatStatus: 'DOMESTIC', name: 'Új Vevő Kft.', taxNumber: '1234', postalCode: '1111', city: 'Budapest', addressLine: 'Fő utca 1.', email: `info@${T}.hu`,
    });
    expect(failed.status).toBe(422);
    expectNoToken(failed);
    expect(failed.body).toContain(NOT_SHOWN);
    const email = controlTag(failed.body, 'email');
    expect(email).toContain('value=""');
    expect(email).not.toContain('disabled');
    expect(controlTag(failed.body, 'name')).toContain('value="Új Vevő Kft."');
  });
});
