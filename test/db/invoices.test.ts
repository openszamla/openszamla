import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts';
import { AppError } from '../../src/core/errors.ts';
import type { Customer, Invoice, InvoiceTotals, SellerProfile, Series } from '../../src/core/types.ts';
import { Store, mapDbError } from '../../src/db/store.ts';
import type { InvoiceMutablePatch } from '../../src/db/store.ts';

// ---------------------------------------------------------------------------------------------
// helpers & fixtures
// ---------------------------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-inv-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clock(start = '2026-10-27T10:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => {
    t += 1000;
    return new Date(t);
  };
}

function openRaw(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw new Error(`expected an AppError, got: ${String(e)}`);
  }
  throw new Error('expected an AppError, but the call succeeded');
}

function codeOf(fn: () => unknown): string {
  return errorOf(fn).code;
}

/** Runs a raw statement that must fail; returns the SQLite error message. */
function rawFailure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected the raw statement to fail');
}

function rawError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the raw statement to fail');
}

const ADDRESS = { countryCode: 'HU', postalCode: '1111', city: 'Budapest', addressLine: 'Fő utca 1.' };

const SELLER: SellerProfile = {
  name: 'Teszt Eladó Kft.',
  taxNumber: '12345676-2-42',
  address: ADDRESS,
  bankAccount: '11773016-11111018',
  vatStatus: 'normal',
  cashAccounting: false,
  smallBusiness: false,
};

function customer(id: string, name: string): Customer {
  return {
    id,
    vatStatus: 'DOMESTIC',
    name,
    taxNumber: id === 'cus_arv' ? '24366183-2-13' : '17781799-5-44',
    address: ADDRESS,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function series(over: Partial<Series>): Series {
  return {
    id: 'ser_inv',
    kind: 'invoice',
    name: 'Számlák',
    pattern: 'SZ-{YYYY}-{SEQ:5}',
    yearlyReset: true,
    nextSeq: 1,
    seqYear: null,
    isDefault: true,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** Totals of a single 27 % line with the given net amount (HUF). */
function totals(net: number): InvoiceTotals {
  const vat = Math.round(net * 0.27);
  const n = String(net);
  const v = String(vat);
  const g = String(net + vat);
  return {
    netAmount: n,
    vatAmount: v,
    grossAmount: g,
    netAmountHuf: n,
    vatAmountHuf: v,
    grossAmountHuf: g,
    byVat: [{ vatCode: '27', netAmount: n, vatAmount: v, grossAmount: g, netAmountHuf: n, vatAmountHuf: v, grossAmountHuf: g }],
    payableAmount: g,
    roundingDifference: '0',
  };
}

let counter = 0;

/** A minimal but complete, valid draft invoice (one 27 % service line, HUF, transfer). */
function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  counter++;
  const t = over.totals ?? totals(10000);
  return {
    id: `inv_${String(counter).padStart(4, '0')}`,
    documentType: 'invoice',
    status: 'draft',
    seriesId: 'ser_inv',
    number: null,
    issueDate: '2026-10-27',
    fulfillmentDate: '2026-10-27',
    dueDate: '2026-11-04',
    paymentMethod: 'TRANSFER',
    currency: 'HUF',
    exchangeRate: '1',
    exchangeRateDate: null,
    exchangeRateSource: null,
    language: 'hu',
    appearance: 'ELECTRONIC',
    seller: SELLER,
    customerId: 'cus_arv',
    customer: { vatStatus: 'DOMESTIC', name: 'Árvíztűrő Kft.', taxNumber: '24366183-2-13', address: ADDRESS },
    lines: [
      {
        lineNo: 1,
        description: 'Tanácsadás',
        quantity: '1',
        unit: 'óra',
        unitPrice: t.netAmount,
        priceBasis: 'net',
        vatCode: '27',
        nature: 'SERVICE',
        netUnitPrice: t.netAmount,
        netAmount: t.netAmount,
        vatAmount: t.vatAmount,
        grossAmount: t.grossAmount,
        netAmountHuf: t.netAmountHuf,
        vatAmountHuf: t.vatAmountHuf,
        grossAmountHuf: t.grossAmountHuf,
      },
    ],
    totals: t,
    comment: null,
    internalNote: null,
    orderNumber: null,
    reference: null,
    notations: [],
    paymentStatus: 'unpaid',
    paidAmount: '0',
    paidDate: null,
    navStatus: 'not_applicable',
    navTransactionId: null,
    navMessages: [],
    cancelledById: null,
    createdAt: '2026-10-27T08:00:00.000Z',
    updatedAt: '2026-10-27T08:00:00.000Z',
    issuedAt: null,
    contentHash: null,
    ...over,
  };
}

const MUTABLE = ['status', 'paymentStatus', 'paidAmount', 'paidDate', 'navStatus', 'navTransactionId', 'navMessages', 'navEnvironment', 'cancelledById', 'updatedAt'];

function immutablePart(inv: Invoice): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...inv };
  for (const k of [...MUTABLE, 'contentHash']) delete doc[k];
  return doc;
}

function setup(path = ':memory:'): Store {
  const store = new Store({ path, now: clock() });
  cleanups.push(() => store.close());
  store.insertSeries(series({}));
  store.insertSeries(series({ id: 'ser_pro', kind: 'proforma', name: 'Díjbekérők', pattern: 'DB-{YYYY}-{SEQ:5}' }));
  store.insertCustomer(customer('cus_arv', 'Árvíztűrő Kft.'));
  store.insertCustomer(customer('cus_tuk', 'Tükörfúrógép Bt.'));
  return store;
}

function draft(store: Store, over: Partial<Invoice> = {}): Invoice {
  const inv = makeInvoice(over);
  store.insertDraft(inv);
  return inv;
}

/** The service-layer issuing flow: allocate the number and mark the draft issued in ONE transaction. */
function issue(store: Store, d: Invoice, issuedAt = '2026-10-27T11:00:00.000Z'): Invoice {
  return store.tx(() => {
    const { seq, year } = store.allocateSequence(d.seriesId, d.issueDate);
    const prefix = d.seriesId === 'ser_pro' ? 'DB' : 'SZ';
    const issued: Invoice = { ...d, status: 'issued', number: `${prefix}-${year}-${String(seq).padStart(5, '0')}`, issuedAt };
    issued.contentHash = sha256Hex(canonicalJson(immutablePart(issued)));
    store.markIssued(issued);
    return issued;
  });
}

function mustGet(store: Store, id: string): Invoice {
  const inv = store.getInvoice(id);
  if (!inv) throw new Error(`invoice not found: ${id}`);
  return inv;
}

// ---------------------------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------------------------

describe('drafts', () => {
  it('insertDraft + getInvoice round-trip the whole document', () => {
    const store = setup();
    const d = makeInvoice({
      comment: 'Köszönjük a megrendelést!',
      orderNumber: 'PO-77',
      internalNote: 'belső megjegyzés',
      notations: ['Fordított adózás'],
      seller: { ...SELLER, euVatNumber: 'HU12345676', invoiceFooter: 'Lábléc' },
    });
    store.insertDraft(d);
    expect(store.getInvoice(d.id)).toEqual(d);
    expect(store.getInvoice('inv_unknown')).toBeNull();
    expect(store.getInvoiceByNumber('SZ-2026-00001')).toBeNull();
  });

  it('insertDraft rejects non-draft invoices', () => {
    const store = setup();
    for (const status of ['issued', 'cancelled'] as const) {
      const inv = makeInvoice({ status, number: 'SZ-2026-00099', issuedAt: '2026-10-27T11:00:00.000Z', contentHash: 'a'.repeat(64) });
      expect(codeOf(() => store.insertDraft(inv))).toBe('NOT_A_DRAFT');
      expect(store.getInvoice(inv.id)).toBeNull();
    }
  });

  it('insertDraft rejects duplicates, unknown references and invalid data', () => {
    const store = setup();
    const d = draft(store);
    expect(codeOf(() => store.insertDraft(d))).toBe('ALREADY_EXISTS');
    expect(codeOf(() => store.insertDraft(makeInvoice({ seriesId: 'ser_unknown' })))).toBe('NOT_FOUND');
    expect(codeOf(() => store.insertDraft(makeInvoice({ customerId: 'cus_unknown' })))).toBe('NOT_FOUND');
    const ref = { originalInvoiceId: 'inv_unknown', originalInvoiceNumber: 'X', modificationIndex: 1, modifyWithoutMaster: false };
    expect(codeOf(() => store.insertDraft(makeInvoice({ documentType: 'storno', reference: ref })))).toBe('NOT_FOUND');
    expect(codeOf(() => store.insertDraft(makeInvoice({ issueDate: '2026-02-30' })))).toBe('INVALID_DATE');
    expect(codeOf(() => store.insertDraft(makeInvoice({ dueDate: '04/11/2026' })))).toBe('INVALID_DATE');
    expect(codeOf(() => store.insertDraft(makeInvoice({ paidAmount: '12,5' })))).toBe('INVALID_NUMBER');
    expect(codeOf(() => store.insertDraft(makeInvoice({ totals: { ...totals(1), grossAmount: '1e3' } })))).toBe('INVALID_NUMBER');
    const bogusType = makeInvoice({ documentType: 'receipt' as unknown as Invoice['documentType'] });
    expect(codeOf(() => store.insertDraft(bogusType))).toBe('INVALID_DATA');
    expect(codeOf(() => store.insertDraft(makeInvoice({ id: '' })))).toBe('INVALID_ARGUMENT');
    expect(store.findInvoices({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it('updateDraft replaces a draft completely', () => {
    const store = setup();
    const d = draft(store);
    const changed: Invoice = {
      ...d,
      customerId: 'cus_tuk',
      customer: { vatStatus: 'DOMESTIC', name: 'Tükörfúrógép Bt.', taxNumber: '17781799-5-44', address: ADDRESS },
      totals: totals(20000),
      comment: 'módosított',
      dueDate: null,
      updatedAt: '2026-10-27T09:00:00.000Z',
    };
    store.updateDraft(changed);
    expect(store.getInvoice(d.id)).toEqual(changed);
    expect(store.findInvoices({ text: 'tukorfurogep', limit: 10, offset: 0 }).total).toBe(1);
    expect(store.findInvoices({ text: 'arvizturo', limit: 10, offset: 0 }).total).toBe(0);
  });

  it('updateDraft refuses to issue and reports unknown drafts', () => {
    const store = setup();
    const d = draft(store);
    const sneaky: Invoice = { ...d, status: 'issued', number: 'SZ-2026-00001', issuedAt: '2026-10-27T11:00:00.000Z', contentHash: 'a'.repeat(64) };
    expect(codeOf(() => store.updateDraft(sneaky))).toBe('NOT_A_DRAFT');
    expect(store.getInvoice(d.id)?.status).toBe('draft');
    expect(codeOf(() => store.updateDraft(makeInvoice({ id: 'inv_unknown' })))).toBe('NOT_FOUND');
  });

  it('deleteDraft deletes a draft', () => {
    const store = setup();
    const d = draft(store);
    store.deleteDraft(d.id);
    expect(store.getInvoice(d.id)).toBeNull();
    expect(codeOf(() => store.deleteDraft(d.id))).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------------------------
// issuing
// ---------------------------------------------------------------------------------------------

describe('issuing (markIssued)', () => {
  it('turns a draft into an issued invoice in one step', () => {
    const store = setup();
    const d = draft(store, { comment: 'Első számla' });
    const issued = issue(store, d);
    expect(issued.number).toBe('SZ-2026-00001');
    expect(store.getInvoice(d.id)).toEqual(issued);
    expect(store.getInvoiceByNumber('SZ-2026-00001')).toEqual(issued);
    expect(store.getSeries('ser_inv')).toMatchObject({ nextSeq: 2, seqYear: 2026 });
    // the number becomes searchable once issued
    expect(store.findInvoices({ text: 'sz-2026-00001', limit: 10, offset: 0 }).items.map((i) => i.id)).toEqual([d.id]);
  });

  it('fails with NOT_A_DRAFT on issued or cancelled invoices', () => {
    const store = setup();
    const issued = issue(store, draft(store));
    expect(codeOf(() => store.markIssued(issued))).toBe('NOT_A_DRAFT');
    expect(codeOf(() => store.markIssued({ ...issued, number: 'SZ-2026-00077' }))).toBe('NOT_A_DRAFT');
    store.patchInvoice(issued.id, { status: 'cancelled' });
    expect(codeOf(() => store.markIssued(issued))).toBe('NOT_A_DRAFT');
    expect(codeOf(() => store.markIssued({ ...issued, id: 'inv_unknown' }))).toBe('NOT_FOUND');
    expect(store.getInvoice(issued.id)?.number).toBe('SZ-2026-00001');
  });

  it('fails with DUPLICATE_INVOICE_NUMBER when the number is taken', () => {
    const store = setup();
    const first = issue(store, draft(store));
    const second = draft(store);
    const dup: Invoice = { ...second, status: 'issued', number: first.number, issuedAt: '2026-10-27T12:00:00.000Z', contentHash: 'b'.repeat(64) };
    const err = errorOf(() => store.markIssued(dup));
    expect(err.code).toBe('DUPLICATE_INVOICE_NUMBER');
    expect(err.details).toMatchObject({ number: first.number, existingInvoiceId: first.id });
    expect(store.getInvoice(second.id)?.status).toBe('draft');
    // a draft that already carries the number blocks it as well
    const third = draft(store, { number: 'SZ-RESERVED' });
    expect(codeOf(() => store.markIssued({ ...dup, number: 'SZ-RESERVED' }))).toBe('DUPLICATE_INVOICE_NUMBER');
    expect(codeOf(() => store.insertDraft(makeInvoice({ number: 'SZ-RESERVED' })))).toBe('DUPLICATE_INVOICE_NUMBER');
    expect(store.getInvoice(third.id)?.number).toBe('SZ-RESERVED');
  });

  it('validates the final document', () => {
    const store = setup();
    const d = draft(store);
    const ok: Invoice = { ...d, status: 'issued', number: 'SZ-2026-00001', issuedAt: '2026-10-27T11:00:00.000Z', contentHash: 'c'.repeat(64) };
    expect(codeOf(() => store.markIssued({ ...ok, status: 'draft' }))).toBe('INVALID_STATUS');
    expect(codeOf(() => store.markIssued({ ...ok, number: null }))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => store.markIssued({ ...ok, issuedAt: null }))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => store.markIssued({ ...ok, contentHash: null }))).toBe('INVALID_ARGUMENT');
    expect(store.getInvoice(d.id)).toEqual(d);
    store.markIssued(ok);
    expect(store.getInvoice(d.id)).toEqual(ok);
  });

  it('a failed issuance rolls back the allocated sequence number', () => {
    const store = setup();
    const first = issue(store, draft(store));
    const second = draft(store);
    expect(
      codeOf(() =>
        store.tx(() => {
          const { seq } = store.allocateSequence('ser_inv', second.issueDate);
          expect(seq).toBe(2);
          store.markIssued({ ...second, status: 'issued', number: first.number, issuedAt: 'x', contentHash: 'd'.repeat(64) });
        }),
      ),
    ).toBe('DUPLICATE_INVOICE_NUMBER');
    expect(store.getSeries('ser_inv')?.nextSeq).toBe(2);
    expect(issue(store, second).number).toBe('SZ-2026-00002');
  });

  it('stores the immutable part losslessly: the content hash recomputes after reads and patches', () => {
    const store = setup();
    const eurTotals: InvoiceTotals = {
      netAmount: '25.56',
      vatAmount: '6.9',
      grossAmount: '32.46',
      netAmountHuf: '10000',
      vatAmountHuf: '2700',
      grossAmountHuf: '12700',
      byVat: [{ vatCode: '27', netAmount: '25.56', vatAmount: '6.9', grossAmount: '32.46', netAmountHuf: '10000', vatAmountHuf: '2700', grossAmountHuf: '12700' }],
      payableAmount: '32.46',
      roundingDifference: '0',
    };
    const base = makeInvoice();
    const firstLine = base.lines[0];
    if (!firstLine) throw new Error('fixture has no line');
    const issued = issue(
      store,
      draft(store, {
        documentType: 'final',
        currency: 'EUR',
        exchangeRate: '391.25',
        exchangeRateDate: '2026-10-22',
        exchangeRateSource: 'MNB',
        language: 'hu-en',
        totals: eurTotals,
        lines: [
          { ...firstLine, quantity: '1.5', unitPrice: '17.04', netUnitPrice: '17.04', netAmount: '25.56', vatAmount: '6.9', grossAmount: '32.46' },
          {
            ...firstLine,
            lineNo: 2,
            description: 'Előleg levonása – „idézőjel” és \\ jel',
            quantity: '-1',
            advanceDeduction: { advanceInvoiceNumber: 'SZ-2026-00000', advancePaymentDate: '2026-10-01', advanceExchangeRate: '390.5' },
          },
        ],
        notations: ['Előlegszámla alapján'],
        orderNumber: 'PO-ÁÉŐ',
      }),
    );
    store.patchInvoice(issued.id, {
      paymentStatus: 'paid',
      paidAmount: '32.46',
      paidDate: '2026-10-30',
      navStatus: 'done',
      navMessages: [{ severity: 'INFO', code: 'I1', message: 'ok' }],
    });
    const reads = [
      mustGet(store, issued.id),
      store.getInvoiceByNumber(issued.number ?? ''),
      store.findInvoices({ text: 'po-aeo', limit: 5, offset: 0 }).items[0],
    ];
    for (const inv of reads) {
      if (!inv) throw new Error('invoice not returned');
      expect(sha256Hex(canonicalJson(immutablePart(inv)))).toBe(issued.contentHash);
      expect(immutablePart(inv)).toEqual(immutablePart(issued));
    }
  });

  it('issued invoices can no longer be updated or deleted as drafts', () => {
    const store = setup();
    const issued = issue(store, draft(store));
    expect(codeOf(() => store.updateDraft({ ...issued, status: 'draft', comment: 'hack' }))).toBe('NOT_A_DRAFT');
    expect(codeOf(() => store.deleteDraft(issued.id))).toBe('NOT_A_DRAFT');
    expect(store.getInvoice(issued.id)).toEqual(issued);
  });
});

// ---------------------------------------------------------------------------------------------
// patchInvoice
// ---------------------------------------------------------------------------------------------

describe('patchInvoice', () => {
  it('updates only the mutable fields and stamps updatedAt from the clock', () => {
    const store = new Store({ path: ':memory:', now: () => new Date('2026-11-02T15:00:00.000Z') });
    cleanups.push(() => store.close());
    store.insertSeries(series({}));
    store.insertCustomer(customer('cus_arv', 'Árvíztűrő Kft.'));
    const issued = issue(store, draft(store));
    const messages = [{ severity: 'WARN' as const, code: 'W1', message: 'Figyelmeztetés', pointer: 'line 1' }];
    store.patchInvoice(issued.id, {
      paymentStatus: 'partial',
      paidAmount: '5000.00',
      paidDate: '2026-11-01',
      navStatus: 'done_with_warnings',
      navTransactionId: 'TX-123',
      navMessages: messages,
    });
    const after = mustGet(store, issued.id);
    expect(after).toEqual({
      ...issued,
      paymentStatus: 'partial',
      paidAmount: '5000',
      paidDate: '2026-11-01',
      navStatus: 'done_with_warnings',
      navTransactionId: 'TX-123',
      navMessages: messages,
      updatedAt: '2026-11-02T15:00:00.000Z',
    });
    store.patchInvoice(issued.id, { paidDate: null, navTransactionId: null, paymentStatus: 'paid' });
    expect(mustGet(store, issued.id)).toMatchObject({ paidDate: null, navTransactionId: null, paymentStatus: 'paid', paidAmount: '5000' });
  });

  it('marks an issued invoice cancelled by its storno invoice', () => {
    const store = setup();
    const original = issue(store, draft(store));
    const storno = issue(
      store,
      draft(store, {
        documentType: 'storno',
        totals: totals(-10000),
        reference: { originalInvoiceId: original.id, originalInvoiceNumber: original.number ?? '', modificationIndex: 1, modifyWithoutMaster: false },
      }),
    );
    store.tx(() => store.patchInvoice(original.id, { status: 'cancelled', cancelledById: storno.id }));
    const cancelled = mustGet(store, original.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledById).toBe(storno.id);
    expect(immutablePart(cancelled)).toEqual(immutablePart(original));
    expect(cancelled.contentHash).toBe(original.contentHash);
    // idempotent
    store.patchInvoice(original.id, { status: 'cancelled' });
    expect(mustGet(store, original.id).status).toBe('cancelled');
  });

  it('refuses invalid patches', () => {
    const store = setup();
    const d = draft(store);
    const issued = issue(store, draft(store));
    expect(codeOf(() => store.patchInvoice(d.id, { status: 'cancelled' }))).toBe('INVALID_STATUS_TRANSITION');
    const sneaky = { issueDate: '2026-01-01' } as unknown as InvoiceMutablePatch;
    expect(codeOf(() => store.patchInvoice(issued.id, sneaky))).toBe('INVALID_PATCH');
    const wrongStatus = { status: 'draft' } as unknown as InvoiceMutablePatch;
    expect(codeOf(() => store.patchInvoice(issued.id, wrongStatus))).toBe('INVALID_STATUS_TRANSITION');
    expect(codeOf(() => store.patchInvoice('inv_unknown', { paymentStatus: 'paid' }))).toBe('NOT_FOUND');
    expect(codeOf(() => store.patchInvoice(issued.id, { cancelledById: 'inv_unknown' }))).toBe('INVALID_REFERENCE');
    expect(codeOf(() => store.patchInvoice(issued.id, { paidAmount: 'sok' }))).toBe('INVALID_NUMBER');
    expect(codeOf(() => store.patchInvoice(issued.id, { paidDate: '2026-11-31' }))).toBe('INVALID_DATE');
    const badEnum = { paymentStatus: 'maybe' } as unknown as InvoiceMutablePatch;
    expect(codeOf(() => store.patchInvoice(issued.id, badEnum))).toBe('INVALID_DATA');
    store.patchInvoice(issued.id, {});
    expect(store.getInvoice(issued.id)).toEqual(issued);
  });
});

// ---------------------------------------------------------------------------------------------
// immutability triggers (raw SQL, bypassing the Store API)
// ---------------------------------------------------------------------------------------------

describe('immutability triggers (raw SQL)', () => {
  function fixture(path = ':memory:'): { store: Store; raw: DatabaseSync; issued: Invoice; draftInv: Invoice } {
    const store = setup(path);
    const issued = issue(store, draft(store));
    const draftInv = draft(store, { comment: 'piszkozat' });
    return { store, raw: store.unsafeRawDatabaseForTests(), issued, draftInv };
  }

  const IMMUTABLE_UPDATES: ReadonlyArray<[column: string, value: string | null]> = [
    ['doc', '{}'],
    ['number', 'SZ-2026-99999'],
    ['gross_amount', '1'],
    ['gross_amount_huf', '1'],
    ['issue_date', '2026-10-28'],
    ['fulfillment_date', '2026-10-28'],
    ['due_date', '2026-12-31'],
    ['due_date', null],
    ['customer_id', 'cus_tuk'],
    ['customer_name', 'Valaki más'],
    ['currency', 'EUR'],
    ['series_id', 'ser_pro'],
    ['document_type', 'advance'],
    ['search_text', 'x'],
    ['content_hash', 'f'.repeat(64)],
    ['created_at', '2030-01-01T00:00:00.000Z'],
    ['issued_at', '2030-01-01T00:00:00.000Z'],
    ['id', 'inv_renamed'],
  ];

  it('UPDATE of any immutable column of an issued invoice fails', () => {
    const { store, raw, issued, draftInv } = fixture();
    for (const [column, value] of IMMUTABLE_UPDATES) {
      const message = rawFailure(() => raw.prepare(`UPDATE invoices SET ${column} = ? WHERE id = ?`).run(value, issued.id));
      expect(message, column).toMatch(/^IMMUTABLE_INVOICE: /);
    }
    expect(rawFailure(() => raw.prepare('UPDATE invoices SET original_invoice_id = ? WHERE id = ?').run(draftInv.id, issued.id))).toMatch(
      /^IMMUTABLE_INVOICE: /,
    );
    expect(store.getInvoice(issued.id)).toEqual(issued);
  });

  /** Columns that may change after issuance; every OTHER column of `invoices` must be frozen. */
  const MUTABLE_COLUMNS = new Set([
    'status',
    'payment_status',
    'paid_amount',
    'paid_date',
    'nav_status',
    'nav_transaction_id',
    'nav_messages',
    // the NAV environment the NAV state belongs to (migration 2)
    'nav_environment',
    'cancelled_by_id',
    'updated_at',
  ]);

  it('every column outside the mutable list is frozen once issued or cancelled – on any connection', () => {
    const path = join(tempDir(), 'company.db');
    const store = setup(path);
    const original = issue(store, draft(store));
    // a storno fills every nullable immutable column (customer, due date, original invoice)
    const storno = issue(
      store,
      draft(store, {
        documentType: 'storno',
        totals: totals(-10000),
        reference: { originalInvoiceId: original.id, originalInvoiceNumber: original.number ?? '', modificationIndex: 1, modifyWithoutMaster: false },
      }),
    );
    store.patchInvoice(original.id, { status: 'cancelled', cancelledById: storno.id });
    const cancelled = mustGet(store, original.id);
    const raw = store.unsafeRawDatabaseForTests();
    const other = openRaw(path); // an external SQLite tool: recursive_triggers OFF
    // Derived from the live schema, so a column added later without updating the trigger fails here.
    const frozen = raw
      .prepare('PRAGMA table_info(invoices)')
      .all()
      .map((r) => String(r['name']))
      .filter((c) => !MUTABLE_COLUMNS.has(c));
    expect(frozen.length).toBeGreaterThanOrEqual(18);
    let attempts = 0;
    for (const conn of [raw, other]) {
      for (const target of [storno, cancelled]) {
        for (const column of frozen) {
          const current = conn.prepare(`SELECT ${column} AS v FROM invoices WHERE id = ?`).get(target.id)?.['v'];
          const candidates = current === null ? ['x'] : [null, `${String(current)}x`];
          for (const value of candidates) {
            attempts++;
            const message = rawFailure(() => conn.prepare(`UPDATE invoices SET ${column} = ? WHERE id = ?`).run(value, target.id));
            expect(message, `${target.id}.${column} = ${String(value)}`).toMatch(/^IMMUTABLE_INVOICE: /);
          }
        }
      }
    }
    expect(attempts).toBeGreaterThan(frozen.length * 4);
    expect(mustGet(store, storno.id)).toEqual(storno);
    expect(mustGet(store, original.id)).toEqual(cancelled);
  });

  it('the mutable-after-issuance columns of an issued invoice can still change', () => {
    const { store, raw, issued } = fixture();
    raw
      .prepare(
        `UPDATE invoices SET payment_status = 'paid', paid_amount = '12700', paid_date = '2026-11-01', nav_status = 'done',
         nav_transaction_id = 'T1', nav_messages = '[]', updated_at = '2026-11-01T10:00:00.000Z' WHERE id = ?`,
      )
      .run(issued.id);
    expect(mustGet(store, issued.id)).toMatchObject({ paymentStatus: 'paid', paidAmount: '12700', navStatus: 'done', navTransactionId: 'T1' });
  });

  it('DELETE of an issued (or cancelled) invoice fails', () => {
    const { store, raw, issued, draftInv } = fixture();
    expect(rawFailure(() => raw.prepare('DELETE FROM invoices WHERE id = ?').run(issued.id))).toMatch(/^IMMUTABLE_INVOICE: /);
    // a multi-row delete is aborted as a whole – the draft survives too
    expect(rawFailure(() => raw.exec('DELETE FROM invoices'))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(store.getInvoice(draftInv.id)).not.toBeNull();
    raw.prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`).run(issued.id);
    expect(rawFailure(() => raw.prepare('DELETE FROM invoices WHERE id = ?').run(issued.id))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(store.getInvoice(issued.id)).not.toBeNull();
  });

  it('allows only draft → issued → cancelled status transitions', () => {
    const { store, raw, issued, draftInv } = fixture();
    const setStatus = (id: string, status: string): unknown => raw.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    expect(rawFailure(() => setStatus(issued.id, 'draft'))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(rawFailure(() => setStatus(draftInv.id, 'cancelled'))).toMatch(/^IMMUTABLE_INVOICE: /);
    setStatus(issued.id, 'cancelled');
    expect(store.getInvoice(issued.id)?.status).toBe('cancelled');
    expect(rawFailure(() => setStatus(issued.id, 'issued'))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(rawFailure(() => setStatus(issued.id, 'draft'))).toMatch(/^IMMUTABLE_INVOICE: /);
    // a raw draft → issued flip without number/hash violates the CHECK constraint
    expect(rawFailure(() => setStatus(draftInv.id, 'issued'))).toMatch(/CHECK constraint failed/);
  });

  it('drafts stay freely editable and deletable', () => {
    const { store, raw, draftInv } = fixture();
    raw.prepare(`UPDATE invoices SET customer_name = 'Új név', gross_amount = '1' WHERE id = ?`).run(draftInv.id);
    raw.prepare('DELETE FROM invoices WHERE id = ?').run(draftInv.id);
    expect(store.getInvoice(draftInv.id)).toBeNull();
  });

  it('INSERT cannot create or overwrite issued invoices (INSERT/UPDATE OR REPLACE included)', () => {
    const { store, raw, issued, draftInv } = fixture();
    const columns = raw
      .prepare('PRAGMA table_info(invoices)')
      .all()
      .map((r) => String(r['name']));
    const copy = (verb: string, overrides: Record<string, string>): string =>
      `${verb} INTO invoices (${columns.join(', ')}) SELECT ${columns.map((c) => overrides[c] ?? c).join(', ')} FROM invoices WHERE id = ?`;

    // a new row that is issued from the start
    expect(rawFailure(() => raw.prepare(copy('INSERT', { id: `'inv_forged'`, number: `'SZ-FORGED'` })).run(issued.id))).toMatch(
      /^IMMUTABLE_INVOICE: /,
    );
    // REPLACE over an issued invoice (same id) – would silently delete it without the guard
    expect(
      rawFailure(() => raw.prepare(copy('INSERT OR REPLACE', { status: `'draft'`, number: 'NULL', doc: `'{}'` })).run(issued.id)),
    ).toMatch(/^IMMUTABLE_INVOICE: /);
    // REPLACE through a number collision
    expect(
      rawFailure(() => raw.prepare(copy('INSERT OR REPLACE', { id: `'inv_other'`, status: `'draft'` })).run(issued.id)),
    ).toMatch(/^DUPLICATE_INVOICE_NUMBER: /);
    // UPSERT: the INSERT guard fires before the conflict is resolved into an UPDATE
    expect(
      rawFailure(() =>
        raw.prepare(`${copy('INSERT', { status: `'draft'`, number: 'NULL' })} ON CONFLICT (id) DO UPDATE SET doc = excluded.doc`).run(issued.id),
      ),
    ).toMatch(/^IMMUTABLE_INVOICE: /);
    // UPDATE OR REPLACE of a draft colliding with the issued invoice's number or id
    expect(
      rawFailure(() => raw.prepare('UPDATE OR REPLACE invoices SET number = ? WHERE id = ?').run(issued.number, draftInv.id)),
    ).toMatch(/^DUPLICATE_INVOICE_NUMBER: /);
    expect(rawFailure(() => raw.prepare('UPDATE OR REPLACE invoices SET id = ? WHERE id = ?').run(issued.id, draftInv.id))).toMatch(
      /^IMMUTABLE_INVOICE: /,
    );
    expect(store.getInvoice(issued.id)).toEqual(issued);
    expect(store.getInvoice(draftInv.id)).toEqual(draftInv);
    expect(store.findInvoices({ limit: 10, offset: 0 }).total).toBe(2);
  });

  it('binds every connection, e.g. an external SQLite tool without recursive_triggers', () => {
    const path = join(tempDir(), 'company.db');
    const { store, issued } = fixture(path);
    const other = openRaw(path);
    expect(other.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
    expect(rawFailure(() => other.prepare(`UPDATE invoices SET doc = '{}' WHERE id = ?`).run(issued.id))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(rawFailure(() => other.prepare('DELETE FROM invoices WHERE id = ?').run(issued.id))).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(
      rawFailure(() =>
        other
          .prepare(
            `INSERT OR REPLACE INTO invoices (id, series_id, document_type, status, issue_date, fulfillment_date, customer_name, currency,
               gross_amount, gross_amount_huf, search_text, doc, payment_status, paid_amount, nav_status, created_at, updated_at)
             VALUES (?, 'ser_inv', 'invoice', 'draft', '2026-10-27', '2026-10-27', 'x', 'HUF', '0', '0', '', '{}', 'unpaid', '0',
               'not_applicable', 'x', 'x')`,
          )
          .run(issued.id),
      ),
    ).toMatch(/^IMMUTABLE_INVOICE: /);
    expect(store.getInvoice(issued.id)).toEqual(issued);
  });

  it('trigger violations map to AppError IMMUTABLE_INVOICE with a Hungarian message and hint', () => {
    const { raw, issued } = fixture();
    const err = mapDbError(rawError(() => raw.prepare(`UPDATE invoices SET doc = '{}' WHERE id = ?`).run(issued.id)));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('IMMUTABLE_INVOICE');
    expect(err.message).toBe('A kiállított számla tartalma nem módosítható.');
    expect(err.hint).toBe('A kiállított számla nem módosítható; használj sztornó vagy módosító számlát.');
    const del = mapDbError(rawError(() => raw.prepare('DELETE FROM invoices WHERE id = ?').run(issued.id)));
    expect(del.code).toBe('IMMUTABLE_INVOICE');
    expect(del.message).toBe('Kiállított számla nem törölhető.');
  });
});

// ---------------------------------------------------------------------------------------------
// findInvoices
// ---------------------------------------------------------------------------------------------

describe('findInvoices', () => {
  /**
   * A: invoice 10-01 (due 10-09) Árvíztűrő, later cancelled by S       → cancelled
   * B: invoice 10-10 (due 10-18) Tükörfúrógép, partially paid           → overdue from 10-19
   * C: invoice 10-15 (due 10-23) Árvíztűrő, paid
   * E: proforma 10-05 (due 10-12) Tükörfúrógép, unpaid                  → never overdue (not an invoice)
   * S: storno of A 10-20 (due 10-28), negative total                    → never overdue
   * G: modification of C 10-21 (due 10-29), positive delta, unpaid     → overdue from 10-30
   * F: draft 10-26 (due 11-03)
   */
  function dataset(): Store {
    const store = setup();
    const at = (day: string): Partial<Invoice> => ({
      issueDate: `2026-10-${day}`,
      fulfillmentDate: `2026-10-${day}`,
      createdAt: `2026-10-${day}T08:00:00.000Z`,
      updatedAt: `2026-10-${day}T08:00:00.000Z`,
    });
    const tuk: Partial<Invoice> = {
      customerId: 'cus_tuk',
      customer: { vatStatus: 'DOMESTIC', name: 'Tükörfúrógép Bt.', taxNumber: '17781799-5-44', address: ADDRESS },
    };
    const A = issue(store, draft(store, { id: 'inv_A', ...at('01'), dueDate: '2026-10-09', comment: 'Szeptemberi díj', orderNumber: 'PO-1' }), '2026-10-01T09:00:00.000Z');
    const E = issue(store, draft(store, { id: 'inv_E', ...at('05'), ...tuk, documentType: 'proforma', seriesId: 'ser_pro', dueDate: '2026-10-12' }), '2026-10-05T09:00:00.000Z');
    const B = issue(store, draft(store, { id: 'inv_B', ...at('10'), ...tuk, dueDate: '2026-10-18', orderNumber: 'PO-22' }), '2026-10-10T09:00:00.000Z');
    const C = issue(store, draft(store, { id: 'inv_C', ...at('15'), dueDate: '2026-10-23' }), '2026-10-15T09:00:00.000Z');
    const S = issue(
      store,
      draft(store, {
        id: 'inv_S',
        ...at('20'),
        documentType: 'storno',
        dueDate: '2026-10-28',
        totals: totals(-10000),
        reference: { originalInvoiceId: A.id, originalInvoiceNumber: A.number ?? '', modificationIndex: 1, modifyWithoutMaster: false },
      }),
      '2026-10-20T09:00:00.000Z',
    );
    issue(
      store,
      draft(store, {
        id: 'inv_G',
        ...at('21'),
        documentType: 'modification',
        dueDate: '2026-10-29',
        totals: totals(1000),
        reference: { originalInvoiceId: C.id, originalInvoiceNumber: C.number ?? '', modificationIndex: 1, modifyWithoutMaster: false },
      }),
      '2026-10-21T09:00:00.000Z',
    );
    draft(store, { id: 'inv_F', ...at('26'), dueDate: '2026-11-03', comment: 'Még nincs kiállítva' });
    store.patchInvoice(A.id, { status: 'cancelled', cancelledById: S.id, navStatus: 'done' });
    store.patchInvoice(B.id, { paymentStatus: 'partial', paidAmount: '5000', navStatus: 'pending' });
    store.patchInvoice(C.id, { paymentStatus: 'paid', paidAmount: '12700', paidDate: '2026-10-20', navStatus: 'done' });
    store.patchInvoice(S.id, { navStatus: 'done' });
    store.patchInvoice('inv_G', { navStatus: 'processing' });
    expect(E.number).toBe('DB-2026-00001');
    expect([A.number, B.number, C.number, S.number]).toEqual(['SZ-2026-00001', 'SZ-2026-00002', 'SZ-2026-00003', 'SZ-2026-00004']);
    return store;
  }

  const all = { limit: 100, offset: 0 };

  it('returns everything newest first by default', () => {
    const store = dataset();
    const res = store.findInvoices(all);
    expect(res.total).toBe(7);
    expect(res.items.map((i) => i.id)).toEqual(['inv_F', 'inv_G', 'inv_S', 'inv_C', 'inv_B', 'inv_E', 'inv_A']);
    expect(store.findInvoices({ ...all, sort: 'issued_asc' }).items.map((i) => i.id)).toEqual([
      'inv_A',
      'inv_E',
      'inv_B',
      'inv_C',
      'inv_S',
      'inv_G',
      'inv_F',
    ]);
  });

  it('sorts by creation time on request', () => {
    const store = dataset();
    const d = draft(store, { id: 'inv_old', issueDate: '2026-10-27', fulfillmentDate: '2026-10-27', createdAt: '2026-09-01T00:00:00.000Z' });
    const ids = store.findInvoices({ ...all, sort: 'created_desc' }).items.map((i) => i.id);
    expect(ids[0]).toBe('inv_F');
    expect(ids.at(-1)).toBe(d.id);
  });

  it('filters by status, document type, customer, payment and NAV status', () => {
    const store = dataset();
    const ids = (f: Partial<Parameters<Store['findInvoices']>[0]>): string[] =>
      store.findInvoices({ ...all, ...f }).items.map((i) => i.id).sort();
    expect(ids({ status: ['draft'] })).toEqual(['inv_F']);
    expect(ids({ status: ['cancelled'] })).toEqual(['inv_A']);
    expect(ids({ status: ['issued'] })).toEqual(['inv_B', 'inv_C', 'inv_E', 'inv_G', 'inv_S']);
    expect(ids({ status: ['issued', 'cancelled'], documentType: ['invoice'] })).toEqual(['inv_A', 'inv_B', 'inv_C']);
    expect(ids({ documentType: ['storno', 'modification'] })).toEqual(['inv_G', 'inv_S']);
    expect(ids({ documentType: ['proforma'] })).toEqual(['inv_E']);
    expect(ids({ customerId: 'cus_tuk' })).toEqual(['inv_B', 'inv_E']);
    expect(ids({ paymentStatus: ['partial', 'paid'] })).toEqual(['inv_B', 'inv_C']);
    expect(ids({ navStatus: ['pending', 'processing'] })).toEqual(['inv_B', 'inv_G']);
    expect(ids({ status: [] })).toHaveLength(7);
  });

  it('searches number, customer name, comment and order number accent-insensitively', () => {
    const store = dataset();
    const ids = (text: string): string[] => store.findInvoices({ ...all, text }).items.map((i) => i.id).sort();
    expect(ids('SZ-2026-00002')).toEqual(['inv_B']);
    expect(ids('db-2026')).toEqual(['inv_E']);
    expect(ids('TUKORFUROGEP')).toEqual(['inv_B', 'inv_E']);
    expect(ids('árvíztűrő')).toEqual(['inv_A', 'inv_C', 'inv_F', 'inv_G', 'inv_S']);
    expect(ids('szeptemberi')).toEqual(['inv_A']);
    expect(ids('po-2')).toEqual(['inv_B']);
    expect(ids('meg nincs')).toEqual(['inv_F']);
    expect(ids('100%')).toEqual([]);
  });

  it('filters by issue date range (inclusive)', () => {
    const store = dataset();
    const ids = (from?: string, to?: string): string[] =>
      store
        .findInvoices({ ...all, ...(from ? { issueDateFrom: from } : {}), ...(to ? { issueDateTo: to } : {}) })
        .items.map((i) => i.id)
        .sort();
    expect(ids('2026-10-10', '2026-10-20')).toEqual(['inv_B', 'inv_C', 'inv_S']);
    expect(ids('2026-10-21')).toEqual(['inv_F', 'inv_G']);
    expect(ids(undefined, '2026-10-05')).toEqual(['inv_A', 'inv_E']);
    expect(ids('2026-11-01')).toEqual([]);
  });

  it('finds overdue invoices: issued, not fully paid, due before the date, payable', () => {
    const store = dataset();
    const ids = (overdueOn: string): string[] => store.findInvoices({ ...all, overdueOn }).items.map((i) => i.id);
    expect(ids('2026-10-12')).toEqual([]);
    // The unpaid díjbekérő E (due 10-12) is no receivable: never overdue (BIZ-9, MCP-UX-8).
    expect(ids('2026-10-13')).toEqual([]);
    expect(ids('2026-10-25')).toEqual(['inv_B']);
    expect(ids('2026-10-29')).toEqual(['inv_B']);
    expect(ids('2026-10-30')).toEqual(['inv_G', 'inv_B']);
    expect(ids('2027-01-01')).toEqual(['inv_G', 'inv_B']);
    expect(store.findInvoices({ ...all, overdueOn: '2026-10-30', customerId: 'cus_tuk' }).total).toBe(1);
  });

  it('receivables: issued invoices with a positive total, not corrections of a cancelled invoice (BIZ-9, MCP-UX-8)', () => {
    const store = dataset();
    const ids = (f: Partial<Parameters<Store['findInvoices']>[0]>): string[] => store.findInvoices({ ...all, ...f }).items.map((i) => i.id).sort();
    // A cancelled, C paid, E a díjbekérő, S a storno, F a draft: only B (partial) and G (positive delta) are owed.
    expect(ids({ receivable: true })).toEqual(['inv_B', 'inv_C', 'inv_G']);
    expect(ids({ receivable: true, paymentStatus: ['unpaid', 'partial'] })).toEqual(['inv_B', 'inv_G']);
    // Cancelling C (its storno negates G too) takes its positive modification G off the receivables.
    store.patchInvoice('inv_C', { status: 'cancelled' });
    expect(ids({ receivable: true, paymentStatus: ['unpaid', 'partial'] })).toEqual(['inv_B']);
    expect(ids({ overdueOn: '2027-01-01' })).toEqual(['inv_B']);
  });

  it('filters by fulfilment date range (inclusive)', () => {
    const store = dataset();
    const ids = (from: string, to: string): string[] => store.findInvoices({ ...all, fulfillmentDateFrom: from, fulfillmentDateTo: to }).items.map((i) => i.id).sort();
    expect(ids('2026-10-10', '2026-10-20')).toEqual(['inv_B', 'inv_C', 'inv_S']);
    expect(codeOf(() => store.findInvoices({ ...all, fulfillmentDateTo: '2026-1-1' }))).toBe('INVALID_DATE');
  });

  it('never lists zero or negative totals as overdue (nothing is owed on them)', () => {
    const store = setup();
    const owed = issue(store, draft(store, { dueDate: '2026-10-01' }));
    const zero = issue(store, draft(store, { dueDate: '2026-10-01', totals: totals(0) }));
    const credit = issue(
      store,
      draft(store, {
        documentType: 'modification',
        dueDate: '2026-10-01',
        totals: totals(-500),
        reference: { originalInvoiceId: owed.id, originalInvoiceNumber: owed.number ?? '', modificationIndex: 1, modifyWithoutMaster: false },
      }),
    );
    expect([zero.totals.grossAmount, credit.totals.grossAmount]).toEqual(['0', '-635']);
    expect(store.findInvoices({ ...all, overdueOn: '2026-10-27' }).items.map((i) => i.id)).toEqual([owed.id]);
    store.patchInvoice(owed.id, { paymentStatus: 'partial', paidAmount: '100' });
    expect(store.findInvoices({ ...all, overdueOn: '2026-10-27' }).total).toBe(1);
    store.patchInvoice(owed.id, { paymentStatus: 'paid', paidAmount: '12700' });
    expect(store.findInvoices({ ...all, overdueOn: '2026-10-27' }).total).toBe(0);
  });

  it('filters by original invoice (its modifications and stornos)', () => {
    const store = dataset();
    expect(store.findInvoices({ ...all, originalInvoiceId: 'inv_A' }).items.map((i) => i.id)).toEqual(['inv_S']);
    expect(store.findInvoices({ ...all, originalInvoiceId: 'inv_C' }).items.map((i) => i.id)).toEqual(['inv_G']);
    expect(store.findInvoices({ ...all, originalInvoiceId: 'inv_B' }).total).toBe(0);
  });

  it('paginates with stable totals', () => {
    const store = dataset();
    const p1 = store.findInvoices({ limit: 3, offset: 0 });
    const p2 = store.findInvoices({ limit: 3, offset: 3 });
    const p3 = store.findInvoices({ limit: 3, offset: 6 });
    expect([p1.total, p2.total, p3.total]).toEqual([7, 7, 7]);
    expect([p1.limit, p1.offset, p2.offset, p3.offset]).toEqual([3, 0, 3, 6]);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual(store.findInvoices(all).items.map((i) => i.id));
    expect(p3.items).toHaveLength(1);
    const filtered = store.findInvoices({ status: ['issued'], limit: 2, offset: 4 });
    expect(filtered.total).toBe(5);
    expect(filtered.items.map((i) => i.id)).toEqual(['inv_E']);
    expect(store.findInvoices({ limit: 5, offset: 50 })).toEqual({ items: [], total: 7, limit: 5, offset: 50 });
  });

  it('validates its arguments', () => {
    const store = dataset();
    const badSort = { ...all, sort: 'random' } as unknown as Parameters<Store['findInvoices']>[0];
    expect(codeOf(() => store.findInvoices(badSort))).toBe('INVALID_ARGUMENT');
    const protoSort = { ...all, sort: 'constructor' } as unknown as Parameters<Store['findInvoices']>[0];
    expect(codeOf(() => store.findInvoices(protoSort))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => store.findInvoices({ ...all, issueDateFrom: 'tegnap' }))).toBe('INVALID_DATE');
    expect(codeOf(() => store.findInvoices({ ...all, overdueOn: '2026-1-1' }))).toBe('INVALID_DATE');
    expect(codeOf(() => store.findInvoices({ limit: -1, offset: 0 }))).toBe('INVALID_PAGINATION');
  });
});

// ---------------------------------------------------------------------------------------------
// indexes
// ---------------------------------------------------------------------------------------------

describe('indexes', () => {
  const ISSUED_ASC = 'issue_date ASC, issued_at ASC, created_at ASC, id ASC';
  const ISSUED_DESC = 'issue_date DESC, issued_at DESC, created_at DESC, id DESC';

  /** EXPLAIN QUERY PLAN of the query shapes findInvoices builds (parameters left unbound). */
  function plan(store: Store, where: string, orderBy: string): string {
    return store
      .unsafeRawDatabaseForTests()
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM invoices${where ? ` WHERE ${where}` : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all()
      .map((r) => String(r['detail']))
      .join(' | ');
  }

  it('serves the common invoice filters from an index that narrows the search', () => {
    const store = setup();
    // reports, exports, integrity check: issued/cancelled documents within an issue-date range
    expect(plan(store, `status IN (?, ?) AND document_type IN (?, ?, ?) AND issue_date >= ? AND issue_date <= ?`, ISSUED_ASC)).toMatch(
      /USING INDEX invoices_status_issue_date \(status=\? AND issue_date>\? AND issue_date<\?\)/,
    );
    // nav_sync work queue and the setup_status counters
    expect(plan(store, `status IN (?, ?) AND nav_status IN (?, ?, ?)`, ISSUED_ASC)).toMatch(
      /USING INDEX invoices_nav_status \(nav_status=\? AND status=\?\)/,
    );
    // overdue (invoice_list overdue: true)
    expect(
      plan(
        store,
        `status = 'issued' AND payment_status IN ('unpaid', 'partial') AND due_date IS NOT NULL AND due_date < ?` +
          ` AND gross_amount <> '0' AND gross_amount NOT LIKE '-%'`,
        ISSUED_DESC,
      ),
    ).toMatch(/USING INDEX invoices_overdue \(status=\? AND payment_status=\? AND due_date>\? AND due_date<\?\)/);
    // modification chain and customer filters
    expect(plan(store, `original_invoice_id = ? AND status IN (?, ?)`, ISSUED_ASC)).toMatch(/USING INDEX invoices_original/);
    expect(plan(store, `customer_id = ?`, ISSUED_DESC)).toMatch(/USING INDEX invoices_customer/);
    // default listing (newest first, no filter) walks the issue-date index instead of sorting the table
    expect(plan(store, '', ISSUED_DESC)).toMatch(/SCAN invoices USING INDEX invoices_issue_date/);
  });
});

// ---------------------------------------------------------------------------------------------
// nextModificationIndex
// ---------------------------------------------------------------------------------------------

describe('nextModificationIndex', () => {
  it('counts issued modification and storno invoices of the original', () => {
    const store = setup();
    const original = issue(store, draft(store));
    const other = issue(store, draft(store));
    const ref = (modificationIndex: number) => ({
      originalInvoiceId: original.id,
      originalInvoiceNumber: original.number ?? '',
      modificationIndex,
      modifyWithoutMaster: false,
    });
    expect(store.nextModificationIndex(original.id)).toBe(1);

    const mod = draft(store, { documentType: 'modification', totals: totals(500), reference: ref(1) });
    expect(store.nextModificationIndex(original.id)).toBe(1); // drafts do not count
    const modIssued = issue(store, mod);
    expect(store.nextModificationIndex(original.id)).toBe(2);

    // a storno of the original counts too, and so does a modification that was later cancelled
    const storno = issue(store, draft(store, { documentType: 'storno', totals: totals(-10500), reference: ref(2) }));
    store.patchInvoice(modIssued.id, { status: 'cancelled', cancelledById: storno.id });
    expect(store.nextModificationIndex(original.id)).toBe(3);

    // other documents referencing it (e.g. a regular invoice) are ignored; other originals are separate
    draft(store, { documentType: 'invoice', reference: ref(9) });
    expect(store.nextModificationIndex(original.id)).toBe(3);
    expect(store.nextModificationIndex(other.id)).toBe(1);
    expect(store.nextModificationIndex('inv_unknown')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// NAV submissions
// ---------------------------------------------------------------------------------------------

describe('NAV submissions', () => {
  it('records attempts, updates their outcome and lists them in order', () => {
    const store = setup();
    const inv = issue(store, draft(store));
    const base = {
      invoiceId: inv.id,
      operation: 'CREATE' as const,
      environment: 'test' as const,
      transactionId: null,
      status: 'sending' as const,
      invoiceDataBase64: Buffer.from('<InvoiceData/>').toString('base64'),
      messages: [],
      lastResponseXml: null,
    };
    const id1 = store.insertNavSubmission({ ...base, requestId: 'RID-1' });
    const id2 = store.insertNavSubmission({ ...base, requestId: 'RID-2' });
    expect(id2).toBeGreaterThan(id1);

    const before = store.listNavSubmissions(inv.id);
    expect(before.map((s) => s.requestId)).toEqual(['RID-1', 'RID-2']);
    expect(before[0]?.createdAt).toBe(before[0]?.updatedAt);

    const messages = [{ severity: 'ERROR' as const, code: 'INVALID_SECURITY_USER', message: 'Hibás technikai felhasználó' }];
    store.updateNavSubmission(id1, { status: 'error', messages, lastResponseXml: '<GeneralErrorResponse/>' });
    store.updateNavSubmission(id2, { status: 'processing', transactionId: 'TX-42' });
    const after = store.listNavSubmissions(inv.id);
    expect(after[0]).toMatchObject({
      id: id1,
      status: 'error',
      messages,
      lastResponseXml: '<GeneralErrorResponse/>',
      transactionId: null,
      createdAt: before[0]?.createdAt,
      invoiceDataBase64: base.invoiceDataBase64,
    });
    expect(after[0]?.updatedAt).not.toBe(before[0]?.updatedAt);
    expect(after[1]).toMatchObject({ id: id2, status: 'processing', transactionId: 'TX-42', operation: 'CREATE', environment: 'test' });

    expect(store.listNavSubmissions('inv_unknown')).toEqual([]);
    expect(codeOf(() => store.updateNavSubmission(9999, { status: 'done' }))).toBe('NOT_FOUND');
    expect(codeOf(() => store.insertNavSubmission({ ...base, invoiceId: 'inv_unknown', requestId: 'RID-3' }))).toBe('NOT_FOUND');
  });

  it('keeps the submitted payload immutable and the log undeletable', () => {
    const store = setup();
    const inv = issue(store, draft(store));
    const id = store.insertNavSubmission({
      invoiceId: inv.id,
      operation: 'CREATE',
      environment: 'production',
      requestId: 'RID-1',
      transactionId: null,
      status: 'sending',
      invoiceDataBase64: 'PEludm9pY2VEYXRhLz4=',
      messages: [],
      lastResponseXml: null,
    });
    const raw = store.unsafeRawDatabaseForTests();
    const err = rawError(() => raw.prepare(`UPDATE nav_submissions SET invoice_data_base64 = 'eA==' WHERE id = ?`).run(id));
    expect(mapDbError(err).code).toBe('IMMUTABLE_NAV_SUBMISSION');
    expect(rawFailure(() => raw.prepare(`UPDATE nav_submissions SET request_id = 'X' WHERE id = ?`).run(id))).toMatch(
      /^IMMUTABLE_NAV_SUBMISSION: /,
    );
    expect(rawFailure(() => raw.prepare('DELETE FROM nav_submissions WHERE id = ?').run(id))).toMatch(/^IMMUTABLE_NAV_SUBMISSION: /);
    expect(store.listNavSubmissions(inv.id)).toHaveLength(1);
  });

  it('an external connection (recursive_triggers OFF) cannot overwrite a submission with INSERT OR REPLACE', () => {
    const path = join(tempDir(), 'company.db');
    const store = setup(path);
    const inv = issue(store, draft(store));
    const payload = Buffer.from('<InvoiceData>eredeti</InvoiceData>').toString('base64');
    const id = store.insertNavSubmission({
      invoiceId: inv.id,
      operation: 'CREATE',
      environment: 'production',
      requestId: 'RID-1',
      transactionId: 'TX-1',
      status: 'done',
      invoiceDataBase64: payload,
      messages: [],
      lastResponseXml: null,
    });
    const other = openRaw(path);
    expect(other.prepare('PRAGMA recursive_triggers').get()).toEqual({ recursive_triggers: 0 });
    for (const verb of ['INSERT OR REPLACE', 'REPLACE']) {
      const message = rawFailure(() =>
        other
          .prepare(
            `${verb} INTO nav_submissions (id, invoice_id, operation, environment, request_id, transaction_id, status,
               invoice_data_base64, messages, last_response_xml, created_at, updated_at)
             VALUES (?, ?, 'CREATE', 'production', 'RID-1', 'TX-1', 'done', 'aGFtaXM=', '[]', NULL, 'x', 'x')`,
          )
          .run(id, inv.id),
      );
      expect(message).toMatch(/^IMMUTABLE_NAV_SUBMISSION: /);
    }
    expect(store.listNavSubmissions(inv.id).map((s) => s.invoiceDataBase64)).toEqual([payload]);
  });

  it("accepts an empty requestId: the service records the attempt before the NAV client generates it", () => {
    const store = setup();
    const inv = issue(store, draft(store));
    // exactly what OpenSzamla.navSubmitOne passes
    const id = store.insertNavSubmission({
      invoiceId: inv.id,
      operation: 'CREATE',
      environment: 'test',
      requestId: '',
      transactionId: null,
      status: 'sending',
      invoiceDataBase64: 'PEludm9pY2VEYXRhLz4=',
      messages: [],
      lastResponseXml: null,
    });
    store.updateNavSubmission(id, { transactionId: 'TX-9', status: 'processing' });
    expect(store.listNavSubmissions(inv.id)).toMatchObject([{ id, requestId: '', transactionId: 'TX-9', status: 'processing' }]);
    const notAString = { requestId: undefined } as unknown as { requestId: string };
    expect(
      codeOf(() =>
        store.insertNavSubmission({
          invoiceId: inv.id,
          operation: 'CREATE',
          environment: 'test',
          ...notAString,
          transactionId: null,
          status: 'sending',
          invoiceDataBase64: 'x',
          messages: [],
          lastResponseXml: null,
        }),
      ),
    ).toBe('INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------
// exact round trips
// ---------------------------------------------------------------------------------------------

describe('round trips', () => {
  it('keeps tricky text and every optional field exactly, so the content hash still matches', () => {
    const store = setup();
    const tricky = 'Idéző „jel” \\ "dupla"   sor\n tab\t NUL\u0000 emoji 😀 magányos \ud800 vége';
    const base = makeInvoice();
    const line = base.lines[0];
    if (!line) throw new Error('fixture has no line');
    const issued = issue(
      store,
      draft(store, {
        comment: tricky,
        internalNote: '',
        orderNumber: '  PO 1  ',
        exchangeRateDate: null,
        seller: { ...SELLER, phone: undefined, swift: 'GIBAHUHB', registrationNumber: '01-09-123456' },
        customer: { ...base.customer, email: 'vevo@pelda.hu', groupMemberTaxNumber: '24366183-1-13', address: { ...ADDRESS, region: 'Pest' } },
        lines: [
          {
            ...line,
            productId: 'prd_1',
            vatReason: tricky,
            modifiesLineNo: 1,
            modificationRef: { lineNumberReference: 2, lineOperation: 'CREATE' },
            quantity: '0.000001',
            unitPrice: '-12345678901234567890.123456789',
          },
        ],
        notations: [tricky, ''],
      }),
    );
    const back = mustGet(store, issued.id);
    expect(back).toEqual(issued);
    expect(back.comment).toBe(tricky);
    expect(back.lines[0]?.unitPrice).toBe('-12345678901234567890.123456789');
    expect(back.internalNote).toBe('');
    expect(back.exchangeRateDate).toBeNull();
    expect('phone' in back.seller).toBe(false);
    expect(sha256Hex(canonicalJson(immutablePart(back)))).toBe(issued.contentHash);
  });
});
