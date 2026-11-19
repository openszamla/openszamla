/**
 * P1-1 on the command line: `openszamla pdf` prints the file, what it is (the kept original) and its SHA-256;
 * `openszamla verify` reports the kept originals – a missing pdf/ file is a note (exit 0), changed PDF bytes are an
 * integrity failure (exit 2); a backup made with `openszamla backup` restores the originals byte for byte.
 */
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

function open(dir: string): OpenSzamla {
  return OpenSzamla.open({ config: loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } }) });
}

/** A data folder with SZ-<year>-00001 issued; its kept original. */
async function issued(): Promise<{ dir: string; id: string; number: string; bytes: Buffer; sha256: string }> {
  const dir = tempDir();
  const app = open(dir);
  try {
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '20000', vatCode: '27' }] });
    const r = await app.issue(d.invoice.id);
    const kept = app.store.getDocument(r.invoice.id);
    return { dir, id: r.invoice.id, number: r.invoice.number as string, bytes: kept?.content as Buffer, sha256: kept?.sha256 as string };
  } finally {
    app.close();
  }
}

describe('openszamla pdf, verify and backup with kept originals (P1-1)', () => {
  it('pdf prints the file, the kind and the SHA-256; verify notes a missing file and fails on changed bytes', async () => {
    const x = await issued();
    const pdf = await cli(['pdf', x.number, '--data-dir', x.dir]);
    expect(pdf.code, pdf.stderr).toBe(0);
    const file = join(x.dir, 'pdf', `${x.number}.pdf`);
    expect(pdf.stdout.split(/\r?\n/)).toEqual([file, 'A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.', `SHA-256: ${x.sha256}`, '']);
    expect(readFileSync(file).equals(x.bytes)).toBe(true);

    let v = await cli(['verify', '--data-dir', x.dir]);
    expect(v.code).toBe(0);
    for (const s of ['Megőrzött eredeti PDF-ek: 1', 'A megőrzött eredeti PDF-ekkel ellentmondó adatok: nincs', 'Eredmény: rendben.']) expect(v.stdout, s).toContain(s);
    expect(v.stdout).not.toContain('Megjegyzés:');

    rmSync(file);
    v = await cli(['verify', '--data-dir', x.dir]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain(`Megjegyzés: ${x.number}: a pdf/${x.number}.pdf fájl hiányzik – a következő PDF-kéréskor a program a megőrzött eredetiből újra kiírja.`);
    expect(v.stdout).toContain('Eredmény: rendben.');

    // The bytes changed with an SQLite tool (its guard dropped and put back).
    const app = open(x.dir);
    const db = app.store.unsafeRawDatabaseForTests();
    const guard = String(db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'invoice_documents_update_guard'`).get()?.sql);
    db.exec('DROP TRIGGER invoice_documents_update_guard');
    const changed = Buffer.from(x.bytes);
    changed[300] = (changed[300] as number) ^ 0x20;
    db.prepare('UPDATE invoice_documents SET content = ? WHERE invoice_id = ?').run(changed, x.id);
    db.exec(guard);
    app.close();
    v = await cli(['verify', '--data-dir', x.dir]);
    expect(v.code).toBe(2);
    expect(v.stdout).toContain(`A megőrzött eredeti PDF-ekkel ellentmondó adatok: \n  ${x.number}: a megőrzött eredeti PDF tartalma nem egyezik a vele tárolt lenyomattal (SHA-256, SHA3-512, méret).`);
    expect(v.stdout).toContain('Eredmény: ELTÉRÉST TALÁLT');
  });

  it('a backup restored into another data folder gives the same original', async () => {
    const x = await issued();
    const dest = join(tempDir(), 'mentes.db');
    expect((await cli(['backup', dest, '--data-dir', x.dir])).code).toBe(0);
    const fresh = tempDir();
    copyFileSync(dest, join(fresh, 'openszamla.db'));
    const pdf = await cli(['pdf', x.number, '--data-dir', fresh]);
    expect(pdf.code, pdf.stderr).toBe(0);
    expect(pdf.stdout).toContain(`SHA-256: ${x.sha256}`);
    expect(readFileSync(join(fresh, 'pdf', `${x.number}.pdf`)).equals(x.bytes)).toBe(true);
    const v = await cli(['verify', '--data-dir', fresh]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain('Megőrzött eredeti PDF-ek: 1');
  });
});
