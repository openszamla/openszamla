/**
 * P1-1: verifyIntegrity (openszamla verify) checks every kept original PDF. Integrity failures: bytes that no longer
 * match the stored SHA-256 / SHA3-512 / size, fingerprints rewritten to match changed bytes (they differ from the
 * 'invoice.document' audit entry), an original without its audit entry, an audit entry whose original is gone. A
 * missing or different pdf/<name>.pdf is only a note: the next PDF request writes it again from the original.
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, type TestApp } from '../helpers/app.ts';

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const hex = (alg: string, b: Uint8Array): string => createHash(alg).update(b).digest('hex').toUpperCase();

/** Two issued invoices, SZ-2026-00001 and SZ-2026-00002, each with its kept original. */
async function setup(): Promise<{ app: OpenSzamla; ids: string[]; paths: string[] }> {
  t = makeTestApp({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  const app = t.app;
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const ids: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < 2; i++) {
    const d = await app.createDraft({ customerId, lines: [{ description: `Tétel ${i + 1}`, quantity: '1', unit: 'db', unitPrice: '10000', vatCode: '27' }] });
    const r = await app.issue(d.invoice.id);
    ids.push(r.invoice.id);
    paths.push(r.pdfPath as string);
  }
  return { app, ids, paths };
}

/** Runs `change` on the raw connection with the named triggers dropped, then puts them back unchanged. */
function withoutTriggers(app: OpenSzamla, names: string[], change: () => void): void {
  const db = app.store.unsafeRawDatabaseForTests();
  const saved = names.map((n) => String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(n)?.sql));
  for (const n of names) db.exec(`DROP TRIGGER ${n}`);
  try {
    change();
  } finally {
    for (const sql of saved) db.exec(sql);
  }
}

describe('verify checks the kept original PDFs (P1-1)', () => {
  it('a clean database: every original checked, nothing found', async () => {
    const { app } = await setup();
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 2, documentMismatches: [], documentWarnings: [], documentNotes: [], legacyDocuments: 0, alteredTriggers: [] });
  });

  it('changed bytes, and changed bytes with recomputed fingerprints, are failures', async () => {
    const { app, ids } = await setup();
    const db = app.store.unsafeRawDatabaseForTests();
    const original = app.store.getDocument(ids[0] as string)?.content as Buffer;
    const tampered = Buffer.from(original);
    tampered[200] = (tampered[200] as number) ^ 0x01;
    withoutTriggers(app, ['invoice_documents_update_guard'], () => {
      db.prepare('UPDATE invoice_documents SET content = ? WHERE invoice_id = ?').run(tampered, ids[0] as string);
    });
    let r = app.verifyIntegrity();
    expect(r).toMatchObject({ ok: false, alteredTriggers: [], audit: { ok: true } });
    expect(r.documentMismatches).toEqual(['SZ-2026-00001: a megőrzött eredeti PDF tartalma nem egyezik a vele tárolt lenyomattal (SHA-256, SHA3-512, méret).']);

    withoutTriggers(app, ['invoice_documents_update_guard'], () => {
      db.prepare('UPDATE invoice_documents SET sha256 = ?, sha3_512 = ? WHERE invoice_id = ?').run(hex('sha256', tampered), hex('sha3-512', tampered), ids[0] as string);
    });
    r = app.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.documentMismatches).toEqual(['SZ-2026-00001: a megőrzött eredeti PDF lenyomata eltér a megőrzéskor naplózottól.']);
    // The pdf/ file still holds the original: the program never overwrites it with the altered one (C1).
    expect(r.documentNotes).toEqual(['SZ-2026-00001: a pdf/SZ-2026-00001.pdf fájl eltér a megőrzött eredetitől, amely sérült: a program nem írja felül vele – ha a fájl a kiállításkor átadott PDF, őrizd meg.']);
  });

  it('an original without its audit entry, and an audit entry whose original was removed, are failures', async () => {
    const { app, ids } = await setup();
    const db = app.store.unsafeRawDatabaseForTests();
    // The last entry of the chain is the keeping of SZ-2026-00002: cutting it off leaves the chain intact.
    const last = db.prepare('SELECT id, action, entity_id FROM audit_log ORDER BY id DESC LIMIT 1').get();
    expect([last?.action, last?.entity_id]).toEqual(['invoice.document', ids[1]]);
    withoutTriggers(app, ['audit_log_delete_guard'], () => {
      db.prepare('DELETE FROM audit_log WHERE id = ?').run(last?.id as number);
    });
    let r = app.verifyIntegrity();
    expect(r).toMatchObject({ ok: false, audit: { ok: true }, alteredTriggers: [] });
    expect(r.documentMismatches).toEqual(['SZ-2026-00002: a megőrzött eredeti PDF megőrzése nincs naplózva (invoice.document).']);

    withoutTriggers(app, ['invoice_documents_delete_guard'], () => {
      db.prepare('DELETE FROM invoice_documents WHERE invoice_id = ?').run(ids[0] as string);
    });
    r = app.verifyIntegrity();
    expect(r.documentsChecked).toBe(1);
    expect(r.documentMismatches).toEqual([
      'SZ-2026-00002: a megőrzött eredeti PDF megőrzése nincs naplózva (invoice.document).',
      expect.stringMatching(/^SZ-2026-00001: az eredeti PDF megőrzése naplózva van \(#\d+\), de a megőrzött PDF hiányzik az adatbázisból\.$/),
    ]);
    // Asking for its PDF does not put a new render in its place: the logged original is missing, verify keeps saying so.
    await expect(app.pdf(ids[0] as string)).rejects.toMatchObject({
      code: 'DOCUMENT_MISSING',
      message: 'A(z) SZ-2026-00001 megőrzött eredeti PDF-je hiányzik az adatbázisból, pedig a napló szerint a program megőrizte; helyette újat nem állít elő.',
      hint: expect.stringMatching(/openszamla verify .*legutóbbi mentésből/),
    });
    expect(app.store.getDocument(ids[0] as string)).toBeNull();
    expect(app.verifyIntegrity().documentMismatches).toHaveLength(2);
    // A MÁSOLAT can still be made (it is never the original).
    expect((await app.pdf(ids[0] as string, { copy: true })).kind).toBe('copy');
  });

  it('an original kept again after the first was removed differs from the logged fingerprints', async () => {
    const { app, ids } = await setup();
    const db = app.store.unsafeRawDatabaseForTests();
    const first = app.store.getDocument(ids[0] as string)?.content as Buffer;
    const other = Buffer.from(first);
    other[100] = (other[100] as number) ^ 0x01;
    // Replaced with other bytes (and their own fingerprints) behind the program's back.
    withoutTriggers(app, ['invoice_documents_delete_guard'], () => {
      db.prepare('DELETE FROM invoice_documents WHERE invoice_id = ?').run(ids[0] as string);
    });
    app.store.insertDocument({ invoiceId: ids[0] as string, content: other, software: 'OpenSzámla 9.9.9' });
    const r = app.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.documentMismatches).toEqual(['SZ-2026-00001: a megőrzött eredeti PDF lenyomata eltér a megőrzéskor naplózottól.']);
  });

  it('a missing or different pdf/ file is a note only, and the next PDF request writes the original again', async () => {
    const { app, ids, paths } = await setup();
    const original = readFileSync(paths[1] as string);
    rmSync(paths[0] as string);
    writeFileSync(paths[1] as string, 'nem az eredeti');
    const r = app.verifyIntegrity();
    expect(r).toMatchObject({ ok: true, documentMismatches: [], documentWarnings: [] });
    expect(r.documentNotes).toEqual([
      'SZ-2026-00001: a pdf/SZ-2026-00001.pdf fájl hiányzik – a következő PDF-kéréskor a program a megőrzött eredetiből újra kiírja.',
      'SZ-2026-00002: a pdf/SZ-2026-00002.pdf fájl eltér a megőrzött eredetitől – a következő PDF-kéréskor a program a megőrzött eredetivel felülírja.',
    ]);
    for (const id of ids) expect((await app.pdf(id)).kind).toBe('original');
    expect(readFileSync(paths[1] as string).equals(original)).toBe(true);
    expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentNotes: [] });
  });
});
