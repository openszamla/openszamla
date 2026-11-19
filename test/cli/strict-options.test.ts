/**
 * WEB-3: the command line rejects options it does not know, options a command does not take and extra
 * arguments – a misspelt --data-dir used to be dropped, and backup / verify silently worked on the
 * default database. Every documented option keeps working; backup and verify name the database.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT } from '../helpers/app.ts';
import { cli, removeTempDirs, tempDir } from '../helpers/cli.ts';

afterEach(() => removeTempDirs());

describe('unknown options, options of other commands and extra arguments are refused', () => {
  it('a misspelt option is INVALID_INPUT naming it: nothing runs, no database is created anywhere', async () => {
    const real = tempDir();
    const fallback = join(tempDir(), 'alapertelmezett'); // stands in for ~/.openszamla
    const cwd = tempDir();
    const env = { OPENSZAMLA_HOME: fallback };
    const cases: Array<[string[], string]> = [
      [['backup', 'mentes.db', '--datadir', real], '--datadir'],
      [['verify', '--datadir', real], '--datadir'],
      [['list', '--data_dir', real], '--data_dir'],
      [['export', '--data-dir', real, '--from', '2026-11-01', '--to', '2026-11-30', '--date-bases', 'fulfillment'], '--date-bases'],
      [['pdf', 'SZ-2026-00001', '--data-dir', real, '--output', 'kimenet'], '--output'],
      [['status', '-x'], '-x'],
    ];
    for (const [args, option] of cases) {
      const r = await cli(args, { env, cwd });
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`Hiba [INVALID_INPUT]: Ismeretlen kapcsoló: ${option}\n`);
      expect(r.stderr).toMatch(/Tipp: A\(z\) \S+ parancs kapcsolói: .*--data-dir/);
      expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    }
    expect(existsSync(fallback)).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(real)).toEqual([]);
  });

  it('the hint lists the options of the command', async () => {
    const r = await cli(['backup', 'x.db', '--datadir', tempDir()]);
    expect(r.stderr).toContain('Tipp: A(z) backup parancs kapcsolói: --data-dir (súgó: openszamla --help).');
  });

  it('an option of another command, a missing value, a value given to a switch and an extra argument', async () => {
    const dir = tempDir();
    const cases: Array<[string[], string]> = [
      [['list', '--data-dir', dir, '--out', dir], 'A(z) --out kapcsoló a(z) list parancsnál nem használható.'],
      [['status', '--data-dir', dir, '--token', 'abc'], 'A(z) --token kapcsoló a(z) status parancsnál nem használható.'],
      [['backup', join(dir, 'a.db'), '--data-dir', dir, '--date-basis', 'issue'], 'A(z) --date-basis kapcsoló a(z) backup parancsnál nem használható.'],
      [['status', '--data-dir'], 'A(z) --data-dir kapcsoló után hiányzik az érték: --data-dir <érték>'],
      [['list', '--data-dir', '--limit', '5'], 'A(z) --data-dir kapcsoló után hiányzik az érték: --data-dir <érték>'],
      [['status', '--help=igen'], 'A(z) --help kapcsoló nem kap értéket.'],
      [['backup', join(dir, 'a.db'), join(dir, 'b.db'), '--data-dir', dir], `Fölösleges argumentum: ${join(dir, 'b.db')}`],
      [['status', 'mindent', '--data-dir', dir], 'Fölösleges argumentum: mindent'],
    ];
    for (const [args, message] of cases) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toContain(`Hiba [INVALID_INPUT]: ${message}\n`);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('an unknown command is still reported as such, before a database is opened', async () => {
    const dir = tempDir();
    const r = await cli(['lsit', '--data-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Ismeretlen parancs: lsit');
    expect(r.stdout).toContain('Használat: openszamla <parancs> [kapcsolók]');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('an empty --data-dir counts as not given (3.2): the default data directory, not the working directory', async () => {
    const home = join(tempDir(), 'adatok');
    const cwd = tempDir();
    const r = await cli(['status', '--data-dir', ''], { env: { OPENSZAMLA_HOME: home }, cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Adatkönyvtár: ${home}`);
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe('every documented option still works', () => {
  let dir = '';
  let number = '';
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'openszamla-cli-seed-')); // kept for the whole block (tempDir() is per test)
    const app = OpenSzamla.open({ dataDir: dir, env: {}, actor: 'cli' });
    try {
      app.updateSeller(SELLER_INPUT);
      const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
      const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '10000', vatCode: '27' }] });
      number = (await app.issue(d.invoice.id, { submitToNav: false })).invoice.number as string;
    } finally {
      app.close();
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('-h/--help, -v/--version and help', async () => {
    for (const args of [['-h'], ['--help'], ['help'], ['list', '--help']]) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout).toContain('Használat: openszamla <parancs> [kapcsolók]');
    }
    for (const args of [['-v'], ['--version']]) expect((await cli(args)).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('list --from/--to/--limit, show, pdf --out, export --format/--date-basis, adohatosagi-export --from-number/--to-number', async () => {
    const today = number.slice(3, 7);
    const list = await cli(['list', '--data-dir', dir, '--from', `${today}-01-01`, '--to', `${today}-12-31`, '--limit', '5']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(number);
    expect(list.stdout).toContain('(1/1)');
    expect((await cli(['show', number, '--data-dir', dir])).stdout).toContain(`"number": "${number}"`);
    const outDir = join(dir, 'kimenet');
    mkdirSync(outDir);
    const pdf = await cli(['pdf', number, '--data-dir', dir, '--out', outDir]);
    expect(pdf.code).toBe(0);
    expect(readdirSync(outDir).some((f) => f.endsWith('.pdf'))).toBe(true);
    const exp = await cli(['export', '--data-dir', dir, '--from', `${today}-01-01`, '--to', `${today}-12-31`, '--format', 'json', '--date-basis', 'fulfillment']);
    expect(exp.code).toBe(0);
    expect(exp.stdout).toContain('1 számla (teljesítés dátuma szerint)');
    const audit = await cli(['adohatosagi-export', '--data-dir', dir, '--from-number', number, '--to-number', number]);
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain('Adóhatósági ellenőrzési adatszolgáltatás: 1 számla');
  });

  it('config <kliens> and install-skill <cél> take their argument; --data-dir works with every command', async () => {
    const home = tempDir();
    const env = { HOME: home, USERPROFILE: home };
    expect((await cli(['config', 'codex', '--data-dir', dir], { env })).stdout).toContain(`OPENSZAMLA_HOME=${dir}`);
    const skill = await cli(['install-skill', 'claude', '--data-dir', dir], { env });
    expect(skill.code).toBe(0);
    expect(existsSync(join(home, '.claude', 'skills', 'magyar-szamlazas', 'SKILL.md'))).toBe(true);
  });

  it('backup names the database it copied, verify the database it checked', async () => {
    const dest = join(dir, 'mentes.db');
    const b = await cli(['backup', dest, '--data-dir', dir]);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(`Mentve: ${join(dir, 'openszamla.db')} → ${dest}\n`);
    const v = await cli(['verify', '--data-dir', dir]);
    expect(v.code).toBe(0);
    expect(v.stdout.split('\n')[0]).toBe(`Adatbázis: ${join(dir, 'openszamla.db')}`);
    expect(v.stdout).toContain('Ellenőrzött számlák: 1');
  });
});
