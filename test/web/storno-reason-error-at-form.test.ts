/**
 * A refused storno / withdrawal reason is shown where it was typed: the preview request goes back to the storno part of
 * the invoice page (#h-cancel), which is open and shows the message above the reason field – the form's own 3–200
 * characters check and the service's "at least 3 visible characters" (PC5) alike. Other messages stay at the top.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function issued(documentType: 'invoice' | 'proforma' = 'invoice'): Promise<{ e: WebEnv; id: string }> {
  const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const lines = [{ description: 'Karbantartás', quantity: '1', unit: 'db', unitPrice: '200000', vatCode: '27' as const }];
  const id = (await e.app.issue((await e.app.createDraft({ customerId, documentType, lines })).invoice.id)).invoice.id;
  return { e, id };
}

/** The storno part of the invoice page. */
function cancelPartOf(body: string): string {
  const start = body.indexOf('<section class="card no-print" aria-labelledby="h-cancel">');
  return start < 0 ? '' : body.slice(start, body.indexOf('</section>', start));
}

/** What precedes the first card: the messages at the top of the page. */
function topOf(body: string): string {
  return body.slice(body.indexOf('<main'), body.indexOf('<div class="page-head">'));
}

describe('a refused storno reason is shown at the storno form', () => {
  it('invisible characters only: back to #h-cancel, the part open, the service message above the reason field', async () => {
    const { e, id } = await issued();
    const b = await e.loggedIn();
    const res = await b.post(`/invoices/${id}/cancel-preview`, { reason: '‮‭‬' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/invoices/${id}#h-cancel`);
    const page = (await b.follow(res)).body;
    const part = cancelPartOf(page);
    expect(part).toContain('<details open>');
    expect(part).toContain('<p class="flash-title">A sztornó oka legalább 3 látható karakterből álljon.</p>');
    // Above the reason field, and not repeated at the top of the page.
    expect(part.indexOf('legalább 3 látható karakterből')).toBeLessThan(part.indexOf('name="reason"'));
    expect(topOf(page)).not.toContain('flash-title');
    expect(flashesOf(page)).toBe('A sztornó oka legalább 3 látható karakterből álljon.');
    expect(e.app.getInvoice(id).status).toBe('issued');
    // Shown once: the next view of the page has the part closed again.
    expect(cancelPartOf((await b.get(`/invoices/${id}`)).body)).toContain('<details>');
  });

  it('spaces only (the form check) and a díjbekérő withdrawal: the same place', async () => {
    const { e, id } = await issued();
    const b = await e.loggedIn();
    const page = (await b.follow(await b.post(`/invoices/${id}/cancel-preview`, { reason: '   ' }))).body;
    expect(cancelPartOf(page)).toContain('<p class="flash-title">Add meg a sztornó okát (3–200 karakter).</p>');

    const p = await issued('proforma');
    const pb = await p.e.loggedIn();
    const withdrawal = (await pb.follow(await pb.post(`/invoices/${p.id}/cancel-preview`, { reason: '‮‭‬' }))).body;
    const part = cancelPartOf(withdrawal);
    expect(part).toContain('<h2 id="h-cancel">Díjbekérő visszavonása</h2>');
    expect(part).toContain('<details open>');
    expect(part).toContain('A visszavonás oka legalább 3 látható karakterből álljon.');
  });

  it('a refusal that is not about the reason (already cancelled) stays at the top of the page', async () => {
    const { e, id } = await issued();
    await e.app.cancel(id, { reason: 'Téves számla' });
    const b = await e.loggedIn();
    const page = (await b.follow(await b.post(`/invoices/${id}/cancel-preview`, { reason: 'Téves számla' }))).body;
    expect(topOf(page)).toContain('már sztornózva / visszavonva van');
    expect(cancelPartOf(page)).toBe('');
  });
});
