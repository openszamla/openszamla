/**
 * The key-data comparison behind the reconciliation of a duplicate rejection (NAV-1): what NAV holds under a
 * number is this invoice only when issue date, seller, buyer, currency and the HUF totals agree – a valid
 * number alone proves nothing. A hand-made entry with other details still matches.
 */
import { describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { parseInvoiceDataKeys } from '../../src/nav/api-xml.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import type { NavInvoiceKeys } from '../../src/nav/types.ts';
import { navInvoiceDifferences } from '../../src/service/nav-match.ts';
import { CUSTOMER_EU, CUSTOMER_PRIVATE, INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM } from '../fixtures/invoices.ts';

const keysOf = (inv: Invoice): NavInvoiceKeys => parseInvoiceDataKeys(buildInvoiceDataXml(inv));

describe('navInvoiceDifferences', () => {
  it('our own report matches; so does one entered by hand with other line texts, address and buyer name spelling', () => {
    for (const inv of [INVOICE_DOMESTIC, INVOICE_EU_SERVICE, INVOICE_PRIVATE_AAM]) expect(navInvoiceDifferences(inv, keysOf(inv)), inv.id).toEqual([]);
    const byHand: Invoice = {
      ...INVOICE_DOMESTIC,
      customer: { ...INVOICE_DOMESTIC.customer, name: 'ARVIZTURO  Tukorfurogep Zrt.', address: { ...INVOICE_DOMESTIC.customer.address, addressLine: 'Október 23. u. 18.' } },
      lines: INVOICE_DOMESTIC.lines.map((l) => ({ ...l, description: `${l.description} (kézi rögzítés)` })),
      orderNumber: null,
    };
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, keysOf(byHand))).toEqual([]);
  });

  it('another invoice under the same number differs in its key data', () => {
    const other: Invoice = {
      ...INVOICE_DOMESTIC,
      issueDate: '2026-10-26',
      customer: { ...CUSTOMER_EU },
      lines: INVOICE_EU_SERVICE.lines,
      totals: INVOICE_EU_SERVICE.totals,
      currency: 'EUR',
      exchangeRate: '390.12',
    };
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, keysOf(other))).toEqual(['kelte', 'vevő', 'pénznem', 'nettó összeg (HUF)', 'ÁFA (HUF)', 'bruttó összeg (HUF)']);
  });

  it('the buyer: the tax number decides when both have one, the name only without; a private person by the status', () => {
    const keys = keysOf(INVOICE_DOMESTIC);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, customerTaxpayerId: '11223346' })).toEqual(['vevő']);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, customerName: 'Egészen más név Kft.' })).toEqual([]);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, customerTaxpayerId: null })).toEqual([]);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, customerTaxpayerId: null, customerName: 'Egészen más név Kft.' })).toEqual(['vevő']);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, customerVatStatus: 'PRIVATE_PERSON', customerTaxpayerId: null, customerName: null })).toEqual(['vevő']);
    const privateKeys = keysOf(INVOICE_PRIVATE_AAM);
    expect(navInvoiceDifferences({ ...INVOICE_PRIVATE_AAM, customer: { ...CUSTOMER_PRIVATE, name: 'Bárki' } }, privateKeys)).toEqual([]);
    expect(navInvoiceDifferences(INVOICE_EU_SERVICE, { ...keysOf(INVOICE_EU_SERVICE), customerCommunityVatNumber: 'DE 999 999 999' })).toEqual(['vevő']);
  });

  it('amounts compare as decimals; a missing gross total is net + VAT; an unreadable document matches nothing', () => {
    const keys = keysOf(INVOICE_DOMESTIC);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, netAmountHuf: '154000.00', vatAmountHuf: '40700.0', grossAmountHuf: null })).toEqual([]);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, { ...keys, grossAmountHuf: '194701' })).toEqual(['bruttó összeg (HUF)']);
    expect(navInvoiceDifferences(INVOICE_DOMESTIC, parseInvoiceDataKeys('not xml'))).toHaveLength(7);
  });
});
