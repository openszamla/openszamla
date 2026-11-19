/**
 * NAV results and waits in the words of the web UI. The service's notes (NavInvoiceResult.note, navWaitReason) are
 * worded for agents and the CLI (nav_sync, invoice_get …); the web says the same from the structured values – the NAV
 * status, the stop of the run (notProcessed), the NAV system, the codes of the program's own NAV messages, NavWait –
 * and names its own buttons instead.
 */
import type { Invoice, NavMessage } from '../core/types.ts';
import type { NavInvoiceResult, NavWait } from '../service/app.ts';

/** The send button of the dashboard, as the texts name it. */
export const SEND_BUTTON = '„Függő számlák beküldése a NAV-nak”';

/** Codes of the program's own NAV messages (user doc 6.15). */
const UNCERTAIN = 'OPENSZAMLA_UNCERTAIN';
const COLLISION = 'OPENSZAMLA_NUMBER_COLLISION';
const BLOCKED = 'OPENSZAMLA_RECONCILE_BLOCKED';

const has = (messages: readonly NavMessage[], code: string): boolean => messages.some((m) => m.code === code);

/** "a(z) SZ-2026-00002" – the original's number (its id when it has none). */
function numberOf(w: NavWait): string {
  return w.originalNumber ?? w.originalId;
}

/**
 * Why a correction (`what`: "Ez a sztornó számla", "Ez a módosító számla") waits for its original, and what to do. The
 * page links the original next to it. `configured`: the NAV system the program reports to now.
 */
export function navWaitText(w: NavWait, what: string, configured: 'test' | 'production' | null): string {
  const n = numberOf(w);
  switch (w.reason) {
    case 'other_environment':
      return configured === 'test'
        ? `${what} a TESZT környezetben nem küldhető be: az eredeti számla (${n}) az éles NAV-rendszerhez tartozik. Az éles jelentéséhez a program gépén vissza kell állítani az éles környezetet.`
        : `${what} az eredeti számlára vár: a(z) ${n} csak a NAV TESZT rendszerében van, az éles rendszerbe nincs jelentve, a NAV pedig a javító számlát csak az eredeti után fogadja be. ` +
            `Ha az eredeti valódi számla, előbb azt küldd be az éles rendszerbe (lásd az eredeti számla oldalán); utána a ${SEND_BUTTON} gomb ezt is beküldi.`;
    case 'rejected':
      return `${what} az eredeti számlára vár: a(z) ${n} NAV-jelentését a NAV elutasította, vagy hibával zárult. Nyisd meg az eredeti számlát, hárítsd el a hiba okát, és küldd újra – utána ez is beküldésre kerül.`;
    case 'collision':
      return `${what} nem küldhető be: az eredeti számla (${n}) sorszáma a NAV-nál egy másik számláé (sorszám-ütközés), így a NAV ezt a másikhoz kötné. A teendőt az eredeti számla NAV-üzenetei írják le; a rendezéséhez kérj segítséget (könyvelő).`;
    case 'blocked':
      return `${what} az eredeti számlára vár: a(z) ${n} NAV-jelentését a program nem tudja egyeztetni a NAV-val (a NAV lekérdezése végleges hibát ad). A teendőt az eredeti számla NAV-üzenetei írják le; utána ez is beküldésre kerül.`;
    case 'processing':
      return `${what} az eredeti számlára vár: a(z) ${n} feldolgozása a NAV-nál még tart. Utána a ${SEND_BUTTON} gomb ezt is beküldi.`;
    case 'pending':
      return `${what} az eredeti számlára vár: előbb a(z) ${n} számlát kell jelenteni a NAV-nak. A ${SEND_BUTTON} gomb sorban mindkettőt beküldi.`;
  }
}

/** "Ez a sztornó számla" / "Ez a módosító számla" / "Ez a számla" – the subject of a wait text. */
export function thisDocument(inv: Pick<Invoice, 'documentType'>): string {
  return inv.documentType === 'storno' ? 'Ez a sztornó számla' : inv.documentType === 'modification' ? 'Ez a módosító számla' : 'Ez a számla';
}

/**
 * What one NAV run did with an invoice (NavInvoiceResult), in a sentence. `configured`: the NAV system reported to;
 * `wait`: why the correction waits for its original (OpenSzamla.navWait), when it does.
 */
export function navResultText(r: NavInvoiceResult, configured: 'test' | 'production' | null, wait: NavWait | null = null, what = 'Ez a számla'): string {
  if (r.notProcessed === 'time') return 'A rendelkezésre álló idő letelt, mielőtt a program ennél a számlánál a NAV-hoz fordult volna – az állapota nem változott, a beküldést később indítsd újra.';
  if (r.notProcessed === 'outage') return 'A NAV most nem érhető el, ezért a program ennél a számlánál nem fordult hozzá – az állapota nem változott, később próbáld újra.';
  if (r.notProcessed === 'pause') return 'A NAV szünetet kért, ezért a program most nem küld be és nem kérdez le semmit – az állapota nem változott; a szünet után próbáld újra.';
  if (configured && r.environment !== configured) {
    return 'A számla NAV-állapota a másik NAV-rendszerhez tartozik, ezért a webes felület nem küldte be – a számla oldalának NAV része leírja, mi a teendő.';
  }
  const test = r.environment === 'test';
  const there = test ? 'A NAV TESZT rendszere' : 'A NAV';
  switch (r.navStatus) {
    case 'done':
      return test ? 'A NAV TESZT rendszere befogadta – éles adatszolgáltatás NEM történt.' : 'A NAV befogadta.';
    case 'done_with_warnings':
      return `${there} befogadta, de figyelmeztetést adott – nézd meg a számla NAV részében.${test ? ' Éles adatszolgáltatás NEM történt.' : ''}`;
    case 'aborted':
      if (has(r.messages, BLOCKED)) return 'A program nem tudja egyeztetni a NAV-val, mi van ebből a számlából a NAV-nál (a NAV lekérdezése végleges hibát ad): a teendőt a számla NAV-üzenetei írják le.';
      if (has(r.messages, COLLISION)) return `Sorszám-ütközés: ${test ? 'a NAV TESZT rendszere' : 'a NAV'} ezzel a sorszámmal egy másik számlát tárol, ez a számla nincs jelentve – a teendőt a számla NAV-üzenetei írják le (az újraküldés nem segít).`;
      return `${there} elutasította: az okát a számla NAV részében, a NAV üzeneteinél olvashatod. A hiba javítása után küldd újra.`;
    case 'error':
      if (has(r.messages, BLOCKED)) return 'A program nem tudja egyeztetni a NAV-val, mi van ebből a számlából a NAV-nál (a NAV lekérdezése végleges hibát ad): a teendőt a számla NAV-üzenetei írják le.';
      return 'Végleges hiba (pl. hibás hitelesítő adatok): az okát a számla NAV-üzenetei írják le; elhárítása után küldd újra.';
    case 'processing':
      return `${there} még feldolgozza – később kérdezd le újra az állapotát.`;
    case 'pending':
      if (wait) return navWaitText(wait, what, configured);
      if (has(r.messages, UNCERTAIN)) return 'A beküldés eredménye bizonytalan (a NAV megkaphatta): a program legalább 5 perc múlva ellenőrzi a NAV-nál, és csak akkor küldi újra, ha nem érkezett meg.';
      return 'Átmeneti hiba miatt nem sikerült elküldeni – később próbáld újra.';
    case 'not_configured':
      return 'A NAV-kapcsolat nincs beállítva.';
    default:
      return 'Nincs teendő.';
  }
}
