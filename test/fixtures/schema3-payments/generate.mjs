// Builds database.sql: a database of schema 3 with payments, made by OpenSzámla before the payment ledger (the tree of
// commit 8e9ed092e262237899b009caab36b298dcdbd0be), dumped as SQL. test/db/payment-ledger-migration.test.ts migrates it.
//
//   git archive 8e9ed092e262237899b009caab36b298dcdbd0be | tar -x -C <dir>
//   node test/fixtures/schema3-payments/generate.mjs <dir> test/fixtures/schema3-payments/database.sql
//
// The PDF renderer of that tree is replaced by one that fails (registerHooks below): no original PDF is kept, which
// keeps the dump small; the payments are what matters here. Node.js 24 (module.registerHooks, type stripping).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [baseDir, outFile] = process.argv.slice(2);
if (!baseDir || !outFile) throw new Error('usage: generate.mjs <tree of 8e9ed09> <database.sql>');
const base = pathToFileURL(`${resolve(baseDir)}/`).href;

registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url === `${base}src/pdf/render.ts`) {
      const stub = 'export const DEFAULT_SOFTWARE_NAME = "OpenSzámla"; export async function renderInvoicePdf() { throw new Error("no PDF in the fixture"); }';
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return r;
  },
});

const { OpenSzamla } = await import(`${base}src/service/app.ts`);
const { loadConfig } = await import(`${base}src/service/config.ts`);

const dir = mkdtempSync(join(tmpdir(), 'openszamla-schema3-'));
let now = new Date('2026-11-14T09:00:00.000Z');
const at = (iso) => {
  now = new Date(iso);
};
const config = loadConfig({ dataDir: dir, env: {}, overrides: { nav: null, confirmMode: 'none' } });
const app = OpenSzamla.open({ config, now: () => now });
const line = (description, quantity, unitPrice, vatCode = '27', extra = {}) => ({ description, quantity, unit: 'db', unitPrice, vatCode, ...extra });
const issue = async (input, opts = {}) => (await app.issue((await app.createDraft(input)).invoice.id, opts)).invoice;
const correct = async (original, lines) => (await app.issue((await app.createCorrectionDraft(original.id, { lines, comment: 'Javítás' })).invoice.id)).invoice;
try {
  app.updateSeller({
    name: 'Pénzforgalmi Teszt Kft.',
    taxNumber: '12345676-2-42',
    euVatNumber: 'HU12345676',
    address: { countryCode: 'HU', postalCode: '1117', city: 'Budapest', addressLine: 'Irinyi József utca 4.' },
    bankAccount: '12345676-11111111',
    email: 'szamla@penzforgalmi.hu',
    vatStatus: 'normal',
    cashAccounting: true,
  });
  const customerId = app.saveCustomer({
    vatStatus: 'DOMESTIC',
    name: 'Árvíztűrő Tükörfúrógép Zrt.',
    taxNumber: '87654323-2-13',
    address: { countryCode: 'HU', postalCode: '2000', city: 'Szentendre', addressLine: 'Fő tér 1.' },
  }).customer.id;

  // 2026-11-14 – SZ-1 (A): 137 000 (100 000 + 27% and 10 000 TAM) and its +12 700 modification SZ-2, paid on the original.
  const a = await issue({ customerId, lines: [line('Szolgáltatás', '1', '100000'), line('Oktatás', '1', '10000', 'TAM', { vatReason: 'Áfa tv. 85. § (1) i)' })] });
  await correct(a, [line('Pótdíj', '1', '10000')]);
  // SZ-3 (B): 127 000, paid in two parts recorded out of order (below).
  const b = await issue({ customerId, lines: [line('Munka', '1', '100000')] });
  // DB-1 (D): a díjbekérő of 127 000.
  const d0 = await issue({ documentType: 'proforma', customerId, lines: [line('Licenc', '1', '100000')] });
  // SZ-4 (E): 190 500 and its −38 100 credit note SZ-5.
  const e = await issue({ customerId, lines: [line('Fejlesztés', '10', '15000')] });
  await correct(e, [line('Fejlesztés', '-2', '15000')]);
  // SZ-6 (F): a cash sale paid at issue.
  await issue({ customerId, paymentMethod: 'CASH', lines: [line('Termék', '1', '10000')] }, { markPaid: true });
  // SZ-7 (G): 38 100 and a 0 Ft modification SZ-8 (only marked settled).
  const g = await issue({ customerId, lines: [line('Tanácsadás', '2', '15000')] });
  const g1 = await correct(g, [line('Teljesítés dátuma helyesen: 2026.11.13.', '1', '0')]);
  // SZ-9 (H): 127 000 – a payment and its reversal, then an overpayment and a reversal of the surplus.
  const h = await issue({ customerId, lines: [line('Munka', '1', '100000')] });
  // SZ-10 (I): 1270 EUR at 400 HUF/EUR, paid in part.
  const i = await issue({ customerId, currency: 'EUR', exchangeRate: '400', lines: [line('Consulting', '1', '1000')] });

  at('2026-11-15T09:00:00.000Z');
  app.recordPayment(h.id, { amount: '4000', date: '2026-11-15' });
  app.recordPayment(h.id, { amount: '-4000', date: '2026-11-15' });
  at('2026-11-16T09:00:00.000Z');
  app.recordPayment(d0.id, { amount: '50000', date: '2026-11-16' });
  // SZ-11 (D): the invoice made from DB-1 – its 50 000 is carried over – and its +12 700 modification SZ-12.
  const d = await issue({ copyFromId: d0.id });
  at('2026-11-17T09:00:00.000Z');
  await correct(d, [line('Licenc bővítés', '1', '10000')]);
  at('2026-11-18T09:00:00.000Z');
  app.recordPayment(h.id, { amount: '200000', date: '2026-11-18' });
  at('2026-11-19T09:00:00.000Z');
  app.recordPayment(h.id, { amount: '-73000', date: '2026-11-19' });
  at('2026-11-20T09:00:00.000Z');
  app.recordPayment(a.id, { amount: '50000', date: '2026-11-20' });
  at('2026-11-21T09:00:00.000Z');
  app.recordPayment(e.id, { amount: '152400', date: '2026-11-21' });
  at('2026-11-22T09:00:00.000Z');
  app.recordPayment(i.id, { amount: '500', date: '2026-11-22' });
  at('2026-11-25T09:00:00.000Z');
  app.recordPayment(g1.id, {});
  app.recordPayment(g.id, { date: '2026-11-25' });
  // SZ-13 (J): issued after the seller left cash accounting, paid in full.
  app.updateSeller({ cashAccounting: false });
  const j = await issue({ customerId, lines: [line('Szolgáltatás', '1', '100000')] });
  app.recordPayment(j.id, { date: '2026-11-26' });
  app.updateSeller({ cashAccounting: true });
  at('2026-12-05T09:00:00.000Z');
  app.recordPayment(a.id, { date: '2026-12-05' });
  // SZ-14 (C): 254 000, 100 000 paid, then cancelled by its storno SZ-15.
  at('2026-12-06T09:00:00.000Z');
  const c = await issue({ customerId, lines: [line('Gép', '1', '200000')] });
  app.recordPayment(c.id, { amount: '100000', date: '2026-12-06' });
  await app.cancel(c.id, { reason: 'visszáru' });
  at('2026-12-10T09:00:00.000Z');
  app.recordPayment(b.id, { amount: '27000', date: '2026-12-08' });
  app.recordPayment(b.id, { date: '2026-11-20' });
} finally {
  app.close();
}

// The dump: the tables, their rows (foreign keys off while loading), then the indexes and the triggers.
const db = new DatabaseSync(config.dbPath);
const quote = (v) => {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  throw new Error(`unexpected value: ${typeof v}`);
};
const out = ['-- OpenSzámla schema 3 with payments (see generate.mjs). Generated; do not edit.', 'PRAGMA foreign_keys = OFF;', 'BEGIN;'];
const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY rowid`).all();
for (const t of objects.filter((o) => o.type === 'table')) out.push(`${t.sql};`);
for (const t of objects.filter((o) => o.type === 'table')) {
  const order = /WITHOUT ROWID/i.test(t.sql) ? '' : ' ORDER BY rowid';
  for (const row of db.prepare(`SELECT * FROM "${t.name}"${order}`).all()) {
    out.push(`INSERT INTO "${t.name}" (${Object.keys(row).map((k) => `"${k}"`).join(', ')}) VALUES (${Object.values(row).map(quote).join(', ')});`);
  }
}
for (const o of objects.filter((x) => x.type === 'index' || x.type === 'trigger')) out.push(`${o.sql};`);
out.push('COMMIT;', '');
db.close();
rmSync(dir, { recursive: true, force: true });
const text = out.join('\n');
if (text.includes('\r')) throw new Error('the dump holds a CR');
writeFileSync(outFile, text);
console.log(`${outFile}: ${text.length} bytes`);
