/**
 * C1: a kept original PDF whose bytes no longer match its fingerprints – changed in the database with the protective
 * triggers dropped, or a damaged disk (SQLite keeps no page checksums) – is never served as the original: pdf(),
 * pdfInfo(), the MCP tool and resource, invoice_get, the web download and page, `openszamla pdf` and the tax-audit
 * export all refuse it (DOCUMENT_INTEGRITY_FAILED, audited once), and the intact pdf/<name>.pdf – the last genuine copy –
 * is never overwritten with it. A MÁSOLAT can still be made.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { cli } from '../helpers/cli.ts';
import { flashesOf, startWeb, type WebEnv } from '../web/helpers.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const ALTERED =
  'A(z) SZ-2026-00001 megőrzött eredeti PDF-je sérült vagy módosult: nem egyezik a kiállításkor rögzített lenyomatával, ezért a program nem adja ki eredetiként, és a pdf/ mappában lévő fájlt sem írja felül vele.';
const HINT = 'Futtasd az openszamla verify parancsot, és állítsd vissza az adatbázist a legutóbbi ép mentésből (a mentés a megőrzött PDF-eket is tartalmazza).';

const hex = (alg: string, b: Uint8Array): string => createHash(alg).update(b).digest('hex').toUpperCase();

/** A web environment with SZ-2026-00001 and SZ-2026-00002 issued, each with its kept original and pdf/ file. */
async function issuedTwo(): Promise<{ e: WebEnv; ids: string[]; paths: string[] }> {
  const e = await startWeb({ now: () => new Date('2026-11-19T09:00:00.000Z') });
  cleanups.push(() => e.close());
  e.app.updateSeller(SELLER_INPUT);
  const customerId = e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const ids: string[] = [];
  const paths: string[] = [];
  for (const description of ['Tanácsadás', 'Fejlesztés']) {
    const d = await e.app.createDraft({ customerId, lines: [{ description, quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const r = await e.app.issue(d.invoice.id);
    ids.push(r.invoice.id);
    paths.push(r.pdfPath as string);
  }
  return { e, ids, paths };
}

/** Runs `change` on the raw connection with the update guard of invoice_documents dropped, then puts it back. */
function behindTheProgramsBack(app: OpenSzamla, change: (db: ReturnType<OpenSzamla['store']['unsafeRawDatabaseForTests']>) => void): void {
  const db = app.store.unsafeRawDatabaseForTests();
  const sql = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'invoice_documents_update_guard'`).get()?.sql);
  db.exec('DROP TRIGGER invoice_documents_update_guard');
  try {
    change(db);
  } finally {
    db.exec(sql);
  }
}

/** One byte of the kept original of `id` flipped; with `refingerprint` the stored SHA-256 / SHA3-512 follow the new bytes. */
function alter(app: OpenSzamla, id: string, refingerprint: boolean): Buffer {
  const original = app.store.getDocument(id)?.content as Buffer;
  const changed = Buffer.from(original);
  changed[300] = (changed[300] as number) ^ 0x01;
  behindTheProgramsBack(app, (db) => {
    db.prepare('UPDATE invoice_documents SET content = ? WHERE invoice_id = ?').run(changed, id);
    if (refingerprint) db.prepare('UPDATE invoice_documents SET sha256 = ?, sha3_512 = ? WHERE invoice_id = ?').run(hex('sha256', changed), hex('sha3-512', changed), id);
  });
  return original;
}

const alteredAudits = (app: OpenSzamla, id: string) => app.auditLog({ entityId: id }).items.filter((x) => x.action === 'invoice.document_altered');

describe('an altered kept original is never served (C1)', () => {
  it.each([
    ['changed bytes, the stored fingerprints left as they were', false],
    ['changed bytes with fingerprints recomputed to match them (they differ from the audit entry)', true],
  ])('%s: pdf() and pdfInfo() refuse it, the genuine pdf/ file stays, the refusal is logged once', async (_name, refingerprint) => {
    const { e, ids, paths } = await issuedTwo();
    const genuine = alter(e.app, ids[0] as string, refingerprint);
    expect(readFileSync(paths[0] as string).equals(genuine)).toBe(true);

    for (let i = 0; i < 2; i++) {
      await expect(e.app.pdf(ids[0] as string)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILED', message: ALTERED, hint: HINT });
      expect(() => e.app.pdfInfo('SZ-2026-00001')).toThrow(expect.objectContaining({ code: 'DOCUMENT_INTEGRITY_FAILED', message: ALTERED }));
    }
    await expect(e.app.pdf(ids[0] as string, { base64: true })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILED' });
    // The last genuine copy is not overwritten with the altered bytes.
    expect(readFileSync(paths[0] as string).equals(genuine)).toBe(true);
    const logged = alteredAudits(e.app, ids[0] as string);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.details).toMatchObject({ number: 'SZ-2026-00001', storedSize: genuine.length, size: genuine.length });
    expect(logged[0]?.details.sha256).not.toBe(hex('sha256', genuine));
    // The other document is served as before; a MÁSOLAT is never the original and can still be made.
    expect((await e.app.pdf(ids[1] as string)).kind).toBe('original');
    expect(e.app.pdfInfo(ids[1] as string).kind).toBe('original');
    expect((await e.app.pdf(ids[0] as string, { copy: true })).kind).toBe('copy');
    // verify reports it, and no longer promises to overwrite the pdf/ file with it.
    const r = e.app.verifyIntegrity();
    expect(r.ok).toBe(false);
    expect(r.documentNotes).toEqual([
      'SZ-2026-00001: a pdf/SZ-2026-00001.pdf fájl eltér a megőrzött eredetitől, amely sérült: a program nem írja felül vele – ha a fájl a kiállításkor átadott PDF, őrizd meg.',
    ]);
  });

  it('the tax-audit export names it among its warnings and does not copy it', async () => {
    const { e, ids } = await issuedTwo();
    alter(e.app, ids[0] as string, false);
    const r = await e.app.taxAuditExport({ from: '2026-11-19', to: '2026-11-19' });
    expect(r.count).toBe(2);
    expect(r.warnings).toEqual([{ invoiceNumber: 'SZ-2026-00001', field: 'pdf', message: `Az export nem tartalmazza a PDF-jét: ${ALTERED} ${HINT}` }]);
    expect(existsSync(join(r.path, 'pdf', 'SZ-2026-00001.pdf'))).toBe(false);
    expect(readFileSync(join(r.path, 'pdf', 'SZ-2026-00002.pdf')).equals(e.app.store.getDocument(ids[1] as string)?.content as Buffer)).toBe(true);
    expect(readFileSync(join(r.path, 'OLVASSEL.txt'), 'utf8')).toContain(`SZ-2026-00001 (pdf): Az export nem tartalmazza a PDF-jét: ${ALTERED}`);
  });

  it.each(['legacy', 'modern'] as const)('MCP (%s era): invoice_pdf and the resource refuse it, invoice_get names the problem', async (era) => {
    const { e, ids } = await issuedTwo();
    alter(e.app, ids[0] as string, false);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(e.app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    const pdf = (await client.callTool({ name: 'invoice_pdf', arguments: { invoice: 'SZ-2026-00001' } })) as { isError?: boolean; structuredContent: { error: Record<string, unknown> } };
    expect(pdf.isError).toBe(true);
    expect(pdf.structuredContent.error).toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILED', message: ALTERED });
    await expect(client.readResource({ uri: `openszamla://invoices/${ids[0]}/pdf` })).rejects.toThrow(/sérült vagy módosult/);
    const got = (await client.callTool({ name: 'invoice_get', arguments: { invoice: 'SZ-2026-00001' } })) as { isError?: boolean; structuredContent: { pdf: Record<string, unknown> } };
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent.pdf).toMatchObject({ path: null, kind: null, sha256: null, problem: { code: 'DOCUMENT_INTEGRITY_FAILED', message: ALTERED } });
  });

  it('the web: the download is refused with the message, the invoice page says the PDF cannot be downloaded', async () => {
    const { e, ids, paths } = await issuedTwo();
    const genuine = alter(e.app, ids[0] as string, false);
    const b = await e.loggedIn();
    const r = await b.get(`/invoices/${ids[0]}.pdf`);
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(flashesOf(r.body)).toContain(ALTERED);
    const page = await b.get(`/invoices/${ids[0]}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('a PDF most nem tölthető le');
    expect(page.body).toContain('sérült vagy módosult');
    expect(page.body).not.toContain('SHA-256: <span class="mono">');
    expect(readFileSync(paths[0] as string).equals(genuine)).toBe(true);
  });

  it('openszamla pdf refuses it (exit 1) and leaves the pdf/ file alone', async () => {
    const { e, ids, paths } = await issuedTwo();
    const genuine = alter(e.app, ids[0] as string, false);
    const r = await cli(['pdf', 'SZ-2026-00001', '--data-dir', e.app.config.dataDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Hiba [DOCUMENT_INTEGRITY_FAILED]: ${ALTERED}`);
    expect(r.stderr).toContain(`Tipp: ${HINT}`);
    expect(r.stdout).toBe('');
    expect(readFileSync(paths[0] as string).equals(genuine)).toBe(true);
  });
});
