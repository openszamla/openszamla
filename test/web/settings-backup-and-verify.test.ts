/**
 * A backup and the integrity check without a terminal. Someone who uses only the web UI – or only the Claude Desktop
 * extension – had no way to make a backup or to run `verify`: both needed the command line. The Settings page has a
 * button for each, and the MCP server the backup_create and verify_integrity tools; the backup goes to a fixed place
 * (<data directory>/backups), never where a request says.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import type { OpenSzamla } from '../../src/service/app.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp } from '../helpers/app.ts';
import { flashesOf, formFields, startWeb, type WebEnv } from './helpers.ts';

type Json = Record<string, any>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function seed(app: OpenSzamla): Promise<string> {
  app.updateSeller(SELLER_INPUT);
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const d = await app.createDraft({ customerId, lines: [{ description: 'Tanácsadás', quantity: '1', unit: 'óra', unitPrice: '10000', vatCode: '27' }] });
  return (await app.issue(d.invoice.id)).invoice.id;
}

describe('the Settings page: backup and check', () => {
  it('"Mentés készítése most" writes a whole database into the backups folder and names it', async () => {
    const e: WebEnv = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
    cleanups.push(() => e.close());
    await seed(e.app);
    const b = await e.loggedIn();
    const page = await b.get('/settings');
    expect(page.body).toContain('<h2 id="h-safety">Mentés és ellenőrzés</h2>');
    const done = await b.follow(await b.post('/settings/backup', formFields(page.body, '/settings/backup')));
    expect(flashesOf(done.body)).toMatch(/^Mentés elkészült \(\d+,?\d* MB\)\.$/);
    const file = /A mentésfájl: ([^<]+)</.exec(done.body)?.[1] ?? '';
    expect(dirname(file)).toBe(join(e.app.config.dataDir, 'backups'));
    expect(existsSync(file)).toBe(true);
    // The backup is a database with the invoice in it.
    const copy = new Store({ path: file });
    try {
      expect(copy.listNumberedDocuments().map((d) => d.number)).toEqual(['SZ-2026-00001']);
    } finally {
      copy.close();
    }
    // A second one the same second gets its own name: nothing is overwritten.
    await b.follow(await b.post('/settings/backup', formFields(done.body, '/settings/backup')));
    expect(readdirSync(join(e.app.config.dataDir, 'backups')).filter((f) => f.endsWith('.db'))).toHaveLength(2);
  });

  it('"Adatbázis ellenőrzése" says "rendben", and names what was changed outside the program', async () => {
    const e: WebEnv = await startWeb({ now: () => new Date('2026-11-14T09:00:00.000Z') });
    cleanups.push(() => e.close());
    const id = await seed(e.app);
    const b = await e.loggedIn();
    const ok = await b.follow(await b.post('/settings/verify', formFields((await b.get('/settings')).body, '/settings/verify')));
    expect(flashesOf(ok.body)).toBe('Ellenőrzés: rendben – nem találtam a programon kívüli módosítás nyomát.');
    expect(ok.body).toContain('Ellenőrzött bizonylatok: 1; auditnapló: rendben');

    const raw = new DatabaseSync(e.app.config.dbPath);
    raw.prepare(`UPDATE invoices SET paid_amount = '12700', payment_status = 'paid' WHERE id = ?`).run(id);
    raw.close();
    const bad = await b.follow(await b.post('/settings/verify', formFields(ok.body, '/settings/verify')));
    expect(flashesOf(bad.body)).toBe('Ellenőrzés: ELTÉRÉST TALÁLT – az adatbázist a programon kívül módosíthatták.');
    expect(bad.body).toContain('A befizetési naplóval ellentmondó befizetett összegek:');
    expect(bad.body).toContain('SZ-2026-00001: a bizonylat befizetett összege');
  });
});

describe('MCP: backup_create and verify_integrity', () => {
  it('make a backup in the backups folder, and report the check with the lists verify prints', async () => {
    const t = makeTestApp({ confirmMode: 'none' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(t.app), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
      t.cleanup();
    });
    await seed(t.app);
    const call = async (name: string): Promise<Json> => {
      const raw = (await client.callTool({ name, arguments: {} })) as Json;
      expect(raw.isError, JSON.stringify(raw.structuredContent)).toBeFalsy();
      return raw.structuredContent as Json;
    };
    const backup = await call('backup_create');
    expect(dirname(backup.path)).toBe(join(t.app.config.dataDir, 'backups'));
    expect(existsSync(backup.path)).toBe(true);
    expect(backup.bytes).toBeGreaterThan(10_000);
    expect(backup.summary).toContain('openszamla restore');
    // The tool takes no path: where a file is written is not the caller's choice.
    const withPath = (await client.callTool({ name: 'backup_create', arguments: { path: join(t.dir, 'máshova.db') } })) as Json;
    expect(withPath.isError).toBe(true);
    expect(existsSync(join(t.dir, 'máshova.db'))).toBe(false);

    const check = await call('verify_integrity');
    expect(check).toMatchObject({ ok: true, invoicesChecked: 1, invoiceMismatches: [], numberingGaps: [], paymentMismatches: [], documentMismatches: [], warnings: [] });
    expect(check.summary).toMatch(/^Ellenőrzés: rendben – 1 bizonylat, \d+ naplóbejegyzés, 1 megőrzött eredeti PDF\.$/);
  });
});
