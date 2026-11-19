# OpenSzámla – architektúra

OpenSzámla egy nyílt forráskódú, helyben futó magyar számlázó program, amelyet elsősorban
AI-ügynökök (Claude, Codex és más MCP-kliensek) kezelnek az **MCP (Model Context Protocol)**
szerveren keresztül; emberek a CLI-t és a beépített webes felületet használhatják.

```
           Claude Code / Claude Desktop / claude.ai    Codex CLI / IDE    ChatGPT (dev mode)
                         │ stdio vagy Streamable HTTP                         │
                         ▼                                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ src/mcp      MCP szerver: eszközök (tools), erőforrások (resources), promptok         │
│ src/cli      parancssor (setup, doctor, config, init, nav-setup, mcp, serve, verify …) │
│ src/web      minimális webes felület (HTTP módban, ugyanazon a porton)                  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ src/service  OpenSzamla osztály – MINDEN üzleti művelet itt (egyetlen igazságforrás)  │
├───────────────┬──────────────┬───────────────┬───────────────┬──────────────────────┤
│ src/core      │ src/db       │ src/nav       │ src/pdf       │ src/mnb              │
│ típusok, ÁFA, │ SQLite       │ NAV Online    │ PDF (pdfmake, │ MNB árfolyam         │
│ számítás,     │ (node:sqlite)│ Számla v3.0   │ Roboto, OFL)  │ (SOAP)               │
│ validáció,    │ triggerekkel │ kliens + XML  │               │                      │
│ sorszámozás   │ védett adat  │               │               │                      │
└───────────────┴──────────────┴───────────────┴───────────────┴──────────────────────┘
```

## Alapelvek

1. **Egy hely a szabályoknak.** Az MCP, a CLI és a web csak vékony adapter a `src/service/app.ts`
   felett; validáció, sorszámozás, NAV-jelentés csak ott történik. A `src/core` és a `src/service`
   hiba- és figyelmeztető szövegei felületfüggetlenek (MCP-eszközt és -mezőt nem neveznek meg – egy
   statikus teszt ezt a `src/core`-ra ki is kényszeríti); az MCP-adapter a hibakód, illetve a
   figyelmeztetés kódja szerint teszi hozzá a `hint`-hez az eszközt és a mezőt (`src/mcp/hints.ts`), a
   webes felület a saját szövegét és hivatkozását (`src/web/hints.ts`).
2. **A kiállított számla megváltoztathatatlan.** Ezt nem csak a kód, hanem SQLite triggerek is
   kikényszerítik. Javítani csak érvénytelenítő (sztornó) vagy módosító számlával lehet.
3. **Hézagmentes sorszámozás.** A piszkozat nem kap sorszámot; a sorszám a kiállításkor, egyetlen
   `BEGIN IMMEDIATE` tranzakcióban kerül kiosztásra. Visszagörgetett tranzakció nem „éget el” sorszámot.
   A sorszám minden sorszámtartományban egyedi: egymással átfedő mintájú aktív tartomány nem hozható
   létre (`patternsOverlap`, `src/core/numbering.ts`).
4. **Pénz soha nem lebegőpontos.** Minden összeg decimális sztring (`decimal.js`), kerekítés
   „half away from zero” – így a sztornó tétel pontosan az eredeti ellentettje.
5. **Titkok nem kerülnek az adatbázisba és a modell elé.** A NAV technikai felhasználó adatai
   környezeti változóból vagy a `nav-credentials.json` fájlból jönnek; egyetlen eszköz sem adja vissza őket.
6. **Visszafordíthatatlan művelet csak megerősítéssel.** Kiállításhoz és sztornóhoz – valamint a másik
   NAV-rendszerhez tartozó számla beküldéséhez (`nav_send_to_configured_environment`; előnézete és kódja a
   `nav_sync`-é, amely maga ilyen számlát nem küld be) – a szerver által az előnézettel kiadott, a
   pontos tartalomhoz kötött, lejáró megerősítő kód kell (`src/mcp/confirm.ts`); kérésre ezen felül MCP
   elicitációs párbeszéd is (`OPENSZAMLA_CONFIRM_MODE=elicit`). Az előnézet
   pontosan az, amit a kiállítás aznap kiállítana (`issuePreview`: a mai kelte, az ebből adódó
   fizetési határidő, az aktuális eladói adatok, a vevőtörzsből vett vevő aktuális adatai, a
   módosítási sorszám), és a kód ehhez – díjbekérőből készült bizonylatnál a díjbekérő befizetéséhez
   is – kötött. A sztornó végrehajtása (`invoice_cancel`) a kód ellenőrzése és a párbeszéd előtt újra
   elkészíti az előnézetet (az egy sorba rendezett okkal), így ki nem állítható sztornóhoz jóváhagyást sem
   kér. Az
   eszközök MCP annotációkkal (`destructiveHint`, `readOnlyHint` …) jelzik a hatásukat, és az
   ismeretlen paramétert elutasítják (szigorú bemeneti sémák).
7. **Auditnapló.** Minden írási művelet hash-láncolt, csak hozzáfűzhető naplóba kerül.
   `openszamla verify` ellenőrzi a számlák tartalmi hash-ét, a láncot, a naplózott kiállítások és a
   bizonylatok egyezését, a sorszámhézagokat, a védő triggereket és a megőrzött eredeti PDF-eket (a
   lenyomatukkal és a naplóval), és kiírja a lánc utolsó bejegyzését (a végéről levágott napló csak
   ezzel összevetve derül ki).
8. **Megbízható NAV-jelentés.** Minden beküldést előbb az adatbázisban lefoglal (`BEGIN IMMEDIATE`),
   így párhuzamos szinkron – akár egy másik folyamatból – sem küld kétszer. A bizonytalan kimenetelű
   beküldést a NAV ajánlása szerint 5 perc után a tranzakciólistával (`queryTransactionList`,
   `queryTransactionStatus` + `returnOriginalRequest`) egyezteti, az ismétlésként elutasítottat
   (`INVOICE_NUMBER_NOT_UNIQUE`) a NAV-nál a sorszámon tárolt adattal (`queryInvoiceData`: a számla
   kiállítása előtt – 5 percnél többel – beérkezett adat sosem ez a számla; egyébként bájtra azonos
   beküldés, a NAV webes felületén kézzel rögzítettnél (`WEB`) egyező kulcsadatok, minden más forrásnál
   (`MGM`, `XML`, `OSZ`, `OPG`) egyező kulcs- és tételadatok – különben sorszám-ütközés, amelyet a sima
   szinkron nem kérdez le újra). 1 MB fölötti NAV-adatot
   gzip-pel tömörítve küld. A sorszám kiosztása után a kiállítás nem
   hiúsul meg: a NAV-hiba az eredmény megjegyzéseibe kerül, és a kiállítás NAV-része legfeljebb kb.
   20 másodperc (nem vár egy futó szinkronra). Egy futás az első NAV-kiesés után nem fordul tovább a
   NAV-hoz, a NAV által kért szünetet (`Retry-After`) az adatbázisban tárolja és betartja. A NAV-végpontot
   csak a környezet (`test` / `production`) határozza meg; a számla NAV-állapota ahhoz a környezethez
   tartozik, amelyikben keletkezett (`invoices.nav_environment`): a teszt rendszerbe jelentett számla
   élesben nem számít jelentettnek. A `nav-credentials.json` változását a futó program újraolvassa.

## Adatmodell röviden

| Fogalom | Leírás |
|---|---|
| Eladó (`SellerProfile`) | a saját cég adatai, ÁFA-státusz (`normal` / `aam`), pénzforgalmi elszámolás, KATA |
| Vevő (`Customer`) | `DOMESTIC` (belföldi áfaalany), `OTHER` (külföldi / nem áfaalany szervezet), `PRIVATE_PERSON` (magánszemély – a NAV felé név/cím nélkül) |
| Termék (`Product`) | törzsadat: név, egység, ár (nettó/bruttó), ÁFA-kód |
| Sorszámtartomány (`Series`) | minta pl. `SZ-{YYYY}-{SEQ:5}`, éves újrakezdés; külön tartomány a díjbekérőknek |
| Számla (`Invoice`) | típus: `invoice`, `advance`, `final`, `modification`, `storno`, `proforma`; állapot: `draft` → `issued` (→ `cancelled`) |
| Eredeti PDF (`invoice_documents`) | a kiállított bizonylat kiállításkor elkészült PDF-je bájtra pontosan (BLOB), SHA-256 és SHA3-512 lenyomattal (nagybetűs hexa), mérettel, az előállító program nevével és verziójával; bizonylatonként egy, a kiállítás tranzakciója után, külön tranzakcióban, `invoice.document` auditbejegyzéssel. Csak bővíthető: triggerek tiltják a módosítást, a törlést, a piszkozathoz és a második eredetit. A `pdf()` ezt adja ki, és ebből írja a `pdf/` fájlt; soha nem renderel újra. Minden kiadás (a `pdfInfo()` és az adóhatósági export is) előtt újraszámolja a lenyomatot, és összeveti a tárolttal és a naplózottal: eltérésnél DOCUMENT_INTEGRITY_FAILED (naplózva `invoice.document_altered`), a `pdf/` fájlt sem írja felül. Az első megőrzéskor talált, más tartalmú `pdf/<név>.pdf` fájlt `…_KORABBI_<időbélyeg>.pdf` néven megőrzi (`invoice.pdf_file_kept`). Az `invoice_documents_legacy` (szintén változtathatatlan) a 3. séma bevezetésekor már kiállított bizonylatokat sorolja fel: ezeknek nincs eredetijük, PDF-jük `…_UJRAELOALLITOTT.pdf` néven, újra előállítva készül |
| Befizetési napló (`payments`, `payment_allocations`, 4. séma) | minden rögzített befizetés, visszafizetés és visszavonás – a díjbekérőről átvett befizetés és a kiállításkori `markPaid` is – egy `payments` sor: bizonylat, befizetés dátuma, előjeles összeg a bizonylat pénznemében, forrás (`manual`, `mark_paid`, `proforma`), hivatkozás (a díjbekérő sorszáma), rögzítés ideje, az `invoice.payment` auditbejegyzés azonosítója. A `payment_allocations` azt rögzíti, hogy a lánc rendezése (`settleLedger`, `src/core/settlement.ts`: a `settleChain` szabályai szerint, a befizetés dátuma szerinti sorrendben) a befizetést a lánc melyik bizonylatára mennyiben számolta el; a sztornón rögzített visszafizetés a sztornóé. Mindkettő csak bővíthető – triggerek tiltják a módosítást, a törlést és a piszkozathoz rögzítést –: egy későbbi átrendeződés (utólag kiállított módosító számla, korábbi dátumú befizetés) új felosztási sorokkal kerül be. Az `invoices.paid_amount` (a bizonylatra felosztott összeg), `paid_date` (a teljes kifizetés napja) és `payment_status` ebből számolódik; a befizetés dátuma szerinti ÁFA-összesítés (`report(dateBasis: 'payment')`) és a napló exportja is ebből olvas. A 4. séma előtti befizetéseket a program az `invoice.payment` bejegyzésekből veszi át (`backfillPaymentLedger`: egyszer, rövid tranzakciókban), a régebbi programváltozat által később naplózottakat a lánc következő befizetése (`syncLedger`) |
| ÁFA-kód (`VatCode`) | `27`, `18`, `5`, `0`, `AAM`, `TAM`, `KBAET`, `KBAUK`, `EAM`, `NAM`, `ATK`, `EUFAD37`, `EUFADE`, `EUE`, `HO`, `FAD`, `KUL_*` – lásd `src/core/vat.ts` |

## MCP felület

Szervernév: `openszamla`. Az eszközök neve angol (`erőforrás_művelet` minta), a leírások
magyar kulcsszavakat is tartalmaznak, hogy a magyar nyelvű kérésekhez jól illeszkedjenek.
Minden eszköz rövid szöveges összefoglalót **és** strukturált (`structuredContent`) választ ad.

| Eszköz | Hatás | Leírás |
|---|---|---|
| `setup_status` | csak olvas | Kiindulópont: eladó adatai, sorszámtartományok, NAV-állapot, teendők |
| `seller_update` | ír | Eladó adatai és számlázási alapértelmezések |
| `series_manage` | ír | Sorszámtartományok listázása / létrehozása / módosítása |
| `taxpayer_lookup` | olvas (NAV) | Adószám-lekérdezés a NAV-tól, opcionálisan mentés vevőként |
| `customer_save` / `customer_find` | ír / olvas | Vevők kezelése, keresés (ékezetfüggetlen) |
| `product_save` / `product_find` | ír / olvas | Termékek, szolgáltatások |
| `invoice_draft` | ír (piszkozat) | Piszkozat létrehozása vagy módosítása; visszaadja a kiszámolt összegeket és a hibákat |
| `invoice_get` / `invoice_list` | csak olvas | Számla részletei; listázás szűrőkkel |
| `invoice_issue` | **visszafordíthatatlan** | Kiállítás: sorszám, zárolás, PDF, NAV-jelentés |
| `invoice_cancel_preview` | csak olvas | Sztornó előnézet + megerősítő kód |
| `invoice_cancel` | **visszafordíthatatlan** | Sztornó számla kiállítása (díjbekérőnél visszavonás) – megerősítő kóddal |
| `invoice_correct` | ír (piszkozat) | Módosító (helyesbítő) számla piszkozata különbözeti tételekkel |
| `invoice_delete_draft` | töröl (csak piszkozat) | Piszkozat törlése |
| `invoice_record_payment` | ír | Befizetés rögzítése |
| `invoice_pdf` | olvas / fájlt ír | Kiállított bizonylatnál a megőrzött eredeti PDF (`kind`, `sha256`), piszkozatnál tervezet; útvonal, erőforrás-link, opcionálisan másolás helyi mappába (hálózati útvonalra nem, felülírás nélkül) |
| `nav_sync` | NAV-ba ír | Függő számlák beküldése, feldolgozási állapot lekérdezése (hívásonként kb. 45 mp időkerettel); a másik NAV-rendszerhez tartozó számlánál csak a beküldés előnézete + megerősítő kód |
| `nav_send_to_configured_environment` | **visszafordíthatatlan** | A másik NAV-rendszerhez tartozó (pl. csak a TESZT rendszerbe jelentett) számla beküldése a beállított rendszerbe – megerősítő kóddal |
| `exchange_rate` | olvas (MNB) | Hivatalos MNB árfolyam adott napra |
| `report_summary` | csak olvas | Időszaki összesítő: forgalom, ÁFA kulcsonként, havi bontás, kintlévőség – a kelte, a teljesítés vagy (pénzforgalmi elszámolásnál) a befizetés dátuma szerint |
| `export_invoices` | fájlt ír | CSV / JSON / NAV XML export könyvelőnek; a befizetési napló CSV-ben / JSON-ban (`ledger`) |
| `tax_audit_export` | fájlt ír | adóhatósági ellenőrzési adatszolgáltatás (3. melléklet szerinti XML + NAV XML + PDF) |
| `audit_log` | csak olvas | Auditnapló |
| `backup_create` | fájlt ír | Az adatbázis konzisztens másolata az adatkönyvtár `backups` mappájába |
| `verify_integrity` | csak olvas | Annak ellenőrzése, hogy az adatbázist nem módosították a programon kívül (mint `openszamla verify`) |

Erőforrások: `openszamla://setup`, `openszamla://vat-codes`, `openszamla://invoices/{id}` (JSON),
`openszamla://invoices/{id}/pdf` (PDF), `openszamla://customers/{id}`.
Promptok: `szamla_kiallitas`, `havi_zaras`, `nav_hibaelharitas`.

## Szállítási módok

* **stdio** (`openszamla mcp`) – Claude Code, Claude Desktop, Codex CLI/IDE helyi használatra.
* **Streamable HTTP** (`openszamla serve`) – `POST /mcp` végpont, állapotmentes mód, Bearer token
  hitelesítéssel (fejlécet küldeni nem tudó klienseknek: `/mcp/<token>`, csak HTTPS mögött);
  ugyanazon a porton fut a webes felület és a token nélküli `/healthz` állapotjelző (név, verzió).
  Alapértelmezésben csak `127.0.0.1`-en figyel, a Host/Origin fejlécet minden kérésnél ellenőrzi, a
  hibás tokeneket címenként korlátozza (429, `Retry-After`). A 2025-ös protokollú kéréseket
  munkamenet nélkül szolgálja ki, ezért azokon nincs elicitációs párbeszéd
  (`ELICITATION_UNAVAILABLE_LEGACY_HTTP`).

## Webes felület

A `src/web` szerveroldalon előállított HTML-oldalakból áll (`pages/*.ts`); minden felhasználói művelet
pontosan egy szolgáltatás-hívás, üzleti szabály nincs benne. Minden oldal szigorú CSP-vel megy ki
(`default-src 'none'`, stílus és szkript csak a válaszonkénti nonce-szal), CSRF-tokennel és
eredet-ellenőrzéssel; külső erőforrást (betűkészletet, CDN-t, képet) nem tölt be, így hálózat nélkül is
működik. A megjelenés egyetlen stíluslapból jön (`src/web/layout.ts`): színtokenek világos és sötét
változattal (a szövegszínek WCAG AA kontrasztúak), 4 px-es térközrács, rendszer-betűkészlet, gombrendszer
(elsődleges, másodlagos, veszélyes, csendes), érintőképernyőn legalább 44 px-es vezérlők. Az ikonok
beépített, saját rajzú SVG-k (`src/web/icons.ts`), mindig szöveg mellett. Az Áttekintő első lépéseit
(`src/web/setup-guide.ts`) a `setup_status` adataiból számolja. A felület által mutatott parancsokat
(`nav-setup`, `nav-send-to-configured-environment`) a szolgáltatás állítja elő (`src/service/config.ts`, a
legrövidebb helyes alakban: a beépített adatkönyvtárnál `--data-dir` nélkül), így ugyanazt írja a webes
felület, a `setup`, a `doctor` és minden teendő és hibaüzenet. A szolgáltatás szövegei az ügynököknek
szólnak (eszköznevekkel); a felület ezek helyett a szerkezett adatokból fogalmaz: a teendőket a
`setup_status` `todos` kódjaiból, a kiállítás eredményét az `IssueResult.notices` kódjaiból, a NAV-futás
eredményét és a javító okirat várakozását a NAV-állapotból, a futás leállásából és a `NavWait`-ből
(`src/web/nav-text.ts`), az ügynöknek szóló ellenőrzési üzenetek és hibatippek helyett a kód szerinti webes
szöveget (`src/web/hints.ts`) mutatja – az üzenet szövegét soha nem elemzi. A bizonylat oldala a
letöltés mellett megnevezi, melyik PDF-et adja (megőrzött eredeti a lenyomatával, újra előállított vagy
tervezet – előállítás nélkül), a másik NAV-rendszerhez tartozó számlát pedig nem küldi be: megmondja, hogyan
küldhető be megerősítéssel. A szkriptek csak kényelmi kiegészítők
(a tartalék tételsorok elrejtése és az új tételsor, a választott termék adatainak kitöltése, az új vevő
mezőinek nyitása, parancs másolása): minden oldal JavaScript nélkül is működik.

## Futtatókörnyezet és csomag

A kiadott csomag (`dist/`) Node.js 22.13.0-tól fut (beépített `node:sqlite`); a `src/cli/main.ts`
induláskor a változatot és a `node:sqlite` működését is ellenőrzi. A PDF-ekbe ágyazott Roboto
betűkészlet (pdfmake) licence SIL Open Font License 1.1; a harmadik féltől származó összetevők:
`THIRD-PARTY-NOTICES`. A csomag csak parancssori program és MCP szerver (nincs könyvtári belépési
pont); az npm-csomag és a `.mcpb` ugyanazokat a dokumentumokat szállítja (`package.json` `files`).

Az MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) mindkét protokoll-generációt kiszolgálja: a
2025-ös (`initialize`, pl. Codex) és a 2026-07-28-as (pl. Claude Code) klienseket is.

## Telepítés és kliensbeállítás

Az `openszamla setup`, `doctor` és `config <kliens> --write` csak a telepítést szolgálja, üzleti szabályt
nem tartalmaz (`src/cli/setup.ts`, `src/cli/doctor.ts`, `src/cli/clients.ts`, `src/cli/toml.ts`); az
eladói és a NAV-lépés ugyanaz a kód, mint az `init` és a `nav-setup`, az adatokat a `src/service`
műveletei mentik és ellenőrzik.

- Az adatkönyvtár helyét a `doctor` és a `setup` ellenőrzi (`dataDirRisk`, `src/cli/doctor.ts`): OneDrive-mappa
  (a `OneDrive*` környezeti változók szerint) és hálózati hely (UNC-útvonal – fájlművelet nélkül –, vagy
  olyan betűjel, amelynek valódi útvonala UNC) esetén figyelmeztet. A titkos adatok kérdése (`src/cli/prompt.ts`)
  terminálon a kérdés előtt begépelt bevitelt elveti, és semmit nem jelenít meg, amíg nincs kérdés a képernyőn.
- A kliensbeállításba írt parancs a Node.js és a telepített `dist/cli/main.js` **abszolút útvonala**: a
  kliensek a szervert parancsértelmező nélkül indítják (Windowson a `.cmd` indító így nem fut), és a
  macOS-es asztali alkalmazások nem látják a terminál PATH-ját.
- Minden hely a környezetből jön (`USERPROFILE` / `HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`,
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`) – a tesztek ezeket ideiglenes mappákra irányítják. A Codex
  `config.toml` fájlját TOML-könyvtár nélkül, utasításokra bontva olvassa és egészíti ki; amit nem tud
  biztonságosan szerkeszteni, azt nem módosítja.
- Írás előtt időbélyeges biztonsági másolat készül, az új tartalom átmeneti fájlon át, az eredeti
  jogosultságaival kerül a helyére; a meglévő `openszamla` bejegyzést csak `--force` cseréli. A `claude`
  parancsot parancsértelmező nélkül, csak közvetlenül indítható programként futtatja.
