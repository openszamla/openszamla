/**
 * "/export": period export of the issued invoices (service: exportInvoices). CSV and JSON are also
 * offered as a download of the file the service wrote; the NAV XML export is a folder, so only its
 * location is shown. The payment ledger of the period (exportInvoices ledger) is offered as CSV and JSON too. The
 * statutory tax-audit export (taxAuditExport) has its own form: it writes a folder, whose location is shown.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isAppError } from '../../core/errors.ts';
import type { DateBasis } from '../../service/app.ts';
import { csrfInput, day, inputField, selectField } from '../components.ts';
import { failure, renderPage, type Ctx } from '../context.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { sendDownload } from '../io.ts';
import type { Flash } from '../layout.ts';

const FORMATS = {
  csv: { label: 'CSV letöltése (Excel)', type: 'text/csv; charset=utf-8' },
  json: { label: 'JSON letöltése', type: 'application/json; charset=utf-8' },
  xml: { label: 'NAV XML fájlok készítése', type: '' },
  // The payment ledger of the period (by payment date, whatever the date basis chosen).
  'ledger-csv': { label: 'Befizetési napló (CSV)', type: 'text/csv; charset=utf-8' },
  'ledger-json': { label: 'Befizetési napló (JSON)', type: 'application/json; charset=utf-8' },
} as const;
type ExportFormat = keyof typeof FORMATS;

/** Which date of an invoice the period is compared with (service: DateBasis). */
const DATE_BASIS: Readonly<Record<DateBasis, string>> = {
  issue: 'kelte szerint',
  fulfillment: 'teljesítés dátuma szerint (ÁFA-időszak)',
  payment: 'befizetés dátuma szerint (pénzforgalmi elszámolás)',
};

function isFormat(v: string | null): v is ExportFormat {
  return v !== null && Object.hasOwn(FORMATS, v);
}

function dateBasisOf(v: string | null): DateBasis {
  return v !== null && Object.hasOwn(DATE_BASIS, v) ? (v as DateBasis) : 'issue';
}

export function exportPage(
  ctx: Ctx,
  o: { from?: string; to?: string; dateBasis?: DateBasis; flash?: Flash; status?: number; audit?: { from: string; to: string; fromNumber: string; toNumber: string } } = {},
): void {
  const today = ctx.app.today();
  const from = o.from ?? `${today.slice(0, 7)}-01`;
  const to = o.to ?? today;
  renderPage(ctx, {
    title: 'Export',
    active: 'export',
    ...(o.status === undefined ? {} : { status: o.status }),
    ...(o.flash ? { flashes: [o.flash] } : {}),
    main: html`<div class="page-head"><div><h1>Export könyvelőnek</h1><p class="sub">A megadott időszak kiállított számlái (díjbekérők nélkül), a kelte vagy a teljesítés dátuma szerint.</p></div></div>
<section class="card"><form method="post" action="/export" aria-label="Export">${csrfInput(ctx)}<div class="grid">
${inputField({ name: 'from', label: 'Időszak kezdete', type: 'date', value: from, required: true })}
${inputField({ name: 'to', label: 'Időszak vége', type: 'date', value: to, required: true })}
${selectField({
  name: 'dateBasis',
  label: 'Melyik dátum szerint',
  value: o.dateBasis ?? 'issue',
  options: Object.entries(DATE_BASIS),
  hint: 'Az ÁFA főszabály szerint a teljesítés napján keletkezik: a hónap végi teljesítésről a következő hónapban kiállított számla teljesítés szerint az előző hónapba tartozik. Pénzforgalmi elszámolásnál az adó a befizetéskor esedékes (Áfa tv. 196/B. §): a befizetés dátuma szerinti válogatás a pénzforgalmi elszámolással kiállított bizonylatok közül azokat adja, amelyekre az időszakban befizetés érkezett. A befizetési napló mindig a befizetés dátuma szerint készül.',
})}
</div>
<div class="actions">${(Object.keys(FORMATS) as ExportFormat[]).map(
      (f) => html`<button class="btn${f === 'csv' ? ' btn-primary' : ''}" type="submit" name="format" value="${f}">${icon(f === 'xml' ? 'file' : 'download')}${FORMATS[f].label}</button>`,
    )}</div>
<p class="hint">A fájl a szerver export-mappájába is mentésre kerül: <span class="mono">${ctx.app.config.exportDir}</span>. A CSV pontosvesszővel tagolt, magyar fejlécekkel (Excelben közvetlenül megnyitható), a kelte és a teljesítés dátuma is benne van; a NAV XML a számlák adatszolgáltatási formátuma, számlánként egy fájl. A befizetési napló az időszak minden befizetését, visszafizetését és visszavonását tartalmazza a befizetés dátuma szerint: melyik bizonylatra mennyi jutott belőle, forintban arányos nettó, ÁFA és bruttó értékkel.</p>
</form></section>
<section class="card" aria-labelledby="h-audit-export"><h2 id="h-audit-export">Adóhatósági ellenőrzési adatszolgáltatás</h2>
<p class="muted">Adóellenőrzéskor a számlázó programnak ki kell tudnia adni a kiállított számlák adatait a 23/2014. NGM rendelet 3. melléklete szerinti XML-ben. Az export egy mappát készít a szerveren: <span class="mono">szamlak.xml</span>, a számlák NAV-adata és PDF-je, valamint egy leírás (OLVASSEL.txt).</p>
<form method="post" action="/export/tax-audit" aria-label="Adóhatósági ellenőrzési adatszolgáltatás">${csrfInput(ctx)}<div class="grid">
${inputField({ name: 'auditFrom', label: 'Időszak kezdete (kelte)', type: 'date', value: o.audit?.from ?? from })}
${inputField({ name: 'auditTo', label: 'Időszak vége (kelte)', type: 'date', value: o.audit?.to ?? to })}
${inputField({ name: 'fromNumber', label: 'vagy: kezdő sorszám', value: o.audit?.fromNumber ?? '', hint: 'Sorszámtartományhoz mindkét sorszámot add meg (ugyanabból a sorszámtartományból); ilyenkor a dátumok nem számítanak.', extra: { autocomplete: 'off', maxlength: 64 } })}
${inputField({ name: 'toNumber', label: 'záró sorszám', value: o.audit?.toNumber ?? '', extra: { autocomplete: 'off', maxlength: 64 } })}
</div>
<div class="actions"><button class="btn" type="submit">${icon('file')}Adatszolgáltatás készítése</button></div>
<p class="hint">Több ezer bizonylatnál az elkészítés percekig tarthat (minden számla PDF-je is belekerül): ilyenkor a parancssor a javasolt mód – <span class="mono">openszamla adohatosagi-export --from … --to …</span>.</p>
</form></section>`,
  });
}

/** The statutory tax-audit export (service: taxAuditExport): by issue-date range, or – when both numbers are given – by number range. */
export async function runTaxAuditExport(ctx: Ctx): Promise<void> {
  const g = (n: string): string => (ctx.form.get(n) ?? '').trim();
  const audit = { from: g('auditFrom'), to: g('auditTo'), fromNumber: g('fromNumber'), toNumber: g('toNumber') };
  const byNumber = audit.fromNumber !== '' || audit.toNumber !== '';
  try {
    const r = await ctx.app.taxAuditExport(byNumber ? { fromNumber: audit.fromNumber, toNumber: audit.toNumber } : { from: audit.from, to: audit.to }, 'web');
    exportPage(ctx, {
      audit,
      flash: {
        tone: r.warnings.length ? 'warn' : 'ok',
        title: `Az adóhatósági ellenőrzési adatszolgáltatás elkészült: ${r.count} számla (${byNumber ? `${r.numberFrom} – ${r.numberTo}` : `${day(r.rangeFrom)} – ${day(r.rangeTo)}`}).`,
        lines: [`Mappa a szerveren: ${r.path}`, ...r.warnings.map((w) => `${w.invoiceNumber} (${w.field}): ${w.message}`)],
      },
    });
  } catch (e) {
    exportPage(ctx, { audit, status: isAppError(e) ? 422 : 500, flash: failure(ctx, e) });
  }
}

export function runExport(ctx: Ctx): void {
  const from = (ctx.form.get('from') ?? '').trim();
  const to = (ctx.form.get('to') ?? '').trim();
  const dateBasis = dateBasisOf(ctx.form.get('dateBasis'));
  const format = ctx.form.get('format');
  if (!isFormat(format)) {
    return exportPage(ctx, { from, to, dateBasis, status: 422, flash: { tone: 'err', title: 'Válassz export formátumot (CSV, JSON vagy NAV XML).' } });
  }
  try {
    const ledger = format === 'ledger-csv' || format === 'ledger-json';
    const r = ledger
      ? ctx.app.exportInvoices({ from, to, format: format === 'ledger-csv' ? 'csv' : 'json', ledger: true }, 'web')
      : ctx.app.exportInvoices({ from, to, format, dateBasis }, 'web');
    if (format === 'xml') {
      return exportPage(ctx, {
        from,
        to,
        dateBasis,
        flash: {
          tone: r.warnings.length || r.notes.length ? 'warn' : 'ok',
          title: `${r.count} számla NAV XML fájlja elkészült (${day(from)} – ${day(to)}, ${DATE_BASIS[dateBasis]}).`,
          // Invoices left out because their NAV XML cannot be built; files named with the invoice id too.
          lines: [`Mappa a szerveren: ${r.path}`, ...r.warnings.map((w) => `${w.invoiceNumber}: ${w.message}`), ...r.notes],
        },
      });
    }
    sendDownload(ctx.res, FORMATS[format].type, basename(r.path), readFileSync(r.path));
  } catch (e) {
    exportPage(ctx, { from, to, dateBasis, status: isAppError(e) ? 422 : 500, flash: failure(ctx, e) });
  }
}
