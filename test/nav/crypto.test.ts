import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeExchangeToken,
  encodeExchangeToken,
  invoiceHash,
  newRequestId,
  passwordHash,
  requestSignature,
  requestTimestamp,
  signatureTimestamp,
} from '../../src/nav/crypto.ts';
import { navExpectedSignature, navTimestampMask } from '../helpers/fake-nav.ts';

const API_SAMPLES = new URL('../../vendor/nav-online-invoice/samples/api/', import.meta.url);

/** The official request samples were signed with this key (it is in an XML comment: <!--<signKey>…</signKey>-->). */
const SAMPLE_SIGNING_KEY = 'ac-ac3a-7f661bff7d342N43CYX4U9FG';

function sample(file: string): string {
  return readFileSync(new URL(file, API_SAMPLES), 'utf8');
}

/** First value of <common:name …>value</common:name> (or a commented-out <name>value</name>). */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<(?:[\\w]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w]+:)?${name}>`).exec(xml);
  if (!m?.[1]) throw new Error(`no ${name} in sample`);
  return m[1].trim();
}

function operations(xml: string, listTag: 'invoiceOperation' | 'annulmentOperation', dataTag: 'invoiceData' | 'invoiceAnnulment'): Array<{ op: string; data: string }> {
  const re = new RegExp(`<${listTag}>\\s*<index>\\d+</index>\\s*<${listTag}>(\\w+)</${listTag}>\\s*<${dataTag}>([^<]+)</${dataTag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => ({ op: m[1] as string, data: (m[2] as string).trim() }));
}

describe('passwordHash (SHA-512, uppercase hex)', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(passwordHash('abc')).toBe(
      'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F',
    );
    expect(passwordHash('')).toBe(
      'CF83E1357EEFB8BDF1542850D66D8007D620E4050B5715DC83F4A921D36CE9CE47D0D13C5D85F2B0FF8318D2877EEC2F63B931BD47417A81A538327AF927DA3E',
    );
  });

  it('is 128 uppercase hex characters (common:SHA512Type)', () => {
    expect(passwordHash('Árvíztűrő tükörfúrógép!')).toMatch(/^[0-9A-F]{128}$/);
  });
});

describe('requestTimestamp', () => {
  it('is UTC with millisecond precision', () => {
    expect(requestTimestamp(new Date(Date.UTC(2026, 9, 27, 13, 5, 0, 7)))).toBe('2026-10-27T13:05:00.007Z');
  });

  it('converts Hungarian local time to UTC (CET +1, CEST +2)', () => {
    expect(requestTimestamp(new Date('2026-01-15T09:30:00+01:00'))).toBe('2026-01-15T08:30:00.000Z');
    expect(requestTimestamp(new Date('2026-07-15T09:30:00+02:00'))).toBe('2026-07-15T07:30:00.000Z');
  });

  it('matches common:GenericTimestampType', () => {
    expect(requestTimestamp(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
  });

  it('rejects invalid dates', () => {
    expect(() => requestTimestamp(new Date('nope'))).toThrow();
  });

  it('signature mask is YYYYMMDDhhmmss of the same UTC instant', () => {
    expect(signatureTimestamp(new Date('2017-12-30T18:25:45.000Z'))).toBe('20171230182545');
    expect(signatureTimestamp(new Date('2026-03-29T03:00:00+02:00'))).toBe('20260329010000');
  });
});

describe('requestSignature – worked example of the specification (chapter 1.5.1)', () => {
  const FIRST = '4317798460962869BC67F07C48EA7E4A3AFA301513CEB87B8EB94ECF92BC220A89C480F87F0860E85E29A3B6C0463D4F29712C5AD48104A6486CE839DC2F24CB';
  const SECOND = 'A881218238933F6FFB9E167445CB4DAA9749BCF484FDE48AB7649FD25E8B634A4736A65A7C4A8E2831119F739837E006566F97370415AAD55E268605206F2A6C';

  it('index hashes: SHA3-512(operation + base64 invoiceData), uppercase', () => {
    expect(invoiceHash('CREATE', 'QWJjZDEyMzQ=')).toBe(FIRST);
    expect(invoiceHash('MODIFY', 'RGNiYTQzMjE=')).toBe(SECOND);
  });

  it('requestSignature = SHA3-512(requestId + timestamp mask + signing key + index hashes)', () => {
    const sig = requestSignature('TSTKFT1222564', new Date('2017-12-30T18:25:45.000Z'), 'ce-8f5e-215119fa7dd621DLMRHRLH2S', [FIRST, SECOND]);
    expect(sig).toBe('60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42');
  });

  it('index hashes are used in uppercase even if given in lowercase', () => {
    const at = new Date('2017-12-30T18:25:45.000Z');
    expect(requestSignature('TSTKFT1222564', at, 'ce-8f5e-215119fa7dd621DLMRHRLH2S', [FIRST.toLowerCase(), SECOND.toLowerCase()])).toBe(
      requestSignature('TSTKFT1222564', at, 'ce-8f5e-215119fa7dd621DLMRHRLH2S', [FIRST, SECOND]),
    );
  });

  it('item order matters', () => {
    const at = new Date('2017-12-30T18:25:45.000Z');
    expect(requestSignature('X1', at, 'k', [FIRST, SECOND])).not.toBe(requestSignature('X1', at, 'k', [SECOND, FIRST]));
  });
});

describe('requestSignature – signatures of the official request samples', () => {
  it.each(['tokenExchange.xml', 'queryTransactionStatus.xml', 'queryTaxpayer.xml'])('%s (no item hashes)', (file) => {
    const xml = sample(file);
    expect(tag(xml, 'signKey')).toBe(SAMPLE_SIGNING_KEY);
    const sig = requestSignature(tag(xml, 'requestId'), new Date(tag(xml, 'timestamp')), SAMPLE_SIGNING_KEY);
    expect(sig).toBe(tag(xml, 'requestSignature'));
  });

  it('manageInvoice.xml: three index hashes and the final signature', () => {
    const xml = sample('manageInvoice.xml');
    const ops = operations(xml, 'invoiceOperation', 'invoiceData');
    expect(ops.map((o) => o.op)).toEqual(['CREATE', 'CREATE', 'CREATE']);
    const hashes = ops.map((o) => invoiceHash(o.op as 'CREATE', o.data));
    expect(hashes).toEqual([tag(xml, 'firstIndexHash'), tag(xml, 'secondIndexHash'), tag(xml, 'thirdIndexHash')]);
    const sig = requestSignature(tag(xml, 'requestId'), new Date(tag(xml, 'timestamp')), SAMPLE_SIGNING_KEY, hashes);
    expect(sig).toBe(tag(xml, 'requestSignature'));
    expect(sig).toBe('A111DD79CAE8E76EAD02E4E7C2D0C866292E50EDDF38D3E7312F1B950B53C08CBBFE12AD07DA10FB1876597DF49F2B6B7A9932B28933728B2E5E29AD05D20EED');
  });

  it('manageAnnulment.xml: ANNUL index hash and the final signature', () => {
    const xml = sample('manageAnnulment.xml');
    const ops = operations(xml, 'annulmentOperation', 'invoiceAnnulment');
    const hashes = ops.map((o) => invoiceHash('ANNUL', o.data));
    expect(hashes).toEqual([tag(xml, 'firstIndexHash')]);
    expect(requestSignature(tag(xml, 'requestId'), new Date(tag(xml, 'timestamp')), SAMPLE_SIGNING_KEY, hashes)).toBe(tag(xml, 'requestSignature'));
  });
});

describe('fake NAV server: its own (independent) implementation reproduces the same vectors', () => {
  it('specification example (1.5.1)', () => {
    expect(navTimestampMask('2017-12-30T18:25:45.000Z')).toBe('20171230182545');
    expect(navTimestampMask('2017-12-30T18:25:45Z')).toBe('20171230182545');
    const items = [
      { operation: 'CREATE', data: 'QWJjZDEyMzQ=' },
      { operation: 'MODIFY', data: 'RGNiYTQzMjE=' },
    ];
    expect(navExpectedSignature('TSTKFT1222564', '2017-12-30T18:25:45.000Z', 'ce-8f5e-215119fa7dd621DLMRHRLH2S', items)).toBe(
      '60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42',
    );
  });

  it('official request samples', () => {
    for (const file of ['tokenExchange.xml', 'queryTransactionStatus.xml', 'queryTaxpayer.xml']) {
      const xml = sample(file);
      expect(navExpectedSignature(tag(xml, 'requestId'), tag(xml, 'timestamp'), SAMPLE_SIGNING_KEY), file).toBe(tag(xml, 'requestSignature'));
    }
    const manage = sample('manageInvoice.xml');
    const invoiceItems = operations(manage, 'invoiceOperation', 'invoiceData').map((o) => ({ operation: o.op, data: o.data }));
    expect(navExpectedSignature(tag(manage, 'requestId'), tag(manage, 'timestamp'), SAMPLE_SIGNING_KEY, invoiceItems)).toBe(tag(manage, 'requestSignature'));
    const annul = sample('manageAnnulment.xml');
    const annulItems = operations(annul, 'annulmentOperation', 'invoiceAnnulment').map((o) => ({ operation: o.op, data: o.data }));
    expect(navExpectedSignature(tag(annul, 'requestId'), tag(annul, 'timestamp'), SAMPLE_SIGNING_KEY, annulItems)).toBe(tag(annul, 'requestSignature'));
  });
});

describe('exchange token (AES-128-ECB, PKCS#5/7 padding, key = exchange key bytes)', () => {
  const KEY = 'ce8f5e215119fa7d';
  const TOKEN = 'b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U'; // shape of the token in samples/api/manageInvoice.xml

  /** Independent construction: every 16-byte block encrypted on its own (ECB) + manual PKCS#7 padding. */
  function manualEcb(plain: string, key: string): string {
    const data = Buffer.from(plain, 'utf8');
    const pad = 16 - (data.length % 16);
    const padded = Buffer.concat([data, Buffer.alloc(pad, pad)]);
    const blocks: Buffer[] = [];
    for (let i = 0; i < padded.length; i += 16) {
      const c = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.alloc(16, 0));
      c.setAutoPadding(false);
      blocks.push(Buffer.concat([c.update(padded.subarray(i, i + 16)), c.final()]));
    }
    return Buffer.concat(blocks).toString('base64');
  }

  it('decodes a token encrypted block by block with PKCS#7 padding', () => {
    const encoded = manualEcb(TOKEN, KEY);
    expect(Buffer.from(encoded, 'base64').length).toBe(48 + 16); // 48 bytes → a full extra padding block
    expect(decodeExchangeToken(encoded, KEY)).toBe(TOKEN);
  });

  it('encodeExchangeToken is the exact inverse (what the NAV server does)', () => {
    expect(encodeExchangeToken(TOKEN, KEY)).toBe(manualEcb(TOKEN, KEY));
    for (const t of ['x', '0123456789abcdef', 'árvíztűrő-token-ŐŰ']) expect(decodeExchangeToken(encodeExchangeToken(t, KEY), KEY)).toBe(t);
  });

  it('tolerates line breaks in the base64 text', () => {
    const encoded = manualEcb(TOKEN, KEY);
    expect(decodeExchangeToken(`${encoded.slice(0, 20)}\n${encoded.slice(20)}`, KEY)).toBe(TOKEN);
  });

  it('fails with a wrong key or a key that is not 16 bytes', () => {
    const encoded = manualEcb(TOKEN, KEY);
    let decoded: string | null = null;
    try {
      decoded = decodeExchangeToken(encoded, 'XXXXXXXXXXXXXXXX');
    } catch {
      decoded = null;
    }
    expect(decoded).not.toBe(TOKEN);
    expect(() => decodeExchangeToken(encoded, 'short')).toThrow(/16 bytes/);
    expect(() => decodeExchangeToken('', KEY)).toThrow();
  });
});

describe('newRequestId', () => {
  it('matches common:EntityIdType ([+a-zA-Z0-9_]{1,30}) and is unique', () => {
    const ids = Array.from({ length: 2000 }, () => newRequestId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[+a-zA-Z0-9_]{1,30}$/);
  });
});
