/**
 * `openszamla setup` – one guided run of the first set-up – and the seller and NAV steps it shares with
 * `openszamla init` and `openszamla nav-setup`.
 *
 * Steps: the runtime, the data directory, the seller, NAV (test environment first, production explained), the AI
 * clients (with the skill where it applies), then what to do next. Every step can be skipped, and the command can be
 * run again: what is done already is only checked. When the input is not a terminal it never waits for input: the
 * clients come from --client, and for the seller and NAV – which need typing, NAV secrets are never options – it
 * prints the command to run. Secrets are asked without echo and never printed.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, isAppError } from '../core/errors.ts';
import type { SellerProfile } from '../core/types.ts';
import { navCredentialProblems } from '../nav/api-xml.ts';
import { NavClient } from '../nav/client.ts';
import type { NavEnvironment } from '../nav/types.ts';
import { OpenSzamla } from '../service/app.ts';
import { ensureDataDir, NAV_CREDENTIALS_FILE, navEnvironment, navSetupCommand, navSetupCommandLine } from '../service/config.ts';
import { VERSION } from '../version.ts';
import {
  CLIENT_TITLES,
  clientPresence,
  commandFor,
  entryState,
  envGet,
  homeDir,
  installSkill,
  isClientId,
  skillDir,
  skillState,
  vscodeWorkspaceConfigPath,
  WRITABLE_CLIENTS,
  writeClientConfig,
  type ClientContext,
  type ClientId,
  type WriteOutcome,
} from './clients.ts';
import { dataDirRisk, dataDirRiskText, navGuideUrl, POWERSHELL_HINT, runtimeText } from './doctor.ts';
import { createPrompter, type Prompter } from './prompt.ts';

/** `flag: 'wx'` creates the file only if it does not exist yet (EEXIST otherwise). */
export function writeSecretFile(path: string, content: string, flag: 'w' | 'wx' = 'w'): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: POSIX modes are not supported; the file lives in the user's profile.
  }
}

// ---------------------------------------------------------------------------------------------
// Seller (openszamla init)
// ---------------------------------------------------------------------------------------------

export interface SellerAnswers {
  name: string;
  taxNumber: string;
  postalCode: string;
  city: string;
  addressLine: string;
  bankAccount: string;
  aam: boolean;
  email: string;
}

/** The questions of `openszamla init`; the defaults are the saved seller's data, or the answers of a failed attempt. */
export async function askSellerAnswers(prompt: Prompter, prev: SellerProfile | null, last?: SellerAnswers): Promise<SellerAnswers> {
  return {
    name: await prompt.ask('Cégnév / egyéni vállalkozó neve', last?.name ?? prev?.name),
    taxNumber: await prompt.ask('Adószám (12345676-1-23)', last?.taxNumber ?? prev?.taxNumber),
    postalCode: await prompt.ask('Irányítószám', last?.postalCode ?? prev?.address.postalCode),
    city: await prompt.ask('Település', last?.city ?? prev?.address.city),
    addressLine: await prompt.ask('Utca, házszám', last?.addressLine ?? prev?.address.addressLine),
    bankAccount: await prompt.ask('Bankszámlaszám (üresen hagyható)', last?.bankAccount ?? prev?.bankAccount),
    aam: (await prompt.ask('Alanyi adómentes vagy? (i/n)', (last ? last.aam : prev?.vatStatus === 'aam') ? 'i' : 'n')).toLowerCase().startsWith('i'),
    email: await prompt.ask('E-mail (üresen hagyható)', last?.email ?? prev?.email),
  };
}

/** Saves the answers as `openszamla init` does (country HU); the lines to print. */
export function saveSellerAnswers(app: OpenSzamla, a: SellerAnswers): string[] {
  const r = app.updateSeller({
    name: a.name,
    taxNumber: a.taxNumber,
    address: { countryCode: 'HU', postalCode: a.postalCode, city: a.city, addressLine: a.addressLine },
    bankAccount: a.bankAccount || null,
    email: a.email || null,
    vatStatus: a.aam ? 'aam' : 'normal',
  });
  return [`Mentve: ${r.seller.name} (${r.seller.taxNumber})`, ...r.issues.map((i) => `  [${i.severity}] ${i.message}`)];
}

// ---------------------------------------------------------------------------------------------
// NAV technical user (openszamla nav-setup)
// ---------------------------------------------------------------------------------------------

export interface NavAnswers {
  environment: NavEnvironment;
  login: string;
  password: string;
  signingKey: string;
  exchangeKey: string;
}

/** NAV's own pages: where the technical user and its keys are created, and NAV's guide to it. */
export const NAV_PORTALS = {
  test: 'https://onlineszamla-test.nav.gov.hu',
  production: 'https://onlineszamla.nav.gov.hu',
  guide: 'https://onlineszamla.nav.gov.hu/dokumentaciok',
} as const;

/** What nav-setup prints before its questions. */
export function navSetupIntro(dataDir: string): string[] {
  return [
    `NAV technikai felhasználó adatai. Létrehozásuk: az Online Számla oldalán (teszt: ${NAV_PORTALS.test}, éles: ${NAV_PORTALS.production}) a NAV Felhasználókezelőben technikai felhasználó, majd kulcsgenerálás; a NAV útmutatója: ${NAV_PORTALS.guide} (Online Számla felhasználói kézikönyv).`,
    `Az adatok a gépeden maradnak: ${join(dataDir, NAV_CREDENTIALS_FILE)}`,
  ];
}

/** The questions of `openszamla nav-setup`: the environment (checked before the secrets are asked for), then the four values; secrets without echo. */
export async function askNavAnswers(prompt: Prompter, envOption: string | undefined): Promise<NavAnswers> {
  const environment = navEnvironment(envOption ?? (await prompt.ask('Környezet (test / production)', 'test')));
  const login = await prompt.ask('Felhasználónév (login)');
  const password = await prompt.askSecret('Jelszó');
  const signingKey = await prompt.askSecret('XML aláírókulcs');
  const exchangeKey = await prompt.askSecret('XML cserekulcs');
  return { environment, login, password, signingKey, exchangeKey };
}

/** Checked before saving: a wrong value would otherwise surface only when the first invoice is reported. */
export function checkNavAnswers(a: NavAnswers): void {
  if (!a.login || !a.password || !a.signingKey || !a.exchangeKey) throw new AppError('INVALID_INPUT', 'Minden mező kitöltése kötelező.');
  const problems = navCredentialProblems(a, { taxNumber: false });
  if (problems.length) {
    throw new AppError('INVALID_INPUT', `A megadott NAV adatok hibásak, nem mentettem el őket: ${problems.join('; ')}.`, {
      hint: 'A technikai felhasználó login neve 6–15 betű vagy szám, az XML cserekulcs pontosan 16 karakter – másold be őket pontosan a NAV felületéről (Online Számla → NAV Felhasználókezelő → technikai felhasználó).',
    });
  }
}

/**
 * Checks and saves the answers as `openszamla nav-setup` does (nav-credentials.json, 0600), then tests the connection
 * when the seller's tax number is known. Returns the exit code: 1 when saved but the effective settings cannot be used.
 */
export async function saveNavAnswers(dataDir: string, a: NavAnswers, err: (s: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  checkNavAnswers(a);
  const { environment, login, password, signingKey, exchangeKey } = a;
  writeSecretFile(join(dataDir, NAV_CREDENTIALS_FILE), JSON.stringify({ environment, login, password, signingKey, exchangeKey }, null, 2));
  const app = OpenSzamla.open({ dataDir, env, actor: 'cli' });
  try {
    const effective = app.config.nav;
    if (effective && (effective.source === 'env' || effective.environment !== environment)) {
      err(
        `Figyelem: a környezeti változók (OPENSZAMLA_NAV_*) felülírják a most mentett beállítást – a program ` +
          `${effective.source === 'env' ? 'a változókban megadott technikai felhasználót és ' : ''}a(z) ${effective.environment} környezetet használja.`,
      );
    }
    if (app.config.navProblem) {
      err(`Mentve, de a NAV-kapcsolat így sem használható: ${app.config.navProblem}`);
      return 1;
    }
    const seller = app.getSeller();
    if (!seller) {
      err('Mentve. Az eladói adatok (adószám) még hiányoznak, ezért a kapcsolatot most nem tudom tesztelni: openszamla init');
      return 0;
    }
    const nav = app.config.nav;
    if (!nav) return 0;
    const client = new NavClient({
      environment: nav.environment,
      credentials: { ...nav.credentials, taxNumber: seller.taxNumber.slice(0, 8) },
      software: app.config.software,
      ...(nav.baseUrl ? { baseUrl: nav.baseUrl } : {}),
    });
    await client.tokenExchange();
    err(`Mentve, és a NAV ${nav.environment === 'production' ? 'ÉLES' : 'TESZT'} kapcsolat működik (tokenExchange OK).`);
    return 0;
  } finally {
    app.close();
  }
}

// ---------------------------------------------------------------------------------------------
// openszamla (no command) and openszamla setup
// ---------------------------------------------------------------------------------------------

/** What `openszamla` alone prints in a terminal. */
export function welcomeText(): string {
  return [
    `OpenSzámla ${VERSION} – nyílt forráskódú magyar számlázó MCP szerverrel`,
    '',
    'Első használathoz futtasd:  openszamla setup',
    '  (végigvezet a beállításon: adatkönyvtár, eladói adatok, NAV-kapcsolat, AI-kliensek)',
    'Ellenőrzés, hibakeresés:    openszamla doctor',
    'Webes felület:              openszamla serve',
    'Minden parancs:             openszamla --help',
    `Dokumentáció: https://github.com/openszamla/openszamla/blob/v${VERSION}/docs/felhasznaloi-dokumentacio.md`,
  ].join('\n');
}

export interface SetupOptions {
  ctx: ClientContext;
  /** --client: the clients to connect without asking (comma-separated). */
  clients?: string | undefined;
  /** --force: replace an existing "openszamla" entry. */
  force: boolean;
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}

/** The --client list; INVALID_INPUT for an unknown name. */
export function parseClientList(value: string): ClientId[] {
  const names = value
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !isClientId(n));
  if (unknown.length || !names.length) {
    throw new AppError('INVALID_INPUT', `Ismeretlen kliens a --client kapcsolóban: ${unknown.join(', ') || '(üres)'}`, {
      hint: `Lehetséges értékek (vesszővel elválasztva): ${WRITABLE_CLIENTS.join(', ')}`,
    });
  }
  return [...new Set(names as ClientId[])];
}

/** The answer to a numbered choice ("1,3"; "0": none); null when it is not one. */
function parseChoice(answer: string, max: number): number[] | null {
  const t = answer.trim();
  if (t === '0' || t === '-') return [];
  const nums = t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1 || n > max)) return null;
  return [...new Set(nums)];
}

async function yesNo(prompt: Prompter, question: string, dflt: boolean): Promise<boolean> {
  for (;;) {
    const a = (await prompt.ask(`${question} (i/n)`, dflt ? 'i' : 'n')).trim().toLowerCase();
    if (/^(i|igen|y|yes)$/.test(a)) return true;
    if (/^(n|nem|no)$/.test(a)) return false;
  }
}

type StepState = 'kész' | 'kihagyva' | 'teendő' | 'hiba';

export async function runSetup(o: SetupOptions): Promise<number> {
  const { ctx } = o;
  const interactive = o.input.isTTY === true;
  // Checked before anything happens: a misspelt client name changes nothing.
  const chosen = o.clients !== undefined ? parseClientList(o.clients) : null;
  const say = (s = ''): void => {
    o.output.write(`${s}\n`);
  };
  const report = (e: unknown, indent = '  '): void => {
    if (!isAppError(e)) throw e;
    say(`${indent}HIBA – ${e.message}`);
    if (e.hint) say(`${indent}Tipp: ${e.hint}`);
  };
  const states: Array<[string, StepState]> = [];
  const todo: string[] = [];

  say(`OpenSzámla ${VERSION} – első beállítás`);
  say(
    interactive
      ? 'Végigmegyünk a beállításon. Minden lépés kihagyható, és a parancs később újra futtatható (openszamla setup): ami már kész, azt csak ellenőrzi. Kilépés: Ctrl+C.'
      : 'A bemenet nem terminál, ezért semmit nem kérdezek: az AI-klienseket a --client kapcsoló adja meg, az eladói és a NAV-adatokhoz kiírom a futtatandó parancsot.',
  );
  // Git Bash (mintty) gives programs pipes instead of a console.
  if (!interactive && ctx.platform === 'win32' && envGet(ctx.env, 'MSYSTEM', ctx.platform)) {
    say('Git Bash-ben a programok nem kapnak terminált: a kérdésekhez futtasd így: winpty openszamla setup – vagy PowerShellben / a Terminálban.');
  }

  say();
  say('[1/5] Futtatókörnyezet');
  const runtime = runtimeText();
  say(`  ${runtime.ok ? 'rendben' : 'HIBA'} – ${runtime.text}`);
  if (!runtime.ok) {
    say('  Tipp: telepítsd a Node.js LTS-változatát (https://nodejs.org, Windowson: winget install OpenJS.NodeJS.LTS), majd nyiss új terminált.');
    return 1;
  }
  states.push(['Futtatókörnyezet', 'kész']);

  say();
  say('[2/5] Adatkönyvtár (itt tárolja a program a számlákat és a beállításokat)');
  const existed = existsSync(ctx.dataDir);
  ensureDataDir(ctx.dataDir);
  const app = OpenSzamla.open({ dataDir: ctx.dataDir, env: ctx.env, actor: 'cli' });
  const prompt = interactive ? createPrompter(o.input, o.output) : null;
  try {
    const status = app.status();
    say(`  ${existed ? 'megvan' : 'létrehoztam'}: ${ctx.dataDir}`);
    say(`  Adatbázis: ${status.dbPath} (${status.counts.issued} kiállított bizonylat, ${status.counts.drafts} piszkozat).`);
    say('  Ugyanitt lesznek a PDF-ek (pdf/), az exportok (export/) és a NAV-beállítás (nav-credentials.json). Mentés: openszamla backup <fájl>.');
    say(`  Másik mappához futtasd így: openszamla setup --data-dir "<mappa>" – az AI-kliensek beállításába is az kerül.`);
    const risk = dataDirRisk(ctx.dataDir, ctx);
    if (risk) {
      const { text, fix } = dataDirRiskText(risk);
      say(`  FIGYELEM – ${text}`);
      say(`  Tipp: ${fix}`);
    }
    states.push(['Adatkönyvtár', 'kész']);

    // ---- 3. seller
    say();
    say('[3/5] Eladói adatok (a saját vállalkozásod adatai – minden számlára rákerülnek)');
    const seller = app.getSeller();
    say(seller ? `  megvan: ${seller.name} (${seller.taxNumber})` : '  még nincsenek megadva.');
    const sellerTodo = `${commandFor('init', ctx)} – vagy kérd meg rá az AI-t („Állítsd be a cégem adatait: …”), vagy add meg a webes felület Beállítások oldalán`;
    if (!prompt) {
      if (seller) states.push(['Eladói adatok', 'kész']);
      else {
        say(`  teendő – add meg egy terminálban: ${sellerTodo}`);
        todo.push(`Eladói adatok: ${sellerTodo}`);
        states.push(['Eladói adatok', 'teendő']);
      }
    } else if (await yesNo(prompt, seller ? '  Módosítod?' : '  Megadod most?', !seller)) {
      say('  (Enterrel a [szögletes zárójelben] álló érték marad.)');
      let last: SellerAnswers | undefined;
      for (;;) {
        const answers = await askSellerAnswers(prompt, seller, last);
        try {
          for (const l of saveSellerAnswers(app, answers)) say(`  ${l}`);
          states.push(['Eladói adatok', 'kész']);
          break;
        } catch (e) {
          report(e);
          last = answers;
          if (!(await yesNo(prompt, '  Újra megpróbálod?', true))) {
            todo.push(`Eladói adatok: ${sellerTodo}`);
            states.push(['Eladói adatok', 'hiba']);
            break;
          }
        }
      }
    } else if (seller) states.push(['Eladói adatok', 'kész']);
    else {
      say(`  kihagyva – később: ${sellerTodo}`);
      todo.push(`Eladói adatok: ${sellerTodo}`);
      states.push(['Eladói adatok', 'kihagyva']);
    }

    // ---- 4. NAV
    say();
    say('[4/5] NAV Online Számla');
    for (const l of [
      'A kiállított számlákról azonnal adatot kell szolgáltatni a NAV-nak; ezt a program a NAV „technikai felhasználójával” magától elvégzi.',
      'Két külön NAV-rendszer van, mindkettőhöz külön regisztráció és külön technikai felhasználó tartozik:',
      `  • TESZT (test): a NAV próbarendszere – az ide küldött számla nem valódi adatszolgáltatás, nyugodtan kipróbálhatod. ${NAV_PORTALS.test}`,
      `  • ÉLES (production): a valódi adatszolgáltatás – éles számlázáshoz ez kell. ${NAV_PORTALS.production}`,
      `Kezdd a TESZT rendszerrel; élesre később, az éles technikai felhasználó adataival állsz át (${navSetupCommandLine(ctx.dataDir, 'production')}).`,
      `A technikai felhasználót és a két XML-kulcsot (aláírókulcs, cserekulcs) az Online Számla oldalán, a NAV Felhasználókezelőben hozod létre – lépésről lépésre: a NAV útmutatója (${NAV_PORTALS.guide}, Online Számla felhasználói kézikönyv) és az OpenSzámla leírása (${navGuideUrl()}).`,
      `Az adatok a gépeden maradnak: ${join(ctx.dataDir, NAV_CREDENTIALS_FILE)}`,
    ]) {
      say(`  ${l}`);
    }
    const navTodo = navSetupCommand(ctx.dataDir);
    let nav = app.status().nav;
    const navState = (): string =>
      nav.configured
        ? `beállítva: ${nav.environment === 'production' ? 'ÉLES' : 'TESZT'} környezet (${nav.source === 'env' ? 'környezeti változókból' : NAV_CREDENTIALS_FILE})`
        : nav.problem
          ? `HIBÁS BEÁLLÍTÁS: ${nav.problem}`
          : 'még nincs beállítva';
    say(`  Állapot: ${navState()}`);
    if (nav.source === 'env') {
      say('  A NAV-adatokat környezeti változók (OPENSZAMLA_NAV_*) adják – itt nincs teendő.');
      states.push(['NAV', nav.configured ? 'kész' : 'teendő']);
    } else if (!prompt) {
      if (nav.configured) states.push(['NAV', 'kész']);
      else {
        say(`  teendő – amikor megvannak a technikai felhasználó adatai, egy terminálban: ${navTodo}`);
        todo.push(`NAV: ${navTodo}`);
        states.push(['NAV', 'teendő']);
      }
    } else {
      const question = nav.configured ? '  Újra megadod a technikai felhasználó adatait?' : nav.problem ? '  Most javítod (újra megadod az adatokat)?' : '  Megvannak a technikai felhasználó adatai? Megadod most?';
      if (await yesNo(prompt, question, Boolean(nav.problem))) {
        let saved = false;
        for (;;) {
          const answers = await askNavAnswers(prompt, undefined);
          try {
            checkNavAnswers(answers);
          } catch (e) {
            report(e);
            if (await yesNo(prompt, '  Újra megpróbálod?', true)) continue;
            break;
          }
          try {
            const code = await saveNavAnswers(ctx.dataDir, answers, (s) => say(`  ${s}`), ctx.env);
            saved = code === 0;
          } catch (e) {
            // Saved already (checkNavAnswers passed): the connection test failed.
            report(e);
            say(`  Az adatokat elmentettem, de a NAV nem fogadta el őket. Ellenőrizd, hogy a ${answers.environment === 'production' ? 'ÉLES' : 'TESZT'} rendszer technikai felhasználójáé-e mind a négy adat, és add meg újra: ${navTodo}`);
          }
          break;
        }
        nav = app.status().nav;
        if (saved && nav.configured) states.push(['NAV', 'kész']);
        else {
          todo.push(`NAV: ${navTodo}`);
          states.push(['NAV', 'hiba']);
        }
      } else if (nav.configured) states.push(['NAV', 'kész']);
      else {
        say(`  kihagyva – később: ${navTodo}`);
        todo.push(`NAV: ${navTodo}`);
        states.push(['NAV', 'kihagyva']);
      }
    }
    if (nav.configured && nav.environment === 'test') {
      say(`  TESZT környezet: a számlák csak a NAV próbarendszerébe kerülnek. Éles számlázás előtt: ${navSetupCommandLine(ctx.dataDir, 'production')}`);
    } else if (nav.configured) say('  ÉLES környezet: minden kiállított számla valódi adatszolgáltatás.');

    // ---- 5. clients
    say();
    say('[5/5] AI-kliensek csatlakoztatása');
    const rows = WRITABLE_CLIENTS.map((client, i) => {
      const entry = entryState(client, ctx);
      return { client, n: i + 1, present: clientPresence(client, ctx) !== null, entry, connected: entry === 'same' };
    });
    for (const r of rows) {
      const where = r.client === 'vscode' ? ` (ebbe a mappába: ${vscodeWorkspaceConfigPath(ctx)})` : '';
      const state = r.connected ? 'már csatlakoztatva' : r.entry === 'different' ? 'van openszamla bejegyzése, más beállítással' : r.present ? 'telepítve' : 'nem találom';
      say(`  ${r.n}) ${CLIENT_TITLES[r.client]}${where} – ${state}`);
    }
    let selected: ClientId[] = [];
    if (chosen) selected = chosen;
    else if (!prompt) {
      say(`  teendő – a --client kapcsoló nélkül nem csatlakoztattam klienst. Például: ${commandFor('setup --client claude-desktop,codex', ctx)}, vagy egyenként: ${commandFor('config <kliens> --write', ctx)}`);
    } else {
      const dflt = rows.filter((r) => r.present && r.entry === 'none' && r.client !== 'vscode').map((r) => r.n);
      for (;;) {
        const answer = await prompt.ask('  Melyikhez csatlakoztassam? Számok vesszővel (pl. 1,3); 0: egyikhez sem', dflt.length ? dflt.join(',') : '0');
        const picked = parseChoice(answer, rows.length);
        if (picked) {
          selected = picked.map((n) => rows[n - 1]?.client).filter((c): c is ClientId => c !== undefined);
          break;
        }
        say(`  Számokat adj meg 1 és ${rows.length} között, vesszővel elválasztva (vagy 0-t).`);
      }
    }
    let clientState: StepState = selected.length || rows.some((r) => r.connected) ? 'kész' : prompt ? 'kihagyva' : 'teendő';
    const changed: ClientId[] = [];
    for (const client of selected) {
      say();
      let outcome: WriteOutcome | null = null;
      let failed = false;
      try {
        outcome = writeClientConfig(client, ctx, { force: o.force });
      } catch (e) {
        if (prompt && isAppError(e) && e.code === 'CLIENT_ENTRY_EXISTS' && !o.force) {
          say(`  ${e.message}`);
          if (await yesNo(prompt, '  Lecseréljem (a régiről biztonsági másolat készül)?', false)) {
            try {
              outcome = writeClientConfig(client, ctx, { force: true });
            } catch (e2) {
              report(e2);
              failed = true;
            }
          } else say(`  ${CLIENT_TITLES[client]}: kihagyva, a meglévő bejegyzés maradt.`);
        } else {
          say(`  ${CLIENT_TITLES[client]}:`);
          report(e);
          failed = true;
        }
      }
      for (const l of outcome?.lines ?? []) say(`  ${l}`);
      if (outcome && outcome.status !== 'unchanged' && outcome.status !== 'printed') changed.push(client);
      if (failed) clientState = 'hiba';
      if (outcome?.status === 'printed') {
        todo.push(`${CLIENT_TITLES[client]}: futtasd a fent kiírt claude mcp add parancsot`);
        if (clientState !== 'hiba') clientState = 'teendő';
      }
      if (failed || (client !== 'claude-code' && client !== 'codex')) continue;
      // The skill: Claude Code and Codex read it from a folder (Claude Desktop cannot).
      const target = client === 'claude-code' ? 'claude' : 'codex';
      const home = homeDir(ctx);
      if (skillState(target, home) === 'current') {
        say(`  A magyar-szamlazas skill már telepítve: ${skillDir(target, home)}`);
        continue;
      }
      if (!prompt || (await yesNo(prompt, `  Telepítsem a magyar-szamlazas skillt is (${skillDir(target, home)}) – ez a számlázás menetére tanítja az AI-t?`, true))) {
        try {
          say(`  Skill telepítve: ${installSkill(target, home)}`);
        } catch (e) {
          report(e);
        }
      }
    }
    states.push(['AI-kliensek', clientState]);

    // ---- summary and what next
    say();
    say('Összegzés');
    for (const [step, state] of states) say(`  ${step}: ${state}`);
    say();
    say('Mit tovább?');
    if (changed.includes('claude-desktop')) say('  • Lépj ki teljesen a Claude Desktopból (az ablak bezárása nem elég: Windowson a tálcán a Claude ikon → Quit, macOS-en Cmd+Q), majd indítsd újra.');
    const others = changed.filter((c) => c !== 'claude-desktop').map((c) => CLIENT_TITLES[c]);
    if (others.length) say(`  • ${others.join(', ')}: nyiss új munkamenetet (vagy indítsd újra a programot), hogy betöltse az OpenSzámlát.`);
    say('  • Kérdezd meg az AI-t: „Mi a helyzet a számlázóval?” – utána például: „Állíts ki számlát a Minta Kft.-nek 10 óra tanácsadásról, 15 000 Ft/óra + ÁFA, 8 napos átutalással.”');
    say(`  • Webes felület AI nélkül: ${commandFor('serve', ctx)} – nyisd meg a böngészőben a kiírt http://127.0.0.1:8787/?token=… címet; amíg használod, a terminál maradjon nyitva (leállítás: Ctrl+C).`);
    say(`  • Ellenőrzés bármikor: ${commandFor('doctor', ctx)} · a beállítás újra futtatható: ${commandFor('setup', ctx)}`);
    if (ctx.platform === 'win32') say(`  • ${POWERSHELL_HINT}`);
    for (const t of todo) say(`  • Teendő – ${t}`);
    return states.some(([, s]) => s === 'hiba') ? 1 : 0;
  } catch (e) {
    if (isAppError(e) && (e.code === 'CANCELLED' || e.code === 'INPUT_ENDED')) {
      say();
      say(`${e.code === 'CANCELLED' ? 'Megszakítva (Ctrl+C).' : 'A bemenet véget ért.'} Ami eddig elkészült, megmaradt; a beállítás folytatható: ${commandFor('setup', ctx)}`);
      return 1;
    }
    throw e;
  } finally {
    prompt?.close();
    app.close();
  }
}
