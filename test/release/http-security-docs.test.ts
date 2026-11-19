/**
 * W3 and the documentation of S1: the README's HTTP security bullet states the custom-token rule and the /mcp
 * guessing throttle, and every document that describes the throttle says that X-Forwarded-For is used only with
 * OPENSZAMLA_TRUST_PROXY=1 (the nginx instruction with $proxy_add_x_forwarded_for belongs to that opt-in).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
/** Markdown text with its line breaks (and the indentation of list items) folded to single spaces. */
const flat = (path: string): string => read(path).replace(/\s*\n\s*/g, ' ');

describe('HTTP security in the documentation', () => {
  it('README: the token rule and the /mcp throttle are in the HTTP security bullet', () => {
    const bullet = /- HTTP módban a szerver alapból csak `127\.0\.0\.1`-en figyel.*?(?= - )/.exec(flat('README.md'))?.[0] ?? '';
    expect(bullet).toContain('legalább 20 karakteres');
    expect(bullet).toContain('`[A-Za-z0-9_-]`');
    expect(bullet).toMatch(/percenként 10 hibás token után/);
    expect(bullet).toContain('429 `Retry-After`');
    expect(bullet).toContain('OPENSZAMLA_TRUST_PROXY=1');
  });

  it('every description of the throttle names the OPENSZAMLA_TRUST_PROXY opt-in', () => {
    for (const doc of ['README.md', 'SECURITY.md', 'docs/kliensek.md', 'docs/felhasznaloi-dokumentacio.md']) {
      expect(read(doc), doc).toContain('OPENSZAMLA_TRUST_PROXY');
    }
    // The environment variable list of the user documentation has it.
    expect(read('docs/felhasznaloi-dokumentacio.md')).toMatch(/^\| `OPENSZAMLA_TRUST_PROXY` \| /m);
    // nginx: the header is trusted only with the opt-in, and the proxy must then set it itself.
    const clients = flat('docs/kliensek.md');
    expect(clients).toMatch(/`OPENSZAMLA_TRUST_PROXY=1` mellett a szerver a fejléc utolsó elemét veszi a kliens címének – ezért ilyenkor a proxynak magának kell beállítania a fejlécet: a Caddy ezt alapból megteszi, nginx-nél `proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;` kell/);
    expect(clients).not.toMatch(/különben a token-próbálgatás elleni korlát \(lent\) minden kliensnek a proxy címét látja/);
  });
});
