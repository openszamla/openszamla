/**
 * The web storno / díjbekérő withdrawal behaves like MCP with a reason that has fewer than 3 visible
 * characters once normalised (PC5): a reason of bidi controls only passes the form's 3–200 characters, but
 * the preview refuses it with the service's message and offers no confirmation; a forged confirmation POST
 * changes nothing. A valid reason is shown – and confirmed – as the service normalised it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, hiddenValue, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const LINES = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' as const }];
const BIDI_ONLY = '‮‭‬';

async function issued(e: WebEnv, documentType: 'invoice' | 'proforma' = 'invoice'): Promise<string> {
  const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  return (await e.app.issue((await e.app.createDraft({ customerId, documentType, lines: LINES })).invoice.id)).invoice.id;
}

describe('the web storno with a blank reason (PC5)', () => {
  it('bidi controls only: the service message, no confirmation form; a forged confirmation changes nothing', async () => {
    const e = await env();
    const id = await issued(e);
    const b = await e.loggedIn();
    const preview = await b.post(`/invoices/${id}/cancel-preview`, { reason: BIDI_ONLY });
    expect(preview.status).toBe(303);
    const page = await b.follow(preview);
    expect(flashesOf(page.body)).toContain('A sztornó oka legalább 3 látható karakterből álljon.');
    expect(page.body).not.toContain('name="confirmation"');
    expect(page.body).not.toContain('Sztornózás</button>');

    const forged = await b.post(`/invoices/${id}/cancel`, { reason: BIDI_ONLY, confirmation: 'x', confirm: 'yes' });
    expect(flashesOf((await b.follow(forged)).body)).toContain('A sztornó oka legalább 3 látható karakterből álljon.');
    expect(e.app.getInvoice(id).status).toBe('issued');
  });

  it('three spaces: the form asks for the reason', async () => {
    const e = await env();
    const id = await issued(e);
    const b = await e.loggedIn();
    const page = await b.follow(await b.post(`/invoices/${id}/cancel-preview`, { reason: '   ' }));
    expect(flashesOf(page.body)).toContain('Add meg a sztornó okát (3–200 karakter).');
    expect(page.body).not.toContain('name="confirmation"');
  });

  it('a díjbekérő withdrawal: the same refusal', async () => {
    const e = await env();
    const id = await issued(e, 'proforma');
    const b = await e.loggedIn();
    const page = await b.follow(await b.post(`/invoices/${id}/cancel-preview`, { reason: BIDI_ONLY }));
    expect(flashesOf(page.body)).toContain('A visszavonás oka legalább 3 látható karakterből álljon.');
    expect(page.body).not.toContain('name="confirmation"');
    expect(e.app.getInvoice(id).status).toBe('issued');
  });

  it('a valid reason is shown and confirmed as normalised', async () => {
    const e = await env();
    const id = await issued(e);
    const b = await e.loggedIn();
    const preview = await b.post(`/invoices/${id}/cancel-preview`, { reason: 'Téves ‮  számla' });
    expect(preview.status).toBe(200);
    expect(hiddenValue(preview.body, 'reason')).toBe('Téves számla');
    const confirmation = hiddenValue(preview.body, 'confirmation') ?? '';
    const done = await b.follow(await b.post(`/invoices/${id}/cancel`, { reason: 'Téves számla', confirmation, confirm: 'yes' }));
    expect(flashesOf(done.body)).toContain('Sztornó számla kiállítva');
    expect(e.app.getInvoice(id).status).toBe('cancelled');
  });
});
