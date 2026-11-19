/**
 * The product edit form keeps "automatikus (az egység alapján)": a nature the unit gives is shown as
 * automatikus, so correcting the unit re-infers it as product_save does; a nature chosen otherwise is
 * kept (WEB-7).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

const NEW = { name: 'Informatikai tanácsadás', unit: 'db', unitPrice: '15 000', priceBasis: 'net', currency: 'HUF', vatCode: '27', sku: '', description: '' };

describe('product edit form and the nature (WEB-7)', () => {
  it('db + automatikus, edited to óra without touching Jelleg, is stored as SERVICE', async () => {
    const e = await startWeb();
    envs.push(e);
    const b = await e.loggedIn();
    await b.get('/products');
    expect((await b.post('/products', { ...NEW, nature: '' })).status).toBe(303);
    const p = e.app.findProducts({}).items[0];
    expect([p?.unit, p?.nature]).toEqual(['db', 'PRODUCT']);

    const page = await b.get(`/products/${p?.id}`);
    const fields = formFields(page.body, `/products/${p?.id}`);
    expect(fields.nature).toBe('');
    expect((await b.post(`/products/${p?.id}`, { ...fields, unit: 'óra' })).status).toBe(303);
    expect(e.app.getProduct(p?.id as string)).toMatchObject({ unit: 'óra', nature: 'SERVICE' });
  });

  it('an explicit nature (OTHER, or SERVICE in db) is kept after a unit change', async () => {
    const e = await startWeb();
    envs.push(e);
    const b = await e.loggedIn();
    await b.get('/products');
    await b.post('/products', { ...NEW, name: 'Licenc', nature: 'OTHER' });
    await b.post('/products', { ...NEW, name: 'Tanácsadás', nature: 'SERVICE' });
    for (const [name, nature] of [['Licenc', 'OTHER'], ['Tanácsadás', 'SERVICE']] as const) {
      const p = e.app.findProducts({ text: name }).items[0];
      expect(p?.nature).toBe(nature);
      const page = await b.get(`/products/${p?.id}`);
      const fields = formFields(page.body, `/products/${p?.id}`);
      expect(fields.nature).toBe(nature);
      expect((await b.post(`/products/${p?.id}`, { ...fields, unit: 'alkalom' })).status).toBe(303);
      expect(e.app.getProduct(p?.id as string)).toMatchObject({ unit: 'alkalom', nature });
    }
  });
});
