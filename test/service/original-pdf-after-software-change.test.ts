/**
 * P1-1: the footer and metadata of a PDF carry the program name and version that rendered it, so a re-render after an
 * update is a different file. The PDF of an issued document is never rendered again: after the program name or the
 * version changed, pdf() returns the original's bytes and sha256, and rewrites pdf/<name>.pdf from them when the file
 * is missing or differs. A MÁSOLAT is rendered by the running program.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInvoicePdf } from '../../src/pdf/render.ts';
import { OpenSzamla } from '../../src/service/app.ts';
import { DEFAULT_SOFTWARE, loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';

/** The program version, switchable in the test (VERSION is read from package.json). */
const version = vi.hoisted(() => ({ value: '' }));
vi.mock('../../src/version.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/version.ts')>();
  version.value = real.VERSION;
  return {
    get VERSION() {
      return version.value;
    },
  };
});

const dirs: string[] = [];
const apps: OpenSzamla[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const NOW = new Date('2026-11-14T09:00:00.000Z');

function open(dir: string, softwareName = DEFAULT_SOFTWARE.softwareName): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none', software: { ...DEFAULT_SOFTWARE, softwareName } } });
  const app = OpenSzamla.open({ config, now: () => NOW });
  apps.push(app);
  return app;
}

async function issuedIn(dir: string): Promise<{ id: string; path: string; bytes: Buffer; sha256: string }> {
  const app = open(dir);
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  const r = await app.issue(d.invoice.id);
  const kept = app.store.getDocument(r.invoice.id);
  app.close();
  apps.pop();
  return { id: r.invoice.id, path: r.pdfPath as string, bytes: readFileSync(r.pdfPath as string), sha256: kept?.sha256 as string };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-version-'));
  dirs.push(dir);
  return dir;
}

describe('the original stays byte for byte the same after the program changed (P1-1)', () => {
  it('another program name: the same bytes and sha256, while a fresh render differs', async () => {
    const dir = tempDir();
    const before = await issuedIn(dir);
    const app = open(dir, 'OpenSzámla Próbaváltozat');
    const inv = app.getInvoice(before.id);
    const fresh = await renderInvoicePdf(inv, { softwareName: `OpenSzámla Próbaváltozat ${version.value}` });
    expect(fresh.equals(before.bytes)).toBe(false);

    const r = await app.pdf(before.id, { base64: true });
    expect(r).toMatchObject({ kind: 'original', sha256: before.sha256, path: before.path, bytes: before.bytes.length });
    expect(Buffer.from(r.base64 as string, 'base64').equals(before.bytes)).toBe(true);
    expect(readFileSync(before.path).equals(before.bytes)).toBe(true);
    // A MÁSOLAT carries the running program.
    const copy = await app.pdf(before.id, { copy: true });
    expect(readFileSync(copy.path).equals(await renderInvoicePdf(inv, { copy: true, softwareName: `OpenSzámla Próbaváltozat ${version.value}` }))).toBe(true);
  });

  it('another version: the same bytes; a missing or altered pdf/ file is written again from the original', async () => {
    const dir = tempDir();
    const before = await issuedIn(dir);
    const real = version.value;
    version.value = '9.9.9';
    try {
      const app = open(dir);
      expect(app.status().version).toBe('9.9.9');
      const fresh = await renderInvoicePdf(app.getInvoice(before.id), { softwareName: 'OpenSzámla 9.9.9' });
      expect(fresh.equals(before.bytes)).toBe(false);
      expect((await app.pdf(before.id)).sha256).toBe(before.sha256);
      expect(readFileSync(before.path).equals(before.bytes)).toBe(true);

      rmSync(before.path);
      const rewritten = await app.pdf(before.id);
      expect(rewritten).toMatchObject({ kind: 'original', path: before.path, sha256: before.sha256 });
      expect(readFileSync(before.path).equals(before.bytes)).toBe(true);

      writeFileSync(before.path, fresh);
      expect((await app.pdf(before.id)).kind).toBe('original');
      expect(readFileSync(before.path).equals(before.bytes)).toBe(true);
      expect(app.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 1, documentMismatches: [], documentNotes: [] });
    } finally {
      version.value = real;
    }
  });
});
