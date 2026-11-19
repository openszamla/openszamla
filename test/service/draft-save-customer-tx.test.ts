/**
 * saveCustomer on a draft (invoice_draft / web "Mentés a vevők közé is") stores the buyer together with
 * the draft, in one transaction: a rejected draft leaves no customer and no customer audit entry behind,
 * and the corrected request then saves both once (WEB-2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(opts: { fetch?: typeof fetch } = {}): OpenSzamla {
  t = makeTestApp(opts.fetch ? { fetch: opts.fetch } : {});
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const GOOD = [{ description: 'Tanácsadás', quantity: '2', unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];
const actions = (app: OpenSzamla): string[] => app.auditLog({ limit: 100 }).items.map((e) => e.action);

describe('saveCustomer is stored with the draft (WEB-2)', () => {
  it('a draft rejected for a line saves no customer; the corrected request saves the customer and the draft once', async () => {
    const app = setup();
    const noPrice = [{ description: 'Tanácsadás', quantity: '2', unit: 'óra', vatCode: '27' as const }];
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, lines: noPrice })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, lines: [{ description: 'Tanácsadás', quantity: '2', unit: 'óra', unitPrice: '1.234,5', vatCode: '27' }] })).rejects.toMatchObject({ code: 'INVALID_NUMBER' });
    expect(app.findCustomers({}).total).toBe(0);
    expect(actions(app)).not.toContain('customer.create');

    const d = await app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, lines: GOOD });
    const customers = app.findCustomers({}).items;
    expect(customers.map((c) => c.name)).toEqual([DOMESTIC_CUSTOMER_INPUT.name]);
    expect(d.invoice.customerId).toBe(customers[0]?.id);
    expect(actions(app).filter((a) => a === 'customer.create' || a === 'invoice.draft.create')).toEqual(['invoice.draft.create', 'customer.create']);
    expect(app.verifyIntegrity().audit.ok).toBe(true);
  });

  it('other failures after the customer check (unknown series, product or date) save no customer either', async () => {
    const app = setup();
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, seriesId: 'ser_nope', lines: GOOD })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, lines: [{ productId: 'prd_nope', quantity: '1' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, fulfillmentDate: '2026-13-40', lines: GOOD })).rejects.toBeTruthy();
    expect(app.findCustomers({}).total).toBe(0);
  });

  it('an update with saveCustomer that is rejected leaves the stored customer unchanged', async () => {
    const app = setup();
    const cus = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const d = await app.createDraft({ customerId: cus.id, lines: GOOD });
    const moved = { countryCode: 'HU', postalCode: '1052', city: 'Budapest', addressLine: 'Váci utca 10.' };
    await expect(app.updateDraft(d.invoice.id, { customer: { id: cus.id, address: moved }, saveCustomer: true, lines: [{ description: 'x', quantity: '1', vatCode: '27' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.getCustomer(cus.id).address.addressLine).toBe('Fő tér 1.');
    expect(actions(app)).not.toContain('customer.update');

    await app.updateDraft(d.invoice.id, { customer: { id: cus.id, address: moved }, saveCustomer: true });
    expect(app.getCustomer(cus.id).address.addressLine).toBe('Váci utca 10.');
    expect(actions(app)).toContain('customer.update');
  });

  it('a different customer with the same tax number is still DUPLICATE_CUSTOMER, and no draft is made', async () => {
    const app = setup();
    app.saveCustomer(DOMESTIC_CUSTOMER_INPUT);
    await expect(app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, name: 'Más Név Kft.' }, saveCustomer: true, lines: GOOD })).rejects.toMatchObject({ code: 'DUPLICATE_CUSTOMER' });
    expect(app.findCustomers({}).total).toBe(1);
    expect(app.findInvoices({}).total).toBe(0);
  });

  it('a foreign-currency draft (MNB rate lookup) rejected for a line saves no customer', async () => {
    const mnb = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const app = setup({ fetch: mnb });
    await expect(app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, saveCustomer: true, currency: 'EUR', lines: [{ description: 'x', quantity: '1', vatCode: '27' }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.findCustomers({}).total).toBe(0);
  });
});
