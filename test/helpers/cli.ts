/** The `openszamla` command as a child process, with a clean environment (no OPENSZAMLA_* of the developer's shell). */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENSZAMLA_')) env[k] = v;
  return { ...env, ...extra };
}

/** Temporary folders, removed by `removeTempDirs` (call it in afterEach). */
const dirs: string[] = [];

export function tempDir(prefix = 'openszamla-cli-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function removeTempDirs(): void {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
}

/** Runs the CLI to its end. */
export function cli(args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env: cleanEnv(opts.env), cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

export interface Serving {
  /** stderr up to the moment `ready` matched. */
  stderr: string;
  stop(): Promise<void>;
}

/**
 * Starts `openszamla serve <args>` and resolves once stderr matches `ready`. If the process ends first,
 * resolves with its run instead (a refused start).
 */
export function serve(args: string[], ready: RegExp, opts: { env?: Record<string, string> } = {}): Promise<Serving | CliRun> {
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', ...args], { env: cleanEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`serve did not start: ${stderr}`));
    }, 20_000);
    const stop = async (): Promise<void> => {
      child.kill();
      await exited; // the database file stays open until the process is gone (Windows cannot delete it before)
    };
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      if (ready.test(stderr)) {
        clearTimeout(timer);
        resolve({ stderr, stop });
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function isRun(r: Serving | CliRun): r is CliRun {
  return 'code' in r;
}
