/**
 * The statutory tax-audit export (adóhatósági ellenőrzési adatszolgáltatás) from the web UI: someone who uses only the
 * browser could not make it – it took the command line or an AI client. The Export page has its own form for it: by
 * issue-date range, or by number range; the folder it wrote is named, and a mistake is explained on the page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

describe('the tax-audit export form of the Export page', () => {
  it('by date range and by number range: the export folder is written and named; an empty range is explained', async () => {
    const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
    envs.push(e);
    e.app.updateSeller(SELLER_INPUT);
    const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const numbers: string[] = [];
    for (const unitPrice of ['10000', '20000']) {
      const d = await e.app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
      numbers.push((await e.app.issue(d.invoice.id)).invoice.number as string);
    }
    const b = await e.loggedIn();
    const action = '/export/tax-audit';
    const page = await b.get('/export');
    expect(page.body).toContain('<h2 id="h-audit-export">Adóhatósági ellenőrzési adatszolgáltatás</h2>');
    const fields = formFields(page.body, action);
    expect(Object.keys(fields).sort()).toEqual(['_csrf', 'auditFrom', 'auditTo', 'fromNumber', 'toNumber']);

    const byDate = await b.post(action, { ...fields, auditFrom: '2026-11-01', auditTo: '2026-11-30' });
    expect(byDate.status).toBe(200);
    expect(flashesOf(byDate.body)).toBe('Az adóhatósági ellenőrzési adatszolgáltatás elkészült: 2 számla (2026.11.01. – 2026.11.30.).');
    const folder = /Mappa a szerveren: ([^<]+)</.exec(byDate.body)?.[1] ?? '';
    expect(existsSync(join(folder, 'szamlak.xml'))).toBe(true);
    expect(readFileSync(join(folder, 'szamlak.xml'), 'utf8')).toContain(numbers[0] as string);

    const byNumber = await b.post(action, { ...formFields(byDate.body, action), fromNumber: numbers[1] as string, toNumber: numbers[1] as string });
    expect(flashesOf(byNumber.body)).toBe(`Az adóhatósági ellenőrzési adatszolgáltatás elkészült: 1 számla (${numbers[1]} – ${numbers[1]}).`);
    // What was typed stays in the form.
    expect(formFields(byNumber.body, action).fromNumber).toBe(numbers[1]);

    const empty = await b.post(action, { ...fields, auditFrom: '2025-01-01', auditTo: '2025-01-31' });
    expect(empty.status).toBe(422);
    expect(flashesOf(empty.body)).toBe('A megadott tartományban nincs kiállított számla.');
    const half = await b.post(action, { ...fields, fromNumber: numbers[0] as string });
    expect(half.status).toBe(422);
    expect(flashesOf(half.body)).toBe('Sorszámtartománynál a kezdő és a záró sorszám is kötelező.');
  });
});
