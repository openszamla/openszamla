import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateNavXml } from '../helpers/nav-xsd.ts';

const SAMPLES = new URL('../../vendor/nav-online-invoice/samples/data/', import.meta.url);

describe('NAV XSD harness', () => {
  const files = readdirSync(SAMPLES).filter((f) => f.endsWith('.xml'));

  it('finds the official NAV data samples', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('official sample %s is valid against invoiceData.xsd', async (file) => {
    const xml = readFileSync(new URL(file, SAMPLES), 'utf8');
    const res = await validateNavXml(xml, 'data');
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('rejects elements in the wrong order', async () => {
    const xml = readFileSync(new URL('belfoldi-termekertekesites.xml', SAMPLES), 'utf8');
    const broken = xml.replace(/(<invoiceNumber>[^<]*<\/invoiceNumber>)(\s*)(<invoiceIssueDate>[^<]*<\/invoiceIssueDate>)/, '$3$2$1');
    expect(broken).not.toBe(xml);
    const res = await validateNavXml(broken, 'data');
    expect(res.valid).toBe(false);
  });
});
