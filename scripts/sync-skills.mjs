#!/usr/bin/env node
// Copies the single source of the agent skill (skills/<name>/) to every place a client looks for it:
//   plugins/openszamla/skills/<name>/  – Claude Code plugin
//   .agents/skills/<name>/             – OpenAI Codex (repo-local skills)
// Run after editing skills/: `node scripts/sync-skills.mjs` (CI runs it with --check).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'skills');
const targets = [join(root, 'plugins', 'openszamla', 'skills'), join(root, '.agents', 'skills')];
const check = process.argv.includes('--check');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

let stale = 0;
for (const target of targets) {
  for (const file of files(source)) {
    const rel = relative(source, file);
    const dest = join(target, rel);
    const same = existsSync(dest) && readFileSync(dest).equals(readFileSync(file));
    if (same) continue;
    stale++;
    if (check) console.error(`out of date: ${relative(root, dest)}`);
  }
  if (!check) {
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    console.log(`synced ${relative(root, source)} → ${relative(root, target)}`);
  }
}
if (check && stale) {
  console.error('Run: node scripts/sync-skills.mjs');
  process.exit(1);
}
