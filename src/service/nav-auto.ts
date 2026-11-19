/**
 * NAV reporting that finishes on its own. A report is due at once (Áfa tv. 10. melléklet 13.), but issuing waits only
 * a short while for NAV: an invoice whose report failed on an outage, whose answer was lost, or whose result came after
 * that wait stayed "pending" or "processing" until someone ran nav_sync – or forgot to. A running server (`openszamla
 * serve`, the stdio MCP server an AI client starts) now looks every few minutes and carries on with what was started.
 *
 * What it does is deliberately narrow:
 * - only when NAV is configured and usable, and reports are sent automatically (navAutoSubmit);
 * - only invoices that already have a submission attempt in the configured NAV system: retried after a transient
 *   failure, reconciled after an unknown outcome, polled while NAV processes them. An invoice never sent – issued
 *   with submitToNav: false, or before NAV was set up – is never sent first by the background run;
 * - never what needs a decision: a rejected report (resubmitFailed), an invoice of the other NAV system;
 * - one run at a time, within a time limit; a pause NAV asked for (Retry-After) is kept by navSync itself;
 * - it never throws and never writes to stdout (the stdio server's stdout carries JSON-RPC only).
 */
import type { OpenSzamla } from './app.ts';

/** The first look after a server starts, and the time between two looks. */
export const NAV_AUTO_SYNC_FIRST_MS = 20_000;
export const NAV_AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
/** One background run takes at most this long (as a nav_sync call an MCP client makes). */
const RUN_BUDGET_MS = 45_000;

export interface NavAutoSync {
  /** Stops the timers; a run in progress finishes. */
  stop(): void;
  /** One look now (what the timer does) – resolves when it is over. */
  runOnce(): Promise<void>;
}

export function startNavAutoSync(app: OpenSzamla, opts: { firstDelayMs?: number; intervalMs?: number; log?: (line: string) => void } = {}): NavAutoSync {
  const log = opts.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  let running = false;
  let stopped = false;
  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const cfg = app.config;
      if (!cfg.nav || cfg.navProblem || !cfg.navAutoSubmit) return;
      if (app.status().counts.navPending === 0) return;
      const results = await app.navSync({ waitSeconds: 8, budgetMs: RUN_BUDGET_MS, onlyAttempted: true }, 'system');
      // The run's targets are invoices still to settle: those accepted now were settled by this run.
      const reported = results.filter((r) => r.navStatus === 'done' || r.navStatus === 'done_with_warnings').length;
      if (reported > 0) log(`[openszamla] automatikus NAV-szinkron: ${reported} számla jelentése rendben lezárult.`);
    } catch (e) {
      // The database closed under a late tick, NAV out of reach …: the next look tries again.
      if (!stopped) log(`[openszamla] automatikus NAV-szinkron: most nem sikerült (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      running = false;
    }
  };
  // unref: the timers never keep the process alive on their own.
  const first = setTimeout(() => void runOnce(), opts.firstDelayMs ?? NAV_AUTO_SYNC_FIRST_MS);
  first.unref();
  const timer = setInterval(() => void runOnce(), opts.intervalMs ?? NAV_AUTO_SYNC_INTERVAL_MS);
  timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    runOnce,
  };
}
