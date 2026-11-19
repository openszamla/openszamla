/**
 * WEB-15: a page number past the end of a non-empty list (an old link, records deleted since) says so
 * and links to the last page – it does not claim that there are no records. Empty lists and empty
 * filter results keep their texts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOMER_DOMESTIC, INVOICE_DOMESTIC, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { insertCustomer, insertDraft, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

const hex = (i: number): string => i.toString(16).padStart(10, '0');

describe('paged lists past the last page', () => {
  it('/invoices, /customers and /products: "Ez az oldal üres – utolsó oldal: 2." with a link that keeps the filters', async () => {
    const e = await startWeb();
    envs.push(e);
    e.app.store.setSetting('seller', SELLER_NORMAL);
    for (let i = 1; i <= 30; i++) {
      insertDraft(e.app, INVOICE_DOMESTIC, { id: `inv_${hex(i)}` });
      insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: `cus_${hex(i)}`, name: `Vevő ${i}`, taxNumber: `8765432${i % 10}-2-13` });
      e.app.saveProduct({ name: `Termék ${i}`, unit: 'db', unitPrice: '1000', vatCode: '27' });
    }
    const b = await e.loggedIn();
    const cases: Array<[string, string, string]> = [
      ['/invoices?page=3', '/invoices?page=2', 'Még nincs bizonylat.'],
      ['/invoices?status=draft&page=3', '/invoices?status=draft&amp;page=2', 'Nincs a szűrésnek megfelelő bizonylat.'],
      ['/customers?page=3', '/customers?page=2', 'Még nincs elmentett vevő.'],
      ['/customers?q=Vev%C5%91&page=5', '/customers?q=Vev%C5%91&amp;page=2', 'Nincs a keresésnek megfelelő vevő.'],
      ['/products?page=3', '/products?page=2', 'Még nincs elmentett termék vagy szolgáltatás.'],
    ];
    for (const [path, last, emptyText] of cases) {
      const r = await b.get(path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toContain('Ez az oldal üres – utolsó oldal: 2.');
      expect(r.body, path).toContain(`<a href="${last}">Ugrás az utolsó oldalra</a>`);
      expect(r.body, path).not.toContain(emptyText);
    }
    // The last page itself is a normal page.
    expect((await b.get('/customers?page=2')).body).toContain('26–30 / 30 találat');
  });

  it('a truly empty list and an empty search result keep their texts, on any page', async () => {
    const e = await startWeb();
    envs.push(e);
    insertCustomer(e.app, { ...CUSTOMER_DOMESTIC, id: 'cus_00000000c1' });
    const b = await e.loggedIn();
    expect((await b.get('/invoices?page=3')).body).toContain('Még nincs bizonylat.');
    expect((await b.get('/products?page=2')).body).toContain('Még nincs elmentett termék vagy szolgáltatás.');
    const search = await b.get('/customers?q=nincsilyen&page=2');
    expect(search.body).toContain('Nincs a keresésnek megfelelő vevő.');
    expect(search.body).not.toContain('Ez az oldal üres');
  });
});
