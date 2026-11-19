/**
 * The web forms accept their own pre-filled numbers. A stored quantity of 2.125, a unit price of 615.943 or a manual
 * exchange rate of 395.125 used to be pre-filled with a decimal point – the "one dot, three digits" form the forms
 * refuse as ambiguous (numberInput) – so such a draft or product could not be saved again from its own form, and the
 * product picker filled in a price the form then refused. Stored numbers are now shown with a decimal comma.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { numberInput, numberValue } from '../../src/web/forms.ts';
import { SELLER_NORMAL } from '../fixtures/invoices.ts';
import { DOMESTIC_CUSTOMER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type Browser, type Fields, type WebEnv } from './helpers.ts';

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

/** The new-draft form as the page renders it, with a saved buyer chosen and the given fields typed in. */
async function newDraft(e: WebEnv, b: Browser, typed: Fields, path = '/invoices/new'): Promise<Fields> {
  const customer = e.app.findCustomers({}).items[0] ?? e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
  const page = await b.get(path);
  return { ...formFields(page.body, '/invoices/new'), customerId: customer.id, ...typed };
}

async function saved(b: Browser, action: string, fields: Fields): Promise<string> {
  const r = await b.post(action, fields);
  expect(r.status, flashesOf(r.body)).toBe(303);
  return flashesOf((await b.follow(r)).body);
}

describe('stored numbers come back from the web forms as they went in', () => {
  it('numberValue writes what numberInput reads back', () => {
    expect(numberValue('2.125')).toBe('2,125');
    expect(numberValue('615.943')).toBe('615,943');
    expect(numberValue('-0.5')).toBe('-0,5');
    expect(numberValue('12500')).toBe('12500');
    expect(numberValue('')).toBe('');
    for (const stored of ['2.125', '615.943', '395.125', '1000.5', '-1.500', '0.001', '12500']) {
      expect(numberInput(numberValue(stored), 'x'), stored).toBe(stored);
    }
  });

  it('a draft with a quantity of 2,125 and a unit price of 615,943 is saved again from its edit form', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const created = await b.post('/invoices/new', await newDraft(e, b, {
      'lines[0].description': 'Tanácsadás', 'lines[0].quantity': '2,125', 'lines[0].unit': 'óra', 'lines[0].unitPrice': '12000', 'lines[0].vatCode': '27',
      'lines[1].description': 'Gázolaj', 'lines[1].quantity': '45,678', 'lines[1].unit': 'l', 'lines[1].unitPrice': '615,943', 'lines[1].vatCode': '27',
    }));
    expect(created.status, flashesOf(created.body)).toBe(303);
    const draft = e.app.findInvoices({ status: ['draft'] }).items[0];
    expect(draft?.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([['2.125', '12000'], ['45.678', '615.943']]);

    const action = `/invoices/${draft?.id ?? ''}/edit`;
    const fields = formFields((await b.get(action)).body, action);
    expect([fields['lines[0].quantity'], fields['lines[1].quantity'], fields['lines[1].unitPrice']]).toEqual(['2,125', '45,678', '615,943']);
    expect(await saved(b, action, { ...fields, comment: 'Csak a megjegyzés változott' })).toBe('Piszkozat mentve.');
    const after = e.app.getInvoice(draft?.id ?? '');
    expect(after.comment).toBe('Csak a megjegyzés változott');
    expect(after.lines.map((l) => [l.quantity, l.unitPrice])).toEqual([['2.125', '12000'], ['45.678', '615.943']]);
    expect(after.totals.grossAmount).toBe(draft?.totals.grossAmount);
  });

  it('a product with a three-decimal price: its own form, the product picker and "Új számla ezzel a termékkel"', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const fuel = e.app.saveProduct({ name: 'Gázolaj', unit: 'l', unitPrice: '615.943', vatCode: '27' });

    const action = `/products/${fuel.id}`;
    const fields = formFields((await b.get(action)).body, action);
    expect(fields.unitPrice).toBe('615,943');
    expect(await saved(b, action, { ...fields, description: 'Prémium gázolaj' })).toBe('Mentve.');
    expect(e.app.getProduct(fuel.id)).toMatchObject({ unitPrice: '615.943', description: 'Prémium gázolaj' });

    // The picker's script copies data-price into the unit price field: it must be a value the form takes.
    const page = await b.get('/invoices/new');
    expect(page.body).toContain('data-price="615,943"');
    const picked = await b.post('/invoices/new', await newDraft(e, b, {
      'lines[0].productId': fuel.id, 'lines[0].description': 'Gázolaj', 'lines[0].quantity': '10', 'lines[0].unit': 'l', 'lines[0].unitPrice': '615,943', 'lines[0].vatCode': '27',
    }));
    expect(picked.status, flashesOf(picked.body)).toBe(303);

    // "Új számla ezzel a termékkel": the first row is pre-filled from the product.
    const withProduct = await newDraft(e, b, {}, `/invoices/new?productId=${fuel.id}`);
    expect(withProduct['lines[0].unitPrice']).toBe('615,943');
    const second = await b.post('/invoices/new', withProduct);
    expect(second.status, flashesOf(second.body)).toBe(303);
    expect(e.app.findInvoices({ status: ['draft'] }).items.map((d) => d.lines[0]?.unitPrice)).toEqual(['615.943', '615.943']);
  });

  it('a manual exchange rate with three decimals is kept by an unchanged save', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const created = await b.post('/invoices/new', await newDraft(e, b, {
      currency: 'EUR', exchangeRate: '395,125',
      'lines[0].description': 'Consulting', 'lines[0].quantity': '1', 'lines[0].unit': 'óra', 'lines[0].unitPrice': '100', 'lines[0].vatCode': '27',
    }));
    expect(created.status, flashesOf(created.body)).toBe(303);
    const draft = e.app.findInvoices({ status: ['draft'] }).items[0];
    expect([draft?.exchangeRate, draft?.exchangeRateSource]).toEqual(['395.125', 'manual']);

    const action = `/invoices/${draft?.id ?? ''}/edit`;
    const fields = formFields((await b.get(action)).body, action);
    expect(fields.exchangeRate).toBe('395,125');
    expect(await saved(b, action, fields)).toBe('Piszkozat mentve.');
    const after = e.app.getInvoice(draft?.id ?? '');
    expect([after.exchangeRate, after.exchangeRateSource]).toEqual(['395.125', 'manual']);
  });
});
