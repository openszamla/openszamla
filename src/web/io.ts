/**
 * Low-level HTTP helpers of the web UI: size-limited form bodies, cookies and responses with the
 * security headers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_COOKIE } from './security.ts';

/** Maximum accepted POST body. */
export const MAX_FORM_BYTES = 256 * 1024;

/** An HTTP-level failure with a Hungarian, user-facing title. */
export class HttpError extends Error {
  readonly status: number;
  readonly hint: string | undefined;

  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.hint = hint;
  }
}

/** Reads an application/x-www-form-urlencoded body (UTF-8, at most `limit` bytes). */
export function readForm(req: IncomingMessage, limit = MAX_FORM_BYTES): Promise<URLSearchParams> {
  const [mime = '', ...params] = (req.headers['content-type'] ?? '').toLowerCase().split(';').map((s) => s.trim());
  if (mime !== 'application/x-www-form-urlencoded') {
    return Promise.reject(new HttpError(415, 'Nem támogatott kéréstípus.', 'Az űrlapok csak application/x-www-form-urlencoded formában küldhetők.'));
  }
  const charset = params.find((p) => p.startsWith('charset='))?.slice('charset='.length).replace(/"/g, '');
  if (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8') {
    return Promise.reject(new HttpError(415, 'Nem támogatott karakterkódolás.', 'Az űrlapokat UTF-8 kódolással kell elküldeni.'));
  }
  const tooLarge = (): HttpError => new HttpError(413, 'Túl nagy kérés.', `Egy űrlap legfeljebb ${Math.floor(limit / 1024)} kB lehet.`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume(); // discard the rest of the body
      reject(e);
    };
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > limit) fail(tooLarge());
      else chunks.push(chunk);
    }
    function onEnd(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    }
    function onError(e: Error): void {
      fail(e);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** All values of every cookie (a name may occur several times, e.g. set by another app on the same host). */
export function parseCookies(header: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  }
  return out;
}

export function sessionCookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(secure: boolean): string {
  return sessionCookieHeader('', 0, secure);
}

/**
 * Headers of every HTML page. Referrer-Policy is "same-origin" rather than "no-referrer": under
 * "no-referrer" browsers send `Origin: null` with same-origin form POSTs, which the HTTP server's
 * Origin allowlist (src/mcp/http.ts) rejects – and which would also defeat our own Origin check.
 * "same-origin" still never sends a referrer to any other site.
 */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; ` +
      `form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/** Headers of non-HTML responses (redirects, downloads). */
export function plainHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  };
}

export function sendHtml(res: ServerResponse, status: number, body: string, nonce: string, extra: Record<string, string | string[]> = {}): void {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...pageHeaders(nonce), 'content-length': String(buf.length), ...extra });
  res.end(buf);
}

export function sendRedirect(res: ServerResponse, location: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { ...plainHeaders(), location, 'content-length': '0', ...extra });
  res.end();
}

/** File download (attachment) with a sanitised ASCII file name. */
export function sendDownload(res: ServerResponse, contentType: string, fileName: string, body: Buffer): void {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'letoltes';
  res.writeHead(200, {
    ...plainHeaders(),
    'content-type': contentType,
    'content-length': String(body.length),
    'content-disposition': `attachment; filename="${safe}"`,
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(body);
}
