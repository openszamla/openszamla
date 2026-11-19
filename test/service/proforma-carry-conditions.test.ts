/**
 * When issuing a document converted from a paid díjbekérő does NOT take its payment over (review C1, N2):
 * a document nothing is payable on (0 Ft – e.g. a végszámla deducting the whole advance – or negative), a
 * withdrawn díjbekérő, and a document billed to another buyer (customer record, else tax number, else
 * name). The preview warns PROFORMA_PAYMENT_NOT_CARRIED with the reason, issuing records nothing and says
 * so – and a payment that cannot be applied never blocks issuing (the draft would be stuck for good:
 * its díjbekérő link survives every edit).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { Invoice, ValidationIssue } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

function setup(): OpenSzamla {
  t = makeTestApp({ now: () => new Date('2026-11-08T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return t.app;
}

const ft = (v: string): string => formatMoney(v, 'HUF');
const LICENCE = [{ description: 'Licenc', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' as const }]; // 127 000 Ft
const OTHER_BUYER = { ...DOMESTIC_CUSTOMER_INPUT, name: 'Másik Kft.', taxNumber: '22222222-2-42' };
const PERSON = { vatStatus: 'PRIVATE_PERSON' as const, name: 'Nagy Béla', address: { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Bartók Béla út 1.' } };

function customerId(app: OpenSzamla, input: typeof DOMESTIC_CUSTOMER_INPUT = DOMESTIC_CUSTOMER_INPUT): string {
  return (app.findCustomers({ taxNumber: input.taxNumber }).items[0] ?? app.saveCustomer(input).customer).id;
}

async function paidProforma(app: OpenSzamla, buyer: Record<string, unknown> = { customerId: customerId(app) }, lines: unknown[] = LICENCE): Promise<Invoice> {
  const d = await app.createDraft({ documentType: 'proforma', ...buyer, lines } as Parameters<OpenSzamla['createDraft']>[0]);
  const p = (await app.issue(d.invoice.id)).invoice;
  return app.recordPayment(p.id, { date: '2026-11-05' });
}

const notCarried = (issues: ValidationIssue[]): ValidationIssue | undefined => issues.find((i) => i.code === 'PROFORMA_PAYMENT_NOT_CARRIED');
const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);

function payments(app: OpenSzamla, id: string): unknown[] {
  return app.auditLog({ entityId: id }).items.filter((e) => e.action === 'invoice.payment').map((e) => e.details.amount);
}

describe('a document nothing is payable on gets no díjbekérő payment (C1)', () => {
  it('a végszámla deducting the whole advance (0 Ft): warned in the preview, issued without the payment, with a note', async () => {
    const app = setup();
    const proforma = await paidProforma(app);
    // The előlegszámla of the payment, made by hand; the végszámla converted from the díjbekérő deducts all of it.
    const ad = await app.createDraft({ documentType: 'advance', customerId: customerId(app), fulfillmentDate: '2026-11-05', lines: [{ description: 'Előleg', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
    const advance = (await app.issue(ad.invoice.id)).invoice;
    const draft = await app.createDraft({
      copyFromId: proforma.id,
      documentType: 'final',
      fulfillmentDate: '2026-11-08',
      lines: [
        ...LICENCE,
        { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: '100000', vatCode: '27', advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: '2026-11-05' } },
      ],
    });
    expect(draft.invoice.totals.payableAmount).toBe('0');
    expect(draft.readyToIssue).toBe(true);
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAYMENT_CARRIED');
    expect(notCarried(draft.issues)).toMatchObject({ severity: 'warning', field: 'totals.payableAmount' });
    expect(notCarried(draft.issues)?.message).toBe(
      `A(z) ${proforma.number} díjbekérőre ${ft('127000')} befizetés van rögzítve (2026.11.05.), de a bizonylat fizetendő összege ${ft('0')}, ezért kiállításkor nem kerül át: ` +
        'a befizetést annál a bizonylatnál rögzítsd, amelyre a vevő fizetett (pl. az előlegszámlánál).',
    );

    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ status: 'issued', documentType: 'final', paidAmount: '0', paidDate: null });
    expect(payments(app, r.invoice.id)).toEqual([]);
    expect(r.notes).toContain(
      `A(z) ${proforma.number} díjbekérőre rögzített befizetés (${ft('127000')}) nem került át: a számla fizetendő összege ${ft('0')}. ` +
        'A befizetést annál a bizonylatnál rögzítsd, amelyre a vevő fizetett (pl. az előlegszámlánál).',
    );
    // The money is recorded where the buyer paid it.
    expect(app.recordPayment(advance.id, { date: '2026-11-05' }).paymentStatus).toBe('paid');
  });

  it('a negative payable is not carried to either', async () => {
    const app = setup();
    const proforma = await paidProforma(app);
    // Net 100 Ft (exempt 1 000, 27% −900): the payable is −143 Ft.
    const draft = await app.createDraft({
      copyFromId: proforma.id,
      fulfillmentDate: '2026-11-05',
      lines: [
        { description: 'Mentes szolgáltatás', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: 'TAM' },
        { description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-900', vatCode: '27' },
      ],
    });
    expect(draft.invoice.totals.payableAmount).toBe('-143');
    expect(notCarried(draft.issues)?.message).toContain(`de a bizonylat fizetendő összege ${ft('-143')}, ezért kiállításkor nem kerül át`);
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ status: 'issued', paidAmount: '0' });
    expect(r.notes.join(' ')).toContain(`nem került át: a számla fizetendő összege ${ft('-143')}.`);
  });

  it('a payment the invoice cannot take (a refund recorded on a negative díjbekérő) never blocks issuing', async () => {
    const app = setup();
    const proforma = await paidProforma(app, { customerId: customerId(app) }, [
      { description: 'Mentes szolgáltatás', quantity: '1', unit: 'db', unitPrice: '1000', vatCode: 'TAM' },
      { description: 'Engedmény', quantity: '1', unit: 'db', unitPrice: '-900', vatCode: '27' },
    ]);
    expect(proforma.paidAmount).toBe('-143');
    const draft = await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-05', lines: LICENCE });
    expect(draft.readyToIssue).toBe(true);
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ status: 'issued', number: 'SZ-2026-00001', paidAmount: '0', paymentStatus: 'unpaid' });
    expect(payments(app, r.invoice.id)).toEqual([]);
    expect(r.notes.join(' ')).toContain(`A(z) ${proforma.number} díjbekérőre rögzített befizetés (${ft('-143')}) nem került át: A visszavont összeg nem lehet nagyobb a befizetettnél`);
    expect(app.verifyIntegrity().ok).toBe(true);
  });
});

describe('a withdrawn díjbekérő or another buyer: the payment stays where it was (N2)', () => {
  it('a withdrawn díjbekérő', async () => {
    const app = setup();
    const proforma = await paidProforma(app);
    await app.cancel(proforma.id, { reason: 'Visszavont ajánlat' });
    const draft = await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-05' });
    expect(codes(draft.issues)).not.toContain('PROFORMA_PAYMENT_CARRIED');
    expect(notCarried(draft.issues)?.message).toBe(
      `A(z) ${proforma.number} díjbekérőre ${ft('127000')} befizetés van rögzítve (2026.11.05.), de a díjbekérő vissza van vonva, ezért kiállításkor nem kerül át: ` +
        'ha a vevő ezt a bizonylatot fizette, a kiállítás után rögzítsd a befizetést.',
    );
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    expect(payments(app, r.invoice.id)).toEqual([]);
    expect(r.notes).toContain(`A(z) ${proforma.number} díjbekérőre rögzített befizetés (${ft('127000')}) nem került át: a díjbekérő vissza van vonva. Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.`);
  });

  it('another customer record', async () => {
    const app = setup();
    const proforma = await paidProforma(app);
    const draft = await app.createDraft({ copyFromId: proforma.id, customerId: customerId(app, OTHER_BUYER), fulfillmentDate: '2026-11-05' });
    expect(draft.invoice.customer.name).toBe('Másik Kft.');
    expect(notCarried(draft.issues)).toMatchObject({ severity: 'warning', field: 'customer' });
    expect(notCarried(draft.issues)?.message).toContain('de a díjbekérő vevője nem azonos a bizonylat vevőjével, ezért kiállításkor nem kerül át: ha ennek a bizonylatnak a vevője fizetett');
    const r = await app.issue(draft.invoice.id);
    expect(r.invoice).toMatchObject({ paymentStatus: 'unpaid', paidAmount: '0' });
    expect(r.notes.join(' ')).toContain('nem került át: a díjbekérő vevője nem azonos a számla vevőjével.');
    expect(payments(app, r.invoice.id)).toEqual([]);
    // The díjbekérő keeps its payment.
    expect(app.getInvoice(proforma.id)).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
  });

  it('the same customer record with changed data is the same buyer', async () => {
    const app = setup();
    const proforma = await paidProforma(app);
    app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, id: customerId(app), name: 'Árvíztűrő Zrt. (új név)' });
    const draft = await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-05' });
    expect(draft.invoice.customer.name).toBe('Árvíztűrő Zrt. (új név)');
    expect(codes(draft.issues)).toContain('PROFORMA_PAYMENT_CARRIED');
    expect((await app.issue(draft.invoice.id)).invoice).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
  });

  it('without customer records: the tax number decides, and without tax numbers the name', async () => {
    const app = setup();
    const inline = await paidProforma(app, { customer: DOMESTIC_CUSTOMER_INPUT });
    expect(inline.customerId).toBeNull();
    // The same tax number in another notation is the same buyer, whatever the name says.
    const same = await app.createDraft({ copyFromId: inline.id, customer: { ...DOMESTIC_CUSTOMER_INPUT, name: 'ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP ZRT.', taxNumber: '87654323213' }, fulfillmentDate: '2026-11-05' });
    expect(codes(same.issues)).toContain('PROFORMA_PAYMENT_CARRIED');
    const other = await app.createDraft({ copyFromId: inline.id, customer: OTHER_BUYER, fulfillmentDate: '2026-11-05' });
    expect(codes(other.issues)).toContain('PROFORMA_PAYMENT_NOT_CARRIED');
    expect((await app.issue(other.invoice.id)).invoice.paymentStatus).toBe('unpaid');

    const person = await paidProforma(app, { customer: PERSON });
    const samePerson = await app.createDraft({ copyFromId: person.id, customer: { ...PERSON, name: '  nagy   béla ' }, fulfillmentDate: '2026-11-05' });
    expect(codes(samePerson.issues)).toContain('PROFORMA_PAYMENT_CARRIED');
    const otherPerson = await app.createDraft({ copyFromId: person.id, customer: { ...PERSON, name: 'Kiss Anna' }, fulfillmentDate: '2026-11-05' });
    expect(notCarried(otherPerson.issues)?.message).toContain('a díjbekérő vevője nem azonos a bizonylat vevőjével');
    expect((await app.issue(samePerson.invoice.id)).invoice).toMatchObject({ paymentStatus: 'paid', paidAmount: '127000' });
  });
});
