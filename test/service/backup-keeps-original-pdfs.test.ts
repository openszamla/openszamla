/**
 * P1-1: the kept originals live in the database, so a backup (openszamla backup) holds them. Restored into a fresh data
 * folder – without the pdf/ folder of the old one – every document's PDF is the original, byte for byte, with its
 * sha256, and verify finds the backup intact (the missing pdf/ files are notes only, written again on request).
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { DEFAULT_SOFTWARE, loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';

const dirs: string[] = [];
const apps: OpenSzamla[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openszamla-backup-'));
  dirs.push(dir);
  return dir;
}

function open(dir: string, softwareName = DEFAULT_SOFTWARE.softwareName): OpenSzamla {
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none', software: { ...DEFAULT_SOFTWARE, softwareName } } });
  const app = OpenSzamla.open({ config, now: () => new Date('2026-11-14T09:00:00.000Z') });
  apps.push(app);
  return app;
}

describe('a backup holds the kept original PDFs (P1-1)', () => {
  it('restored into a fresh data folder, every PDF is the original', async () => {
    const dir = tempDir();
    const app = open(dir);
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const originals = new Map<string, { number: string; bytes: Buffer; sha256: string }>();
    for (const unitPrice of ['10000', '25000']) {
      const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
      const r = await app.issue(d.invoice.id);
      originals.set(r.invoice.id, { number: r.invoice.number as string, bytes: readFileSync(r.pdfPath as string), sha256: app.store.getDocument(r.invoice.id)?.sha256 as string });
    }
    const storno = await app.cancel([...originals.keys()][0] as string, { reason: 'Téves számla' });
    originals.set(storno.invoice.id, { number: storno.invoice.number as string, bytes: readFileSync(storno.pdfPath as string), sha256: app.store.getDocument(storno.invoice.id)?.sha256 as string });
    const backup = join(tempDir(), 'mentes.db');
    app.store.backup(backup);

    // A fresh folder (another machine), opened by a program with another name: nothing is rendered again.
    const fresh = tempDir();
    copyFileSync(backup, join(fresh, 'openszamla.db'));
    const restored = open(fresh, 'OpenSzámla Másik Gép');
    const before = restored.verifyIntegrity();
    expect(before).toMatchObject({ ok: true, documentsChecked: 3, documentMismatches: [], documentWarnings: [] });
    expect(before.documentNotes).toHaveLength(3);
    for (const [id, o] of originals) {
      expect(restored.store.getDocument(id)?.content.equals(o.bytes), o.number).toBe(true);
      const r = await restored.pdf(id);
      expect(r, o.number).toMatchObject({ kind: 'original', sha256: o.sha256, path: join(fresh, 'pdf', `${o.number}.pdf`) });
      expect(readFileSync(r.path).equals(o.bytes), o.number).toBe(true);
    }
    expect(restored.verifyIntegrity()).toMatchObject({ ok: true, documentsChecked: 3, documentNotes: [] });
    expect(existsSync(join(dir, 'pdf'))).toBe(true);
  });
});
