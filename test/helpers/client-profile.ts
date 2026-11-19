/**
 * A throw-away user profile for the installation tests (setup, config --write, doctor): HOME, USERPROFILE, APPDATA,
 * LOCALAPPDATA and XDG_CONFIG_HOME point into a temporary folder, CODEX_HOME, CLAUDE_CONFIG_DIR and NODE_OPTIONS are
 * cleared, and PATH holds only the folder of a fake `claude` and Node.js's own folder – no test can reach the real
 * client configurations or run the real `claude`.
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLI, type CliRun } from './cli.ts';

/** Variables the profile sets or clears (compared case-insensitively: Windows has "Path"). */
const OWN = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_EXIT']);

export interface Profile {
  root: string;
  home: string;
  appData: string;
  localAppData: string;
  xdgConfig: string;
  /** First on PATH; holds the fake claude when asked for. */
  bin: string;
  /** A working directory inside the profile (not the home folder). */
  work: string;
  env: Record<string, string>;
  /** The argument lists the fake claude was started with. */
  claudeCalls(): string[][];
}

const profiles: string[] = [];

export function removeProfiles(): void {
  while (profiles.length) rmSync(profiles.pop() as string, { recursive: true, force: true });
}

/** The recorder of the fake claude: on Windows a preload of a node.exe copy named claude.exe, elsewhere its script. */
function writeRecorder(root: string): string {
  const file = join(root, 'fake-claude.mjs');
  writeFileSync(
    file,
    `import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const preload = /^claude(\\.exe)?$/i.test(basename(process.execPath));
if (preload || process.env.FAKE_CLAUDE_SCRIPT === '1') {
  const args = preload ? [basename(process.argv[1] ?? ''), ...process.argv.slice(2)] : process.argv.slice(2);
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
  process.stdout.write('Added stdio MCP server openszamla to user config\\n');
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
`,
  );
  return file;
}

export function makeProfile(opts: { fakeClaude?: boolean; claudeExit?: number } = {}): Profile {
  const root = mkdtempSync(join(tmpdir(), 'openszamla-profile-'));
  profiles.push(root);
  const home = join(root, 'home');
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  const xdgConfig = join(home, '.config');
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  for (const d of [appData, localAppData, xdgConfig, bin, work]) mkdirSync(d, { recursive: true });
  const base = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('OPENSZAMLA_') && !OWN.has(e[0].toUpperCase())),
  );
  const env: Record<string, string> = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    PATH: [bin, dirname(process.execPath)].join(delimiter),
  };
  const log = join(root, 'claude-calls.jsonl');
  if (opts.fakeClaude) {
    const recorder = writeRecorder(root);
    env.FAKE_CLAUDE_LOG = log;
    env.FAKE_CLAUDE_EXIT = String(opts.claudeExit ?? 0);
    if (process.platform === 'win32') {
      // Only an .exe is started without a shell: a copy of node.exe that the preload turns into the recorder.
      const exe = join(bin, 'claude.exe');
      try {
        linkSync(process.execPath, exe);
      } catch {
        copyFileSync(process.execPath, exe);
      }
      env.NODE_OPTIONS = `--import=${pathToFileURL(recorder).href}`;
    } else {
      const script = join(bin, 'claude');
      writeFileSync(script, `#!/bin/sh\nFAKE_CLAUDE_SCRIPT=1 exec "${process.execPath}" "${recorder}" "$@"\n`);
      chmodSync(script, 0o755);
    }
  }
  return {
    root,
    home,
    appData,
    localAppData,
    xdgConfig,
    bin,
    work,
    env,
    claudeCalls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}

/** Runs the CLI in the profile (its environment only, the working directory `work` unless given). */
export function runIn(p: Profile, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...p.env, ...opts.env }, cwd: opts.cwd ?? p.work, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}
