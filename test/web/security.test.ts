import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { localizeLineRefs, numberInput, draftInputFrom } from '../../src/web/forms.ts';
import { parseCookies } from '../../src/web/io.ts';
import {
  CONFIRM_BUCKET_MS,
  csrfTokenFor,
  deriveKeys,
  isSameOriginRequest,
  isTopLevelNavigation,
  AddressThrottle,
  mintConfirmation,
  mintSession,
  OnceIds,
  REDACTED,
  redactSecrets,
  safeEqual,
  secretList,
  SESSION_TTL_SECONDS,
  tokenMatches,
  verifyConfirmation,
  verifyCsrf,
  verifySession,
} from '../../src/web/security.ts';

const keys = deriveKeys('secret-token-0123456789');
const other = deriveKeys('another-token-0123456789');
const NOW = Date.parse('2026-10-27T09:00:00.000Z');

function req(headers: Record<string, string>): IncomingMessage {
  return { headers, socket: {} } as unknown as IncomingMessage;
}

describe('token and sessions', () => {
  it('checks the token in constant time and never puts it in the cookie', () => {
    expect(tokenMatches(keys, 'secret-token-0123456789')).toBe(true);
    expect(tokenMatches(keys, 'secret-token-012345678')).toBe(false);
    expect(tokenMatches(keys, '')).toBe(false);
    const { cookieValue, session } = mintSession(keys, NOW);
    expect(cookieValue).not.toContain('secret-token');
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toBe(NOW - (NOW % 1000) + SESSION_TTL_SECONDS * 1000);
  });

  it('never authenticates with an empty configured token or an empty candidate', () => {
    const empty = deriveKeys('');
    expect(tokenMatches(empty, '')).toBe(false);
    expect(tokenMatches(empty, 'x')).toBe(false);
    expect(tokenMatches(deriveKeys('   '), '   ')).toBe(false);
  });

  it('accepts only untampered, unexpired sessions signed with the current token', () => {
    const { cookieValue, session } = mintSession(keys, NOW);
    expect(verifySession(keys, cookieValue, NOW + 1000)).toEqual(session);
    expect(verifySession(other, cookieValue, NOW)).toBeNull();
    expect(verifySession(keys, cookieValue, session.expiresAt)).toBeNull();
    const [id, exp, sig] = cookieValue.split('.') as [string, string, string];
    expect(verifySession(keys, `${id}.${Number(exp) + 3600}.${sig}`, NOW)).toBeNull();
    expect(verifySession(keys, `${id.replace(/^./, id[0] === 'A' ? 'B' : 'A')}.${exp}.${sig}`, NOW)).toBeNull();
    expect(verifySession(keys, 'garbage', NOW)).toBeNull();
    expect(verifySession(keys, '', NOW)).toBeNull();
  });

  it('CSRF tokens are per session and compared safely', () => {
    const a = mintSession(keys, NOW).session;
    const b = mintSession(keys, NOW).session;
    const token = csrfTokenFor(keys, a.id);
    expect(verifyCsrf(keys, a.id, token)).toBe(true);
    expect(verifyCsrf(keys, b.id, token)).toBe(false);
    expect(verifyCsrf(keys, a.id, `${token}x`)).toBe(false);
    expect(verifyCsrf(keys, a.id, '')).toBe(false);
    expect(verifyCsrf(keys, a.id, null)).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('confirmation values', () => {
  it('are bound to operation, session, target and content, and expire after 10–20 minutes', () => {
    const c = mintConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-a', NOW);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-a', c, NOW)).toBe(true);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-a', c, NOW + CONFIRM_BUCKET_MS)).toBe(true);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-a', c, NOW + 2 * CONFIRM_BUCKET_MS + 1)).toBe(false);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-b', c, NOW)).toBe(false);
    expect(verifyConfirmation(keys, 'sid-2', 'issue', 'inv_1', 'hash-a', c, NOW)).toBe(false);
    expect(verifyConfirmation(keys, 'sid-1', 'cancel', 'inv_1', 'hash-a', c, NOW)).toBe(false);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_2', 'hash-a', c, NOW)).toBe(false);
    expect(verifyConfirmation(other, 'sid-1', 'issue', 'inv_1', 'hash-a', c, NOW)).toBe(false);
    expect(verifyConfirmation(keys, 'sid-1', 'issue', 'inv_1', 'hash-a', '', NOW)).toBe(false);
  });
});

describe('same-origin check for POSTs', () => {
  it('accepts same-origin browser requests and non-browser clients', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', referer: 'http://127.0.0.1:8787/invoices' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: 'szamla.example.hu', origin: 'https://szamla.example.hu' }))).toBe(true);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', 'x-forwarded-host': 'szamla.example.hu', origin: 'https://szamla.example.hu' }))).toBe(true);
  });

  it('rejects cross-site, same-site and opaque origins', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:3000' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', origin: 'null' }))).toBe(false);
    expect(isSameOriginRequest(req({ host: '127.0.0.1:8787', referer: 'https://evil.example/x' }))).toBe(false);
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:8787' }))).toBe(false);
  });
});

describe('login throttle', () => {
  it('blocks an address after too many failures inside the window – and only that address', () => {
    const t = new AddressThrottle({ perAddress: 3, windowMs: 60_000 });
    t.fail('10.0.0.5', NOW);
    t.fail('10.0.0.5', NOW + 1);
    expect(t.check('10.0.0.5', NOW + 2)).toBeNull();
    t.fail('10.0.0.5', NOW + 3);
    expect(t.check('10.0.0.5', NOW + 4)).toMatchObject({ cause: 'address', seconds: 60 });
    // Somebody else's wrong guesses do not lock this one out.
    expect(t.check('127.0.0.1', NOW + 4)).toBeNull();
    expect(t.check('10.0.0.5', NOW + 60_004)).toBeNull();
  });

  it('only top-level navigations (or clients without fetch metadata) may use a ?token= link', () => {
    expect(isTopLevelNavigation(req({}))).toBe(true);
    expect(isTopLevelNavigation(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(isTopLevelNavigation(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }))).toBe(false);
    expect(isTopLevelNavigation(req({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }))).toBe(false);
    expect(isTopLevelNavigation(req({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe(false);
  });
});

describe('secret redaction (last line of defence of every rendered page)', () => {
  const page = (inner: string): string =>
    `<!doctype html><html><head><title>${inner}</title><style nonce="n">button{border:0}</style></head><body><button class="btn">${inner}</button><input value="${inner}"><a href="/invoices?q=${inner}">x</a><script nonce="n">var button = 1;</script></body></html>`;

  it('masks secrets in text and attribute values, raw, HTML-escaped and URL-encoded', () => {
    const secrets = secretList(['p&ss"w<rd> 1', 'TOKEN-123456', '', null, 'short']);
    expect(secrets).toEqual(['p&ss"w<rd> 1', 'TOKEN-123456']);
    const escaped = 'p&amp;ss&quot;w&lt;rd&gt; 1';
    const out = redactSecrets(`${page(escaped)}<p>TOKEN-123456</p><a href="/x?q=p%26ss%22w%3Crd%3E+1">y</a>`, secrets);
    expect(out).not.toContain(escaped);
    expect(out).not.toContain('TOKEN-123456');
    expect(out).not.toContain('p%26ss%22w%3Crd%3E+1');
    expect(out).toContain(`<title>${REDACTED}</title>`);
    expect(out).toContain(`value="${REDACTED}"`);
  });

  it('never alters markup or the constant style/script blocks, even for a secret like "button"', () => {
    const html = page('Mentés');
    expect(redactSecrets(html, secretList(['button']))).toBe(html);
    // The one change besides the masking: the input whose value holds the secret is disabled (never
    // posted back masked) and followed by a note (WEB-4).
    const masked = redactSecrets(page('a button b'), secretList(['button']));
    const note = /<span class="withheld" role="note">[^<]+<\/span>/.exec(masked)?.[0] ?? '';
    expect(note).not.toBe('');
    expect(masked).toBe(
      page('a button b')
        .replace(/a button b/g, `a ${REDACTED} b`)
        .replace(`<input value="a ${REDACTED} b">`, `<input value="a ${REDACTED} b" disabled>${note}`),
    );
    expect(redactSecrets(html, [])).toBe(html);
  });
});

describe('one-time form ids', () => {
  it('accept an id once, again after release, and only well-formed ids', () => {
    const once = new OnceIds(60_000, 2);
    const id = OnceIds.mint();
    expect(OnceIds.isWellFormed(id)).toBe(true);
    expect(OnceIds.isWellFormed('x')).toBe(false);
    expect(OnceIds.isWellFormed(null)).toBe(false);
    expect(once.claim(`s|${id}`, NOW)).toBe(true);
    expect(once.claim(`s|${id}`, NOW + 1)).toBe(false);
    once.release(`s|${id}`);
    expect(once.claim(`s|${id}`, NOW + 2)).toBe(true);
    expect(once.claim(`s|${id}`, NOW + 60_003)).toBe(true);
    once.claim('a', NOW);
    once.claim('b', NOW);
    expect(once.claim(`s|${id}`, NOW + 60_004)).toBe(true);
  });
});

describe('cookies and form parsing', () => {
  it('keeps every value of a repeated cookie name', () => {
    const c = parseCookies('a=1; openszamla_session=x; b="2"; openszamla_session=y');
    expect(c.get('openszamla_session')).toEqual(['x', 'y']);
    expect(c.get('b')).toEqual(['2']);
  });

  it('accepts Hungarian number notation', () => {
    expect(numberInput('1 234,5')).toBe('1234.5');
    expect(numberInput('12.5')).toBe('12.5');
    expect(numberInput(' 15 000 ')).toBe('15000');
    expect(numberInput('1,234,5')).toBe('1,234,5');
    expect(numberInput(null)).toBe('');
    // Dots grouping the thousands with a decimal comma: the Hungarian way of writing money.
    expect(numberInput('1.000,50')).toBe('1000.50');
    expect(numberInput('12.345.678,9')).toBe('12345678.9');
    // Two or more groups of three digits can only be a thousands grouping.
    expect(numberInput('1.000.000')).toBe('1000000');
    expect(numberInput('-12.345.678')).toBe('-12345678');
    // A dot with anything but groups of three digits after it, or a leading zero, can only be a decimal point.
    expect(numberInput('0.125')).toBe('0.125');
    expect(numberInput('1.5')).toBe('1.5');
    expect(numberInput('1.2345')).toBe('1.2345');
  });

  it('refuses "1.000" and "10.000": a thousands separator or a decimal point – a guess could bill 1000× too little', () => {
    for (const v of ['1.000', '10.000', '250.000', '2.125', '615.943', '-1.500']) {
      expect(() => numberInput(v, '1. tétel – egységár'), v).toThrow(`A(z) „${v}” nem egyértelmű a(z) „1. tétel – egységár” mezőben: a pont ezres tagolás és tizedesjel is lehet.`);
    }
    let error: { code?: string; hint?: string } | null = null;
    try {
      numberInput('10.000', 'Összeg');
    } catch (e) {
      error = e as { code?: string; hint?: string };
    }
    expect(error?.code).toBe('INVALID_INPUT');
    // Both readings, written out with the value that was typed.
    expect(error?.hint).toBe('Tizedes törtként vesszővel írd: 10,000. Ezresként pont nélkül: 10000 (vagy szóközzel: 10 000).');
  });

  it('turns the draft form into a DraftInput, skipping blank rows', () => {
    const f = new URLSearchParams();
    f.set('documentType', 'invoice');
    f.set('customerId', 'cus_0123456789');
    f.set('currency', 'eur');
    f.set('exchangeRate', '390,12');
    for (const [i, d, q, p] of [[0, 'Tanácsadás', '10', '80'], [1, '', '', ''], [2, 'Könyv', '2', '12,50']] as const) {
      f.set(`lines[${i}].description`, d);
      f.set(`lines[${i}].quantity`, q);
      f.set(`lines[${i}].unitPrice`, p);
      f.set(`lines[${i}].unit`, i === 0 ? 'óra' : '');
      f.set(`lines[${i}].priceBasis`, 'net');
      f.set(`lines[${i}].vatCode`, '27');
      f.set(`lines[${i}].productId`, '');
    }
    const { input, rowNumbers } = draftInputFrom(f);
    expect(input.customerId).toBe('cus_0123456789');
    expect(input.customer).toBeUndefined();
    expect(input.currency).toBe('EUR');
    expect(input.exchangeRate).toBe('390.12');
    expect(input.lines).toEqual([
      { description: 'Tanácsadás', quantity: '10', unitPrice: '80', unit: 'óra', priceBasis: 'net', vatCode: '27' },
      { description: 'Könyv', quantity: '2', unitPrice: '12.50', priceBasis: 'net', vatCode: '27' },
    ]);
    expect(rowNumbers).toEqual([1, 3]);
    expect(localizeLineRefs('Hiányzik a mennyiség (lines[1].quantity).', rowNumbers)).toBe('Hiányzik a mennyiség (3. tétel – mennyiség).');
  });

  it('rejects incomplete rows and bad ids with Hungarian messages', () => {
    const f = new URLSearchParams({ 'lines[0].description': 'X', 'lines[0].quantity': '', 'lines[0].unitPrice': '5' });
    expect(() => draftInputFrom(f)).toThrow(/1\. tételből hiányzik a mennyiség/);
    expect(() => draftInputFrom(new URLSearchParams({ customerId: 'cus_../../x' }))).toThrow(/Érvénytelen vevőazonosító/);
    expect(() => draftInputFrom(new URLSearchParams({ documentType: 'storno' }))).toThrow(/bizonylattípust/);
  });
});
