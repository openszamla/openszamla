/**
 * WEB-13: the web UI shows advice a web user can follow, where the service message (kept unchanged for
 * MCP and the CLI) points to MCP tools, MCP parameters or CLI commands.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type Fields, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  return e;
}

/** The new-draft form as a browser would submit it, with an inline buyer and one line. */
async function newDraftFields(b: Awaited<ReturnType<WebEnv['loggedIn']>>, extra: Fields = {}): Promise<Fields> {
  const page = await b.get('/invoices/new');
  expect(page.status).toBe(200);
  const a = DOMESTIC_CUSTOMER_INPUT.address;
  return {
    ...formFields(page.body, '/invoices/new'),
    c_vatStatus: 'DOMESTIC',
    c_name: DOMESTIC_CUSTOMER_INPUT.name,
    c_taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber,
    c_postalCode: a.postalCode,
    c_city: a.city,
    c_addressLine: a.addressLine,
    'lines[0].description': 'Oktatás',
    'lines[0].quantity': '1',
    'lines[0].unit': 'alkalom',
    'lines[0].unitPrice': '40000',
    'lines[0].vatCode': '27',
    ...extra,
  };
}

describe('web hints for service messages written for MCP and the CLI', () => {
  it('no seller yet: the error links to Beállítások instead of naming seller_update / openszamla init', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const r = await b.post('/invoices/new', await newDraftFields(b));
    expect(r.status).toBe(422);
    expect(flashesOf(r.body)).toContain('Az eladó (saját cég) adatai még nincsenek beállítva.');
    expect(r.body).toContain('a Beállítások oldalon');
    expect(r.body).toContain('<a href="/settings">Beállítások megnyitása</a>');
    expect(r.body).not.toContain('seller_update');
    expect(r.body).not.toContain('openszamla init');
  });

  it('a buyer that already exists: "válaszd ki a vevőt a listából", on the customer list and in the draft form', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT);
    const b = await e.loggedIn();
    const list = await b.get('/customers');
    const a = DOMESTIC_CUSTOMER_INPUT.address;
    const dup = await b.post('/customers', {
      ...formFields(list.body, '/customers'),
      vatStatus: 'DOMESTIC', name: 'Másik név Zrt.', taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber, postalCode: a.postalCode, city: a.city, addressLine: a.addressLine,
    });
    expect(dup.status).toBe(422);
    expect(flashesOf(dup.body)).toContain('Már létezik vevő ezzel az adószámmal');
    expect(dup.body).toContain('válaszd ki a vevőt a listából');
    expect(dup.body).not.toContain('(customerId)');

    const draft = await b.post('/invoices/new', await newDraftFields(b, { saveCustomer: '1' }));
    expect(draft.status).toBe(422);
    expect(draft.body).toContain('válaszd ki a vevőt a listából');
    expect(draft.body).not.toContain('(customerId)');
  });

  it('a TAM line without the exact legal basis: the draft page says the AI assistant can add it', async () => {
    const e = await env();
    e.app.store.setSetting('seller', SELLER_NORMAL);
    const view = await e.app.createDraft({
      customer: DOMESTIC_CUSTOMER_INPUT,
      lines: [{ description: 'Oktatás', quantity: '1', unit: 'alkalom', unitPrice: '40000', vatCode: 'TAM' }],
    });
    const issue = view.issues.find((i) => i.code === 'LINE_EXEMPTION_REFERENCE_RECOMMENDED');
    expect(issue?.message).toMatch(/add meg a tételnél a mentesség pontos jogszabályhelyét/);
    const b = await e.loggedIn();
    const page = await b.get(`/invoices/${view.invoice.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('A webes űrlapon ehhez nincs mező: a pontos jogszabályhelyet az AI-asszisztens írhatja be');
    expect(page.body).not.toContain('vatReason');
    expect(page.body).not.toContain('invoice_draft');
    // Still a warning only: the draft can be issued from the web.
    expect(page.body).toContain('action="/invoices/');
    expect(page.body).toContain('/issue"');
  });
});
