/**
 * A request the server refuses for its Host or Origin: a browser page (the web UI, a form sent from another address)
 * used to get the MCP endpoint's JSON-RPC error – raw English JSON in the browser window. A page now gets Hungarian
 * text saying what happened and how to set the allowed addresses; the /mcp endpoint keeps the JSON-RPC error, and
 * nothing of the request is echoed back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../../src/mcp/http.ts';
import { makeTestApp } from '../helpers/app.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('a refused Host or Origin', () => {
  it('a page gets Hungarian text, /mcp the JSON-RPC error', async () => {
    const t = makeTestApp();
    const http = await startHttpServer(t.app, { port: 0, token: 'test-token-0123456789-0123456789-abc' });
    cleanups.push(async () => {
      await http.close();
      t.cleanup();
    });
    const evil = 'https://evil.example';

    const page = await fetch(`${http.url}/invoices/new`, { method: 'POST', headers: { origin: evil, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await page.text();
    expect(text).toContain('A program ezt a kérést elutasította: az űrlapot egy másik címről (origin) küldték');
    expect(text).toContain('OPENSZAMLA_ALLOWED_ORIGINS');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('jsonrpc');

    const mcp = await fetch(http.mcpUrl, { method: 'POST', headers: { origin: evil, 'content-type': 'application/json' }, body: '{}' });
    expect(mcp.status).toBe(403);
    expect(mcp.headers.get('content-type')).toContain('application/json');
    expect((await mcp.json()) as unknown).toMatchObject({ jsonrpc: '2.0', error: { message: `Forbidden origin: ${evil}` } });
  });
});
