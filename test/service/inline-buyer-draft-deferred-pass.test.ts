/**
 * A draft with an inline buyer stores customerFromRecord: false explicitly – draft-only data, not kept at
 * issue – and the one-time pass that makes drafts of the earlier version follow their customer record
 * (flagRecordBuyerDrafts) looks only at drafts without the property (PC4). So a pass that did not complete
 * at the first start (e.g. DB_BUSY) and runs at a later one never turns a new one-off buyer – given with a
 * record's id and the record's data – into one that follows the record: a customer_save does not rewrite it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const NOW = () => new Date('2026-11-14T09:00:00.000Z');
const LINES = [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' as const }];
const MOVED = { countryCode: 'HU', postalCode: '1052', city: 'Budapest', addressLine: 'Váci utca 1.' };

function setup(): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ now: NOW });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

/** A later start of the program on the same database, with the one-time pass not yet done (deferred). */
function deferredStart(app: OpenSzamla): OpenSzamla {
  app.store.setSetting('draftBuyersFollowRecords', null);
  return new OpenSzamla(app.store, app.config, { now: NOW });
}

/** What the earlier version stored for a draft: no customerFromRecord property. */
function asLegacy(app: OpenSzamla, id: string): void {
  const { customerFromRecord: _flag, ...legacy } = app.getInvoice(id);
  app.store.updateDraft(legacy as Invoice);
}

/** The pass's own log entries for a draft ('invoice.draft.update', fields: ["customerFromRecord"]). */
const systemUpdates = (app: OpenSzamla, id: string): number =>
  app.auditLog({ entityId: id }).items.filter((e) => e.action === 'invoice.draft.update' && e.actor === 'system' && JSON.stringify(e.details.fields) === '["customerFromRecord"]').length;

describe('an inline buyer stays inline when the one-time pass runs later (PC4)', () => {
  it('given with the record id and the record data: stored as inline, the deferred pass leaves it, customer_save does not reach it', async () => {
    const { app, customerId } = setup();
    // Exactly the record's data, with its id, but not as the record: a one-off buyer (6.7).
    const d = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, id: customerId }, lines: LINES });
    expect(d.invoice.customerId).toBe(customerId);
    expect(d.invoice.customerFromRecord).toBe(false);
    expect(app.getInvoice(d.invoice.id).customerFromRecord).toBe(false);

    const started = deferredStart(app);
    expect(started.getInvoice(d.invoice.id).customerFromRecord).toBe(false);
    expect(systemUpdates(started, d.invoice.id)).toBe(0);

    started.saveCustomer({ id: customerId, address: MOVED });
    expect(started.viewInvoice(d.invoice.id).invoice.customer.address.addressLine).toBe('Fő tér 1.');
    const issued = (await started.issue(d.invoice.id)).invoice;
    expect(issued.customer.address.addressLine).toBe('Fő tér 1.');
    // Draft-only: not part of the issued document.
    expect(issued.customerFromRecord).toBeUndefined();
    expect(started.verifyIntegrity().invoiceMismatches).toEqual([]);
  });

  it('the same deferred pass still flags a draft of the earlier version – also one edited before it ran', async () => {
    const { app, customerId } = setup();
    const legacy = await app.createDraft({ customerId, lines: LINES });
    asLegacy(app, legacy.invoice.id);
    const edited = await app.createDraft({ customerId, lines: LINES });
    asLegacy(app, edited.invoice.id);
    // Edited without giving the buyer again: it stays a draft of the earlier version.
    await app.updateDraft(edited.invoice.id, { comment: 'Novemberi szerviz' });
    expect(app.getInvoice(edited.invoice.id).customerFromRecord).toBeUndefined();
    const inline = await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, id: customerId }, lines: LINES });

    const started = deferredStart(app);
    expect(started.getInvoice(legacy.invoice.id).customerFromRecord).toBe(true);
    expect(started.getInvoice(edited.invoice.id).customerFromRecord).toBe(true);
    expect(started.getInvoice(inline.invoice.id).customerFromRecord).toBe(false);
    expect([legacy, edited, inline].map((x) => systemUpdates(started, x.invoice.id))).toEqual([1, 1, 0]);
  });

  it('the buyer of a copied issued document: from the record when it is one, otherwise the copy’s own', async () => {
    const { app, customerId } = setup();
    const fromRecord = (await app.issue((await app.createDraft({ customerId, lines: LINES })).invoice.id)).invoice;
    const oneOff = (await app.issue((await app.createDraft({ customer: { ...DOMESTIC_CUSTOMER_INPUT, name: 'Egyszeri Bt.', taxNumber: '22222222-2-42' }, lines: LINES })).invoice.id)).invoice;
    expect((await app.createDraft({ copyFromId: fromRecord.id })).invoice.customerFromRecord).toBe(true);
    expect((await app.createDraft({ copyFromId: oneOff.id })).invoice.customerFromRecord).toBe(false);
    // Given again, the buyer decides as on any draft.
    const switched = await app.createDraft({ copyFromId: oneOff.id, customerId });
    expect(switched.invoice.customerFromRecord).toBe(true);
  });
});
