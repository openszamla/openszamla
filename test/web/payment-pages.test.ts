/**
 * Web pages about payments: the issue form's "A vevő kifizette (befizetés a kiállítás napjával)" (MCP-5) –
 * ticked for cash and card, unticked otherwise, not offered for a díjbekérő; the payment section shows
 * what is still open on an invoice settled with its modifications (MCP-6); and the dashboard repeats the
 * cash-accounting VAT warning of the report (MCP-2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import { CASH_ACCOUNTING_VAT_NOTE, type OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { formFields, hiddenValue, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(): Promise<WebEnv> {
  const e = await startWeb();
  envs.push(e);
  e.app.updateSeller(SELLER_INPUT);
  return e;
}

const ft = (v: string): string => formatMoney(v, 'HUF');

async function draftOf(app: OpenSzamla, extra: Record<string, unknown>): Promise<string> {
  const customerId = (app.findCustomers({}).items[0] ?? app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer).id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Szerviz', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }], ...extra });
  return d.invoice.id;
}

describe('web issue form: the buyer has paid (MCP-5)', () => {
  it('is ticked for cash and card, unticked for transfer, missing on a díjbekérő', async () => {
    const e = await env();
    const b = await e.loggedIn();
    for (const [paymentMethod, ticked] of [['CASH', true], ['CARD', true], ['TRANSFER', false]] as const) {
      const id = await draftOf(e.app, { paymentMethod });
      const page = await b.get(`/invoices/${id}`);
      expect(page.body).toContain('A vevő kifizette (befizetés a kiállítás napjával)');
      expect(formFields(page.body, `/invoices/${id}/issue`).markPaid, paymentMethod).toBe(ticked ? 'yes' : undefined);
    }
    const proforma = await draftOf(e.app, { documentType: 'proforma', paymentMethod: 'CASH' });
    expect((await b.get(`/invoices/${proforma}`)).body).not.toContain('name="markPaid"');
  });

  it('issuing with it ticked records the payment on the issue day; unticked leaves the invoice open', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const cash = await draftOf(e.app, { paymentMethod: 'CASH' });
    const page = await b.get(`/invoices/${cash}`);
    // As the browser submits it: the pre-ticked box, and the confirmation box ticked by the user.
    const issued = await b.follow(await b.post(`/invoices/${cash}/issue`, { ...formFields(page.body, `/invoices/${cash}/issue`), confirm: 'yes' }));
    expect(issued.body).toContain('Befizetés rögzítve a kiállítás napjával');
    expect(e.app.getInvoice(cash)).toMatchObject({ paymentStatus: 'paid', paidAmount: '12700', paidDate: '2026-10-27' });
    expect(e.app.auditLog({ entityId: cash }).items.some((a) => a.action === 'invoice.payment' && a.actor === 'web' && a.details.markPaid === true)).toBe(true);

    const other = await draftOf(e.app, { paymentMethod: 'CASH' });
    const confirmation = hiddenValue((await b.get(`/invoices/${other}`)).body, 'confirmation') ?? '';
    await b.post(`/invoices/${other}/issue`, { confirmation, confirm: 'yes' });
    expect(e.app.getInvoice(other)).toMatchObject({ status: 'issued', paymentStatus: 'unpaid' });
  });

  it('the payment section shows what is still open with the invoice modifications', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const id = await draftOf(e.app, {});
    const original = (await e.app.issue(id)).invoice;
    await e.app.issue((await e.app.createCorrectionDraft(original.id, { lines: [{ description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-1000', vatCode: '27' }] })).invoice.id);
    const page = await b.get(`/invoices/${original.id}`);
    expect(page.body).toContain(`<dt>Hátralék</dt><dd>${ft('11430')}</dd>`);
    e.app.recordPayment(original.id, {});
    expect((await b.get(`/invoices/${original.id}`)).body).toContain(`<dt>Hátralék</dt><dd>${ft('0')}</dd>`);
  });
});

describe('dashboard: cash accounting (MCP-2)', () => {
  it('the month summary carries the warning that its VAT is not the VAT to declare', async () => {
    const e = await env();
    const b = await e.loggedIn();
    const html = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // A draft: the dashboard is past its first run and shows the month summary.
    await draftOf(e.app, {});
    expect((await b.get('/')).body).not.toContain('Pénzforgalmi elszámolás:');
    e.app.updateSeller({ cashAccounting: true });
    expect((await b.get('/')).body).toContain(`<p class="hint">${html(CASH_ACCOUNTING_VAT_NOTE)}</p>`);
  });
});
