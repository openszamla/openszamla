#!/usr/bin/env node
/**
 * Entry point of the `openszamla` command. Checks the runtime first – OpenSzámla needs Node.js ≥ 22.13.0,
 * the first version with node:sqlite available without a flag and with StatementSync#iterate – so an old
 * runtime (e.g. one embedded in an MCP client) fails with a clear message instead of a module-loading
 * stack trace; then loads the real commands.
 */
const MIN = [22, 13, 0] as const;
const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
// Node.js 22 prints "ExperimentalWarning: SQLite is an experimental feature …" at the first use of node:sqlite – with
// every command, in the middle of its output. The program is built on that module, and its user can do nothing about
// the notice: this one warning is left out (every other warning is printed as usual).
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (text.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
/** Not only the version: the node:sqlite features the store relies on must actually work. */
const hasSqlite = (() => {
  try {
    const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : undefined;
    if (typeof sqlite?.DatabaseSync !== 'function' || typeof sqlite.StatementSync?.prototype.iterate !== 'function') return false;
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      db.exec('BEGIN; CREATE TABLE probe (x); COMMIT');
      return [...db.prepare('SELECT 1 AS one').iterate()].length === 1;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
})();
const oldVersion = major !== MIN[0] ? major < MIN[0] : minor !== MIN[1] ? minor < MIN[1] : patch < MIN[2];
if (oldVersion || !hasSqlite) {
  process.stderr.write(
    `OpenSzámla: Node.js ${MIN.join('.')} vagy újabb szükséges (beépített node:sqlite modullal); ez a futtatókörnyezet: ${process.versions.node}.\n` +
      'Telepítsd a Node.js 24 LTS-t (https://nodejs.org), vagy add meg az MCP-kliens konfigurációjában a frissebb node elérési útját.\n',
  );
  process.exit(1);
}
await import('./commands.ts');
