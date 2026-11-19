/**
 * Streamable HTTP server: MCP endpoint (/mcp, stateless, both protocol eras) + web UI on one port.
 *
 * Security defaults: listens on 127.0.0.1; every /mcp request needs the access token, either as
 * "Authorization: Bearer <token>" or in the path (/mcp/<token>, for clients that cannot send headers –
 * only behind HTTPS); wrong tokens are limited per client address (429 with Retry-After). Host and
 * Origin headers are checked against an allowlist to block DNS-rebinding attacks from web pages.
 * There is no CORS on /mcp.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { AppError } from '../core/errors.ts';
import type { OpenSzamla } from '../service/app.ts';
import { VERSION } from '../version.ts';
import { plainHeaders } from '../web/io.ts';
import { AddressThrottle, clientAddress } from '../web/security.ts';
import { createWebHandler } from '../web/ui.ts';
import { createMcpServer } from './server.ts';

export interface HttpOptions {
  host?: string;
  port?: number;
  /** Access token for /mcp and the web UI. Generated if omitted. */
  token?: string;
  /** Extra allowed Host header values ("name" or "name:port"), e.g. a public hostname behind a reverse proxy. */
  allowedHosts?: string[];
  /** Extra allowed Origins, e.g. "https://szamla.example.hu". */
  allowedOrigins?: string[];
  /** Serve the web UI (default true). */
  web?: boolean;
  /**
   * Count a connection from this machine (a reverse proxy next to the server) against the last X-Forwarded-For
   * entry instead of the loopback address (OPENSZAMLA_TRUST_PROXY; default false: the header is ignored).
   */
  trustProxy?: boolean;
}

export interface RunningHttpServer {
  url: string;
  mcpUrl: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function percentDecoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // not valid percent-encoding: only the value as sent can match
  }
}

/** A failure to listen as an AppError with a Hungarian hint (a busy port is the usual one); anything else unchanged. */
function listenError(e: unknown, host: string, port: number): unknown {
  const code = (e as NodeJS.ErrnoException).code;
  const where = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (code === 'EADDRINUSE') {
    return new AppError('PORT_IN_USE', `A port már foglalt: ${where}.`, {
      hint: 'Fut már egy openszamla serve (vagy más program) ezen a porton? Állítsd le, vagy adj meg másik portot: --port <szám> (OPENSZAMLA_HTTP_PORT).',
      cause: e,
    });
  }
  if (code === 'EACCES') {
    return new AppError('PORT_ACCESS_DENIED', `Nincs jogosultság a port használatához: ${where}.`, {
      hint: 'Válassz másik portot (--port, OPENSZAMLA_HTTP_PORT; alapértelmezés: 8787): Linuxon és macOS-en az 1024 alatti portokhoz rendszergazdai jog kell, Windowson egyes porttartományokat a rendszer lefoglal.',
      cause: e,
    });
  }
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError('HOST_UNAVAILABLE', `Ezen a gépen nincs ilyen cím, ezért nem figyelhet rajta: ${host}.`, {
      hint: 'A --host (OPENSZAMLA_HTTP_HOST) a gép egyik saját címe legyen: 127.0.0.1 (alapértelmezés: csak erről a gépről érhető el) vagy 0.0.0.0 (minden hálózati csatolón).',
      cause: e,
    });
  }
  return e;
}

function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...plainHeaders(), 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** 403 for a browser page: what happened and what to do, in plain text (nothing of the request is echoed). */
function refusedPage(res: ServerResponse, what: string): void {
  res.writeHead(403, { ...plainHeaders(), 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    `${what}\n\n` +
      'A webes felületet azon a címen nyisd meg, amelyet a program az indításakor kiírt (alapesetben http://127.0.0.1:8787/…). ' +
      'Ha más gépnéven vagy fordított proxy mögül éred el, add meg a szerver indítása előtt az OPENSZAMLA_ALLOWED_HOSTS ' +
      '(pl. szamla.pelda.hu) és az OPENSZAMLA_ALLOWED_ORIGINS (pl. https://szamla.pelda.hu) változót – részletek: docs/felhasznaloi-dokumentacio.md, 8. fejezet.\n',
  );
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export async function startHttpServer(app: OpenSzamla, opts: HttpOptions = {}): Promise<RunningHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const tokenDigest = digest(token);
  let port = opts.port ?? 8787;

  const hostAllowed = (hostHeader: string): boolean => {
    const h = hostHeader.toLowerCase();
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0] ?? '';
    const extra = (opts.allowedHosts ?? []).map((x) => x.toLowerCase());
    if (extra.includes(h) || extra.includes(name)) return true;
    if (!isLoopback(name) && name !== host.toLowerCase()) return false;
    return h === name || h === `${name}:${port}`;
  };
  const originAllowed = (origin: string): boolean => {
    if (origin === 'null') return false;
    if ((opts.allowedOrigins ?? []).includes(origin)) return true;
    try {
      const u = new URL(origin);
      const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
      return isLoopback(u.hostname) && originPort === String(port);
    } catch {
      return false;
    }
  };
  // As sent, or percent-decoded: in the /mcp/<token> path a client has to encode e.g. #, ?, % or accented
  // letters, which (older, saved) tokens may contain – the same token then works as header and in the path.
  const tokenOk = (candidate: string | null): boolean =>
    candidate !== null && [candidate, percentDecoded(candidate)].some((c) => timingSafeEqual(digest(c), tokenDigest));
  // Wrong tokens per client address (the web login counts its own the same way, src/web/ui.ts).
  const authThrottle = new AddressThrottle();

  // A server per request: it cannot notify about resource list changes, so it does not advertise them.
  // A 2025-era request is served by a fresh instance without a session (the SDK's stateless fallback).
  const mcp = toNodeHandler(
    createMcpHandler((rc) => createMcpServer(app, { resourceListChanged: false, statelessLegacyHttp: rc.era === 'legacy' })),
  );
  const web = opts.web === false ? null : createWebHandler(app, { token, trustProxy: opts.trustProxy === true });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // A page of the web UI gets the refusal in Hungarian, as text; an MCP client the JSON-RPC error.
        const forPage = !/^\/mcp(?:[/?]|$)/.test(req.url ?? '/');
        if (!hostAllowed(req.headers.host ?? '')) {
          if (forPage) refusedPage(res, 'A program ezt a kérést elutasította: a böngésző olyan címen (gépnéven) érte el, amely nincs az engedélyezettek között.');
          else rpcError(res, 403, `Forbidden host: ${req.headers.host ?? ''}`);
          return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !originAllowed(origin)) {
          if (forPage) refusedPage(res, 'A program ezt a kérést elutasította: az űrlapot egy másik címről (origin) küldték, mint amelyiken a webes felület fut.');
          else rpcError(res, 403, `Forbidden origin: ${origin}`);
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/healthz') {
          res.writeHead(200, { ...plainHeaders(), 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: 'openszamla', version: VERSION }));
          return;
        }
        const m = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
        if (m) {
          const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? null;
          // Token guessing: an address that sent too many wrong tokens – or, past the global cap, one that has not
          // authenticated recently – is refused without a check until the wait is over.
          const client = clientAddress(req, opts.trustProxy === true);
          const presented = m[1] !== undefined || bearer !== null;
          const wait = presented ? authThrottle.check(client, Date.now()) : null;
          if (wait) {
            const message =
              wait.cause === 'address'
                ? `Túl sok hibás hozzáférési token erről a címről – próbáld újra ${wait.seconds} másodperc múlva.`
                : `Túl sok hibás hozzáférési token érkezett a szerverre, ezért most csak az elmúlt 60 percben sikeresen azonosított címekről fogad kérést – próbáld újra ${wait.seconds} másodperc múlva.`;
            rpcError(res, 429, message, { 'retry-after': String(wait.seconds) });
            return;
          }
          if (!tokenOk(m[1] ?? bearer)) {
            if (presented) authThrottle.fail(client, Date.now());
            rpcError(res, 401, 'Unauthorized: missing or invalid access token', { 'www-authenticate': 'Bearer realm="openszamla"' });
            return;
          }
          authThrottle.succeed(client, Date.now());
          if (m[1]) req.url = `/mcp${url.search}`;
          await mcp(req, res);
          return;
        }
        if (web && (await web(req, res, url))) return;
        res.writeHead(404, { ...plainHeaders(), 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (e) {
        if (!res.headersSent) rpcError(res, 500, e instanceof Error ? e.message : 'Internal error');
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) => reject(listenError(e, host, port)));
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;

  const shownHost = isLoopback(host) ? '127.0.0.1' : host;
  return {
    url: `http://${shownHost}:${port}`,
    mcpUrl: `http://${shownHost}:${port}/mcp`,
    token,
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
