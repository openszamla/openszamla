/**
 * U3: the draft page and the storno preview show validation issues in the words of the web forms – the buyer types as the
 * form names them, no MCP field or tool names, no NAV error numbers –, the field in Hungarian ("érintett mező: vevő
 * típusa") linked to where it is fixed, and a draft the web form cannot edit says what to do instead.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { localizeLineRefs } from '../../src/web/forms.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { startWeb, type WebEnv } from './helpers.ts';

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

function draftPartOf(body: string): string {
  const start = body.indexOf('aria-labelledby="h-draft"');
  return body.slice(start, body.indexOf('</section>', start));
}

describe('issues of a draft', () => {
  it('an intra-EU code for a private person: the form words, the field linked to the buyer part of the form', async () => {
    const e = await env();
    const view = await e.app.createDraft({
      customer: { vatStatus: 'PRIVATE_PERSON', name: 'Szőke Őrs', address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 20.' } },
      lines: [{ description: 'Termék', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: 'KBAET' }],
    });
    expect(view.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EU_CODE_CUSTOMER_NOT_OTHER', 'EU_CODE_CUSTOMER_EU_VAT_REQUIRED']));
    const b = await e.loggedIn();
    const part = draftPartOf((await b.get(`/invoices/${view.invoice.id}`)).body);
    expect(part).toContain('A(z) KBAET kódú tétel csak más uniós tagállamban nyilvántartott cégnek (adóalanynak) számlázható: a vevő típusa legyen „egyéb (külföldi, vagy nem áfaalany szervezet)”, és add meg a közösségi adószámát.');
    expect(part).toContain(`– érintett mező: <a href="/invoices/${view.invoice.id}/edit#h-cust">vevő típusa</a>`);
    expect(part).toContain(`– érintett mező: <a href="/invoices/${view.invoice.id}/edit#h-cust">vevő közösségi adószáma</a>`);
    for (const w of ['(customer.vatStatus)', 'customer.euVatNumber', 'OTHER-re', 'OTHER státuszú', 'NAV ERROR', '(issueDate)']) expect(part, w).not.toContain(w);
  });

  it('a buyer from the customer list: the buyer fields link to its data sheet (the draft follows the record)', async () => {
    const e = await env();
    const customer = e.app.saveCustomer({ vatStatus: 'PRIVATE_PERSON', name: 'Szőke Őrs', address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 20.' } }).customer;
    const view = await e.app.createDraft({ customerId: customer.id, lines: [{ description: 'Termék', quantity: '1', unit: 'db', unitPrice: '10000', vatCode: 'KBAET' }] });
    const b = await e.loggedIn();
    expect(draftPartOf((await b.get(`/invoices/${view.invoice.id}`)).body)).toContain(`– érintett mező: <a href="/customers/${customer.id}">vevő típusa</a>`);
  });

  it('a TAM line: the line named in Hungarian, linked to the lines, with the note on how to give the exact legal basis', async () => {
    const e = await env();
    const view = await e.app.createDraft({ customer: DOMESTIC_CUSTOMER_INPUT, lines: [{ description: 'Oktatás', quantity: '1', unit: 'alkalom', unitPrice: '40000', vatCode: 'TAM' }] });
    const b = await e.loggedIn();
    const part = draftPartOf((await b.get(`/invoices/${view.invoice.id}`)).body);
    expect(part).toContain('A(z) 1. tétel tárgyi adómentes: a számlán a mentesség pontos jogszabályhelye is feltüntethető');
    expect(part).toContain(`– érintett mező: <a href="/invoices/${view.invoice.id}/edit#h-lines">1. tétel – adómentesség oka</a>`);
    expect(part).not.toContain('vatReason');
  });

  it('a draft the web form cannot edit (a végszámla with an advance deduction) says what to do – no MCP tool names', async () => {
    const e = await env();
    const view = await e.app.createDraft({
      customer: DOMESTIC_CUSTOMER_INPUT,
      documentType: 'final',
      lines: [
        { description: 'Teljes díj', quantity: '1', unit: 'db', unitPrice: '900000', vatCode: '27' },
        { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: '300000', vatCode: '27', advanceDeduction: { advanceInvoiceNumber: 'E-2026-00001', advancePaymentDate: '2026-10-05' } },
      ],
    });
    const b = await e.loggedIn();
    const page = (await b.get(`/invoices/${view.invoice.id}`)).body;
    expect(page).not.toContain(`href="/invoices/${view.invoice.id}/edit"`);
    const edit = await b.follow(await b.get(`/invoices/${view.invoice.id}/edit`));
    for (const body of [page, edit.body]) {
      expect(body).toContain('az AI-asszisztenssel javíttasd, vagy töröld, és készíts újat.');
      expect(body).not.toContain('invoice_draft');
      expect(body).not.toContain('MCP-n');
    }
  });
});

describe('line references', () => {
  it('a nested field of a line is named by its last part', () => {
    expect(localizeLineRefs('lines[1].advanceDeduction.advanceInvoiceNumber', [1, 2])).toBe('2. tétel – előlegszámla sorszáma');
    expect(localizeLineRefs('lines[0].unitPrice', [3])).toBe('3. tétel – egységár');
    expect(localizeLineRefs('lines[0].somethingElse', [3])).toBe('3. tétel');
  });
});
