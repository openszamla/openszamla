/**
 * P1-1: issuing renders the PDF once, after the issue transaction, and keeps it in the database as the document's
 * original – its bytes, SHA-256 and SHA3-512 (uppercase hex) and the program that rendered it – with an
 * 'invoice.document' audit entry carrying the same fingerprints; pdf/<name>.pdf is written from the kept bytes. Every
 * issued document gets one: invoice, előlegszámla, végszámla, módosító and sztornó számla, díjbekérő. A draft
 * (TERVEZET) and a copy (MÁSOLAT) are rendered on demand and never kept.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import type { DraftInput } from '../../src/service/inputs.ts';
import { VERSION } from '../../src/version.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const hex = (alg: string, b: Uint8Array): string => createHash(alg).update(b).digest('hex').toUpperCase();
const LINES: DraftInput['lines'] = [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }];

function setup(): { app: OpenSzamla; customerId: string } {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  t.app.updateSeller(SELLER_INPUT);
  return { app: t.app, customerId: t.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
}

/** The kept original of an issued document equals its pdf/ file and its audit entry. */
function expectKept(app: OpenSzamla, inv: Invoice, pdfPath: string | null): void {
  const kept = app.store.getDocument(inv.id);
  expect(kept, inv.number as string).not.toBeNull();
  const bytes = readFileSync(pdfPath as string);
  expect(basename(pdfPath as string)).toBe(`${inv.number}.pdf`);
  expect(kept?.content.equals(bytes), inv.number as string).toBe(true);
  expect(kept).toMatchObject({ kind: 'original', sha256: hex('sha256', bytes), sha3_512: hex('sha3-512', bytes), size: bytes.length, software: `OpenSzámla ${VERSION}` });
  const entries = app.auditLog({ entityId: inv.id }).items.filter((e) => e.action === 'invoice.document');
  expect(entries.map((e) => e.details), inv.number as string).toEqual([
    { number: inv.number, kind: 'original', sha256: kept?.sha256, sha3_512: kept?.sha3_512, size: bytes.length, software: `OpenSzámla ${VERSION}` },
  ]);
}

describe('the PDF of every issued document is kept as it was handed over (P1-1)', () => {
  it('issue keeps the original; a later request returns exactly its bytes and sha256', async () => {
    const { app, customerId } = setup();
    const d = await app.createDraft({ customerId, lines: LINES });
    const r = await app.issue(d.invoice.id, {}, 'cli');
    expect(r.pdfError).toBeNull();
    expectKept(app, r.invoice, r.pdfPath);
    const entry = app.auditLog({ entityId: r.invoice.id }).items[0];
    expect([entry?.action, entry?.actor]).toEqual(['invoice.document', 'cli']);

    const kept = app.store.getDocument(r.invoice.id);
    const again = await app.pdf(r.invoice.number as string, { base64: true });
    expect(again).toMatchObject({ kind: 'original', sha256: kept?.sha256, path: r.pdfPath, bytes: kept?.size, note: 'A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.' });
    expect(Buffer.from(again.base64 as string, 'base64').equals(kept?.content as Buffer)).toBe(true);
    // Nothing new is kept or logged.
    expect(app.auditLog({ entityId: r.invoice.id }).items.filter((e) => e.action === 'invoice.document')).toHaveLength(1);
  });

  it('every document type gets its original: advance, final, modification, storno, proforma', async () => {
    const { app, customerId } = setup();
    const issue = async (input: Partial<DraftInput>): Promise<Invoice> => {
      const d = await app.createDraft({ customerId, lines: LINES, ...input });
      const r = await app.issue(d.invoice.id);
      expectKept(app, r.invoice, r.pdfPath);
      return r.invoice;
    };
    const advance = await issue({ documentType: 'advance', fulfillmentDate: '2026-11-02', lines: [{ description: 'Előleg', quantity: '1', unit: 'db', unitPrice: '100000', vatCode: '27' }] });
    const final = await issue({
      documentType: 'final',
      lines: [
        { description: 'Gépsor', quantity: '1', unit: 'db', unitPrice: '500000', vatCode: '27' },
        { description: 'Előleg levonása', quantity: '-1', unit: 'db', unitPrice: '100000', vatCode: '27', advanceDeduction: { advanceInvoiceNumber: advance.number as string, advancePaymentDate: '2026-11-02' } },
      ],
    });
    expect(final.documentType).toBe('final');
    const invoice = await issue({});
    const correction = await app.createCorrectionDraft(invoice.id, { lines: [{ description: 'Árengedmény', quantity: '-1', unit: 'óra', unitPrice: '15000', vatCode: '27' }], comment: 'Kedvezmény' });
    const modification = await app.issue(correction.invoice.id);
    expect(modification.invoice.documentType).toBe('modification');
    expectKept(app, modification.invoice, modification.pdfPath);
    const storno = await app.cancel(invoice.id, { reason: 'Téves számla' });
    expect(storno.invoice.documentType).toBe('storno');
    expectKept(app, storno.invoice, storno.pdfPath);
    // The cancelled invoice keeps its original as it was.
    expect((await app.pdf(invoice.id)).kind).toBe('original');
    const proforma = await issue({ documentType: 'proforma' });
    expect(proforma.documentType).toBe('proforma');
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 6, documentMismatches: [], documentWarnings: [], documentNotes: [], legacyDocuments: 0 });
  });

  it('a draft and a MÁSOLAT are rendered on demand and never kept', async () => {
    const { app, customerId } = setup();
    const d = await app.createDraft({ customerId, lines: LINES });
    const draft = await app.pdf(d.invoice.id);
    expect(draft).toMatchObject({ kind: 'draft', sha256: null });
    expect(basename(draft.path)).toBe(`TERVEZET_${d.invoice.id}.pdf`);
    expect(app.store.getDocument(d.invoice.id)).toBeNull();
    expect(() => app.store.insertDocument({ invoiceId: d.invoice.id, content: readFileSync(draft.path), software: 'x' })).toThrow(expect.objectContaining({ code: 'IMMUTABLE_DOCUMENT' }));

    const r = await app.issue(d.invoice.id);
    const kept = app.store.getDocument(r.invoice.id);
    const copy = await app.pdf(r.invoice.id, { copy: true });
    expect(copy).toMatchObject({ kind: 'copy', sha256: null, note: 'MÁSOLAT jelölésű példány, most előállítva – nem az eredeti PDF.' });
    expect(basename(copy.path)).toBe(`${r.invoice.number}_MASOLAT.pdf`);
    expect(readFileSync(copy.path).equals(kept?.content as Buffer)).toBe(false);
    expect(app.store.getDocument(r.invoice.id)?.content.equals(kept?.content as Buffer)).toBe(true);
    expect(readFileSync(r.pdfPath as string).equals(kept?.content as Buffer)).toBe(true);
    expect(existsSync(copy.path)).toBe(true);
  });
});
