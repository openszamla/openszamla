/**
 * Many issued documents, fast: copies of an issued template written straight through the store (insertDraft +
 * markIssued, as issue() writes them) – no PDFs, NAV or audit entries – for the timing guards of the full scans and
 * the advance checks. And a timer that takes the best of a few runs, so a single slow run (GC, a busy machine) does not
 * decide a guard, with a way to measure a guard's ratios again before it fails.
 */
import { newId } from '../../src/core/ids.ts';
import type { Invoice } from '../../src/core/types.ts';
import { invoiceContentHash, type OpenSzamla } from '../../src/service/app.ts';

/** Writes `count` issued copies of `template` (numbers `${prefix}-1` …), in one transaction; `change` may adjust each. */
export function writeIssuedCopies(app: OpenSzamla, template: Invoice, count: number, prefix: string, change: (inv: Invoice, n: number) => void = () => undefined): Invoice[] {
  const out: Invoice[] = [];
  app.store.tx(() => {
    for (let n = 1; n <= count; n++) {
      const inv: Invoice = structuredClone(template);
      inv.id = newId('inv');
      inv.reference = template.reference ? { ...template.reference } : null;
      change(inv, n);
      inv.number = null;
      inv.status = 'draft';
      inv.issuedAt = null;
      inv.contentHash = null;
      inv.cancelledById = null;
      inv.paymentStatus = 'unpaid';
      inv.paidAmount = '0';
      inv.paidDate = null;
      app.store.insertDraft(inv);
      inv.number = `${prefix}-${n}`;
      inv.status = 'issued';
      inv.issuedAt = `${inv.issueDate}T10:00:00.000Z`;
      inv.contentHash = invoiceContentHash(inv);
      app.store.markIssued(inv);
      out.push(inv);
    }
  });
  return out;
}

/** The fastest of `runs` runs of `fn`, in ms (after one warm-up run). */
export async function bestOf(runs: number, fn: () => unknown): Promise<number> {
  await fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/**
 * The ratios of a timing guard, measured so that a busy machine cannot fail it by chance (other test files run in
 * parallel, CI machines are shared): `measure` is repeated – at most `attempts` times, and only while a ratio is not
 * under its limit – and every ratio keeps its lowest value. A real regression is over the limit in every measurement;
 * a slow moment is not. `measured` holds every measurement, for the message of a failing guard.
 */
export async function lowestRatios<K extends string>(
  limits: Record<K, number>,
  measure: () => Promise<Record<K, number>>,
  attempts = 4,
): Promise<{ lowest: Record<K, number>; measured: Array<Record<K, number>> }> {
  const keys = Object.keys(limits) as K[];
  const lowest = Object.fromEntries(keys.map((k) => [k, Number.POSITIVE_INFINITY])) as Record<K, number>;
  const measured: Array<Record<K, number>> = [];
  for (let i = 0; i < attempts && keys.some((k) => !(lowest[k] < limits[k])); i++) {
    const ratios = await measure();
    measured.push(ratios);
    for (const k of keys) lowest[k] = Math.min(lowest[k], ratios[k]);
  }
  return { lowest, measured };
}
