// Runs npm / npx through their own CLI scripts with the current Node.js binary – without a shell, so
// every argument (e.g. a Windows path with spaces) reaches npm unchanged, and Node.js 24 prints no
// DEP0190 warning (shell: true only concatenates the arguments).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Path of npm's `npm-cli.js` / `npx-cli.js` belonging to the running Node.js installation. */
export function npmCliScript(name = 'npm-cli.js') {
  const execpath = process.env.npm_execpath;
  const dirs = [
    execpath && /npm-cli\.c?js$/.test(execpath) ? dirname(execpath) : null, // started through `npm run …`
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin'), // Windows installer layout
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin'), // Unix layout (nvm, Volta, Homebrew, …)
  ].filter((d) => d !== null);
  for (const dir of dirs) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`npm not found (${name}); looked in: ${dirs.join(', ')}`);
}

/** `npm <args>`; returns stdout (null with stdio: 'inherit'). */
export function npm(args, opts = {}) {
  return execFileSync(process.execPath, [npmCliScript('npm-cli.js'), ...args], { encoding: 'utf8', ...opts });
}

/** `npx <args>`; returns stdout (null with stdio: 'inherit'). */
export function npx(args, opts = {}) {
  return execFileSync(process.execPath, [npmCliScript('npx-cli.js'), ...args], { encoding: 'utf8', ...opts });
}
