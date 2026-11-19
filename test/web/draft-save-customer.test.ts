/**
 * Web "Új számla" with "Mentés a vevők közé is": a rejected save stores no buyer, and the corrected form
 * then saves the buyer and the draft once (WEB-2). A draft whose buyer changed in the customer list since
 * it was saved says so, and shows the data issuing will use (MCP-1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, startWeb, type Fields, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

function draftForm(unitPrice: string): Fields {
  const a = DOMESTIC_CUSTOMER_INPUT.address;
  const blank = (i: number): Fields => ({
    [`lines[${i}].description`]: '', [`lines[${i}].quantity`]: '', [`lines[${i}].unit`]: '', [`lines[${i}].unitPrice`]: '', [`lines[${i}].priceBasis`]: 'net', [`lines[${i}].vatCode`]: '27', [`lines[${i}].productId`]: '',
  });
  return {
    documentType: 'invoice', customerId: '', saveCustomer: '1',
    c_vatStatus: 'DOMESTIC', c_name: DOMESTIC_CUSTOMER_INPUT.name, c_taxNumber: DOMESTIC_CUSTOMER_INPUT.taxNumber, c_euVatNumber: '', c_thirdStateTaxId: '',
    c_countryCode: a.countryCode, c_postalCode: a.postalCode, c_city: a.city, c_addressLine: a.addressLine, c_email: '',
    fulfillmentDate: '2026-10-27', dueDate: '', paymentMethod: 'TRANSFER', currency: 'HUF', exchangeRate: '', language: 'hu', orderNumber: '', comment: '', internalNote: '',
    ...blank(0),
    'lines[0].description': 'Szoftverfejlesztés', 'lines[0].quantity': '10', 'lines[0].unit': 'óra', 'lines[0].unitPrice': unitPrice,
    ...blank(1), ...blank(2),
  };
}

describe('new draft with "Mentés a vevők közé is" (WEB-2)', () => {
  it('a rejected save stores no buyer; the corrected form saves the buyer and the draft once', async () => {
    const e = await env();
    const b = await e.loggedIn();
    await b.get('/invoices/new');
    // Two decimal commas: not a number ("1.234,5" is one now – the Hungarian way of writing 1234.5).
    const bad = await b.post('/invoices/new', draftForm('1,234,5'));
    expect(bad.status).toBe(422);
    expect(bad.body).toContain('1. tétel – egységár');
    expect(e.app.findCustomers({}).total).toBe(0);
    expect(e.app.auditLog({ limit: 50 }).items.map((x) => x.action)).not.toContain('customer.create');

    const good = await b.post('/invoices/new', draftForm('1234,5'));
    expect(good.status, flashesOf(good.body)).toBe(303);
    const customers = e.app.findCustomers({}).items;
    expect(customers.map((c) => c.taxNumber)).toEqual([DOMESTIC_CUSTOMER_INPUT.taxNumber]);
    const drafts = e.app.findInvoices({ status: ['draft'] }).items;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.customerId).toBe(customers[0]?.id);
  });
});

describe('a draft whose buyer changed in the customer list (MCP-1)', () => {
  it('shows the current buyer and a note on the draft page', async () => {
    const e = await env();
    const customer = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const d = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Szoftverfejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
    const b = await e.loggedIn();
    expect((await b.get(`/invoices/${d.invoice.id}`)).body).not.toContain('A vevő adatai a piszkozat mentése óta megváltoztak.');
    e.app.saveCustomer({ id: customer.id, address: { ...DOMESTIC_CUSTOMER_INPUT.address, addressLine: 'Duna korzó 5.' } });
    const page = await b.get(`/invoices/${d.invoice.id}`);
    expect(page.body).toContain('A vevő adatai a piszkozat mentése óta megváltoztak.');
    expect(page.body).toContain('Duna korzó 5.');
  });
});
