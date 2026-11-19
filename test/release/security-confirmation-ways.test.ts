/**
 * C10: SECURITY.md names every way an irreversible operation (issuing, storno, sending an invoice of the other NAV
 * system) is confirmed – the MCP confirmation code, the elicit dialog on top of it, the none mode without either, the
 * command line's explicit --confirm and the web UI's own confirmation step – and keeps the security notes of this
 * release: blank-rendering storno reasons, secrets typed ahead, an altered original PDF.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8').replace(/\s*\n\s*/g, ' ');

describe('SECURITY.md (C10)', () => {
  it('names every way an irreversible operation is confirmed', () => {
    const part = security.slice(security.indexOf('Visszafordíthatatlan művelet'), security.indexOf('A PDF másolása'));
    for (const s of [
      'szerver által kiadott, az előnézethez kötött, lejáró megerősítő kóddal',
      '`elicit` módban ezen felül a felhasználó párbeszédben adott jóváhagyásával',
      '`OPENSZAMLA_CONFIRM_MODE=none`',
      'kód és párbeszéd nélkül',
      '`openszamla nav-send-to-configured-environment <sorszám> --confirm`',
      'nélküle a parancs csak kiírja, mit jelentene',
      '**Webes felület:**',
      'kötelezően bejelölendő jelölőnégyzet',
      'A másik NAV-rendszerhez tartozó számlát a webes felület nem küldi be.',
    ]) {
      expect(part, s).toContain(s);
    }
  });

  it('keeps the security notes of the release', () => {
    expect(security).toContain('U+3164');
    expect(security).toContain('a titkos adat kérdése előtt elveti');
    expect(security).toContain('DOCUMENT_INTEGRITY_FAILED');
    expect(security).toContain('…_KORABBI_<időbélyeg>.pdf');
  });
});
