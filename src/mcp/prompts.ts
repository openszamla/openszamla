/** MCP prompts – reusable, guided workflows (Claude Code shows them as /mcp__openszamla__<name>). */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function user(text: string): { messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'szamla_kiallitas',
    {
      title: 'Számla kiállítása',
      description: 'Végigvezet egy számla kiállításán: vevő, tételek, ellenőrzés, jóváhagyás, kiállítás, PDF, NAV.',
      argsSchema: z.object({
        vevo: z.string().optional().describe('A vevő neve vagy adószáma'),
        tetelek: z.string().optional().describe('Mit számlázunk (szabad szöveg)'),
      }),
    },
    ({ vevo, tetelek }) =>
      user(
        `Állíts ki egy számlát az OpenSzámla eszközeivel.${vevo ? ` Vevő: ${vevo}.` : ''}${tetelek ? ` Tételek: ${tetelek}.` : ''}\n` +
          '1) setup_status – ellenőrizd az eladói beállításokat és a NAV-kapcsolatot.\n' +
          '2) Keresd meg a vevőt (customer_find); magyar cégnél használd a taxpayer_lookup-ot; ha nincs, mentsd (customer_save).\n' +
          '3) Készíts piszkozatot (invoice_draft). Ha valami hiányzik (ár, ÁFA-kód, teljesítés dátuma, fizetési mód), kérdezz rá – ne találgass.\n' +
          '4) Mutasd meg az előnézetet (vevő, tételek, nettó/ÁFA/bruttó, dátumok, megjegyzések, figyelmeztetések), és kérj kifejezett jóváhagyást.\n' +
          '5) Jóváhagyás után invoice_issue a piszkozat azonosítójával és a megerősítő kóddal; utána add meg a sorszámot, a PDF útvonalát és a NAV-állapotot.',
      ),
  );

  server.registerPrompt(
    'havi_zaras',
    {
      title: 'Havi zárás',
      description: 'Havi összesítő a könyvelőnek: forgalom, ÁFA, kintlévőségek, NAV-problémák, export.',
      argsSchema: z.object({ honap: z.string().optional().describe('Hónap ÉÉÉÉ-HH formában (alapértelmezés: előző hónap)') }),
    },
    ({ honap }) =>
      user(
        `Készíts havi zárást${honap ? ` a(z) ${honap} hónapra` : ' az előző hónapra'} az OpenSzámla eszközeivel:\n` +
          '1) report_summary a hónap első és utolsó napjával, dateBasis: "fulfillment" – az ÁFA főszabály szerint a teljesítés napján keletkezik, így a hónap végi teljesítésről a következő hónapban kiállított számla is ebbe a hónapba tartozik. ' +
          'Foglald össze a nettó/ÁFA/bruttó forgalmat ÁFA-kódonként, és írd mellé, hogy ez teljesítés szerinti összesítés (a kelte szerinti számlaforgalom ettől eltérhet). ' +
          'Ha az eladó pénzforgalmi elszámolású (a válasz notes mezője ezt jelzi), az ÁFA az ellenérték megtérülésekor (a befizetéskor) esedékes (Áfa tv. 196/B. §): mondd meg, hogy ez az összesítés nem a bevallandó adó, ' +
          'és kérd le a befizetés szerintit is (report_summary dateBasis: "payment" – a hónap befizetései a pénzforgalmi elszámolással kiállított bizonylatokon, arányos ÁFA-val, a notes figyelmeztetéseivel); a bevallandó adót a könyvelő állapítja meg.\n' +
          '2) invoice_list overdue: true – sorold fel a lejárt, kifizetetlen számlákat.\n' +
          '3) invoice_list a nem "done" NAV-állapotú számlákra – ha van, javasolj nav_sync-et.\n' +
          '4) export_invoices csv formátumban a könyvelőnek ugyanarra a hónapra, dateBasis: "fulfillment", és add meg a fájl útvonalát; jelezd, hogy a válogatás a teljesítés dátuma szerinti (a CSV-ben a kelte és a teljesítés dátuma is szerepel). ' +
          'Pénzforgalmi elszámolású eladónál a hónap befizetési naplóját is (export_invoices ledger: true).',
      ),
  );

  server.registerPrompt(
    'nav_hibaelharitas',
    {
      title: 'NAV hibaelhárítás',
      description: 'Megkeresi a NAV-nak nem vagy hibásan jelentett számlákat, és javaslatot tesz a javításra.',
    },
    () =>
      user(
        'Ellenőrizd a NAV Online Számla jelentéseket:\n' +
          '1) setup_status – be van-e állítva (és használható-e) a NAV-kapcsolat, melyik környezet (teszt/éles – teszt környezetben valódi adatszolgáltatás nem történik), és mit írnak a teendők.\n' +
          '2) invoice_list navStatus: ["pending","processing","aborted","error","not_configured"].\n' +
          '3) Minden problémás számlánál nézd meg a navMessages-t (invoice_get), és magyarázd el közérthetően.\n' +
          '4) Átmeneti hibánál futtass nav_sync-et (a bizonytalan kimenetelű beküldést és az ismétlésként – INVOICE_NUMBER_NOT_UNIQUE – elutasítottat a nav_sync maga egyezteti a NAV-val). ' +
          'Ha a NAV elutasította (aborted), vagy végleges hiba (error) történt: hárítsd el az okát (pl. beállítás javítása, programfrissítés), majd küldd újra ugyanazt a számlát: nav_sync resubmitFailed: true – a hozzá tartozó módosító és sztornó számlák csak ezután jelenthetők. ' +
          'Ha az egyeztetéshez a NAV lekérdezése végleges hibát ad (OPENSZAMLA_RECONCILE_BLOCKED, pl. a technikai felhasználónak nincs lekérdezési jogosultsága), előbb azt kell elhárítani. Sorszám-ütközésnél (OPENSZAMLA_NUMBER_COLLISION: a NAV-nál a sorszámon egy másik számla szerepel, pl. visszaállított mentés miatt) az újraküldés nem segít: magyarázd el az üzenetet, és javasolj szakértői segítséget. ' +
          'Elutasított jelentést ne kerülj meg sztornóval és új számlával: a sztornót sem fogadja be a NAV, amíg az eredeti nincs nála. Kiállított számlát módosítani nem lehet; ha a NAV a számla adata miatt utasítja el, és a beállítás javítása sem segít, javasolj szakértői segítséget (könyvelő, NAV ügyfélszolgálat).',
      ),
  );
}
