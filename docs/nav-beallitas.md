# NAV Online Számla kapcsolat beállítása

A számlázó programmal kiállított számláról a kiállításkor **azonnal** adatot kell szolgáltatni a
NAV-nak (23/2014. NGM rendelet 13/A. §). Az OpenSzámla ezt a NAV Online Számla v3.0 gép-gép
interfészén keresztül, automatikusan végzi – ehhez egy **technikai felhasználó** kell.

## 1. Technikai felhasználó létrehozása

Először a **teszt** környezetben érdemes kipróbálni, utána az élesben ugyanígy (a két rendszer
regisztrációja teljesen külön van, a kulcsok nem vihetők át).

| | Teszt | Éles |
|---|---|---|
| Online Számla felület | https://onlineszamla-test.nav.gov.hu | https://onlineszamla.nav.gov.hu |
| API (a program használja) | `https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3` | `https://api.onlineszamla.nav.gov.hu/invoiceService/v3` |

1. Lépj be az adózó nevében eljárni jogosult személyként (KAÜ / Ügyfélkapu+). Az első belépő lesz az
   elsődleges felhasználó.
2. A felhasználókezelőben (2025 óta a NAV Felhasználókezelő alkalmazás) hozz létre **technikai
   felhasználót** jelszóval, és add meg a jogosultságokat: **Számlák kezelése** (beküldéshez kötelező)
   és **Számlák lekérdezése** (vagy „Saját számlák lekérdezése”). A lekérdezési jogosultságot a
   program a bizonytalan kimenetelű és az ismétlésként elutasított beküldések egyeztetéséhez is
   használja (5. pont): nélküle ezeket nem tudja egyeztetni, és – hogy semmi ne kerüljön kétszer a
   NAV-hoz – nem is küldi újra őket, amíg a jogosultságot meg nem adod.
3. Generálj **XML aláírókulcsot** és **XML cserekulcsot** a technikai felhasználóhoz. (Újragenerálás
   után a régi kulcsok azonnal érvénytelenek.)
4. Jegyezd fel: a technikai felhasználó **login nevét**, **jelszavát**, az **aláírókulcsot** és a
   **cserekulcsot** (16 karakter), és add meg őket a programnak (2. pont). A már futó programot (a
   Claude Desktop, a Claude Code, a Codex MCP-szerverét, az `openszamla serve`-et) ehhez nem kell
   újraindítani.

## 2. Megadás a programnak

Az ajánlott mód az interaktív parancs (az adatok a gépeden, az adatkönyvtárban maradnak – Linuxon és
macOS-en `0600` jogosultsággal):

```bash
openszamla nav-setup --data-dir "<adatkönyvtár>"   # rákérdez a környezetre (test/production) és a négy adatra
```

A `--data-dir` annak az adatkönyvtárnak az útvonala, amelyet a szerver (az MCP-kliens) használ. Az
MCP-kliens konfigurációjában megadott `OPENSZAMLA_HOME` a terminálban nem érvényes, ezért enélkül az
adatok a `~/.openszamla` könyvtárba kerülnének, ahol a szerver nem keresi őket. A pontos parancsot
(az adatkönyvtárral együtt) a `setup_status` / `openszamla status` „Teendők” listája is kiírja.
Globális telepítés nélkül: `npx -y openszamla nav-setup --data-dir "<adatkönyvtár>"`.

A futó MCP-szerver (Claude Desktop, Claude Code, Codex) és az `openszamla serve` a mentett adatokat a
következő műveletnél észleli és átveszi – **újraindítás nem kell**: a `setup_status` azonnal az új
beállítást mutatja, a `nav_sync` pedig beküldi a közben kiállított, még nem jelentett számlákat. (A
környezeti változókat a program induláskor olvassa: ezek megváltoztatása után a klienst vagy a
`serve`-et újra kell indítani.)

A környezetet (`test` / `teszt`, `production` / `prod` / `éles`) a program a titkok előtt
ellenőrzi. A jelszó és a két kulcs terminálon **gépelés közben sem jelenik meg**; a válaszok
csővezetéken is megadhatók (soronként egy). Mentés előtt a program ellenőrzi az adatok formátumát (a
login név 6–15 betű vagy szám, az XML cserekulcs pontosan 16 karakter); hibás adatot nem ment el.
Mentés után figyelmeztet, ha `OPENSZAMLA_NAV_*` környezeti változók felülírják a most mentett
beállítást, és azonnal teszteli a kapcsolatot (`tokenExchange`), ha az eladó adószáma már be van
állítva. Részletek: [felhasználói dokumentáció](felhasznaloi-dokumentacio.md), 7.3.

Alternatíva: környezeti változók (pl. MCP-kliens konfigurációjában vagy a Claude Desktop bővítmény
beállításaiban):

| Változó | Jelentés |
|---|---|
| `OPENSZAMLA_NAV_ENV` | `test` vagy `production` (`teszt`, `prod`, `éles` is elfogadott); megadva felülírja a `nav-setup`-ban mentett környezetet, üresen az érvényes (ha az sincs: `test`) |
| `OPENSZAMLA_NAV_LOGIN` | technikai felhasználó login neve |
| `OPENSZAMLA_NAV_PASSWORD` | jelszó |
| `OPENSZAMLA_NAV_SIGNING_KEY` | XML aláírókulcs |
| `OPENSZAMLA_NAV_EXCHANGE_KEY` | XML cserekulcs |
| `OPENSZAMLA_NAV_AUTO_SUBMIT` | `true` (alapértelmezés): kiállításkor azonnal beküld |
| `OPENSZAMLA_NAV_WAIT_SECONDS` | kiállításkor ennyi másodpercig várja a feldolgozás eredményét (alapértelmezés 20, legfeljebb 45) |

**Melyik beállítás érvényes?** Ha az `OPENSZAMLA_NAV_LOGIN` (a jelszóval és a két kulccsal együtt)
meg van adva, a program ezeket használja, különben az adatkönyvtár `nav-credentials.json` fájlját (amit
a `nav-setup` ír). A megadott, nem üres `OPENSZAMLA_NAV_ENV` mindkét esetben felülírja a környezetet.
Az üres érték és a kliens által ki nem fejtett `${…}` érték „nincs megadva”-nak számít – így a
Claude Desktop-bővítmény és a Claude Code-plugin üresen hagyott NAV-beállításai nem írják felül a
`nav-setup`-ban mentett adatokat és környezetet. A bővítményhez vagy pluginhoz a `nav-setup`-ot a
bővítmény/plugin adatkönyvtárával futtasd: `openszamla nav-setup --data-dir <az ott megadott mappa>`.

A titkok soha nem kerülnek az adatbázisba, és egyetlen MCP-eszköz sem adja vissza őket. Az
MCP-kliensnek (és így a nyelvi modellnek) **ne** add meg őket chatben.

A program induláskor (és a `nav-credentials.json` minden újraolvasásakor) ellenőrzi a beállítás
formátumát (technikai felhasználó adatai, valamint az `OPENSZAMLA_SOFTWARE_ID`). A kézzel írt fájl
kódolása UTF-8 lehet – a fájl elején bájtsorrend-jellel (BOM – pl. a Windows PowerShell 5.1
`Out-File -Encoding utf8` parancsa írja) vagy anélkül –, illetve bájtsorrend-jellel kezdődő UTF-16
(little vagy big endian: ezt írja a Windows PowerShell 5.1 `Out-File` parancsa és `>` átirányítása
`-Encoding` nélkül, valamint a Jegyzettömb „Unicode” mentése); a program mindegyiket ugyanúgy olvassa. Ha
valami hibás – a
sérült vagy hiányos `nav-credentials.json` is (pl. kézi szerkesztés után maradt vessző, félbeszakadt
mentés, üres jelszó) –, a program úgy működik, mintha a NAV-kapcsolat nem lenne beállítva: minden
parancs elindul (`status`, `list`, `verify`, `backup`, `mcp`, `serve`), a számlák kiállíthatók, de
egyet sem küld be (NAV-állapotuk `not_configured`), és a hiba okát – pl. „A NAV-beállítás fájlja (…)
nem érvényes JSON (pl. kézi szerkesztés vagy félbeszakadt mentés miatt).” vagy „A NAV technikai
felhasználó adatai hibásak: a jelszó üres.” – a `setup_status`, az `openszamla status` („NAV: HIBÁS
BEÁLLÍTÁS (<környezet>, file) – …”) és a webes felület is megmutatja, a beállító paranccsal együtt; a
fájl értékeit soha. A `nav-setup` a hibás fájlt felülírja; a javítás után a `nav_sync` pótolja a
jelentéseket. (Hiányos `OPENSZAMLA_NAV_*` változókkal viszont a program nem indul el – felhasználói
dokumentáció, 3.3.)

A NAV-végpontot kizárólag a környezet (`test` / `production`) határozza meg; más címre irányító
beállítás nincs.

## 3. Ellenőrzés

- `openszamla status` – „NAV: test (file)” vagy „NAV: production (env)”; hibás beállításnál
  „NAV: HIBÁS BEÁLLÍTÁS (…) – <a hiba oka>”.
- Kézzel írt `nav-credentials.json`-nál a „nem érvényes JSON” hiba nem a fájl kódolásán múlik, ha az
  UTF-8 (bájtsorrend-jellel vagy anélkül) vagy bájtsorrend-jellel kezdődő UTF-16 – ez a Windows
  PowerShell 5.1 és a Jegyzettömb alapértelmezése –, hanem a tartalmán (pl. hiányzó idézőjel vagy
  vessző). A bájtsorrend-jel nélküli és a csonka UTF-16 fájlt a program nem tudja olvasni: mentsd
  UTF-8-ként (`Out-File -Encoding utf8`), vagy írd meg a fájlt a `nav-setup`-pal (2. pont).
- Az ügynöknek: „Kérdezd le a NAV-tól a saját adószámunkat.” (`taxpayer_lookup`).
- Teszt környezetben állíts ki egy próbaszámlát; a `nav_sync` eredménye `done` legyen.

## 4. Éles használat

Teszt környezetben minden NAV-eredmény jelzi, hogy a számla csak a NAV tesztrendszerébe került
(„NAV (TESZT környezet): … – éles adatszolgáltatás NEM történt”), és a kiállítás megjegyzései is
figyelmeztetnek erre: ilyenkor **valódi adatszolgáltatás nem történik**.

Állítsd át a környezetet `production`-re (`openszamla nav-setup --env production --data-dir "<adatkönyvtár>"`,
vagy `OPENSZAMLA_NAV_ENV=production`) az **éles** technikai felhasználó adataival. A `nav-setup`-pal
való átállítás csak akkor elég, ha sehol nincs megadva `OPENSZAMLA_NAV_ENV` (a Claude
Desktop-bővítmény és a Claude Code-plugin „NAV környezet” beállítása üres); a megadott érték
felülírja a mentettet (ha a változó a terminálban is be van állítva, a `nav-setup` mentés után jelzi
is). Ellenőrzés: az ügynökben a `setup_status`, a terminálban az `openszamla status` „production”
környezetet mutasson. A teszt környezetben kiállított számlák az adatbázisban maradnak – éles indulás
előtt érdemes új adatkönyvtárral kezdeni (`OPENSZAMLA_HOME`).

Ha ugyanazt az adatkönyvtárat használod tovább, a program számontartja, melyik NAV-rendszerhez tartozik
egy-egy számla jelentése: a csak a TESZT rendszerbe jelentett (vagy ott feldolgozás alatt álló, ott
kiállított és még nem jelentett) számla az éles környezetben **nincs jelentve**, és nem is számít
annak. A `nav_sync` ezeket az éles rendszerbe magától nem küldi be, és a teszt rendszer
tranzakcióazonosítójával az éles rendszert sem kérdezi – a tesztidőszak számlái lehetnek valódi
tesztek. A `setup_status` teendői sorszámmal megnevezik őket („… NAV-állapota a TESZT rendszerhez
tartozik …, az éles rendszerbe nincs jelentve …”), az `invoice_list` / `invoice_get` `navNote`-ja is
jelzi. Ha valamelyik **valódi** számla (pl. tévedésből a teszt környezetben állítottad ki), küldd be az
éles rendszerbe, számlánként – új beküldésként. Ez valódi adatszolgáltatás, és nem vonható vissza, ezért
megerősítés kell hozzá, és külön eszköz végzi. A `nav_sync { invoice: "<sorszám>", resubmitFailed: true }`
nem küld be semmit, csak megmutatja, melyik rendszerhez tartozik a számla, hová kerülne, és hogy ez
éles jelentés, egy megerősítő kóddal; a jóváhagyásod után az ügynök a kóddal hívja a
`nav_send_to_configured_environment { invoice, confirmationCode }` eszközt (a kliens ehhez is az
engedélyedet kéri, `elicit` módban a párbeszédablakában is jóváhagyod), és csak ez küldi be. Ha az
előnézet óta megváltozott a számla NAV-állapota, a kód érvénytelen – friss előnézet kell. Parancssorból:
`openszamla nav-send-to-configured-environment <sorszám> --data-dir "<adatkönyvtár>"` kiírja, mit
jelentene, és csak a `--confirm` kapcsolóval küldi be. A webes felület ilyen számlát nem küld be: a
számla oldalán a NAV rész ezt a két utat írja le, a parancsot másolható formában.
Módosító/sztornó számlája csak ezután kerül beküldésre.

A még egyik NAV-rendszerbe sem küldött, környezet nélküli számlát (pl. a NAV-kapcsolat nélkül
kiállítottat) a következő `nav_sync` a beállított rendszerbe küldi. Ilyen egy korábbi programváltozat
(1-es adatbázisséma) által kiállított, soha be nem küldött számla is: az adatbázis átállításakor (2-es
séma) a program a környezetet csak a beküldésekből tudja megállapítani, ezért ha egy ilyen számla a
teszt környezetben készült, az éles környezetre váltás után a következő `nav_sync` az éles rendszerbe
küldi. Ilyen adatbázissal átállás előtt nézd át a még nem jelentett számlákat (`invoice_list navStatus:
["pending", "not_configured"]`), vagy kezdj új adatkönyvtárral.

## 5. Mi történik hiba esetén?

| Helyzet | A program viselkedése | A te teendőd |
|---|---|---|
| Hálózati hiba a kérés elküldése előtt, NAV karbantartás, HTTP 5xx | a számla `pending` marad; a futás az első ilyen hiba után nem fordul tovább a NAV-hoz, a többi számla állapota nem változik („A NAV ebben a futásban nem érhető el …”) | `nav_sync` később; jogszabály: a kiesés megszűnése után **24 órán belül** pótolni kell |
| A NAV nem válaszol (időtúllépés) | a `nav_sync` az első időtúllépés után leáll (legfeljebb egy kérés időkorlátja, 60 mp; MCP-n egy hívás a NAV-val összesen legfeljebb kb. 45 mp-ig, a webes felület NAV-gombjai („Függő számlák beküldése a NAV-nak”, a bizonylat oldalán a NAV-gomb) kb. 60 mp-ig foglalkoznak, a sorra nem került számlákat a `notProcessed` sorolja fel); kiállításkor a NAV-rész legfeljebb kb. 20 mp (kérésenként 6 mp), a számla `pending`, a kiállítás nem hiúsul meg; ha a beküldés maradt válasz nélkül, a kimenetel bizonytalan (lásd a következő sort) | `nav_sync` később |
| Forgalomkorlátozás (HTTP 429) vagy karbantartás `Retry-After` fejléccel | a futás azonnal leáll; a program megjegyzi, mikortól fordulhat a NAV-hoz újra (`Retry-After`, 429-nél fejléc nélkül 60 mp, legfeljebb 1 óra), és addig semmit nem küld be és nem kérdez le – a későbbi `nav_sync`, a lekérdezések, a kiállításkori beküldés és az adószám-lekérdezés (`taxpayer_lookup`: NAV_PAUSED, a hátralévő idővel) sem; az adószám-lekérdezésre kért szünetet is megjegyzi; a számlák `pending` / `processing` maradnak, a megjegyzés megadja az időpontot | `nav_sync` a megadott időpont után |
| Bizonytalan kimenetel: időtúllépés, a kapcsolat a kérés elküldése után megszakadt, olvashatatlan válasz | a számla `pending`, az üzenetek között „a beküldés eredménye bizonytalan” | `nav_sync` legalább 5 perc múlva: a program a NAV tranzakciólistáján (az időszak minden oldalán, a saját technikai felhasználó tranzakciói között) megnézi, megérkezett-e a beküldés – ha a lista nem kérdezhető le, a számla sorszámával –, és csak akkor küldi újra, ha nem: így a számla nem kerül kétszer a NAV-hoz |
| Hibás beállítás (pl. 15 karakteres cserekulcs, hibás login név, sérült vagy hiányos `nav-credentials.json`) | a program elindul, de nem küld be semmit, a számlák `not_configured` állapotúak, a hiba oka a `setup_status`-ban | javítsd: `openszamla nav-setup --data-dir "<adatkönyvtár>"`, majd `nav_sync` – a futó programot (MCP-kliens, `serve`) nem kell újraindítani |
| Hibás hitelesítés (jelszó, kulcs, jogosultság) | `error` + magyar nyelvű magyarázat | javítsd a beállítást, majd `nav_sync resubmitFailed: true` |
| Az egyeztetéshez szükséges NAV-lekérdezés végleges hibát ad (pl. a technikai felhasználónak nincs lekérdezési jogosultsága – `FORBIDDEN`) | a program nem küld (újra) semmit; a számla `error` (ismétlésként elutasítottnál `aborted`), üzenetei között a NAV hibája és `OPENSZAMLA_RECONCILE_BLOCKED` a teendővel; a `setup_status` teendői is megnevezik az okot | hárítsd el (jogosultság: 1. pont), majd `nav_sync resubmitFailed: true` – a program előbb egyeztet, és csak ha kell, küld |
| A NAV elutasította (`ABORTED`) | `aborted` + a NAV üzenetei | hárítsd el a hiba okát (programhiba esetén frissítés, beállítási hibánál a beállítás javítása), majd küldd újra ugyanazt a számlát: `nav_sync resubmitFailed: true` |
| A NAV ismétlésként utasította el (`INVOICE_NUMBER_NOT_UNIQUE`) | a program lekéri a NAV-tól az ezzel a sorszámmal tárolt számlát (`queryInvoiceData`), és összeveti ezzel: ha a NAV azt több mint 5 perccel e számla kiállítása előtt kapta meg (a NAV beérkezési időpontja és e gép órája szerint), az egy másik számla – akkor is, ha az adatai bájtra azonosak (sorszám-ütközés, lásd a következő sort); különben `done` lesz, ha az ennek a számlának egy korábbi beküldése (pl. válasz nélkül maradt), ha a NAV webes felületén kézzel rögzítették (`WEB`) és egyeznek a kulcsadatai – kelte, eladó, vevő, pénznem, nettó, ÁFA és bruttó forintösszeg –, vagy ha más úton érkezett – egy számlázó program gépi interfészén (`MGM`), kézi XML-feltöltéssel (`XML`), a NAV Online Számlázójából (`OSZ`) vagy online pénztárgépről (`OPG`) –, és a kulcsadatai mellett a tételei is egyeznek (tételszám; megnevezés, mennyiség, egység, nettó összeg, ÁFA-kulcs) | nincs; ha a NAV-nál nincs ilyen számla, vagy többször szerepel, az üzenet leírja a teendőt |
| Sorszám-ütközés: a NAV-nál a számla sorszámán egy **másik** számla szerepel (pl. régebbi mentés visszaállítása, vagy ugyanazt a sorszámtartományt használó másik számlázó program, a NAV Online Számlázója vagy egy online pénztárgép miatt) – eltérő adatokkal, vagy a számla kiállítása előtt beérkezve | `aborted` + `OPENSZAMLA_NUMBER_COLLISION` (az eltérő adatokkal – a kiállítás előtt beérkezett számlánál a két időponttal –, a valószínű okkal és a sorszámtartomány következő sorszámával); a számla nincs jelentve, módosító/sztornó számlája sem kerül beküldésre; a program a NAV-tól csak a számla kifejezett újraküldésekor kérdezi le újra | kérj segítséget (könyvelő); a további számlákat a NAV-nál még szabad sorszámmal állítsd ki (pl. új sorszámtartomány eltérő előtaggal); ha a NAV-nál tárolt számlát technikai érvénytelenítéssel visszavonják, utána `nav_sync { invoice: "<sorszám>", resubmitFailed: true }` |
| Nagyon hosszú számla (1 MB fölötti NAV-adat) | a program tömörítve (gzip) küldi; a NAV korlátainál (15 MB számlánként, 10 MB kérésenként) nagyobb számlát ki sem állít (NAV_REPORT_TOO_LARGE) | oszd több számlára |
| A NAV befogadta figyelmeztetéssel | `done_with_warnings` | nézd át az üzeneteket (`invoice_get`) |
| Saját rendszered 48 óránál tovább nem tud jelenteni | – | a NAV felületén jelezd az üzemzavart, és rögzítsd kézzel az adatokat; a kézzel rögzített számlát a program később ismétlésként felismeri, ha a kulcsadatai (kelte, eladó, vevő, pénznem, nettó, ÁFA és bruttó forintösszeg) egyeznek a számláéval (a NAV felületén kézzel rögzített számlánál a tételeket nem veti össze; a felületen feltöltött XML-fájlnál a tételeknek is egyezniük kell). Csak a programban már kiállított számlát rögzítsd így: a kiállítása előtt a NAV-hoz került számlát a program sorszám-ütközésnek tekinti |
| A számla csak a TESZT rendszerbe van jelentve, a környezet már éles (4. pont) | a számla az éles rendszerben nincs jelentve; a `nav_sync` magától nem küldi be, a `setup_status` megnevezi | ha valódi számla: előnézet és kód: `nav_sync { invoice: "<sorszám>", resubmitFailed: true }`, a megerősítésed után a beküldés: `nav_send_to_configured_environment { invoice, confirmationCode }` (parancssorban `openszamla nav-send-to-configured-environment <sorszám> --confirm`) |

Módosító és sztornó számlát a program csak akkor küld be, ha az eredeti számla már sikeresen
(`done`) bekerült a NAV rendszerébe – a NAV a módosítást csak az eredeti után fogadja be. Ha az eredetit
a NAV ugyanabban a `nav_sync` futásban fogadja be, a futás a módosító/sztornó számlát is beküldi. Ha az
eredeti jelentését a NAV elutasította, a hozzá tartozó módosító/sztornó számla `pending` marad, és a
`setup_status`, a `nav_sync` és a webes felület is kiírja, hogy az eredeti miatt nem jelenthető. Ilyenkor
az eredeti számla jelentésének hibáját kell elhárítani és az eredetit újraküldeni
(`nav_sync { invoice: "<az eredeti sorszáma>", resubmitFailed: true }`); utána a módosító/sztornó
számlát a következő `nav_sync` beküldi. Sorszám-ütközéses eredetinél az újraküldés nem segít (lásd a
táblázatot); ha az eredeti egyeztetését végleges NAV-hiba akadályozza (pl. hiányzó lekérdezési
jogosultság), a hiba elhárítása után `nav_sync resubmitFailed: true` – a `setup_status` teendője az
eredeti állapota szerint mondja meg, melyik eset áll fenn.

**Ne** próbáld egy elutasított jelentést sztornóval és új számlával „megkerülni”: a sztornó számla
az eredetire hivatkozik, ezért a NAV azt sem fogadja be, amíg az eredeti nincs nála – a sztornó is
jelentetlen maradna. Ha a NAV olyan adat miatt utasítja el a számlát, amely a kiállított számlán
szerepel, és sem a program frissítése, sem a beállítások javítása nem segít, kérj segítséget
(könyvelő, NAV ügyfélszolgálat, hibajelzés a fejlesztőknek): az eredeti számla jelentését pótolni
kell, mielőtt módosító vagy sztornó számla jelenthető lenne. Ugyanez a teendő, ha a program egy
kiállított számlából nem tudja elkészíteni a NAV-adatot (`NAV_DATA_INVALID`, a számla `error`): ez
programhiba – a kiállítás előtti ellenőrzés az ilyen adatot kiszűri –, és sem módosító, sem sztornó
számla nem segít rajta.

Egy-egy számla beküldését a program akkor sem ismétli meg, ha több NAV-szinkron fut egyszerre (dupla
kattintás, párhuzamos eszközhívás, egy második program ugyanazon az adatbázison): minden beküldést
előbb az adatbázisban lefoglal.

Részletes műszaki háttér: [research/03-nav-online-szamla-api.md](research/03-nav-online-szamla-api.md).
