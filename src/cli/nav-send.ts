/**
 * openszamla nav-send-to-configured-environment <sorszám|id> [--confirm]: sends one invoice whose NAV state belongs to
 * the other NAV system (e.g. reported only to the TEST one) to the configured one, as a new submission – what
 * nav_send_to_configured_environment does over MCP. It always prints what that means first; without --confirm it sends
 * nothing (CONFIRMATION_REQUIRED). The rule – which invoice, bound to what was shown – is the service's.
 */
import { AppError } from '../core/errors.ts';
import type { OpenSzamla } from '../service/app.ts';
import { navSendCommandLine } from '../service/config.ts';

/** Runs the command; returns the exit code (0: reported to, or being processed by, the configured NAV system). */
export async function navSendToConfiguredEnvironment(app: OpenSzamla, idOrNumber: string, opts: { confirm: boolean; dataDir: string }, out: (line: string) => void): Promise<number> {
  const resend = app.requireNavForeignResend(idOrNumber);
  out(resend.summary);
  const target = resend.sendTo === 'production' ? 'az éles' : 'a TESZT';
  if (!opts.confirm) {
    throw new AppError('CONFIRMATION_REQUIRED', 'Nem küldtem be: a másik NAV-rendszerhez tartozó számla beküldéséhez kifejezett megerősítés kell (--confirm).', {
      hint: `Ha ez valódi számla, és ${target} NAV-rendszerbe is be kell küldeni: ${navSendCommandLine(resend.number ?? resend.invoiceId, opts.dataDir)}`,
    });
  }
  const [r] = await app.navSync({ invoiceId: resend.invoiceId, resubmitFailed: true, confirmedForeign: resend.fingerprint });
  if (!r) return 1;
  out(`${r.number ?? r.invoiceId}: ${r.navStatus} (${r.environment === 'production' ? 'éles' : 'TESZT'} rendszer) – ${r.note}`);
  const reported = r.environment === resend.sendTo && (r.navStatus === 'done' || r.navStatus === 'done_with_warnings' || r.navStatus === 'processing');
  return reported ? 0 : 1;
}
