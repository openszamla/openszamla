/** Builds the OpenSzámla MCP server (tools, resources, prompts). One factory serves every transport and both protocol eras. */
import { McpServer } from '@modelcontextprotocol/server';
import type { OpenSzamla } from '../service/app.ts';
import type { ConfirmMode } from '../service/config.ts';
import { VERSION } from '../version.ts';
import { SERVER_INSTRUCTIONS } from './instructions.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerTools } from './tools.ts';

export const RESOURCE_BASE = 'openszamla://';

/**
 * `resourceListChanged` (default true): the server tells the client when the resource list changes
 * (notifications/resources/list_changed after issuing, cancelling, saving a customer). Only a server that
 * lives as long as the connection can (stdio); the HTTP endpoint builds one per request, so it passes
 * false and does not advertise resources.listChanged.
 *
 * `statelessLegacyHttp`: the instance answers a single 2025-era request of the stateless HTTP endpoint
 * (src/mcp/http.ts) – it never sees the client's initialize capabilities and cannot send the client a
 * request (an elicitation dialog).
 */
export function createMcpServer(
  app: OpenSzamla,
  opts: { confirmMode?: ConfirmMode; resourceListChanged?: boolean; statelessLegacyHttp?: boolean } = {},
): McpServer {
  const resourceListChanged = opts.resourceListChanged ?? true;
  const server = new McpServer(
    { name: 'openszamla', title: 'OpenSzámla', version: VERSION, websiteUrl: 'https://github.com/openszamla/openszamla' },
    { instructions: SERVER_INSTRUCTIONS, ...(resourceListChanged ? {} : { capabilities: { resources: { listChanged: false } } }) },
  );
  const ctx = {
    app,
    confirmMode: opts.confirmMode ?? app.config.confirmMode,
    resourceBase: RESOURCE_BASE,
    resourceListChanged,
    statelessLegacyHttp: opts.statelessLegacyHttp === true,
  };
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
