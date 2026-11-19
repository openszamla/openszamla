/**
 * BUYER_DIFFERS_FROM_RECORD on the web draft page (N6): the service message names the MCP way to switch
 * the draft to the record's data; the page adds the web way – saving the draft on the edit page gives it the
 * data of the buyer selected from the customer list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[\s ]+/g, ' ');

describe('a draft whose buyer data differ from its customer record, on the web (N6)', () => {
  it('shows the warning with the web way, and saving the draft on the edit page switches it to the record', async () => {
    const e = await startWeb();
    envs.push(e);
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await e.app.createDraft({
      customer: { ...DOMESTIC_CUSTOMER_INPUT, id: customerId, address: { ...DOMESTIC_CUSTOMER_INPUT.address, addressLine: 'Telephely, Ipari út 5.' } },
      lines: [{ description: 'Oktatás', quantity: '1', unit: 'alkalom', unitPrice: '40000', vatCode: '27' }],
    });
    const b = await e.loggedIn();
    const page = text((await b.get(`/invoices/${d.invoice.id}`)).body);
    expect(page).toContain('A piszkozat a saját vevőadatait tartja meg, és ezek eltérnek a vevők között tárolt adatoktól (eltér: cím)');
    expect(page).toContain('A webes felületen: a Piszkozat szerkesztése oldalon mentve a piszkozat a vevőlistában kiválasztott vevő tárolt adatait kapja.');

    const edit = await b.get(`/invoices/${d.invoice.id}/edit`);
    expect(edit.status).toBe(200);
    const saved = await b.post(`/invoices/${d.invoice.id}/edit`, formFields(edit.body, `/invoices/${d.invoice.id}/edit`));
    expect(saved.status).toBe(303);
    const after = e.app.getInvoice(d.invoice.id);
    expect(after.customerFromRecord).toBe(true);
    expect(after.customer.address.addressLine).toBe(DOMESTIC_CUSTOMER_INPUT.address.addressLine);
    expect(text((await b.get(`/invoices/${d.invoice.id}`)).body)).not.toContain('eltérnek a vevők között tárolt adatoktól');
  });
});
