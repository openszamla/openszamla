/**
 * Hand-computed, internally consistent sample invoices shared by the NAV, PDF and service tests.
 * Amounts follow the calc rules: HUF amounts in whole forints, foreign currency amounts with 2
 * decimals and their HUF equivalents with 2 decimals.
 */
import type { CustomerData, Invoice, InvoiceLine, SellerProfile } from '../../src/core/types.ts';

export const SELLER_NORMAL: SellerProfile = {
  name: 'Példa Szoftver Kft.',
  taxNumber: '12345676-2-42',
  euVatNumber: 'HU12345676',
  address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Irinyi József utca 4-20.' },
  bankAccount: '12345676-11111111',
  bankName: 'OTP Bank',
  email: 'szamlazas@pelda.hu',
  vatStatus: 'normal',
  cashAccounting: false,
  smallBusiness: false,
};

export const SELLER_AAM: SellerProfile = {
  name: 'Kovács Anna e.v.',
  taxNumber: '11223346-1-06',
  address: { countryCode: 'HU', postalCode: '6720', city: 'Szeged', addressLine: 'Kárász utca 5.' },
  bankAccount: '12345676-11111111',
  vatStatus: 'aam',
  cashAccounting: false,
  smallBusiness: false,
};

export const CUSTOMER_DOMESTIC: CustomerData = {
  vatStatus: 'DOMESTIC',
  name: 'Árvíztűrő Tükörfúrógép Zrt.',
  taxNumber: '87654323-2-13',
  address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Október huszonharmadika utca 18.' },
  email: 'konyveles@arvizturo.hu',
};

export const CUSTOMER_PRIVATE: CustomerData = {
  vatStatus: 'PRIVATE_PERSON',
  name: 'Szőke Őrs',
  address: { countryCode: 'HU', postalCode: '4025', city: 'Debrecen', addressLine: 'Piac utca 20.' },
};

export const CUSTOMER_EU: CustomerData = {
  vatStatus: 'OTHER',
  name: 'Beispiel GmbH',
  euVatNumber: 'DE123456789',
  address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' },
};

const BASE = {
  status: 'issued' as const,
  seriesId: 'ser_0000000001',
  paymentStatus: 'unpaid' as const,
  paidAmount: '0',
  paidDate: null,
  navStatus: 'pending' as const,
  navTransactionId: null,
  navMessages: [],
  cancelledById: null,
  comment: null,
  internalNote: null,
  orderNumber: null,
  reference: null,
  customerId: null,
  exchangeRateDate: null,
  exchangeRateSource: null,
  language: 'hu' as const,
  appearance: 'ELECTRONIC' as const,
  createdAt: '2026-10-27T08:00:00.000Z',
  updatedAt: '2026-10-27T08:00:00.000Z',
  issuedAt: '2026-10-27T08:00:00.000Z',
  contentHash: null,
};

const DOMESTIC_LINES: InvoiceLine[] = [
  {
    lineNo: 1, description: 'Szoftverfejlesztés – október', quantity: '10', unit: 'óra', unitPrice: '15000', priceBasis: 'net',
    vatCode: '27', nature: 'SERVICE', netUnitPrice: '15000',
    netAmount: '150000', vatAmount: '40500', grossAmount: '190500',
    netAmountHuf: '150000', vatAmountHuf: '40500', grossAmountHuf: '190500',
  },
  {
    lineNo: 2, description: 'Szakkönyv: Őszi útmutató', quantity: '2', unit: 'db', unitPrice: '2000', priceBasis: 'net',
    vatCode: '5', nature: 'PRODUCT', netUnitPrice: '2000',
    netAmount: '4000', vatAmount: '200', grossAmount: '4200',
    netAmountHuf: '4000', vatAmountHuf: '200', grossAmountHuf: '4200',
  },
];

/** Domestic B2B, HUF, 27% + 5%, bank transfer. */
export const INVOICE_DOMESTIC: Invoice = {
  ...BASE,
  id: 'inv_00000000a1',
  documentType: 'invoice',
  number: 'SZ-2026-00001',
  issueDate: '2026-10-27',
  fulfillmentDate: '2026-10-27',
  dueDate: '2026-11-04',
  paymentMethod: 'TRANSFER',
  currency: 'HUF',
  exchangeRate: '1',
  seller: SELLER_NORMAL,
  customer: CUSTOMER_DOMESTIC,
  lines: DOMESTIC_LINES,
  totals: {
    netAmount: '154000', vatAmount: '40700', grossAmount: '194700',
    netAmountHuf: '154000', vatAmountHuf: '40700', grossAmountHuf: '194700',
    byVat: [
      { vatCode: '27', netAmount: '150000', vatAmount: '40500', grossAmount: '190500', netAmountHuf: '150000', vatAmountHuf: '40500', grossAmountHuf: '190500' },
      { vatCode: '5', netAmount: '4000', vatAmount: '200', grossAmount: '4200', netAmountHuf: '4000', vatAmountHuf: '200', grossAmountHuf: '4200' },
    ],
    payableAmount: '194700',
    roundingDifference: '0',
  },
  orderNumber: 'PO-7781',
  notations: [],
};

/** AAM seller → private person, cash, 0/5 Ft rounding (24 998 → 25 000). */
export const INVOICE_PRIVATE_AAM: Invoice = {
  ...BASE,
  id: 'inv_00000000a2',
  documentType: 'invoice',
  number: 'SZ-2026-00002',
  issueDate: '2026-10-27',
  fulfillmentDate: '2026-10-25',
  dueDate: '2026-10-27',
  paymentMethod: 'CASH',
  currency: 'HUF',
  exchangeRate: '1',
  seller: SELLER_AAM,
  customer: CUSTOMER_PRIVATE,
  lines: [
    {
      lineNo: 1, description: 'Kerámia bögre, kézzel festett', quantity: '2', unit: 'db', unitPrice: '12499', priceBasis: 'gross',
      vatCode: 'AAM', nature: 'PRODUCT', netUnitPrice: '12499',
      netAmount: '24998', vatAmount: '0', grossAmount: '24998',
      netAmountHuf: '24998', vatAmountHuf: '0', grossAmountHuf: '24998',
    },
  ],
  totals: {
    netAmount: '24998', vatAmount: '0', grossAmount: '24998',
    netAmountHuf: '24998', vatAmountHuf: '0', grossAmountHuf: '24998',
    byVat: [{ vatCode: 'AAM', netAmount: '24998', vatAmount: '0', grossAmount: '24998', netAmountHuf: '24998', vatAmountHuf: '0', grossAmountHuf: '24998' }],
    payableAmount: '25000',
    roundingDifference: '2',
  },
  notations: ['Alanyi adómentes (Áfa tv. XIII. fejezet)'],
};

/** EUR service to an EU business, place of supply abroad (EUFAD37), MNB rate 390.12. */
export const INVOICE_EU_SERVICE: Invoice = {
  ...BASE,
  id: 'inv_00000000a3',
  documentType: 'invoice',
  number: 'SZ-2026-00003',
  issueDate: '2026-10-27',
  fulfillmentDate: '2026-10-24',
  dueDate: '2026-11-10',
  paymentMethod: 'TRANSFER',
  currency: 'EUR',
  exchangeRate: '390.12',
  exchangeRateDate: '2026-10-23',
  exchangeRateSource: 'MNB',
  language: 'hu-en',
  seller: SELLER_NORMAL,
  customer: CUSTOMER_EU,
  lines: [
    {
      lineNo: 1, description: 'Consulting services / Tanácsadás', quantity: '10', unit: 'óra', unitPrice: '80', priceBasis: 'net',
      vatCode: 'EUFAD37', nature: 'SERVICE', netUnitPrice: '80',
      netAmount: '800', vatAmount: '0', grossAmount: '800',
      netAmountHuf: '312096', vatAmountHuf: '0', grossAmountHuf: '312096',
    },
  ],
  totals: {
    netAmount: '800', vatAmount: '0', grossAmount: '800',
    netAmountHuf: '312096', vatAmountHuf: '0', grossAmountHuf: '312096',
    byVat: [{ vatCode: 'EUFAD37', netAmount: '800', vatAmount: '0', grossAmount: '800', netAmountHuf: '312096', vatAmountHuf: '0', grossAmountHuf: '312096' }],
    payableAmount: '800',
    roundingDifference: '0',
  },
  notations: ['Fordított adózás – a teljesítés helye az Áfa tv. 37. § (1) bekezdése alapján a vevő tagállama / Reverse charge (Article 196 of Directive 2006/112/EC)'],
};

/** Storno of INVOICE_DOMESTIC (modificationIndex 1, lines negated, NAV line refs continue at 3). */
export const INVOICE_STORNO: Invoice = {
  ...INVOICE_DOMESTIC,
  id: 'inv_00000000a4',
  documentType: 'storno',
  number: 'SZ-2026-00004',
  issueDate: '2026-10-28',
  dueDate: '2026-10-28',
  orderNumber: null,
  comment: 'Sztornó oka: hibás vevő adatok',
  reference: { originalInvoiceId: 'inv_00000000a1', originalInvoiceNumber: 'SZ-2026-00001', modificationIndex: 1, modifyWithoutMaster: false },
  lines: DOMESTIC_LINES.map((l, i) => ({
    ...l,
    lineNo: i + 1,
    quantity: `-${l.quantity}`,
    netAmount: `-${l.netAmount}`, vatAmount: `-${l.vatAmount}`, grossAmount: `-${l.grossAmount}`,
    netAmountHuf: `-${l.netAmountHuf}`, vatAmountHuf: `-${l.vatAmountHuf}`, grossAmountHuf: `-${l.grossAmountHuf}`,
    modificationRef: { lineNumberReference: 3 + i, lineOperation: 'CREATE' as const },
  })),
  totals: {
    netAmount: '-154000', vatAmount: '-40700', grossAmount: '-194700',
    netAmountHuf: '-154000', vatAmountHuf: '-40700', grossAmountHuf: '-194700',
    byVat: [
      { vatCode: '27', netAmount: '-150000', vatAmount: '-40500', grossAmount: '-190500', netAmountHuf: '-150000', vatAmountHuf: '-40500', grossAmountHuf: '-190500' },
      { vatCode: '5', netAmount: '-4000', vatAmount: '-200', grossAmount: '-4200', netAmountHuf: '-4000', vatAmountHuf: '-200', grossAmountHuf: '-4200' },
    ],
    payableAmount: '-194700',
    roundingDifference: '0',
  },
  notations: ['Érvénytelenítő (sztornó) számla – az eredeti számla sorszáma: SZ-2026-00001'],
};

export const ALL_FIXTURES = { INVOICE_DOMESTIC, INVOICE_PRIVATE_AAM, INVOICE_EU_SERVICE, INVOICE_STORNO };
