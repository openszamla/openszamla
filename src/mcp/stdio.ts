/** stdio transport – Claude Code, Claude Desktop and Codex start the server as a child process. */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { OpenSzamla } from '../service/app.ts';
import { createMcpServer } from './server.ts';

/**
 * Serves MCP over stdin/stdout (both protocol eras) until stdin closes.
 * stdout carries JSON-RPC only: anything printed by accident goes to stderr.
 */
export async function runStdio(app: OpenSzamla): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const handle = serveStdio(() => createMcpServer(app), {
    onerror: (e) => process.stderr.write(`[openszamla] ${e.message}\n`),
  });
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void handle.close().finally(() => {
        app.close();
        resolve();
      });
    };
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.once(signal, shutdown);
  });
}
