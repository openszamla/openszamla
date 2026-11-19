/**
 * The real `openszamla mcp` command as a child process – exactly how Claude Code, Claude Desktop and
 * Codex start it – in both protocol eras, plus a raw 2025-06-18 initialize like Codex sends.
 * Runs src/cli/main.ts directly, so it needs type stripping without a flag (Node.js ≥ 22.18); the
 * built package is exercised on the minimum runtime by scripts/smoke.mjs in CI.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openszamla-stdio-'));
  dirs.push(d);
  return d;
}

describe.each(['legacy', 'auto'] as const)('openszamla mcp over stdio (%s negotiation)', (mode) => {
  it('lists tools and answers setup_status', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      env: { ...process.env, OPENSZAMLA_HOME: dataDir() } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { versionNegotiation: { mode } });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(27);
      const r = (await client.callTool({ name: 'setup_status', arguments: {} })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent?.seller).toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('raw stdio protocol', () => {
  it('answers a 2025-06-18 initialize (Codex) and writes only JSON-RPC to stdout', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, OPENSZAMLA_HOME: dataDir() }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    const gotTwo = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (lines.length >= 2) resolve();
        }
      });
    });
    const send = (msg: unknown): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-like', version: '0' } } });
    await new Promise((r) => setTimeout(r, 300));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await Promise.race([gotTwo, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout; stdout so far: ${lines.join('\n')}`)), 20_000))]);
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
    const msgs = lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as { id?: number; result?: { protocolVersion?: string; tools?: unknown[]; instructions?: string } });
    const init = msgs.find((m) => m.id === 1);
    expect(init?.result?.protocolVersion).toBe('2025-06-18');
    expect(init?.result?.instructions).toContain('setup_status');
    expect(msgs.find((m) => m.id === 2)?.result?.tools).toHaveLength(27);
  }, 30_000);
});
