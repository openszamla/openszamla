# Jogi megfelelés

Ez a dokumentum összefoglalja, hogyan teljesíti az OpenSzámla a számlázó programokra és a számlákra
vonatkozó magyar előírásokat (állapot: 2026. október 27.), mit kell a felhasználónak magának
megtennie, és mit **nem** tud (még) a program. Nem jogi tanácsadás; a részletes, forrásolt elemzés:
[research/02-jogi-kovetelmenyek.md](research/02-jogi-kovetelmenyek.md).

## Számlázó program (23/2014. (VI. 30.) NGM rendelet)

| Követelmény | Megvalósítás |
|---|---|
| Kihagyás és ismétlés nélküli, folyamatos sorszámozás (8. § (1) a)) | A sorszám csak kiállításkor, egyetlen tranzakcióban kerül kiosztásra; piszkozat nem kap sorszámot; több sorszámtartomány, mindegyiken belül folyamatos; éves újrakezdés csak évszámos mintával. A sorszám minden sorszámtartományban egyedi: a program nem enged olyan mintát, amelyből egy másik aktív tartomány sorszáma is előállhatna, sem olyan tartományt, amelynek következő sorszáma már foglalt. Az `openszamla verify` a sorszámhézagokat is keresi. |
| A kiállított számla nem módosítható, nem törölhető | SQLite triggerek tiltják a módosítást és törlést; javítás csak sztornó vagy módosító számlával; tartalmi hash + hash-láncolt auditnapló. Az `openszamla verify` a tartalmi hash-t, a láncot, a naplózott kiállítások és a bizonylatok egyezését, a naplózatlan bizonylatokat és a triggereket ellenőrzi; a lánc utolsó bejegyzését a mentéssel együtt kell megőrizni (a felhasználói dokumentáció 9. fejezete leírja, mit mutat ki és mit nem). |
| „Adóhatósági ellenőrzési adatszolgáltatás” funkció (8. § (1) c), 11/A. §) | Export dátum- vagy sorszámtartományra a 3. melléklet szerinti XML-ben, mellette NAV Online Számla XML és PDF. Egy-egy, a sémába nem írható bizonylat nem akasztja meg az exportot: kimarad, és az OLVASSEL.txt megnevezi. |
| Azonnali NAV-adatszolgáltatás (8. § (1) d), 13/A. §) | Kiállításkor automatikus beküldés (`manageInvoice`), státuszkövetés, újraküldés, eredeti → módosítás sorrend. Kettős beküldés elleni védelem: a bizonytalan kimenetelű beküldést a NAV tranzakciólistájával, az ismétlésként elutasítottat a NAV-nál a sorszámon tárolt számla adataival (`queryInvoiceData`) egyezteti. Jelentettnek csak a bájtra azonos beküldést, a NAV webes felületén kézzel rögzített, azonos kulcsadatú (kelte, eladó, vevő, pénznem, forintösszegek) számlát, illetve a más úton (más számlázó program gépi interfészén, XML-feltöltéssel, a NAV Online Számlázójával vagy online pénztárgéppel) érkezett, a kulcsadatai mellett tételenként is egyező (megnevezés, mennyiség, egység, nettó összeg, ÁFA-kulcs) számlát tekinti; amit a NAV több mint 5 perccel e számla kiállítása előtt kapott meg, az akkor sem ez a számla, ha az adatai egyeznek. Minden más esetben sorszám-ütközést jelez (az ilyen számla és módosító/sztornó számlája nem minősül jelentettnek). Az 1 MB fölötti NAV-adatot tömörítve küldi, a NAV méretkorlátait meghaladó számlát nem állítja ki. A teszt környezetbe küldött jelentést minden eredmény „TESZT környezet” jelöléssel mutatja (az nem adatszolgáltatás), és éles környezetben nem tekinti jelentettnek: az ilyen számlát megnevezi, és csak a felhasználó kifejezett megerősítésével, külön művelettel (`nav_send_to_configured_environment`, parancssorban `openszamla nav-send-to-configured-environment … --confirm`), új beküldéssel jelenti az éles rendszerbe – a webes felület ilyet nem küld be. A hibás vagy sérült NAV-beállítást induláskor (és mentéskor) jelzi; ha a NAV nem érhető el vagy forgalomkorlátozást kér, a beküldést később pótolja. |
| Dokumentáció, csak dokumentált funkciók (10. §) | [Felhasználói dokumentáció](felhasznaloi-dokumentacio.md) minden MCP-eszközről és paraméterről, CLI-parancsról és kapcsolóról, webes műveletről és környezeti változóról; a program név- és verzióazonosítója: OpenSzámla, `OPENSZAMLA-0000001`, verziószám a `package.json` szerint (`openszamla --version`). A dokumentáció az npm-csomag és a Claude Desktop-bővítmény része, változatonként online is elérhető: `https://github.com/openszamla/openszamla/blob/v<verzió>/docs/felhasznaloi-dokumentacio.md`. |

## A számla tartalma (Áfa tv. 169. §)

A program minden kötelező adatot nyomtat (kelte, sorszám, eladó és vevő neve, címe, adószámai,
megnevezés, mennyiség, mennyiségi egység, teljesítés dátuma, nettó egységár, adóalap, adómérték,
áthárított adó – devizás számlánál forintban is), és a [kötelező szöveges megjelöléseket](research/02-jogi-kovetelmenyek.md#20-kötelező-szöveges-megjelölések-összesítő-táblázat)
(„fordított adózás”, „pénzforgalmi elszámolás”, „különbözet szerinti szabályozás – …”, adómentességi
hivatkozások) az ÁFA-kódokból automatikusan előállítja. Alanyi adómentes eladó számláján nem szerepel
adómérték és áthárított adó.

Módosító és érvénytelenítő számlán az eladó aktuális azonosító adatai szerepelnek, de az ÁFA-helyzete
(alanyi adómentesség, pénzforgalmi elszámolás, KATA) és az árfolyam az eredeti számláé, mert az eredeti
ügyletet helyesbíti. Módosító számla csak tétellel állítható ki (a NAV tétel nélkülit nem fogad be);
csak fejadat javításához 0 összegű különbözeti tétel adható meg.

Devizás számlánál az árfolyam a teljesítés napjára vonatkozik (Áfa tv. 80. §): a program a másolt
számla árfolyamát nem viszi át, a teljesítési dátum változásakor a kézi árfolyamot újra kéri, devizás
végszámlán pedig az előleg árfolyamát az előlegszámlából veszi (vagy megadását kéri).

## Az elektronikus számla megőrzése

Az e-mailben (vagy más elektronikus úton) átadott PDF-számla elektronikus számla. A program a kiállított
bizonylat kiállításkor elkészült PDF-jét eredetiként, bájtra pontosan megőrzi, és később – programfrissítés
után is – mindig ezt adja ki; újra nem állítja elő ([felhasználói dokumentáció 6.14](felhasznaloi-dokumentacio.md#614-invoice_pdf--pdf)).

| Követelmény | Megvalósítás |
|---|---|
| Hitelesség, sértetlenség, olvashatóság a megőrzés végéig (Áfa tv. 168/A. §) | Minden kiállított bizonylat (számla, előleg- és végszámla, módosító és sztornó számla, díjbekérő) PDF-je a kiállításkor egyszer készül el, és az adatbázisba kerül SHA-256 és SHA3-512 lenyomattal, a méretével és az előállító program nevével, verziójával. A megőrzést a hash-láncolt auditnapló is rögzíti (`invoice.document`). Az MCP-eszköz, az erőforrás, a parancssor, a webes letöltés és az adóhatósági export ugyanezt a bájtsort adja ki; az `invoice_pdf`, az `openszamla pdf` és a webes felület (a bizonylat oldalának fejében, a letöltés mellett) az eredeti SHA-256 lenyomatát is megmutatja. Az `openszamla verify` a megőrzött PDF-eket a lenyomatukkal és a naplóval is összeveti. |
| Elektronikus okirat elektronikus megőrzése a hitelességet biztosító adatokkal; formátumváltás csak a 168/A. § teljesülése mellett (Áfa tv. 179. § (2)) | Az eredeti az átadott formátumban és bájtsorral marad meg; a program nem alakítja át, és nem állítja elő újra egy újabb változattal (ami a láblécben és a metaadatban más bájtsort adna – a jogi kérdést, hogy ez formátumváltásnak minősül-e, így nem kell eldönteni). A lenyomatok az eredeti mellett, ugyanabban az adatbázisban és a mentésben vannak. Az eredeti PDF-ek megőrzése előtt kiállított bizonylat PDF-jét a program csak `_UJRAELOALLITOTT` jelöléssel, külön fájlba állítja elő, és nem tekinti eredetinek. |
| Védelem az utólagos módosítás ellen (1/2018. (VI. 29.) ITM rendelet 3. §) | SQLite triggerek tiltják a megőrzött eredeti cseréjét, módosítását és törlését, és azt, hogy piszkozathoz eredeti kerüljön; a programon kívüli módosítást az `openszamla verify` kimutatja (a lenyomat, a napló és a triggerek ellenőrzésével). A program minden kiadás előtt is összeveti a megőrzött eredetit a lenyomatával és a naplóval: a sérült vagy módosult példányt eredetiként nem adja ki, és a `pdf/` mappában lévő példányt sem írja felül vele (DOCUMENT_INTEGRITY_FAILED). |
| 8 év megőrzés (Számv. tv. 169. §) | A mentés (`openszamla backup`) az adatbázissal együtt a megőrzött eredeti PDF-eket is tartalmazza. Egy régebbi mentés visszaállítása után az újra kiadott sorszámú bizonylat nem írja felül az elveszett számla `pdf/` mappában maradt PDF-jét: a program `…_KORABBI_<időbélyeg>.pdf` néven megőrzi és jelzi. |

Későbbi lehetőség: a NAV-adatszolgáltatásban az elektronikus számla lenyomatának (`electronicInvoiceHash`,
SHA3-512, nagybetűs hexa) beküldése – az 1/2018. (VI. 29.) ITM rendelet 7. §-a szerint a NAV-nak
beküldött lenyomat a megőrzés bizonyítéka. A program a SHA3-512 lenyomatot ma is kiszámítja és
megőrzi, de a NAV-nak nem küldi be (ehhez élő próba kell a NAV tesztkörnyezetében).

## Pénzforgalmi elszámolás (Áfa tv. 196/B. §)

Pénzforgalmi elszámolásnál a fizetendő adót az ellenérték megtérülésekor (jóváírásakor, kézhezvételekor)
kell megállapítani, részfizetésnél „legalább a megfizetett részlet erejéig” (196/B. § (2) a), (3) a) aa)).
A program ehhez:

- a pénzforgalmi elszámolású eladó számláján a „pénzforgalmi elszámolás” megjelölést nyomtatja, és a
  NAV-adatszolgáltatásban jelzi (`cashAccountingIndicator`) – csak százalékos ÁFA-kulcsú tételt tartalmazó
  számlán, mert a módszer a fordítottan adózó, adómentes és Közösségen belüli ügyletekre nem vonatkozik;
- minden befizetést, visszafizetést és visszavonást a dátumával rögzít a csak bővíthető befizetési
  naplóban, azzal együtt, hogy a számla és módosító számlái közül melyikre mennyi jutott belőle; a
  bizonylat befizetett összege és a teljes kifizetés napja ebből adódik, és a sztornózott számlára
  befizetett összeg visszafizetése a sztornó számlán rögzíthető ([felhasználói dokumentáció 6.13](felhasznaloi-dokumentacio.md#613-invoice_record_payment--befizetés-rögzítése));
- az időszaki összesítő és az export befizetés dátuma szerinti alapja (`dateBasis: "payment"`) az
  időszak befizetéseinek a pénzforgalmi elszámolással kiállított bizonylatokra jutó részeit összesíti, a
  bizonylat ÁFA-jával arányos adóval (rész × ÁFA ÷ bruttó végösszeg, forintban, a bizonylat árfolyamán,
  részenként és ÁFA-kódonként 0,01 forintra kerekítve); a befizetési napló CSV-ben és JSON-ban
  exportálható ([6.17](felhasznaloi-dokumentacio.md#617-report_summary--időszaki-összesítő-csak-olvas),
  [6.18](felhasznaloi-dokumentacio.md#618-export_invoices--export)).

A részfizetés adójának számítását és kerekítését, és azt, hogy egy ügyletre vonatkozik-e a módszer, a
program nem dönti el: az összesítő figyelmeztetése szerint ezt – és a bevallandó adót – a könyvelő
állapítja meg.

## A felhasználó feladatai

1. Regisztráció az Online Számla rendszerben, technikai felhasználó és kulcsok – [nav-beallitas.md](nav-beallitas.md).
2. A számla kelte a kibocsátás (a vevő rendelkezésére bocsátás) napja: a kiállított számlát még aznap küldd el
   vagy add át a vevőnek (a program a kiállítás napját írja kelteként).
3. Devizás számláknál az **MNB-árfolyam** választását előzetesen be kell jelenteni a NAV-nak (Áfa tv.
   80. § (2) b)); ennek hiányában a bank deviza eladási árfolyamát kell használni (beállítás:
   `seller_update` → `defaults.exchangeRateSource: "manual"`).
4. Alanyi adómentesség, pénzforgalmi elszámolás választása: a NAV felé tett nyilatkozat (a programban
   csak jelölni kell).
5. Megőrzés 8 évig (elektronikus számlát elektronikusan): rendszeres mentés (`openszamla backup` – a
   megőrzött eredeti PDF-eket is tartalmazza), és a program dokumentációjának (verziónként) megőrzése
   az elévülésig. A vevőnek a program által megőrzött PDF-et add át (`invoice_pdf`, `openszamla pdf`,
   „PDF letöltése”); ha más fájlt adsz át (pl. átalakított vagy újra nyomtatott PDF-et), annak
   megőrzéséről magadnak kell gondoskodnod.
6. NAV-kiesés esetén a pótlás figyelemmel kísérése (`nav_sync`, 24 órás határidő); 48 óránál hosszabb
   saját kiesésnél bejelentés és kézi rögzítés a NAV felületén. A NAV által elutasított jelentés okát
   el kell hárítani, és ugyanazt a számlát újra kell küldeni ([nav-beallitas.md](nav-beallitas.md#5-mi-történik-hiba-esetén)).
7. Éles számlázáshoz a NAV-kapcsolatot **éles** (`production`) környezetre kell állítani: a teszt
   környezetbe küldött számla nem adatszolgáltatás. A program az éles környezetben a csak a teszt
   rendszerbe jelentett számlát nem tekinti jelentettnek (a `setup_status` megnevezi); ha valódi
   számla, az éles rendszerbe kell küldeni (`nav_send_to_configured_environment` – a
   felhasználó megerősítésével, [nav-beallitas.md](nav-beallitas.md#4-éles-használat)).
8. A „SZAMLAZO” bejelentés **2021. január 4. óta nem kell** (17/2020. (XII. 30.) PM rendelet).

## Amit a 0.1-es verzió nem tud

- egyszerűsített számla, gyűjtőszámla, önszámlázás, termékdíjas tételek, új közlekedési eszköz
  részletes adatai, mezőgazdasági kompenzációs felár;
- különbözet szerinti szabályozásnál csak a kötelező jelölés és a teljes ellenérték kezelése: a különbözet
  (árrés) adóalapjának és adójának számítása nincs benne. Utazásszervezőknél ezeket 2026-01-01-től a NAV-nak
  forintban jelenteni kell (Áfa tv. 210/A. § (3)), ezért a program `KUL_UTAZAS` tételt 2026-01-01 utáni
  teljesítéssel nem enged kiállítani;
- a webes felület kijelentkeztetett munkameneteit, a belépési korlátot és az `/mcp` hibás tokenjeinek
  számlálását a program a memóriában tartja (újraindításkor nullázódnak): a szerver újraindítása után
  egy kilépés előtt ellopott süti a lejáratáig (legfeljebb 12 óra) újra érvényes lehet. Ha ez kockázat,
  indítsd a szervert új hozzáférési tokennel (ez minden korábbi sütit érvénytelenít);
- nyugta / e-nyugta (2026-09-01-től külön adatszolgáltatás);
- minősített elektronikus aláírással hitelesített e-számla, EDI;
- az elektronikus számla lenyomatának (`electronicInvoiceHash`) beküldése a NAV-nak (a program a
  lenyomatot kiszámítja és megőrzi, lásd [Az elektronikus számla megőrzése](#az-elektronikus-számla-megőrzése));
- OSS/IOSS (egyablakos) ügyletek külön kezelése;
- pénzforgalmi elszámolásnál a bevallandó ÁFA meghatározása (Áfa tv. 196/B. §): a befizetés dátuma szerinti
  összesítés a befizetésekkel arányos adót mutatja (lásd fent, Pénzforgalmi elszámolás), de hogy a
  részfizetés adóját így kell-e megállapítani, és mit kell bevallani, a könyvelő dönti el; bankszámlakivonat
  importja és a befizetések automatikus párosítása nincs (a befizetést kézzel kell rögzíteni);
- teljesítési dátumot javító módosító számla után az eredeti időszak helyesbítése: az összesítő és az
  export minden bizonylatot a saját teljesítési dátuma szerinti időszakba sorol (az eredeti számla az
  eredeti időszakban marad), és erre figyelmeztet; hogy az eredeti időszakot önellenőrzéssel kell-e
  helyesbíteni, a könyvelő dönti el;
- technikai érvénytelenítés (`manageAnnulment`) – helyette a NAV webes felülete használható;
- más programmal kiállított (ebben az adatbázisban nem szereplő) számla módosítása vagy sztornózása;
  a NAV által elutasított eredeti számlához tartozó módosító/sztornó számla jelentése (előbb az
  eredeti jelentését kell pótolni);
- tétel nélküli módosító számla (csak fejadat javítására 0 összegű különbözeti tétel adható meg);
- több cég egy adatbázisban (cégenként külön adatkönyvtár használható);
- a PDF-en csak latin (ékezetes), cirill és görög betűs szöveg jeleníthető meg: más írásrendszerű (pl. kínai,
  arab, héber) nevet latin betűs átírással kell megadni – a program a nem megjeleníthető karaktert a
  kiállítás előtt jelzi, a kötelező adatoknál hibaként (PDF_UNPRINTABLE_CHARACTERS).

Ezekben az esetekben használj más, erre alkalmas programot vagy a NAV Online Számlázóját.

## Licencek

Az OpenSzámla saját kódja MIT licencű ([LICENSE](../LICENSE)). A PDF-ekbe ágyazott Roboto betűkészlet
(a pdfmake része, a Claude Desktop-bővítmény terjeszti) a SIL Open Font License 1.1 alatt áll; a NAV
XSD-k és mintafájlok MIT licencűek. A harmadik féltől származó összetevők közleményei és
licencszövegei: [THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES).
