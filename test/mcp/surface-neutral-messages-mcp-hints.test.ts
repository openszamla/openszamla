/**
 * U4: the messages of src/core and src/service that reach the web UI (and the command line) never name an MCP tool or
 * an MCP field: a typo in a tax number does not send a web user to "taxpayer_lookup", a díjbekérő payment that is not
 * carried over does not say "invoice_record_payment". The MCP adapter adds that advice by error / issue code
 * (src/mcp/hints.ts), so an agent still gets the tool and the field.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/core/format.ts';
import type { ValidationIssue } from '../../src/core/types.ts';
import { validateCustomer, validateSeller } from '../../src/core/validate.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb } from '../web/helpers.ts';

type Json = Record<string, any>;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** Fields of the MCP tool inputs that the neutral texts used to name. */
const MCP_FIELDS = ['exchangeRate', 'vatReason', 'nature', 'thirdStateTaxId', 'groupMemberTaxNumber', 'advanceExchangeRate', 'advanceDeduction', 'customerId', 'seriesId', 'markPaid', 'draftId', 'countryCode', 'postalCode', 'addressLine', 'unitPrice', 'vatCode'];

let TOOLS: string[] = [];
beforeAll(async () => {
  const t = makeTestApp();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientT);
  TOOLS = (await client.listTools()).tools.map((x) => x.name);
  await client.close();
  await handle.close();
  t.cleanup();
  expect(TOOLS).toEqual(expect.arrayContaining(['taxpayer_lookup', 'invoice_record_payment', 'seller_update', 'invoice_draft']));
});

/** The MCP tool and field names `text` mentions (as whole words). */
function mcpNames(text: string): string[] {
  return [...TOOLS, ...MCP_FIELDS].filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(text));
}

/** Source text without comments – strings and template literals kept – so only what the program says is searched. */
function withoutComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

async function connect(app: OpenSzamla): Promise<(name: string, args: Json) => Promise<{ isError: boolean; sc: Json }>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(app), { transport: serverT });
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientT);
  cleanups.push(async () => {
    await client.close();
    await handle.close();
  });
  return async (name, args) => {
    const r = (await client.callTool({ name, arguments: args })) as Json;
    return { isError: r.isError === true, sc: r.structuredContent as Json };
  };
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string; hint?: string; details?: Json }> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e as { code: string; message: string; hint?: string; details?: Json };
  }
  throw new Error('nothing was refused');
}

const BAD_CHECK_DIGIT = '12345678-1-42';
const LINE = { description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' as const };
const EU_BUSINESS = { vatStatus: 'OTHER' as const, name: 'Beispiel GmbH', euVatNumber: 'DE123456789', address: { countryCode: 'DE', postalCode: '10115', city: 'Berlin', addressLine: 'Invalidenstraße 1' } };

describe('core and service messages are surface-neutral (U4)', () => {
  it('no string of src/core names an MCP tool', () => {
    const dir = join(ROOT, 'src', 'core');
    const found: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const names = TOOLS.filter((n) => withoutComments(readFileSync(join(dir, f), 'utf8')).includes(n));
      if (names.length) found.push(`${f}: ${names.join(', ')}`);
    }
    expect(found).toEqual([]);
  });

  it('the errors the web gets name no MCP tool or field', async () => {
    const t = makeTestApp({ now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => t.cleanup());
    const app = t.app;
    const errors = [await refusal(() => app.updateSeller({ ...SELLER_INPUT, taxNumber: BAD_CHECK_DIGIT }))];
    app.updateSeller({ ...SELLER_INPUT, bankAccount: null });
    errors.push(await refusal(() => app.saveCustomer({ ...DOMESTIC_CUSTOMER_INPUT, taxNumber: BAD_CHECK_DIGIT })));
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    errors.push(await refusal(() => app.saveCustomer(DOMESTIC_CUSTOMER_INPUT)));
    const old = app.listSeries('invoice').find((s) => s.isDefault)?.id as string;
    const draft = await app.createDraft({ customerId, lines: [LINE] });
    app.createSeries({ kind: 'invoice', name: 'Új', pattern: 'UJ-{YYYY}-{SEQ:4}', isDefault: true });
    app.updateSeries(old, { archived: true });
    errors.push(await refusal(app.createDraft({ customerId, seriesId: old, lines: [LINE] })));
    errors.push(await refusal(app.issue(draft.invoice.id)));
    const issued = (await app.issue((await app.createDraft({ customerId, lines: [LINE] })).invoice.id)).invoice;
    errors.push(await refusal(app.updateDraft(issued.id, { comment: 'x' })));
    errors.push(await refusal(() => app.deleteDraft(issued.id)));
    errors.push(await refusal(app.issue(issued.id)));
    const final = await app.createDraft({ customerId, documentType: 'final', lines: [LINE] });
    errors.push(await refusal(app.issue(final.invoice.id)));
    const reason = app.cancelReason(issued.id, 'Téves vevő');
    const confirmed = app.cancelFingerprint(issued.id, reason);
    await app.issue((await app.createCorrectionDraft(issued.id, { lines: [{ ...LINE, quantity: '-1', unitPrice: '1000' }], comment: 'Engedmény' })).invoice.id);
    errors.push(await refusal(app.cancel(issued.id, { reason, confirmedFingerprint: confirmed })));
    expect(errors.map((e) => e.code)).toEqual([
      'INVALID_TAX_NUMBER', 'INVALID_TAX_NUMBER', 'DUPLICATE_CUSTOMER', 'SERIES_ARCHIVED', 'SERIES_ARCHIVED', 'NOT_A_DRAFT', 'NOT_A_DRAFT', 'NOT_A_DRAFT', 'VALIDATION_FAILED', 'STORNO_CHAIN_CHANGED',
    ]);
    for (const e of errors) expect(mcpNames(`${e.message} ${e.hint ?? ''}`), `${e.code}: ${e.message} ${e.hint ?? ''}`).toEqual([]);
    expect(errors[0]?.message).toMatch(/ellenőrző számjegye \(8\. jegy\) nem stimmel – valószínűleg elírás\. Ellenőrizd az adószámot\.$/);
    expect(errors[1]?.hint).toBe('Formátum: 12345676-1-23. Nézd meg a partner korábbi számláján vagy a cégkivonatán.');
  });

  it('the validation issues of a draft and the notes of issuing name no MCP tool or field', async () => {
    const t = makeTestApp({ now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => t.cleanup());
    const app = t.app;
    app.updateSeller({ ...SELLER_INPUT, bankAccount: null });
    app.updateDefaults({ exchangeRateSource: 'manual' });
    const domestic = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const eu = app.saveCustomer(EU_BUSINESS).customer.id;
    const issues: ValidationIssue[] = [
      ...validateSeller(null as never),
      ...validateCustomer({ ...DOMESTIC_CUSTOMER_INPUT, taxNumber: BAD_CHECK_DIGIT, address: undefined as never }),
      ...validateCustomer({ ...EU_BUSINESS, euVatNumber: 'GB123456789' }),
      ...(await app.createDraft({ customerId: domestic, lines: [{ ...LINE, vatCode: 'TAM' }] })).issues,
      ...(await app.createDraft({ customerId: eu, currency: 'EUR', lines: [{ ...LINE, vatCode: 'EUFAD37', nature: 'PRODUCT' }] })).issues,
      ...(await app.createDraft({ customerId: eu, lines: [{ ...LINE, unit: 'db', nature: 'PRODUCT' }] })).issues,
      ...(await app.createDraft({ customerId: domestic, documentType: 'final', lines: [LINE] })).issues,
    ];
    // A paid díjbekérő, withdrawn: its payment is not carried over to the invoice made from it.
    const proforma = (await app.issue((await app.createDraft({ customerId: domestic, documentType: 'proforma', lines: [LINE] })).invoice.id)).invoice;
    app.recordPayment(proforma.id, { date: '2026-11-19' });
    await app.cancel(proforma.id, { reason: 'Visszavont ajánlat' });
    const converted = await app.createDraft({ copyFromId: proforma.id, fulfillmentDate: '2026-11-19' });
    issues.push(...converted.issues);
    const codes = issues.map((i) => i.code);
    for (const code of [
      'SELLER_MISSING', 'CUSTOMER_TAX_NUMBER_INVALID', 'CUSTOMER_ADDRESS_REQUIRED', 'CUSTOMER_EU_VAT_NUMBER_INVALID', 'SELLER_BANK_ACCOUNT_MISSING', 'LINE_EXEMPTION_REFERENCE_RECOMMENDED',
      'EXCHANGE_RATE_MISSING', 'LINE_NATURE_MISMATCH', 'EU_B2B_GOODS_WITH_HU_VAT', 'FINAL_WITHOUT_ADVANCE_DEDUCTION', 'PROFORMA_PAYMENT_NOT_CARRIED',
    ]) {
      expect(codes, code).toContain(code);
    }
    for (const i of issues) expect(mcpNames(i.message), `${i.code}: ${i.message}`).toEqual([]);
    const r = await app.issue(converted.invoice.id, { markPaid: true });
    for (const n of r.notes.filter((x) => !/NAV/.test(x))) expect(mcpNames(n), n).toEqual([]);
    expect(r.notes).toContain(`A(z) ${proforma.number} díjbekérőre rögzített befizetés (${formatMoney('25400', 'HUF')}) nem került át: a díjbekérő vissza van vonva. Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.`);
  });

  it('MCP adds the tool and the field: errors by code, issues in their hint', async () => {
    const t = makeTestApp({ confirmMode: 'none', now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => t.cleanup());
    const call = await connect(t.app);
    await call('seller_update', SELLER_INPUT);
    const bad = await call('customer_save', { ...DOMESTIC_CUSTOMER_INPUT, taxNumber: BAD_CHECK_DIGIT });
    expect(bad.isError).toBe(true);
    expect(bad.sc.error.code).toBe('INVALID_TAX_NUMBER');
    expect(bad.sc.error.hint).toBe(
      'Formátum: 12345676-1-23. Nézd meg a partner korábbi számláján vagy a cégkivonatán. MCP: a NAV adószám-lekérdezése (taxpayer_lookup) megmutatja, milyen adószámmal és névvel szerepel a partner a NAV-nál.',
    );
    const customer = (await call('customer_save', DOMESTIC_CUSTOMER_INPUT)).sc.customer;
    const duplicate = await call('customer_save', DOMESTIC_CUSTOMER_INPUT);
    expect(duplicate.sc.error.hint).toContain(`customerId: "${customer.id}"`);

    const tam = await call('invoice_draft', { customerId: customer.id, lines: [{ ...LINE, vatCode: 'TAM' }] });
    const exemption = (tam.sc.issues as Json[]).find((i) => i.code === 'LINE_EXEMPTION_REFERENCE_RECOMMENDED');
    expect(exemption?.message).not.toContain('vatReason');
    expect(exemption?.hint).toBe('MCP: a jogszabályhely a tétel vatReason mezője (invoice_draft).');

    const final = await call('invoice_draft', { customerId: customer.id, documentType: 'final', lines: [LINE] });
    const refused = await call('invoice_issue', { draftId: final.sc.invoice.id });
    expect(refused.sc.error.code).toBe('VALIDATION_FAILED');
    expect((refused.sc.error.details.issues as Json[]).find((i) => i.code === 'FINAL_WITHOUT_ADVANCE_DEDUCTION')?.hint).toContain('advanceDeduction');

    const issued = await call('invoice_issue', { draftId: tam.sc.invoice.id });
    const notDraft = await call('invoice_draft', { draftId: issued.sc.invoice.id, comment: 'x' });
    expect(notDraft.sc.error).toMatchObject({ code: 'NOT_A_DRAFT', hint: expect.stringContaining('invoice_correct') });

    const old = t.app.listSeries('invoice').find((s) => s.isDefault)?.id as string;
    await call('series_manage', { action: 'create', kind: 'invoice', name: 'Új', pattern: 'UJ-{YYYY}-{SEQ:4}', isDefault: true });
    await call('series_manage', { action: 'update', id: old, archived: true });
    const archived = await call('invoice_draft', { customerId: customer.id, seriesId: old, lines: [LINE] });
    expect(archived.sc.error.code).toBe('SERIES_ARCHIVED');
    expect(archived.sc.error.hint).toContain(`series_manage { action: "update", id: "${old}", archived: false }`);
  });

  it('the web: a mistyped tax number on the seller and the customer form names no MCP tool', async () => {
    const e = await startWeb({ now: () => new Date('2026-11-19T09:00:00.000Z') });
    cleanups.push(() => e.close());
    const b = await e.loggedIn();
    const hintsOf = (body: string): string => [...body.matchAll(/<p class="flash-hint">([\s\S]*?)<\/p>/g)].map((m) => m[1]).join(' | ');
    const show = async (r: Awaited<ReturnType<typeof b.post>>) => (r.status === 303 ? b.follow(r) : r);

    const settings = await b.get('/settings');
    const seller = await show(await b.post('/settings/seller', { ...formFields(settings.body, '/settings/seller'), name: SELLER_INPUT.name, taxNumber: BAD_CHECK_DIGIT, postalCode: '1117', city: 'Budapest', addressLine: 'Irinyi József utca 4.' }));
    expect(flashesOf(seller.body)).toMatch(/ellenőrző számjegye \(8\. jegy\) nem stimmel – valószínűleg elírás\. Ellenőrizd az adószámot\./);
    expect(mcpNames(`${flashesOf(seller.body)} ${hintsOf(seller.body)}`)).toEqual([]);

    e.app.updateSeller(SELLER_INPUT);
    const customers = await b.get('/customers');
    const fields = formFields(customers.body, '/customers');
    const customer = await show(await b.post('/customers', { ...fields, vatStatus: 'DOMESTIC', name: 'Minta Kft.', taxNumber: BAD_CHECK_DIGIT, postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' }));
    expect(flashesOf(customer.body)).toMatch(/Érvénytelen vevői adószám: .*Ellenőrizd az adószámot\./);
    expect(mcpNames(`${flashesOf(customer.body)} ${hintsOf(customer.body)}`)).toEqual([]);
  });
});
