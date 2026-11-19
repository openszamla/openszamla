#!/usr/bin/env node
// Builds the Claude Desktop extension (MCP Bundle, .mcpb):
//   1. npm run build                          → dist/
//   2. stage everything the npm package ships (package.json "files": dist/, skills/, the user
//      documentation, CHANGELOG.md, README.md, LICENSE, THIRD-PARTY-NOTICES), the vendor schemas,
//      package.json and the production node_modules
//   3. npx @anthropic-ai/mcpb validate + pack → openszamla-<version>.mcpb
// Usage: npm run build:mcpb (or node scripts/build-mcpb.mjs)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npm, npx } from './lib/npm.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, '.tmp', 'mcpb-stage');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// npm/npx without a shell: a checkout under "C:\Users\Kovács Anna\…" stays one argument.
const run = (tool, args, cwd = root) => tool(args, { cwd, stdio: 'inherit' });

run(npm, ['run', 'build']);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// The user documentation must reach the user with the program (23/2014. NGM rendelet 10. §).
for (const item of [...pkg.files, 'vendor/nav-online-invoice']) {
  cpSync(join(root, item), join(stage, item), { recursive: true });
}
const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
manifest.documentation = `https://github.com/openszamla/openszamla/blob/v${pkg.version}/docs/felhasznaloi-dokumentacio.md`;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const { devDependencies: _dev, scripts: _scripts, ...prodPkg } = pkg;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(prodPkg, null, 2)}\n`);
cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], stage);

const out = join(root, `openszamla-${pkg.version}.mcpb`);
run(npx, ['-y', '@anthropic-ai/mcpb@2.1.2', 'validate', join(stage, 'manifest.json')]);
run(npx, ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out]);
console.log(`\nKész: ${out}`);
