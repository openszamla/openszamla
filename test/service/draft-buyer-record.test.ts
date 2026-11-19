/**
 * The buyer of a draft taken from a customer record follows the record until issuing (MCP-1): the
 * preview, the issue fingerprint and the issued invoice use the record's current data. Inline buyer
 * data and the buyer of a correction stay as stored. customerId and customer together are refused (MCP-13).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CustomerData } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  t = makeTestApp();
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const LINES = [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];
const TYPO = { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 11.' };
const FIXED = { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' };

const addressOf = (c: CustomerData): string => c.address.addressLine;

describe('a buyer from a customer record follows the record until issuing (MCP-1)', () => {
  it('customer_save after the draft: new preview, new fingerprint, the issued invoice has the corrected data', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }).customer;
    const d = await app.createDraft({ customerId: cus.id, lines: LINES });
    expect(d.invoice.customerFromRecord).toBe(true);
    const before = app.issueFingerprint(d.invoice.id);

    app.saveCustomer({ id: cus.id, address: FIXED, taxNumber: '11111111-2-41' });
    const view = app.viewInvoice(d.invoice.id);
    expect(addressOf(view.invoice.customer)).toBe('Fő tér 1.');
    expect(view.invoice.customer.taxNumber).toBe('11111111-2-41');
    expect(app.issueFingerprint(d.invoice.id)).not.toBe(before);

    const r = await app.issue(d.invoice.id);
    expect(addressOf(r.invoice.customer)).toBe('Fő tér 1.');
    expect(r.invoice.customer.taxNumber).toBe('11111111-2-41');
    expect(r.invoice.customerId).toBe(cus.id);
    // A draft-only flag: not part of the issued document.
    expect(r.invoice.customerFromRecord).toBeUndefined();
    expect(app.verifyIntegrity().invoiceMismatches).toEqual([]);
  });

  it('a later draft update stores the current record data', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }).customer;
    const d = await app.createDraft({ customerId: cus.id, lines: LINES });
    app.saveCustomer({ id: cus.id, address: FIXED });
    await app.updateDraft(d.invoice.id, { comment: 'Október' });
    expect(addressOf(app.getInvoice(d.invoice.id).customer)).toBe('Fő tér 1.');
  });

  it('a buyer saved with the draft (saveCustomer) follows its record as well', async () => {
    const app = setup();
    const d = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }, saveCustomer: true, lines: LINES });
    const cusId = d.invoice.customerId as string;
    expect(app.getCustomer(cusId).address.addressLine).toBe('Fő tér 11.');
    app.saveCustomer({ id: cusId, address: FIXED });
    expect(addressOf(app.viewInvoice(d.invoice.id).invoice.customer)).toBe('Fő tér 1.');
  });

  it('inline buyer data – even with the id of a stored customer – is used as given', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: FIXED }).customer;
    const d = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, id: cus.id, address: { ...FIXED, addressLine: 'Telephely, Ipari út 5.' } }, lines: LINES });
    expect(d.invoice.customerFromRecord).toBe(false);
    const before = app.issueFingerprint(d.invoice.id);
    app.saveCustomer({ id: cus.id, address: { ...FIXED, addressLine: 'Fő tér 2.' } });
    expect(app.issueFingerprint(d.invoice.id)).toBe(before);
    expect(addressOf(app.viewInvoice(d.invoice.id).invoice.customer)).toBe('Telephely, Ipari út 5.');
    expect(addressOf((await app.issue(d.invoice.id)).invoice.customer)).toBe('Telephely, Ipari út 5.');
  });

  it('modification and storno keep the original invoice\'s buyer', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }).customer;
    const original = (await app.issue((await app.createDraft({ customerId: cus.id, lines: LINES })).invoice.id)).invoice;
    app.saveCustomer({ id: cus.id, address: FIXED });
    const corr = await app.createCorrectionDraft(original.id, { lines: [{ description: 'Árengedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] });
    expect(addressOf(corr.invoice.customer)).toBe('Fő tér 11.');
    expect(addressOf((await app.issue(corr.invoice.id)).invoice.customer)).toBe('Fő tér 11.');
    expect(addressOf(app.stornoPreview(original.id, 'Téves számla').storno.customer)).toBe('Fő tér 11.');
    expect(addressOf((await app.cancel(original.id, { reason: 'Téves számla' })).invoice.customer)).toBe('Fő tér 11.');
  });

  it('a copy of an issued invoice gets the current data of its customer record', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }).customer;
    const src = (await app.issue((await app.createDraft({ customerId: cus.id, lines: LINES })).invoice.id)).invoice;
    app.saveCustomer({ id: cus.id, address: FIXED });
    const copy = await app.createDraft({ copyFromId: src.id });
    expect(copy.invoice.customerId).toBe(cus.id);
    expect(addressOf(copy.invoice.customer)).toBe('Fő tér 1.');
    app.saveCustomer({ id: cus.id, address: { ...FIXED, addressLine: 'Fő tér 3.' } });
    expect(addressOf(app.viewInvoice(copy.invoice.id).invoice.customer)).toBe('Fő tér 3.');
  });
});

describe('customerId and customer together are refused (MCP-13)', () => {
  it('on create and on update, without storing anything', async () => {
    const app = setup();
    const cus = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer;
    const other = { vatStatus: 'PRIVATE_PERSON' as const, name: 'Másik Ember', address: FIXED };
    await expect(app.createDraft({ customerId: cus.id, customer: other, lines: LINES })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'customerId és customer egyszerre nem adható meg.',
      hint: expect.stringMatching(/customer\.id.*saveCustomer/),
    });
    expect(app.findInvoices({}).total).toBe(0);
    const d = await app.createDraft({ customerId: cus.id, lines: LINES });
    await expect(app.updateDraft(d.invoice.id, { customerId: cus.id, customer: other, saveCustomer: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(app.findCustomers({}).total).toBe(1);
    expect(app.getInvoice(d.invoice.id).customer.name).toBe(DOMESTIC_CUSTOMER_INPUT.name);
  });

  it('customer with id + saveCustomer still updates the record, and customerId alone re-reads it', async () => {
    const app = setup();
    const cus = app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, address: TYPO }).customer;
    const d = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, id: cus.id, address: TYPO }, lines: LINES });
    const saved = await app.updateDraft(d.invoice.id, { customer: { id: cus.id, address: FIXED }, saveCustomer: true });
    expect(app.getCustomer(cus.id).address.addressLine).toBe('Fő tér 1.');
    expect(addressOf(saved.invoice.customer)).toBe('Fő tér 1.');
    app.saveCustomer({ id: cus.id, address: { ...FIXED, addressLine: 'Fő tér 2.' } });
    const again = await app.updateDraft(d.invoice.id, { customerId: cus.id });
    expect(addressOf(again.invoice.customer)).toBe('Fő tér 2.');
  });
});
