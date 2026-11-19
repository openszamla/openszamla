/**
 * The storno reason and the díjbekérő withdrawal reason are normalised once, in the service (PC5): on one
 * line (line breaks and other control characters become a space, bidirectional controls are left out),
 * runs of spaces collapsed, trimmed – the preview, the confirmation and the storno use the same text. A
 * reason with fewer than 3 visible characters after that (three spaces, bidi controls only, zero-width
 * characters only) is refused with INVALID_INPUT by stornoPreview, cancelReason, cancelFingerprint and
 * cancel, before anything is stored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry, Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const LINES = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' as const }];

async function setup(documentType: 'invoice' | 'proforma' = 'invoice'): Promise<{ app: OpenSzamla; inv: Invoice }> {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  const customerId = t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const inv = (await t.app.issue((await t.app.createDraft({ customerId, documentType, lines: LINES })).invoice.id)).invoice;
  return { app: t.app, inv };
}

const SPACES = '   ';
const BIDI_ONLY = '‮⁦⁩'; // RLO, LRI, PDI
const ZERO_WIDTH = '​​​';
const TWO_VISIBLE = ' a ‮\n b '; // "a b": two visible characters
const STORNO_TOO_SHORT = { code: 'INVALID_INPUT', message: 'A sztornó oka legalább 3 látható karakterből álljon.' };
const WITHDRAWAL_TOO_SHORT = { code: 'INVALID_INPUT', message: 'A visszavonás oka legalább 3 látható karakterből álljon.' };

const entries = (app: OpenSzamla, action: string): AuditEntry[] => app.auditLog({ limit: 200 }).items.filter((e) => e.action === action);

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('nothing thrown');
}

describe('a storno reason needs 3 visible characters after normalisation (PC5)', () => {
  it.each([
    ['three spaces', SPACES],
    ['bidi controls only', BIDI_ONLY],
    ['zero-width characters only', ZERO_WIDTH],
    ['two visible characters', TWO_VISIBLE],
  ])('%s: refused by the preview, the confirmation and the storno; nothing is stored', async (_label, reason) => {
    const { app, inv } = await setup();
    expect(thrown(() => app.stornoPreview(inv.id, reason))).toMatchObject(STORNO_TOO_SHORT);
    expect(thrown(() => app.cancelReason(inv.id, reason))).toMatchObject(STORNO_TOO_SHORT);
    expect(thrown(() => app.cancelFingerprint(inv.id, reason))).toMatchObject(STORNO_TOO_SHORT);
    await expect(app.cancel(inv.id, { reason })).rejects.toMatchObject(STORNO_TOO_SHORT);
    expect(app.getInvoice(inv.id).status).toBe('issued');
    expect(app.findInvoices({ documentType: ['storno'], status: ['draft', 'issued'] }).total).toBe(0);
    expect(entries(app, 'invoice.storno.draft')).toEqual([]);
  });

  it('without a reason the storno is refused as well', async () => {
    const { app, inv } = await setup();
    await expect(app.cancel(inv.id)).rejects.toMatchObject(STORNO_TOO_SHORT);
    expect(thrown(() => app.stornoPreview(inv.id))).toMatchObject(STORNO_TOO_SHORT);
  });

  it('the state of the invoice is reported before the reason', async () => {
    const { app, inv } = await setup();
    await app.cancel(inv.id, { reason: 'Téves számla' });
    await expect(app.cancel(inv.id, { reason: SPACES })).rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
  });

  it('one normalised reason for the preview, the confirmation and the storno', async () => {
    const { app, inv } = await setup();
    const given = '  Téves ‮  mennyiség,\r\n\tújra  számlázva  ';
    const normalised = 'Téves mennyiség, újra számlázva';
    const preview = app.stornoPreview(inv.id, given);
    expect(preview.reason).toBe(normalised);
    expect(preview.storno.comment).toBe(`Sztornó oka: ${normalised}`);
    expect(app.cancelReason(inv.id, given)).toBe(normalised);
    expect(app.cancelFingerprint(inv.id, given)).toBe(app.cancelFingerprint(inv.id, normalised));
    const storno = (await app.cancel(inv.id, { reason: given })).invoice;
    expect(storno.comment).toBe(`Sztornó oka: ${normalised}`);
    expect(entries(app, 'invoice.storno.draft').map((e) => e.details.reason)).toEqual([normalised]);
  });
});

describe('a díjbekérő withdrawal reason follows the same rule (PC5)', () => {
  it.each([
    ['three spaces', SPACES],
    ['bidi controls only', BIDI_ONLY],
  ])('%s: refused, the díjbekérő stays issued', async (_label, reason) => {
    const { app, inv } = await setup('proforma');
    expect(thrown(() => app.cancelReason(inv.id, reason))).toMatchObject(WITHDRAWAL_TOO_SHORT);
    expect(thrown(() => app.cancelFingerprint(inv.id, reason))).toMatchObject(WITHDRAWAL_TOO_SHORT);
    await expect(app.cancel(inv.id, { reason })).rejects.toMatchObject(WITHDRAWAL_TOO_SHORT);
    expect(app.getInvoice(inv.id).status).toBe('issued');
    expect(entries(app, 'proforma.cancel')).toEqual([]);
  });

  it('a valid reason is logged normalised', async () => {
    const { app, inv } = await setup('proforma');
    await app.cancel(inv.id, { reason: ' Elállt \n a  vevő ' });
    expect(app.getInvoice(inv.id).status).toBe('cancelled');
    expect(entries(app, 'proforma.cancel').map((e) => e.details.reason)).toEqual(['Elállt a vevő']);
  });
});
