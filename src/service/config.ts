/**
 * Runtime configuration: data directory, database path, NAV credentials and behaviour switches.
 *
 * Secrets (NAV technical user) are read from environment variables or from
 * <dataDir>/nav-credentials.json (written by `openszamla nav-setup`, file mode 0600). They are never
 * stored in the database and never returned by any tool. A running program follows the file
 * (NavSettingsWatch), and a damaged file is a bad setting (navProblem), never a start-up error.
 *
 * MCP clients start the server without a shell and pass every extension/plugin option, set or not:
 * empty values and unexpanded `${…}` placeholders count as not set, a leading `~` in a path is expanded
 * here, and a path with an unexpanded variable is refused.
 *
 * The NAV endpoint always follows the environment (test / production): there is deliberately no setting
 * that redirects it, so reporting cannot silently go elsewhere. Only tests pass `baseUrl` (fake NAV).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../core/errors.ts';
import { navCredentialProblems, navSoftwareProblem } from '../nav/api-xml.ts';
import type { NavCredentials, NavEnvironment, NavSoftware } from '../nav/types.ts';
import { VERSION } from '../version.ts';

/** How irreversible operations (issuing, storno) are confirmed by MCP clients. */
export type ConfirmMode =
  /** Require the server-issued confirmation code from the preview (default; works with every client). */
  | 'code'
  /** Code AND an MCP elicitation dialog answered by the human (fails on clients without elicitation). */
  | 'elicit'
  /** No confirmation (unattended automation, e.g. a webshop backend). */
  | 'none';

export interface NavRuntimeConfig {
  environment: NavEnvironment;
  /** Credentials without taxNumber – that comes from the seller profile. */
  credentials: Omit<NavCredentials, 'taxNumber'>;
  source: 'env' | 'file';
  /** Override of the API base URL – tests only (fake NAV server); no setting or variable sets it. */
  baseUrl?: string;
  /**
   * Why the saved file cannot be used (unreadable, not JSON, a field that is not text …), never echoing a value;
   * navConfigProblem reports it. The credentials then hold what could be read, and the environment is the one
   * OPENSZAMLA_NAV_ENV or the file names – `test` when neither can be read.
   */
  fileProblem?: string;
}

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  pdfDir: string;
  exportDir: string;
  nav: NavRuntimeConfig | null;
  /**
   * Why the NAV settings cannot be used (technical user data or softwareId in a wrong format), checked when
   * the configuration is loaded; null when they are usable or NAV is not configured. With a problem the
   * program treats NAV as not configured (nothing is sent) and status() shows the reason.
   */
  navProblem: string | null;
  /** Report invoices to NAV right after issuing (default true when NAV is configured). */
  navAutoSubmit: boolean;
  /** How long issuing waits for NAV's processing result before returning (seconds, default 20). */
  navWaitSeconds: number;
  confirmMode: ConfirmMode;
  /** Allow tools to copy generated files to arbitrary local directories (stdio/local use only). */
  allowFileCopy: boolean;
  software: NavSoftware;
}

export const NAV_CREDENTIALS_FILE = 'nav-credentials.json';

export const DEFAULT_SOFTWARE: NavSoftware = {
  softwareId: 'OPENSZAMLA-0000001',
  softwareName: 'OpenSzámla',
  softwareOperation: 'LOCAL_SOFTWARE',
  softwareMainVersion: VERSION,
  softwareDevName: 'OpenSzámla közreműködők',
  softwareDevContact: 'https://github.com/openszamla/openszamla',
  softwareDevCountryCode: 'HU',
};

export interface LoadConfigOptions {
  dataDir?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<Omit<AppConfig, 'dataDir' | 'dbPath'>>;
  /**
   * allowFileCopy when OPENSZAMLA_ALLOW_FILE_COPY is not set (default true). `serve` passes false: its
   * clients may be remote, and a folder on the server machine means nothing to them.
   */
  fileCopyDefault?: boolean;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'igen', 'on'].includes(v.trim().toLowerCase());
}

/** A whole value like `${user_config.nav_env}`: an MCP extension/plugin option without a value, passed through unexpanded. */
const PLACEHOLDER = /^\$\{[^}]*\}$/;

/**
 * A setting from the environment, or undefined when it is empty or an unexpanded `${…}` placeholder:
 * MCP extensions and plugins pass every option, set or not, so such values mean "not set".
 */
export function envValue(env: NodeJS.ProcessEnv, key: string, opts: { trim?: boolean } = {}): string | undefined {
  const raw = env[key];
  const v = raw?.trim();
  if (raw === undefined || !v || PLACEHOLDER.test(v)) return undefined;
  return opts.trim === false ? raw : v;
}

/** A yes/no setting from the environment (envValue): `1`, `true`, `yes`, `igen` or `on` is yes, any other value no; not set, `dflt`. */
export function envFlag(env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean {
  return bool(envValue(env, key), dflt);
}

/** Normalises a NAV environment name (test/teszt, production/prod/éles); undefined means test. */
export function navEnvironment(v: string | undefined): NavEnvironment {
  const s = (v ?? 'test').trim().toLowerCase();
  if (s === 'production' || s === 'prod' || s === 'eles' || s === 'éles') return 'production';
  if (s === 'test' || s === 'teszt') return 'test';
  throw new AppError('INVALID_CONFIG', `Ismeretlen NAV környezet: ${v}`, {
    hint: 'A NAV környezet "test" (teszt) vagy "production" (éles) lehet (OPENSZAMLA_NAV_ENV, openszamla nav-setup --env).',
  });
}

/** `${…}` anywhere, or a leading `$VAR` / `%VAR%`: a variable the MCP client did not expand. */
const UNEXPANDED_IN_PATH = /\$\{|^\$[A-Za-z_]|^%[^%\\/]+%/;

/**
 * Expands a leading `~` to the home directory. Shells do this, but MCP clients start the server
 * without a shell, so `"~/.openszamla"` in a client configuration arrives literally.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolves a configured path (OPENSZAMLA_HOME, OPENSZAMLA_DB, --data-dir) to an absolute path. A
 * variable left unexpanded is refused: resolved against the working directory it would silently
 * create a separate, empty database there – with its own invoice numbering.
 */
export function resolveConfiguredPath(value: string, setting: string): string {
  const v = value.trim();
  if (UNEXPANDED_IN_PATH.test(v)) {
    throw new AppError('INVALID_CONFIG', `${setting}: a(z) "${v}" útvonalban ki nem fejtett változó van.`, {
      hint:
        'Az MCP-kliens (vagy a parancsértelmező) nem helyettesítette be a változót. Adj meg abszolút útvonalat ' +
        '(pl. C:\\Users\\Nev\\.openszamla vagy /home/nev/.openszamla), vagy hagyd el a beállítást: az alapértelmezés ~/.openszamla.',
    });
  }
  return resolve(expandHome(v));
}

/** True when a configured path depends on the working directory (relative even after `~` expansion). */
export function isRelativeConfiguredPath(value: string): boolean {
  return !isAbsolute(expandHome(value.trim()));
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OPENSZAMLA_HOME?.trim();
  return home ? resolveConfiguredPath(home, 'OPENSZAMLA_HOME') : join(homedir(), '.openszamla');
}

/**
 * Creates a folder of the data (the data directory, the database's folder) if it does not exist. A path
 * that cannot be one – a file in its place, a drive or share that is not connected, no permission – is
 * an AppError naming the folder instead of a raw file-system error.
 */
export function ensureDataDir(dir: string, what = 'Az adatkönyvtár'): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why =
      code === 'EEXIST' || code === 'ENOTDIR'
        ? 'a helyén vagy az útvonalában fájl van, nem mappa'
        : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
          ? 'nincs írási jogod hozzá (vagy a meghajtó csak olvasható)'
          : code === 'ENOENT' || code === 'UNKNOWN' || code === 'ENODEV' || code === 'ENXIO'
            ? 'a meghajtó vagy a hálózati hely nem érhető el'
            : `a fájlrendszer hibát jelzett (${code ?? 'ismeretlen'})`;
    throw new AppError('DATA_DIR_UNAVAILABLE', `${what} nem hozható létre és nem nyitható meg: ${dir} – ${why}.`, {
      hint: 'Adj meg egy létező vagy létrehozható mappát, amelyhez írási jogod van (--data-dir, OPENSZAMLA_HOME; az adatbázisfájlé: OPENSZAMLA_DB); hálózati vagy cserélhető meghajtónál előbb csatlakoztasd.',
      cause: e,
    });
  }
}

/**
 * The --data-dir option of a command the program prints for `dataDir` (with its leading space), in the shortest correct
 * form: none for the built-in ~/.openszamla (a terminal without OPENSZAMLA_HOME uses it anyway), a folder under the home
 * folder as "~/…" ("~\…" on Windows – the program expands the ~ itself, resolveConfiguredPath), any other one as it is.
 */
export function dataDirOption(dataDir: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const norm = (p: string): string => (win ? p.replace(/\//g, '\\') : p).replace(/[\\/]+$/, '');
  const same = (a: string, b: string): boolean => (win || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const dir = norm(dataDir);
  const h = norm(home);
  if (!h || same(dir, `${h}${sep}.openszamla`)) return '';
  if (same(dir, h)) return ' --data-dir "~"';
  const under = dir.length > h.length + 1 && same(dir.slice(0, h.length), h) && dir.charAt(h.length) === sep;
  return ` --data-dir "${under ? `~${dir.slice(h.length)}` : dir}"`;
}

/**
 * The nav-setup command line that saves the credentials where THIS program reads them (with `env`: switching to that
 * NAV environment). MCP clients often start the server with their own OPENSZAMLA_HOME, which a terminal does not have –
 * so any other data directory than the built-in one is named (dataDirOption). The one form every hint gives: the
 * service's to-dos and errors, `openszamla setup`, `openszamla doctor` and the web UI (README and user doc 3.4 show it too).
 */
export function navSetupCommandLine(dataDir: string, env?: NavEnvironment): string {
  return `openszamla nav-setup${env ? ` --env ${env}` : ''}${dataDirOption(dataDir)}`;
}

/** navSetupCommandLine, with the npx form that needs no global installation. */
export function navSetupCommand(dataDir: string): string {
  return `${navSetupCommandLine(dataDir)} (telepítés nélkül: npx -y ${navSetupCommandLine(dataDir)})`;
}

/**
 * The command that sends an invoice whose NAV state belongs to the other NAV system to the configured one – with the
 * explicit confirmation (--confirm) – as `openszamla nav-send-to-configured-environment` and the web UI give it.
 */
export function navSendCommandLine(invoice: string, dataDir: string): string {
  return `openszamla nav-send-to-configured-environment "${invoice}" --confirm${dataDirOption(dataDir)}`;
}

/** Why `nav` cannot be used with `software` (Hungarian, never echoing a value); null when it can (or NAV is not configured). */
export function navConfigProblem(nav: NavRuntimeConfig | null, software: NavSoftware): string | null {
  if (!nav) return null;
  if (nav.fileProblem) return nav.fileProblem;
  const problems = navCredentialProblems(nav.credentials, { taxNumber: false });
  if (problems.length) return `A NAV technikai felhasználó adatai hibásak: ${problems.join('; ')}.`;
  return navSoftwareProblem(software);
}

const FILE_FIELDS = ['login', 'password', 'signingKey', 'exchangeKey'] as const;

/**
 * The settings of a nav-credentials.json that cannot be used as it is (hand-edited, a save cut short …): the program
 * starts anyway and sends nothing (fileProblem → navProblem), like with any other bad setting. `fileEnvironment` is
 * what the file names, when that much can be read.
 */
function brokenNavFile(problem: string, envOverride: string | undefined, fileEnvironment: string | undefined, credentials: Partial<Record<(typeof FILE_FIELDS)[number], string>> = {}): NavRuntimeConfig {
  // A wrong OPENSZAMLA_NAV_ENV stays the documented INVALID_CONFIG; an unknown value in the file is part of `problem`.
  let environment: NavEnvironment = envOverride !== undefined ? navEnvironment(envOverride) : 'test';
  if (envOverride === undefined && fileEnvironment !== undefined) {
    try {
      environment = navEnvironment(fileEnvironment);
    } catch {
      // stays 'test', the documented default
    }
  }
  return {
    environment,
    credentials: { login: credentials.login ?? '', password: credentials.password ?? '', signingKey: credentials.signingKey ?? '', exchangeKey: credentials.exchangeKey ?? '' },
    source: 'file',
    fileProblem: problem,
  };
}

/**
 * The text of a nav-credentials.json (`bytes`), also one saved by hand: UTF-8 with or without a byte order mark
 * (Windows PowerShell 5.1 `Out-File -Encoding utf8` and older Notepad write one), or UTF-16 with one, little or big
 * endian – what Windows PowerShell 5.1 `Out-File` and `>` write by default, and Notepad's "Unicode" save. Null when
 * such a UTF-16 file cannot be decoded (an odd length, a broken surrogate pair); anything else is read as UTF-8.
 */
function navFileText(bytes: Buffer): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!bigEndian && !(bytes[0] === 0xff && bytes[1] === 0xfe)) return bytes.toString('utf8');
  try {
    // Without full ICU, TextDecoder knows only little endian: big endian is swapped to it first (on a copy).
    const units = bigEndian ? Buffer.from(bytes).swap16() : bytes;
    return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(units).slice(1);
  } catch {
    return null; // an odd number of bytes (swap16, decode) or a broken surrogate pair
  }
}

export function loadNavConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): NavRuntimeConfig | null {
  // Set (and not empty) it overrides the environment saved by nav-setup; the extension and the plugin
  // pass "" when their "NAV környezet" option is left empty.
  const environment = envValue(env, 'OPENSZAMLA_NAV_ENV');
  const login = envValue(env, 'OPENSZAMLA_NAV_LOGIN');
  if (login) {
    const password = envValue(env, 'OPENSZAMLA_NAV_PASSWORD', { trim: false });
    const signingKey = envValue(env, 'OPENSZAMLA_NAV_SIGNING_KEY');
    const exchangeKey = envValue(env, 'OPENSZAMLA_NAV_EXCHANGE_KEY');
    if (!password || !signingKey || !exchangeKey) {
      throw new AppError('INVALID_CONFIG', 'Hiányos NAV beállítás a környezeti változókban.', {
        hint: 'Add meg együtt: OPENSZAMLA_NAV_LOGIN, OPENSZAMLA_NAV_PASSWORD, OPENSZAMLA_NAV_SIGNING_KEY, OPENSZAMLA_NAV_EXCHANGE_KEY.',
      });
    }
    return { environment: navEnvironment(environment), credentials: { login, password, signingKey, exchangeKey }, source: 'env' };
  }
  const file = join(dataDir, NAV_CREDENTIALS_FILE);
  if (!existsSync(file)) return null;
  // A damaged file is a bad setting like any other (navConfigProblem): every command starts, nothing is sent.
  const where = `A NAV-beállítás fájlja (${file})`;
  let text: string | null;
  try {
    text = navFileText(readFileSync(file));
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return brokenNavFile(`${where} nem olvasható${typeof code === 'string' ? ` (${code})` : ''}.`, environment, undefined);
  }
  let parsed: unknown;
  try {
    if (text === null) throw new SyntaxError('Not decodable as UTF-16.');
    parsed = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the text around the error, which may be a secret.
    const named = /"environment"\s*:\s*"([^"\\]{0,20})"/.exec(text ?? '')?.[1];
    return brokenNavFile(`${where} nem érvényes JSON (pl. kézi szerkesztés vagy félbeszakadt mentés miatt).`, environment, named);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return brokenNavFile(`${where} nem a várt formátumú (egy JSON-objektum kell).`, environment, undefined);
  }
  const obj = parsed as Record<string, unknown>;
  const s = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');
  const credentials = { login: s('login'), password: s('password'), signingKey: s('signingKey'), exchangeKey: s('exchangeKey') };
  const fileEnvironment = s('environment') || undefined;
  const notText = [...FILE_FIELDS, 'environment'].filter((k) => obj[k] !== undefined && obj[k] !== null && typeof obj[k] !== 'string');
  if (notText.length) {
    return brokenNavFile(`${where} hibás: ${notText.map((k) => `a(z) „${k}” mező`).join(', ')} nem szöveg (az értéket idézőjelek között kell megadni).`, environment, fileEnvironment, credentials);
  }
  if (environment === undefined && fileEnvironment !== undefined) {
    try {
      navEnvironment(fileEnvironment);
    } catch {
      return brokenNavFile(`${where} hibás: a környezet („environment”) értéke test vagy production lehet.`, environment, undefined, credentials);
    }
  }
  // Missing or empty fields are reported by navConfigProblem ("a jelszó üres" …).
  return { environment: navEnvironment(environment ?? fileEnvironment), credentials, source: 'file' };
}

/** Size, modification time and identity of `file`; '' when it does not exist (or cannot be looked at). */
function fileStamp(file: string): string {
  try {
    const s = statSync(file, { throwIfNoEntry: false });
    return s ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : '';
  } catch {
    return '';
  }
}

/**
 * Follows <dataDir>/nav-credentials.json while the program runs: `openszamla nav-setup` saves it while an MCP server
 * (Claude Desktop, Claude Code, Codex) or `openszamla serve` keeps running. When the file's size or modification time
 * changes, the NAV settings are read again exactly as at start (loadNavConfig: the OPENSZAMLA_NAV_LOGIN … variables
 * still win, OPENSZAMLA_NAV_ENV still overrides the environment) and checked again (navConfigProblem). Never throws: a
 * half-written or broken file becomes a navProblem like any other bad setting.
 */
export class NavSettingsWatch {
  readonly #file: string;
  readonly #env: NodeJS.ProcessEnv;
  /** null until the first look: the file is read once more then, so a save during start-up is not missed. */
  #stamp: string | null = null;

  constructor(dataDir: string, env: NodeJS.ProcessEnv) {
    this.#file = join(dataDir, NAV_CREDENTIALS_FILE);
    this.#env = env;
  }

  /** `config` with the NAV settings read again when the file changed since the last look; null when it did not. */
  refresh(config: AppConfig): AppConfig | null {
    const stamp = fileStamp(this.#file);
    if (stamp === this.#stamp) return null;
    this.#stamp = stamp;
    let nav: NavRuntimeConfig | null;
    try {
      nav = loadNavConfig(config.dataDir, this.#env);
    } catch (e) {
      // e.g. an unknown OPENSZAMLA_NAV_ENV, harmless until a file appeared: never thrown here (issuing may be underway).
      nav = brokenNavFile(e instanceof Error ? e.message : String(e), undefined, undefined);
    }
    return { ...config, nav, navProblem: navConfigProblem(nav, config.software) };
  }
}

/**
 * Whether the NAV settings of a configuration loaded with these options follow nav-credentials.json (NavSettingsWatch):
 * not when the caller fixed them (overrides.nav – tests, the fake NAV) or the OPENSZAMLA_NAV_LOGIN … variables give them.
 */
export function followsNavCredentialsFile(opts: LoadConfigOptions): boolean {
  return opts.overrides?.nav === undefined && !envValue(opts.env ?? process.env, 'OPENSZAMLA_NAV_LOGIN');
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir !== undefined ? resolveConfiguredPath(opts.dataDir, 'Az adatkönyvtár (--data-dir)') : defaultDataDir(env);
  const dbEnv = env.OPENSZAMLA_DB?.trim();
  const dbPath = opts.dbPath ?? (dbEnv ? resolveConfiguredPath(dbEnv, 'OPENSZAMLA_DB') : join(dataDir, 'openszamla.db'));
  const nav = opts.overrides?.nav !== undefined ? opts.overrides.nav : loadNavConfig(dataDir, env);
  const rawMode = (envValue(env, 'OPENSZAMLA_CONFIRM_MODE') ?? 'code').toLowerCase();
  const confirmMode: ConfirmMode = rawMode === 'auto' || rawMode === 'param' ? 'code' : (rawMode as ConfirmMode);
  if (!['code', 'elicit', 'none'].includes(confirmMode)) {
    throw new AppError('INVALID_CONFIG', `Ismeretlen OPENSZAMLA_CONFIRM_MODE: ${rawMode}`, { hint: 'Lehetséges értékek: code (alapértelmezés), elicit, none.' });
  }
  const softwareId = envValue(env, 'OPENSZAMLA_SOFTWARE_ID');
  const software: NavSoftware = { ...DEFAULT_SOFTWARE, ...(softwareId ? { softwareId } : {}) };
  const base: AppConfig = {
    dataDir,
    dbPath,
    pdfDir: join(dataDir, 'pdf'),
    exportDir: join(dataDir, 'export'),
    nav,
    navProblem: null,
    navAutoSubmit: bool(envValue(env, 'OPENSZAMLA_NAV_AUTO_SUBMIT'), true),
    navWaitSeconds: Math.max(0, Math.min(45, Number(envValue(env, 'OPENSZAMLA_NAV_WAIT_SECONDS') ?? 20) || 0)),
    confirmMode,
    allowFileCopy: bool(envValue(env, 'OPENSZAMLA_ALLOW_FILE_COPY'), opts.fileCopyDefault ?? true),
    software,
  };
  const config: AppConfig = { ...base, ...opts.overrides, dataDir, dbPath, nav };
  // Checked here, not when the first invoice is reported: a wrong key must not surface only after issuing.
  return { ...config, navProblem: navConfigProblem(nav, config.software) };
}

/** An HTTP access token given with `serve --token` or OPENSZAMLA_HTTP_TOKEN must be at least this long. */
export const MIN_HTTP_TOKEN_LENGTH = 20;

/**
 * Why an HTTP access token is too weak to guard the MCP endpoint and the web UI – both give full rights,
 * issuing and cancelling included – in Hungarian and without echoing it; null when it will do. The token
 * `serve` generates (32 base64url characters) always does.
 */
export function httpTokenProblem(token: string): string | null {
  const problems: string[] = [];
  if (token.length < MIN_HTTP_TOKEN_LENGTH) problems.push(`${MIN_HTTP_TOKEN_LENGTH} karakternél rövidebb`);
  if (!/^[A-Za-z0-9_-]*$/.test(token)) problems.push('az angol ábécé betűin, a számjegyeken, a „_” és a „-” jelen kívül más karaktert is tartalmaz');
  return problems.length ? problems.join(', és ') : null;
}
