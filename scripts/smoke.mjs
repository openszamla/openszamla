#!/usr/bin/env node
// Smoke test of a build: command line, service and MCP server (stdio) on one database. Plain
// JavaScript, so it also runs on the oldest supported Node.js (CI runs it on 22.13.0, the minimum in
// package.json "engines").
//   node scripts/smoke.mjs                   this repository's dist/ (after npm run build)
//   node scripts/smoke.mjs --package <dir>   an installed package, e.g. <prefix>/node_modules/openszamla
//   node scripts/smoke.mjs --src             src/*.ts directly (development; Node.js >= 22.18)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const packageDir = args.includes('--package') ? resolve(args[args.indexOf('--package') + 1] ?? '.') : null;
const fromSource = args.includes('--src');
const root = packageDir ?? fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(root, fromSource ? 'src/cli/main.ts' : 'dist/cli/main.js');
const appPath = join(root, fromSource ? 'src/service/app.ts' : 'dist/service/app.js');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function check(ok, what) {
  if (!ok) throw new Error(`SMOKE FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

/** The developer's own OPENSZAMLA_* settings (e.g. NAV credentials) must not leak into the test. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OPENSZAMLA_')));

/** Starts `openszamla mcp`, sends the requests, returns the responses by id. */
function mcp(dataDir, requests) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], { env: { ...cleanEnv, OPENSZAMLA_HOME: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = new Map();
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`SMOKE FAIL: no MCP answer in 30 s; stderr: ${stderr}`));
    }, 30_000);
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // anything but JSON-RPC on stdout breaks MCP clients
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (requests.every((r) => r.id === undefined || responses.has(r.id))) child.stdin.end();
      }
    });
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      done(responses);
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...r })}\n`);
  });
}

const dir = mkdtempSync(join(tmpdir(), 'openszamla-smoke-'));
try {
  const cli = (...a) => execFileSync(process.execPath, [cliPath, ...a], { encoding: 'utf8', env: { ...cleanEnv, OPENSZAMLA_HOME: dir } }).trim();
  check(cli('--version') === version, `openszamla --version: ${version} (Node.js ${process.versions.node})`);
  // A command prints nothing it was not asked for: on Node.js 22 the runtime's "ExperimentalWarning: SQLite …" must not
  // land in the middle of every answer (the entry point leaves that one warning out).
  const quiet = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', env: { ...cleanEnv, OPENSZAMLA_HOME: dir } });
  check(quiet.status === 0 && quiet.stderr === '', 'no runtime warning on stderr');

  // Several reads and writes on one connection, then a reopen (on Node.js 22.13–22.15 a read once
  // left its transaction open and every later operation failed).
  const { OpenSzamla } = await import(pathToFileURL(appPath).href);
  let app = OpenSzamla.open({ dataDir: dir, env: {} });
  app.updateSeller({
    name: 'Füstpróba Kft.',
    taxNumber: '12345676-2-42',
    address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Irinyi József utca 4.' },
    vatStatus: 'normal',
  });
  check(app.status().seller?.name === 'Füstpróba Kft.', 'seller saved and read back');
  check(app.findInvoices({}).total === 0, 'empty invoice list');
  const customerId = app.saveCustomer({
    vatStatus: 'DOMESTIC',
    name: 'Árvíztűrő Tükörfúrógép Zrt.',
    taxNumber: '87654323-2-13',
    address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
  }).customer.id;
  const draft = await app.createDraft({ customerId, lines: [{ description: 'Szoftverfejlesztés', quantity: '10', unit: 'óra', unitPrice: '15000', vatCode: '27' }] });
  const issued = await app.issue(draft.invoice.id, { submitToNav: false });
  check(issued.invoice.status === 'issued' && Boolean(issued.invoice.number), `invoice issued: ${issued.invoice.number}`);
  check(issued.pdfError === null && issued.pdfPath !== null && existsSync(issued.pdfPath), 'PDF rendered');
  app.close();
  app = OpenSzamla.open({ dataDir: dir, env: {} });
  check(app.findInvoices({}).total === 1, 'invoice found after reopening');
  check(app.verifyIntegrity().audit.ok, 'audit chain intact');
  app.close();

  check(cli('verify').includes('Ellenőrzött számlák: 1'), 'openszamla verify');
  cli('backup', join(dir, 'mentés.db'));
  check(existsSync(join(dir, 'mentés.db')), 'openszamla backup');
  // The preview of a restore changes nothing; restoring for real puts the backup in the database's place and keeps the old one.
  check(cli('restore', join(dir, 'mentés.db')).includes('előnézet (semmi nem változott)'), 'openszamla restore (preview)');
  check(cli('restore', join(dir, 'mentés.db'), '--confirm').includes('Ellenőrzés: rendben (1 bizonylat'), 'openszamla restore --confirm');

  const r = await mcp(dir, [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'tools/call', params: { name: 'setup_status', arguments: {} } },
  ]);
  const tools = (r.get(2)?.result?.tools ?? []).map((t) => t.name);
  check(tools.includes('setup_status') && tools.includes('invoice_issue'), `MCP tools/list: ${tools.length} tools`);
  check(r.get(3)?.result?.structuredContent?.counts?.issued === 1, 'MCP setup_status sees the issued invoice');

  if (packageDir) {
    for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES', 'CHANGELOG.md', 'docs/felhasznaloi-dokumentacio.md']) check(existsSync(join(packageDir, f)), `${f} shipped`);
  }
  console.log('smoke test passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
