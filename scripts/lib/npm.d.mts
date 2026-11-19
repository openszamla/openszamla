import type { ExecFileSyncOptions } from 'node:child_process';

/** Path of npm's `npm-cli.js` / `npx-cli.js` belonging to the running Node.js installation. */
export function npmCliScript(name?: 'npm-cli.js' | 'npx-cli.js'): string;
/** `npm <args>` without a shell; returns stdout (null with stdio: 'inherit'). */
export function npm(args: readonly string[], opts?: ExecFileSyncOptions): string | null;
/** `npx <args>` without a shell; returns stdout (null with stdio: 'inherit'). */
export function npx(args: readonly string[], opts?: ExecFileSyncOptions): string | null;
