/**
 * `openszamla doctor`: checks an installation and prints a fix for every problem (Hungarian). Read-only apart from a
 * probe file in the data directory (written and removed) and what opening the database does anyway (an older
 * database is brought up to date, as by every command); the data directory and the database are never created. NAV is
 * contacted only with --nav. Nothing secret is printed: of client entries only commands and the data directory.
 *
 * Levels: ok (rendben), info, warn (figyelem), error (HIBA). Only an error – something that blocks use: the data
 * directory or database cannot be used, a client's configuration cannot be read or starts a command that does not
 * exist, a requested NAV test fails – makes the exit code 1.
 */
import { existsSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, join, posix, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAppError } from '../core/errors.ts';
import { LATEST_SCHEMA_VERSION } from '../db/schema.ts';
import { NavClient } from '../nav/client.ts';
import { OpenSzamla } from '../service/app.ts';
import { dataDirOption, loadConfig, NAV_CREDENTIALS_FILE, navSetupCommand, navSetupCommandLine } from '../service/config.ts';
import { VERSION } from '../version.ts';
import {
  CLIENT_TITLES,
  commandFor,
  entryDataDir,
  envGet,
  findOnPath,
  homeDir,
  inspectClientConfigs,
  runsWithoutShell,
  samePath,
  skillDir,
  skillState,
  WRITABLE_CLIENTS,
  type ClientContext,
  type ConfigView,
  type EntryView,
} from './clients.ts';

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface Check {
  section: string;
  level: CheckLevel;
  text: string;
  /** What to do about it. */
  fix?: string;
}

const require = createRequire(import.meta.url);

/** The minimum Node.js version: package.json "engines" (the same as the start-up check of main.ts). */
export function minNodeVersion(): string {
  const engines = (require('../../package.json') as { engines?: { node?: string } }).engines?.node ?? '';
  return /(\d+\.\d+\.\d+)/.exec(engines)?.[1] ?? '22.13.0';
}

function olderThan(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** Whether node:sqlite works as the store needs it (main.ts checks the same before any command runs). */
export function sqliteWorks(): boolean {
  try {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('BEGIN; CREATE TABLE probe (x); COMMIT');
      return [...db.prepare('SELECT 1 AS one').iterate()].length === 1;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** NAV's technical user, step by step (docs/nav-beallitas.md of this version: an npm installation has no repository). */
export function navGuideUrl(): string {
  return `https://github.com/openszamla/openszamla/blob/v${VERSION}/docs/nav-beallitas.md`;
}

/**
 * Windows PowerShell's default execution policy blocks the .ps1 starters npm makes (npm.ps1, openszamla.ps1): what
 * setup and doctor tell a Windows user, with the commands that work as they are.
 */
export const POWERSHELL_HINT =
  'Windows PowerShellben, ha egy parancs „running scripts is disabled on this system” („a parancsfájlok futtatása le van tiltva”) hibát ad, ' +
  'írd .cmd végződéssel (pl. openszamla.cmd doctor, npm.cmd install -g openszamla), vagy engedélyezd egyszer a saját felhasználódnak: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned.';

/** UNC paths – \\server\share, //server/share, \\?\UNC\… –: a folder on another machine (\\?\C:\… is local). */
function isUncPath(p: string): boolean {
  const s = p.replace(/\//g, '\\');
  if (/^\\\\[?.]\\UNC\\/i.test(s)) return true;
  if (/^\\\\[?.]\\/.test(s)) return false;
  return /^\\\\[^\\]/.test(s);
}

/** Where a data directory should not be, and why (DATA_DIR_RISK). */
export interface DataDirRisk {
  kind: 'onedrive' | 'network';
  /** The OneDrive folder it is in, or its network path. */
  where: string;
}

/**
 * A data directory inside a OneDrive folder (the OneDrive, OneDriveConsumer and OneDriveCommercial variables Windows sets)
 * or on a network path – a UNC path, or a drive letter mapped to a network share, whose real path (realpath of the
 * nearest existing folder) is a UNC path. A sync client copying the database and its -wal/-shm files, or SQLite's file
 * locking over the network, can damage it. Null otherwise. A UNC path is recognised without touching the network.
 */
export function dataDirRisk(dir: string, ctx: Pick<ClientContext, 'env' | 'platform'>, realpath: (p: string) => string = realpathSync.native): DataDirRisk | null {
  const windows = ctx.platform === 'win32';
  const path = windows ? win32 : posix;
  const target = path.resolve(dir);
  const norm = (p: string): string => (windows ? p.toLowerCase() : p);
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = envGet(ctx.env, key, ctx.platform);
    if (!root || !path.isAbsolute(root)) continue;
    const r = norm(path.resolve(root));
    const t = norm(target);
    if (t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return { kind: 'onedrive', where: path.resolve(root) };
  }
  if (!windows) return null;
  if (isUncPath(dir) || isUncPath(target)) return { kind: 'network', where: target };
  for (let p = target; ; p = path.dirname(p)) {
    if (existsSync(p)) {
      try {
        const real = realpath(p);
        if (isUncPath(real)) return { kind: 'network', where: real };
      } catch {
        // not resolvable: nothing to say about it
      }
      return null;
    }
    if (path.dirname(p) === p) return null;
  }
}

/** What setup and doctor say about a DataDirRisk: the risk, and what to do instead. */
export function dataDirRiskText(r: DataDirRisk): { text: string; fix: string } {
  return {
    text:
      r.kind === 'onedrive'
        ? `Az adatkönyvtár egy OneDrive-mappában van (${r.where}): a szinkronizálás az SQLite-adatbázist (és a mellette lévő -wal, -shm fájlokat) használat közben másolhatja, így az adatbázis megsérülhet vagy ütköző példányok keletkezhetnek – két gépen használva a sorszámozás is kettéválhat.`
        : `Az adatkönyvtár hálózati helyen van (${r.where}): hálózati meghajtón az SQLite fájlzárolása nem megbízható, egyszerre használva vagy megszakadó kapcsolatnál az adatbázis megsérülhet.`,
    fix:
      'Tartsd az adatkönyvtárat a gép saját lemezén, szinkronizálás nélkül (pl. az alapértelmezett ~/.openszamla, Windowson C:\\Users\\<név>\\.openszamla): zárd be az OpenSzámlát (AI-kliens, openszamla serve), másold át a mappát, és futtasd: openszamla setup --data-dir "<új mappa>". ' +
      'A biztonságot a rendszeres mentés adja (openszamla backup <fájl>) – a mentésfájl már mehet a OneDrive-ra vagy a hálózati meghajtóra.',
  };
}

/** The runtime line of setup and doctor. */
export function runtimeText(): { ok: boolean; text: string } {
  const min = minNodeVersion();
  const sqlite = sqliteWorks();
  return {
    ok: !olderThan(process.versions.node, min) && sqlite,
    text: `Node.js ${process.versions.node} (${process.execPath}); legalább ${min} kell; a beépített SQLite (node:sqlite) ${sqlite ? 'működik' : 'NEM működik'}.`,
  };
}

/** The schema version of an existing database file, read without changing it. */
function schemaVersionOf(file: string): number {
  const db = new DatabaseSync(file);
  try {
    const meta = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
    if (!meta) return 0;
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    return row ? Number(row['value']) : 0;
  } finally {
    db.close();
  }
}

function errorText(e: unknown): { text: string; fix?: string } {
  if (isAppError(e)) return { text: `${e.message}`, ...(e.hint ? { fix: e.hint } : {}) };
  return { text: e instanceof Error ? e.message : String(e) };
}

/** What a client entry starts, checked: the command (and the script Node.js is given) must exist. */
function commandChecks(view: ConfigView, entry: EntryView, ctx: ClientContext, add: (level: CheckLevel, text: string, fix?: string) => void): void {
  const where = `${view.label}: ${view.file}`;
  const rewrite = commandFor(`config ${view.client} --write --force`, ctx);
  if (entry.http && entry.command === undefined) {
    add('info', `${where} – HTTP-kapcsolat (url); a szervert itt nem a kliens indítja, hanem az openszamla serve.`);
    return;
  }
  if (!entry.command) {
    add('error', `${where} – az openszamla bejegyzésben nincs parancs (command), ezért a kliens nem tudja elindítani.`, `Írd be újra: ${rewrite}`);
    return;
  }
  const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(entry.command);
  // Windows starts "…\node" as "…\node.exe".
  const exists = existsSync(entry.command) || (ctx.platform === 'win32' && !extname(entry.command) && existsSync(`${entry.command}.exe`));
  if (absolute && !exists) {
    add('error', `${where} – a beállított parancs nem létezik: ${entry.command} (pl. a Node.js frissítése vagy áthelyezése után).`, `Írd be újra a mostani útvonallal: ${rewrite}`);
    return;
  }
  let note = '';
  if (!absolute) {
    const found = findOnPath(entry.command, ctx);
    if (!found) {
      add('error', `${where} – a beállított parancs (${entry.command}) nincs a PATH-on, ezért a kliens nem tudja elindítani.`, `Írd be abszolút útvonallal: ${rewrite}`);
      return;
    }
    note = runsWithoutShell(found, ctx.platform)
      ? ` A parancs a PATH-ról indul (${found}); az asztali alkalmazások PATH-ja eltérhet a terminálétól.`
      : ` A parancs a PATH-on egy parancsértelmezőt igénylő fájl (${found}): a parancsértelmező nélkül indító kliens nem tudja futtatni.`;
  }
  const isNode = /^node(\.exe)?$/i.test(basename(entry.command));
  const script = isNode ? entry.args?.[0] : undefined;
  if (script && /\.[cm]?[jt]s$/i.test(script) && !existsSync(script)) {
    add('error', `${where} – a Node.js-nek megadott programfájl nem létezik: ${script} (pl. az OpenSzámla eltávolítása vagy áthelyezése után).`, `Írd be újra a mostani telepítéssel: ${rewrite}`);
    return;
  }
  if (/^npx(\.cmd)?$/i.test(basename(entry.command))) note += ' Az npx az első indításkor letölti a csomagot (hálózat és idő kell hozzá).';
  if (note) add('warn', `${where} – openszamla bejegyzés: ${entry.command}.${note}`, `Biztosabb, abszolút útvonalas beállítás: ${rewrite}`);
  else add('ok', `${where} – openszamla bejegyzés, a parancs létezik (${entry.command}${script ? ` ${script}` : ''}).`);
}

export interface DoctorOptions {
  ctx: ClientContext;
  /** Live NAV connection test (tokenExchange). */
  nav: boolean;
}

export async function doctorChecks(o: DoctorOptions): Promise<Check[]> {
  const { ctx } = o;
  const checks: Check[] = [];
  let section = '';
  const add = (level: CheckLevel, text: string, fix?: string): void => {
    checks.push({ section, level, text, ...(fix ? { fix } : {}) });
  };

  section = 'Futtatókörnyezet';
  const runtime = runtimeText();
  add(runtime.ok ? 'ok' : 'error', runtime.text, runtime.ok ? undefined : 'Telepítsd a Node.js LTS-változatát (https://nodejs.org, Windowson: winget install OpenJS.NodeJS.LTS).');
  if (ctx.platform === 'win32') add('info', POWERSHELL_HINT);

  section = 'Adatkönyvtár és adatbázis';
  let app: OpenSzamla | null = null;
  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig({ dataDir: ctx.dataDir, env: ctx.env });
  } catch (e) {
    const t = errorText(e);
    add('error', `A beállítások hibásak, a program így nem indul el: ${t.text}`, t.fix);
  }
  if (config) {
    const dir = config.dataDir;
    const risk = dataDirRisk(dir, ctx);
    if (risk) add('warn', dataDirRiskText(risk).text, dataDirRiskText(risk).fix);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
      if (!isDir) add('error', `Az adatkönyvtár helyén fájl van: ${dir}`, 'Adj meg egy mappát (--data-dir, OPENSZAMLA_HOME), vagy nevezd át a fájlt.');
    } catch {
      add('warn', `Az adatkönyvtár még nem létezik: ${dir} (az első használatkor létrejön).`, `Beállítás: ${commandFor('setup', ctx)}`);
    }
    if (isDir) {
      const probe = join(dir, `.openszamla-doctor-${process.pid}.tmp`);
      try {
        writeFileSync(probe, '');
        rmSync(probe, { force: true });
        add('ok', `Adatkönyvtár: ${dir} (írható).`);
      } catch (e) {
        add('error', `Az adatkönyvtár nem írható: ${dir} (${(e as NodeJS.ErrnoException).code ?? 'ismeretlen hiba'}).`, 'Adj írási jogot a mappához, vagy válassz másikat (--data-dir, OPENSZAMLA_HOME).');
      }
      if (!existsSync(config.dbPath)) {
        add('info', `Adatbázis: még nincs (${config.dbPath}); az első használatkor létrejön.`);
      } else {
        let version: number | null = null;
        try {
          version = schemaVersionOf(config.dbPath);
        } catch {
          // reported by the open below
        }
        try {
          app = OpenSzamla.open({ dataDir: dir, env: ctx.env, actor: 'cli' });
          const was = version !== null && version < LATEST_SCHEMA_VERSION && version > 0 ? ` (a program most frissítette: ${version} → ${LATEST_SCHEMA_VERSION})` : '';
          add('ok', `Adatbázis: ${config.dbPath} – megnyitható, sémaverzió: ${LATEST_SCHEMA_VERSION}${was}.`);
        } catch (e) {
          const t = errorText(e);
          add('error', `Az adatbázis nem használható: ${t.text}`, t.fix);
        }
      }
    }
  }

  section = 'Eladó';
  const sellerFix = `${commandFor('init', ctx)} (vagy ${commandFor('setup', ctx)}; vagy kérd meg rá az AI-t, vagy a webes felület Beállítások oldalán)`;
  if (app) {
    const s = app.status();
    if (!s.seller) add('warn', 'Az eladó (a saját vállalkozásod) adatai még nincsenek megadva – számlát így nem lehet kiállítani.', sellerFix);
    else {
      const errors = s.sellerIssues.filter((i) => i.severity === 'error');
      if (errors.length) add('warn', `Eladó: ${s.seller.name} (${s.seller.taxNumber}) – hibás adatok: ${errors.map((i) => i.message).join(' ')}`, commandFor('init', ctx));
      else add('ok', `Eladó: ${s.seller.name} (${s.seller.taxNumber}).`);
    }
  } else if (config && !existsSync(config.dbPath)) add('warn', 'Az eladó (a saját vállalkozásod) adatai még nincsenek megadva (még nincs adatbázis).', sellerFix);
  else add('info', 'Az eladói adatok nem ellenőrizhetők, mert az adatbázis nem nyitható meg (lásd fent).');

  section = 'NAV Online Számla';
  if (config) {
    const nav = config.nav;
    const file = join(config.dataDir, NAV_CREDENTIALS_FILE);
    if (!nav) {
      add('warn', 'A NAV-kapcsolat nincs beállítva: a kiállított számlákról a törvény szerint azonnal adatot kell szolgáltatni (a program kiállít, de nem jelent).', `Hozd létre a technikai felhasználót (lépésről lépésre: ${navGuideUrl()}), majd: ${navSetupCommand(config.dataDir)}`);
    } else if (config.navProblem) {
      add('warn', `A NAV-beállítás hibás (${nav.environment}, ${nav.source === 'env' ? 'környezeti változók' : file}) – a program egy számlát sem jelent: ${config.navProblem}`, `Javítás: ${navSetupCommand(config.dataDir)}`);
    } else {
      const from = nav.source === 'env' ? 'környezeti változókból (OPENSZAMLA_NAV_*)' : file;
      if (nav.environment === 'test') {
        add('warn', `NAV: TESZT környezet (${from}) – a számlák csak a NAV próbarendszerébe kerülnek, valódi adatszolgáltatás nem történik.`, `Éles számlázás előtt: ${navSetupCommandLine(config.dataDir, 'production')} (az éles technikai felhasználó adataival)`);
      } else add('ok', `NAV: ÉLES környezet (${from}).`);
      if (nav.source === 'file' && ctx.platform !== 'win32') {
        try {
          if ((statSync(file).mode & 0o077) !== 0) add('warn', `A ${file} fájlt más felhasználók is olvashatják.`, `chmod 600 "${file}"`);
        } catch {
          // reported as a NAV problem
        }
      }
    }
    if (app) {
      const c = app.status().counts;
      if (c.navPending || c.navProblems) add('info', `NAV-jelentésre vár: ${c.navPending}, hibás vagy nem jelentett: ${c.navProblems} számla.`, 'Részletek: openszamla status; az AI-nak: „Nézd meg a NAV-problémás számlákat.”');
    }
    if (o.nav) {
      const seller = app?.getSeller();
      if (!nav || config.navProblem) add('info', 'A NAV-kapcsolat nem tesztelhető: nincs (használható) beállítás.');
      else if (!seller) add('info', 'A NAV-kapcsolat nem tesztelhető: az eladó adószáma még hiányzik.', commandFor('init', ctx));
      else {
        try {
          const client = new NavClient({
            environment: nav.environment,
            credentials: { ...nav.credentials, taxNumber: seller.taxNumber.slice(0, 8) },
            software: config.software,
            ...(nav.baseUrl ? { baseUrl: nav.baseUrl } : {}),
          });
          await client.tokenExchange();
          add('ok', `A NAV ${nav.environment === 'production' ? 'ÉLES' : 'TESZT'} kapcsolat működik (tokenExchange).`);
        } catch (e) {
          const t = errorText(e);
          add('error', `A NAV-kapcsolat tesztje nem sikerült: ${t.text}`, t.fix ?? `Ellenőrizd a technikai felhasználó adatait: ${navSetupCommand(config.dataDir)}`);
        }
      }
    } else add('info', 'Élő NAV-kapcsolatteszt: openszamla doctor --nav');
  }

  section = 'AI-kliensek';
  const views = inspectClientConfigs(ctx);
  const withEntry = new Set(views.filter((v) => v.entry).map((v) => v.client));
  let connected = 0;
  for (const v of views) {
    if (v.problem) {
      add('error', `${v.label}: ${v.problem}`, `A kliens valószínűleg egyik MCP-szerverét sem tudja betölteni, amíg a fájl hibás. Javítsd a fájlt (vagy nevezd át), majd futtasd: ${commandFor(`config ${v.client} --write`, ctx)}`);
      continue;
    }
    if (!v.exists) continue;
    if (!v.entry) {
      if (!withEntry.has(v.client)) add('info', `${v.label}: ${v.file} – nincs benne openszamla bejegyzés.`, `Ha ezt a klienst használod: ${commandFor(`config ${v.client} --write`, ctx)}`);
      continue;
    }
    connected++;
    if (v.note) add('info', `${v.label}: ${v.file} – ${v.note}.`);
    commandChecks(v, v.entry, ctx, add);
    if (v.unreadable?.length) add('warn', `${v.label}: a bejegyzés egyes részei nem olvashatók ki (${v.unreadable.join(', ')}), ezeket nem ellenőriztem.`);
    try {
      const used = entryDataDir(v.entry, ctx);
      if (!samePath(used, ctx.dataDir, ctx.platform)) {
        add('warn', `${v.label}: a kliens másik adatkönyvtárat használ: ${used} (ez az ellenőrzés: ${ctx.dataDir}) – ott külön adatbázis és sorszámozás van.`, `Ha ugyanazokkal a számlákkal dolgoznál: ${commandFor(`config ${v.client} --write --force`, ctx)}, vagy futtasd az ellenőrzést azzal: openszamla doctor${dataDirOption(used, homeDir(ctx), ctx.platform)}`);
      }
    } catch (e) {
      add('error', `${v.label}: ${errorText(e).text}`, errorText(e).fix);
    }
  }
  if (!connected) add('warn', 'Egyik ismert AI-kliens beállításában sincs OpenSzámla (a parancssor és a webes felület ettől még működik).', `Csatlakoztatás: ${commandFor('setup', ctx)} vagy ${commandFor('config <kliens> --write', ctx)}`);
  const present = new Set(views.filter((v) => v.exists || v.problem).map((v) => v.client));
  const missing = WRITABLE_CLIENTS.filter((c) => !present.has(c)).map((c) => CLIENT_TITLES[c]);
  if (missing.length) add('info', `Nincs konfigurációs fájlja (ha nem használod, nincs teendő): ${missing.join(', ')}.`);

  section = 'Skill';
  const home = homeDir(ctx);
  for (const [target, client] of [['claude', 'claude-code'], ['codex', 'codex']] as const) {
    const state = skillState(target, home);
    const uses = views.some((v) => v.client === client && v.entry);
    const where = skillDir(target, home);
    if (state === 'current') add('ok', `${CLIENT_TITLES[client]} skill: ${where} (a program ezen változatáé).`);
    else if (state === 'different') add('warn', `${CLIENT_TITLES[client]} skill: ${where} – eltér a program ezen változatáétól.`, `Frissítés: openszamla install-skill ${target}`);
    else if (uses) add('info', `${CLIENT_TITLES[client]} skill: nincs telepítve (ajánlott, nem kötelező).`, `openszamla install-skill ${target}`);
  }
  app?.close();
  return checks;
}

const LABEL: Record<CheckLevel, string> = { ok: 'rendben', info: 'info', warn: 'figyelem', error: 'HIBA' };

export function formatDoctor(checks: readonly Check[]): string {
  const lines = [`OpenSzámla ${VERSION} – a telepítés és a beállítások ellenőrzése`];
  let section = '';
  for (const c of checks) {
    if (c.section !== section) {
      section = c.section;
      lines.push('', section);
    }
    lines.push(`  ${LABEL[c.level].padEnd(8)}  ${c.text}`);
    if (c.fix) lines.push(`  ${''.padEnd(8)}  → ${c.fix}`);
  }
  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  lines.push(
    '',
    `Összesen: ${errors} hiba, ${warnings} figyelmeztetés.`,
    errors ? 'A hibák akadályozzák a használatot – javítsd őket a fenti tippek szerint, majd futtasd újra: openszamla doctor' : 'A program használható.',
  );
  return lines.join('\n');
}

/** openszamla doctor: the checks on stdout; 1 when something blocks use. */
export async function runDoctor(o: DoctorOptions & { out: (s: string) => void }): Promise<number> {
  const checks = await doctorChecks(o);
  o.out(formatDoctor(checks));
  return checks.some((c) => c.level === 'error') ? 1 : 0;
}
