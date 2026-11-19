/**
 * EX8 / P1-4: the payment ledger export (befizetési napló). export_invoices with ledger: true writes
 * befizetesek_<from>_<to>.json or .csv: every payment, refund and reversal dated in the period – the díjbekérők' too –, by
 * payment date, with the document it was recorded on, its kind and source, and the part each document received with its
 * proportional HUF net, VAT and gross and whether it counts by payment date (cash accounting). The CLI (export --ledger) and
 * the web Export page (Befizetési napló) offer it too.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/core/types.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { PAYMENT_BASIS_NOTE, type LedgerEntry, type OpenSzamla } from '../../src/service/app.ts';
import type { LineInput } from '../../src/service/inputs.ts';
import { DOMESTIC_CUSTOMER_INPUT, SELLER_INPUT, makeTestApp, paymentClock } from '../helpers/app.ts';
import { cli, removeTempDirs } from '../helpers/cli.ts';
import { startWeb, type WebEnv } from '../web/helpers.ts';

type Json = Record<string, any>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  removeTempDirs();
});

const line = (description: string, unitPrice: string, vatCode = '27'): LineInput => ({ description, quantity: '1', unit: 'db', unitPrice, vatCode }) as LineInput;

/** A cash-accounting seller: a díjbekérő paid and converted, a cash sale paid at issue, an invoice and its modification, a 0 Ft one. */
async function payments(app: OpenSzamla): Promise<Invoice[]> {
  app.updateSeller({ ...SELLER_INPUT, cashAccounting: true });
  const customerId = app.saveCustomer(DOMESTIC_CUSTOMER_INPUT).customer.id;
  const issue = async (lines: LineInput[], extra: Record<string, unknown> = {}, opts: { markPaid?: boolean } = {}): Promise<Invoice> =>
    (await app.issue((await app.createDraft({ customerId, lines, ...extra })).invoice.id, opts)).invoice;
  const proforma = await issue([line('Licenc', '100000')], { documentType: 'proforma' });
  app.recordPayment(proforma.id, { date: '2026-11-15' });
  const converted = (await app.issue((await app.createDraft({ copyFromId: proforma.id })).invoice.id)).invoice;
  const cash = await issue([line('Termék', '10000')], { paymentMethod: 'CASH' }, { markPaid: true });
  const original = await issue([line('Munka', '100000')]);
  const modification = (await app.issue((await app.createCorrectionDraft(original.id, { lines: [line('Pótdíj', '10000')], comment: 'pótdíj' })).invoice.id)).invoice;
  app.recordPayment(original.id, { amount: '139700', date: '2026-11-18' });
  app.recordPayment(original.id, { amount: '-700', date: '2026-11-19' });
  const zero = (await app.issue((await app.createCorrectionDraft(original.id, { lines: [line('Teljesítés dátuma helyesen', '0')], comment: 'dátum' })).invoice.id)).invoice;
  app.recordPayment(zero.id, { date: '2026-11-20' });
  return [proforma, converted, cash, original, modification, zero].map((i) => app.getInvoice(i.id));
}

describe('the payment ledger export (EX8, P1-4)', () => {
  it('JSON: every payment of the period with its kind, source and the parts of its chain, with the HUF shares', async () => {
    const clock = paymentClock('2026-11-14');
    const t = makeTestApp({ confirmMode: 'none', now: clock.now });
    clock.follow(t.app);
    cleanups.push(() => t.cleanup());
    const [proforma, converted, cash, original, modification, zero] = await payments(t.app);
    const r = t.app.exportInvoices({ from: '2026-11-01', to: '2026-11-30', format: 'json', ledger: true });
    expect([basename(r.path), r.count, r.dateBasis, r.ledger, r.warnings]).toEqual(['befizetesek_2026-11-01_2026-11-30.json', 6, 'payment', true, []]);
    expect(r.notes[1]).toBe(PAYMENT_BASIS_NOTE);
    const entries = JSON.parse(readFileSync(r.path, 'utf8')) as LedgerEntry[];
    expect(entries.map((e) => [e.date, e.recordedOn.number, e.amount, e.kind, e.source, e.reference])).toEqual([
      ['2026-11-15', proforma?.number, '127000', 'payment', 'manual', null],
      ['2026-11-15', converted?.number, '127000', 'payment', 'proforma', proforma?.number],
      // Issued after the díjbekérő payment was recorded on 11-15 (paymentClock): paid at issue, on its issue date.
      ['2026-11-15', cash?.number, '12700', 'payment', 'mark_paid', null],
      ['2026-11-18', original?.number, '139700', 'payment', 'manual', null],
      ['2026-11-19', original?.number, '-700', 'reversal', 'manual', null],
      ['2026-11-20', zero?.number, '0', 'settled', 'manual', null],
    ]);
    const parts = (e: LedgerEntry | undefined): unknown[] => (e?.allocations ?? []).map((a) => [a.invoice.number, a.amount, a.cashAccounting, a.huf]);
    expect(parts(entries[0])).toEqual([[proforma?.number, '127000', false, { net: '100000', vat: '27000', gross: '127000' }]]);
    expect(parts(entries[3])).toEqual([
      [original?.number, '127000', true, { net: '100000', vat: '27000', gross: '127000' }],
      [modification?.number, '12700', true, { net: '10000', vat: '2700', gross: '12700' }],
    ]);
    // The reversal takes back what reached the modification first.
    expect(parts(entries[4])).toEqual([[modification?.number, '-700', true, { net: '-551.18', vat: '-148.82', gross: '-700' }]]);
    expect(entries[5]?.allocations).toEqual([]);
    expect(t.app.auditLog({ limit: 1 }).items[0]).toMatchObject({ action: 'export', details: { dateBasis: 'payment', format: 'json', count: 6, ledger: true } });
  });

  it('CSV: one row per part, decimal comma; the CLI writes it with --ledger, and exports by payment date', async () => {
    const clock = paymentClock('2026-11-14');
    const t = makeTestApp({ confirmMode: 'none', now: clock.now });
    clock.follow(t.app);
    const [, , , original, modification] = await payments(t.app);
    const r = t.app.exportInvoices({ from: '2026-11-18', to: '2026-11-19', format: 'csv', ledger: true });
    const text = readFileSync(r.path, 'utf8');
    const [header, ...rows] = text.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(header).toBe('Befizetés dátuma;Befizetés azonosítója;Fajta;Forrás;Díjbekérő;Rögzítve a bizonylaton;Összeg;Pénznem;Bizonylat;Bizonylat típusa;Jutó összeg;Árfolyam;Nettó (HUF);ÁFA (HUF);Bruttó (HUF);Pénzforgalmi elszámolás');
    expect(rows.map((row) => row.split(';').filter((_, i) => i !== 1))).toEqual([
      ['2026-11-18', 'befizetés', 'rögzítve', '', `${original?.number}`, '139700', 'HUF', `${original?.number}`, 'számla', '127000', '1', '100000', '27000', '127000', 'igen'],
      ['2026-11-18', 'befizetés', 'rögzítve', '', `${original?.number}`, '139700', 'HUF', `${modification?.number}`, 'módosító számla', '12700', '1', '10000', '2700', '12700', 'igen'],
      ['2026-11-19', 'visszavonás', 'rögzítve', '', `${original?.number}`, '-700', 'HUF', `${modification?.number}`, 'módosító számla', '-700', '1', '-551,18', '-148,82', '-700', 'igen'],
    ]);
    // Wrong format or date basis for the ledger: refused, no file.
    expect(() => t.app.exportInvoices({ from: '2026-11-01', to: '2026-11-30', format: 'xml', ledger: true })).toThrow('A befizetési napló CSV vagy JSON formátumban exportálható.');
    expect(() => t.app.exportInvoices({ from: '2026-11-01', to: '2026-11-30', format: 'csv', ledger: true, dateBasis: 'issue' })).toThrow('A befizetési napló a befizetés dátuma szerint készül');
    const config = t.app.config;
    t.app.close();
    cleanups.push(() => t.cleanup());
    const run = await cli(['export', '--data-dir', config.dataDir, '--from', '2026-11-01', '--to', '2026-11-30', '--ledger', '--format', 'json']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`6 befizetés (befizetési napló, a befizetés dátuma szerint) → ${join(config.exportDir, 'befizetesek_2026-11-01_2026-11-30.json')}`);
    const byPayment = await cli(['export', '--data-dir', config.dataDir, '--from', '2026-11-01', '--to', '2026-11-30', '--date-basis', 'payment']);
    expect(byPayment.stdout).toContain(`4 számla (befizetés dátuma szerint) → ${join(config.exportDir, 'szamlak_befizetes_2026-11-01_2026-11-30.csv')}`);
    expect(byPayment.stdout).toContain(`  figyelem – ${PAYMENT_BASIS_NOTE}`);
  });

  it('MCP export_invoices ledger: true; the web Export page offers the payment basis and the ledger download', async () => {
    const clock = paymentClock('2026-11-14');
    const e: WebEnv = await startWeb({ now: clock.now });
    clock.follow(e.app);
    cleanups.push(() => e.close());
    await payments(e.app);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(e.app, { confirmMode: 'none' }), { transport: serverT });
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientT);
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    const r = ((await client.callTool({ name: 'export_invoices', arguments: { from: '2026-11-01', to: '2026-11-30', format: 'json', ledger: true } })) as Json).structuredContent as Json;
    expect([r.count, r.ledger, r.dateBasis]).toEqual([6, true, 'payment']);
    const schema = (await client.listTools()).tools.find((x) => x.name === 'export_invoices')?.inputSchema as Json;
    expect(schema.properties.ledger.type).toBe('boolean');

    const b = await e.loggedIn();
    const page = await b.get('/export');
    expect(page.body).toContain('<option value="payment">befizetés dátuma szerint (pénzforgalmi elszámolás)</option>');
    expect(page.body).toContain('name="format" value="ledger-csv"');
    expect(page.body).toContain('Befizetési napló (CSV)');
    const csv = await b.post('/export', { from: '2026-11-01', to: '2026-11-30', format: 'ledger-csv', dateBasis: 'issue' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="befizetesek_2026-11-01_2026-11-30.csv"');
    expect(csv.body).toContain('Befizetés dátuma;Befizetés azonosítója;Fajta');
    const json = await b.post('/export', { from: '2026-11-01', to: '2026-11-30', format: 'ledger-json' });
    expect((JSON.parse(json.body) as unknown[]).length).toBe(6);
    const byPayment = await b.post('/export', { from: '2026-11-01', to: '2026-11-30', format: 'csv', dateBasis: 'payment' });
    expect(byPayment.headers['content-disposition']).toBe('attachment; filename="szamlak_befizetes_2026-11-01_2026-11-30.csv"');
  });
});
