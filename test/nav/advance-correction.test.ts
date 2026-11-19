import { describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { buildInvoiceDataXml } from '../../src/nav/invoice-data.ts';
import { INVOICE_STORNO } from '../fixtures/invoices.ts';
import { validateNavXml } from '../helpers/nav-xsd.ts';

describe('corrections of an advance invoice', () => {
  it('keep advanceIndicator on every line (the original was an előlegszámla)', async () => {
    const storno: Invoice = {
      ...INVOICE_STORNO,
      reference: { ...(INVOICE_STORNO.reference as NonNullable<Invoice['reference']>), originalDocumentType: 'advance' },
    };
    const xml = buildInvoiceDataXml(storno);
    expect(xml.match(/<advanceIndicator>true<\/advanceIndicator>/g)?.length).toBe(storno.lines.length);
    const res = await validateNavXml(xml, 'data');
    expect(res.errors).toEqual([]);
  });

  it('do not mark corrections of normal invoices as advance', () => {
    expect(buildInvoiceDataXml(INVOICE_STORNO)).not.toContain('advanceIndicator');
  });
});
