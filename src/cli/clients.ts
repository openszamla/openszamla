/**
 * MCP clients for the command line (`openszamla config`, `openszamla setup`, `openszamla doctor`): where each client
 * keeps its configuration, the server entry OpenSzámla puts there, and the writers.
 *
 * - The entry starts the server without a shell and without PATH: the absolute path of the Node.js executable and of
 *   this installation's entry script. Desktop apps on macOS do not get the shell's PATH, and on Windows `openszamla`
 *   and `npx` are .cmd shims that a process started without a shell cannot run (ENOENT, or EINVAL for a .cmd path).
 * - Every location comes from the environment passed in (USERPROFILE / HOME, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME,
 *   CODEX_HOME, CLAUDE_CONFIG_DIR), never from the process itself, so a run can be pointed anywhere (the tests point
 *   them at throw-away folders).
 * - A file is changed only after a timestamped backup next to it, and everything else in it stays; an existing
 *   "openszamla" entry is replaced only with force. Nothing secret is printed: of an existing entry only its command,
 *   the number of its arguments and the names of its environment variables are shown (its arguments or URL may carry
 *   an HTTP token, its environment NAV credentials).
 * - `claude mcp add` is run without a shell, and only when `claude` is an executable (on Windows .exe or .com): an npm
 *   .cmd shim is not run – its command line is printed instead.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.ts';
import { dataDirOption, resolveConfiguredPath } from '../service/config.ts';
import { findTable, parseTomlValue, removeTable, tableValues, tomlStatements, type TomlStatement } from './toml.ts';

export type ClientId = 'claude-desktop' | 'claude-code' | 'codex' | 'cursor' | 'vscode';

/** The clients `config --write` and `setup` can connect, in the order they are offered. */
export const WRITABLE_CLIENTS: readonly ClientId[] = ['claude-desktop', 'claude-code', 'codex', 'cursor', 'vscode'];

export const CLIENT_TITLES: Readonly<Record<ClientId, string>> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  codex: 'Codex (OpenAI)',
  cursor: 'Cursor',
  vscode: 'VS Code (GitHub Copilot)',
};

export interface ClientContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The working directory: the VS Code workspace, the Claude Code project. */
  cwd: string;
  /** The data directory the entry points the server to (absolute). */
  dataDir: string;
  now: Date;
}

/** How a client starts the server. */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function isClientId(v: string): v is ClientId {
  return (WRITABLE_CLIENTS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Environment and paths
// ---------------------------------------------------------------------------------------------

/** A variable of `env` (case-insensitive on Windows, like the process environment there); empty counts as not set. */
export function envGet(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  let v = env[key];
  if (v === undefined && platform === 'win32') {
    const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
    v = k === undefined ? undefined : env[k];
  }
  const t = v?.trim();
  return t ? t : undefined;
}

/** The user's home folder as the clients see it: USERPROFILE on Windows, HOME elsewhere. */
export function homeDir(ctx: Pick<ClientContext, 'env' | 'platform'>): string {
  const v = envGet(ctx.env, ctx.platform === 'win32' ? 'USERPROFILE' : 'HOME', ctx.platform);
  return v && isAbsolute(v) ? v : homedir();
}

function absoluteEnv(ctx: Pick<ClientContext, 'env' | 'platform'>, key: string, fallback: string): string {
  const v = envGet(ctx.env, key, ctx.platform);
  return v && isAbsolute(v) ? v : fallback;
}

const appDataDir = (ctx: ClientContext): string => absoluteEnv(ctx, 'APPDATA', join(homeDir(ctx), 'AppData', 'Roaming'));
const localAppDataDir = (ctx: ClientContext): string => absoluteEnv(ctx, 'LOCALAPPDATA', join(homeDir(ctx), 'AppData', 'Local'));
const xdgConfigDir = (ctx: ClientContext): string => absoluteEnv(ctx, 'XDG_CONFIG_HOME', join(homeDir(ctx), '.config'));

/** The built-in data directory (~/.openszamla) of this user. */
export function builtinDataDir(ctx: Pick<ClientContext, 'env' | 'platform'>): string {
  return join(homeDir(ctx), '.openszamla');
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The data directory differs from the built-in one: the entry names it (OPENSZAMLA_HOME) – a desktop client does not see the shell's variables. */
export function isCustomDataDir(ctx: ClientContext): boolean {
  return !samePath(ctx.dataDir, builtinDataDir(ctx), ctx.platform);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function pathDirs(ctx: Pick<ClientContext, 'env' | 'platform'>): string[] {
  const sep = ctx.platform === 'win32' ? ';' : ':';
  return (envGet(ctx.env, 'PATH', ctx.platform) ?? '')
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && isAbsolute(d));
}

/** The first `name` on PATH that can be run (on Windows with a PATHEXT extension); null when there is none. */
export function findOnPath(name: string, ctx: Pick<ClientContext, 'env' | 'platform'>): string | null {
  const exts =
    ctx.platform === 'win32'
      ? (envGet(ctx.env, 'PATHEXT', ctx.platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
      : [''];
  for (const dir of pathDirs(ctx)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (!isFile(p)) continue;
      if (ctx.platform !== 'win32') {
        try {
          accessSync(p, fsConstants.X_OK);
        } catch {
          continue;
        }
      }
      return p;
    }
  }
  return null;
}

/** A program a process can start without a shell: anything executable on Unix, an .exe or .com on Windows. */
export function runsWithoutShell(file: string, platform: NodeJS.Platform): boolean {
  return platform !== 'win32' || ['.exe', '.com'].includes(extname(file).toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// The server entry
// ---------------------------------------------------------------------------------------------

/** This installation's entry script: dist/cli/main.js – src/cli/main.ts when the program runs from its sources. */
export function entryScript(): string {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `main${extname(self)}`);
}

/** The program runs from the npx cache (`npx openszamla …`): a path there may be gone after the next cleanup. */
export function isTransientInstall(script: string): boolean {
  return /[\\/]_npx[\\/]/.test(script);
}

/**
 * The Node.js executable to write into a client configuration: the running one – by the name PATH knows it under when
 * that is the same file (Homebrew's /opt/homebrew/bin/node instead of the versioned Cellar path a `brew upgrade`
 * removes).
 */
export function nodeExecutable(ctx: Pick<ClientContext, 'env' | 'platform'>, execPath: string = process.execPath): string {
  const real = realpathOr(execPath);
  for (const dir of pathDirs(ctx)) {
    const candidate = join(dir, ctx.platform === 'win32' ? 'node.exe' : 'node');
    if (isFile(candidate) && samePath(realpathOr(candidate), real, ctx.platform)) return candidate;
  }
  return execPath;
}

/** The entry: Node.js and this installation's entry script by absolute path, the data directory when it is not the built-in one. */
export function serverLaunch(ctx: ClientContext): Launch {
  return {
    command: nodeExecutable(ctx),
    args: [entryScript(), 'mcp'],
    ...(isCustomDataDir(ctx) ? { env: { OPENSZAMLA_HOME: ctx.dataDir } } : {}),
  };
}

/**
 * Double-quotes a command-line argument (bash, zsh, PowerShell and cmd all keep "…" with spaces as one argument).
 * Trailing backslashes are doubled so they cannot escape the closing quote.
 */
export function quoteArg(s: string): string {
  return `"${s.replace(/(\\+)$/, '$1$1')}"`;
}

/** A command-line word: as it is when it needs no quoting, else quoteArg. */
function word(s: string): string {
  return /^[A-Za-z0-9_.:@%+=,-]+$/.test(s) ? s : quoteArg(s);
}

/** TOML string: a literal string ('…', backslashes as they are) unless the value needs escaping. */
export function tomlString(s: string): string {
  return /['\u0000-\u001f\u007f]/.test(s) ? JSON.stringify(s).replace(/\u007f/g, '\\u007F') : `'${s}'`;
}

/** A path as a literal argument of the shell the user most likely types into (PowerShell on Windows). */
function shellPath(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * `openszamla <command>`, with --data-dir when the data directory is not the built-in one – in the form every hint gives
 * (dataDirOption: `~` for a folder under the home folder, which the program expands itself).
 */
export function commandFor(base: string, ctx: ClientContext): string {
  return `openszamla ${base}${dataDirOption(ctx.dataDir, homeDir(ctx), ctx.platform)}`;
}

// ---------------------------------------------------------------------------------------------
// Where the clients keep their configuration
// ---------------------------------------------------------------------------------------------

export interface ConfigFile {
  path: string;
  /** Which installation reads it, when that needs saying. */
  note?: string;
  /**
   * Windows Claude Desktop only – whose file it is: the Microsoft Store (MSIX) app's data folder, which current builds
   * read (%LOCALAPPDATA%\Claude-Data\claude_<id>); the virtualized AppData copy older Store builds read
   * (%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude); the classic installer's (%APPDATA%\Claude).
   */
  kind?: 'store' | 'store-legacy' | 'classic';
}

/** The subfolders of `dir` whose names match `re`; none when it cannot be read. */
function subfolders(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
}

/**
 * The claude_desktop_config.json files a Claude Desktop installation may read. On Windows: the Store (MSIX) app's data
 * folder first – current builds read only that one (they keep their whole state there, the logs in %LOCALAPPDATA%\Claude) –,
 * then the AppData copy of older Store builds, then the classic installer's file.
 */
export function claudeDesktopConfigFiles(ctx: ClientContext): ConfigFile[] {
  if (ctx.platform === 'win32') {
    const local = localAppDataDir(ctx);
    const data = join(local, 'Claude-Data');
    const packages = join(local, 'Packages');
    return [
      ...subfolders(data, /^claude_[0-9a-z]+$/i).map((n): ConfigFile => ({ path: join(data, n, 'claude_desktop_config.json'), note: 'a Microsoft Store-ból (MSIX) telepített Claude Desktop ezt olvassa', kind: 'store' })),
      ...subfolders(packages, /^Claude_[0-9a-z]+$/i).map((n): ConfigFile => ({
        path: join(packages, n, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
        note: 'a Microsoft Store-ból (MSIX) telepített régebbi Claude Desktop ezt olvassa',
        kind: 'store-legacy',
      })),
      { path: join(appDataDir(ctx), 'Claude', 'claude_desktop_config.json'), kind: 'classic' },
    ];
  }
  if (ctx.platform === 'darwin') return [{ path: join(homeDir(ctx), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') }];
  return [{ path: join(xdgConfigDir(ctx), 'Claude', 'claude_desktop_config.json') }];
}

/**
 * The claude_desktop_config.json the installed app reads. On Windows: the file in a Store app's data folder (a current
 * build reads nothing else, so a file left from an older build must not win; of several data folders the one changed
 * last), also before the app wrote it there – when the folder holds the app's state; an EMPTY data folder, left behind
 * by an uninstalled build, is not an app in use and hides nothing. Else the older Store builds' own file when it
 * exists, else the classic %APPDATA% one when it exists, else the older Store builds' folder when the app has created
 * it, else the classic one.
 */
export function claudeDesktopConfigPath(ctx: ClientContext): ConfigFile {
  const files = claudeDesktopConfigFiles(ctx);
  const classic = files[files.length - 1] as ConfigFile;
  const modified = (path: string): number => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  };
  const inUse = (dir: string): boolean => {
    try {
      return readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  };
  const newest = (list: ConfigFile[], of: (f: ConfigFile) => string): ConfigFile | undefined => [...list].sort((a, b) => modified(of(b)) - modified(of(a)))[0];
  const store = files.filter((f) => f.kind === 'store');
  const legacy = files.filter((f) => f.kind === 'store-legacy');
  return (
    // A Store build's own file; of several data folders the one whose file changed last.
    newest(store.filter((f) => existsSync(f.path)), (f) => f.path) ??
    // No file there yet, but the app keeps its state in the folder: it will read its configuration from there. An
    // empty folder (left behind by an uninstalled build) is not an app in use.
    newest(store.filter((f) => inUse(dirname(f.path))), (f) => dirname(f.path)) ??
    newest(legacy.filter((f) => existsSync(f.path)), (f) => f.path) ??
    (existsSync(classic.path) ? classic : legacy.find((f) => existsSync(dirname(f.path)))) ??
    classic
  );
}

export function codexConfigPath(ctx: ClientContext): string {
  const custom = envGet(ctx.env, 'CODEX_HOME', ctx.platform);
  return join(custom ? resolveConfiguredPath(custom, 'CODEX_HOME') : join(homeDir(ctx), '.codex'), 'config.toml');
}

export const cursorConfigPath = (ctx: ClientContext): string => join(homeDir(ctx), '.cursor', 'mcp.json');
export const vscodeWorkspaceConfigPath = (ctx: ClientContext): string => join(ctx.cwd, '.vscode', 'mcp.json');

export function vscodeUserConfigPath(ctx: ClientContext): string {
  if (ctx.platform === 'win32') return join(appDataDir(ctx), 'Code', 'User', 'mcp.json');
  if (ctx.platform === 'darwin') return join(homeDir(ctx), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  return join(xdgConfigDir(ctx), 'Code', 'User', 'mcp.json');
}

/** Claude Code's own configuration (user-scope MCP servers): ~/.claude.json, or in CLAUDE_CONFIG_DIR. */
export function claudeCodeConfigPath(ctx: ClientContext): string {
  const custom = envGet(ctx.env, 'CLAUDE_CONFIG_DIR', ctx.platform);
  return join(custom ? resolveConfiguredPath(custom, 'CLAUDE_CONFIG_DIR') : homeDir(ctx), '.claude.json');
}

/** Whether a client seems to be installed on this machine, and the evidence. */
export function clientPresence(client: ClientId, ctx: ClientContext): string | null {
  const exists = (p: string): string | null => (existsSync(p) ? p : null);
  switch (client) {
    case 'claude-desktop':
      return claudeDesktopConfigFiles(ctx).map((f) => exists(dirname(f.path))).find(Boolean) ?? null;
    case 'claude-code':
      return findOnPath('claude', ctx) ?? exists(claudeCodeConfigPath(ctx)) ?? exists(join(homeDir(ctx), '.claude'));
    case 'codex':
      return findOnPath('codex', ctx) ?? exists(dirname(codexConfigPath(ctx)));
    case 'cursor':
      return exists(dirname(cursorConfigPath(ctx)));
    case 'vscode':
      return findOnPath('code', ctx) ?? exists(dirname(vscodeUserConfigPath(ctx)));
  }
}

// ---------------------------------------------------------------------------------------------
// Reading configurations (also for doctor)
// ---------------------------------------------------------------------------------------------

/** An "openszamla" server entry as far as it can be read (values of env are kept for the data directory only). */
export interface EntryView {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** An HTTP entry (url); the URL itself is never kept – it may carry the token. */
  http?: boolean;
}

export interface ConfigView {
  client: ClientId;
  /** e.g. "Claude Code (felhasználói szint)". */
  label: string;
  file: string;
  note?: string;
  exists: boolean;
  /** Why the file cannot be read; the client probably cannot read it either. */
  problem?: string;
  /** The entry; null when the file has none. */
  entry?: EntryView | null;
  /** Parts of a Codex entry that could not be read. */
  unreadable?: string[];
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new AppError('CLIENT_CONFIG_UNREADABLE', `A(z) ${file} fájl nem olvasható (${(e as NodeJS.ErrnoException).code ?? 'ismeretlen hiba'}).`, {
      hint: 'Ellenőrizd, hogy a fájl elérhető-e, és van-e olvasási jogod hozzá.',
      cause: e,
    });
  }
}

/** Where a JSON parse error is (line and column), never the parser's message: it may quote the file (secrets). */
const JSON_LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * Where `text` stops being JSON: the offset of the first character that does not fit (text.length when it ends too
 * early), or null for valid JSON. JSON.parse's own message names the position only for some mistakes, and in a form
 * that differs between Node.js versions; a configuration file a person edited by hand deserves the line every time.
 */
export function jsonErrorOffset(text: string): number | null {
  const n = text.length;
  let i = 0;
  const fail = (): never => {
    throw new RangeError('json');
  };
  const ws = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const string = (): void => {
    i++;
    for (;;) {
      if (i >= n) fail();
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return;
      }
      if (c < ' ') fail();
      if (c === '\\') {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail();
      } else i++;
    }
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (c === '{') {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === close) {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') return string();
    JSON_LITERAL.lastIndex = i;
    const m = JSON_LITERAL.exec(text);
    if (!m) fail();
    i += (m as RegExpExecArray)[0].length;
  };
  try {
    value();
    ws();
    if (i < n) fail();
    return null;
  } catch (e) {
    if (e instanceof RangeError && e.message === 'json') return Math.min(i, n);
    throw e;
  }
}

function jsonErrorPlace(text: string, e: unknown): string {
  const m = /position (\d+)/.exec(e instanceof Error ? e.message : '');
  const pos = jsonErrorOffset(text) ?? (m ? Number(m[1]) : null);
  if (pos === null) return '';
  const before = text.slice(0, pos);
  return ` (${before.split('\n').length}. sor, ${pos - before.lastIndexOf('\n')}. oszlop)`;
}

interface JsonConfig {
  exists: boolean;
  text: string;
  data: Record<string, unknown>;
  /** The file is JSON with comments or trailing commas (VS Code allows them): read, but a rewrite would lose them. */
  jsonc?: boolean;
}

/**
 * JSON with comments (JSONC, what VS Code reads): the text without its // and block comments and without commas before a
 * closing } or ]. Strings are copied as they are. What is left is parsed as JSON by the caller.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  const n = text.length;
  /** The index after the white space and comments that start at `i`. */
  const skip = (i: number): number => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
      } else return i;
    }
  };
  for (let i = 0; i < n; ) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const next = skip(i);
      out += text.slice(i, next).replace(/[^\n]/g, '');
      i = next;
    } else if (c === ',') {
      const next = text[skip(i + 1)];
      if (next !== '}' && next !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `jsonc`: the client reads JSON with comments (VS Code) – such a file is read too, and marked (JsonConfig.jsonc). */
function readJsonConfig(file: string, jsonc = false): JsonConfig {
  if (!existsSync(file)) return { exists: false, text: '', data: {} };
  const text = readText(file).replace(/^\uFEFF/, '');
  if (!text.trim()) return { exists: true, text, data: {} };
  let data: unknown;
  let commented = false;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Where the file is broken: for a client that allows comments, the first error that is not a comment (the
    // stripped text keeps the line breaks, so the line is the file's).
    let cause: unknown = e;
    let source = text;
    if (jsonc) {
      const stripped = stripJsonComments(text);
      try {
        data = JSON.parse(stripped);
        commented = true;
      } catch (inner) {
        cause = inner;
        source = stripped;
      }
    }
    if (!commented) {
      throw new AppError('CLIENT_CONFIG_INVALID', `A(z) ${file} nem érvényes JSON${jsonErrorPlace(source, cause)} – nem módosítottam.`, {
        hint: jsonc
          ? 'Javítsd a fájlt (gyakori hiba a hiányzó vessző, idézőjel vagy zárójel; a megjegyzés és a záró vessző itt megengedett), vagy nevezd át, és futtasd újra a parancsot.'
          : 'Javítsd a fájlt (gyakori hiba a hiányzó vagy fölösleges vessző, illetve a megjegyzés), vagy nevezd át, és futtasd újra a parancsot.',
      });
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError('CLIENT_CONFIG_INVALID', `A(z) ${file} nem a várt formátumú (egy JSON-objektum kell) – nem módosítottam.`, {
      hint: 'Javítsd vagy nevezd át a fájlt, és futtasd újra a parancsot.',
    });
  }
  return { exists: true, text, data: data as Record<string, unknown>, ...(commented ? { jsonc: true } : {}) };
}

function entryView(v: unknown): EntryView {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const view: EntryView = {};
  if (typeof o.command === 'string') view.command = o.command;
  if (Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')) view.args = o.args as string[];
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    view.env = Object.fromEntries(Object.entries(o.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  if (typeof o.url === 'string' || o.type === 'http' || o.type === 'sse') view.http = true;
  return view;
}

function jsonView(client: ClientId, label: string, file: string, key: string, note?: string): ConfigView {
  const base: ConfigView = { client, label, file, exists: existsSync(file), ...(note ? { note } : {}) };
  if (!base.exists) return base;
  try {
    const servers = readJsonConfig(file, client === 'vscode').data[key];
    const entry = servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, unknown>).openszamla : undefined;
    return { ...base, entry: entry === undefined ? null : entryView(entry) };
  } catch (e) {
    return { ...base, problem: e instanceof AppError ? e.message : String(e) };
  }
}

const CODEX_TABLE = ['mcp_servers', 'openszamla'];

interface CodexRead {
  lines: string[];
  stmts: TomlStatement[];
  entry: EntryView;
  unreadable: string[];
  defined: boolean;
}

function readCodex(text: string): CodexRead {
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.length ? body.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const stmts = tomlStatements(lines);
  const d = findTable(stmts, CODEX_TABLE);
  const entry: EntryView = {};
  const unreadable: string[] = [];
  const values = tableValues(stmts, CODEX_TABLE);
  if (values.has('url')) entry.http = true; // a Streamable HTTP server (its URL is never kept)
  for (const key of ['command', 'args', 'env']) {
    const raw = values.get(key);
    if (raw === undefined) continue;
    const p = parseTomlValue(raw);
    if (!p.ok) unreadable.push(key);
    else if (key === 'command' && typeof p.value === 'string') entry.command = p.value;
    else if (key === 'args' && Array.isArray(p.value)) entry.args = p.value;
    else if (key === 'env' && typeof p.value === 'object' && !Array.isArray(p.value)) entry.env = p.value;
    else unreadable.push(key);
  }
  for (const [key, raw] of tableValues(stmts, [...CODEX_TABLE, 'env'])) {
    const p = parseTomlValue(raw);
    if (p.ok && typeof p.value === 'string') entry.env = { ...entry.env, [key]: p.value };
    else unreadable.push(`env.${key}`);
  }
  if (d.elsewhere.length) unreadable.push('a tábla fejléc nélküli (pontozott vagy egysoros) megadása');
  return { lines, stmts, entry, unreadable, defined: Boolean(d.table || d.subtables.length || d.elsewhere.length) };
}

function codexView(ctx: ClientContext): ConfigView {
  let file: string;
  try {
    file = codexConfigPath(ctx);
  } catch (e) {
    return { client: 'codex', label: CLIENT_TITLES.codex, file: '(CODEX_HOME)', exists: false, problem: e instanceof AppError ? e.message : String(e) };
  }
  const base: ConfigView = { client: 'codex', label: CLIENT_TITLES.codex, file, exists: existsSync(file) };
  if (!base.exists) return base;
  try {
    const r = readCodex(readText(file));
    return { ...base, entry: r.defined ? r.entry : null, ...(r.unreadable.length ? { unreadable: r.unreadable } : {}) };
  } catch (e) {
    return { ...base, problem: e instanceof AppError ? e.message : String(e) };
  }
}

/** Every configuration file of the known clients that may name the server, and what it says about "openszamla". */
export function inspectClientConfigs(ctx: ClientContext): ConfigView[] {
  const views: ConfigView[] = [];
  const read = claudeDesktopConfigPath(ctx).path;
  const desktop = claudeDesktopConfigFiles(ctx);
  for (const f of desktop) {
    const note = [f.note, desktop.length > 1 && samePath(f.path, read, ctx.platform) ? 'a config --write ezt a fájlt írja' : undefined].filter(Boolean).join('; ');
    views.push(jsonView('claude-desktop', CLIENT_TITLES['claude-desktop'], f.path, 'mcpServers', note || undefined));
  }
  try {
    views.push(jsonView('claude-code', 'Claude Code (felhasználói szint)', claudeCodeConfigPath(ctx), 'mcpServers'));
  } catch (e) {
    views.push({ client: 'claude-code', label: 'Claude Code (felhasználói szint)', file: '(CLAUDE_CONFIG_DIR)', exists: false, problem: e instanceof AppError ? e.message : String(e) });
  }
  views.push(jsonView('claude-code', 'Claude Code (projekt: .mcp.json)', join(ctx.cwd, '.mcp.json'), 'mcpServers'));
  views.push(codexView(ctx));
  views.push(jsonView('cursor', CLIENT_TITLES.cursor, cursorConfigPath(ctx), 'mcpServers'));
  views.push(jsonView('vscode', 'VS Code (felhasználói szint)', vscodeUserConfigPath(ctx), 'servers'));
  views.push(jsonView('vscode', 'VS Code (munkaterület)', vscodeWorkspaceConfigPath(ctx), 'servers'));
  return views;
}

/** The data directory a client entry points the server to – as the server reads it (defaultDataDir): its OPENSZAMLA_HOME, or the built-in one. */
export function entryDataDir(entry: EntryView, ctx: ClientContext): string {
  const v = entry.env?.OPENSZAMLA_HOME?.trim();
  return v ? resolveConfiguredPath(v, 'OPENSZAMLA_HOME') : builtinDataDir(ctx);
}

// ---------------------------------------------------------------------------------------------
// Printing (openszamla config <client>)
// ---------------------------------------------------------------------------------------------

function jsonBlock(key: string, launch: Launch, stdioType: boolean): string {
  return `{
  "${key}": {
    "openszamla": {${stdioType ? '\n      "type": "stdio",' : ''}
      "command": ${JSON.stringify(launch.command)},
      "args": [${launch.args.map((a) => JSON.stringify(a)).join(', ')}]${launch.env ? `,\n      "env": ${JSON.stringify(launch.env)}` : ''}
    }
  }
}`;
}

function codexTomlLines(launch: Launch): string[] {
  return [
    '[mcp_servers.openszamla]',
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    ...(launch.env ? [`env = { ${Object.entries(launch.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`] : []),
  ];
}

/** `claude mcp add …` for the entry (user scope). -e takes every following value up to the next option, so another option must follow it. */
function claudeAddArgs(launch: Launch): string[] {
  const env = Object.entries(launch.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', ...env, '--transport', 'stdio', '--scope', 'user', 'openszamla', '--', launch.command, ...launch.args];
}

function claudeAddLine(launch: Launch): string {
  const env = Object.entries(launch.env ?? {}).map(([k, v]) => ` -e ${quoteArg(`${k}=${v}`)}`).join('');
  return `claude mcp add${env} --transport stdio --scope user openszamla -- ${[launch.command, ...launch.args].map(word).join(' ')}`;
}

/** The ready-to-paste configuration of `client` (openszamla config <client>); changes nothing. */
export function clientConfigText(client: string, ctx: ClientContext): string {
  const custom = isCustomDataDir(ctx);
  const transient = isTransientInstall(entryScript());
  const env = custom ? { env: { OPENSZAMLA_HOME: ctx.dataDir } } : {};
  const launch: Launch = transient ? { command: 'openszamla', args: ['mcp'], ...env } : serverLaunch(ctx);
  const head = transient
    ? '# Figyelem: az OpenSzámla most az npx ideiglenes mappájából fut, ezért itt a rövid parancs áll; ez a globális telepítés (npm install -g openszamla) után működik, és akkor a program a beállítást be is írja: openszamla config <kliens> --write.'
    : '# A parancs a Node.js és az OpenSzámla abszolút útvonala: így a kliens parancsértelmező (shell) és PATH nélkül is elindítja. Node.js-frissítés vagy áthelyezés után ellenőrizd: openszamla doctor.';
  const write = (c: ClientId): string => (transient ? '' : ` – a program be is írja: ${commandFor(`config ${c} --write`, ctx)}`);
  switch (client) {
    case 'claude-code':
      return [
        head,
        `# Claude Code (felhasználói szint, minden projektben)${write('claude-code')}:`,
        claudeAddLine(launch),
        '',
        '# vagy projekt szinten (.mcp.json a projekt gyökerében; megosztott projektben minden gépen kell az openszamla parancs: npm install -g openszamla):',
        jsonBlock('mcpServers', { command: 'openszamla', args: ['mcp'], ...env }, true),
        '',
        '# Plugin (MCP szerver + skill): /plugin marketplace add openszamla/openszamla  majd  /plugin install openszamla@openszamla',
      ].join('\n');
    case 'claude-desktop': {
      const target = claudeDesktopConfigPath(ctx);
      return [
        head,
        `# claude_desktop_config.json – ezen a gépen: ${target.path}${target.note ? ` (${target.note})` : ''}${write('claude-desktop')}`,
        '# (Windows: %APPDATA%\\Claude\\, a Microsoft Store-os változatnál %LOCALAPPDATA%\\Claude-Data\\claude_…\\; macOS: ~/Library/Application Support/Claude/, Linux: ~/.config/Claude/.) Utána lépj ki teljesen a Claude Desktopból, és indítsd újra.',
        '# Alternatíva: a kiadásokhoz mellékelt openszamla-<verzió>.mcpb fájl (dupla kattintással telepíthető bővítmény).',
        jsonBlock('mcpServers', launch, false),
      ].join('\n');
    }
    case 'codex': {
      let file = '~/.codex/config.toml';
      try {
        file = codexConfigPath(ctx);
      } catch {
        // an unusable CODEX_HOME: doctor names it
      }
      return [
        head,
        `# OpenAI Codex (CLI és IDE) – parancssorból:`,
        `codex mcp add openszamla${Object.entries(launch.env ?? {}).map(([k, v]) => ` --env ${quoteArg(`${k}=${v}`)}`).join('')} -- ${[launch.command, ...launch.args].map(word).join(' ')}`,
        '',
        `# vagy ~/.codex/config.toml (ezen a gépen: ${file})${write('codex')}:`,
        ...codexTomlLines(launch),
        '# A NAV jelszót környezeti változóból is átadhatod (a Codex csak a felsorolt változókat engedi át):',
        '# env_vars = ["OPENSZAMLA_NAV_LOGIN", "OPENSZAMLA_NAV_PASSWORD", "OPENSZAMLA_NAV_SIGNING_KEY", "OPENSZAMLA_NAV_EXCHANGE_KEY", "OPENSZAMLA_NAV_ENV"]',
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 300',
        '',
        '# Skill a Codexnek: openszamla install-skill codex',
      ].join('\n');
    }
    case 'vscode':
      return [
        head,
        `# .vscode/mcp.json a munkaterület (projekt) mappájában${transient ? '' : ` – abban a mappában futtatva a program be is írja: ${commandFor('config vscode --write', ctx)}`}`,
        '# Felhasználói szinten: VS Code → Parancspaletta → „MCP: Open User Configuration”, és ugyanezt a bejegyzést másold be.',
        jsonBlock('servers', launch, true),
      ].join('\n');
    case 'cursor':
      return [head, `# ~/.cursor/mcp.json (ezen a gépen: ${cursorConfigPath(ctx)})${write('cursor')}`, jsonBlock('mcpServers', launch, false)].join('\n');
    case 'http':
      return [
        '# Streamable HTTP (claude.ai custom connector, ChatGPT, távoli kliensek):',
        `openszamla serve${dataDirOption(ctx.dataDir, homeDir(ctx), ctx.platform)} --host 127.0.0.1 --port 8787`,
        `# MCP végpont: http://127.0.0.1:8787/mcp  – fejléc: Authorization: Bearer <token> (token: ${custom ? join(ctx.dataDir, 'http-token') : '<adatkönyvtár>/http-token'})`,
        '# Claude Code:  claude mcp add --transport http openszamla-http http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"',
        '# Codex:        codex mcp add openszamla-http --url http://127.0.0.1:8787/mcp --bearer-token-env-var OPENSZAMLA_HTTP_TOKEN',
        '# Nyilvános eléréshez (claude.ai) HTTPS reverse proxy kell; lásd docs/kliensek.md.',
      ].join('\n');
    default:
      throw new AppError('INVALID_INPUT', `Ismeretlen kliens: ${client || '(üres)'}`, { hint: 'claude-code | claude-desktop | codex | vscode | cursor | http' });
  }
}

// ---------------------------------------------------------------------------------------------
// Writing (openszamla config <client> --write, setup)
// ---------------------------------------------------------------------------------------------

export interface WriteOutcome {
  client: ClientId;
  /** created: new file; added: entry added to an existing file; replaced: entry replaced (force); unchanged: it was there already; ran: claude mcp add ran; printed: the command to run was printed. */
  status: 'created' | 'added' | 'replaced' | 'unchanged' | 'ran' | 'printed';
  file?: string;
  backup?: string;
  /** What to tell the user (Hungarian), one line each. */
  lines: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const isoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function writeFailed(file: string, e: unknown): AppError {
  const code = (e as NodeJS.ErrnoException).code ?? 'ismeretlen hiba';
  return new AppError('CLIENT_CONFIG_WRITE_FAILED', `Nem sikerült írni: ${file} (${code}).`, {
    hint: 'Lépj ki a kliensből (ha fut), ellenőrizd, hogy van-e írási jogod a mappához, és futtasd újra a parancsot.',
    cause: e,
  });
}

/** The file to change: a symbolic link (e.g. a dotfiles setup) is written through, not replaced by a plain file. */
function writeTarget(file: string): string {
  try {
    return lstatSync(file).isSymbolicLink() ? realpathSync(file) : file;
  } catch {
    return file;
  }
}

/** A copy of `file` next to it: <file>.bak-ÉÉÉÉHHNN-ÓÓPPMM (never overwriting an earlier backup). */
function backupFile(file: string, now: Date): string {
  for (let i = 0; ; i++) {
    const dest = `${file}.bak-${stamp(now)}${i ? `-${i}` : ''}`;
    try {
      copyFileSync(file, dest, fsConstants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw writeFailed(dest, e);
    }
  }
}

/** Writes through a temporary file renamed over the original (a crash leaves the old or the new file, never half of one), keeping its permissions. */
function writeConfigFile(file: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // a new file
  }
  const tmp = `${file}.openszamla-${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch {
        // Windows: POSIX modes do not apply
      }
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    // Windows refuses to rename over a file another program holds open: write it in place then.
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      try {
        writeFileSync(file, content, 'utf8');
        return;
      } catch (e2) {
        throw writeFailed(file, e2);
      }
    }
    throw writeFailed(file, e);
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** An entry for the user without anything secret: command, number of arguments, names of the variables. */
export function describeEntry(view: EntryView): string {
  const parts: string[] = [];
  if (view.command !== undefined) parts.push(`parancs: ${view.command}`);
  if (view.http) parts.push('HTTP-kapcsolat (url)');
  if (view.args) parts.push(`${view.args.length} argumentum`);
  const names = Object.keys(view.env ?? {});
  if (names.length) parts.push(`környezeti változók: ${names.join(', ')}`);
  return parts.join('; ') || 'üres bejegyzés';
}

function nextStep(client: ClientId, ctx: ClientContext): string {
  switch (client) {
    case 'claude-desktop':
      return ctx.platform === 'darwin'
        ? 'Következő lépés: lépj ki teljesen a Claude Desktopból (Cmd+Q), majd indítsd újra – az ablak bezárása nem elég.'
        : ctx.platform === 'win32'
          ? 'Következő lépés: lépj ki teljesen a Claude Desktopból (Windowson a tálcán, az óra mellett a Claude ikonon jobb kattintás → Quit), majd indítsd újra – az ablak bezárása nem elég.'
          : 'Következő lépés: lépj ki teljesen a Claude Desktopból (File → Quit), majd indítsd újra – az ablak bezárása nem elég.';
    case 'cursor':
      return 'Következő lépés: a Cursorban Settings → MCP: megjelenik az openszamla szerver (ha nem, indítsd újra a Cursort).';
    case 'vscode':
      return 'Következő lépés: nyisd meg ezt a mappát a VS Code-ban; a Copilot Chat (Agent mód) eszközei között megjelenik az openszamla (első indításkor a VS Code jóváhagyást kér).';
    case 'codex':
      return 'Következő lépés: indítsd újra a Codexet; ellenőrzés: codex mcp list (a Codexben: /mcp).';
    case 'claude-code':
      return 'Ellenőrzés: claude mcp list (a Claude Code-ban: /mcp).';
  }
}

function changeLines(o: { client: ClientId; title: string; file: string; created: boolean; backup: string | null; added: string[]; replaced: string | null; kept: string; ctx: ClientContext }): string[] {
  const { ctx } = o;
  return [
    `${o.title}: ${o.created ? 'létrehoztam' : 'módosítottam'} – ${o.file}`,
    o.replaced ? `  Lecseréltem a korábbi openszamla bejegyzést (${o.replaced}); a teljes korábbi bejegyzés a biztonsági másolatban van.` : '  Hozzáadtam az openszamla bejegyzést:',
    ...(o.replaced ? ['  Az új bejegyzés:'] : []),
    ...o.added.map((l) => `    ${l}`),
    ...(o.created ? [] : [`  ${o.kept}`]),
    ...(o.backup ? [`  Biztonsági másolat: ${o.backup}`, `  Visszavonás: ${ctx.platform === 'win32' ? `Copy-Item -Force ${shellPath(o.backup, ctx.platform)} ${shellPath(o.file, ctx.platform)}` : `cp ${shellPath(o.backup, ctx.platform)} ${shellPath(o.file, ctx.platform)}`}`] : []),
    ...(o.created ? [`  Visszavonás: ${ctx.platform === 'win32' ? 'Remove-Item' : 'rm'} ${shellPath(o.file, ctx.platform)}`] : []),
    `  ${nextStep(o.client, ctx)}`,
  ];
}

function assertDurable(): void {
  if (!isTransientInstall(entryScript())) return;
  throw new AppError('TRANSIENT_INSTALL', 'Az OpenSzámla most az npx ideiglenes mappájából fut, ezért a kliens beállításába nem írhatok tartós útvonalat.', {
    hint: 'Telepítsd a programot (npm install -g openszamla), és utána futtasd: openszamla config <kliens> --write (vagy openszamla setup).',
  });
}

function writeJsonClient(client: 'claude-desktop' | 'cursor' | 'vscode', ctx: ClientContext, force: boolean): WriteOutcome {
  const located = client === 'claude-desktop' ? claudeDesktopConfigPath(ctx) : { path: client === 'cursor' ? cursorConfigPath(ctx) : vscodeWorkspaceConfigPath(ctx) };
  // By their real paths: the working directory a process reports is a resolved one, the home folder may lead through a link.
  if (client === 'vscode' && samePath(realpathOr(ctx.cwd), realpathOr(homeDir(ctx)), ctx.platform)) {
    throw new AppError('INVALID_INPUT', `A VS Code-beállítást a munkaterület (projekt) mappájába írom (.vscode/mcp.json), de most a saját mappádban vagy (${ctx.cwd}).`, {
      hint: 'Lépj be a projekt mappájába (cd <mappa>), és ott futtasd: openszamla config vscode --write. Felhasználói szinten: VS Code → Parancspaletta → „MCP: Open User Configuration”, és másold be, amit az openszamla config vscode kiír.',
    });
  }
  const file = writeTarget(located.path);
  const key = client === 'vscode' ? 'servers' : 'mcpServers';
  const title = CLIENT_TITLES[client];
  const doc = readJsonConfig(file, client === 'vscode');
  const servers = doc.data[key];
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new AppError('CLIENT_CONFIG_INVALID', `A(z) ${file} fájlban a(z) „${key}” nem objektum – nem módosítottam.`, { hint: 'Javítsd a fájlt, és futtasd újra a parancsot.' });
  }
  const launch = serverLaunch(ctx);
  const entry: Record<string, unknown> = { ...(client === 'vscode' ? { type: 'stdio' } : {}), command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
  const list = (servers ?? {}) as Record<string, unknown>;
  const prev = Object.hasOwn(list, 'openszamla') ? list.openszamla : undefined;
  if (prev !== undefined && canonical(prev) === canonical(entry)) {
    return { client, status: 'unchanged', file, lines: [`${title}: már be van állítva, nem változtattam semmit – ${file}`] };
  }
  if (prev !== undefined && !force) {
    throw new AppError('CLIENT_ENTRY_EXISTS', `A(z) ${file} fájlban már van openszamla bejegyzés, más beállítással (${describeEntry(entryView(prev))}) – nem írtam felül.`, {
      hint: `Ha le akarod cserélni (a régiről biztonsági másolat készül): ${commandFor(`config ${client} --write --force`, ctx)}`,
    });
  }
  if (doc.jsonc) {
    // Rewriting would drop the comments (and VS Code's trailing commas): the file is left alone, the entry is shown.
    throw new AppError('CLIENT_CONFIG_HAS_COMMENTS', `A(z) ${file} megjegyzéseket vagy záró vesszőt tartalmaz (a VS Code megengedi), amelyeket az átírás elveszítene – nem módosítottam.`, {
      hint: `Add hozzá kézzel a „${key}” részhez (ha már van openszamla bejegyzés, azt cseréld le): "openszamla": ${JSON.stringify(entry)}`,
    });
  }
  const others = Object.keys(list).filter((k) => k !== 'openszamla');
  const next = { ...doc.data, [key]: { ...list, openszamla: entry } };
  const eol = doc.text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)"/m.exec(doc.text)?.[1] ?? '  ';
  const backup = doc.exists ? backupFile(file, ctx.now) : null;
  writeConfigFile(file, `${JSON.stringify(next, null, indent).replace(/\n/g, eol)}${eol}`);
  return {
    client,
    status: prev !== undefined ? 'replaced' : doc.exists ? 'added' : 'created',
    file,
    ...(backup ? { backup } : {}),
    lines: changeLines({
      client,
      title: `${title}${located.note ? ` (${located.note})` : ''}`,
      file,
      created: !doc.exists,
      backup,
      added: `"openszamla": ${JSON.stringify(entry, null, 2)}`.split('\n'),
      replaced: prev !== undefined ? describeEntry(entryView(prev)) : null,
      kept: others.length ? `A fájl többi része változatlan (további szerverek: ${others.join(', ')}).` : 'A fájl többi része változatlan.',
      ctx,
    }),
  };
}

const CODEX_MARKER = /^\s*#\s*OpenSzámla – openszamla config codex --write/;

function writeCodex(ctx: ClientContext, force: boolean): WriteOutcome {
  const file = writeTarget(codexConfigPath(ctx));
  const exists = existsSync(file);
  const raw = exists ? readText(file) : '';
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const r = readCodex(raw);
  const d = findTable(r.stmts, CODEX_TABLE);
  const launch = serverLaunch(ctx);
  if (d.closedParent) {
    throw new AppError('CLIENT_CONFIG_UNSUPPORTED', `A(z) ${file} ${d.closedParent.start + 1}. sora az mcp_servers táblát egy sorban (vagy tömbként) adja meg, ezért új [mcp_servers.openszamla] tábla nem adható hozzá – nem módosítottam.`, {
      hint: 'Írd át a fájlban az mcp_servers megadását [mcp_servers.<név>] táblákra, vagy másold be kézzel, amit az openszamla config codex kiír.',
    });
  }
  let replaced: string | null = null;
  let lines = r.lines;
  if (r.defined) {
    const sameHome = (r.entry.env?.OPENSZAMLA_HOME ?? null) === (launch.env?.OPENSZAMLA_HOME ?? null);
    if (!d.elsewhere.length && r.entry.command === launch.command && canonical(r.entry.args) === canonical(launch.args) && sameHome) {
      return { client: 'codex', status: 'unchanged', file, lines: [`${CLIENT_TITLES.codex}: már be van állítva, nem változtattam semmit – ${file}`] };
    }
    const where = [d.table, ...d.subtables, ...d.elsewhere].filter((s): s is TomlStatement => s !== null).map((s) => s.start + 1);
    const summary = `${describeEntry(r.entry)}; ${where.length > 1 ? `${where.join('., ')}. sor` : `${where[0]}. sor`}`;
    if (!force) {
      throw new AppError('CLIENT_ENTRY_EXISTS', `A(z) ${file} fájlban már van openszamla szerver, más beállítással (${summary}) – nem írtam felül.`, {
        hint: `Ha le akarod cserélni (a régiről biztonsági másolat készül): ${commandFor('config codex --write --force', ctx)}`,
      });
    }
    if (d.elsewhere.length) {
      throw new AppError('CLIENT_CONFIG_UNSUPPORTED', `A(z) ${file} fájlban az openszamla szerver nem [mcp_servers.openszamla] táblaként szerepel (${summary}), ezért nem tudom biztonságosan lecserélni – nem módosítottam.`, {
        hint: 'Töröld a fájlból a régi openszamla beállítást, és futtasd újra a parancsot (vagy másold be kézzel, amit az openszamla config codex kiír).',
      });
    }
    replaced = summary;
    lines = removeTable(lines, r.stmts, CODEX_TABLE, CODEX_MARKER);
  }
  while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines = lines.slice(0, -1);
  const block = [`# OpenSzámla – openszamla config codex --write, ${isoDate(ctx.now)}`, ...codexTomlLines(launch), 'startup_timeout_sec = 30', 'tool_timeout_sec = 300'];
  const backup = exists ? backupFile(file, ctx.now) : null;
  writeConfigFile(file, `${bom}${[...lines, ...(lines.length ? [''] : []), ...block].join(eol)}${eol}`);
  return {
    client: 'codex',
    status: replaced ? 'replaced' : exists ? 'added' : 'created',
    file,
    ...(backup ? { backup } : {}),
    lines: changeLines({
      client: 'codex',
      title: CLIENT_TITLES.codex,
      file,
      created: !exists,
      backup,
      added: block,
      replaced,
      kept: replaced ? 'A fájl többi része változatlan (a régi tábla és altáblái helyett az új a fájl végére került).' : 'A fájl többi része változatlan (az új tábla a fájl végére került).',
      ctx,
    }),
  };
}

function runClaude(claude: string, args: string[], ctx: ClientContext): { ok: boolean; output: string } {
  const r = spawnSync(claude, args, { encoding: 'utf8', env: ctx.env, cwd: ctx.cwd, timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { ok: !r.error && r.status === 0, output: r.error ? `${r.error.message}${output ? `\n${output}` : ''}` : output };
}

function writeClaudeCode(ctx: ClientContext, force: boolean): WriteOutcome {
  const launch = serverLaunch(ctx);
  const line = claudeAddLine(launch);
  const config = claudeCodeConfigPath(ctx);
  let prev: EntryView | null = null;
  const view = jsonView('claude-code', 'Claude Code', config, 'mcpServers');
  if (view.entry) prev = view.entry;
  const same =
    prev &&
    prev.command === launch.command &&
    canonical(prev.args ?? []) === canonical(launch.args) &&
    canonical(prev.env ?? {}) === canonical(launch.env ?? {});
  if (same) return { client: 'claude-code', status: 'unchanged', file: config, lines: [`${CLIENT_TITLES['claude-code']}: már be van állítva (felhasználói szint), nem változtattam semmit – ${config}`] };
  if (prev && !force) {
    throw new AppError('CLIENT_ENTRY_EXISTS', `A Claude Code felhasználói beállításaiban (${config}) már van openszamla szerver, más beállítással (${describeEntry(prev)}) – nem írtam felül.`, {
      hint: `Ha le akarod cserélni: ${commandFor('config claude-code --write --force', ctx)} (ez előbb a claude mcp remove --scope user openszamla parancsot futtatja).`,
    });
  }
  const claude = findOnPath('claude', ctx);
  if (!claude || !runsWithoutShell(claude, ctx.platform)) {
    const why = claude
      ? `A claude parancs (${claude}) csak parancsértelmezővel indítható, ezért nem futtatom.`
      : 'A claude parancs nincs a PATH-on (a Claude Code nincs telepítve, vagy ebben a terminálban nem érhető el).';
    return {
      client: 'claude-code',
      status: 'printed',
      lines: [
        `${CLIENT_TITLES['claude-code']}: ${why} Futtasd egy terminálban:`,
        ...(prev ? ['  claude mcp remove --scope user openszamla'] : []),
        `  ${line}`,
        `  ${nextStep('claude-code', ctx)}`,
      ],
    };
  }
  const out: string[] = [];
  if (prev) {
    const rm = runClaude(claude, ['mcp', 'remove', '--scope', 'user', 'openszamla'], ctx);
    if (!rm.ok) {
      throw new AppError('CLAUDE_COMMAND_FAILED', `A claude mcp remove --scope user openszamla nem sikerült: ${rm.output.slice(0, 500) || '(nincs kimenet)'}`, {
        hint: 'Futtasd kézzel a fenti parancsot, majd ezt újra.',
      });
    }
    out.push('  Futtattam: claude mcp remove --scope user openszamla', `  (a korábbi bejegyzés: ${describeEntry(prev)})`);
  }
  const add = runClaude(claude, claudeAddArgs(launch), ctx);
  if (!add.ok) {
    throw new AppError('CLAUDE_COMMAND_FAILED', `A claude mcp add nem sikerült: ${add.output.slice(0, 500) || '(nincs kimenet)'}`, {
      hint: `Futtasd kézzel egy terminálban: ${line}`,
    });
  }
  return {
    client: 'claude-code',
    status: 'ran',
    file: config,
    lines: [
      `${CLIENT_TITLES['claude-code']}: beállítottam (felhasználói szint, minden projektben).`,
      ...out,
      `  Futtattam (${claude}): ${line}`,
      ...add.output
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `  claude: ${l.trim()}`),
      '  Visszavonás: claude mcp remove --scope user openszamla',
      `  ${nextStep('claude-code', ctx)}`,
    ],
  };
}

/** Writes the server entry into `client`'s own configuration (openszamla config <client> --write). */
export function writeClientConfig(client: string, ctx: ClientContext, opts: { force: boolean }): WriteOutcome {
  if (client === 'http') {
    throw new AppError('INVALID_INPUT', 'A HTTP-kapcsolatot nem lehet beírni: a távoli kliensben (claude.ai, ChatGPT) kell megadni.', {
      hint: 'A lépéseket az openszamla config http írja ki (a --write nélkül).',
    });
  }
  if (!isClientId(client)) throw new AppError('INVALID_INPUT', `Ismeretlen kliens: ${client || '(üres)'}`, { hint: 'claude-desktop | claude-code | codex | cursor | vscode' });
  assertDurable();
  if (client === 'codex') return writeCodex(ctx, opts.force);
  if (client === 'claude-code') return writeClaudeCode(ctx, opts.force);
  return writeJsonClient(client, ctx, opts.force);
}

/**
 * The "openszamla" entry of the configuration `config <client> --write` writes: none, the same as it would write
 * (command, arguments, data directory), or a different one; 'none' when that cannot be told.
 */
export function entryState(client: ClientId, ctx: ClientContext): 'none' | 'same' | 'different' {
  let entry: EntryView | null | undefined;
  try {
    switch (client) {
      case 'claude-desktop':
        entry = jsonView(client, '', claudeDesktopConfigPath(ctx).path, 'mcpServers').entry;
        break;
      case 'claude-code':
        entry = jsonView(client, '', claudeCodeConfigPath(ctx), 'mcpServers').entry;
        break;
      case 'codex':
        entry = codexView(ctx).entry;
        break;
      case 'cursor':
        entry = jsonView(client, '', cursorConfigPath(ctx), 'mcpServers').entry;
        break;
      case 'vscode':
        entry = jsonView(client, '', vscodeWorkspaceConfigPath(ctx), 'servers').entry;
        break;
    }
  } catch {
    return 'none';
  }
  if (!entry) return 'none';
  const launch = serverLaunch(ctx);
  const same = entry.command === launch.command && canonical(entry.args ?? []) === canonical(launch.args) && (entry.env?.OPENSZAMLA_HOME ?? null) === (launch.env?.OPENSZAMLA_HOME ?? null);
  return same ? 'same' : 'different';
}

// ---------------------------------------------------------------------------------------------
// The agent skill
// ---------------------------------------------------------------------------------------------

export type SkillTarget = 'claude' | 'codex';

/** The skill shipped with this installation. */
export function bundledSkillDir(): string {
  return fileURLToPath(new URL('../../skills/magyar-szamlazas', import.meta.url));
}

/** Where Claude Code (~/.claude/skills) or Codex (~/.agents/skills) looks for the skill. */
export function skillDir(target: SkillTarget, home: string): string {
  return join(home, target === 'claude' ? '.claude' : '.agents', 'skills', 'magyar-szamlazas');
}

/** Copies the bundled agent skill to the user-level skill folder of Claude Code or Codex. */
export function installSkill(target: string, home: string = homedir()): string {
  const src = bundledSkillDir();
  if (!existsSync(join(src, 'SKILL.md'))) throw new AppError('NOT_FOUND', `Nem található a skill: ${src}`);
  if (target !== 'claude' && target !== 'codex') throw new AppError('INVALID_INPUT', `Ismeretlen cél: ${target || '(üres)'}`, { hint: 'openszamla install-skill claude | codex' });
  const dest = skillDir(target, home);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return dest;
}

/** The installed copy of the skill: missing, the same as this version's, or different. */
export function skillState(target: SkillTarget, home: string): 'missing' | 'current' | 'different' {
  const installed = join(skillDir(target, home), 'SKILL.md');
  if (!isFile(installed)) return 'missing';
  try {
    return readFileSync(installed).equals(readFileSync(join(bundledSkillDir(), 'SKILL.md'))) ? 'current' : 'different';
  } catch {
    return 'different';
  }
}
