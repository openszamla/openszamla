/** Zod input schemas shared by the MCP tools (zod v4). Descriptions are written for LLM callers. */
import * as z from 'zod/v4';
import { VAT_CODES } from '../core/vat.ts';
import type { VatCode } from '../core/types.ts';

export const decimal = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, 'Use a plain number with "." as decimal separator, e.g. "12.5"')])
  .describe('Number; "." decimal separator, no thousands separator (e.g. 12500 or "12.5")');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').describe('Date as YYYY-MM-DD');

export const vatCode = z
  .enum(VAT_CODES as [VatCode, ...VatCode[]])
  .describe(
    'VAT code (ÁFA-kód): "27"/"18"/"5"/"0" = VAT rate %; AAM = alanyi adómentes (small-business exempt seller); TAM = tárgyi adómentes (exempt activity, give vatReason); ' +
      'KBAET = intra-EU supply of goods; KBAUK = new means of transport to EU; EAM = export of goods outside EU; NAM = other exempt international transaction; ' +
      'ATK = outside the scope of VAT; EUFAD37 = B2B service to another EU country, buyer pays VAT (reverse charge); EUFADE = other EU reverse charge; EUE = taxed in another EU state, not reverse charge; ' +
      'HO = service supplied outside the EU; FAD = domestic reverse charge (fordított adózás); KUL_UTAZAS/KUL_HASZNALT/KUL_MUALKOTAS/KUL_REGISEG = margin schemes',
  );

export const paymentMethod = z
  .enum(['TRANSFER', 'CASH', 'CARD', 'VOUCHER', 'OTHER'])
  .describe('Payment method: TRANSFER = átutalás, CASH = készpénz, CARD = bankkártya, VOUCHER = utalvány, OTHER = egyéb');

export const language = z.enum(['hu', 'en', 'hu-en']).describe('Invoice language: hu, en or bilingual hu-en');

// Every object here is strict: an unknown (misspelt) key is rejected instead of silently dropped.
export const address = z
  .object({
    countryCode: z.string().length(2).optional().describe('ISO 3166-1 alpha-2, e.g. HU, DE (default HU; when updating a customer: the stored country)'),
    postalCode: z.string().min(1).describe('Irányítószám'),
    city: z.string().min(1).describe('Település'),
    addressLine: z.string().min(1).describe('Street, house number, floor/door (utca, házszám…)'),
    region: z.string().optional(),
  })
  .strict()
  .describe('Postal address');

export const customerVatStatus = z
  .enum(['DOMESTIC', 'OTHER', 'PRIVATE_PERSON'])
  .describe('DOMESTIC = Hungarian VAT-registered business (needs taxNumber); OTHER = foreign business (euVatNumber or thirdStateTaxId) or Hungarian non-VAT organisation; PRIVATE_PERSON = private individual (magánszemély)');

export const customerFields = {
  vatStatus: customerVatStatus,
  name: z.string().min(1).describe('Full legal name of the buyer'),
  taxNumber: z.string().optional().describe('Hungarian adószám, e.g. 12345676-2-42 (DOMESTIC)'),
  groupMemberTaxNumber: z.string().optional().describe('Csoporttag adószáma (only for VAT group members)'),
  euVatNumber: z.string().optional().describe('EU VAT number with country prefix, e.g. DE123456789'),
  thirdStateTaxId: z.string().optional().describe('Tax id of a buyer outside the EU'),
  address,
  email: z.string().optional(),
  phone: z.string().optional(),
  bankAccount: z.string().optional(),
};

/** Inline buyer of invoice_draft. */
export const customerInput = z
  .object({
    id: z.string().optional().describe('Existing customer id (cus_…) to update'),
    ...customerFields,
    note: z.string().optional().describe('Internal note (not printed)'),
  })
  .strict();

const clearable = (description: string) => z.string().nullable().optional().describe(`${description}; null or "" clears it`);

/** customer_save: a new customer, or (with id) only the fields to change. */
export const customerSaveInput = z
  .object({
    id: z.string().optional().describe('Existing customer id (cus_…): only the given fields change, the others keep their stored value'),
    vatStatus: customerVatStatus.optional().describe(`${customerVatStatus.description}. Required for a new customer`),
    name: z.string().min(1).optional().describe('Full legal name of the buyer. Required for a new customer'),
    taxNumber: clearable('Hungarian adószám, e.g. 12345676-2-42 (DOMESTIC)'),
    groupMemberTaxNumber: clearable('Csoporttag adószáma (only for VAT group members)'),
    euVatNumber: clearable('EU VAT number with country prefix, e.g. DE123456789'),
    thirdStateTaxId: clearable('Tax id of a buyer outside the EU'),
    address: address.optional().describe('Postal address, always complete (replaces the stored one). Required for a new customer'),
    email: clearable('E-mail'),
    phone: clearable('Phone'),
    bankAccount: clearable('Bank account'),
    note: clearable('Internal note (not printed)'),
    archived: z.boolean().optional().describe('true archives the customer (hidden from customer_find and the web customer picker unless includeArchived), false restores it'),
  })
  .strict();

export const lineInput = z.object({
  productId: z.string().optional().describe('Product id (prd_…); fills description, unit, price, priceBasis, VAT code and nature unless given explicitly'),
  description: z.string().max(512).optional().describe('Line text (megnevezés). Required unless productId is given'),
  quantity: decimal.describe('Quantity (mennyiség). Negative on correction lines and advance deductions; on other lines only e.g. for a discount – the tax base of an invoice cannot be negative'),
  unit: z.string().max(50).optional().describe('Unit as printed: db, óra, nap, hó, kg, l, m, km, csomag, alkalom … (default db). A service billed in db (or without a unit) should pass nature SERVICE'),
  unitPrice: decimal.optional().describe('Unit price in the invoice currency; net unless priceBasis is "gross". With productId and no priceBasis, the product\'s price basis applies – also to a unitPrice given here'),
  priceBasis: z.enum(['net', 'gross']).optional().describe('net = nettó egységár, gross = bruttó (VAT included). Default: the product\'s price basis with productId, otherwise net'),
  vatCode: vatCode.optional(),
  vatReason: z.string().max(200).optional().describe('Exact legal basis for exempt/out-of-scope codes, e.g. "Áfa tv. 85. § (1) e)"'),
  nature: z
    .enum(['PRODUCT', 'SERVICE', 'OTHER'])
    .optional()
    .describe(
      'Termék (PRODUCT) / szolgáltatás (SERVICE) / egyéb (OTHER), reported to NAV. Default: the product\'s nature with productId; else, without a unit or with db, the nature a VAT code implies (EUFAD37, HO → SERVICE; KBAET, KBAUK, EAM → PRODUCT); else from a given unit (óra, nap, hó … → SERVICE; db, kg … → PRODUCT); OTHER without a unit. A service billed in db should pass SERVICE',
    ),
  modifiesLineNo: z.number().int().positive().optional().describe('invoice_correct only: number of the ORIGINAL line this difference line refers to (informational: printed, not sent to NAV)'),
  advanceDeduction: z
    .object({
      advanceInvoiceNumber: z.string().describe('Number of the advance (előleg) invoice'),
      advancePaymentDate: isoDate.describe('Date the advance was paid'),
      advanceExchangeRate: decimal
        .optional()
        .describe('Exchange rate of the advance invoice (foreign currency only). Default: the rate of that advance invoice when it was issued in this program; required otherwise'),
    })
    .strict()
    .optional()
    .describe('Final invoice (végszámla) only: this line deducts an advance; give a NEGATIVE quantity or price'),
}).strict();

/** report_summary / export_invoices: which date of an invoice the period (from, to) is compared with. */
export const dateBasis = z
  .enum(['issue', 'fulfillment', 'payment'])
  .describe(
    'Which date puts an invoice into the period: "issue" = kelte, the issue date (default; invoice register view); "fulfillment" = teljesítés dátuma, the general VAT tax point (Áfa tv. 55. §) – ' +
      'use it for the VAT figures of a month (monthly close, VAT return): an invoice for September work issued on 3 October belongs to September. ' +
      'Exception: for a cash-accounting seller (pénzforgalmi elszámolás) the VAT is due when the payment is received (Áfa tv. 196/B. §) – use "payment" = the payment date: ' +
      'the payments and refunds dated in the period on the documents issued under cash accounting, each with the proportional part of the VAT of its document (payment × VAT ÷ gross, in HUF at the rate of the document, rounded to 0.01 per payment and VAT code); ' +
      'the notes say how, and the accountant decides what to declare',
  );

export const periodFrom = isoDate.describe('First day of the period, inclusive (YYYY-MM-DD); compared with the date chosen by dateBasis');
export const periodTo = isoDate.describe('Last day of the period, inclusive (YYYY-MM-DD); compared with the date chosen by dateBasis');

export const pagination = {
  limit: z.number().int().min(1).max(100).optional().describe('Max items (default 20)'),
  offset: z.number().int().min(0).optional().describe('Items to skip (default 0)'),
};
