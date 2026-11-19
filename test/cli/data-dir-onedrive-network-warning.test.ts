/**
 * OD: `openszamla doctor` and `openszamla setup` warn when the data directory is inside a OneDrive folder (the OneDrive,
 * OneDriveConsumer and OneDriveCommercial variables Windows sets) or on a network path – a UNC path, recognised without
 * touching the network, or a drive letter mapped to a share (its real path is a UNC path) –, say why (the SQLite
 * database can be damaged there) and what to do instead: a folder on the machine's own disk, and regular backups.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirRisk, dataDirRiskText } from '../../src/cli/doctor.ts';
import { makeProfile, removeProfiles, runIn } from '../helpers/client-profile.ts';

afterEach(() => removeProfiles());

const WIN = { platform: 'win32' as const };
/** A realpath that must not be called (a UNC path is never touched). */
const untouched = (p: string): string => {
  throw new Error(`realpath called for ${p}`);
};

describe('where a data directory should not be (OD)', () => {
  it('inside a OneDrive folder, by any of the three variables, compared without case on Windows', () => {
    const env = { OneDrive: 'C:\\Users\\Anna\\OneDrive', OneDriveCommercial: 'C:\\Users\\Anna\\OneDrive - Minta Kft' };
    expect(dataDirRisk('C:\\Users\\Anna\\OneDrive\\Számlák', { ...WIN, env }, untouched)).toEqual({ kind: 'onedrive', where: 'C:\\Users\\Anna\\OneDrive' });
    expect(dataDirRisk('c:\\users\\anna\\onedrive', { ...WIN, env }, untouched)?.kind).toBe('onedrive');
    expect(dataDirRisk('C:\\Users\\Anna\\OneDrive - Minta Kft\\OpenSzamla', { ...WIN, env }, untouched)).toEqual({ kind: 'onedrive', where: 'C:\\Users\\Anna\\OneDrive - Minta Kft' });
    expect(dataDirRisk('C:\\Users\\Anna\\OneDriveMentes\\x', { ...WIN, env: { OneDriveConsumer: 'C:\\Users\\Anna\\OneDrive' } }, () => 'C:\\Users\\Anna\\OneDriveMentes\\x')).toBeNull();
    expect(dataDirRisk('/home/anna/OneDrive/szamlak', { platform: 'linux', env: { OneDrive: '/home/anna/OneDrive' } })).toEqual({ kind: 'onedrive', where: '/home/anna/OneDrive' });
  });

  it('a UNC path is a network path, recognised without touching it', () => {
    for (const dir of ['\\\\nas\\szamlak\\openszamla', '//nas/szamlak/openszamla', '\\\\?\\UNC\\nas\\szamlak']) {
      expect(dataDirRisk(dir, { ...WIN, env: {} }, untouched), dir).toMatchObject({ kind: 'network' });
    }
    expect(dataDirRisk('\\\\?\\C:\\Adatok\\OpenSzamla', { ...WIN, env: {} }, () => 'C:\\Adatok')).toBeNull();
  });

  // The real path is asked of the nearest existing folder: only a Windows host has existing folders under a drive letter.
  it.runIf(process.platform === 'win32')('a drive letter whose real path is a UNC path (a mapped network drive) is a network path; a local one is not', () => {
    const p = makeProfile();
    const dir = join(p.root, 'adatok', 'még nem létezik');
    expect(dataDirRisk(dir, { ...WIN, env: {} }, () => '\\\\nas\\szamlak\\adatok')).toEqual({ kind: 'network', where: '\\\\nas\\szamlak\\adatok' });
    expect(dataDirRisk(dir, { ...WIN, env: {} }, (x) => x)).toBeNull();
  });

  it('outside Windows a path that looks like a UNC path is an ordinary folder name, and nothing is resolved', () => {
    expect(dataDirRisk('\\\\nas\\szamlak', { platform: 'linux', env: {} }, untouched)).toBeNull();
    expect(dataDirRisk('//nas/szamlak', { platform: 'darwin', env: {} }, untouched)).toBeNull();
  });

  it('the texts name the risk and the remedy', () => {
    const onedrive = dataDirRiskText({ kind: 'onedrive', where: 'C:\\Users\\Anna\\OneDrive' });
    expect(onedrive.text).toBe(
      'Az adatkönyvtár egy OneDrive-mappában van (C:\\Users\\Anna\\OneDrive): a szinkronizálás az SQLite-adatbázist (és a mellette lévő -wal, -shm fájlokat) használat közben másolhatja, így az adatbázis megsérülhet vagy ütköző példányok keletkezhetnek – két gépen használva a sorszámozás is kettéválhat.',
    );
    expect(onedrive.fix).toContain('openszamla backup <fájl>');
    expect(onedrive.fix).toContain('openszamla setup --data-dir "<új mappa>"');
    expect(dataDirRiskText({ kind: 'network', where: '\\\\nas\\x' }).text).toBe(
      'Az adatkönyvtár hálózati helyen van (\\\\nas\\x): hálózati meghajtón az SQLite fájlzárolása nem megbízható, egyszerre használva vagy megszakadó kapcsolatnál az adatbázis megsérülhet.',
    );
  });

  it('doctor and setup warn about a data directory in OneDrive (the folder is used anyway)', async () => {
    const p = makeProfile();
    const onedrive = join(p.home, 'OneDrive');
    const dir = join(onedrive, 'Számlák');
    mkdirSync(dir, { recursive: true });
    // The machine's own OneDrive variables (Windows: in any letter case) give way to this profile's.
    for (const k of Object.keys(p.env)) if (/^onedrive(consumer|commercial)?$/i.test(k)) delete p.env[k];
    const env = { OneDrive: onedrive };
    const doctor = await runIn(p, ['doctor', '--data-dir', dir], { env });
    expect(doctor.code, doctor.stdout).toBe(0);
    expect(doctor.stdout).toContain(`figyelem  Az adatkönyvtár egy OneDrive-mappában van (${onedrive}): a szinkronizálás az SQLite-adatbázist`);
    expect(doctor.stdout).toContain('→ Tartsd az adatkönyvtárat a gép saját lemezén, szinkronizálás nélkül');
    const setup = await runIn(p, ['setup', '--data-dir', dir], { env });
    expect(setup.code, setup.stdout).toBe(0);
    expect(setup.stdout).toContain(`  FIGYELEM – Az adatkönyvtár egy OneDrive-mappában van (${onedrive})`);
    expect(setup.stdout).toContain('  Tipp: Tartsd az adatkönyvtárat a gép saját lemezén');
    // Outside OneDrive: no such warning.
    const local = await runIn(p, ['doctor'], { env });
    expect(local.stdout).not.toContain('OneDrive-mappában');
  });
});
