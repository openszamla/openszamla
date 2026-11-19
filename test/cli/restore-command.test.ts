/**
 * `openszamla restore <mentésfájl> [--confirm]` end to end: the preview changes nothing and says how to go on; with
 * --confirm the backup is the database, the replaced one is kept beside it, and the check of the result is printed.
 * (The rules – in use, earlier state, numbering – are tested in test/service/restore-backup.test.ts.)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { loadConfig } from '../../src/service/config.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

/** A data folder with two invoices, a backup after the first one. */
async function seeded(): Promise<{ dir: string; backup: string }> {
  const dir = tempDir();
  const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } });
  const app = OpenSzamla.open({ config });
  try {
    app.updateSeller(SELLER_INPUT);
    const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
    const one = async (unitPrice: string): Promise<void> => {
      const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice, vatCode: '27' }] });
      await app.issue(d.invoice.id);
    };
    await one('10000');
    const backup = join(tempDir(), 'mentes.db');
    app.store.backup(backup);
    await one('20000');
    return { dir, backup };
  } finally {
    app.close();
  }
}

describe('openszamla restore', () => {
  it('previews without --confirm, restores with it, and keeps the replaced database', async () => {
    const s = await seeded();
    const year = new Date().getFullYear();
    const preview = await cli(['restore', s.backup, '--data-dir', s.dir]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('Visszaállítás – előnézet (semmi nem változott)');
    expect(preview.stdout).toContain('A mentés ennek az adatbázisnak egy korábbi állapota.');
    expect(preview.stdout).toContain('A jelenlegi adatbázis 1 kiállított bizonylata NINCS a mentésben');
    expect(preview.stdout).toContain(`  SZ-${year}-00002 (számla, kelte `);
    expect(preview.stdout).toContain(`  Számlák: a következő sorszám SZ-${year}-00003 (a mentés szerint SZ-${year}-00002 lenne)`);
    expect(preview.stdout).toMatch(/openszamla restore ".*mentes\.db" --confirm --data-dir /);
    expect(readdirSync(s.dir).filter((f) => f.includes('visszaallitas'))).toEqual([]);

    const done = await cli(['restore', s.backup, '--confirm', '--data-dir', s.dir]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain('Visszaállítva: ');
    expect(done.stdout).toContain('A korábbi adatbázis megvan, félretéve: ');
    expect(done.stdout).toContain('Ellenőrzés: rendben (1 bizonylat, ');
    const aside = readdirSync(s.dir).filter((f) => f.startsWith('openszamla.db.visszaallitas-elott-'));
    expect(aside).toHaveLength(1);
    expect(existsSync(join(s.dir, 'openszamla.db'))).toBe(true);

    const list = await cli(['list', '--data-dir', s.dir]);
    expect(list.stdout).toContain(`SZ-${year}-00001`);
    expect(list.stdout).not.toContain(`SZ-${year}-00002`);
    const verify = await cli(['verify', '--data-dir', s.dir]);
    expect(verify.code, verify.stdout).toBe(0);
    expect(verify.stdout).toContain('Sorszámhézagok: nincs');
    expect(verify.stdout).toMatch(/Figyelmeztetés: .*mentés visszaállítása \(naplóbejegyzés #\d+\) – a mentés után kiállított 1 bizonylat \(SZ-\d{4}-00002\) nincs az adatbázisban\./);
  });

  it('needs the backup file, and says so for a missing or foreign one', async () => {
    const dir = tempDir();
    const none = await cli(['restore', '--data-dir', dir]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Hiba [INVALID_INPUT]: Add meg a visszaállítandó mentésfájlt.');
    const missing = await cli(['restore', join(dir, 'nincs.db'), '--confirm', '--data-dir', dir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Hiba [BACKUP_NOT_FOUND]: A mentésfájl nem található: ');
    // Nothing was created for a restore that did not happen.
    expect(existsSync(join(dir, 'openszamla.db'))).toBe(false);
  });
});
