/**
 * The invoice page says, next to "PDF letöltése", what the download gives (OpenSzamla.pdfInfo – nothing is rendered or
 * written for the page): an issued document's kept original with its SHA-256; for one whose PDF could not be made at
 * issue, that the first download keeps it; for a document issued before originals were kept, the regenerated PDF – not
 * the one handed over – with its file name; a draft's TERVEZET; and DOCUMENT_MISSING when a logged original is gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { legacyDataDir } from '../helpers/legacy-data.ts';
import { Browser, startWeb, TOKEN, type WebEnv } from './helpers.ts';

vi.mock('../../src/pdf/render.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/pdf/render.ts')>();
  return { ...real, renderInvoicePdf: vi.fn(real.renderInvoicePdf) };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const LINES = [{ description: 'Tanácsadás', quantity: '3', unit: 'óra', unitPrice: '20000', vatCode: '27' as const }];

/** The page head (title, badges, key facts, the PDF note and the action links). */
function headOf(body: string): string {
  const start = body.indexOf('<div class="page-head">');
  return body.slice(start, body.indexOf('<section', start));
}

async function env(): Promise<{ e: WebEnv; customerId: string }> {
  const e = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
  cleanups.push(() => e.close());
  e.app.updateSeller(SELLER_INPUT);
  return { e, customerId: e.app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id };
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

describe('the invoice page names the PDF its download gives', () => {
  it('an issued document: the kept original with its SHA-256; a draft: the TERVEZET – the page renders no PDF', async () => {
    const { e, customerId } = await env();
    const d = await e.app.createDraft({ customerId, lines: LINES });
    await e.app.issue(d.invoice.id);
    const sha = e.app.store.getDocument(d.invoice.id)?.sha256 as string;
    expect(sha).toMatch(/^[0-9A-F]{64}$/);
    const draft = await e.app.createDraft({ customerId, lines: LINES });
    vi.mocked(renderInvoicePdf).mockClear();

    const b = await e.loggedIn();
    const body = (await b.get(`/invoices/${d.invoice.id}`)).body;
    // The log names the kept original in Hungarian, its fingerprints monospaced (they wrap on a phone).
    expect(body).toContain('<span class="muted">fajta:</span> eredeti PDF');
    expect(body).toContain(`<span class="muted">SHA-256:</span> <span class="mono">${sha}</span>`);
    expect(body).toMatch(/<span class="muted">méret:<\/span> \d+ bájt/);
    const head = headOf(body);
    expect(head).toContain(`<a class="btn" aria-describedby="pdf-note" href="/invoices/${d.invoice.id}.pdf">PDF letöltése</a>`);
    expect(head).toContain('<p class="facts" id="pdf-note"><span>PDF: <strong>a megőrzött eredeti</strong> – a kiállításkor készült, a letöltés bájtra pontosan ezt adja</span>');
    expect(head).toContain(`SHA-256: <span class="mono">${sha}</span>`);
    const draftHead = headOf((await b.get(`/invoices/${draft.invoice.id}`)).body);
    expect(draftHead).toContain('PDF: <strong>tervezet</strong> („TERVEZET – NEM SZÁMLA” vízjellel) – nem számla');
    expect(draftHead).not.toContain('SHA-256');
    expect(vi.mocked(renderInvoicePdf)).not.toHaveBeenCalled();
    expect(e.app.store.getDocument(draft.invoice.id)).toBeNull();
  });

  it('a PDF that could not be made at issue: the page says the first download keeps it; after the download, its SHA-256', async () => {
    const { e, customerId } = await env();
    const d = await e.app.createDraft({ customerId, lines: LINES });
    vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('nincs elég memória'));
    const r = await e.app.issue(d.invoice.id);
    expect(r.pdfError).toBe('nincs elég memória');

    const b = await e.loggedIn();
    const before = headOf((await b.get(`/invoices/${d.invoice.id}`)).body);
    expect(before).toContain('PDF: <strong>eredeti</strong> – Az eredeti PDF a kiállításkor nem készült el: az első PDF-kérés (letöltés) készíti el, és azt őrzi meg eredetiként.');
    expect(e.app.store.getDocument(d.invoice.id)).toBeNull();
    expect((await b.get(`/invoices/${d.invoice.id}.pdf`)).status).toBe(200);
    const kept = e.app.store.getDocument(d.invoice.id);
    expect(kept).not.toBeNull();
    expect(headOf((await b.get(`/invoices/${d.invoice.id}`)).body)).toContain(`SHA-256: <span class="mono">${kept?.sha256}</span>`);
  });

  it('a document issued before originals were kept: "újra előállított, nem az eredeti" and the file name; the view writes nothing', async () => {
    const legacy = await legacyDataDir(() => {
      vi.mocked(renderInvoicePdf).mockRejectedValueOnce(new Error('0.1.0: a PDF csak fájlba került'));
    });
    cleanups.push(() => legacy.cleanup());
    const app = legacy.open();
    const http = await startHttpServer(app, { port: 0, token: TOKEN });
    cleanups.push(() => http.close());
    const b = new Browser(http.url);
    await b.login();
    vi.mocked(renderInvoicePdf).mockClear();
    const head = headOf((await b.get(`/invoices/${legacy.invoice.id}`)).body);
    expect(head).toContain('PDF: újra előállított, nem az eredeti</span>');
    expect(head).toContain('nem bájtra azonos a vevőnek átadott PDF-fel. A letöltött fájl neve: SZ-2026-00002_UJRAELOALLITOTT.pdf.');
    expect(head).not.toContain('SHA-256');
    // Viewing the page renders nothing and logs nothing: only the download writes (and logs) the regenerated file.
    expect(vi.mocked(renderInvoicePdf)).not.toHaveBeenCalled();
    expect(app.auditLog({ entityId: legacy.invoice.id }).items.some((x) => x.action === 'invoice.pdf_regenerated')).toBe(false);
  });

  it('a logged original missing from the database: the page says the PDF cannot be downloaded, and why', async () => {
    const { e, customerId } = await env();
    const d = await e.app.createDraft({ customerId, lines: LINES });
    await e.app.issue(d.invoice.id);
    withoutTriggers(e.app, ['invoice_documents_delete_guard'], () => {
      e.app.store.unsafeRawDatabaseForTests().prepare('DELETE FROM invoice_documents WHERE invoice_id = ?').run(d.invoice.id);
    });
    const b = await e.loggedIn();
    const page = await b.get(`/invoices/${d.invoice.id}`);
    expect(page.status).toBe(200);
    const head = headOf(page.body);
    expect(head).toContain('a PDF most nem tölthető le</span>');
    expect(head).toContain('A(z) SZ-2026-00001 megőrzött eredeti PDF-je hiányzik az adatbázisból, pedig a napló szerint a program megőrizte; helyette újat nem állít elő.');
    expect(e.app.store.getDocument(d.invoice.id)).toBeNull();
  });
});
