/**
 * The web storno preview (/invoices/<id>/cancel-preview):
 * - a storno with validation errors offers no confirmation – no checkbox, no button, no confirmation value –,
 *   only the errors and what to do first (T2.2); a storno refused after a clean preview (the state changed)
 *   shows the storno hint, never the draft one;
 * - it shows the storno's fulfilment date: the invoice's current one, after a date-correcting modification
 *   the corrected date (T2.3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, hiddenValue, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(now: string): Promise<WebEnv> {
  const e = await startWeb({ now: () => new Date(now) });
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const STORNO_HINT = 'A sztornó nem állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), majd próbáld újra.';
const line = (description: string, quantity: string, unitPrice: string, extra: Partial<LineInput> = {}): LineInput => ({ description, quantity, unit: 'db', unitPrice, vatCode: '27', ...extra });
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[\s ]+/g, ' ');

async function advanceWithFinal(e: WebEnv, withFinal: boolean): Promise<{ advanceId: string; issueFinal(): Promise<void> }> {
  const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const advance = (await e.app.issue((await e.app.createDraft({ customerId, documentType: 'advance', lines: [line('Előleg', '1', '300000')] })).invoice.id)).invoice;
  const issueFinal = async (): Promise<void> => {
    await e.app.issue((await e.app.createDraft({
      customerId,
      documentType: 'final',
      lines: [line('Gépsor', '1', '1000000'), line('Előleg levonása', '-1', '300000', { advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: advance.fulfillmentDate } })],
    })).invoice.id);
  };
  if (withFinal) await issueFinal();
  return { advanceId: advance.id, issueFinal };
}

describe('the web storno preview with errors (T2.2)', () => {
  it('shows the errors and what to do, without the confirmation form', async () => {
    const e = await env('2026-11-08T09:00:00.000Z');
    const { advanceId } = await advanceWithFinal(e, true);
    const b = await e.loggedIn();
    const preview = await b.post(`/invoices/${advanceId}/cancel-preview`, { reason: 'Téves előlegszámla' });
    expect(preview.status).toBe(200);
    const t = text(preview.body);
    expect(t).toContain('A(z) SZ-2026-00001 előlegszámlát a(z) SZ-2026-00002 végszámla levonja (27 ÁFA-kód, nettó 300000 HUF), ezért nem sztornózható');
    expect(t).toContain('A sztornó most nem állítható ki: előbb a fenti hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával vagy módosításával), utána kérj új sztornó-előnézetet.');
    expect(preview.body).toContain('Vissza a számlához');
    expect(preview.body).not.toContain(`action="/invoices/${advanceId}/cancel"`);
    expect(preview.body).not.toContain('name="confirm"');
    expect(hiddenValue(preview.body, 'confirmation')).toBeNull();
    expect(preview.body).not.toContain('Sztornó számla kiállítása');
  });

  it('a storno refused after a clean preview: the storno hint, not the draft one', async () => {
    const e = await env('2026-11-08T09:00:00.000Z');
    const { advanceId, issueFinal } = await advanceWithFinal(e, false);
    const b = await e.loggedIn();
    const preview = await b.post(`/invoices/${advanceId}/cancel-preview`, { reason: 'Téves előlegszámla' });
    const confirmation = hiddenValue(preview.body, 'confirmation');
    expect(confirmation).not.toBeNull();
    await issueFinal();
    const r = await b.post(`/invoices/${advanceId}/cancel`, { reason: 'Téves előlegszámla', confirmation: confirmation ?? '', confirm: 'yes' });
    expect(r.status).toBe(303);
    const page = await b.follow(r);
    expect(flashesOf(page.body)).toContain('A sztornó számla nem állítható ki: A(z) SZ-2026-00001 előlegszámlát a(z) SZ-2026-00002 végszámla levonja');
    expect(text(page.body)).toContain(STORNO_HINT);
    expect(page.body).not.toContain('invoice_draft');
    expect(e.app.getInvoice(advanceId).status).toBe('issued');
  });
});

describe("the web storno preview shows the storno's fulfilment date (T2.3)", () => {
  it('after a date-correcting modification: the corrected date, marked as such; otherwise the original date', async () => {
    const e = await env('2026-11-05T09:00:00.000Z');
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const fixed = (await e.app.issue((await e.app.createDraft({ customerId, fulfillmentDate: '2026-10-15', lines: [line('Karbantartás', '1', '200000')] })).invoice.id)).invoice;
    await e.app.issue((await e.app.createCorrectionDraft(fixed.id, { fulfillmentDate: '2026-11-03', lines: [line('Teljesítés dátuma helyesen: 2026.11.03.', '1', '0')], comment: 'Teljesítési dátum javítása' })).invoice.id);
    const plain = (await e.app.issue((await e.app.createDraft({ customerId, fulfillmentDate: '2026-11-02', lines: [line('Karbantartás', '1', '100000')] })).invoice.id)).invoice;
    const b = await e.loggedIn();

    const p1 = text((await b.post(`/invoices/${fixed.id}/cancel-preview`, { reason: 'Szerződés felbontva' })).body);
    expect(p1).toContain('A sztornó számla teljesítési dátuma 2026.11.03. (javított; az eredeti számláé: 2026.10.15.)');
    expect(p1).toContain('Az eredeti számla kelte 2026.11.05.');

    const p2 = text((await b.post(`/invoices/${plain.id}/cancel-preview`, { reason: 'Téves számla' })).body);
    expect(p2).toContain('A sztornó számla teljesítési dátuma 2026.11.02. Az eredeti számla kelte');
  });
});
