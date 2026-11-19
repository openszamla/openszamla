/**
 * OpenSzámla command line.
 *
 *   openszamla                     a short welcome in a terminal (the help otherwise)
 *   openszamla setup               guided first set-up: runtime, data dir, seller, NAV, AI clients, skill
 *   openszamla doctor              check the installation and the settings, with a fix for each problem
 *   openszamla mcp                 MCP server on stdio (Claude Code, Claude Desktop, Codex)
 *   openszamla serve               MCP over Streamable HTTP + web UI
 *   openszamla init                set up the seller profile interactively (or with flags)
 *   openszamla nav-setup           store NAV technical-user credentials and test them
 *   openszamla nav-send-to-configured-environment <invoice> [--confirm]
 *                                  send an invoice of the other NAV system to the configured one (nav-send.ts)
 *   openszamla status              show setup status
 *   openszamla list | show | pdf   inspect invoices
 *   openszamla export              export a period (csv/json/xml)
 *   openszamla verify              check invoice hashes and the audit chain
 *   openszamla backup <file>       consistent copy of the database
 *   openszamla restore <file>      put a backup in the place of the database (restore.ts)
 *   openszamla config <client>     print ready-to-paste MCP config (claude-code, claude-desktop, codex, cursor, vscode, http);
 *                                  --write puts it into the client's own configuration (backup first, --force to replace)
 *   openszamla install-skill <t>   copy the agent skill to ~/.claude/skills (claude) or ~/.agents/skills (codex)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AppError, isAppError } from '../core/errors.ts';
import { formatMoney } from '../core/format.ts';
import { NAV_STATUS_NAME, invoiceStatusName } from '../core/names.ts';
import { startHttpServer } from '../mcp/http.ts';
import { runStdio } from '../mcp/stdio.ts';
import { OpenSzamla, REGENERATED_PDF_SUFFIX } from '../service/app.ts';
import { startNavAutoSync } from '../service/nav-auto.ts';
import {
  MIN_HTTP_TOKEN_LENGTH,
  defaultDataDir,
  ensureDataDir,
  envFlag,
  envValue,
  httpTokenProblem,
  isRelativeConfiguredPath,
  loadConfig,
  resolveConfiguredPath,
} from '../service/config.ts';
import { VERSION } from '../version.ts';
import { clientConfigText, installSkill, writeClientConfig, type ClientContext } from './clients.ts';
import { runDoctor } from './doctor.ts';
import { navSendToConfiguredEnvironment } from './nav-send.ts';
import { runRestore } from './restore.ts';
import { createPrompter } from './prompt.ts';
import {
  askNavAnswers,
  askSellerAnswers,
  navSetupIntro,
  runSetup,
  saveNavAnswers,
  saveSellerAnswers,
  welcomeText,
  writeSecretFile,
  type NavAnswers,
  type SellerAnswers,
} from './setup.ts';

const HELP = `OpenSzámla ${VERSION} – nyílt forráskódú magyar számlázó MCP szerverrel

Használat: openszamla <parancs> [kapcsolók]

Parancsok:
  setup                    első beállítás lépésenként: futtatókörnyezet, adatkönyvtár, eladó, NAV, AI-kliensek  [--client …] [--force]
  doctor                   a telepítés és a beállítások ellenőrzése, javítási tippekkel  [--nav]
  mcp                      MCP szerver stdio-n (Claude Code, Claude Desktop, Codex)
  serve                    MCP Streamable HTTP + webes felület  [--host 127.0.0.1] [--port 8787] [--token …]
  init                     eladói adatok beállítása (interaktív)
  nav-setup                NAV technikai felhasználó adatainak mentése és tesztelése [--env test|production]
  nav-send-to-configured-environment <sorszám|id> [--confirm]
                           a másik NAV-rendszerhez tartozó (pl. csak a TESZT rendszerbe jelentett) számla beküldése
                           a beállított rendszerbe; --confirm nélkül csak kiírja, mit jelentene
  status                   beállítások és állapot
  list                     számlák listája [--from ÉÉÉÉ-HH-NN] [--to …] [--limit 20]
  show <sorszám|id>        számla részletei
  pdf <sorszám|id>         a bizonylat PDF-je (kiállítottnál a megőrzött eredeti) [--out <mappa>]
  export                   export --from … --to … [--format csv|json|xml] [--date-basis issue|fulfillment|payment] [--ledger]
                           (az időszak a kelte – issue, alapértelmezés –, a teljesítés dátuma – fulfillment – vagy a befizetés
                           dátuma – payment – szerint; --ledger: az időszak befizetési naplója, csv vagy json)
  adohatosagi-export       adóhatósági ellenőrzési adatszolgáltatás: --from … --to … | --from-number … --to-number …
  verify                   számla-hash-ek, auditlánc, sorszámfolytonosság, megőrzött PDF-ek és adatbázis-védelmek ellenőrzése
  backup <fájl>            adatbázis mentése
  restore <fájl>           mentés visszaállítása az adatbázis helyére; --confirm nélkül csak kiírja, mi történne
                           (a jelenlegi adatbázist félreteszi, nem törli; előtte állítsd le a webes felületet és az AI-klienseket)
  config <kliens>          MCP konfiguráció kiírása: claude-code | claude-desktop | codex | vscode | cursor | http
                           [--write: beírás a kliens saját beállításába, biztonsági másolattal] [--force: meglévő bejegyzés cseréje]
  install-skill <cél>      a magyar-szamlazas skill telepítése: claude (~/.claude/skills) | codex (~/.agents/skills)

Közös kapcsolók:
  --data-dir <mappa>       adatkönyvtár (alapértelmezés: ~/.openszamla vagy OPENSZAMLA_HOME)
  -h, --help               súgó
  -v, --version            verzió
`;

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

function readTokenFile(dataDir: string): string | undefined {
  const f = join(dataDir, 'http-token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || undefined : undefined;
}

/** True when `token` is the one saved in <dataDir>/http-token (false without a readable file). */
function isSavedToken(dataDir: string, token: string): boolean {
  try {
    return readTokenFile(dataDir) === token;
  } catch {
    return false;
  }
}

/**
 * The token saved in <dataDir>/http-token. A new random token is saved only when there is no such file:
 * an existing one is never overwritten (every configured client would be locked out), not even when it
 * is empty or another serve created it in the meantime.
 */
async function savedHttpToken(dataDir: string): Promise<string> {
  const saved = readTokenFile(dataDir);
  if (saved) return saved;
  const file = join(dataDir, 'http-token');
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(24).toString('base64url');
  try {
    writeSecretFile(file, token, 'wx');
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const now = readTokenFile(dataDir);
  if (now) return now;
  throw new AppError('INVALID_CONFIG', `A hozzáférési token fájlja üres: ${file}`, {
    hint: 'Töröld a fájlt (indításkor a program új, véletlen tokent készít és ment), vagy írd bele a használni kívánt tokent; utána a klienseknél is az érvényes tokent add meg.',
  });
}

/** A port from --port or OPENSZAMLA_HTTP_PORT: an integer from 0 (any free port) to 65535. */
function parsePort(value: string, source: string): number {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (port >= 0 && port <= 65535) return port;
  throw new AppError('INVALID_INPUT', `Érvénytelen port (${source}): ${value}`, {
    hint: 'A port 0 és 65535 közötti egész szám (alapértelmezés: 8787; 0: a rendszer választ egy szabad portot).',
  });
}

/** An option value; empty or whitespace counts as not given, like an empty environment variable. */
function given(v: string | undefined): string | undefined {
  return v?.trim() || undefined;
}

const OPTIONS = {
  'data-dir': { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  token: { type: 'string' },
  env: { type: 'string' },
  confirm: { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  format: { type: 'string' },
  'date-basis': { type: 'string' },
  ledger: { type: 'boolean' },
  'from-number': { type: 'string' },
  'to-number': { type: 'string' },
  limit: { type: 'string' },
  out: { type: 'string' },
  write: { type: 'boolean' },
  force: { type: 'boolean' },
  client: { type: 'string' },
  nav: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type OptionName = keyof typeof OPTIONS;

/** What each command takes besides --data-dir, -h/--help and -v/--version: its own options and the number of arguments. */
const COMMANDS: Readonly<Record<string, { options: readonly OptionName[]; args: number }>> = {
  setup: { options: ['client', 'force'], args: 0 },
  doctor: { options: ['nav'], args: 0 },
  mcp: { options: [], args: 0 },
  serve: { options: ['host', 'port', 'token'], args: 0 },
  init: { options: [], args: 0 },
  'nav-setup': { options: ['env'], args: 0 },
  'nav-send-to-configured-environment': { options: ['confirm'], args: 1 },
  status: { options: [], args: 0 },
  list: { options: ['from', 'to', 'limit'], args: 0 },
  show: { options: [], args: 1 },
  pdf: { options: ['out'], args: 1 },
  export: { options: ['from', 'to', 'format', 'date-basis', 'ledger'], args: 0 },
  'adohatosagi-export': { options: ['from', 'to', 'from-number', 'to-number'], args: 0 },
  verify: { options: [], args: 0 },
  backup: { options: [], args: 1 },
  restore: { options: ['confirm'], args: 1 },
  config: { options: ['write', 'force'], args: 1 },
  'install-skill': { options: [], args: 1 },
};

/** The command's spec, or undefined for an unknown command (a plain lookup would also find e.g. "constructor"). */
function commandSpec(cmd: string | undefined): { options: readonly OptionName[]; args: number } | undefined {
  return cmd !== undefined && Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
}

/** Hint for an option error: the options of the command (if it is known) and the help. */
function optionsHint(cmd: string | undefined): string {
  const spec = commandSpec(cmd);
  if (!spec) return 'A parancsok és kapcsolóik: openszamla --help';
  return `A(z) ${cmd} parancs kapcsolói: ${[...spec.options, 'data-dir'].map((o) => `--${o}`).join(', ')} (súgó: openszamla --help).`;
}

/**
 * Parses the command line strictly: an unknown (e.g. misspelt) option, a missing value or a value given
 * to a switch is INVALID_INPUT naming the option as typed – dropped silently, `backup --datadir D` would
 * copy the default database instead of D. Node's own messages are English; the tokens of a lenient parse
 * tell which option it was.
 */
function parseCommandLine(argv: string[]): { values: Partial<Record<OptionName, string | boolean>>; positionals: string[] } {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw e;
    const { tokens, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false, tokens: true });
    const hint = optionsHint(positionals[0]);
    for (const t of tokens) {
      if (t.kind !== 'option') continue;
      if (!Object.hasOwn(OPTIONS, t.name)) throw new AppError('INVALID_INPUT', `Ismeretlen kapcsoló: ${t.rawName}`, { hint });
      const type = OPTIONS[t.name as OptionName].type;
      if (type === 'boolean' && t.value !== undefined) throw new AppError('INVALID_INPUT', `A(z) ${t.rawName} kapcsoló nem kap értéket.`, { hint });
      if (type === 'string' && (t.value === undefined || (!t.inlineValue && t.value.startsWith('-') && t.value.length > 1))) {
        throw new AppError('INVALID_INPUT', `A(z) ${t.rawName} kapcsoló után hiányzik az érték: ${t.rawName} <érték>`, {
          hint: `Kötőjellel kezdődő értéket egyenlőségjellel adj meg (${t.rawName}=-…). ${hint}`,
        });
      }
    }
    throw new AppError('INVALID_INPUT', 'Hibás kapcsoló a parancssorban.', { hint, cause: e });
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseCommandLine(argv);
  const cmd = positionals[0];
  if (values.version) {
    out(VERSION);
    return 0;
  }
  // `openszamla` alone in a terminal: where to start; piped or redirected: the help.
  if (!cmd && !values.help && process.stdin.isTTY && process.stdout.isTTY) {
    out(welcomeText());
    return 0;
  }
  if (!cmd || values.help || cmd === 'help') {
    out(HELP);
    return 0;
  }
  const spec = commandSpec(cmd);
  if (!spec) {
    // Before anything is opened: a mistyped command creates no data directory.
    err(`Ismeretlen parancs: ${cmd}\n`);
    out(HELP);
    return 1;
  }
  // An option or argument the command does not take would be ignored: refused instead.
  for (const name of Object.keys(values) as OptionName[]) {
    if (name === 'data-dir' || spec.options.includes(name)) continue;
    throw new AppError('INVALID_INPUT', `A(z) --${name} kapcsoló a(z) ${cmd} parancsnál nem használható.`, { hint: optionsHint(cmd) });
  }
  const extra = positionals[1 + spec.args];
  if (extra !== undefined) {
    throw new AppError('INVALID_INPUT', `Fölösleges argumentum: ${extra}`, {
      hint: `A(z) ${cmd} parancs ${spec.args ? 'egy argumentumot vár' : 'nem vár argumentumot'}; a szóközt tartalmazó értéket tedd idézőjelek közé. ${optionsHint(cmd)}`,
    });
  }
  const str = (k: OptionName): string | undefined => {
    const v = values[k];
    return typeof v === 'string' ? v : undefined;
  };
  // Empty counts as not given (3.2): `--data-dir ""` would otherwise mean the working directory.
  const dataDirArg = given(str('data-dir'));
  const dataDir = dataDirArg !== undefined ? resolveConfiguredPath(dataDirArg, '--data-dir') : defaultDataDir();
  /** Server modes: the data directory in use, and a warning when it depends on the working directory. */
  const reportDataDir = (): void => {
    err(`OpenSzámla ${VERSION} – adatkönyvtár: ${dataDir}`);
    const configured = [dataDirArg ?? process.env.OPENSZAMLA_HOME?.trim(), process.env.OPENSZAMLA_DB?.trim()];
    for (const p of configured) {
      if (!p || !isRelativeConfiguredPath(p)) continue;
      err(
        `Figyelem: relatív útvonal ("${p}"), a munkakönyvtárhoz (${process.cwd()}) képest értelmezve. Ha a kliens más ` +
          'mappából indítja a szervert, ott külön, üres adatbázis jön létre (saját sorszámozással) – adj meg abszolút útvonalat.',
      );
    }
  };

  /** Where the client configurations are: from this process's environment (USERPROFILE / HOME, APPDATA, …). */
  const clientContext = (): ClientContext => ({ env: process.env, platform: process.platform, cwd: process.cwd(), dataDir, now: new Date() });

  if (cmd === 'config') {
    if (values.write) {
      for (const line of writeClientConfig(positionals[1] ?? '', clientContext(), { force: values.force === true }).lines) out(line);
      return 0;
    }
    if (values.force) throw new AppError('INVALID_INPUT', 'A --force kapcsoló csak a --write kapcsolóval együtt használható.', { hint: optionsHint(cmd) });
    out(clientConfigText(positionals[1] ?? '', clientContext()));
    return 0;
  }

  if (cmd === 'install-skill') {
    out(`Skill telepítve: ${installSkill(positionals[1] ?? '')}`);
    return 0;
  }

  if (cmd === 'setup') {
    return runSetup({ ctx: clientContext(), clients: str('client'), force: values.force === true, input: process.stdin, output: process.stdout });
  }

  if (cmd === 'doctor') {
    return runDoctor({ ctx: clientContext(), nav: values.nav === true, out });
  }

  if (cmd === 'nav-setup') {
    ensureDataDir(dataDir);
    const prompt = createPrompter(process.stdin, process.stderr);
    let answers: NavAnswers;
    try {
      for (const line of navSetupIntro(dataDir)) err(line);
      answers = await askNavAnswers(prompt, str('env'));
    } finally {
      prompt.close();
    }
    return saveNavAnswers(dataDir, answers, err);
  }

  if (cmd === 'mcp') {
    reportDataDir(); // stderr: stdout carries JSON-RPC only; MCP clients keep stderr in their server log
    const app = OpenSzamla.open({ dataDir, actor: 'mcp' });
    // While the server runs, reports NAV has not settled yet are carried on in the background (nav-auto.ts).
    const auto = envFlag(process.env, 'OPENSZAMLA_NAV_AUTO_SYNC', true) ? startNavAutoSync(app) : null;
    try {
      await runStdio(app);
    } finally {
      auto?.stop();
    }
    return 0;
  }

  if (cmd === 'serve') {
    reportDataDir();
    // Empty values count as not set, as everywhere: an empty --token or OPENSZAMLA_HTTP_TOKEN would replace the
    // saved token, an empty host would listen on every network interface, an empty port on a random one.
    const tokenArg = given(str('token'));
    const custom = tokenArg ?? envValue(process.env, 'OPENSZAMLA_HTTP_TOKEN');
    const weakCustom = custom !== undefined ? httpTokenProblem(custom) : null;
    // The saved token given once more (e.g. OPENSZAMLA_HTTP_TOKEN exported from the http-token file for Codex,
    // docs/kliensek.md) counts as the saved token: a weak one is only warned about, as without the option.
    const savedAgain = weakCustom !== null && custom !== undefined && isSavedToken(dataDir, custom);
    if (weakCustom && !savedAgain) {
      throw new AppError('INVALID_INPUT', `A(z) ${tokenArg !== undefined ? '--token kapcsolóval' : 'OPENSZAMLA_HTTP_TOKEN változóban'} megadott hozzáférési token túl gyenge: ${weakCustom}.`, {
        hint: `Hagyd el, és a program a(z) ${join(dataDir, 'http-token')} fájlban lévő (ha nincs, újonnan készített, véletlen) tokent használja. Saját token legalább ${MIN_HTTP_TOKEN_LENGTH} karakter, csak angol betű, számjegy, „_” és „-”.`,
      });
    }
    const portArg = given(str('port'));
    const portEnv = envValue(process.env, 'OPENSZAMLA_HTTP_PORT');
    const port = portArg !== undefined ? parsePort(portArg, '--port') : portEnv !== undefined ? parsePort(portEnv, 'OPENSZAMLA_HTTP_PORT') : 8787;
    const host = given(str('host')) ?? envValue(process.env, 'OPENSZAMLA_HTTP_HOST') ?? '127.0.0.1';
    // Copying PDFs into server folders (invoice_pdf copyToDir) is off unless OPENSZAMLA_ALLOW_FILE_COPY turns it on.
    const app = OpenSzamla.open({ dataDir, actor: 'mcp', fileCopyDefault: false });
    const token = custom ?? (await savedHttpToken(dataDir));
    const allowedHosts = (envValue(process.env, 'OPENSZAMLA_ALLOWED_HOSTS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowedOrigins = (envValue(process.env, 'OPENSZAMLA_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // X-Forwarded-For only on request: without a reverse proxy that sets it, the client would choose its own address.
    const trustProxy = envFlag(process.env, 'OPENSZAMLA_TRUST_PROXY', false);
    const running = await startHttpServer(app, { host, port, token, allowedHosts, allowedOrigins, trustProxy });
    err(`OpenSzámla ${VERSION} fut.`);
    err(`  Webes felület: ${running.url}/?token=${encodeURIComponent(token)}`);
    err('  Nyisd meg ezt a címet a böngészőben. Amíg használod, ezt az ablakot hagyd nyitva; leállítás: Ctrl+C.');
    err('  AI-kliensek (MCP) ugyanitt csatlakozhatnak:');
    err(`  MCP végpont:   ${running.mcpUrl}   (Authorization: Bearer <token>)`);
    err(`  Token fájl:    ${join(dataDir, 'http-token')}`);
    // A weak saved token keeps working (no lock-out of the configured clients), but it is not hidden either.
    const weakSaved = custom === undefined || savedAgain ? httpTokenProblem(token) : null;
    if (weakSaved) {
      err(
        `FIGYELEM: a(z) ${join(dataDir, 'http-token')} fájlban lévő hozzáférési token gyenge: ${weakSaved}. Az MCP végponton és a ` +
          'webes felületen ez teljes hozzáférést ad (kiállítás, sztornó). Cseréld le: töröld a fájlt, és indítsd újra a szervert ' +
          '(a program új, véletlen tokent készít), majd a klienseknél is az újat add meg.',
      );
    }
    if (trustProxy) err('  Kliens címe a /mcp korlátjához: a saját gépről érkező kapcsolatnál az X-Forwarded-For fejléc utolsó eleme (OPENSZAMLA_TRUST_PROXY)');
    // While the server runs, reports NAV has not settled yet are carried on in the background (nav-auto.ts).
    const auto = envFlag(process.env, 'OPENSZAMLA_NAV_AUTO_SYNC', true) ? startNavAutoSync(app) : null;
    err(`  Automatikus NAV-szinkron (a megkezdett beküldések befejezése, 5 percenként): ${auto ? 'bekapcsolva' : 'kikapcsolva (OPENSZAMLA_NAV_AUTO_SYNC=0)'}`);
    // The last line of the start-up text: whether an AI client may have PDFs copied into this machine's folders.
    err(`  Haladó beállítás – PDF másolása mappába (AI-kliens kérésére): ${app.config.allowFileCopy ? 'engedélyezve' : 'kikapcsolva (OPENSZAMLA_ALLOW_FILE_COPY=1 engedélyezi)'}`);
    const stop = (): void => {
      auto?.stop();
      void running.close().finally(() => {
        app.close();
        process.exit(0);
      });
    };
    // Ctrl+C, a stop request, and a closed terminal window (SIGHUP; on Windows also Ctrl+Break): the database is
    // closed, so its write-ahead log is folded in and no log file stays beside it.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.once(signal, stop);
    await new Promise(() => undefined);
    return 0;
  }

  if (cmd === 'restore') {
    // Before the database is opened: the restore replaces the file, and refuses while anything has it open.
    const file = positionals[1];
    if (!file) throw new AppError('INVALID_INPUT', 'Add meg a visszaállítandó mentésfájlt.', { hint: 'openszamla restore <mentésfájl> [--confirm]' });
    return runRestore({ dbPath: loadConfig({ dataDir }).dbPath, backupPath: resolve(file), confirm: values.confirm === true, dataDir }, out);
  }

  const app = OpenSzamla.open({ dataDir, actor: 'cli' });
  try {
    switch (cmd) {
      case 'nav-send-to-configured-environment': {
        const id = positionals[1];
        if (!id) throw new AppError('INVALID_INPUT', 'Add meg a számla sorszámát vagy azonosítóját.');
        return await navSendToConfiguredEnvironment(app, id, { confirm: values.confirm === true, dataDir }, out);
      }
      case 'status': {
        const s = app.status();
        out(`OpenSzámla ${s.version}`);
        out(`Adatkönyvtár: ${s.dataDir}`);
        out(`Eladó: ${s.seller ? `${s.seller.name} (${s.seller.taxNumber})` : 'NINCS BEÁLLÍTVA'}`);
        out(`NAV: ${s.nav.configured ? `${s.nav.environment} (${s.nav.source})` : s.nav.problem ? `HIBÁS BEÁLLÍTÁS (${s.nav.environment}, ${s.nav.source}) – ${s.nav.problem}` : 'nincs beállítva'}`);
        out(`Számlák: ${s.counts.issued} kiállított, ${s.counts.drafts} piszkozat, ${s.counts.unpaid} kifizetetlen, NAV függő: ${s.counts.navPending}, NAV hiba: ${s.counts.navProblems}`);
        for (const n of s.nextSteps) out(`  → ${n}`);
        // The steps name the tools of an AI client; the same from a terminal or the web UI.
        if (s.nextSteps.length > 0) out('  (A zárójeles nevek – pl. seller_update, nav_sync – az AI-kliens eszközei. Parancssorban: openszamla init – eladó; openszamla nav-setup – NAV; a NAV-szinkron és a többi művelet a webes felületen is elérhető: openszamla serve.)');
        for (const n of s.notes) out(`  Megjegyzés: ${n}`);
        return 0;
      }
      case 'init': {
        const prompt = createPrompter(process.stdin, process.stderr);
        let answers: SellerAnswers;
        try {
          answers = await askSellerAnswers(prompt, app.getSeller());
        } finally {
          prompt.close();
        }
        for (const line of saveSellerAnswers(app, answers)) out(line);
        return 0;
      }
      case 'list': {
        const page = app.findInvoices({
          ...(str('from') ? { issueDateFrom: str('from') } : {}),
          ...(str('to') ? { issueDateTo: str('to') } : {}),
          limit: Number(str('limit') ?? 20),
        });
        for (const i of page.items) {
          // In words, as the web UI and the CSV export name them – not the internal codes.
          out(`${(i.number ?? i.id).padEnd(18)} ${i.issueDate}  ${invoiceStatusName(i).padEnd(11)} ${i.customer.name.slice(0, 32).padEnd(32)} ${formatMoney(i.totals.grossAmount, i.currency).padStart(16)}  NAV: ${NAV_STATUS_NAME[i.navStatus]}`);
        }
        out(`(${page.items.length}/${page.total})`);
        return 0;
      }
      case 'show': {
        const id = positionals[1];
        if (!id) throw new AppError('INVALID_INPUT', 'Add meg a számla sorszámát vagy azonosítóját.');
        out(JSON.stringify(app.viewInvoice(id), null, 2));
        return 0;
      }
      case 'pdf': {
        const id = positionals[1];
        if (!id) throw new AppError('INVALID_INPUT', 'Add meg a számla sorszámát vagy azonosítóját.');
        const outDir = str('out');
        const r = await app.pdf(id, outDir ? { copyToDir: resolve(outDir) } : {});
        out(r.copiedTo ?? r.path);
        out(r.note);
        if (r.sha256) out(`SHA-256: ${r.sha256}`);
        return 0;
      }
      case 'export': {
        const from = str('from');
        const to = str('to');
        if (!from || !to) throw new AppError('INVALID_INPUT', 'Add meg: --from ÉÉÉÉ-HH-NN --to ÉÉÉÉ-HH-NN');
        const format = (str('format') ?? 'csv') as 'csv' | 'json' | 'xml';
        // The service checks the value (issue | fulfillment | payment).
        const dateBasis = str('date-basis') as 'issue' | 'fulfillment' | 'payment' | undefined;
        const r = app.exportInvoices({ from, to, format, ...(dateBasis ? { dateBasis } : {}), ...(values.ledger === true ? { ledger: true } : {}) });
        const basis = r.dateBasis === 'fulfillment' ? 'teljesítés dátuma' : r.dateBasis === 'payment' ? 'befizetés dátuma' : 'kelte';
        out(r.ledger ? `${r.count} befizetés (befizetési napló, a befizetés dátuma szerint) → ${r.path}` : `${r.count} számla (${basis} szerint) → ${r.path}`);
        for (const w of r.warnings) out(`  megjegyzés – ${w.invoiceNumber} (${w.field}): ${w.message}`);
        for (const n of r.notes) out(`  figyelem – ${n}`);
        return 0;
      }
      case 'adohatosagi-export': {
        const from = str('from');
        const to = str('to');
        const fromNumber = str('from-number');
        const toNumber = str('to-number');
        if (!(from && to) && !(fromNumber && toNumber)) {
          throw new AppError('INVALID_INPUT', 'Add meg: --from ÉÉÉÉ-HH-NN --to ÉÉÉÉ-HH-NN, vagy --from-number <sorszám> --to-number <sorszám>');
        }
        const r = await app.taxAuditExport(fromNumber && toNumber ? { fromNumber, toNumber } : { from: from as string, to: to as string });
        out(`Adóhatósági ellenőrzési adatszolgáltatás: ${r.count} számla → ${r.path}`);
        for (const w of r.warnings) out(`  megjegyzés – ${w.invoiceNumber} (${w.field}): ${w.message}`);
        return 0;
      }
      case 'verify': {
        const r = app.verifyIntegrity();
        out(`Adatbázis: ${app.config.dbPath}`);
        out(`Ellenőrzött számlák: ${r.invoicesChecked}, eltérés: ${r.invoiceMismatches.length ? r.invoiceMismatches.join(', ') : 'nincs'}`);
        out(`Auditnapló: ${r.audit.ok ? 'rendben' : `SÉRÜLT (id ${r.audit.brokenAtId})`} (${r.audit.entries} bejegyzés)`);
        out(`Megőrzött eredeti PDF-ek: ${r.documentsChecked}`);
        const problems: Array<[string, string[]]> = [
          ['A naplóval ellentmondó bizonylatok', r.auditMismatches],
          ['Naplózatlan (a programon kívül felvett) bizonylatok', r.unauditedInvoices],
          ['Sorszámhézagok', r.numberingGaps],
          ['Hiányzó vagy módosított adatbázis-védelmek (triggerek)', r.alteredTriggers],
          ['A befizetési naplóval ellentmondó befizetett összegek', r.paymentMismatches],
          ['A megőrzött eredeti PDF-ekkel ellentmondó adatok', r.documentMismatches],
        ];
        for (const [title, list] of problems) out(`${title}: ${list.length ? `\n  ${list.join('\n  ')}` : 'nincs'}`);
        // Neither changes the result: nothing was altered.
        for (const w of r.documentWarnings) out(`Figyelmeztetés: ${w}`);
        for (const w of r.restoreWarnings) out(`Figyelmeztetés: ${w}`);
        for (const n of r.documentNotes) out(`Megjegyzés: ${n}`);
        if (r.legacyDocuments > 0) {
          out(`Megjegyzés: ${r.legacyDocuments} bizonylat az eredeti PDF-ek megőrzése előtt készült; ezek PDF-jét kérésre a program újra előállítja (${REGENERATED_PDF_SUFFIX}.pdf végű fájl), ez nem az eredeti.`);
        }
        // Kept with the backups, the last entry shows whether entries were later cut off the end of the log.
        if (r.audit.head) out(`Az auditnapló utolsó bejegyzése: #${r.audit.head.id} ${r.audit.head.hash} – őrizd meg a mentéssel együtt.`);
        out(r.ok ? 'Eredmény: rendben.' : 'Eredmény: ELTÉRÉST TALÁLT – az adatbázist a programon kívül módosíthatták.');
        return r.ok ? 0 : 2;
      }
      case 'backup': {
        const dest = positionals[1];
        if (!dest) throw new AppError('INVALID_INPUT', 'Add meg a mentés fájlnevét.');
        app.store.backup(resolve(dest));
        out(`Mentve: ${app.config.dbPath} → ${resolve(dest)}`);
        return 0;
      }
      default:
        err(`Ismeretlen parancs: ${cmd}\n`);
        out(HELP);
        return 1;
    }
  } finally {
    app.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (e: unknown) => {
    if (isAppError(e)) {
      err(`Hiba [${e.code}]: ${e.message}`);
      if (e.hint) err(`Tipp: ${e.hint}`);
    } else {
      err(`Hiba: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    process.exitCode = 1;
  },
);

