/**
 * Drafts saved before a draft's buyer followed its customer record have no customerFromRecord flag (N6):
 * - once per database, at start, every such draft naming a customer record whose stored buyer data equal
 *   the record's gets the flag (logged), and from then on follows the record – a customer_save reaches its
 *   preview, its confirmation and the issued invoice;
 * - a draft naming a customer record whose own buyer data differ from it (an older draft, or inline data
 *   with the record's id) keeps them, and its preview says so: BUYER_DIFFERS_FROM_RECORD, with the way to
 *   switch to the record (invoice_draft { draftId, customerId }).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const NOW = () => new Date('2026-11-02T09:00:00.000Z');
const LINES = [{ description: 'Fejlesztés', quantity: '1', unit: 'óra', unitPrice: '15000', vatCode: '27' as const }];
const ADDRESS = DOMESTIC_CUSTOMER_INPUT.address;
const MOVED = { ...ADDRESS, postalCode: '1052', city: 'Budapest', addressLine: 'Váci utca 1.' };

const warning = (issues: ValidationIssue[]): ValidationIssue | undefined => issues.find((i) => i.code === 'BUYER_DIFFERS_FROM_RECORD');

/** What 0.1.0 stored for a draft made with customerId: the same buyer data, without the flag. */
function asLegacy(app: OpenSzamla, id: string): void {
  const { customerFromRecord: _flag, ...legacy } = app.getInvoice(id);
  app.store.updateDraft(legacy as Invoice);
}

/** A start of the program on the same database, with the one-time pass not yet done. */
function restart(app: OpenSzamla): OpenSzamla {
  app.store.setSetting('draftBuyersFollowRecords', null);
  return new OpenSzamla(app.store, app.config, { now: NOW });
}

function setup(): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ now: NOW });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

describe('drafts saved before drafts followed their customer record (N6)', () => {
  it('a draft whose buyer equals the record gets the flag once, logged, and then follows the record', async () => {
    const { app, customerId } = setup();
    const d = await app.createDraft({ customerId, lines: LINES });
    asLegacy(app, d.invoice.id);
    expect(app.getInvoice(d.invoice.id).customerFromRecord).toBeUndefined();

    const started = restart(app);
    expect(started.getInvoice(d.invoice.id).customerFromRecord).toBe(true);
    expect(started.getInvoice(d.invoice.id).updatedAt).toBe(d.invoice.updatedAt);
    const logged = started.auditLog({ entityId: d.invoice.id }).items.filter((e) => e.action === 'invoice.draft.update');
    expect(logged.map((e) => [e.actor, e.details])).toEqual([['system', { fields: ['customerFromRecord'] }]]);
    expect(warning(started.viewInvoice(d.invoice.id).issues)).toBeUndefined();

    // From now on a customer_save reaches the draft: a new preview and confirmation, the issued invoice.
    const before = started.issueFingerprint(d.invoice.id);
    started.saveCustomer({ id: customerId, address: MOVED });
    expect(started.viewInvoice(d.invoice.id).invoice.customer.address.addressLine).toBe('Váci utca 1.');
    expect(started.issueFingerprint(d.invoice.id)).not.toBe(before);
    expect((await started.issue(d.invoice.id)).invoice.customer.address.addressLine).toBe('Váci utca 1.');
  });

  it('only once per database: a later start does not look again', async () => {
    const { app, customerId } = setup();
    const d = await app.createDraft({ customerId, lines: LINES });
    asLegacy(app, d.invoice.id);
    const started = restart(app);
    expect(started.getInvoice(d.invoice.id).customerFromRecord).toBe(true);
    const entries = started.auditLog({ limit: 1 }).total;
    asLegacy(started, d.invoice.id);
    const again = new OpenSzamla(app.store, app.config, { now: NOW });
    expect(again.getInvoice(d.invoice.id).customerFromRecord).toBeUndefined();
    expect(again.auditLog({ limit: 1 }).total).toBe(entries);
  });

  it('a draft whose buyer differs from the record keeps its data and gets BUYER_DIFFERS_FROM_RECORD', async () => {
    const { app, customerId } = setup();
    const d = await app.createDraft({ customerId, lines: LINES });
    asLegacy(app, d.invoice.id);
    // 0.1.0: the record changed after the draft was saved, the draft kept the old data.
    app.saveCustomer({ id: customerId, address: MOVED, email: 'szamla@vevo.hu' });
    const started = restart(app);
    expect(started.getInvoice(d.invoice.id).customerFromRecord).toBeUndefined();

    const view = started.viewInvoice(d.invoice.id);
    expect(view.readyToIssue).toBe(true);
    expect(view.invoice.customer.address.addressLine).toBe(ADDRESS.addressLine);
    expect(warning(view.issues)).toEqual({
      severity: 'warning',
      code: 'BUYER_DIFFERS_FROM_RECORD',
      message:
        'A piszkozat a saját vevőadatait tartja meg, és ezek eltérnek a vevők között tárolt adatoktól (eltér: cím, e-mail): kiállításkor a piszkozat adatai kerülnek a számlára, ' +
        `a tárolt vevő módosítása nem hat rá. Ha a tárolt adatokkal kell kiállítani, válaszd ki újra a vevőt: invoice_draft { draftId, customerId: "${customerId}" }.`,
      field: 'customer',
    });

    // The way the message gives: the record's data, following it from then on.
    const switched = await started.updateDraft(d.invoice.id, { customerId });
    expect(switched.invoice.customerFromRecord).toBe(true);
    expect(switched.invoice.customer.address.addressLine).toBe('Váci utca 1.');
    expect(warning(switched.issues)).toBeUndefined();
  });

  it('inline buyer data with the id of a record are named too; corrections and drafts without a record are not', async () => {
    const { app, customerId } = setup();
    const inline = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, id: customerId, address: { ...ADDRESS, addressLine: 'Telephely, Ipari út 5.' } }, lines: LINES });
    expect(warning(inline.issues)?.message).toContain('(eltér: cím)');
    const oneOff = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, address: MOVED }, lines: LINES });
    expect(warning(oneOff.issues)).toBeUndefined();

    const original = (await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice;
    app.saveCustomer({ id: customerId, address: MOVED });
    const correction = await app.createCorrectionDraft(original.id, { lines: [{ ...LINES[0]!, description: 'Árengedmény', unitPrice: '-1000' }], comment: 'Árengedmény' });
    expect(correction.invoice.customer.address.addressLine).toBe(ADDRESS.addressLine);
    expect(warning(correction.issues)).toBeUndefined();
    // A start leaves them as they are.
    const started = restart(app);
    expect(started.getInvoice(inline.invoice.id).customerFromRecord).toBe(false);
    expect(started.getInvoice(correction.invoice.id).customerFromRecord).toBeUndefined();
  });
});
