/**
 * WEB-6: on Windows `openszamla backup "mentes 14:30.db"` used to write an empty "mentes 14" with the data
 * in an NTFS alternate data stream, which a copy to a stick, a zip or an upload leaves behind. Names Windows
 * cannot hold are refused before anything is written (drive, UNC and \\?\ roots keep working), and a
 * backup that came out missing or empty is an error, with the stub removed.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/core/errors.ts';
import { Store, windowsPathProblem } from '../../src/db/store.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

const B = '\\';

describe('windowsPathProblem', () => {
  it('accepts drive, drive-relative, UNC, \\\\?\\ and \\\\.\\ paths and plain relative names', () => {
    for (const p of [
      `C:${B}Users${B}Nev${B}mentes.db`,
      `C:${B}mentes.db`,
      'C:mentes.db',
      'd:/mentesek/mentes_2026-11-08_1430.db',
      `${B}${B}nas${B}share${B}mentesek${B}mentes.db`,
      '//nas/share/mentes.db',
      `${B}${B}?${B}C:${B}nagyon${B}hosszu${B}utvonal${B}mentes.db`,
      `${B}${B}?${B}UNC${B}nas${B}share${B}mentes.db`,
      `${B}${B}.${B}C:${B}mentes.db`,
      `mentesek${B}mentes 2026-11-08 1430.db`,
    ]) {
      expect(windowsPathProblem(p), p).toBeNull();
    }
  });

  it('names a colon below the root, the characters Windows forbids and control characters', () => {
    const cases: Array<[string, string]> = [
      [`C:${B}mentesek${B}mentes 2026-11-08 14:30.db`, 'kettőspont (:)'],
      ['mentes-2026-11-08T14:30:00.db', 'kettőspont (:)'],
      [`${B}${B}nas${B}share${B}mentes 14:30.db`, 'kettőspont (:)'],
      [`${B}${B}?${B}C:${B}a${B}mentes:adatfolyam.db`, 'kettőspont (:)'],
      [`C:${B}a:b${B}mentes.db`, 'kettőspont (:)'],
      [`C:${B}mentes?.db`, '„?” jel'],
      [`C:${B}mentes*.db`, '„*” jel'],
      [`C:${B}"mentes".db`, '„"” jel'],
      [`C:${B}<mentes>.db`, '„<” jel'],
      [`C:${B}mentes|2.db`, '„|” jel'],
      [`C:${B}mentes\u0007.db`, 'vezérlőkarakter'],
    ];
    for (const [p, what] of cases) expect(windowsPathProblem(p), p).toBe(what);
  });
});

describe.runIf(process.platform === 'win32')('openszamla backup on Windows', () => {
  it('refuses a name with ":" before writing anything (no alternate data stream, no empty file)', async () => {
    const dir = tempDir();
    const cwd = tempDir();
    for (const name of ['mentes 2026-11-08 14:30.db', 'mentes-2026-11-08T14:30:00.db']) {
      const r = await cli(['backup', name, '--data-dir', dir], { cwd });
      expect(r.code, name).toBe(1);
      expect(r.stderr).toContain(`Hiba [INVALID_INPUT]: A mentés útvonalában Windowson nem állhat kettőspont (:): ${join(cwd, name)}`);
      expect(r.stderr).toContain('pl. mentes_2026-11-08_1430.db');
    }
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('absolute drive paths, drive-relative input and \\\\?\\ long paths still work', async () => {
    const dir = tempDir();
    const cwd = tempDir();
    const targets: Array<[string, string]> = [
      [join(cwd, 'mentes_2026-11-08_1430.db'), join(cwd, 'mentes_2026-11-08_1430.db')],
      [`${cwd.slice(0, 2)}mentes-relativ.db`, join(cwd, 'mentes-relativ.db')], // e.g. C:mentes-relativ.db, resolved against the working directory
      [`${B}${B}?${B}${join(cwd, 'mentes-hosszu.db')}`, `${B}${B}?${B}${join(cwd, 'mentes-hosszu.db')}`],
    ];
    for (const [arg, file] of targets) {
      const r = await cli(['backup', arg, '--data-dir', dir], { cwd });
      expect(r.code, `${arg}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toBe(`Mentve: ${join(dir, 'openszamla.db')} → ${resolve(cwd, arg)}\n`);
      expect(statSync(file).size).toBeGreaterThan(0);
    }
  });
});

describe('a backup that came out missing or empty', () => {
  /** A store whose VACUUM INTO only "succeeds": it writes `content`, or nothing at all. */
  function storeWithFakeVacuum(dir: string, content: string | null): Store {
    const store = new Store({ path: join(dir, 'company.db') });
    const db = store.unsafeRawDatabaseForTests();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) =>
      sql.startsWith('VACUUM INTO')
        ? {
            run: (dest: string) => {
              if (content !== null) writeFileSync(dest, content);
              return { changes: 0, lastInsertRowid: 0 };
            },
          }
        : prepare(sql)) as typeof db.prepare;
    return store;
  }

  it('is BACKUP_FAILED, and an empty stub is removed', () => {
    for (const content of ['', null]) {
      const dir = tempDir();
      const store = storeWithFakeVacuum(dir, content);
      const target = join(dir, 'mentes.db');
      let error: unknown;
      try {
        store.backup(target);
      } catch (e) {
        error = e;
      } finally {
        store.close();
      }
      expect(isAppError(error) && error.code).toBe('BACKUP_FAILED');
      expect((error as Error).message).toBe(`A mentés nem jött létre, vagy üres maradt: ${target}`);
      expect(existsSync(target)).toBe(false);
    }
  });
});
