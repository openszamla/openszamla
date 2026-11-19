/**
 * Invoice → PDF (pdfmake 0.3, embedded Roboto font: full Hungarian character coverage ő/ű/Ő/Ű).
 *
 * CONTRACT FILE – keep the signatures. Requirements:
 * - Prints EVERY mandatory element of Áfa tv. 169. § (see docs/research/02-jogi-kovetelmenyek.md):
 *   title by document type (SZÁMLA / ELŐLEGSZÁMLA / VÉGSZÁMLA / MÓDOSÍTÓ SZÁMLA / SZTORNÓ SZÁMLA /
 *   DÍJBEKÉRŐ – "nem számla"), number, issue date, fulfillment date, due date, payment method,
 *   seller & buyer blocks (name, address, tax numbers, EU VAT numbers, bank account), lines (description,
 *   quantity + unit, net unit price, net amount, VAT label, VAT amount, gross amount), VAT summary
 *   per VAT code, totals, HUF amounts and exchange rate for foreign currency (at least the VAT in HUF),
 *   cash payable amount with rounding, mandatory notations (invoice.notations), reference to the
 *   original invoice for storno/modification, comment, order number, page numbers "1/2".
 * - Languages: 'hu', 'en', 'hu-en' (bilingual labels "Számla / Invoice").
 * - Options: draft watermark ("TERVEZET – NEM SZÁMLA"), copy marking ("MÁSOLAT").
 * - pdfmake server setup: setUrlAccessPolicy(() => false); setLocalAccessPolicy allowing only the
 *   bundled font directory; never load remote resources.
 * - Deterministic output for the same input (fixed creation date = issuedAt/createdAt in metadata).
 *
 * Implementation: ./document.ts builds the pdfmake document definition (layout, legal content),
 * ./labels.ts holds the HU/EN texts, ./engine.ts configures pdfmake (fonts, access policies).
 * The output is byte-for-byte identical for identical input (pdfkit derives the file ID from the
 * metadata, and the creation date comes from the invoice).
 */
import type { Invoice } from '../core/types.ts';
import { buildInvoiceDocument } from './document.ts';
import { renderPdfBuffer } from './engine.ts';

export interface PdfOptions {
  draft?: boolean;
  copy?: boolean;
  /** Printed in the footer, e.g. "OpenSzámla 0.1.0". */
  softwareName?: string;
}

/** Footer / metadata software name when the caller does not pass one. */
export const DEFAULT_SOFTWARE_NAME = 'OpenSzámla';

export async function renderInvoicePdf(invoice: Invoice, opts: PdfOptions = {}): Promise<Buffer> {
  // A document without a number is never an invoice: it always gets the draft watermark,
  // even if the caller forgot to ask for it.
  const draft = opts.draft === true || invoice.status === 'draft' || invoice.number === null;
  const softwareName = opts.softwareName?.trim() || DEFAULT_SOFTWARE_NAME;
  const doc = buildInvoiceDocument(invoice, { draft, copy: opts.copy === true, softwareName });
  return renderPdfBuffer(doc);
}
