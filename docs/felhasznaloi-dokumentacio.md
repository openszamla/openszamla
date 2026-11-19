# OpenSzámla – felhasználói dokumentáció

| | |
|---|---|
| Program neve | OpenSzámla |
| Azonosító (NAV `softwareId`) | `OPENSZAMLA-0000001` (telepítésenként felülírható: `OPENSZAMLA_SOFTWARE_ID`) |
| Verzió | 0.1.0 (a futó verzió: `openszamla --version`) |
| Működési típus | helyben futó program (`LOCAL_SOFTWARE`) |
| Fejlesztő | OpenSzámla közreműködők – https://github.com/openszamla/openszamla |
| Licenc | MIT (a harmadik féltől származó összetevőké: `THIRD-PARTY-NOTICES`) |
| Dokumentáció | a telepített csomag része (`docs/felhasznaloi-dokumentacio.md`); változatonként online is: `https://github.com/openszamla/openszamla/blob/v<verzió>/docs/felhasznaloi-dokumentacio.md` |

Ez a dokumentum a 23/2014. (VI. 30.) NGM rendelet 10. §-a szerinti felhasználói dokumentáció: leírja
a program működését és **valamennyi funkcióját**. A program kizárólag az itt leírt funkciókat hajtja
végre. A funkciók változását a [CHANGELOG.md](../CHANGELOG.md) és ennek a dokumentumnak az új
változata rögzíti; a dokumentációt (minden változatát) a program használója az áthárított adó
megállapításához való jog elévüléséig köteles megőrizni.

## 1. Áttekintés

Az OpenSzámla számlákat és számlával egy tekintet alá eső okiratokat (módosító és érvénytelenítő
számla) állít ki, valamint díjbekérőt (nem számla) készít. A kiállított számlák adatait a kiállításkor
a NAV Online Számla rendszerébe továbbítja. Három kezelőfelülete van, amelyek ugyanazt a programrészt
hívják, ugyanazokkal az ellenőrzésekkel:

- **MCP szerver** – AI-ügynökök (Claude, Codex stb.) használják (6. fejezet);
- **parancssor** (`openszamla …`) (7. fejezet);
- **webes felület** (`openszamla serve`) (8. fejezet).

Ahol a felületek tudása eltér (pl. módosító számla csak MCP-n készíthető), az adott fejezet leírja.
Minden adatváltoztató műveletet a program az auditnaplóba ír (6.20).

## 2. Alapfogalmak

| Fogalom | Leírás |
|---|---|
| Eladó | a program használója (saját cég / egyéni vállalkozó); adatai minden számlára rákerülnek |
| Vevő | a számla címzettje: belföldi áfaalany (`DOMESTIC`), egyéb – külföldi vagy nem áfaalany szervezet (`OTHER`), magánszemély (`PRIVATE_PERSON`) |
| Piszkozat | még nem kiállított, szabadon módosítható és törölhető tervezet; nincs sorszáma, nem számla |
| Előnézet | a piszkozat úgy, ahogy a kiállítás az adott napon kiállítaná: a mai kelte, az ebből adódó fizetési határidő, az eladó aktuális adatai, a vevők közül választott vevő aktuális adatai, újraszámolt összegek (6.7) |
| Kiállítás | a piszkozat lezárása: sorszámot kap, a kelte a kiállítás napja, tartalma véglegessé válik, PDF készül (ezt a program eredetiként, bájtra pontosan megőrzi, 6.14), a NAV-nak jelentésre kerül |
| Eredeti PDF | a kiállított bizonylat kiállításkor elkészült PDF-je, amelyet a program az adatbázisban SHA-256 és SHA3-512 lenyomattal megőriz, és később is pontosan ezt adja ki – soha nem állítja elő újra (6.14) |
| Sorszámtartomány | sorszám-minta (pl. `SZ-{YYYY}-{SEQ:5}` → `SZ-2026-00001`); a számlák és a díjbekérők külön tartományt használnak; egy sorszám az összes tartományban egyedi |
| Sztornó számla | érvénytelenítő számla: az eredeti számla (és korábbi módosításai) összes tételének ellentéte |
| Módosító számla | helyesbítő számla: csak a változást (különbözetet) tartalmazza |
| ÁFA-kód | a tétel adózási módja (`27`, `18`, `5`, `0`, `AAM`, `TAM`, `KBAET`, …) – 4. fejezet |
| Árfolyamforrás | devizás bizonylatnál `MNB` (az MNB hivatalos árfolyama, a program kéri le) vagy `manual` (kézi: az árfolyamot meg kell adni) – 5.2 |
| Kintlévőség | kiállított, nem sztornózott számla, előleg-, vég- vagy módosító számla pozitív végösszeggel, amely nem sztornózott számlát módosít – erre vár az eladó fizetést, amíg nincs rendezve; a számla és kiállított módosító számlái együtt rendeződnek (a jóváírás beszámít, 6.13). Díjbekérő, sztornó számla, jóváíró (negatív) módosító számla és 0 Ft-os bizonylat nem kintlévőség. A készpénzes és a kártyás számla is kintlévőség, amíg a befizetése nincs rögzítve: a helyben kifizetett számla a kiállításkor kifizetettnek jelölhető (`markPaid`, 6.9) |
| Dátumalap | időszakos összesítésnél és exportnál: a kelte (`issue`, alapértelmezés), a teljesítés dátuma (`fulfillment` – főszabály szerint az ÁFA szempontjából irányadó nap) vagy a befizetés dátuma (`payment`) szerint kerül-e egy számla az időszakba. Pénzforgalmi elszámolásnál az adót az ellenérték megtérülésének (a befizetésnek) az időszakában kell megállapítani (Áfa tv. 196/B. §): ezt a befizetés dátuma szerinti alap mutatja (a pénzforgalmi elszámolással kiállított bizonylatok befizetései, arányos ÁFA-val); a kelte és a teljesítés szerinti összesítő és export erre figyelmeztet (6.17, 6.18) |
| Befizetési napló | a rögzített befizetések, visszafizetések és visszavonások naplója: mindegyik a dátumával, összegével és forrásával, és azzal, hogy a számla és módosító számlái közül melyikre mennyi jutott belőle (felosztás). Ebből adódik a bizonylatok befizetett összege és a teljes kifizetés napja (6.13); exportálható (6.18) |
| NAV-környezet | `test` (a NAV tesztrendszere – valódi adatszolgáltatás nem történik) vagy `production` (éles) |
| MCP-kliens | az AI-alkalmazás, amely az OpenSzámla MCP szerverét elindítja és használja (Claude Desktop, Claude Code, Codex, Cursor, VS Code stb.); a saját beállításában szerepel, milyen paranccsal indítja (7.9) |
| Skill | az AI-nak szóló útmutató a magyar számlázás menetéről (`magyar-szamlazas`); a Claude Code és a Codex egy mappából olvassa (7.10) |
| Azonosító vagy sorszám | ahol a program egy számlát vár, a belső azonosító (`inv_…`) és a sorszám is megadható. Az `inv_` kezdetű értéket előbb azonosítóként, majd sorszámként keresi (így az `inv_…` kezdetű sorszámok is működnek); az elején és végén álló szóköz nem számít |
| Megerősítő kód | a visszafordíthatatlan műveletekhez (kiállítás, sztornó, a másik NAV-rendszerhez tartozó számla beküldése a beállított rendszerbe) a program által az előnézettel kiadott, legalább 10, legfeljebb 20 percig érvényes kód (6.9, 6.10, 6.15.1) |

## 3. Telepítés, beállítás, adatok

### 3.1 Telepítés

1. **Node.js 22.13.0 vagy újabb** (ajánlott: az aktuális LTS-változat, pl. 24). Windows 10/11:
   `winget install OpenJS.NodeJS.LTS` (PowerShellben vagy a Terminálban), vagy a https://nodejs.org
   oldal LTS-telepítője (a „Tools for Native Modules” lehetőség nem kell: a programnak nincs natív
   összetevője). macOS: a https://nodejs.org LTS-telepítője, vagy `brew install node`. Linux: a
   disztribúció csomagkezelője, ha legalább 22.13-at telepít, különben a NodeSource-csomagok vagy az
   nvm. A telepítés után **új terminálablakot** kell nyitni (a már nyitott nem látja az új programot);
   ellenőrzés: `node --version`.
   **Windowson** a további parancsokat a Terminálban (PowerShellben) `.cmd` végződéssel kell írni
   (`npm.cmd`, `openszamla.cmd`): a Windows alapbeállítása a PowerShellben letiltja az npm és az OpenSzámla
   `.ps1` indítóját („running scripts is disabled on this system”, 3.6); a Parancssorban (`cmd`) a
   végződés nélküli parancs is működik.
2. **A program telepítése:** Windows PowerShellben `npm.cmd install -g openszamla`, macOS-en, Linuxon
   (és a Windows Parancssorban) `npm install -g openszamla`; ellenőrzés: `openszamla --version`
   (PowerShellben `openszamla.cmd --version`). Amíg a
   csomag nem érhető el az npm-en, csomagfájlból: `npm install -g ./openszamla-<verzió>.tgz` (Windows
   PowerShellben `npm.cmd install -g .\openszamla-<verzió>.tgz`; a
   csomagfájlt a forráskód mappájában az `npm install`, `npm run build`, `npm pack` parancsok készítik);
   forráskódból, fejlesztéshez: `npm install`, `npm run build`, majd `npm link`. Telepítés nélkül:
   `npx -y openszamla <parancs>` – így viszont az MCP-kliensek beállításába nem írható tartós útvonal
   (7.9).
3. **Első beállítás:** `openszamla setup` (Windows PowerShellben `openszamla.cmd setup`; 7.11) –
   lépésenként: futtatókörnyezet, adatkönyvtár, eladói
   adatok, NAV technikai felhasználó, az AI-kliensek beállítása és a skill; minden lépés kihagyható, a
   parancs újra futtatható. Az eredmény ellenőrzése bármikor: `openszamla doctor` (7.12). A lépések
   külön is elvégezhetők: `openszamla init` (7.2), `openszamla nav-setup` (7.3), `openszamla config
   <kliens> --write` (7.9), `openszamla install-skill` (7.10).

- A Claude Desktop-bővítmény (`openszamla-<verzió>.mcpb`, dupla kattintással telepíthető) és a Claude
  Code-plugin telepítése: [kliensek.md](kliensek.md), beállításaik: 3.5. Telepítési hibák és
  elhárításuk: 3.6.
- A paraméter nélkül indított `openszamla` terminálban (ha a bemenete és a kimenete is terminál) rövid
  üdvözlő szöveget ír ki: az első lépés (`openszamla setup`), az ellenőrzés (`openszamla doctor`), a
  webes felület (`openszamla serve`), a súgó (`openszamla --help`) és a dokumentáció címe; egyébként
  (pl. átirányított kimenetnél) a súgót. Kilépési kód: 0.
- Futtatókörnyezet: **Node.js 22.13.0 vagy újabb** (ajánlott: 24 LTS). Induláskor a program
  ellenőrzi a Node.js változatát és a beépített `node:sqlite` modul működését; ha nem megfelelő,
  1-es kilépési kóddal leáll, és a hibakimenetre (stderr) ezt írja: „OpenSzámla: Node.js 22.13.0
  vagy újabb szükséges (beépített node:sqlite modullal); ez a futtatókörnyezet: <változat>.” A Node.js
  22-es változatai a beépített adatbázismodul első használatakor egy „ExperimentalWarning: SQLite is an
  experimental feature …” figyelmeztetést írnának a hibakimenetre: ezt az egyet a program nem írja ki
  (a felhasználónak nincs vele teendője); minden más futtatókörnyezeti figyelmeztetés megjelenik.
- Az npm-csomag parancssori program és MCP szerver. Programkönyvtárként nem használható: nincs
  dokumentált programozói felülete, az `import 'openszamla'` `ERR_PACKAGE_PATH_NOT_EXPORTED` hibát ad.
- A csomag és a Claude Desktop-bővítmény tartalmazza ezt a dokumentációt, továbbá a
  `docs/jogi-megfeleles.md`, `docs/nav-beallitas.md`, `docs/kliensek.md`, `CHANGELOG.md`, `README.md`,
  `LICENSE` és `THIRD-PARTY-NOTICES` fájlt. Globális telepítésnél a csomag mappája: `npm root -g` →
  `openszamla`. Az adott változat dokumentációja online:
  `https://github.com/openszamla/openszamla/blob/v<verzió>/docs/felhasznaloi-dokumentacio.md`
  (a bővítmény „documentation” hivatkozása is ide mutat).

### 3.2 Adatkönyvtár

- Alapértelmezés: `~/.openszamla` (Windows: `C:\Users\<név>\.openszamla`). Más mappa: a `--data-dir
  <mappa>` kapcsoló vagy az `OPENSZAMLA_HOME` környezeti változó (ha mindkettő meg van adva, a
  kapcsoló érvényes). Az adatbázisfájl külön is megadható: `OPENSZAMLA_DB`.
- Útvonalszabályok (`OPENSZAMLA_HOME`, `OPENSZAMLA_DB`, `--data-dir`):
  - a magában álló `~`, illetve a `~/` vagy `~\` kezdet a felhasználó saját mappáját jelenti;
  - ha az érték `${` jelet tartalmaz, vagy `$NÉV`, illetve `%NÉV%` alakkal kezdődik (az MCP-kliens
    vagy a parancsértelmező nem helyettesítette be a változót), a program nem indul el: INVALID_CONFIG,
    „<beállítás>: a(z) "<érték>" útvonalban ki nem fejtett változó van.” – a javaslat: abszolút útvonal,
    vagy a beállítás elhagyása (akkor `~/.openszamla`);
  - minden más relatív útvonalat a munkakönyvtárhoz képest értelmez; az üres érték „nincs megadva”.
- MCP-kliens konfigurációjában mindig **abszolút útvonalat** adj meg: a kliensek a szervert eltérő
  munkakönyvtárból (Claude Code projektenként másból) indítják, így egy relatív útvonal mindenhol
  külön, üres adatbázist – és külön sorszámozást – eredményezne.
- Az `openszamla mcp` és az `openszamla serve` induláskor a hibakimenetre (stderr; az MCP-kliensek ezt
  a szerver naplójába teszik) kiírja: „OpenSzámla <verzió> – adatkönyvtár: <abszolút útvonal>”. Relatív
  `OPENSZAMLA_HOME`, `--data-dir` vagy `OPENSZAMLA_DB` esetén figyelmeztet is: „Figyelem: relatív
  útvonal ("…"), a munkakönyvtárhoz (…) képest értelmezve. …”. Stdio módban a szabványos kimenetre
  (stdout) csak az MCP-protokoll üzenetei kerülnek.
- Ha az adatkönyvtár (vagy az `OPENSZAMLA_DB` mappája) nem hozható létre, illetve nem mappa – a helyén
  vagy az útvonalában fájl van, a meghajtó vagy a hálózati hely nem érhető el, nincs írási jog –, a
  program minden módban leáll: „Hiba [DATA_DIR_UNAVAILABLE]: Az adatkönyvtár nem hozható létre és nem
  nyitható meg: <mappa> – <ok>.” (az adatbázis mappájánál: „Az adatbázis mappája …”), a javaslat
  a megfelelő beállítást nevezi meg. Stdio módban is csak a hibakimenetre ír.
- **Ne legyen OneDrive-mappában vagy hálózati helyen.** A szinkronizáló program használat közben
  másolhatja az SQLite-adatbázist és a mellette lévő `-wal`, `-shm` fájlokat, hálózati meghajtón pedig az
  SQLite fájlzárolása nem megbízható: az adatbázis megsérülhet, két gépen használva a sorszámozás
  kettéválhat. Az `openszamla doctor` (7.12) és az `openszamla setup` (7.11) figyelmeztet, ha az
  adatkönyvtár a `OneDrive`, `OneDriveConsumer` vagy `OneDriveCommercial` környezeti változó (ezeket a
  Windows állítja be) mappáján belül, UNC-útvonalon (`\\szerver\megosztás\…` – ezt hálózati hozzáférés
  nélkül ismeri fel) vagy hálózati meghajtóként csatolt betűjelen van (ennek valódi útvonala UNC): „Az
  adatkönyvtár egy OneDrive-mappában van (…): a szinkronizálás az SQLite-adatbázist (és a mellette lévő
  -wal, -shm fájlokat) használat közben másolhatja, így az adatbázis megsérülhet vagy ütköző példányok
  keletkezhetnek – két gépen használva a sorszámozás is kettéválhat.”, illetve „Az adatkönyvtár hálózati
  helyen van (…): hálózati meghajtón az SQLite fájlzárolása nem megbízható, egyszerre használva vagy
  megszakadó kapcsolatnál az adatbázis megsérülhet.” A javaslat: helyi, nem szinkronizált mappa (pl. az
  alapértelmezett), az OpenSzámla bezárása után a mappa átmásolása, `openszamla setup --data-dir "<új
  mappa>"`, és rendszeres mentés (`openszamla backup <fájl>`, 7.8) – a mentésfájl már mehet a OneDrive-ra
  vagy a hálózati meghajtóra. A program ettől még használja a megadott mappát.
- Az adatkönyvtár tartalma: `openszamla.db` (adatbázis – benne a kiállított bizonylatok megőrzött eredeti
  PDF-je, 6.14), `pdf/` (a kiállított bizonylatok PDF-jei: a megőrzött eredeti másolata, 6.14),
  `pdf/drafts/` (tervezetek), `export/` (exportok, 6.18–6.19), `backups/` (a programból készített
  mentések, 6.22, 8.5), visszaállítás után az `openszamla.db.visszaallitas-elott-<dátum>` fájl (a félretett
  korábbi adatbázis, 7.14), `nav-credentials.json` (ha a
  NAV-adatokat a `nav-setup`-pal adtad meg; Linuxon és macOS-en `0600` jogosultsággal), `http-token`
  (a HTTP mód hozzáférési tokenje, 8. fejezet).

### 3.3 Környezeti változók

| Változó | Jelentés |
|---|---|
| `OPENSZAMLA_HOME` | adatkönyvtár (3.2) |
| `OPENSZAMLA_DB` | adatbázisfájl (alapértelmezés: `<adatkönyvtár>/openszamla.db`; útvonalszabályok: 3.2) |
| `OPENSZAMLA_NAV_ENV` | NAV-környezet: `test` / `teszt` vagy `production` / `prod` / `éles` / `eles`. Megadva felülírja a `nav-setup`-ban mentett környezetet; üresen a mentett érvényes (ha az sincs: `test`). Más érték: „Ismeretlen NAV környezet: …” (INVALID_CONFIG), a program nem indul el (ha NAV-adatok nincsenek megadva, az érték hatástalan) |
| `OPENSZAMLA_NAV_LOGIN`, `OPENSZAMLA_NAV_PASSWORD`, `OPENSZAMLA_NAV_SIGNING_KEY`, `OPENSZAMLA_NAV_EXCHANGE_KEY` | a NAV technikai felhasználó login neve, jelszava, XML aláírókulcsa és XML cserekulcsa – csak együtt adhatók meg; ha a login meg van adva, de valamelyik másik hiányzik: „Hiányos NAV beállítás a környezeti változókban.” (INVALID_CONFIG), a program nem indul el |
| `OPENSZAMLA_NAV_AUTO_SUBMIT` | kiállításkor azonnali NAV-beküldés (alapértelmezés: igen; igaznak számít: `1`, `true`, `yes`, `igen`, `on`, minden más érték hamis) |
| `OPENSZAMLA_NAV_AUTO_SYNC` | a futó szerver (`openszamla serve`, `openszamla mcp`) automatikus NAV-szinkronja: a már megkezdett beküldések befejezése kb. 5 percenként (6.15; alapértelmezés: igen; `0` kikapcsolja) |
| `OPENSZAMLA_NAV_WAIT_SECONDS` | kiállításkor legfeljebb ennyi másodpercig várja a NAV feldolgozási eredményét (alapértelmezés: 20; 0–45; nem szám érték: 0). A kiállítás NAV-része – a beküldés és a várakozás együtt – ettől függetlenül legfeljebb kb. 20 másodperc (6.9), ezért nagyobb érték ezt nem hosszabbítja meg |
| `OPENSZAMLA_CONFIRM_MODE` | `code` (alapértelmezés: megerősítő kód kell), `elicit` (kód + a kliens párbeszédablakában adott jóváhagyás; az `openszamla serve` HTTP-végpontján csak 2026-07-28-as protokollú klienssel, 6.9), `none` (megerősítés nélkül – csak felügyelt automatizáláshoz); az `auto` és a `param` érték `code`-nak számít; más érték: INVALID_CONFIG, a program nem indul el |
| `OPENSZAMLA_ALLOW_FILE_COPY` | a PDF helyi mappába másolásának engedélyezése (`invoice_pdf` `copyToDir`, `openszamla pdf --out`; alapértelmezés: igen, az `openszamla serve` webes/HTTP szerverénél nem; értelmezése mint az `OPENSZAMLA_NAV_AUTO_SUBMIT`-é) |
| `OPENSZAMLA_SOFTWARE_ID` | a NAV-nak küldött programazonosító felülírása (pontosan 18 karakter: nagybetű, szám vagy kötőjel) |
| `OPENSZAMLA_HTTP_TOKEN` | a HTTP mód hozzáférési tokenje (8. fejezet): legalább 20 karakter, csak az angol ábécé betűi, számjegyek, `_` és `-`; gyengébb tokennel az `openszamla serve` nem indul el (INVALID_INPUT) – kivéve, ha az érték pontosan a `http-token` fájlban lévő token: az a mentett tokennek számít (figyelmeztetéssel elindul, 8. fejezet). A `/mcp` végponton hibás tokennel próbálkozó címet a szerver percenként 10 kísérlet után kivárásra kényszeríti (429, 8. fejezet), a webes belépést külön korlát védi (8.1) |
| `OPENSZAMLA_HTTP_HOST`, `OPENSZAMLA_HTTP_PORT` | a HTTP mód címe (alapértelmezés: `127.0.0.1`) és portja (alapértelmezés: `8787`; 0 és 65535 közötti egész szám, a 0 tetszőleges szabad portot jelent; más értékkel: „Érvénytelen port (OPENSZAMLA_HTTP_PORT): …”, INVALID_INPUT, a `serve` nem indul el) |
| `OPENSZAMLA_ALLOWED_HOSTS` | vesszővel elválasztva további elfogadott `Host` fejlécértékek (`név` vagy `név:port`), pl. a reverse proxy mögötti nyilvános név |
| `OPENSZAMLA_ALLOWED_ORIGINS` | vesszővel elválasztva további elfogadott `Origin` értékek, pl. `https://szamla.example.hu` |
| `OPENSZAMLA_TRUST_PROXY` | a kliens címe az `openszamla serve` `/mcp` próbálgatás elleni korlátjához (8. fejezet) a saját gépről (loopback) érkező kapcsolatnál az `X-Forwarded-For` fejléc utolsó eleméből (alapértelmezés: nem – a fejlécet figyelmen kívül hagyja, és a proxy mögötti minden kliens a proxy címével számít; értelmezése mint az `OPENSZAMLA_NAV_AUTO_SUBMIT`-é). Csak akkor kapcsold be (`1`), ha ugyanazon a gépen olyan reverse proxy fut a szerver előtt, amely maga állítja be a fejlécet (a Caddy alapból; nginx-nél `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) – TCP-alagút (ssh -R, frp, ngrok TCP módban) vagy a kliens fejlécét változatlanul továbbadó proxy mögött ne: ott a kliens maga választhatna címet minden próbálkozáshoz (8.7) |

Az `OPENSZAMLA_NAV_*`, `OPENSZAMLA_CONFIRM_MODE`, `OPENSZAMLA_SOFTWARE_ID`,
`OPENSZAMLA_ALLOW_FILE_COPY`, `OPENSZAMLA_HTTP_*`, `OPENSZAMLA_ALLOWED_*` és `OPENSZAMLA_TRUST_PROXY`
változónál az üres érték, valamint a teljes egészében ki nem fejtett `${…}` érték (pl.
`${user_config.nav_env}`, amit egy MCP-bővítmény a kitöltetlen beállítás helyén átadhat) „nincs
megadva”-nak számít: az üres `OPENSZAMLA_NAV_WAIT_SECONDS` tehát a 20 másodperces alapértelmezést
jelenti, az üres `OPENSZAMLA_NAV_ENV` a `nav-setup` választását hagyja érvényben, az üres
`OPENSZAMLA_HTTP_TOKEN` a mentett `http-token` fájlt, az üres `OPENSZAMLA_HTTP_HOST` /
`OPENSZAMLA_HTTP_PORT` pedig a `127.0.0.1` / `8787` alapértelmezést.

A NAV-végpontot kizárólag a környezet (`test` / `production`) határozza meg; más címre irányító
beállítás nincs.

### 3.4 NAV-kapcsolat

A technikai felhasználó létrehozása és a teendők hiba esetén: [nav-beallitas.md](nav-beallitas.md).

- **Honnan veszi a program az adatokat?** Ha az `OPENSZAMLA_NAV_LOGIN` (a jelszóval és a két kulccsal
  együtt) meg van adva, ezeket használja, különben az adatkönyvtár `nav-credentials.json` fájlját,
  amit az `openszamla nav-setup` ír (7.3). A megadott (nem üres) `OPENSZAMLA_NAV_ENV` mindkét esetben
  felülírja a környezetet. A `setup_status` és az `openszamla status` kiírja a környezetet és a
  forrást (`env` / `file`) – titkot soha.
- **Futás közben mentett beállítás:** a futó program (az MCP-szerver, az `openszamla serve`) a
  `nav-credentials.json` változását (méretét vagy módosítási idejét) a következő műveletnél észleli, és
  ugyanazokkal a szabályokkal olvassa újra, mint induláskor: a `nav-setup` után **nem kell
  újraindítani** – a `setup_status` azonnal az új beállítást mutatja, a `nav_sync` és a következő
  kiállítás már azzal jelent, a webes felület pedig az új titkokat is kitakarja. Az `OPENSZAMLA_NAV_*`
  környezeti változókat a program induláskor olvassa (ezek változásához újraindítás kell).
- **Ellenőrzés induláskor** (és a fájl minden újraolvasásakor): a `nav-credentials.json` olvasható,
  érvényes JSON-objektum, a mezői szövegek, a környezete `test` vagy `production`; a login név 6–15
  betű vagy szám, a jelszó és az XML aláírókulcs nem üres, az XML cserekulcs pontosan 16 karakter, az
  `OPENSZAMLA_SOFTWARE_ID` pontosan 18 karakter (nagybetű, szám, kötőjel). A fájl kódolása UTF-8 lehet,
  a fájl elején bájtsorrend-jellel (BOM – pl. a Windows PowerShell 5.1 `Out-File -Encoding utf8`
  parancsa és a régebbi Jegyzettömb írja) vagy anélkül, illetve bájtsorrend-jellel kezdődő UTF-16
  (little vagy big endian – ilyet ír a Windows PowerShell 5.1 `Out-File` parancsa és `>` átirányítása
  `-Encoding` nélkül, valamint a Jegyzettömb „Unicode” mentése): a program mindegyiket ugyanúgy olvassa
  és ellenőrzi. A bájtsorrend-jel nélküli UTF-16 fájlt és a nem dekódolható (pl. csonka) UTF-16 fájlt
  nem érvényes JSON-nak tekinti (lásd lent); ilyenkor mentsd a fájlt UTF-8-ként
  (`Out-File -Encoding utf8`), vagy írd meg a `nav-setup`-pal. Ha valami hibás – a
  hiányos vagy sérült fájl is (pl. kézi szerkesztés után maradt vessző, félbeszakadt mentés, üres
  jelszó) –, a program elindul (minden parancs működik: `status`, `list`, `verify`, `backup`, `mcp`,
  `serve`), de a NAV-kapcsolatot nem beállítottnak tekinti: a számlák kiállíthatók, NAV-állapotuk
  `not_configured`, egyet sem küld be, a `nav_sync` NAV_INVALID_CONFIG hibát ad („A NAV-kapcsolat
  beállítása hibás: …”), a hiba okát pedig a `setup_status` (`nav.problem`), az `openszamla status`
  („NAV: HIBÁS BEÁLLÍTÁS (<környezet>, file) – …”) és a webes felület is kiírja, a beállító paranccsal
  együtt. Sérült fájlnál az ok pl. „A NAV-beállítás fájlja (<útvonal>) nem érvényes JSON (pl. kézi
  szerkesztés vagy félbeszakadt mentés miatt).”, „… nem olvasható (<hibakód>).”, „… nem a várt
  formátumú (egy JSON-objektum kell).”, „… hibás: a(z) „password” mező nem szöveg (az értéket
  idézőjelek között kell megadni).”, „… hibás: a környezet („environment”) értéke test vagy production
  lehet.”; hiányzó vagy üres adatnál „A NAV technikai felhasználó adatai hibásak: a jelszó üres.”. A
  fájl értékeit a program soha nem írja ki; a környezet a fájlban megnevezett (ha kiolvasható,
  egyébként `test`), a megadott `OPENSZAMLA_NAV_ENV` itt is felülírja. A `nav-setup` a hibás fájlt
  felülírja. A beállítás javítása után a `nav_sync` beküldi a számlákat. (A hiányos `OPENSZAMLA_NAV_*`
  változók és az ismeretlen `OPENSZAMLA_NAV_ENV` továbbra is induláskori hiba, 3.3; ha az ismeretlen
  `OPENSZAMLA_NAV_ENV` csak egy futás közben mentett fájllal válik érvényessé, a futó program nem áll
  le, hanem ezt jelzi hibás beállításként: „Ismeretlen NAV környezet: …”.)
- **A beállító parancs** a teendőkben, a hibaüzenetekben, az `openszamla setup` és az `openszamla
  doctor` kiírásában és a webes felületen a legrövidebb helyes alakjában jelenik meg. A beépített
  adatkönyvtárnál (`~/.openszamla`) `--data-dir` nélkül: `openszamla nav-setup` (telepítés nélkül: `npx
  -y openszamla nav-setup`); minden más adatkönyvtárnál az adatkönyvtárral együtt:
  `openszamla nav-setup --data-dir "<adatkönyvtár>"` (telepítés nélkül: `npx -y openszamla
  nav-setup --data-dir "<adatkönyvtár>"`), a saját mappád alatti adatkönyvtár `~`-mal rövidítve (pl.
  `--data-dir "~\Dokumentumok\Számlák"` – a `~`-t a program maga oldja fel, 3.2). Az MCP-kliens
  konfigurációjában megadott `OPENSZAMLA_HOME` a terminálban nem érvényes, ezért más adatkönyvtárnál a
  `--data-dir` nélkül az adatok máshová kerülnének. Ugyanezt az alakot használja a
  `nav-send-to-configured-environment` parancsa is (7.13), és az `openszamla setup`, az `openszamla
  doctor` és az `openszamla config` minden más kiírt parancsa is (pl. `openszamla init`, `openszamla
  serve`, `openszamla doctor`, `openszamla config <kliens> --write`).

### 3.5 A Claude Desktop-bővítmény és a Claude Code-plugin beállításai

- **Claude Desktop-bővítmény (`.mcpb`):** *Adatkönyvtár* (kötelező, alapértelmezés: `~/.openszamla`);
  *NAV környezet* (nem kötelező, alapértelmezés üres: üresen a `nav-setup`-ban választott környezet
  érvényes, kitöltve felülírja); *NAV technikai felhasználó*, *NAV jelszó*, *XML aláírókulcs*, *XML
  cserekulcs* (nem kötelezők, alapértelmezés üres: üresen a `nav-credentials.json` adatai érvényesek).
  A bővítményhez a NAV-adatokat a `nav-setup`-pal is megadhatod: `openszamla nav-setup --data-dir
  <a bővítmény adatkönyvtára>` – a futó bővítmény újraindítás nélkül átveszi őket (3.4). A bővítmény
  a szerver mindhárom promptját felkínálja (6.21).
- **Claude Code-plugin:** *Adatkönyvtár* (`data_dir`, üresen `~/.openszamla`; ha megadod, a
  NAV-adatokat is oda mentsd: `npx -y openszamla nav-setup --data-dir <ugyanez a mappa>`, különben a
  szerver „NAV nincs beállítva” állapotot jelez); *NAV környezet* (`nav_env`, szövegmező: `test` vagy
  `production`, alapértelmezése nincs: üresen a `nav-setup` választása érvényes, kitöltve felülírja;
  más értékkel a szerver – ha NAV-adatok be vannak állítva – „Ismeretlen NAV környezet: …” hibával nem
  indul el).
- A bővítmény a Claude Desktop beépített vagy a gépre telepített Node.js-ével fut (szükséges: 22.13.0
  vagy újabb, a bővítmény leírása is ezt adja meg). Ha a bővítmény naplójában a „Node.js 22.13.0 vagy
  újabb szükséges” hiba áll (3.1), telepítsd a Node.js-t, és a Claude Desktop Settings → Extensions →
  Advanced settings részén kapcsold ki a „Use Built-in Node.js for MCP” beállítást.

### 3.6 Hibaelhárítás telepítéskor

| Jelenség | Ok és teendő |
|---|---|
| PowerShell: „… cannot be loaded because running scripts is disabled on this system” („a parancsfájlok futtatása le van tiltva ezen a rendszeren”) az `npm` vagy az `openszamla` parancsnál | a Windows alapbeállítása tiltja az npm `.ps1` indítóit. Írd ki a `.cmd` végződést (`npm.cmd install -g openszamla`, `openszamla.cmd setup`), vagy engedélyezd egyszer, a saját felhasználódnak: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| „'node' is not recognized …” / „A(z) node kifejezés nem ismerhető fel …” közvetlenül a Node.js telepítése után | a már nyitott terminál nem látja az új programot: nyiss új terminálablakot (ha ez sem segít, jelentkezz ki és be) |
| „OpenSzámla: Node.js 22.13.0 vagy újabb szükséges …” | a futtatókörnyezet túl régi (`node --version`), vagy az MCP-kliens egy beépített, régi Node.js-t használ: telepítsd az LTS-változatot (3.1), bővítménynél lásd 3.5 |
| EACCES a globális telepítésnél (macOS, Linux) | a globális npm-mappa a rendszeré: ne `sudo`-val telepíts – Homebrew-val vagy nvm-mel telepített Node.js-nél ez nem fordul elő; vagy saját mappa: `npm config set prefix ~/.npm-global` (és a `~/.npm-global/bin` a PATH-ra) |
| A telepítés proxy mögött nem éri el az npm-et (ETIMEDOUT, ECONNRESET, SELF_SIGNED_CERT_IN_CHAIN) | `npm config set proxy http://<proxy>:<port>` és `npm config set https-proxy http://<proxy>:<port>`; saját tanúsítvánnyal vizsgált céges forgalomnál `npm config set cafile <tanúsítvány.pem>`. A program saját NAV- és MNB-kapcsolata a `HTTPS_PROXY=http://<proxy>:<port>` és a `NODE_OPTIONS=--use-env-proxy` környezeti változóval megy a proxyn át (Node.js 24; MCP-kliensnél a szerver `env` beállításában), a céges tanúsítványt a `NODE_EXTRA_CA_CERTS=<tanúsítvány.pem>` adja meg |
| Az AI-kliens nem látja az OpenSzámla eszközeit | `openszamla doctor` (7.12): melyik kliens beállításában szerepel, létezik-e a beállított parancs, melyik adatkönyvtárat használja. A Claude Desktopból a beállítás után teljesen ki kell lépni (Windowson a tálcán a Claude ikon → Quit, macOS-en Cmd+Q) |
| A Claude Desktop nem veszi át a kézzel szerkesztett beállítást (Windows, Microsoft Store-os telepítés) | ez a változat nem a `%APPDATA%\Claude\` alatti fájlt olvassa: az újabb kiadások a saját adatmappájukat (`%LOCALAPPDATA%\Claude-Data\claude_…\claude_desktop_config.json`), a régebbiek a `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\claude_desktop_config.json` fájlt; az `openszamla config claude-desktop --write` a gépen használtat írja, és kiírja, melyiket (7.9). Hogy elindult-e a szerver, a Claude Desktop naplója mutatja (`%LOCALAPPDATA%\Claude\logs\mcp.log`, `mcp-server-openszamla.log`) |

## 4. ÁFA-kódok

| Kód | Jelentés | NAV-megfelelő | A számlán |
|---|---|---|---|
| `27`, `18`, `5` | általános és kedvezményes adókulcs | `vatPercentage` | kulcs és áthárított adó |
| `0` | 0%-os adókulcs (csak az Áfa tv. 3/B. melléklete szerinti termékekre, pl. vényköteles gyógyszer 2026-09-01-től) | `vatPercentage = 0` | 0% |
| `AAM` | alanyi adómentes eladó | `vatExemption` `AAM` | „Alanyi adómentes”, kulcs és adó nélkül |
| `TAM` | tárgyi adómentes tevékenység (Áfa tv. 85–86. §) – a pontos jogcím a tétel `vatReason` mezőjébe | `vatExemption` `TAM` | mentességi hivatkozás |
| `KBAET` | Közösségen belüli adómentes termékértékesítés | `vatExemption` `KBAET` | hivatkozás + vevő közösségi adószáma |
| `KBAUK` | új közlekedési eszköz Közösségen belüli értékesítése | `vatExemption` `KBAUK` | hivatkozás |
| `EAM` | termékexport harmadik országba | `vatExemption` `EAM` | hivatkozás |
| `NAM` | egyéb nemzetközi ügylethez kapcsolódó mentesség | `vatExemption` `NAM` | hivatkozás |
| `ATK` | az Áfa tv. tárgyi hatályán kívüli ügylet | `vatOutOfScope` `ATK` | utalás |
| `EUFAD37` | más tagállamban teljesített szolgáltatás (37. §), a vevő fizeti az adót | `vatOutOfScope` `EUFAD37` | „fordított adózás” |
| `EUFADE` | más tagállamban teljesített egyéb, fordítottan adózó ügylet | `vatOutOfScope` `EUFADE` | „fordított adózás” |
| `EUE` | más tagállamban teljesített, nem fordítottan adózó ügylet | `vatOutOfScope` `EUE` | utalás |
| `HO` | harmadik országban teljesített ügylet | `vatOutOfScope` `HO` | utalás |
| `FAD` | belföldi fordított adózás (142. §) | `vatDomesticReverseCharge` | „fordított adózás”, vevő adószáma |
| `KUL_UTAZAS`, `KUL_HASZNALT`, `KUL_MUALKOTAS`, `KUL_REGISEG` | különbözet szerinti szabályozás | `marginSchemeIndicator` | „különbözet szerinti szabályozás – …” |

A pontos számlaszövegeket a program állítja elő (`openszamla://vat-codes` erőforrás).

## 5. Számítási szabályok

### 5.1 Összegek

- Tételenként: nettó = mennyiség × nettó egységár, ÁFA = nettó × kulcs, bruttó = nettó + ÁFA; bruttó
  egységár esetén bruttó = mennyiség × bruttó egységár, ÁFA = bruttó × kulcs / (1 + kulcs). Kerekítés a
  pénznem tizedesjegyeire, de legfeljebb 2 tizedesre (HUF: egész forint; a háromtizedes pénznemek – pl.
  KWD, BHD – összegei 0,01-re kerekülnek, mert a NAV-adat összegei legfeljebb 2 tizedesek), 0,5-től
  felfelé (negatív értéknél szimmetrikusan).
- Az ÁFA-összesítő és a végösszegek a (kerekített) tételek összegei.
- Készpénzes (HUF) fizetésnél a fizetendő összeg a 2008. évi III. törvény szerint 0/5 forintra kerekített;
  a számla végösszege és a NAV-adat a kerekítetlen összeg.

### 5.2 Devizás bizonylat, árfolyam

- Forintértékek: tételenként a nettó és az ÁFA forintértéke = összeg × árfolyam, 0,01 forintra
  kerekítve; a tétel bruttó forintértéke = nettó + ÁFA forintértéke. Az ÁFA-összesítő sorainak és a
  végösszegeknek a forintértéke a tételek forintértékeinek összege, ezért néhány fillérrel eltérhet a
  devizás összeg × árfolyam szorzattól. Az árfolyam 1 egység forintértéke
  (legfeljebb 6 tizedesjegy). Az árfolyam az Áfa tv. 80. § (1) szerint a teljesítés napjára vonatkozik;
  előlegszámlán a teljesítés napja az előleg jóváírásának / kézhezvételének napja, így az árfolyam is
  erre a napra.
- **MNB árfolyamforrás** (alapértelmezés; a választást előzetesen be kell jelenteni a NAV-nak): ha a
  piszkozatban nincs megadva árfolyam, a program lekéri az MNB hivatalos árfolyamát a teljesítés napjára
  (ha aznap nincs jegyzés – hétvégén, ünnepnapon, illetve a mai napra 11 óra, az MNB napi jegyzése
  előtt –, az utolsó közzétettet). A múltbeli napok lekért árfolyamát az adatbázisban
  tárolja. Ha a lekérés nem sikerül, a piszkozat árfolyam nélkül mentődik, és EXCHANGE_RATE_MISSING
  hibát jelez („Nem sikerült lekérni az MNB … árfolyamát a teljesítés napjára. Add meg kézzel …, vagy
  mentsd újra később a piszkozatot (a program akkor újra lekéri).”).
- **Mikor frissül az MNB-árfolyam:** a lekért árfolyam a piszkozat teljesítési dátumához és pénzneméhez
  tartozik (a mellette tárolt dátum a közzététel napja, ez korábbi is lehet). A program csak akkor kéri
  le újra, ha a teljesítési dátum vagy a pénznem megváltozik, vagy ha korábban nem sikerült lekérni;
  egy kifejezetten megadott `exchangeRate` (kézi árfolyam, lásd lent) felváltja. Más adat módosításakor
  (tételek, vevő, megjegyzés stb.) és a kiállításkor a tárolt árfolyam marad, és a program az MNB-t sem
  keresi meg – egy közben elérhetetlenné vált MNB miatt tehát nem vész el. Így a mai teljesítési napra
  11 óra előtt mentett piszkozat később is az akkor lekért, előző közzététel szerinti árfolyammal marad;
  a napi jegyzés szerinti árfolyamhoz add meg kifejezetten (`exchangeRate`; kézi árfolyamként tárolódik).
- **Kézi árfolyamforrás** (`exchangeRateSource: manual`): az árfolyamot minden devizás bizonylaton meg
  kell adni (`exchangeRate`); hiányában EXCHANGE_RATE_MISSING („… add meg az árfolyamot
  (1 <pénznem> = ? HUF), pl. a bankod deviza eladási árfolyamát a teljesítés napján …”; MCP-n a `hint`:
  „MCP: az árfolyam az invoice_draft exchangeRate mezője (1 egység forintban).”).
- A kifejezetten megadott `exchangeRate` kézi árfolyam (MNB-beállításnál is; módosító számlán csak az
  eredeti árfolyama adható meg, lásd lent), és ahhoz a teljesítési naphoz tartozik, amellyel megadták.
  Ha a piszkozat teljesítési dátuma vagy pénzneme megváltozik, és
  ugyanabban a hívásban nem adsz új árfolyamot, a régit a program elveti: MNB-beállításnál az új nap
  MNB-árfolyamát kéri le, kézi beállításnál EXCHANGE_RATE_MISSING jelzi, hogy újra meg kell adni.
- **Másolat** (`copyFromId`, díjbekérőből készülő számla is) soha nem veszi át a forrás árfolyamát:
  MNB-beállításnál az új teljesítési nap MNB-árfolyamát kapja, kézi beállításnál EXCHANGE_RATE_MISSING
  jelzi, hogy meg kell adni; az ugyanabban a hívásban megadott `exchangeRate` érvényes.
- A **módosító és az érvénytelenítő számla** az eredeti számla árfolyamát használja (a teljesítési
  dátum javításakor is), mert az eredeti ügyletet helyesbíti. A módosító piszkozaton más árfolyam nem
  adható meg: CORRECTION_EXCHANGE_RATE_FIXED hiba („A módosító és a sztornó számla az eredeti számla
  (<sorszám>) árfolyamát használja (1 <pénznem> = … HUF); más árfolyam nem adható meg …”); az
  eredetivel azonos érték megadható, nem változtat semmit. Hibás árfolyamú számlát sztornóval és új
  számlával lehet javítani. Ha egy korábbi programváltozattal készült módosító piszkozat árfolyama eltér
  az eredetiétől, a piszkozat ugyanezzel a kóddal hibás (nem állítható ki), és a következő mentéskor
  az eredeti számla árfolyamát kapja.
- Figyelmeztetések: EXCHANGE_RATE_DATE_MISSING (az árfolyamhoz nincs dátum rögzítve, így nem
  ellenőrizhető a teljesítés napjával szemben – add meg újra, vagy MNB-beállításnál mentsd újra a
  piszkozatot árfolyam nélkül), EXCHANGE_RATE_ONE (az árfolyam 1), EXCHANGE_RATE_DATE_AFTER_TAX_POINT
  (az árfolyam dátuma későbbi a teljesítésnél), EXCHANGE_RATE_DATE_OLD (több mint 10 nappal régebbi).
  Hibák: EXCHANGE_RATE_PRECISION (több mint 6 tizedes), EXCHANGE_RATE_EXTREME (a NAV által elfogadott
  sávon kívül). Az EXCHANGE_RATE_MISSING hibát a program egyszer jelzi, a piszkozat mentésekor és
  lekérdezésekor ugyanazzal a szöveggel.

### 5.3 Előleg levonása (végszámla)

- A végszámla (`final`) a teljes ügyletet tartalmazza, és legalább egy előleglevonó tételt kell
  tartalmaznia (`advanceDeduction`, negatív mennyiséggel vagy egységárral) – hiányában
  FINAL_WITHOUT_ADVANCE_DEDUCTION hiba.
- **Az előlegszámla árfolyama** (`advanceExchangeRate`, a NAV-adatban `advanceExchangeRate`): forintos
  számlán 1. Devizás számlán, ha nincs megadva, a program a hivatkozott előlegszámla árfolyamát veszi,
  ha az ebben a programban, azonos pénznemben készült; különben meg kell adni (hiányában
  LINE_ADVANCE_RATE_MISSING hiba). Devizás számlán az 1-es árfolyamra LINE_ADVANCE_RATE_ONE
  figyelmeztetés jelez.
- **A levont előlegszámla ellenőrzése** (végszámlán és minden előleglevonó tételnél; módosító és
  sztornó számlán nem): hiba, ha a megadott sorszám nem előlegszámla – hanem pl. számla, díjbekérő vagy
  egy előlegszámla módosítása (ADVANCE_INVOICE_NOT_ADVANCE; az eredeti előlegszámla sorszámát kell
  megadni) –, ha az előlegszámlát sztornózták (ADVANCE_INVOICE_CANCELLED), vagy más a pénzneme
  (ADVANCE_INVOICE_CURRENCY). Figyelmeztetés, ha a sorszám ebben a programban nem található (pl. a
  korábbi számlázó programmal készült – ellenőrizd a sorszámot és az összeget; ADVANCE_INVOICE_NOT_FOUND),
  ha az előlegszámla vevője más (ADVANCE_INVOICE_OTHER_CUSTOMER), ha az előlegszámlán nincs a levonás
  ÁFA-kódjával tétel (ADVANCE_DEDUCTION_VAT_CODE), és ha ÁFA-kódonként az ugyanezt az előleget levonó
  összes kiállított bizonylat (a sztornózottakat a sztornójuk semlegesíti) és a piszkozat levonása
  együtt meghaladja az előlegszámla nettó összegét a módosításaival együtt
  (ADVANCE_DEDUCTION_EXCEEDS_ADVANCE – pl. egy lemásolt végszámla).
- **A levont előlegszámla sztornója és módosítása** (a fordított irány): a végszámla a ténylegesen
  számlázott előleget vonja le, ezért az előlegszámlát a végszámla kiállítása miatt nem kell
  sztornózni. Hiba (ADVANCE_STILL_DEDUCTED), ha egy ÁFA-kódon a kiállított bizonylatok levonása – a
  fenti módon számolva: a sztornózott végszámla levonását a sztornója semlegesíti, piszkozat nem
  számít – meghaladná azt, ami az előlegből marad (az előlegszámla, a kiállított módosításai és az új
  okirat együtt): sztornónál minden ÁFA-kódon; módosításnál az általa csökkentett ÁFA-kódokon, és ha
  a módosítás az előleg teljes nettó összegét csökkenti, az összes ÁFA-kód együttes levonásán is, az
  előlegből összesen maradó nettó összeghez mérve – így módosítással sem tüntethető el az az előleg,
  amelyet egy végszámla más ÁFA-kóddal von le, mint amellyel számlázták (ADVANCE_DEDUCTION_VAT_CODE,
  fent). Az üzenet megnevezi a levonó végszámlá(ka)t (pl. „A(z) SZ-2026-00001 előlegszámlát a(z)
  SZ-2026-00002 végszámla levonja (27 ÁFA-kód, nettó 300000 HUF), ezért nem sztornózható: …”; az
  együttes vizsgálatnál „… végszámla levonja (összesen nettó 300000 HUF, ebből 5 ÁFA-kóddal 300000
  HUF), a módosítás után viszont az előlegből összesen csak nettó 0 HUF maradna. …”): előbb azt kell
  sztornózni, vagy módosító számlával csökkenteni a levonását (pozitív, előleglevonó különbözeti
  tétellel), és csak utána az előlegszámlát. Megengedett az előleg növelése, az a csökkentés, amely
  után a levonás ÁFA-kódonként és összesen is belefér a maradó előlegbe, és az előlegszámla
  sztornója, ha a levonó végszámlát már sztornózták, vagy az még csak piszkozat.
- Mindkét irányú ellenőrzés (a piszkozat minden megnyitásakor, előnézetekor és a kiállításkor) csak az
  előleget levonó bizonylatokat olvassa be: a többi, az előleg óta kiállított bizonylatot az adatbázis
  szövegkereséssel szűri ki, egy lekérdezéssel a bizonylat összes levont előlegére. Így több ezer
  bizonylat mellett sem lassítja érezhetően a végszámla megnyitását és kiállítását, sem az előlegszámla
  sztornójának előnézetét.

## 6. MCP szerver – eszközök

Indítás: `openszamla mcp` (stdio) vagy `openszamla serve` (Streamable HTTP, `/mcp` – 8. fejezet). A
szerver mindkét MCP protokoll-generációt kiszolgálja (2025-ös és 2026-07-28-as). Minden eszköz JSON
választ ad szövegként és `structuredContent`-ként is, és MCP-annotációkkal jelzi a hatását (csak olvas
/ ír / visszafordíthatatlan / külső rendszert ér el).

- **A program hibái:** `isError: true`, a válasz `error` objektuma: `code`, `message` (magyar),
  `hint` (javítási javaslat), esetenként `details` (pl. az ellenőrzés hibalistája).
- **Felületfüggetlen üzenetek, MCP-javaslat:** a hibák (`message`, `hint`) és az ellenőrzés
  figyelmeztetéseinek szövege ugyanaz, amit a webes felület és a parancssor mutat, ezért MCP-eszközt
  vagy -mezőt nem nevez meg (pl. „Ellenőrizd az adószámot.”). Az MCP-eszközök ezt kódonként kiegészítik:
  a hiba `hint` mezője a program javaslata után „MCP: …” mondattal megnevezi a teendőhöz tartozó
  eszközt vagy mezőt (pl. INVALID_TAX_NUMBER: „MCP: a NAV adószám-lekérdezése (taxpayer_lookup)
  megmutatja, milyen adószámmal és névvel szerepel a partner a NAV-nál.”), az ellenőrzés tételei
  (`issues`, a hibák `details.issues` listájában is) pedig ilyenkor `hint` mezőt kapnak (pl.
  LINE_EXEMPTION_REFERENCE_RECOMMENDED: „MCP: a jogszabályhely a tétel vatReason mezője
  (invoice_draft).”; PROFORMA_PAYMENT_NOT_CARRIED: „MCP: a befizetés rögzítése:
  invoice_record_payment.”). Ha a program javaslata már eszközt nevez meg, nem kerül mellé másik. Ilyen
  kiegészítést kapnak a hibák közül: INVALID_TAX_NUMBER, INVALID_EU_VAT_NUMBER, SELLER_NOT_CONFIGURED,
  DUPLICATE_CUSTOMER (a meglévő vevő `customerId`-jával), NOT_A_DRAFT, VALIDATION_FAILED (piszkozatnál,
  sztornónál nem), STORNO_CHAIN_CHANGED, SERIES_ARCHIVED (a sorszámtartomány azonosítójával), SERIES_MISSING,
  INVALID_SERIES_PATTERN, NO_INVOICES; a figyelmeztetések és ellenőrzési hibák közül: SELLER_MISSING,
  SELLER_BANK_ACCOUNT_MISSING, a hibás adószám (SELLER_/CUSTOMER_…TAX_NUMBER_INVALID), a csoporttagi adószám
  (…GROUP_MEMBER…), a hibás közösségi adószám (…EU_VAT_NUMBER_INVALID), a hiányzó cím (…ADDRESS_REQUIRED),
  EXCHANGE_RATE_MISSING, EXCHANGE_RATE_DATE_MISSING, CORRECTION_EXCHANGE_RATE_FIXED, REFERENCE_REQUIRED,
  CORRECTION_SELLER_REGIME_MISMATCH, LINES_REQUIRED, LINE_VAT_CODE_NOT_ALLOWED,
  LINE_EXEMPTION_REFERENCE_RECOMMENDED, LINE_NATURE_MISMATCH, EU_B2B_GOODS_WITH_HU_VAT,
  EU_B2B_OTHER_WITH_HU_VAT, LINE_ADVANCE_RATE_MISSING, FINAL_WITHOUT_ADVANCE_DEDUCTION, LINE_AMOUNTS_INVALID,
  LINE_AMOUNTS_STALE, PROFORMA_PAYMENT_NOT_CARRIED, SERIES_ARCHIVED.
- **Paraméterhibák:** minden eszköz elutasítja az ismeretlen (pl. elírt) paramétert, a beágyazott
  objektumokban (cím, tételek, előleglevonás, vevő, alapértelmezések) is; a bemeneti sémák
  `additionalProperties: false`-t hirdetnek. Az ilyen, séma szerinti hibákat (ismeretlen kulcs, rossz
  típus vagy formátum, nem megengedett érték) az MCP-könyvtár adja vissza `isError: true`-val, angol
  szövegként – „Input validation error: Invalid arguments for tool <eszköz>: …”, pl.
  `Unrecognized key: "dueDays"` –, `structuredContent` és hibakód nélkül. Ilyenkor semmi nem történik.
- **Formátumok:** dátum `ÉÉÉÉ-HH-NN`; összeg és mennyiség szám vagy pontos tizedesjelű szöveg (pl.
  `12500` vagy `"12.5"`), ezres elválasztó nélkül. Ahol a paraméter „azonosító vagy sorszám”, mindkettő
  megadható (2. fejezet).
- **Harmadik féltől származó szöveg** (a vevő neve, a sztornó oka, a NAV által adott név) az
  összefoglalókban (`summary`) és az `elicit` módú párbeszédekben a program saját adatai és mondatai
  után, idézőjelek között („…”), egy sorban és rövidítve áll (a név legfeljebb 100, a sztornó oka
  legfeljebb 200 karakter; a hosszabb szöveg végén „…”). Az idézett szövegben minden idézőjel – „ ” “
  ‟ " ‘ ’ ‚ ‛ « » ‹ › és a Unicode többi idézőjele –, valamint a kettős idézőjelhez hasonló jelek (ʺ ˝ ˮ ″
  ‶ 〃 ״ ❛ ❜ ❝ ❞ 🙶 🙷 🙸 – U+02BA, U+02DD, U+02EE, U+2033, U+2036, U+3003, U+05F4, U+275B–U+275E,
  U+1F676–U+1F678) aposztróf (') lesz, a két vagy több egymás utáni vessző (`,,`) és aposztróf (`''`)
  pedig egyetlen aposztróf, így a szöveg ezekkel a jelekkel nem zárhatja le az idézetet, és nem
  folytatódhat a program mondataként; a tárolt adat ettől nem változik. Az
  irányváltó vezérlőkarakterek (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), amelyekkel a
  szöveg más sorrendben jelenhetne meg, mint ahogy tárolva van, a vevő nevéből, címéből és a sztornó
  okából már a mentéskor kimaradnak (6.5, 6.10). A korábban mentett, sortörést vagy ilyen karaktert
  tartalmazó vevőnevet és címet a válaszok egy sorban, ezek nélkül mutatják: a számlasorokban
  (`invoice_list`, a `customer` mező), a bizonylat adataiban (`buyer`), a vevő adataiban
  (`customer_find`, `customer_save`, `taxpayer_lookup`), a `report_summary` `topCustomers` listájában
  és az erőforrások listájában (6.21).

### 6.1 `setup_status` – beállítások és állapot (csak olvas)
Paramétere nincs. Visszaadja:
- `version`, `dataDir`, `dbPath`; `seller` (eladó) és `sellerIssues` (az eladói adatok hibái,
  figyelmeztetései); `defaults` (számlázási alapértelmezések); `series` (a nem archivált
  sorszámtartományok);
- `nav`: `configured` (van-e **használható** NAV-beállítás – megadott és formailag helyes),
  `environment` (`test` / `production`), `source` (`env`: környezeti változók, `file`:
  `nav-credentials.json`), `autoSubmit`, `problem` (miért nem használható a megadott beállítás, pl. „A
  NAV technikai felhasználó adatai hibásak: az XML cserekulcs nem 16 karakteres.”, egyébként `null`).
  Hibás beállításnál `configured: false`, de a környezet és a forrás látszik. Titkot soha nem ad vissza;
- `counts`: vevők, termékek, piszkozatok, kiállított bizonylatok (a sztornózottakkal), `unpaid`
  (kifizetetlen vagy részben fizetett kintlévőség – 2. fejezet), `navPending` (`pending` /
  `processing`), `navProblems` (`aborted` / `error` / `not_configured` – köztük a sorszám-ütközéses és a
  NAV-val nem egyeztethető jelentések, 6.15), `navNotConfigured` (ebből a használható NAV-kapcsolat
  nélkül kiállított, még nem jelentett számlák, `not_configured`) – használható NAV-kapcsolatnál ezek a
  beállított NAV-környezet (vagy még egyik környezethez sem tartozó) számlái –, `navOtherEnvironment`: a
  számlák, amelyek NAV-állapota a másik NAV-rendszerhez tartozik (pl. csak a TESZT rendszerbe
  jelentve), ebben a környezetben tehát nincsenek jelentve (6.15);
- `nextSteps` – teendők: az eladó beállítása vagy hibáinak javítása; a NAV-kapcsolat hiánya vagy
  hibája (az okkal és a beállító paranccsal, 3.4), illetve a TESZT környezet figyelmeztetése; külön
  lépésként a NAV által elutasított vagy végleges hibával zárult jelentések (teendő: az ok elhárítása,
  majd `nav_sync resubmitFailed: true`), a NAV-val végleges lekérdezési hiba miatt nem egyeztethető
  jelentések (az okkal, pl. „a technikai felhasználónak nincs lekérdezési jogosultsága („Számlák
  lekérdezése”)”; teendő: a hiba elhárítása, majd `nav_sync resubmitFailed: true`), a sorszám-ütközéses
  számlák (a NAV-nál a sorszámukon egy másik számla szerepel; a valószínű okkal és a sorszámtartomány
  következő sorszámával), a nem jelentett eredeti miatt nem jelenthető módosító/sztornó számlák – az
  eredeti állapota szerint külön lépésben, az eredeti sorszámaival és a hozzá illő teendővel:
  elutasított vagy hibás eredetinél „… NAV-jelentése elutasítva vagy hibás, … küldd újra: nav_sync {
  invoice: "<az eredeti sorszáma>", resubmitFailed: true } …”; sorszám-ütközéses eredetinél „… sorszáma
  a NAV-nál egy másik számláé (sorszám-ütközés): az eredeti nincs jelentve, a NAV pedig a
  módosítást/sztornót a másik számlához kötné. Az újraküldés nem segít: a teendőt az eredeti számla
  OPENSZAMLA_NUMBER_COLLISION üzenete írja le (invoice_get <az eredeti sorszáma>), a rendezéséhez kérj
  segítséget (könyvelő).”; ha az eredeti egyeztetését végleges NAV-hiba akadályozza, „… NAV-jelentését
  a program nem tudja egyeztetni a NAV-val (<az ok>) …”, a hiba elhárításával, majd `nav_sync
  resubmitFailed: true`-val –,
  a másik NAV-rendszerhez tartozó számlák (éles környezetben pl. „2 számla NAV-állapota a TESZT
  rendszerhez tartozik (ott jelentve, feldolgozás alatt vagy jelentésre várva), az éles rendszerbe
  nincs jelentve (<sorszámok>): … Ha valamelyik valódi számla, az éles rendszerbe a
  nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő
  kód: nav_sync { invoice: "<sorszám>", resubmitFailed: true }.”, a rájuk váró módosító/sztornó
  számlák számával; 6.15.1), az
  egyeztetendő, ismétlésként elutasított jelentések (a `nav_sync` egyezteti a NAV-val), a
  NAV-kapcsolat nélkül kiállított, még nem jelentett számlák, a függő jelentések (az eredetire váró
  javító okiratok nélkül) és a feldolgozás alatt állók; ha a NAV szünetet kért (Retry-After, 6.15),
  hogy meddig. A darabszámok az összes érintett számlára pontosak (nem csak az első néhány száz
  alapján);
- `todos` – ugyanezek a teendők szöveg nélkül, szerkezetten (a webes felület ezekből a saját szavaival
  írja ki őket, 8.2): `code` (a teendő állandó kódja), `count` (az érintett bizonylatok száma; az eladói
  adatok hibáinál a hibák száma; a beállítási teendőknél 0), és ahol van: `numbers` és `more` (az első
  legfeljebb 10 érintett sorszám és a további darabszám – a javító okiratokra váró eredeti számlák, a
  másik NAV-rendszer számlái), `problem` (a hibás NAV-beállítás oka), `reasons` (miért nem kérdezhető a
  NAV), `nextNumbers` (a sorszám-ütközésnél a következő kiadandó sorszám), `environment` (a másik
  NAV-rendszer: `test` / `production`), `until` és `pauseCode` (a NAV által kért szünet vége és oka). A
  kódok: `SELLER_MISSING`, `SELLER_INVALID` (az eladó adatai hiányoznak / hibásak), `NAV_NOT_CONFIGURED`,
  `NAV_INVALID_CONFIG`, `NAV_TEST_ENVIRONMENT`, `NAV_PAUSE`, `NAV_REJECTED` (elutasított vagy végleges
  hibával zárult jelentések), `NAV_CHECK_BLOCKED` (a NAV-val nem egyeztethető jelentések),
  `NAV_NUMBER_COLLISION`, `NAV_HELD_BY_REJECTED_ORIGINAL`, `NAV_HELD_BY_COLLISION_ORIGINAL`,
  `NAV_HELD_BY_BLOCKED_ORIGINAL` (az eredeti miatt nem jelenthető módosító/sztornó számlák),
  `NAV_OTHER_ENVIRONMENT` (a másik NAV-rendszerhez tartozó számlák), `NAV_HELD_BY_OTHER_ENVIRONMENT` (a
  rájuk váró módosító/sztornó számlák), `NAV_DUPLICATE` (egyeztetendő, ismétlésként elutasított
  jelentések), `NAV_NOT_REPORTED` (NAV-kapcsolat nélkül kiállított számlák), `NAV_PENDING` (függő
  jelentések, az eredetire váró javító okiratok nélkül) és `NAV_PROCESSING`;
- `notes` – megjegyzések (nem teendők): pénzforgalmi elszámolású eladónál a 6.17 szerinti figyelmeztetés
  („Pénzforgalmi elszámolás: az itt összesített ÁFA a kelte vagy a teljesítés dátuma szerinti, NEM a
  bevallandó adó. …”), egyébként üres lista;
- `vatCodes`, `commonUnits` (gyakori mennyiségi egységek), `today`, `confirmMode`.

### 6.2 `seller_update` – eladó adatai és alapértelmezések
Paraméterek: `name`, `taxNumber`, `groupMemberTaxNumber`, `euVatNumber`, `address` (`countryCode` –
alapértelmezés `HU` –, `postalCode`, `city`, `addressLine`, `region`), `bankAccount`, `bankName`,
`swift`, `email`, `phone`, `website`, `registrationNumber`, `vatStatus` (`normal` / `aam`),
`cashAccounting` (pénzforgalmi elszámolás), `smallBusiness` (KATA), `invoiceFooter` (lábléc), valamint
`defaults`: `paymentMethod`, `paymentDays` (0–365), `language`, `appearance`, `currency`,
`exchangeRateSource` (`MNB` / `manual`, 5.2).
- Csak a megadott mezők változnak; `null` vagy üres érték törli az elhagyható mezőt. Paraméter nélkül
  az aktuális adatokat adja vissza („Nem változott semmi.”).
- Az adószámot teljes formában kéri (12345676-1-23), a csoporttagi adószámot, a közösségi adószámot
  (pl. HU12345676) és a bankszámlaszámot (2×8 vagy 3×8 jegyű GIRO, vagy IBAN) formailag és
  ellenőrzőszámmal ellenőrzi; hibás értéknél nem ment (INVALID_TAX_NUMBER, INVALID_EU_VAT_NUMBER,
  INVALID_BANK_ACCOUNT). A mentett adatok további hibáit és figyelmeztetéseit az `issues` adja.
- `vatStatus: "aam"` esetén minden tétel ÁFA-kódja `AAM` kell legyen.
- A módosítás a már kiállított számlákat nem érinti (azok az akkori adatokat őrzik). A piszkozatok
  előnézete és kiállítása mindig az aktuális eladói adatokkal történik. Módosító és sztornó számlán az
  eladó **aktuális azonosító adatai** (név, cím, adószám, bankszámla stb.) szerepelnek, de az
  **ÁFA-helyzete** (ÁFA-státusz, pénzforgalmi elszámolás, KATA) **az eredeti számláé** (6.10, 6.11).

### 6.3 `series_manage` – sorszámtartományok
`action`: `list` | `create` | `update`.
- `list`: a nem archivált sorszámtartományok (azonosító, típus, név, minta, éves újrakezdés, következő
  sorszám és éve, alapértelmezett, archivált).
- `create`: `kind` (`invoice` – számla / `proforma` – díjbekérő), `name`, `pattern` – mind kötelező –,
  `yearlyReset`, `startSeq` (első sorszám, alapértelmezés 1; pl. másik programról áttéréskor),
  `isDefault`. A mintában a `{YYYY}`, `{YY}`, `{SEQ}`, `{SEQ:n}` (n = 1–10 jegyre nullákkal kitöltve)
  tokenek és a betű, szám, `- / _ .` karakterek használhatók; pontosan egy `{SEQ…}` kell; a leghosszabb
  lehetséges sorszám legfeljebb 50 karakter. A `yearlyReset` alapértelmezése: igen, ha a minta
  tartalmazza az évet; évenkénti újrakezdéshez az év kötelező a mintában.
- `update`: `id` (kötelező), `name`, `pattern`, `yearlyReset`, `isDefault`, `archived`. Az
  `isDefault: true` a sorszámtartományt a típusa alapértelmezettjévé teszi (a korábbi alapértelmezett
  megszűnik az lenni). Az alapértelmezett nem kapcsolható ki közvetlenül (`isDefault: false` →
  INVALID_INPUT) és nem archiválható: előbb egy másikat kell alapértelmezetté tenni.
- **Egyedi sorszámok:** a sorszám minden sorszámtartományban egyedi, ezért a program elutasítja azt a
  mintát, amelyből egy másik, nem archivált sorszámtartomány (bármelyik típusú) sorszáma is
  előállhatna, pl. `SZ-{YYYY}-0{SEQ:4}` a `SZ-{YYYY}-{SEQ:5}` mellett; a betűk kis- és nagybetűtől
  függetlenül számítanak (SERIES_PATTERN_OVERLAP, `details.conflictingSeriesId`). Elutasítja azt a
  sorszámtartományt is, amelynek következő sorszáma már foglalt, pl. egy archivált tartomány kiadta
  (SERIES_NUMBER_TAKEN, `details.existingInvoiceId`; nagyobb `startSeq` vagy más minta kell). Ezt
  létrehozáskor, a minta módosításakor és archiválás visszavonásakor ellenőrzi.
- A már kiadott sorszámok nem változnak; ha egy tartomány egy évben már adott ki sorszámot, korábbi
  évi keltezéssel nem ad ki többet.
- **Archivált sorszámtartomány új sorszámot nem ad ki.** Új bizonylathoz nem választható ki
  (SERIES_ARCHIVED, a `details.seriesId`-vel és javaslattal: „Válassz aktív sorszámtartományt (új piszkozat
  az alapértelmezettet kapja), vagy szüntesd meg ennek a sorszámtartománynak az archiválását.”; MCP-n a
  `hint` ezt is: `series_manage { action: "update", id: "<id>", archived: false }`), és az archiválása előtt benne készült
  piszkozat sem állítható ki belőle: az előnézet SERIES_ARCHIVED hibát mutat, a kiállítás ugyanezzel
  elutasul – a piszkozatnak másik sorszámtartományt kell adni (`invoice_draft` `seriesId`), vagy vissza
  kell állítani a tartományt. Az archivált tartomány számlái javíthatók és sztornózhatók maradnak: a
  módosító és a sztornó számla – amely az eredeti számla sorszámtartományát kapná – az aktuális
  alapértelmezett számla-sorszámtartományból kap sorszámot. Ezt az előnézet CORRECTION_SERIES_ARCHIVED
  figyelmeztetése („Az eredeti számla sorszámtartománya („Számlák”) archivált, ezért a(z) „Számlák
  2027” sorszámtartományból kap sorszámot.”) és a kiállítás megjegyzése is jelzi. A sorszámozás
  tartományonként hézagmentes marad (7.7).
- **Induláskor** minden bizonylattípusnak kell alapértelmezett sorszámtartomány. Ha egy típusnak nincs
  (csak régebbi változat adataival fordulhat elő), egy aktív tartománya lesz az; ha olyan sincs, az az
  archivált tartomány, amelynek sorszámait a beépített alapminta megismételné (visszaáll, és folytatja a
  sorszámozást). Új alapértelmezett („Számlák” `SZ-{YYYY}-{SEQ:5}`, „Díjbekérők” `DB-{YYYY}-{SEQ:5}`,
  évenkénti újrakezdéssel) csak akkor jön létre, ha egyik sincs. Az átállítás az auditnaplóba kerül
  (`series.update`).

### 6.4 `taxpayer_lookup` – adószám-lekérdezés (NAV)
Paraméterek: `taxNumber` (8 jegyű törzsszám vagy teljes adószám), `saveAsCustomer`. A NAV
`queryTaxpayer` szolgáltatásával lekéri a cégnevet, a címeket és az adószám érvényességét (érvénytelen
adószámra figyelmeztet). `saveAsCustomer: true` esetén belföldi vevőként (`DOMESTIC`) menti a
székhelycímmel (a név és a cím egy sorba kerül, 6.5); ha már van vevő ezzel az adószámmal,
DUPLICATE_CUSTOMER hibát ad, ha a NAV nem ad címet, NAV_NO_ADDRESS-t. Ha nincs ilyen adózó: `found:
false`. Az összefoglaló (`summary`) az adószámmal kezdődik, a NAV által adott nevet a végén,
idézőjelek között adja („<adószám> – név: „<név>””, egy sorban, legfeljebb 100 karakter). Használható
NAV-kapcsolat kell.
- **A NAV által kért szünet (Retry-After, 6.15) a lekérdezésre is érvényes:** amíg tart, a program
  nem fordul a NAV-hoz, hanem NAV_PAUSED hibát ad a szünet végével és a hátralévő idővel, pl. „A NAV
  forgalomkorlátozás miatt (HTTP 429) azt kérte, hogy legkorábban 2026.11.14. 17:05:30-kor forduljunk
  hozzá újra (Retry-After) – kb. 2 perc van hátra. Addig a program az adószám-lekérdezéssel sem fordul
  a NAV-hoz.” (egy percen belül másodpercben: „– 20 másodperc van hátra.”), javaslattal: „Próbáld újra
  2026.11.14. 17:05:30 után; addig a vevő adatait kézzel is megadhatod (customer_save).”. Ha a NAV
  magára a lekérdezésre kér szünetet (HTTP 429, vagy karbantartás `Retry-After` fejléccel), a hiba a
  NAV-é (pl. NAV_TOO_MANY_REQUESTS), és a program a szünetet ugyanúgy megjegyzi, mint a `nav_sync`
  (6.15): a végéig a `nav_sync`, a kiállításkori beküldés és a további lekérdezések sem fordulnak a
  NAV-hoz.

### 6.5 `customer_save` / `customer_find` – vevők
**`customer_save`** paraméterei: `id`, `vatStatus`, `name`, `taxNumber`, `groupMemberTaxNumber`,
`euVatNumber`, `thirdStateTaxId`, `address` (`countryCode`, `postalCode`, `city`, `addressLine`,
`region`), `email`, `phone`, `bankAccount`, `note` (belső megjegyzés, nem kerül a számlára),
`archived`.
- **Új vevő** (`id` nélkül): a `vatStatus`, a `name` és az `address` kötelező (hiányzó típusnál:
  „A vevő típusa (vatStatus) kötelező.”); a hiányzó országkód `HU`. Azonos adószámmal második vevő nem
  hozható létre (DUPLICATE_CUSTOMER, `details.existingId`).
- **Módosítás** (`id`-vel): csak a megadott mezők változnak; `null` vagy `""` törli az elhagyható mezőt
  (`taxNumber`, `groupMemberTaxNumber`, `euVatNumber`, `thirdStateTaxId`, `email`, `phone`,
  `bankAccount`, `note`). A cím mindig egészében adandó meg, és a tárolt címet váltja fel; ha a cím
  `countryCode` nélkül érkezik, a tárolt ország marad.
- `archived: true` archiválja a vevőt (a `customer_find` és a webes vevőválasztó nem mutatja, csak
  `includeArchived` esetén), `false` visszaállítja.
- Az adószámot és a közösségi adószámot formailag ellenőrzi; az egészében hibás vevőadatot nem menti
  (VALIDATION_FAILED, a hibák a `details`-ben), a figyelmeztetéseket az `issues` adja.
- A névben és a cím mezőiben (`countryCode`, `postalCode`, `city`, `addressLine`, `region`) a
  sortörés, a tabulátor és más vezérlőkarakter – a körülötte álló szóközökkel együtt – egy szóközzé
  válik, az irányváltó vezérlőkarakterek (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
  pedig kimaradnak: cégnévben, címben nincs sortörés, és egy e-mailből másolt szöveg így nem kezdhet
  új, hivatalosnak látszó sort a program üzeneteiben, és nem jelenhet meg más sorrendben, mint ahogy
  tárolva van (6. fejezet eleje). Ugyanez érvényes a piszkozatnál közvetlenül megadott vevőre (6.7) és
  a `taxpayer_lookup` mentésére (6.4).
- Válasz: `summary` („Vevő mentve (<azonosító>): „<név>””, a név egy sorban, legfeljebb 100
  karakter), `customer`, `issues`.
- A vevő módosítása a már kiállított számlákat nem érinti; a rá hivatkozó piszkozatok előnézete és
  kiállítása viszont már az új adatokkal történik (6.7).

**A keresőszöveg hossza** (`query` a `customer_find`, `product_find`, `invoice_list` eszközben, a webes
keresőmezőkben is): legfeljebb 200 karakter; hosszabbnál INVALID_INPUT: „A keresőszöveg túl hosszú (N
karakter); legfeljebb 200 karakter lehet.”, javaslat: egy jellemző részletre keresni.

**`customer_find`**: `id` (egy vevő), `query` (név, adószám, közösségi vagy csoporttagi adószám,
harmadik országbeli adóazonosító, e-mail, település – ékezet- és kisbetű-nagybetű-független),
`taxNumber` (törzsszám vagy teljes adószám; a csoporttagi adószámra is talál), `includeArchived`,
lapozás: `limit` (alapértelmezés 20, legfeljebb 100), `offset`. Eredmény: `total`, `offset`,
`customers`.

### 6.6 `product_save` / `product_find` – termékek, szolgáltatások
**`product_save`** paraméterei: `id`, `name`, `unit`, `unitPrice`, `priceBasis` (`net` – alapértelmezés
– / `gross`), `currency` (alapértelmezés `HUF`), `vatCode`, `nature` (`PRODUCT` / `SERVICE` / `OTHER`;
megadás nélkül a mennyiségi egységből következtetve), `sku` (cikkszám), `description`, `archived`. A
`name`, `unit`, `unitPrice` és `vatCode` minden hívásban kötelező. `id`-vel módosít: az elhagyott
elhagyható mezők (`priceBasis`, `currency`, `nature`, `sku`, `description`, `archived`) megtartják a
tárolt értéket; a `nature` csak akkor számolódik újra, ha a mennyiségi egység változik és nincs
megadva; az üres `sku` / `description` törli a mezőt. A módosítás a meglévő bizonylatokat nem érinti.

**`product_find`**: `id`, `query` (megnevezés, cikkszám, leírás – ékezetfüggetlen), `includeArchived`,
`limit` (alapértelmezés 20, legfeljebb 100), `offset`.

### 6.7 `invoice_draft` – piszkozat létrehozása, módosítása, előnézet
Új piszkozatot hoz létre, vagy (`draftId`-vel) meglévőt módosít. Paraméterek:
- `draftId` (módosításhoz), `documentType` (`invoice` – számla, alapértelmezés –, `advance` –
  előlegszámla –, `final` – végszámla –, `proforma` – díjbekérő), `copyFromId` (csak új piszkozatnál:
  korábbi számla vagy díjbekérő másolása, azonosító vagy sorszám), `seriesId` (alapértelmezés: a
  bizonylattípus alapértelmezett sorszámtartománya; másik típusú vagy archivált tartomány nem adható meg
  – SERIES_ARCHIVED, 6.3);
- vevő: `customerId`, vagy `customer` (a vevő adatai közvetlenül: `vatStatus`, `name`, `address` –
  kötelezők; a cím mezői: `countryCode` (alapértelmezés `HU`), `postalCode`, `city`, `addressLine`,
  `region` –, `taxNumber`, `groupMemberTaxNumber`, `euVatNumber`, `thirdStateTaxId`, `email`, `phone`,
  `bankAccount`, `note`, `id`) és `saveCustomer` (a vevők közé is menti; `customer.id`-vel a meglévő
  vevőt frissíti, 6.5) – a kettő együtt nem adható meg (lásd Vevő);
- dátumok: `issueDate` (kelte – kiállításkor mindig a kiállítás napja lesz), `fulfillmentDate`
  (teljesítés dátuma, alapértelmezés a kelte), `dueDate` (fizetési határidő) vagy `paymentDays`
  (fizetési határidő napokban, a keltétől);
- `paymentMethod` (`TRANSFER` átutalás, `CASH` készpénz, `CARD` bankkártya, `VOUCHER` utalvány, `OTHER`
  egyéb), `currency` (ISO-kód, alapértelmezés: a beállított alapértelmezett pénznem), `exchangeRate` (1 egység
  forintértéke, 5.2; módosító számla piszkozatán csak az eredeti számla árfolyama), `language` (`hu` /
  `en` / `hu-en`; alapértelmezés: a beállított alapértelmezett nyelv), `appearance` (`ELECTRONIC` /
  `PAPER`; alapértelmezés: a beállított alapértelmezett megjelenés),
  `comment` (a számlára nyomtatott megjegyzés), `internalNote` (belső megjegyzés, nem nyomtatódik),
  `orderNumber` (megrendelésszám) – a három szöveg `null`-lal törölhető;
- `lines` (tételek): `productId` (a termék megnevezését, egységét, árát, ártípusát, ÁFA-kódját és
  jellegét veszi át, a megadott mezők felülírják; a termék ára csak azonos pénznemű bizonylaton vehető
  át, különben CURRENCY_MISMATCH – add meg az egységárat) vagy `description` (megnevezés, legfeljebb 512
  karakter), `quantity` (negatív tétel, pl. engedmény, megengedett, de számla, előleg- és végszámla
  adóalapja nem lehet negatív – NEGATIVE_TAX_BASE), `unit` (alapértelmezés `db`),
  `unitPrice` (nettó, ha az ártípus nem `gross`), `priceBasis` (`net` / `gross`; alapértelmezés:
  `productId`-vel a termék ártípusa – a megadott `unitPrice`-ra is –, különben `net`), `vatCode`
  (kötelező; alanyi adómentes eladónál elhagyva `AAM`), `vatReason` (mentességi jogcím, legfeljebb 200
  karakter), `nature` (`PRODUCT` / `SERVICE` / `OTHER`, a NAV-nak jelentett jelleg; elhagyva lásd Tétel
  jellege), `modifiesLineNo` (csak módosító számlán, 6.11), előleglevonásnál `advanceDeduction`:
  `advanceInvoiceNumber` (az előlegszámla sorszáma), `advancePaymentDate` (az előleg fizetésének
  napja), `advanceExchangeRate` (5.3).

**Vevő:** a `customerId`-vel megadott, a `saveCustomer`-rel mentett és a másolt számla vevők közötti
vevője (`copyFromId`) **a vevők közül való**: a piszkozat előnézete és kiállítása mindig a vevő
**aktuális** adataival történik, mint az eladóé (a korábbi változattal mentett piszkozatokról lásd
lent). Egy későbbi `customer_save` (vagy a webes
felületen a vevő módosítása) így a nyitott piszkozatra is hat: az előnézet megváltozik, és a korábbi
megerősítő kód érvényét veszti (6.9). A `saveCustomer` nélkül közvetlenül megadott `customer` –
`customer.id`-vel is – egyszeri vevőadat: a piszkozat úgy használja, ahogy megadták, a tárolt vevő
későbbi módosítása nem írja felül. Módosító és sztornó számla vevője mindig az eredeti számláé. A
`customerId` és a `customer` együtt nem adható meg (INVALID_INPUT: „customerId és customer egyszerre
nem adható meg.”; a tárolt vevő adatai a `customer.id`-vel és `saveCustomer: true`-val módosíthatók,
egyszeri vevőhöz csak a `customer` kell). A `saveCustomer` a vevőt a piszkozattal együtt, egy
lépésben menti: ha a piszkozat bármely hiba miatt nem jön létre vagy nem módosul (pl. hibás tétel,
ismeretlen termék vagy sorszámtartomány), a vevő sem kerül mentésre, és az auditnaplóba sem kerül
róla bejegyzés; más vevő azonos adószámmal: DUPLICATE_CUSTOMER.

**Vevőhöz kötött piszkozat saját vevőadatokkal:** a korábbi változattal mentett piszkozatokon nincs
jelölve, hogy a vevőjük a vevők közül való. A program az adatbázis első megnyitásakor, egyszer, minden
olyan piszkozatot, amely tárolt vevőt nevez meg (`customerId`; módosító és sztornó piszkozatot nem), és
amelynek vevőadatai megegyeznek a tárolt vevő aktuális adataival, a vevők közül valónak jelöl (az
auditnaplóban `invoice.draft.update` bejegyzés, `fields: ["customerFromRecord"]`, szereplő: rendszer):
ettől kezdve ezek is a vevő aktuális adataival készülnek, mint a fenti piszkozatok. Ez az egyszeri
átnézés csak a jelölés nélküli, korábbi változattal mentett piszkozatokat érinti: az ezzel a változattal
mentett piszkozaton mindig jelölve van, hogy a vevője a vevők közül való-e (a közvetlenül megadott
vevőadatnál `customerFromRecord: false`; csak a piszkozat adata, a kiállított számlára nem kerül), így
a `customer.id`-vel megadott egyszeri vevőadat akkor is egyszeri marad, és a `customer_save` akkor sem
írja át, ha az átnézés csak egy későbbi indításkor fut le (pl. mert az első indításkor az adatbázis
foglalt volt). Ha egy tárolt vevőt
megnevező piszkozat vevőadatai eltérnek a tárolt vevőétől (egy ilyen régebbi piszkozat, amelynek vevőjét
azóta módosították, vagy a `customer.id`-vel megadott egyszeri vevőadat), a piszkozat a saját adatait
tartja meg, és az előnézete BUYER_DIFFERS_FROM_RECORD figyelmeztetést ad (`customer` mező): „A
piszkozat a saját vevőadatait tartja meg, és ezek eltérnek a vevők között tárolt adatoktól (eltér:
cím, e-mail): kiállításkor a piszkozat adatai kerülnek a számlára, a tárolt vevő módosítása nem hat
rá. Ha a tárolt adatokkal kell kiállítani, válaszd ki újra a vevőt: invoice_draft { draftId,
customerId: "…" }.” (a zárójelben az eltérő adatok: vevő típusa, név, adószám, csoporttagi adószám,
közösségi adószám, külföldi adóazonosító, cím, e-mail, telefon, bankszámlaszám). A vevő újbóli
megadása (`invoice_draft { draftId, customerId }`) a tárolt adatokat teszi a piszkozatra, és attól
kezdve a piszkozat a vevőt követi. Módosító és sztornó piszkozatnál nincs ilyen figyelmeztetés: a vevőjük
mindig az eredeti számláé.

**Tétel jellege** (`nature`, a NAV-adat `lineNatureIndicator` mezője): a megadott érték; `productId`-vel
a termék jellege; különben – mennyiségi egység nélkül vagy `db` egységnél – az ÁFA-kódból, ha az csak
egyféle ügyletre való (`EUFAD37`, `HO` → szolgáltatás; `KBAET`, `KBAUK`, `EAM` → termék); egyébként a
megadott mennyiségi egységből (pl. `óra`, `nap`, `hó` → szolgáltatás; `db`, `kg` → termék; más egység
→ `OTHER`); egység nélkül `OTHER` (a számlára egység nélkül is `db` kerül). Szolgáltatásnál, ha az
egység `db` vagy nincs egység, add meg: `nature: "SERVICE"`. Az előnézet tételei a jelleget is
mutatják. A jelleghez kötött figyelmeztetések a tétel jellegére mutatnak (`lines[i].nature`), és a kód
mellett a jelleg javítását is felajánlják: LINE_NATURE_MISMATCH (a jelleg és az ÁFA-kód nem illik
össze, pl. termék `EUFAD37`-tel), EU_B2B_GOODS_WITH_HU_VAT (más tagállambeli adóalany vevőnek magyar
áfával számlázott termék), EU_B2B_OTHER_WITH_HU_VAT (ugyanilyen vevőnek magyar áfával számlázott,
`OTHER` jellegű tétel: szolgáltatásnál főszabályként `EUFAD37`, a Magyarországot elhagyó terméknél
`KBAET` a kód).

**Módosítás** (`draftId`): a megadott mezők felváltják a régieket, a `lines` az összes tételt. Kiállított
számla nem módosítható (NOT_A_DRAFT); módosító és sztornó piszkozat típusa nem változtatható.

**Alapértelmezések:** a kelte a mai nap; a teljesítés dátuma a kelte; a fizetési határidő átutalásnál a
kelte + az alapértelmezett fizetési napok, más fizetési módnál a kelte. A pénznem, a fizetési mód, a
nyelv és a megjelenés az eladó alapértelmezése (`seller_update` `defaults`, a `setup_status` `defaults`
mezőjében látható; beépített értékük HUF, átutalás, `hu`, `ELECTRONIC`) – az alapértelmezett pénznem
tehát nem feltétlenül HUF. Ha új piszkozatnál nincs megadva pénznem, és az alapértelmezett pénznem nem
HUF, a létrehozás válasza DEFAULT_CURRENCY_APPLIED figyelmeztetést ad („A pénznem az eladó
alapértelmezése: EUR. A pénznem nem volt megadva, ezért a megadott egységárak is ebben a pénznemben
értendők; ha a számla más pénznemben (pl. forintban) szól, add meg a pénznemet (currency).”). Ez csak a
létrehozáskor jelenik meg (az `invoice_get` és a későbbi módosítások nem ismétlik), másolatnál nem (az a
forrás pénznemét veszi át), és akkor sem, ha egy tétel árát a termékből veszi (a termék ára a számla
pénznemében van, különben CURRENCY_MISMATCH). Új piszkozathoz legalább egy tétel kell.

**Fizetési határidő:** a `dueDate`-ként megadott határidő **megadott** marad: nem változik, ha a
piszkozatot később állítják ki, vagy ha a kelte módosul. A `paymentDays`-ből, az alapértelmezésből vagy
a másolt számla fizetési idejéből számolt határidő a keltével együtt mozog (a vevő a teljes fizetési
időt megkapja).

**Másolás** (`copyFromId`): a vevőt (ha a forrás vevője a vevők között van, annak aktuális adataival),
a tételeket (a `modifiesLineNo` nélkül), a fizetési módot, a pénznemet, a nyelvet, a megjelenést, a
megjegyzéseket és a megrendelésszámot veszi át. A kelte és a
teljesítés dátuma a mai nap, a fizetési határidő a forrás fizetési ideje mától számolva, a
sorszámtartomány az alapértelmezett (vagy a megadott); az árfolyamot soha nem veszi át (5.2).
Díjbekérőből – más `documentType` megadása nélkül – számla lesz, és a belső megjegyzésbe a „Díjbekérő:
<sorszám>” sor kerül. Sztornó vagy módosító számla nem másolható.

**Szövegek, méret:** az ellenőrzés (a piszkozaté, és a `customer_save` / `seller_update` adataié is) úgy
olvassa a szövegeket, ahogy a NAV-adatba kerülnek: a sortörés és a tabulátor szóköz lesz, az XML-ben
nem ábrázolható karakterek (vezérlőkarakterek, pl. U+0002, valamint az U+FFFE / U+FFFF) kimaradnak. Ha
egy kötelező mezőben (tétel megnevezése, eladó vagy vevő neve, települése, címsora, a levont
előlegszámla sorszáma) csak ilyen karakter van, a mező hiányzónak számít (pl. LINE_DESCRIPTION_REQUIRED,
CUSTOMER_NAME_REQUIRED), és a piszkozat nem állítható ki; a szöveg közé keveredett ilyen karakter csak
kimarad a NAV-adatból. Az eladó és a vevő neve akkor is hiányzónak számít (SELLER_NAME_REQUIRED,
CUSTOMER_NAME_REQUIRED), ha csak üresen megjelenő jelekből áll – szóköz, láthatatlan formázókarakter,
alapértelmezésben nem megjelenítendő (Default_Ignorable) karakter, pl. a hangul kitöltő jelek (U+115F,
U+1160, U+3164, U+FFA0), és az üres Braille-jel (U+2800) –, mert a számlán üresen jelenne meg. A vevő
nevében és címében a vezérlőkarakter már a mentéskor szóköz lesz (6.5):
a csak ilyen karakterekből álló vevőnevet a `customer_save` és a közvetlenül megadott vevő (`customer`)
már ekkor elutasítja („A vevő neve kötelező.”). Ha a számla NAV-adata nagyobb lenne a NAV korlátainál (számlánként 15 MB
tömörítetlenül, kérésenként 10 MB – 6.15), a piszkozat nem állítható ki: NAV_REPORT_TOO_LARGE („A számla
NAV-adatszolgáltatása … MB; a NAV számlánként legfeljebb 15,0 MB adatot fogad el (tömörítetlenül).
Ennyi tétellel (…) a számla nem jelenthető a NAV-nak: oszd több számlára, vagy rövidítsd a tételek
szövegét.”). 500 tételig ez nem fordulhat elő; hosszabb számlánál a program az ellenőrzéskor elkészíti
és megméri a NAV-adatot.

**A PDF-en nem megjeleníthető karakterek** (PDF_UNPRINTABLE_CHARACTERS): a számla PDF-je egyetlen beágyazott
betűkészlettel készül (Roboto), amely a latin (minden magyar és közép-európai ékezetes betűvel), a cirill
és a görög írást, a számokat és a szokásos írásjeleket tudja (pl. € $ £ ° ± × ² ³ ½ § „ ” – …). Amire
nincs jele – arab, héber, kínai, japán, koreai, thai, grúz, örmény írás, emoji, különleges jelek, pl.
→ ✓ ★ ℃ ㎡ ₴ –, az a PDF-en üres négyzetként jelenne meg. A piszkozat ellenőrzése ezért megnevezi az
ilyen karaktereket (a kódpontjukkal, legfeljebb nyolcat): „A vevő neve olyan karaktert tartalmaz, amelyet
a számla PDF-je nem tud megjeleníteni – üres négyzet kerülne a helyére: „株” (U+682A), … . A PDF latin
(ékezetes), cirill és görög betűket, számokat és a szokásos írásjeleket tud; más írásrendszerű nevet írj
át latin betűkre, a különleges jelet (pl. nyíl, pipa, emoji) hagyd el vagy írd ki szóval.” **Hiba** – a
piszkozat nem állítható ki – az eladó és a vevő nevében és címében, a tételek megnevezésében és
mennyiségi egységében (ezeknek a számlán olvashatónak kell lenniük, Áfa tv. 169. §); **figyelmeztetés** a
megjegyzésben, a megrendelésszámban, az eladó bankjának nevében, láblécében és elérhetőségeiben, a vevő
elérhetőségeiben. A láthatatlan formázókaraktereket (pl. szövegirányt váltó jelek, nulla szélességű
szóköz) a PDF nem jeleníti meg, ezek nem számítanak. A NAV-adatot mindez nem érinti (az UTF-8).

**Díjbekérőből készült bizonylat:** a bizonylat adataiban a díjbekérő azonosítója is szerepel
(`proformaId`; nem nyomtatódik, a NAV-hoz nem kerül; egy számla másolata, illetve módosító és sztornó
számlája nem örökli). Ha a díjbekérőre befizetést rögzítettek, a kiállításkor az a bizonylatra is
átkerül (6.9). A bizonylattípust a program soha nem változtatja meg magától. A megerősítő kód a
díjbekérő befizetéséhez is kötött (6.9). Figyelmeztetések az
előnézetben:
- PROFORMA_PAYMENT_CARRIED: „A(z) <díjbekérő> díjbekérőre <összeg> befizetés van rögzítve (<dátum>):
  kiállításkor ez a bizonylatra is átkerül befizetésként – ne rögzítsd újra.”;
- PROFORMA_PAYMENT_NOT_CARRIED: a befizetés kiállításkor nem kerül át, és a figyelmeztetés megmondja,
  miért („A(z) <díjbekérő> díjbekérőre <összeg> befizetés van rögzítve (<dátum>), de <ok>, ezért
  kiállításkor nem kerül át: <teendő>”):
  - a díjbekérő pénzneme eltér a bizonylatétól (a `currency` mezőhöz) – a kiállítás után kell rögzíteni
    (6.13);
  - a díjbekérő vissza van vonva (6.10): „… de a díjbekérő vissza van vonva, ezért kiállításkor nem
    kerül át: ha a vevő ezt a bizonylatot fizette, a kiállítás után rögzítsd a befizetést.”;
  - a bizonylat vevője nem a díjbekérő vevője (a `customer` mezőhöz): „… de a díjbekérő vevője nem
    azonos a bizonylat vevőjével, ezért kiállításkor nem kerül át: ha ennek a bizonylatnak a vevője
    fizetett, a kiállítás után rögzítsd a befizetést.” Ha mindkét bizonylat
    vevője a vevők közül való, a vevő azonosítója dönt (ugyanaz a vevő megváltozott adatokkal is
    ugyanaz); különben – ha mindkettőn van – az adószám (magyar adószámnál a törzsszám, egyébként a
    közösségi vagy a külföldi adóazonosító), adószám nélkül a név (a kis- és nagybetű és a szóközök
    nem számítanak);
  - a bizonylaton nincs fizetendő összeg – a fizetendő összeg 0 (pl. a teljes előleget levonó
    végszámlán) vagy negatív (a `totals.payableAmount` mezőhöz): „… de a bizonylat fizetendő összege
    0 Ft, ezért kiállításkor nem kerül át: a befizetést annál a bizonylatnál rögzítsd, amelyre a vevő
    fizetett (pl. az előlegszámlánál).”;
  - a bizonylat előleget von le (van előleglevonó tétele, `advanceDeduction`; a figyelmeztetés az első
    ilyen tétel mezőjéhez, pl. `lines[1].advanceDeduction`): a díjbekérő befizetése valószínűleg éppen a
    levont előleg, amely az előlegszámlához tartozik – átvéve ugyanazt a pénzt kétszer számolná, hiszen a
    végszámla fizetendő összegéből az előleget már levonták. Így a díjbekérő befizetése a részleges és a
    teljes előleglevonásnál sem kerül át (ha a fizetendő összeg 0 vagy negatív, az előző pont szerinti
    figyelmeztetés szól): „… de a bizonylat levonja a(z) <előlegszámla> előlegszámlát, ezért
    kiállításkor nem kerül át: a díjbekérő befizetése valószínűleg ez az előleg, így az előlegszámlához
    tartozik – ha ott még nincs rögzítve, ott rögzítsd. Ha a vevő erre a
    bizonylatra is fizetett, azt a kiállítás után rögzítsd.” (több levont
    előlegszámla sorszáma vesszővel elválasztva); MCP-n mindegyik `hint`-je: „MCP: a befizetés
    rögzítése: invoice_record_payment.”;
- PROFORMA_ALREADY_INVOICED: a díjbekérőből már kiállítottak egy (nem sztornózott) bizonylatot: „…
  ellenőrizd, nem számlázod-e kétszer. A díjbekérő befizetése (…) erre a bizonylatra nem kerül át.”;
- PROFORMA_PAID_BEFORE_FULFILLMENT (a `fulfillmentDate` mezőhöz): a díjbekérőt a bizonylat teljesítési
  dátuma (másoláskor a mai nap) előtt fizették – a teljesítés napját meg kell kérdezni; ha a fizetés a
  teljesítést megelőzte, az előleg (az adó a befizetéskor keletkezik, Áfa tv. 59. §), és előlegszámla
  kell róla (`documentType: "advance"`). Előlegszámlán akkor jelez, ha a teljesítés dátuma nem a
  befizetés napja (előlegszámlán a teljesítés napja az előleg kézhezvételének napja). Előleget levonó
  bizonylaton (végszámlán) nem jelez: az előlegszámla már elkészült.

**Válasz** – a teljes **előnézet** pontosan úgy, ahogy az `invoice_issue` aznap kiállítaná: a mai
kelte, az ebből adódó fizetési határidő, az eladó aktuális adatai (javító okiratnál az eredeti
ÁFA-helyzetével), a vevők közül való vevő aktuális adatai, módosító számlánál az aktuális módosítási
sorszám, újraszámolt összegek és kötelező megjegyzések. Ha a piszkozatban tárolt dátumok ettől
eltérnek, ISSUE_DATE_WILL_CHANGE figyelmeztetés
jelzi („A piszkozat kelte …; kiállításkor a számla kelte a kiállítás napja (…) lesz, a fizetési
határidő ugyanennyivel eltolódik: … → …” vagy „…; a megadott fizetési határidő (…) nem változik.”). A
válasz mezői: `summary`, `readyToIssue`, `nextStep`, `issues` (hibák és figyelmeztetések: súlyosság,
kód, szöveg, mező), `invoice` (a bizonylat adatai, a tételeknél a jelleggel – `nature` – is) és – ha a
piszkozat kiállítható, és a megerősítési mód nem `none` – a `confirmationCode` és a
`confirmationValidMinutes` (10). A `summary` sorrendje: a piszkozat azonosítója, a bruttó végösszeg,
a bruttó egységárú tételek („A(z) 2. tétel egységára bruttó (az ÁFÁ-t tartalmazza).”; ha több tétel
van, és mind bruttó árú: „Minden tétel egységára bruttó …” – a termékből átvett ártípus is), végül
a vevő neve idézőjelek között, egy sorban, legfeljebb 100 karakteren („Vevő: „…””; a hosszabb név
végén „…”). A piszkozat nem számla: nincs sorszáma, nem kerül a NAV-hoz.

### 6.8 `invoice_get` / `invoice_list` – lekérdezés (csak olvas)
**`invoice_get`** (`invoice`: azonosító vagy sorszám): kiállított bizonylatnál minden adat (eladó,
vevő, tételek, ÁFA-összesítő, forintösszegek, kötelező megjegyzések, fizetési és NAV-állapot a NAV
üzeneteivel, hivatkozás az eredetire), a hozzá tartozó módosító és sztornó okiratok (`corrections`) és a
PDF: a válasz `pdf` mezőjében `uri` (az `openszamla://invoices/<id>/pdf` erőforrás), `kind` és `sha256`
(mint az `invoice_pdf`-nél, 6.14: az eredeti PDF-ek megőrzése óta kiállított bizonylatnál `"original"` a
megőrzött eredeti SHA-256 lenyomatával – ha még nincs megőrizve, `null` lenyomattal –, az azelőtt
kiállítottnál `"regenerated"`, lenyomat nélkül) és `path`: az a fájl, amelyet az `invoice_pdf` ad – az
eredetinél a `pdf/<fájlnév>.pdf`, ha a megőrzött eredeti bájtjait tartalmazza, a megőrzés előtt kiállított
bizonylatnál az újra előállított `pdf/<fájlnév>_UJRAELOALLITOTT.pdf`, soha nem egy korábbi változat által
kiírt fájl –; ha ez még nincs meg (vagy a `pdf/` mappában lévő fájl eltér), `null`: az `invoice_pdf`
írja ki. Ha a PDF nem adható ki (DOCUMENT_MISSING, DOCUMENT_INTEGRITY_FAILED, 6.14), a `path`, a `kind`
és a `sha256` `null`, a `problem` pedig megadja a hibát (`code`, `message`, `hint`). A tartalomban a PDF
erőforrás-hivatkozásként is szerepel. Piszkozatnál ugyanazt adja, mint az `invoice_draft`: friss előnézet, hibák,
és ha kiállítható, friss megerősítő kód.

**`invoice_list`**: a legújabb elöl. Szűrők: `status` (`draft` / `issued` / `cancelled`),
`documentType`, `customerId`, `query` (sorszám, vevő neve, megjegyzés, megrendelésszám), `from` – `to`
(kelte, a határnapokkal együtt; a `from` nem lehet későbbi a `to`-nál – különben INVALID_INPUT, „A
kezdő dátum (…) későbbi a záró dátumnál (…).”, javaslattal; az azonos nap egynapos időszak),
`paymentStatus` (`unpaid` / `partial` / `paid`), `navStatus`, `overdue` (lejárt fizetési határidejű,
nem vagy csak részben fizetett kintlévőség), lapozás: `limit` (alapértelmezés 20, legfeljebb 100),
`offset`.
- A fizetési állapot – és így az, hogy egy bizonylat kintlévőség-e és lejárt-e – a számla és kiállított
  módosító számlái együttes rendezéséből adódik (6.13): a javított végösszeggel kifizetett számla
  kifizetett, nem lejárt.
- Ha a `paymentStatus` `status` és `documentType` nélkül érkezik, csak a **kintlévőségeket** listázza
  (2. fejezet) – ugyanazt a kört, amelyet a `setup_status` `counts.unpaid` számol. `status` vagy
  `documentType` megadásakor a fizetési állapot minden bizonylatra szó szerint szűr (piszkozat,
  díjbekérő, sztornó is).
- Eredmény: `total`, `offset`, `limit`, `more` (ha van további találat), `filters` (az alkalmazott
  szűrők, köztük `receivablesOnly: true` és lejártságnál `overdueOn`), `invoices` (rövid sorok).
- A sorok (és az `invoice_get` adatai) a `navStatus` mellett `navEnvironment`-et is adnak: melyik
  NAV-rendszerhez (`test` / `production`) tartozik a NAV-állapot (hiányzik, ha még egyikhez sem). Ha ez
  nem a beállított környezet, `navNote` mondja meg, mit jelent, pl. „A számla NAV-állapota a TESZT
  rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve – a teszt környezetbe küldött
  számla nem adatszolgáltatás. Ha ez valódi számla, az éles rendszerbe a
  nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő
  kód: nav_sync { invoice: "…", resubmitFailed: true }.” (6.15, 6.15.1).

### 6.9 `invoice_issue` – kiállítás (visszafordíthatatlan)
Paraméterek: `draftId`, `confirmationCode`, `submitToNav` (azonnali NAV-beküldés; alapértelmezés: az
`OPENSZAMLA_NAV_AUTO_SUBMIT` beállítás, alapból igen), `markPaid` (a vevő már fizetett, pl. készpénzzel
vagy kártyával az eladáskor; alapértelmezés: nem).
- Ellenőrzi a piszkozatot (hibásat nem állít ki: VALIDATION_FAILED) és a megerősítő kódot
  (CONFIRMATION_REQUIRED, CONFIRMATION_INVALID). A kód csak arra érvényes, amit az előnézet mutatott:
  érvénytelenné válik, ha azóta a piszkozat, az eladó vagy – a vevők közül való vevőnél (6.7) – a vevő
  adatai megváltoztak, ha közben éjfél elmúlt
  (a kelte a kiállítás napja), illetve módosító számlánál, ha közben ugyanahhoz az eredeti számlához
  másik módosító vagy sztornó számlát állítottak ki (a módosítási sorszám megváltozik). Díjbekérőből
  készült bizonylatnál (6.7) a kód a díjbekérő befizetéséhez is kötött: érvénytelen, ha azóta a
  díjbekérőre befizetést rögzítettek vagy vontak vissza (megváltozott a befizetett összeg vagy dátuma),
  ha a díjbekérőből másik bizonylatot állítottak ki, vagy azt sztornózták, illetve ha emiatt (pl. a
  díjbekérő visszavonása miatt) megváltozott, hogy a befizetés átkerül-e – így a friss előnézet már az
  aktuális figyelmeztetést mutatja (pl. PROFORMA_ALREADY_INVOICED). Ilyenkor friss
  előnézet és kód kell (`invoice_get`). `OPENSZAMLA_CONFIRM_MODE=none` esetén kód nem kell.
- **`elicit` mód:** a kód mellett a kliens párbeszédablakában a felhasználónak is jóvá kell hagynia. A
  kérdés sorrendben megnevezi a bizonylat típusát (számla, előlegszámla, végszámla, módosító számla,
  díjbekérő), a bruttó összeget, a kiállítandó kelte, teljesítés és fizetési határidő dátumát, hogy a
  kiállított számla nem módosítható (díjbekérő: nem módosítható, csak visszavonható), a NAV-ról szóló
  mondatot, `markPaid: true` esetén aszerint, amit a `markPaid` rögzíteni fog (a bizonylaton a
  kiállításkor nyitva maradó összeg előjele szerint): befizetésnél „A vevő kifizette: a befizetés a
  kiállítás napjával rögzítésre kerül.”, jóváíró bizonylat visszafizetésénél „Visszatérítés a vevőnek:
  a visszafizetés a kiállítás napjával rögzítésre kerül.”; ha nem marad nyitott összeg (pl. a
  jóváírást a program a ki nem fizetett számlába beszámítja, vagy a díjbekérő átkerülő befizetése
  mindent fedez), nincs ilyen mondat, és az eredmény megjegyzése szerint befizetés nem lett rögzítve;
  végül a vevő nevét idézőjelek között, egy sorban, legfeljebb 100 karakteren („Vevő:
  „…”.”) – így a vevő nevébe írt szöveg nem előzheti meg és nem utánozhatja a program adatait. A
  NAV-ról szóló mondat: díjbekérőnél „A díjbekérő nem számla, a NAV-nak nem kerül jelentésre.”;
  NAV-kapcsolat nélkül „… a számlát utólag haladéktalanul jelenteni kell a NAV-nak (nav_sync).”; hibás beállításnál
  „A NAV-kapcsolat beállítása hibás: a számlát a beállítás javítása után haladéktalanul jelenteni kell
  …”; ha nem lesz azonnali beküldés: „A NAV-jelentést ezután a nav_sync végzi.”; teszt környezetben „A
  NAV tesztrendszerének kerül jelentésre. A NAV-kapcsolat TESZT környezetre mutat: éles
  adatszolgáltatás NEM történik.”; egyébként „A NAV-nak azonnal jelentésre kerül.”. Módosító és sztornó
  számlánál – a sztornó előnézetében és párbeszédében is (6.10) –, ha a NAV az eredeti számlát még nem
  fogadta be (függő, elutasított, hibás, vagy csak a másik NAV-rendszerbe jelentett), ezek helyett: „A
  NAV-jelentése az eredeti számla (<sorszám>) jelentésére vár: a NAV azt még nem fogadta be
  (NAV-állapota: …), a javító bizonylatot pedig csak utána fogadja el – előbb azt kell rendezni
  (nav_sync).” Ha a felhasználó
  nem hagyja jóvá, semmi nem változik (`status: cancelled_by_user`); ha a kliens nem tud
  párbeszédet nyitni, ELICITATION_UNSUPPORTED hiba. Az `openszamla serve` HTTP-végpontján (8. fejezet) a
  2025-ös protokollú kéréseket a szerver munkamenet nélkül, kérésenként szolgálja ki, így ott párbeszédet
  nem nyithat – akkor sem, ha a kliens jelezte, hogy tudna: ilyenkor a kiállítás (és a sztornó, 6.10,
  valamint a másik NAV-rendszerhez tartozó számla beküldése, 6.15.1) ELICITATION_UNAVAILABLE_LEGACY_HTTP
  hibával elmarad („A 2025-ös protokollú HTTP-kapcsolaton az elicit mód nem érhető el – használd a
  stdio módot, egy 2026-07-28-as protokollú klienst vagy a code módot.”). A 2026-07-28-as protokollú HTTP-kliens és a stdio mód (`openszamla mcp`, mindkét
  protokoll-generációval) megkapja a párbeszédet, ha a kliens támogatja; a `code` mód HTTP-n is működik.
- **Befizetés a kiállításkor** (a fizetési adatok kiállítás után is változhatnak, a bizonylat tartalmát
  és tartalmi hash-ét nem érintik; ugyanabban a műveletben, az auditnaplóba `invoice.payment`
  bejegyzéssel):
  - díjbekérőből készült bizonylatra (6.7) átkerül a díjbekérőre rögzített befizetés – a díjbekérő minden
    befizetése a saját dátumával a bizonylat befizetési naplójába (6.13; forrása: „a díjbekérőről átvéve”,
    a díjbekérő sorszámával), és az ebből adódó fizetési állapot –, ha a díjbekérő nincs visszavonva, a pénznemük és a vevőjük
    azonos (6.7), a bizonylat fizetendő összege 0-nál nagyobb, a bizonylat nem von le előleget (nincs
    előleglevonó tétele – a díjbekérő befizetése ilyenkor valószínűleg a levont előleg, 6.7), és a
    díjbekérőből még nem állítottak ki másik, nem sztornózott bizonylatot. Megjegyzés: „A(z) <díjbekérő>
    díjbekérőre rögzített befizetés (<összeg>, <dátum>) átkerült erre a számlára – fizetési állapota:
    <állapot>. Ne rögzítsd újra.” (a dátum a díjbekérő utolsó befizetéséé; az auditnapló egyetlen
    `invoice.payment` bejegyzése a befizetések összegével);
    ha nem került át: „A(z) <díjbekérő> díjbekérőre rögzített befizetés (<összeg>) nem került át: a
    díjbekérő pénzneme (…) eltér a számláétól (…). …”, „… nem került át: a díjbekérő vissza van vonva.
    Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.”, „… nem került át:
    a díjbekérő vevője nem azonos a számla vevőjével. Ha ennek a számlának a vevője fizetett, rögzítsd a
    befizetést.”, „… nem került át: a számla fizetendő összege 0 Ft. A
    befizetést annál a bizonylatnál rögzítsd, amelyre a vevő fizetett (pl. az előlegszámlánál).”, „… nem
    került át: a számla levonja a(z) <előlegszámla> előlegszámlát. A díjbekérő befizetése valószínűleg ez
    az előleg, így az előlegszámlához tartozik – ha ott még nincs rögzítve, ott rögzítsd. Ha a vevő erre a
    számlára is fizetett, azt ezen a számlán rögzítsd.”, illetve „A(z) … díjbekérőből már kiállítottak
    bizonylatot (…); a díjbekérő befizetése (…) ezért nem került át erre a számlára.”. Az átvitel a kiállítást soha nem akadályozza
    meg: ha a befizetés mégsem rögzíthető a bizonylatra (pl. a díjbekérőn visszafizetés szerepel), a
    bizonylat befizetés nélkül kerül kiállításra, és a megjegyzés megnevezi az okot („… nem került át:
    <ok> Ha a vevő ezt a számlát fizette, rögzítsd a befizetést.”) – a befizetést MCP-n az
    `invoice_record_payment` rögzíti (6.13);
  - `markPaid: true`: az ezen a bizonylaton még nyitott összeg (6.13 – a díjbekérőről átkerült befizetés
    után, módosító számlánál a számla és módosításai együttes rendezése szerint; készpénzes forintos
    számlánál a kerekített fizetendő összeg; a lánc többi bizonylatának hátraléka nem) befizetésként
    rögzítésre kerül a kiállítás napjával (a befizetési naplóban forrása: „a kiállításkor rögzítve”, 6.13); megjegyzés: „Befizetés rögzítve a
    kiállítás napjával (<dátum>): <összeg> – fizetési állapota: fizetve.” (jóváíró bizonylatnál
    „Visszafizetés rögzítve …”, 0 összegű bizonylatnál „… rendezettnek jelölve.”; ha nincs nyitott
    összeg: „A bizonylaton nincs nyitott összeg, ezért befizetés nem lett rögzítve.”). A
    `markPaid` nem része a megerősítő kódnak: ugyanaz a kód érvényes vele és nélküle;
  - módosító számla kiállításakor az eredeti számla és módosításai fizetési állapota újraszámolódik
    (6.13).
- **Kiállításkor:** a kelte a mai nap; a származtatott fizetési határidő ugyanannyival eltolódik, a
  megadott nem változik (6.7) – erről megjegyzés szól („A számla kelte a kiállítás napja (…) lett; a
  fizetési határidő ugyanennyivel eltolódott: …” / „…; a megadott fizetési határidő (…) nem
  változott.”). Az eladó aktuális adatai kerülnek rá (javító okiratnál az eredeti ÁFA-helyzetével), a
  vevők közül való vevőnél a vevő aktuális adatai (6.7), kiosztja a sorszámtartomány következő
  sorszámát (archivált sorszámtartomány nem ad ki sorszámot: a módosító és a sztornó számla ilyenkor
  az alapértelmezett számla-sorszámtartományból kap, más piszkozat nem állítható ki – 6.3),
  véglegesíti és tartalmi hash-sel látja el a bizonylatot, elkészíti a PDF-et, és – ha be van állítva – beküldi a NAV-nak, majd legfeljebb
  `OPENSZAMLA_NAV_WAIT_SECONDS` (alapból 20) másodpercig vár a feldolgozás eredményére. Díjbekérőnél
  nincs NAV-beküldés.
- **A PDF megőrzése:** a PDF a kiállítás lezárása után egyszer készül el, és a program eredetiként
  bájtra pontosan megőrzi az adatbázisban (SHA-256 és SHA3-512 lenyomattal, az auditnaplóba
  `invoice.document` bejegyzéssel), majd ebből írja ki a `pdf/<fájlnév>.pdf` fájlt (`pdfPath`). Minden
  kiállított bizonylatnak – számla, előleg- és végszámla, módosító és sztornó számla, díjbekérő – van
  eredetije; később a program mindig ezt adja ki, újra soha nem állítja elő (6.14).
- **A NAV-rész időkorlátja:** a kiállítás NAV-része – a beküldés és a várakozás együtt – legfeljebb kb.
  20 másodperc, kérésenként 6 másodperces időkorláttal (a NAV rendesen egy másodpercen belül válaszol),
  mert az MCP-kliensek alapból 60 másodperc után feladják a hívást, és az hibának látszana. Ha a NAV
  nem válaszol, a számla `pending` marad (`TIMEOUT` üzenettel), és a `nav_sync` jelenti később; ha a
  beküldés (`manageInvoice`) maradt válasz nélkül, a kimenetel bizonytalan, és a `nav_sync` előbb
  egyeztet (6.15). Kérést a program csak akkor indít, ha az a 20 másodpercen belül véget érhet; ha a
  beküldésre már nem marad idő (pl. mert a NAV az előző kérésekre lassan válaszolt), a számla
  állapota nem változik, a `nav` megjegyzése: „A kiállításkor a NAV-beküldésre szánt idő (20 mp)
  letelt, ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz – futtasd a nav_sync-et.”;
  egy emiatt el nem küldött lekérdezés hibája (`NOT_SENT`, egy egyeztetés megjegyzésében is
  megjelenhet): „A kérést nem küldtük el: a kiállításkor a NAV-ra szánt idő letelt.” (teendő: később
  `nav_sync`). Ha ugyanebben a programban éppen fut egy NAV-szinkron (vagy egy másik kiállítás
  beküldése), a kiállítás nem vár rá: a számla `pending`, a `nav` eredmény és a megjegyzés: „Egy
  NAV-szinkron éppen fut, ezért a kiállítás nem várt rá: a számla NAV-jelentése függőben van
  (pending) – a következő nav_sync beküldi (futtasd: nav_sync).” Kettős beküldés ebből sem lehet
  (6.15). Ha a NAV szünetet kért (Retry-After, 6.15), a kiállítás nem fordul a NAV-hoz; a `nav`
  megjegyzése megmondja, mikortól lehet újra.
- **A sorszám kiosztása után a kiállítás nem hiúsul meg:** egy NAV-hiba nem hibaként, hanem a
  megjegyzésekben jelenik meg, pl. „A számla kiállítva, de a NAV-beküldés nem indult el: … A hiba
  elhárítása után futtasd a nav_sync-et.”; NAV-kapcsolat nélkül „FIGYELEM: NAV Online Számla nincs
  beállítva – ezt a számlát a törvény szerint haladéktalanul jelenteni kell a NAV-nak. Állítsd be a
  NAV kapcsolatot (…), majd futtasd a nav_sync-et.”; hibás beállításnál „FIGYELEM: a NAV-kapcsolat
  beállítása hibás, ezért ez a számla nem került jelentésre: … javítsd a beállítást (…), majd futtasd a
  nav_sync-et.”; azonnali beküldés nélkül „A NAV-jelentés függőben van – futtasd a nav_sync eszközt.”;
  ha a PDF nem készült el: „A PDF előállítása nem sikerült; a következő PDF-kérés (letöltés) újra
  megpróbálja, és az így elkészülő PDF lesz az eredeti.” (az első később sikeresen elkészült PDF lesz az
  eredeti – MCP-n az `invoice_pdf` kéri le –, 6.14; `pdfPath` ilyenkor `null`, `pdfError` az ok). Ha a
  `pdf/<fájlnév>.pdf` már létezett más tartalommal (pl. egy régebbi mentés visszaállítása után ugyanezzel
  a sorszámmal korábban kiállított, az adatbázisban már nem szereplő bizonylaté), a program nem írja
  felül: előbb `pdf/<fájlnév>_KORABBI_<ééééhhnn-óóppmm>.pdf` néven megőrzi (6.14), és ezt mondja:
  „A pdf/<fájlnév>.pdf fájl már létezett, és nem ennek a bizonylatnak a PDF-je (pl. egy régebbi mentés
  visszaállítása előtt ugyanezzel a sorszámmal kiállított bizonylaté): a program nem írta felül, hanem
  pdf/<fájlnév>_KORABBI_<ééééhhnn-óóppmm>.pdf néven megőrizte. Őrizd meg, és vizsgáld meg a
  könyvelőddel.” Teszt
  környezetben minden (díjbekérőn kívüli) kiállításhoz megjegyzés tartozik: „TESZT környezet: a
  NAV-kapcsolat a NAV tesztrendszerére mutat, ezért ez a számla nem kerül éles adatszolgáltatásba.
  Valódi számlát éles (production) NAV-kapcsolattal kell jelenteni.”
- **Eredmény:** `summary` („Kiállítva: <sorszám>, bruttó <összeg>. NAV (TESZT környezet): <állapot> –
  éles adatszolgáltatás NEM történt. Vevő: „<vevő>”.” / „… NAV (éles környezet): <állapot>. Vevő:
  „<vevő>”.”; NAV-kapcsolat nélkül vagy hibás beállításnál „NAV: <állapot>.”; a vevő neve egy sorban,
  legfeljebb 100 karakter), `invoice`, `pdfPath`, `pdfError`, `nav` (mint a `nav_sync` egy eredménye, a
  `environment` mezővel), `notes`, és a PDF erőforrás-hivatkozása.
  Készpénzes (`CASH`) vagy kártyás (`CARD`) fizetendő (0-nál nagyobb fizetendő összegű) számlánál
  (díjbekérőnél nem), ha `markPaid` nélkül
  állították ki és nincs kifizetve, `nextStep` is: „Készpénzes/kártyás számla: ha a vevő már fizetett,
  rögzítsd a befizetést (invoice_record_payment), vagy add meg a markPaid: true-t a kiállításkor.” – a
  befizetés rögzítéséig a számla kintlévőség, és a fizetési határidő (a kelte) után lejártnak számít.
  Ugyanez az egy szabály dönti el, hogy a webes kiállítási űrlapon „A vevő kifizette” jelölő alapból be
  van-e jelölve (8.3).
- Ugyanazzal a kóddal megismételt hívás nem állít ki új számlát, hanem a már kiállítottat adja vissza
  (`repeated: true`).

### 6.10 `invoice_cancel_preview` / `invoice_cancel` – sztornó (visszafordíthatatlan)
**Előnézet** (`invoice_cancel_preview`; `invoice`: azonosító vagy sorszám, `reason`: az ok, 3–200
karakter, a sztornó számlára kerül – egy sorban: a sortörés, a tabulátor és más vezérlőkarakter
szóközzé válik, az irányváltó vezérlőkarakter kimarad, mint a vevő nevében, 6.5, az egymást követő
szóközökből egy lesz, a két végéről a szóköz lemarad; az előnézet, a megerősítő kód, a párbeszéd és a
sztornó számla ugyanezt az egy sorba rendezett okot használja; az összefoglalóban és a párbeszédben a
benne lévő idézőjel aposztróf, 6. fejezet eleje). **Az ok legalább 3 látható karakter:** ha az egy
sorba rendezés után ennél kevesebb marad – pl. csak szóközökből, csak irányváltó vagy más láthatatlan
formázókarakterekből, vagy üresen megjelenő jelekből áll (a szóköz, a láthatatlan formázókarakter, az
alapértelmezésben nem megjelenítendő – Default_Ignorable – karakter, pl. a hangul kitöltő jelek U+115F,
U+1160, U+3164, U+FFA0, és az üres Braille-jel, U+2800, nem számít bele) –, az előnézet és
a végrehajtás is INVALID_INPUT hibát ad: „A sztornó oka legalább 3 látható karakterből álljon.”
(díjbekérőnél: „A visszavonás oka legalább 3 látható karakterből álljon.”), még mielőtt megerősítő
kódot adna vagy párbeszédet nyitna; ugyanez a szabály érvényes a webes felületen is (8.3).

Az előnézet nem változtat semmit. Visszaadja: `summary` – a sztornó számla bruttó összegével és
teljesítési dátumával („Sztornó számla készül a(z) … számlához: bruttó … – az eredeti számla ellentéte, teljesítés: <ÉÉÉÉ-HH-NN>, új sorszámmal.”; ha a
számlának vannak kiállított módosító számlái: „… – az eredeti számla (bruttó …) és N módosító számlája
(<sorszám>: bruttó …, …) együttes ellentéte, teljesítés: …”; ha egy módosító számla javította a számla
teljesítési dátumát, a dátum után: „(javított; az eredeti számláé: <ÉÉÉÉ-HH-NN>)”), a NAV-ról szóló
mondattal (mint 6.9), végül a vevő nevével és az okkal idézőjelek között („Vevő: „…”; ok: „…”.”) –,
`invoice` (az eredeti), `storno` (`currency`, `net`, `vat`, `gross`, `fulfillmentDate`: a sztornó
teljesítési dátuma – lásd Végrehajtás –, `negates`: a semlegesített módosító számlák `id`, `number`,
`gross` adatai), `reason` (az egy sorba rendezett ok),
`issues` (ha a sztornónak ellenőrzési hibája vagy figyelmeztetése van), `nextStep`, és – ha a sztornó
kiállítható, és a megerősítési mód nem `none` – `confirmationCode` és `confirmationValidMinutes`. Ha a
sztornó hibás, kódot nem ad, és a `nextStep` ezt mondja.

A kód érvénytelenné válik, ha az előnézet óta újabb módosító számla készült az eredetihez, ha az eladó
adatai megváltoztak, ha éjfél elmúlt, vagy ha a végrehajtás más okkal érkezik (a két okot egy sorba
rendezve hasonlítja össze).

**Végrehajtás** (`invoice_cancel`): `invoice`, ugyanaz a `reason`, `confirmationCode`, `submitToNav`
(azonnali NAV-beküldés; alapértelmezés: az `OPENSZAMLA_NAV_AUTO_SUBMIT` beállítás). `elicit` módban a
párbeszéd a sztornó bruttó összegét, teljesítési dátumát (mint az előnézet `summary`-je) és a
NAV-mondatot mutatja, végül idézőjelek között a vevőt és az okot („Sztornózod a(z) … számlát? A
sztornó számla: bruttó … – …, teljesítés: …. <NAV-mondat> Vevő: „…”; ok: „…”.”),
díjbekérőnél: „Visszavonod a(z) … díjbekérőt?”; párbeszéd nélkül (ELICITATION_UNSUPPORTED, illetve
HTTP-n 2025-ös protokollal ELICITATION_UNAVAILABLE_LEGACY_HTTP, 6.9) nem történik sztornó. A
végrehajtás a megerősítő kód ellenőrzése és a párbeszéd előtt újra elkészíti a sztornó előnézetét: ha
a sztornónak ellenőrzési hibája van (pl. az előnézet óta kiállított végszámla vonja le az
előlegszámlát), a lent leírt VALIDATION_FAILED hibát adja – párbeszéd nélkül, és a kódtól függetlenül
(érvénytelen kóddal is ezt) –, így a felhasználónak nem kell jóváhagynia olyan sztornót, amely nem
állítható ki. A program
érvénytelenítő számlát állít ki az eredeti számla és összes kiállított módosítása tételeinek
ellentétével – a láncot a kiállítás adatbázis-tranzakciójában olvassa be, így azt a módosító számlát is
semlegesíti, amelyet közben egy másik, ugyanazon az adatkönyvtáron futó folyamat (pl. az `openszamla
serve` webes felülete és egy MCP-szerver) állított ki –, az eredeti számla sorszámtartományában (ha az
archivált, az aktuális alapértelmezett
számla-sorszámtartományban – az előnézetben CORRECTION_SERIES_ARCHIVED figyelmeztetés, 6.3), új
sorszámmal, a mai keltével, a számla aktuális teljesítési dátumával – az utolsó kiállított módosító
számláéval, ha van (egy teljesítési dátumot javító módosítás után tehát a javított dátummal), különben
az eredetiével; a NAV is ehhez hasonlítja a sztornót, az eltérést STORNO_FULFILLMENT_DATE
figyelmeztetés jelzi (WARN 11401) –, az eredeti árfolyammal,
„Sztornó oka: <ok>” megjegyzéssel (angol nyelvű számlánál „Reason for cancellation: <ok>”, kétnyelvűnél
„Sztornó oka / Reason for cancellation: <ok>”), hivatkozással az eredeti sorszámra; az eladó aktuális azonosító
adataival, de az eredeti számla ÁFA-helyzetével (6.2). A NAV-nak STORNO műveletként jelenti; a
kiállítás többi szabálya (megjegyzések, NAV-eredmény, a sorszám kiosztása utáni NAV-hibák) mint 6.9. Az
eredeti számla állapota „sztornózott” lesz. Ha a sztornó nem állítható ki (ellenőrzési hiba), nem
jön létre sztornó számla, és az eredeti változatlan marad: VALIDATION_FAILED („A sztornó számla nem
állítható ki: <a hibák szövege>”, a hibák a `details`-ben) ezzel a javaslattal: „A sztornó nem
állítható ki: előbb a hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával
vagy módosításával), majd próbáld újra.” – `OPENSZAMLA_CONFIRM_MODE=none` mellett is, és akkor is, ha
az előnézet még hibátlan volt, de a kód felhasználásáig megváltozott a helyzet (pl. azóta kiállított
végszámla vonja le az előlegszámlát). Eredmény: `summary`, `invoice` (a sztornó számla, a
teljesítési dátumával), `pdfPath`, `nav`, `notes`, PDF erőforrás-hivatkozás; ugyanazzal a kóddal
megismételt hívás a már kiállított sztornót adja vissza (`repeated: true`).

**Közben megváltozott lánc:** a megerősítő kódot (a webes felületen a megerősítést, 8.3) a program a
sztornó kiállításának adatbázis-tranzakciójában még egyszer összeveti azzal, amire készült. Ha a kód
ellenőrzése után, de a kiállítás előtt egy másik folyamat módosító számlát állított ki a számlához (vagy
megváltoztak az eladó adatai, illetve éjfél elmúlt), sztornó nem készül, az eredeti számla és a módosító
számla változatlan marad: STORNO_CHAIN_CHANGED („A(z) <sorszám> számla sztornója nem készült el: a
jóváhagyott előnézet óta megváltozott, amit a sztornó semlegesít – közben módosító számla készült a
számlához, megváltoztak az eladó adatai, vagy új nap kezdődött.”), ezzel a javaslattal: „Kérj új
sztornó-előnézetet, ellenőrizd az új összeget, és a jóváhagyás után próbáld újra az új megerősítéssel.”
(MCP-n ezt is: „MCP: új előnézet és kód: invoice_cancel_preview { invoice, reason }, majd invoice_cancel az
új kóddal.”; a webes felületen a Sztornózás rész.) Az új előnézet már
a módosító számlát is semlegesítő összeget mutatja. `OPENSZAMLA_CONFIRM_MODE=none` mellett (kód nélkül)
nincs mihez hasonlítani: a sztornó ilyenkor is a kiállításkori teljes láncot semlegesíti. Ellenőrzési
hiba (STORNO_CHAIN_MISMATCH), ha egy sztornó valamelyik ÁFA-kódon nettó összegben nem az eredeti számla
és kiállított módosító számlái együttes összegének ellentéte („A sztornó számla <kód> ÁFA-kódú nettó
összege (…) nem ellentéte az eredeti számla és kiállított módosító számlái együttes összegének (…): a
sztornónak az egész számlát semlegesítenie kell. Kérj új sztornó-előnézetet, és sztornózd újra.”) – a
program a sztornót mindig így állítja elő, ez a hiba tehát csak hibás adatnál jelenhet meg.

**Befizetés a sztornózott számlán:** a sztornózott számla és módosító számlái megtartják a sztornó
kiállításakor rájuk jutott befizetett összeget és fizetési állapotot, rájuk további fizetés nem
rögzíthető. Ha a vevő fizetett rájuk, a neki visszafizetett összeget a sztornó számlán kell rögzíteni
(`invoice_record_payment`, negatív összeggel, legfeljebb a még vissza nem fizetett összegig); ha
mindet visszafizették, a sztornózott lánc egyenlege nulla (6.13, **Sztornó számla**).

**Díjbekérőnél** csak visszavonás történik: nincs bizonylat, sorszám és NAV-jelentés, a díjbekérő
állapota „sztornózott” lesz, az ok (egy sorba rendezve, legalább 3 látható karakterrel, mint fent) az
auditnaplóba kerül.

Nem sztornózható: piszkozat (törölni kell, NOT_ISSUED), már sztornózott számla (ALREADY_CANCELLED),
sztornó vagy módosító számla (INVALID_INPUT: „Módosító számlát önmagában nem lehet sztornózni.” – a
javaslat megmondja a két utat: csak a módosítás visszavonása ellentétes előjelű módosító számlával az
eredetin, vagy az egész számla érvénytelenítése az eredeti sztornójával, a módosításaival együtt;
sztornó számlánál: „Sztornó számlát nem lehet sztornózni.” – ha a számlára mégis szükség van, újat kell
kiállítani), és az az előlegszámla, amelyet kiállított
végszámla levon: az előnézet és a végrehajtás ADVANCE_STILL_DEDUCTED hibát ad a levonó végszámla
sorszámával – előbb a végszámlát kell sztornózni vagy a levonását módosítani (5.3).

### 6.11 `invoice_correct` – módosító számla piszkozata
Paraméterek: `invoice` (az eredeti számla azonosítója vagy sorszáma), `lines` (különbözeti tételek,
legalább egy; mezői mint 6.7), `comment` (a módosítás oka, a számlára kerül; hiányában
MODIFICATION_REASON_MISSING figyelmeztetés), `fulfillmentDate` (alapértelmezés: a számla aktuális
teljesítési dátuma – az utolsó kiállított módosító számláé, ha van, egy teljesítési dátumot javító
módosítás után tehát a javított dátum, különben az eredeti számláé; az árfolyamot ez nem változtatja. A
NAV is ehhez hasonlítja a módosító számlát: ettől eltérő hónapra eső dátumra
MODIFICATION_FULFILLMENT_DATE figyelmeztetés, WARN 11400). Piszkozatot készít, amit az
`invoice_issue` állít ki (NAV: MODIFY).
- A tételek **különbözetek**, nem a javított értékek: árcsökkentés = 1 db, negatív egységárral, az
  eredeti ÁFA-kóddal; visszavétel = a tétel negatív mennyiséggel; 10 óra 12-re javítása = +2 óra. A
  NAV-adatban minden módosító tétel új sor, amelynek sorszáma az eredeti számla (és korábbi
  módosításai) tételszámozását folytatja.
- **Mit tesz a módosítás a számlával** (`chain`): a módosító piszkozat előnézete – az
  `invoice_correct`, az `invoice_draft { draftId }` és az `invoice_get` válasza – megadja az eredeti
  számla és kiállított módosító számlái együttes összegeit a módosítás előtt (`before`) és ezzel a
  módosítással (`after`): `originalNumber`, `modifications` (a már kiállított módosítások száma),
  `currency`, és mindkettőnél `netAmount`, `vatAmount`, `grossAmount`. Az összefoglaló is kimondja
  („A(z) SZ-2026-00012 számla a módosításaival együtt: eddig bruttó 190 500 Ft, ezzel a módosítással
  bruttó 228 600 Ft.”), a kiállítás megerősítő párbeszédablaka is, a webes felületen pedig a piszkozat
  „Kiállítás” részének felsorolása („A módosító számla tételei különbözetek: a(z) … számla a
  módosításaival együtt eddig bruttó …, ezzel a módosítással bruttó … lesz.”). Az AI-ügynök ezt a
  felhasználónak megmutatja: az `after` az, amennyi a számla a módosítás után lesz.
- **Megismételt tétel** (CORRECTION_LINE_REPEATS_ORIGINAL figyelmeztetés): ha egy pozitív mennyiségű
  és egységárú tétel megnevezése megegyezik az eredeti számla egy tételével, és a mennyisége is
  ugyanannyi (jellemzően a javított ár került a különbözet helyére), vagy az egységára ugyanannyi és a
  mennyisége nagyobb (a javított mennyiség került a különbözet helyére): „A(z) 1. tétel („…”, 12 óra ×
  15 000 Ft) az eredeti számla 1. tételének (10 óra × 15 000 Ft) megismétlésének látszik. A módosító
  számla tételei különbözetek: ezzel a(z) … számla a módosításaival együtt bruttó …-ról …-ra változik.
  Ha a tétel javított értékét adtad meg, helyette a különbözetet add meg (…). Ha valóban ennyivel
  több került felszámításra, a tétel rendben van.” Csak figyelmeztetés: a piszkozat kiállítható.
- `modifiesLineNo` (tételenként, elhagyható): az eredeti számla melyik tételére vonatkozik a különbözet.
  Tájékoztató adat: a PDF-en („Az eredeti számla N. tételének módosítása”) és a webes felületen
  jelenik meg, a NAV-adatba nem kerül. Értéke 1 és az eredeti számla (és módosításai) legnagyobb
  tételszáma közötti egész lehet (különben INVALID_INPUT); nem módosító bizonylaton
  LINE_MODIFIES_LINE_NOT_EXPECTED figyelmeztetés jelzi, hogy nem kerül a számlára.
- **Legalább egy tétel kell:** tétel nélküli módosító számlát a NAV nem fogad be. Tétel nélkül a
  `invoice_correct` nem készít piszkozatot, a módosító piszkozat tételei nem törölhetők ki
  (`invoice_draft { draftId, lines: [] }` → INVALID_INPUT), egy tétel nélküli módosító piszkozat pedig
  nem állítható ki (MODIFICATION_WITHOUT_LINES hiba). **Csak fejadat** (pl. teljesítési dátum, a vevő
  címe) javításához adj meg egy 0 összegű különbözeti tételt: mennyiség 1, egységár 0, az eredeti
  számla ÁFA-kódja, a megnevezésben a javított adat; vagy sztornózd a számlát, és állíts ki újat.
  Téves vevőnél a helyes eljárás a sztornó és új számla (eltérő vevőre MODIFICATION_CUSTOMER_CHANGED
  figyelmeztetés).
- **Negatív eredmény:** MODIFICATION_NEGATIVE_RESULT figyelmeztetés, ha a módosítás valamelyik
  ÁFA-kódján az adóalap vagy az adó az eredeti számla, a kiállított módosításai és ez a módosítás
  együttes összegében negatív lenne – az adóalap és az adó módosítás után sem lehet negatív (pl. két
  egymás utáni árengedmény együtt több, mint a számla). Csak figyelmeztetés: egy több okirattal végzett
  javítás (pl. egy összeg átvitele 27%-ról 5%-ra) közben átmenetileg előfordulhat.
- **Előlegszámla módosítása:** ha kiállított végszámla levonja, a csökkentés csak addig állítható ki,
  amíg a levonás belefér a maradó előlegbe: a módosítás által csökkentett ÁFA-kódokon, és ha a
  módosítás az előleg teljes nettó összegét csökkenti, az összes ÁFA-kód levonása együtt is – akkor
  is, ha a végszámla más ÁFA-kóddal vonta le az előleget (különben ADVANCE_STILL_DEDUCTED hiba a
  levonó végszámla sorszámával, 5.3); a növelés mindig.
- A módosító számla az eredeti számla vevőjét, pénznemét, árfolyamát, sorszámtartományát (ha az
  archivált, az aktuális alapértelmezett számla-sorszámtartományból kap sorszámot:
  CORRECTION_SERIES_ARCHIVED figyelmeztetés, 6.3), fizetési módját, nyelvét és megjelenését veszi át;
  kelte a kiállítás napja. Az eladó aktuális azonosító
  adatai, de az eredeti számla ÁFA-helyzete kerül rá: a tételek ÁFA-kódját az eredeti számla eladói
  státusza szerint ellenőrzi (egy alanyi adómentes időszakban kiállított számla az ÁFA-körbe lépés után
  is módosítható és sztornózható, és fordítva), a kötelező megjegyzések és a NAV-adat (alanyi
  mentesség, pénzforgalmi elszámolás, KATA jelölése) az eredetit követik; ÁFA-kód nélküli tétel
  alanyi adómentes eredetinél `AAM` kódot kap. Ha egy javító okirat eladói ÁFA-helyzete mégis eltér
  az eredetiétől, CORRECTION_SELLER_REGIME_MISMATCH hiba.
- A piszkozat az `invoice_draft` `draftId`-vel módosítható, az árfolyama kivételével (az mindig az
  eredeti számláé; más érték: CORRECTION_EXCHANGE_RATE_FIXED, 5.2). Nem javítható: piszkozat
  (NOT_ISSUED), sztornózott számla (ALREADY_CANCELLED), sztornó vagy módosító számla (az eredetire kell
  hivatkozni), díjbekérő.

### 6.12 `invoice_delete_draft` – piszkozat törlése
Paraméter: `draftId`. Csak piszkozat törölhető; kiállított számla soha (NOT_A_DRAFT).

### 6.13 `invoice_record_payment` – befizetés rögzítése
Paraméterek: `invoice` (azonosító vagy sorszám), `amount` (a bizonylat pénznemében; alapértelmezés:
a hátralék, lásd lent), `date` (alapértelmezés: a mai nap), `allowOverpayment` (`true`: a hátraléknál
nagyobb összeg – túlfizetés – rögzítése, lásd lent; alapértelmezés: `false`). Csak kiállított, nem sztornózott
bizonylatra – sztornó számlán csak a sztornózott számlára befizetett összeg visszafizetése, lásd
**Sztornó számla** –, és nem egy sztornózott számla módosító számlájára (a sztornó azt is semlegesítette): erre
az alapértelmezett és a megadott összeg is hibát ad: „A(z) <módosító számla> a sztornózott <számla>
számla módosító számlája: a sztornó számla ezt is semlegesítette, ezért rá fizetés nem rögzíthető.”
(INVALID_INPUT, azzal a javaslattal, hogy a befizetést a helyette kiállított számlán kell rögzíteni).
Ezt a program a befizetés adatbázis-tranzakciójában még egyszer, a bizonylat akkori állapotán
ellenőrzi: ha közben egy másik, ugyanazon az adatkönyvtáron futó folyamat sztornózta a számlát, a
befizetés nem rögzül, és ugyanaz a hiba jelenik meg („Sztornózott számlára nem rögzíthető fizetés.”,
azzal a javaslattal, hogy a vevőnek visszafizetett összeget a számla sztornó számláján kell rögzíteni,
negatív összeggel).
Állapot: kifizetetlen / részben fizetve / kifizetve. A bizonylat tartalmát nem módosítja.
Készpénzes / kártyás eladásnál a befizetés a kiállításkor is rögzíthető (`markPaid`, 6.9); a
díjbekérőről átvett befizetést (6.9) nem kell újra rögzíteni.
- **Befizetési napló.** Minden rögzített összeg – befizetés, a vevőnek visszafizetett összeg, korábbi
  befizetés visszavonása, a kiállításkor rögzített befizetés (`markPaid`, 6.9), a díjbekérőről átvett
  befizetés (6.9), a 0 Ft-os bizonylat rendezettnek jelölése – a befizetési napló egy sora: a bizonylat,
  amelyre rögzítették, a befizetés dátuma, az előjeles összeg a bizonylat pénznemében, a forrás
  („rögzítve”, „a kiállításkor rögzítve”, „a díjbekérőről átvéve” – a díjbekérő sorszámával), a
  rögzítés ideje és az `invoice.payment` auditbejegyzés. A program azt is rögzíti, hogy a számla és
  módosító számlái együttes rendezése (lent) egy-egy befizetést a lánc melyik bizonylatára mennyiben
  számol el (felosztás): ha a vevő az eredeti számlán fizette a felfelé módosított végösszeget, a
  befizetésből a módosító számlára jutó rész a módosító számláé. A befizetéseket a befizetés dátuma
  szerint – azonos napon a rögzítés sorrendjében – osztja fel, és a lánc minden változásakor (új
  befizetés, korábbi dátumú befizetés utólagos rögzítése, módosító számla kiállítása) újra: ami
  változik, azt új felosztási sorokkal rögzíti. A napló és a felosztás csak bővíthető (9. fejezet):
  rögzített sor nem módosítható és nem törölhető.
  - **Befizetett összeg** (`paidAmount`): a bizonylatra jutó (felosztott) összeg – az eredeti számlán
    rögzített, a módosító számlát is fedező befizetésből az eredeti számlán csak a rá jutó rész, a
    többi a módosító számlán látszik. Túlfizetésnél (ha a láncon már semmi sincs nyitva) a többlet
    azon a bizonylaton marad, amelyre rögzítették.
  - **A teljes kifizetés napja** (`paidDate`): annak a befizetésnek a dátuma, amellyel a bizonylat – a
    befizetések dátuma szerinti sorrendben – teljesen kifizetetté (rendezetté) vált, és az is maradt;
    amíg nincs teljesen kifizetve, nincs dátuma. Nem az utoljára rögzített befizetés dátuma: ha a
    későbbi dátumú befizetést rögzítették előbb, a dátum akkor is a teljes kifizetés napja. Az eredeti
    számlán rögzített befizetéssel rendezett módosító számla ennek a befizetésnek a dátumát kapja. A
    befizetés nélkül, beszámítással rendezett jóváíró bizonylatnak nincs dátuma; a 0 Ft-os bizonylaté a
    rendezettnek jelölés napja.
  - **Befizetési előzmények:** egy bizonylat befizetései – a rá rögzítettek és a lánc más bizonylatán
    rögzített, rá is jutó befizetések – a befizetés dátuma szerint a webes felület bizonylatoldalán
    (8.3) és a befizetési naplóban (6.18) látszanak.
  - **A korábbi változattal rögzített befizetéseket** (az `invoice.payment` auditbejegyzésekből) a
    program az adatbázis első megnyitásakor egyszer a naplóba veszi – a napló sorrendjében, a
    forrásukkal –, majd minden érintett láncot a napló alapján újraszámol; a megváltozott fizetési
    állapotot `invoice.payment.status` (szereplő: rendszer), az egészet egy `payment.ledger` bejegyzés
    naplózza. A régi adatoknál ezért a befizetett összeg és a fizetés dátuma a fenti szabályok szerint
    változhat. Legfeljebb 500 bejegyzést, illetve 50 láncot egy-egy rövid adatbázis-tranzakcióban; ha
    egy másik folyamat közben elvégezte, nem ismétli meg, és egy bejegyzést sosem vesz át kétszer. Ha egy
    régebbi programváltozat a frissítés után is rögzít befizetést ugyanabba az adatkönyvtárba, azt a lánc
    következő befizetése veszi át.
- **A számla és módosító számlái együtt rendeződnek.** A befizetések a láncon belül a befizetési
  napló szerint oszlanak meg (fent), a hátralék és a fizetési állapot pedig
  az eredeti számla és kiállított módosító számlái együttes fizetendő összegéből adódik (a sztornózott
  számla láncát a sztornó semlegesíti, arra ez nem vonatkozik: a sztornózott számlán és módosító
  számláin nincs hátralék, és fizetés sem rögzíthető rájuk – lásd fent; a rájuk befizetett összeg
  visszafizetése a sztornó számlán rögzíthető, lásd **Sztornó számla**):
  1. egy bizonylat túlfizetése a lánc többi bizonylatának hátralékát fedezi, előbb az eredeti számláét,
     majd a módosító számlákét kiállításuk sorrendjében (pl. a vevő az eredeti számlán fizette a
     felfelé módosított végösszeget);
  2. a jóváíró (negatív) módosító számla még vissza nem fizetett jóváírását a program beszámítja a
     hátralékba, előbb az eredeti számláéba: ha a vevő a javított végösszeget fizette, az eredeti számla
     és a jóváíró bizonylat is rendezett (kifizetve), visszafizetést nem kell rögzíteni; a jóváíró
     bizonylaton visszafizetendő csak az marad, amit a vevő a javított végösszegen felül fizetett;
  3. a jóváírásnál többet visszafizetve a többlet előbb a még nem rendezett jóváírást használja fel,
     majd ismét hátralékot nyit (a legutóbbi bizonylaton kezdve).
  Kifizetve: nincs nyitott összeg; részben fizetve: van rajta befizetés, de maradt nyitott összeg;
  kifizetetlen: egyébként – a beszámított jóváírás tehát nem befizetés, csak csökkenti a hátralékot. A
  0 Ft-os bizonylat ebben nem vesz részt. Egy befizetés vagy egy módosító számla kiállítása után a
  program a lánc minden bizonylatának állapotát újraszámolja; a más bizonylat miatt megváltozott
  állapotot `invoice.payment.status` bejegyzés naplózza (6.20). A korábbi változattal rögzített
  láncokat a program az adatbázis első megnyitásakor egyszer így számolja újra (szereplő: rendszer):
  legfeljebb 50 láncot egy-egy rövid adatbázis-tranzakcióban, így a közben induló vagy futó más
  folyamat (pl. egy egyszerre induló MCP-szerver) nem vár az egész újraszámolásra; ha egy másik folyamat
  közben már elvégezte, nem ismétli meg. A lánc bizonylatait a program az eredeti számla szerinti
  indexen keresi, így egy befizetés rögzítése vagy a hátralék kiszámítása a bizonylatok számától
  függetlenül gyors.
- **Az alapértelmezett összeg** (`amount` nélkül): pozitív fizetendő összegű bizonylaton – az eredeti
  számlán és a felfelé módosító számlán is – az, amivel a számla és kiállított módosító számlái
  együtt még tartoznak (a fenti szabályok szerint számolt hátralékok összege), ha a lánc még tartozik
  valamivel: egy kifizetett, majd felfelé módosított számlánál tehát az eredeti számlán is a nyitott
  különbözet, egy ki nem fizetett számlánál és nyitott módosításánál pedig mindkettő együtt – ezt a
  túlfizetés szabálya (1.) a lánc többi bizonylatára átvezeti, így egy összeg nélküli hívás az egész
  láncot rendezi. Jóváíró bizonylaton a rajta még visszafizetendő összeg. A `markPaid` (6.9) ettől
  eltérően csak a kiállított bizonylaton nyitott összeget rögzíti. Megadott összeg ugyanúgy
  rögzíthető, mint önálló számlán. **Túlfizetés:** a pozitív fizetendő összegű bizonylatra megadott,
  a hátraléknál – a számla és módosító számlái együttes hátralékánál – nagyobb pozitív összeget a
  program csak kifejezett megerősítéssel (`allowOverpayment: true`) rögzíti (állapot: kifizetve);
  enélkül OVERPAYMENT_NOT_CONFIRMED hibát ad, és semmit nem rögzít: „A megadott összeg (127 000 Ft)
  nagyobb a hátraléknál (12 700 Ft): a különbözet (114 300 Ft) túlfizetés lenne.”, javaslat:
  „Ellenőrizd az összeget (nem csúszott el egy számjegy vagy a tizedesjel?). Ha a vevő valóban
  ennyit fizetett, rögzítsd a túlfizetés kifejezett megerősítésével (allowOverpayment: true).” – a
  teljesen kifizetett bizonylatra rögzített minden további pozitív összeg ilyen. Az AI-ügynök az
  összeget a felhasználóval ellenőrizteti, és csak a megerősítése után adja meg a kapcsolót. A
  visszavonás (negatív összeg) és a visszafizetés nem túlfizetés. A megerősítés sem elég azon a
  számlán és módosító számláin, amelyre a kiállításkor a díjbekérő befizetése átkerült (lásd lent). A 0 összeg nem
  rögzíthető („A befizetés összege nem lehet 0.”), ahogy a bizonylat összegeinél több tizedesjegyű
  összeg sem – forintos bizonylatnál egész szám kell („A befizetés összege egész szám legyen – a
  bizonylat összegei is egész forintok: …”), devizásnál legfeljebb 2 tizedesjegy –, és a mai napnál
  későbbi dátumú befizetés sem („A befizetés dátuma (…) későbbi a mai napnál (…).” – a befizetést a
  beérkezése után, a valódi dátumával kell rögzíteni; pénzforgalmi elszámolásnál ez dönti el az ÁFA
  időszakát), sem a bizonylat kelténél több mint egy évvel (366 nappal) korábbi dátumú („A befizetés
  dátuma (…) több mint egy évvel korábbi a bizonylat kelténél (…).”, javaslat: az évszám ellenőrzése –
  egy előleg vagy utánvét megelőzheti a számláját, de ennyivel nem); ha a lánc semmivel nem tartozik, az alapértelmezett
  összeg „A számla már teljesen ki van fizetve.” (jóváíró bizonylatnál „A jóváíró bizonylat már
  rendezett: nincs visszafizetendő összeg.”) hibát ad – módosított számlánál azzal a javaslattal, hogy
  a hátralékot a program a módosító számlákkal együtt számolja; ha a láncra díjbekérő befizetése került
  át, azzal is, hogy azt ne rögzítsd újra („A(z) <díjbekérő> díjbekérőre rögzített befizetés a
  kiállításkor átkerült erre a számlára – ne rögzítsd újra.”, a módosító számlán „… átkerült a(z) <számla>
  számlára …”).
- **Díjbekérőből átvett befizetés:** az olyan számlán és módosító számláin, amelyre a kiállításkor a
  díjbekérő befizetése átkerült, nem rögzíthető nagyobb összeg, mint amennyivel a számla és módosító
  számlái együtt még tartoznak (a lánc együttes hátraléka) – pl. a teljes vételár a részben átvett
  befizetés mellé (a módosító számlán is), vagy az átvett összeg még egyszer –, mert az ugyanazt a pénzt
  kétszer számolná: „A(z) <számla> számlára a(z) <díjbekérő> díjbekérő befizetése (<összeg>, <dátum>) a
  kiállításkor már átkerült; ez a befizetés ugyanazt a pénzt kétszer számolná (hátralék: …).”
  (INVALID_INPUT; a <számla> az, amelyre a befizetés átkerült – a módosító számlán rögzítve is; a hátralék
  a lánc együttes hátraléka, 0 Ft, ha a lánc semmivel nem tartozik). Ezen a láncon tehát túlfizetés nem
  rögzíthető; a hátralékig terjedő összeg – pl. egy felfelé módosítás különbözete az eredeti vagy a
  módosító számlán –, az alapértelmezett összeg és a visszavonás (negatív összeg) rögzíthető, a jóváíró
  módosító számlán a visszafizetés visszavonása (pozitív összeg) is. Ha a tévesen átvitt befizetést
  negatív összeggel visszavonták, a hátralék ismét a teljes összeg, és az rögzíthető.
- **Visszavonás:** az ellentétes előjelű összeg korábbi befizetést von vissza (pl. tévesen rögzítettet),
  legfeljebb a bizonylatra eddig rögzített összegig – a rá rögzített befizetések összegéig, akkor is, ha
  azokból a lánc más bizonylatára is jutott („A visszavont összeg nem lehet nagyobb a befizetettnél (eddig
  rögzítve: …)”). A visszavonás először a lánc más bizonylatára jutott részt veszi vissza (pl. a módosító
  számlát fedező többletet). A visszavonás is a napló egy sora a saját dátumával, és a befizetés dátuma
  szerinti összesítésben (6.17) ezen a napon számít: tévesen rögzített befizetés visszavonásához ezért a
  visszavont befizetés dátumát érdemes megadni. Ha a bizonylat így már nincs teljesen kifizetve, a teljes
  kifizetés napja törlődik, az állapot a fenti szabályok szerint (önálló számlánál 0 befizetett összegnél:
  kifizetetlen).
- **Jóváíró bizonylat** (negatív végösszeg, pl. árcsökkentő módosító számla): a vevőnek visszafizetett
  összeg negatív, a pozitív összeg ezt vonja vissza.
- **Sztornó számla:** a sztornózott számla és módosító számlái megtartják a sztornó kiállításakor rájuk
  jutott befizetett összeget és fizetési állapotot (a részben fizetett sztornózott számla tehát „részben
  fizetve” marad), rájuk további fizetés nem rögzíthető (lásd fent). A vevőnek visszafizetett összeget a
  sztornó számlán kell rögzíteni, negatív összeggel, legfeljebb amennyi a sztornózott számlára és módosító
  számláira befizetett összegből még nincs visszafizetve (alapértelmezett összeg: mind; több: „A
  visszafizetés nem lehet nagyobb a visszafizetendő összegnél (<összeg>): ennyi maradt a sztornózott
  <számla> számlára befizetett összegből.”). Ha mindet visszafizették, a lánc egyenlege nulla, a sztornó
  számla állapota kifizetve (rendezett), a teljes kifizetés napja a teljes visszafizetés napja; részben
  visszafizetve: részben fizetve, egyébként kifizetetlen. Pozitív összeg a sztornón rögzített
  visszafizetést vonja vissza, legfeljebb az eddig visszafizetettig („A visszavont összeg nem lehet
  nagyobb a visszafizetettnél (eddig rögzítve: …)”). Ha már nincs mit visszafizetni, az alapértelmezett
  összeg: „A sztornó számlán nincs visszafizetendő összeg: a sztornózott <számla> számlára befizetett
  összeget már visszafizették.” Ha a sztornózott számlára és módosító számláira nem érkezett befizetés, a
  sztornón semmi nem rögzíthető: „Sztornó számlára nem rögzíthető fizetés.” (azzal a javaslattal, hogy
  ott csak a befizetett összeg visszafizetése rögzíthető). A sztornó hátraléka (`open`) a még
  visszafizetendő összeg, negatív előjellel.
- **0 Ft-os bizonylat** csak rendezettnek jelölhető (összeg nélküli hívással); összeg nem rögzíthető rá.
- Eredmény: `summary` („Befizetés rögzítve: <sorszám> → <állapot> (<befizetve> / <fizetendő>; hátralék:
  <összeg>)”; sztornó számlán „Visszafizetés rögzítve: <sorszám> (sztornó) → <állapot> (visszafizetve:
  <összeg>; még visszafizetendő: <összeg>)”), `invoice`, `open` (a bizonylat hátraléka a fenti szabályok
  szerint; jóváíró bizonylaton és sztornón negatív: a még visszafizetendő összeg).

### 6.14 `invoice_pdf` – PDF
Paraméterek: `invoice` (azonosító vagy sorszám), `copyToDir` (másolás egy helyi mappába), `copy`
(„MÁSOLAT” jelölés).
- Visszaadja a bizonylat PDF-jét: `kind` (a fájl fajtája, lásd alább), `sha256` (az eredeti SHA-256
  lenyomata nagybetűs hexában; más fajtánál `null`), `note` (a fajta szövegesen), a fájl helyét
  (`path`), méretét (`bytes`), a másolat helyét (`copiedTo`) és egy erőforrás-hivatkozást (az
  MCP-kliens ezen keresztül olvassa be a fájlt); ha ez a kérés őrizte meg az eredetit, és a helyén egy
  másik fájlt talált, `previousFile`-t is: annak új helyét (lásd lent, „A megőrzéskor talált másik fájl”). Összefoglaló: „<note> Fájl: <hely>”, eredetinél
  „… (SHA-256: <lenyomat>)”.
- **Eredeti** (`kind: "original"`; kiállított, sztornózott és visszavont bizonylat): a kiállításkor
  elkészült PDF (6.9), amelyet a program az adatbázisban bájtra pontosan megőriz – a tartalmát, SHA-256
  és SHA3-512 lenyomatát (nagybetűs hexa), méretét és az előállító program nevét és verzióját. Később –
  programfrissítés, más programnév vagy -verzió után is – mindig pontosan ezt adja ki, és soha nem
  állítja elő újra: a lábléc és a PDF-metaadat a kiállításkor futó program nevét és verzióját mutatja.
  Ha a `pdf/<fájlnév>.pdf` fájl hiányzik vagy eltér, a kéréskor a megőrzött eredetiből írja ki újra.
  `note`: „A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.” Ha a PDF a kiállításkor
  nem készült el (6.9), az első sikeres kérés – `invoice_pdf`, az erőforrás, `openszamla pdf`, a webes
  letöltés vagy az adóhatósági export – készíti el és őrzi meg eredetiként (`invoice.document`
  naplóbejegyzéssel). A megőrzött eredetit a program nem cseréli, nem módosítja és nem törli; ezt
  adatbázis-szintű védelem (trigger) is kikényszeríti: a programot megkerülő módosítás
  IMMUTABLE_DOCUMENT hibát kap. Ha a napló szerint megőrzött eredeti hiányzik az adatbázisból (a
  programon kívül törölték), a program helyette újat nem állít elő: DOCUMENT_MISSING, „A(z) <sorszám>
  megőrzött eredeti PDF-je hiányzik az adatbázisból, pedig a napló szerint a program megőrizte;
  helyette újat nem állít elő.”, javaslat: `openszamla verify` futtatása és az adatbázis visszaállítása
  a legutóbbi mentésből (a mentés a megőrzött PDF-eket is tartalmazza).
  **Sérült vagy módosult eredeti:** minden kiadás előtt – `invoice_pdf`, az erőforrás, az `invoice_get`
  `pdf` mezője, `openszamla pdf`, a webes letöltés és a bizonylat oldala, az adóhatósági export – a
  program újraszámolja a megőrzött eredeti lenyomatát (SHA-256, SHA3-512, méret), és összeveti a vele
  tárolttal és az `invoice.document` naplóbejegyzésben rögzítettel. Ha eltér (a programon kívül
  módosították, vagy a lemez sérült – az SQLite nem ellenőrzi a lapjait), a PDF-et eredetiként nem adja
  ki, és a `pdf/<fájlnév>.pdf` fájlt sem írja felül vele: DOCUMENT_INTEGRITY_FAILED, „A(z) <sorszám>
  megőrzött eredeti PDF-je sérült vagy módosult: nem egyezik a kiállításkor rögzített lenyomatával, ezért
  a program nem adja ki eredetiként, és a pdf/ mappában lévő fájlt sem írja felül vele.”, javaslat:
  „Futtasd az openszamla verify parancsot, és állítsd vissza az adatbázist a legutóbbi ép mentésből (a
  mentés a megőrzött PDF-eket is tartalmazza).” Az első ilyen elutasítást naplózza
  (`invoice.document_altered`: a tárolt és a talált lenyomat, a méretek). MÁSOLAT (`copy: true`) ekkor
  is kérhető – az soha nem az eredeti. A szerver utasításai és a skill szerint az ügynök ilyenkor ezt
  megmondja a felhasználónak, az `openszamla verify`-t és a mentésből visszaállítást javasolja, és
  másolatot nem ad ki eredetiként; a megőrzéskor félretett korábbi fájlról (lent) is szól.
  **A megőrzéskor talált másik fájl:** amikor a program egy bizonylat eredetijét először megőrzi
  (kiállításkor, vagy ha akkor a PDF nem készült el, az első PDF-kéréskor vagy az adóhatósági exportban),
  és a `pdf/<fájlnév>.pdf` már létezik más tartalommal, az nem ennek a bizonylatnak a PDF-je (pl. egy
  régebbi mentés visszaállítása előtt ugyanezzel a sorszámmal kiállított bizonylaté, 9. fejezet). A
  program nem írja felül: előbb `pdf/<fájlnév>_KORABBI_<ééééhhnn-óóppmm>.pdf` néven (a megőrzés helyi
  idejével) megőrzi – ha ilyen nevű fájl már van, `…_2.pdf`, `…_3.pdf` stb. néven, meglévő fájlt soha nem
  írva felül –, naplózza (`invoice.pdf_file_kept`: a fájl neve, SHA-256 lenyomata és mérete), és szól:
  a kiállítás `notes`-ában (6.9), a PDF-kérés `note`-jában a fajta szövege után, az exportban a
  megjegyzések között („A pdf/<fájlnév>.pdf fájl már létezett, és nem ennek a bizonylatnak a PDF-je …
  pdf/<fájlnév>_KORABBI_<ééééhhnn-óóppmm>.pdf néven megőrizte. Őrizd meg, és vizsgáld meg a
  könyvelőddel.”). Később – amikor az eredeti már meg van őrizve – a hiányzó vagy eltérő
  `pdf/<fájlnév>.pdf` fájlt a kérés a megőrzött eredetiből írja ki újra (lásd fent).
- **Újra előállított** (`kind: "regenerated"`): az eredeti PDF-ek megőrzése (az adatbázis 3. sémaverziója)
  előtt kiállított bizonylatnak – korábbi vagy fejlesztői adatnál – nincs megőrzött eredetije. A program
  a futó változattal állítja elő, külön fájlba: `pdf/<fájlnév>_UJRAELOALLITOTT.pdf`; eredetiként soha
  nem őrzi meg, a fájl megírását naplózza (`invoice.pdf_regenerated`), a korábban kiírt
  `pdf/<fájlnév>.pdf`-hez nem nyúl. `note`: „Ez a bizonylat az eredeti PDF megőrzése előtt készült,
  ezért a program a jelenlegi változattal újra előállította: nem bájtra azonos a vevőnek átadott
  PDF-fel.”, és ha van korábban kiírt fájl: „A korábban kiírt <fájlnév>.pdf fájlt a program nem
  módosítja.” Az eszköz leírása, a szerver utasításai és a skill szerint az ügynök ilyenkor jelzi a
  felhasználónak, hogy ez nem a vevőnek átadott PDF, és nem adja ki eredetiként.
- **Tervezet** (`kind: "draft"`): piszkozat PDF-je „TERVEZET – NEM SZÁMLA” vízjellel, az előnézet
  adataival (mai kelte, aktuális eladói adatok), kéréskor készül, és nem kerül megőrzésre:
  `pdf/drafts/TERVEZET_<azonosító>.pdf`; `note`: „Tervezet („TERVEZET – NEM SZÁMLA” vízjellel), most
  előállítva.”
- A webes felület a bizonylat oldalán, a „PDF letöltése” gomb mellett megnevezi, melyik fajtát adja a
  letöltés (eredetinél a SHA-256 lenyomattal is, 8.3); ehhez semmit nem állít elő.
- **Tárhely:** egy szokásos bizonylat PDF-je 25–35 KB (sok tétellel 40–50 KB); ennyivel nő
  bizonylatonként az adatbázis, és ugyanennyi a `pdf/` mappában lévő másolat: évi 1000 bizonylatnál kb.
  30 MB az adatbázisban és még egyszer ennyi a `pdf/` mappában.
- **Fájlnév** (`pdf/` mappa): a sorszám, amelyben minden `/` (és minden, az A–Z, a–z, 0–9, `.`, `_`,
  `-` körén kívüli karaktersor) helyén `_` áll: `<fájlnév>.pdf`. Ha egy korábban kiállított bizonylat
  sorszámából ugyanez a fájlnév adódik (a kis- és nagybetű sem különbözik, pl. `AB/2026/1` és
  `AB_2026_1`, vagy `ab-2026-1` és `AB-2026-1`), a később kiállított bizonylat fájlneve
  `<fájlnév>_<azonosító>` (pl. `AB_2026_1_inv_3f9a1c7e2b.pdf`). Egy bizonylat fájlneve később sem
  változik.
- `copy: true` (`kind: "copy"`): a „MÁSOLAT” jelölésű példány külön fájl, `<fájlnév>_MASOLAT.pdf`
  (piszkozatnál `TERVEZET_<azonosító>_MASOLAT.pdf`, `kind: "draft"`), a kiállított számla PDF-je
  mellett; azt soha nem írja felül. A másolat kéréskor, a futó programmal készül, és nem kerül
  megőrzésre; `note`: „MÁSOLAT jelölésű példány, most előállítva – nem az eredeti PDF.”
- `copyToDir`: csak létező, abszolút útvonalú **helyi** mappa adható meg. Hálózati (UNC) és
  eszközútvonalat (`\\szerver\megosztás`, `//szerver/megosztás`, `\\?\…`, `\\.\…`) a program
  fájlművelet előtt elutasít: INVALID_INPUT, „Hálózati (UNC) vagy eszközútvonalra nem másolható a PDF:
  …”. Olyan mappába sem másol, amely szimbolikus hivatkozáson vagy csatoláson át hálózati megosztásra
  mutat; ezt azonban csak a hivatkozás feloldásakor ismeri fel, ami a megosztást már elérheti. (A
  hálózati meghajtóként csatolt betűjelet nem kezeli külön.) A másolás soha nem ír felül: ha a
  mappában már van ilyen nevű, azonos tartalmú fájl, a hívás sikeres (`copiedTo` az a fájl); ha eltérő
  tartalmú, FILE_EXISTS hiba („A célmappában már van … nevű, eltérő tartalmú fájl; a program nem írja
  felül.”), és a meglévő fájl érintetlen marad. `copy: true` mellett a `_MASOLAT`, újra előállított
  PDF-nél az `_UJRAELOALLITOTT` végű fájlt másolja.
- Ha a fájlmásolás ki van kapcsolva, a `copyToDir` (és az `openszamla pdf --out`) FILE_COPY_DISABLED
  hibát ad: „Fájlmásolás ebben a módban nem engedélyezett.”, javaslattal: „A másolást az
  OPENSZAMLA_ALLOW_FILE_COPY környezeti változó engedélyezi (az openszamla serve webes/HTTP szerverén
  alapból ki van kapcsolva). Másolás nélkül: MCP-n az erőforrás-hivatkozáson (resource link) át, a
  webes felületen a „PDF letöltése” gombbal; az openszamla pdf parancs kiírja a PDF helyét.”
  Kikapcsolja az `OPENSZAMLA_ALLOW_FILE_COPY=false`. Az `openszamla serve` alatt (8. fejezet) alapból
  ki van kapcsolva, mert a HTTP-kliens más gépen is lehet, és a szerver gépének mappái neki nem
  hozzáférhetők; ott az `OPENSZAMLA_ALLOW_FILE_COPY=1` kapcsolja be.

### 6.15 `nav_sync` – NAV-jelentés és állapotfrissítés
Paraméterek: `invoice` (azonosító vagy sorszám – csak ezt az egy számlát kezeli), `waitSeconds` (ennyi
ideig várja a feldolgozás eredményét, 0–45, alapértelmezés 15; legfeljebb a hívás időkeretének végéig,
lásd **Időkeret**), `resubmitFailed` (az elutasított – `aborted` – és a végleges hibával zárult –
`error` – jelentéseket is újraküldi; csak a hiba okának elhárítása után használd; `invoice`-szal a
másik NAV-rendszerhez tartozó számlánál nem küld be semmit, hanem a beküldés előnézetét és megerősítő
kódját adja a `nav_send_to_configured_environment`-hez, lásd **Teszt és éles környezet** és 6.15.1).
A `nav_sync` a másik NAV-rendszerhez tartozó számlát soha nem küldi be.
- **Automatikus szinkron:** amíg egy szerver fut – az `openszamla serve`, vagy az AI-kliens által indított
  `openszamla mcp` –, a program az indulás után kb. 20 másodperccel, majd kb. 5 percenként magától is
  lefuttatja a szinkront azokra a számlákra, amelyeknek **már volt beküldési kísérlete** a beállított
  NAV-rendszerben: az átmeneti hiba (pl. NAV-üzemzavar) miatt függőben maradtat újra beküldi, a
  bizonytalan kimenetelűt egyezteti, a feldolgozás alatt állót lekérdezi – ugyanazokkal a szabályokkal,
  mint a `nav_sync` (a NAV által kért szünetet is betartja), legfeljebb 45 másodpercig, `rendszer`
  szereplőként naplózva. Amit **nem** tesz: még soha be nem küldött számlát (pl. `submitToNav: false`
  kiállítás, vagy a NAV beállítása előtt kiállított számla) nem küld be először; elutasított vagy
  hibás jelentést nem küld újra (`resubmitFailed`); a másik NAV-rendszer számláihoz nem nyúl. Nem fut,
  ha a NAV nincs (jól) beállítva, vagy az azonnali beküldés ki van kapcsolva
  (`OPENSZAMLA_NAV_AUTO_SUBMIT=0`); kikapcsolható: `OPENSZAMLA_NAV_AUTO_SYNC=0`. Az eredményt a
  szerver a hibakimenetre írja („[openszamla] automatikus NAV-szinkron: N számla jelentése rendben
  lezárult.”), a számlák NAV-állapota pedig mindenhol frissül. Ha nem fut szerver, semmi nem történik
  magától: a függő számlákat az Áttekintő és a `setup_status` mutatja.
- Beküldi a még nem jelentett (`pending`, valamint a NAV-kapcsolat nélkül kiállított `not_configured`)
  számlákat kiállítási sorrendben (egy futásban legfeljebb 200-at), és lekérdezi a feldolgozás alatt
  állók (`processing`) eredményét. A 200 számlát azok közül választja, amelyekkel a futásban teendője
  van: a korábbi, `resubmitFailed` nélkül nem kezelt elutasított vagy hibás számlák – akárhány van
  belőlük – nem szorítják ki a függő számlákat. Csak a beállított NAV-környezet számláival foglalkozik
  (lásd **Teszt és éles környezet**).
  `invoice` megadásakor az adott számlát akkor is újraküldi, ha korábban elutasították vagy hibás volt
  (az ismétlésként elutasítottat és a sorszám-ütközésest csak akkor, ha az egyeztetés szerint a NAV-nál
  nincs érvényes számla a sorszámával – lásd lent).
- **Tömörítés, méretkorlát:** a NAV egy kérésben legfeljebb 10 MB-ot, számlánként legfeljebb 15 MB
  (tömörítetlen) adatot fogad el. Ha a számla NAV-adata base64-ben 1 MB-nál hosszabb, a program
  gzip-pel tömörítve küldi (`compressedContent=true`); az aláírás, a beküldéssel tárolt adat és az
  egyeztetés (lásd lent) is pontosan ezt a tömörített adatot használja. A NAV korlátainál nagyobb számla
  ki sem állítható (NAV_REPORT_TOO_LARGE, 6.7). 10 MB-nál nagyobb kérést a program nem küld el
  (REQUEST_TOO_LARGE), a NAV HTTP 413-as („túl nagy kérés”) válasza pedig végleges hiba (`error`), nem
  bizonytalan kimenetel.
- **Teszt és éles környezet:** a számla NAV-állapota (és tranzakcióazonosítója) ahhoz a
  NAV-rendszerhez (`test` / `production`) tartozik, amelyikben keletkezett (`navEnvironment`); a
  kiállításkor beállított környezet a számla környezete. Számla csak abban a rendszerben számít
  jelentettnek, amelyik befogadta: a TESZT rendszerbe jelentett számla az éles környezetben nincs
  jelentve (a teszt környezetbe küldött számla nem adatszolgáltatás). Ha a környezetet átállítod (pl.
  `OPENSZAMLA_NAV_ENV`), a másik rendszer számláit – az ott jelentetteket, az ott feldolgozás
  alattiakat, az ott elutasítottakat és az ott kiállított, még nem jelentetteket – a `nav_sync` nem
  küldi be és nem kérdezi le (a másik rendszer tranzakcióazonosítójával sem); a `setup_status` külön
  számolja (`navOtherEnvironment`) és megnevezi őket (6.1), az `invoice_list` / `invoice_get`
  `navNote`-tal jelzi (6.8). `nav_sync { invoice }`-ra a megjegyzés „A számla NAV-állapota a TESZT
  rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve – a teszt környezetbe küldött
  számla nem adatszolgáltatás. Ha ez valódi számla, az éles rendszerbe a
  nav_send_to_configured_environment küldi be, a felhasználó jóváhagyásával – előnézet és megerősítő
  kód: nav_sync { invoice: "…", resubmitFailed: true }.” (teszt környezetben az éles rendszerhez
  tartozó számláról: „… az ÉLES rendszerhez tartozik (ott: …); a TESZT környezetben ezzel nincs teendő
  …”). A jelenlegi rendszerbe ilyen számla csak kifejezett kérésre kerül, **új beküldéssel**, számlánként
  – tömegesen soha (a tesztidőszak számlái lehetnek valódi tesztek) –, és **csak a felhasználó
  megerősítésével**. Ezt a beküldést a `nav_sync` soha nem végzi el: a visszafordíthatatlan művelet
  külön eszköz, a `nav_send_to_configured_environment` (6.15.1; parancssorban `openszamla
  nav-send-to-configured-environment`, 7.13). A `nav_sync { invoice: "<sorszám>", resubmitFailed: true }`
  ilyen számlánál semmit nem küld be, hanem a beküldés előnézetét adja – bármelyik megerősítési
  módban, és bárhányszor hívják:
  - `confirmationRequired` (`true`; `OPENSZAMLA_CONFIRM_MODE=none` esetén `false`), `crossEnvironment`
    (`invoiceId`, `number`, `reportedTo` – a NAV-rendszer, amelyhez a számla NAV-állapota tartozik –,
    `navStatus` – az ottani állapota –, `sendTo` – ahová most kerülne –, `realReport` – `true`, ha az
    éles rendszerbe kerülne, mert az valódi adatszolgáltatás), `summary`, pl. „A(z) … számla
    NAV-állapota a TESZT rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve. Most
    az ÉLES NAV-rendszerbe kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás a NAV felé,
    és nem vonható vissza. Csak akkor küldd be, ha ez valódi számla. Nem küldtük be: a nav_sync a másik
    NAV-rendszerhez tartozó számlát nem küldi be – ezt a nav_send_to_configured_environment végzi, a
    felhasználó megerősítésével.” (`none` módban a vége: „… ezt a nav_send_to_configured_environment
    végzi.”; a TESZT rendszerbe: „… az ÉLES rendszerhez tartozik (ott: …). Most a NAV TESZT
    rendszerébe kerülne beküldésre, új beküldésként: ez nem adatszolgáltatás, és a számla NAV-állapota
    ezután a TESZT rendszerhez tartozik. …”), `environment` (a cél-rendszer);
  - `nextStep`: „Mutasd meg ezt a felhasználónak. Csak ha kifejezetten megerősíti, hogy ez valódi
    számla, és ebbe a NAV-rendszerbe is be kell küldeni, hívd: nav_send_to_configured_environment {
    invoice, confirmationCode }.” (`elicit` módban a végén: „… (a kliens párbeszédablaka is
    rákérdez).”; `none` módban: „Csak ha a felhasználó kifejezetten kéri, hogy ezt a számlát ebbe a
    NAV-rendszerbe is beküldd, hívd: nav_send_to_configured_environment { invoice }.”);
  - a `none` módon kívül megerősítő kód (`confirmationCode`, 10–20 percig érvényes,
    `confirmationValidMinutes`). A kód ahhoz kötött, amit az előnézet mutatott: a számlához, a
    tartalmához, a NAV-állapotához (az ottani állapotához és ahhoz, hogy melyik NAV-rendszerhez
    tartozik) és a cél-rendszerhez – ha ezek közül bármi megváltozik (pl. a TESZT rendszerben elutasított
    számlát egy oda beállított programpéldány közben újraküldi, és ott befogadják), a kód érvénytelen
    (6.15.1).

  A szabályt a program maga érvényesíti: csak a felhasználó által jóváhagyott előnézethez tartozó
  beküldés mehet ki („Nem küldtük be (megerősítés nélkül): … A másik NAV-rendszerbe küldést a
  felhasználónak kell jóváhagynia.”, ha nem az), és a webes felület ilyen számlát nem küld be (8.3).

  Ha egy korábbi beküldését ez a rendszer már befogadta (a környezetet oda-vissza állították), azt
  veszi át, és nem küld újra – ehhez megerősítés nem kell. A még egyik NAV-rendszerbe sem küldött,
  környezet nélküli számlát (pl. a NAV-kapcsolat nélkül kiállított `not_configured` számlát) viszont a
  következő `nav_sync` megerősítés nélkül a beállított rendszerbe küldi. Ilyen egy korábbi
  programváltozat (1-es adatbázisséma) által kiállított, soha be nem küldött számla is: az adatbázis
  átállításakor (2-es séma) a program a környezetet csak a beküldésekből tudja megállapítani, így ha egy
  ilyen számla a teszt környezetben készült, és a környezet már éles, a következő `nav_sync` az éles
  rendszerbe küldi. Ilyen adatbázissal éles indulás előtt nézd át a még nem jelentett számlákat
  (`invoice_list navStatus: ["pending", "not_configured"]`), vagy kezdj új adatkönyvtárral
  ([nav-beallitas.md](nav-beallitas.md), 4. pont).

  A másik rendszer nyitott (bizonytalan kimenetelű vagy feldolgozás alatti) beküldése itt nem
  akadályozza a beküldést, és itt nem is egyeztetődik; az ismétlésként elutasítás és a befogadott
  beküldés is csak a saját rendszerében számít. Módosító és sztornó számla csak akkor
  kerül beküldésre, ha az eredetit ugyanez a rendszer fogadta be; addig: „Nem küldhető be: az eredeti
  számla (…) NAV-állapota a TESZT rendszerhez tartozik, az éles rendszerbe nincs jelentve, … Ha az
  eredeti valódi számla, előbb azt kell beküldeni az éles rendszerbe
  (nav_send_to_configured_environment, a felhasználó jóváhagyásával – előnézet és megerősítő kód:
  nav_sync { invoice: "…", resubmitFailed: true }) – utána ez a számla is beküldésre kerül.”
- **Javító okiratok sorrendje:** módosító és sztornó számlát csak akkor küld be, ha az eredeti számlát –
  és ugyanennek a számlának minden korábban kiállított módosító számláját – a NAV már befogadta (`done` /
  `done_with_warnings`): a javító okiratok a kiállításuk sorrendjében kerülnek a NAV-hoz (a NAV sorszámozza
  őket, és mindegyik a korábbiak tételszámozását folytatja). Egy korábbi, még el nem fogadott módosításra
  váró okirat megjegyzése: „Nem küldhető be: ugyanennek a számlának egy korábbi módosító számláját (…) a
  NAV még nem fogadta be (NAV-állapota: …), a javító bizonylatokat pedig a kiállításuk sorrendjében kell
  jelenteni. Előbb azt kell rendezni (az oka: invoice_get … → navMessages; újraküldés: nav_sync { invoice:
  "…", resubmitFailed: true }) – utána ez a számla is beküldésre kerül.”, feldolgozás alatt álló korábbinál
  „Még nem küldtük be: … a NAV még feldolgozza …”; amint a korábbit a NAV befogadja, a futás a várakozót
  is beküldi. Az eredetire várásnál addig a javító okirat `pending` marad, és a
  megjegyzés megmondja, miért: „Várakozik: előbb az eredeti számlát (…) kell sikeresen jelenteni –
  futtasd: nav_sync (invoice nélkül), vagy nav_sync { invoice: "…" }.”; „Várakozik: az eredeti számlát
  (…) a NAV még feldolgozza; …”; elutasított vagy hibás eredetinél „Nem küldhető be: az eredeti számla
  (…) NAV-jelentése elutasítva (ABORTED) | hibával zárult, … Hárítsd el az eredeti számla
  jelentésének hibáját …, és küldd újra: nav_sync { invoice: "<az eredeti>", resubmitFailed: true } –
  utána ez a számla is beküldésre kerül.”; sorszám-ütközéses eredetinél (lásd lent) „Nem küldhető be:
  az eredeti számla (…) sorszáma a NAV-nál egy másik számláé (sorszám-ütközés), így a NAV ezt a
  módosítást/sztornót a másik számlához kötné. …”; ha az eredeti egyeztetését végleges NAV-hiba
  akadályozza (`OPENSZAMLA_RECONCILE_BLOCKED`, lásd lent) „Nem küldhető be: az eredeti számla (…)
  NAV-jelentését a program nem tudja egyeztetni a NAV-val (a NAV lekérdezése végleges hibát ad), … majd
  futtasd: nav_sync { invoice: "…", resubmitFailed: true } – utána ez a számla is beküldésre kerül.”
  A javító okirat beküldési kísérlete az ismétlésként elutasított, még nem egyeztetett eredetit
  egyezteti a NAV-val (lásd lent); a már egyeztetett – sorszám-ütközéses, végleges NAV-hiba miatt nem
  egyeztethető vagy `OPENSZAMLA_HINT` teendőt jelző – eredetit nem kérdezi le újra, így ilyenkor a
  futás a NAV-hoz sem fordul. Ha az eredetit a NAV ugyanabban a futásban fogadja
  be (pl. a sztornó akkor készült, amikor az eredetit még feldolgozta), a futás az eredeti után a
  javító okiratot is beküldi, és a hátralévő várakozási időn belül lekérdezi; az eredetire váró javító
  okiratok eredetijét a futás akkor is lekérdezi, ha csak a javító okiratot kezeli (így a sztornó
  kiállításakor is, 6.10). Minden megjegyzés a futás végi állapotot írja le: ha az eredetit közben
  befogadták, de a javító okirat beküldésére már nem maradt mód, „Amire ez a számla várt (az eredeti számla:
  …, és korábbi módosításai), azt a NAV közben befogadta; ez a számla a következő nav_sync-kel kerül
  beküldésre.”; ha közben elutasították, a fenti
  „Nem küldhető be: …” szöveg.
- **Nincs kettős beküldés:** egy számlát akkor sem küld be kétszer, ha több szinkron fut egyszerre
  (dupla kattintás, párhuzamos eszközhívás, egy másik program ugyanazon az adatbázison): minden
  beküldést előbb az adatbázisban lefoglal. Ilyenkor a megjegyzés: „Nem küldtük be: közben egy másik
  NAV-szinkron (vagy egy másik folyamat) már beküldte, vagy éppen küldi.” / „… éppen beküldi.”
- **Időkeret:** egy MCP-hívás (`nav_sync`, `nav_send_to_configured_environment`) a NAV-val legfeljebb
  kb. 45 másodpercig foglalkozik, a webes felület NAV-gombjai – az Áttekintő „Függő számlák beküldése a
  NAV-nak” gombja (8.2) és a bizonylat oldalának NAV-gombja (8.3) – kb. 60 másodpercig –
  az MCP-kliensek kb. 60 másodperc után feladják a hívást (a TypeScript MCP-könyvtár alapértelmezése, a
  Codex `tool_timeout_sec` beállítása), és akkor az ügynök nem tudná meg, mi került beküldésre. A keret
  a hívással indul, egy éppen futó másik NAV-szinkronra várakozás is beleszámít: ha az tovább tart, a
  hívás nem vár rá tovább, és nem fordul a NAV-hoz. Új NAV-kérést a program csak akkor indít, ha a
  keretből még elegendő idő van rá (kérésenként a keret nyolcada, legfeljebb 6 másodperc; egy beküldés
  két kérés), és egy kérés sem tart a keret végénél tovább: az időkorlátja a hátralévő időre rövidül –
  az így lejárt kérés a keret végét jelenti, nem NAV-kiesést. A feldolgozásra várakozás (`waitSeconds`)
  is legfeljebb a keret végéig tart. Azoknál a számláknál, amelyekhez a futás így már nem jutott el, a
  program nem fordult (tovább) a NAV-hoz; megjegyzésük „A NAV-szinkronra szánt idő (45 mp) letelt,
  ezért a program ennél a számlánál nem fordult (tovább) a NAV-hoz. Futtasd újra a nav_sync-et: a
  következő futás folytatja.” (a webes felületen „… (60 mp) …”), eredményükben `notProcessed: "time"`
  áll (lásd **Eredmény**). Egy emiatt el nem küldött lekérdezés hibája `NOT_SENT`: „A kérést nem
  küldtük el: a NAV-szinkronra szánt idő (45 mp) letelt.” Az a beküldés, amelynek válasza a keret vége
  miatt maradt el, bizonytalan kimenetelű (lásd **Bizonytalan kimenetel**): a program előbb egyezteti a
  NAV-val, és csak akkor küldi újra, ha nem érkezett meg – így semmi nem kerül kétszer a NAV-hoz. A
  parancssornak (7.13) nincs ilyen kerete; a kiállításkori beküldésnek saját, kb. 20 másodperces kerete
  van (6.9).
- **NAV-kiesés:** ha egy futásban a NAV nem érhető el – időtúllépés, hálózati hiba, karbantartás
  (`MAINTENANCE_MODE`), HTTP 5xx NAV-válasz nélkül –, a futás az első ilyen hiba után nem fordul
  tovább a NAV-hoz (időtúllépésnél és hálózati hibánál azonnal; a gyors „nem elérhető” válasznál az
  éppen kezelt számla után, amelynek még a tartalék lekérdezése is lefuthat): a többi számla állapota
  nem változik, megjegyzése „A NAV ebben a futásban nem érhető el (<kód>), ezért a program ennél a
  számlánál nem fordult a NAV-hoz – a számla állapota nem változott. Futtasd később újra a
  nav_sync-et.” Így egy nem válaszoló NAV egy futást legfeljebb egy kérés időkorlátjáig (60
  másodperc) tart fel, nem számlánként. Egy ezért el nem küldött kérés hibája `NOT_SENT`: „A kérést nem
  küldtük el: a NAV ebben a futásban nem érhető el (<kód>).” (kiállításkor, ha letelt a NAV-ra szánt
  idő: „A kérést nem küldtük el: a kiállításkor a NAV-ra szánt idő letelt.”, 6.9). Ez a megjegyzésekben
  jelenik meg, ha egy egyeztetés lekérdezése maradt el miatta (pl. „Ismétlésként elutasítva; a NAV-nál
  tárolt számla lekérése most nem sikerült (A kérést nem küldtük el: a NAV ebben a futásban nem érhető
  el (TIMEOUT).) – futtasd később újra a nav_sync-et.”); a számla ettől nem kerül végleges hibába, a
  teendő: később újra `nav_sync`.
- **Forgalomkorlátozás, Retry-After:** ha a NAV forgalomkorlátozást (HTTP 429 `TOO_MANY_REQUESTS`) vagy
  `Retry-After` fejléccel karbantartást (HTTP 503 / `MAINTENANCE_MODE`) jelez, a futás azonnal leáll, és
  a program az adatbázisban megjegyzi, mikortól fordulhat a NAV-hoz újra (a `Retry-After` szerint;
  fejléc nélküli 429-nél 60 másodperc; legfeljebb 1 óra – utána a következő futás újra próbálkozik).
  Addig ebben a NAV-környezetben semmit nem küld be és nem kérdez le: sem a későbbi `nav_sync`
  futások, sem a feldolgozás alattiak lekérdezése, sem a kiállításkori beküldés (6.9), sem az
  adószám-lekérdezés (`taxpayer_lookup`, NAV_PAUSED, 6.4) – egy másik programpéldányban sem. Az
  adószám-lekérdezésre kért szünetet a program ugyanígy megjegyzi. A számlák `pending` / `processing`
  állapotúak maradnak (nem lesznek `error`),
  megjegyzésük pl. „A NAV forgalomkorlátozás miatt (HTTP 429) azt kérte, hogy legkorábban 2026.11.08.
  17:05:30-kor forduljunk hozzá újra (Retry-After): addig a program nem küld be és nem kérdez le
  semmit – a számla állapota nem változott. Utána futtasd újra a nav_sync-et.” (karbantartásnál „…
  karbantartás miatt …”); a `setup_status` teendői is jelzik. A program a hívásban nem várakozik.
- **Bizonytalan kimenetel** (időtúllépés, a kérés elküldése után megszakadt kapcsolat, olvashatatlan
  HTTP 2xx válasz, HTTP 502/504 NAV-válasz nélkül): a számla `pending` marad, üzenetei `WARN <kód>` és
  `INFO OPENSZAMLA_UNCERTAIN`. A program a beküldés után 5 percig nem küldi újra (a megjegyzés megmondja,
  hány perc múlva futtasd újra); utána a NAV tranzakciólistáján (`queryTransactionList` – a beküldés
  körüli időszak minden oldalán –, majd `queryTransactionStatus` az eredeti kéréssel) megkeresi a
  pontosan ugyanazt az adatot tartalmazó beküldést; a más technikai felhasználó (pl. egy webáruház)
  által beküldött és a technikai érvénytelenítést tartalmazó tranzakciókat nem vizsgálja. Ha megtalálja,
  azt fogadja el, és nem küld újra („A korábbi, bizonytalan kimenetelű beküldést a NAV megkapta
  (tranzakció: …), ezért nem küldtük újra.”); ha nem, a kísérletet meg nem érkezettnek jelöli
  (`OPENSZAMLA_NOT_RECEIVED`), és a számlát egyszer beküldi. A beküldés körüli időszakot a NAV órája
  szerint számolja: a NAV válaszaiból – a HTTP `Date` fejlécből és az adatszolgáltatási token
  kiadásának időpontjából (`tokenValidityFrom`; ez akkor is megvan, ha egy proxy a `Date` fejlécet
  elhagyja) – méri, mennyit siet vagy késik e gép órája. A beküldés előtt mért, legalább egyperces
  eltérést még a jelentés elküldése **előtt** rögzíti (`nav.clock` naplóbejegyzés, `clockOffsetMs`; a
  webes naplóban „NAV-beküldés előtt: a gép órája eltér a NAV órájától – a gép órája a NAV órájához
  képest: … perccel siet / késik”), a bizonytalan kimenetelű beküldésnél a `nav.submit.uncertain`
  bejegyzésben is, és az egyeztetéskor ezzel számol – így percekkel siető vagy késő óránál is megtalálja
  a saját beküldését, akkor is, ha az órát közben beállították, vagy a program a küldés közben leállt
  (összeomlás, áramszünet). Ha a kísérletnél mért eltérés ismert, a beküldés óta eltelt időt (az 5 perces
  várakozást) is a NAV órája szerint számolja. Egy összeomlás miatt „küldés alatt” maradt, 3 percnél
  régebbi kísérletet ugyanígy kezel (rögzített eltérés híján az egyeztetéskor mérttel). Ha a
  tranzakciólista nem kérdezhető le, a számla
  sorszámával kérdezi le a NAV-ot (`queryInvoiceData`, összevetés: lásd a következő pontot): ha ott ez a
  számla szerepel, `done` lesz, és nem küld újra („… a NAV-nál a számla szerepel …, ezért nem küldtük
  újra.”); ha egy másik számla – a számla kiállítása előtt a NAV-hoz érkezett is az –, sorszám-ütközés
  („Sorszám-ütközés: a NAV-nál ezzel a sorszámmal egy másik számla szerepel (eltérés: …) – ez a számla
  nincs jelentve, és nem küldtük be. …”). Különben nem küld semmit: átmeneti hibánál későbbi
  újrafuttatást kér („… most nem sikerült … Futtasd később újra a nav_sync-et.”); végleges NAV-hibánál
  (pl. a technikai felhasználónak nincs lekérdezési jogosultsága – FORBIDDEN –, hibás a jelszava, le
  van tiltva) a számla `error` lesz, üzenetei között a NAV hibája és `OPENSZAMLA_RECONCILE_BLOCKED` a
  teendővel (pl. „… mert a technikai felhasználónak nincs lekérdezési jogosultsága („Számlák
  lekérdezése”). Addig nem küldi (újra), különben kétszer kerülhetne a NAV-hoz. Add meg a technikai
  felhasználónak a „Számlák lekérdezése” (vagy „Saját számlák lekérdezése”) jogosultságot … Utána
  futtasd: nav_sync resubmitFailed: true.”). Ezt a `navProblems` számolja, és a `setup_status` teendői
  is megnevezik (6.1); a `resubmitFailed` nélküli `nav_sync` nem foglalkozik vele, a hiba elhárítása
  utáni `nav_sync resubmitFailed: true` (vagy `nav_sync { invoice }`) előbb egyeztet, és csak ha kell,
  küld. A lekérdezésekhez a technikai felhasználónak lekérdezési jogosultság is kell
  ([nav-beallitas.md](nav-beallitas.md)).
- **Ismétlésként elutasított beküldés** (`INVOICE_NUMBER_NOT_UNIQUE`): ha a számla egy másik
  beküldését a NAV befogadta, a számla azzal `done`. Különben a program lekéri a NAV-tól az ezzel a
  sorszámmal tárolt számlát (`queryInvoiceData`), és összeveti ezzel a számlával – az, hogy a sorszám
  a NAV-nál érvényes, önmagában nem bizonyítja, hogy ez a számla van ott. Az összevetés pontjai, ebben a
  sorrendben:
  - a NAV a tárolt számlát **e számla kiállítása előtt** kapta meg: a beérkezése a NAV adatai szerint
    (`queryInvoiceData` auditadat, `insdate`) több mint 5 perccel korábbi, mint e számla kiállítása (e
    gép órája szerint, a gép és a NAV órájának mért eltérésével helyesbítve – a számla első beküldésekor
    rögzített értékkel, ennek híján az egyeztetéskor mérttel; az 5 perc a tűrés). Az a számla korábban
    létezett, mint ez, tehát nem ez – akkor sem, ha az adatai bájtra azonosak: **sorszám-ütközés**
    (lásd lent). Egy visszaállított mentés után az újra kiadott sorszámú számla ugyanazt a tételt
    ugyanazon az áron egy másik magánszemélynek is szólhat; magánszemélyről a NAV csak a státuszát
    kapja, így a két NAV-adat bájtra azonos, és csak az időpont különbözteti meg őket. Az
    `OPENSZAMLA_NUMBER_COLLISION` üzenet mindkét időpontot megadja („A(z) … sorszám a NAV-nál egy másik
    számláé: az ezzel a sorszámmal ott tárolt számlát a NAV 2026.11.14. 10:00:05-kor kapta meg, ez a
    számla pedig csak 2026.11.14. 14:05:00-kor készült (e gép órája szerint), így az nem ez a számla –
    akkor sem, ha az adatai egyeznek vele (…). Ez a számla tehát NINCS jelentve …”); az eltérés az
    egyeztetés megjegyzésében és az auditnaplóban (`nav.reconcile`, a NAV-időponttal: `insDate`): „a NAV
    …-kor kapta meg, ez a számla csak …-kor készült”. A valódi újraküldést ez nem érinti: a válasz
    nélkül maradt beküldés, és a kiállítás után, de a beküldés előtt készült mentés visszaállítása
    utáni ismételt beküldés is a kiállítás után érkezett a NAV-hoz, így ezek a következő pontok szerint
    `done` lesznek. Ha a NAV válaszában az időpont nem olvasható, ez a pont kimarad. Korlátok: ha a
    mentést a kiállítást követő 5 percen belül állították vissza, és az újra kiadott számla NAV-adata
    bájtra azonos, a két számla nem különböztethető meg; egy elveszett számla szándékos, azonos adatú
    újrarögzítése pedig sorszám-ütközésként jelenik meg – ellenőrizd a NAV felületén; ha a beküldéskor
    az óraeltérést nem lehetett mérni (a NAV a tokencserére sem válaszolt), és e gép óráját a kiállítás
    és az egyeztetés között 5 percnél többel átállították, egy valódi újraküldés is sorszám-ütközésnek
    tűnhet;
  - a NAV-nál tárolt adat bájtra azonos a számla egyik beküldésével (pl. egy válasz nélkül maradt
    korábbi beküldés): `done` (`OPENSZAMLA_RECONCILED`);
  - más az adattartalom, és a NAV-nál tárolt számlát a NAV webes felületén **kézzel rögzítették** (a
    NAV adatai szerint – `queryInvoiceData` auditadat, forrás – `WEB`; pl. a NAV-kiesés miatti kézi
    rögzítés, [nav-beallitas.md](nav-beallitas.md), 5. pont), de egyeznek a kulcsadatok – kelte, az
    eladó adószáma, a vevő (adószáma, ha mindkét oldalon van, különben a neve, kis- és nagybetűtől,
    ékezettől, szóközöktől függetlenül; magánszemélynél a státusza), a pénznem, a nettó, az ÁFA és a
    bruttó forintösszeg: `done`, az `OPENSZAMLA_RECONCILED` üzenet ezt a forrással együtt jelzi („…
    nem gépi interfészen került a NAV-hoz – a NAV webes felületén rögzítették (WEB) –, és a
    kulcsadatai egyeznek ezzel a számlával …”), és kéri, hogy a NAV felületén a többi adatot is
    ellenőrizd. A kézzel begépelt tételek szövege eltérhet, ezért a tételeket itt nem veti össze;
  - más az adattartalom, és a NAV-nál tárolt számla **más úton** került a NAV-hoz: **gépi
    interfészen** (`MGM`, ismeretlen forrásnál is így – egy számlázó program küldte be: ez a program
    egy másik változata vagy telepítése, vagy egy másik program), **kézi XML-feltöltéssel** (`XML` –
    pl. e program XML-exportjának (6.18) egy fájlját töltötték fel a NAV felületén), a **NAV Online
    Számlázó** programjában állították ki (`OSZ`), vagy **online pénztárgépről** jött (`OPG`). Ezeket
    program állította elő, nem kézzel gépelték: csak akkor ez a számla, ha a kulcsadatai mellett a
    tételei is egyeznek: a
    tételek száma, és tételenként a megnevezés (kis- és nagybetűtől, ékezettől, szóközöktől
    függetlenül), a mennyiség, a mennyiségi egység, a nettó összeg és az ÁFA-kulcs (vagy mentességi,
    hatályon kívüli eset). Ekkor `done`, az `OPENSZAMLA_RECONCILED` üzenete: „… gépi interfészen (MGM)
    érkezett, és nem bájtra azonos egyik itt nyilvántartott beküldéssel sem, de a kulcsadatai (…) és a
    tételei (…) is egyeznek ezzel a számlával – pl. a program egy másik változata vagy telepítése
    küldte be –, ezért a számla jelentve van. …”; a többi forrásnál „… nem gépi interfészen került a
    NAV-hoz – kézi XML-feltöltéssel került a NAV-hoz (XML) –, és nem bájtra azonos egyik itt
    nyilvántartott beküldéssel sem, de a kulcsadatai (…) és a tételei (…) is egyeznek ezzel a
    számlával, ezért a számla jelentve van. …” (illetve „– a NAV Online Számlázó programjában
    állították ki (OSZ) –”, „– online pénztárgépről érkezett (OPG) –”); egy későbbi futás egyeztetésének
    megjegyzése: „A NAV-nál ellenőrizve: ezzel a sorszámmal azonos kulcs- és tételadatú számla szerepel
    – … –, tehát jelentve van – lásd az üzenetet.” (gépi interfésznél: „… gépi interfészen beküldött,
    azonos kulcs- és tételadatú számla szerepel …”). A kulcsadat-egyezés itt nem elég: egy
    visszaállított mentés után az újra kiadott sorszámú számla gyakran egy másik magánszemélynek szól
    ugyanazon az áron (magánszemélyről a NAV csak a státuszát kapja), vagy ugyanannak a cégnek ugyanarra
    az összegre, más tételekkel – és ugyanezt a sorszámot egy másik csatorna (pl. a NAV Online
    Számlázója vagy egy online pénztárgép) is felhasználhatta;
  - másik számla – e számla kiállítása előtt érkezett a NAV-hoz (lásd fent), eltérő kulcsadatú, vagy
    nem a NAV webes felületén rögzítették és eltérő tételű: **sorszám-ütközés**. A számla `aborted`
    marad, üzenete
    `OPENSZAMLA_NUMBER_COLLISION` („A(z) … sorszám a NAV-nál egy másik számláé: az ezzel a sorszámmal
    ott tárolt számla adatai eltérnek ettől a számlától (vevő, …). Ez a számla tehát NINCS jelentve …”;
    egyező kulcsadatoknál a zárójelben az eltérő tételadatok, pl. „1. tétel megnevezése”, „2. tétel
    mennyisége”, „tételek száma”; a kiállítása előtt érkezett számlánál a két időpont, lásd fent),
    amely megnevezi a valószínű okot (egy régebbi mentés visszaállítása után újra kiadott sorszám,
    vagy ugyanezt a sorszámtartományt használó másik számlázó program / telepítés), a
    sorszámtartomány következő sorszámát (ellenőrizd, hogy a NAV-nál szabad-e; ha nem, új
    sorszámtartomány eltérő előtaggal, 6.3) és a teendőt (szakértői segítség; ha a NAV-nál tárolt
    számlát technikai érvénytelenítéssel visszavonják, utána `nav_sync { invoice, resubmitFailed: true }`).
    A `navProblems` számolja, a teendők között külön sor jelzi (6.1), módosító és sztornó számlája nem
    küldhető be (a NAV a másik számlához kötné), és a program újra sem küldi, amíg a NAV-nál ezen a
    sorszámon a másik számla szerepel (az újraküldés nem segítene). A felvett sorszám-ütközést a
    program nem kérdezi le újra minden futásban: sem a `resubmitFailed` nélküli `nav_sync`, sem az
    összes számla újraküldése (`resubmitFailed: true` `invoice` nélkül), sem a módosító/sztornó
    számláinak beküldési kísérlete nem fordul miatta a NAV-hoz; az újraküldés megjegyzése:
    „Sorszám-ütközés: … (az újraküldés nem segít). A program ezt nem kérdezi le újra a NAV-tól minden
    futásban: ha a NAV-nál ezen a sorszámon tárolt másik számlát technikai érvénytelenítéssel
    visszavonták, az újraellenőrzéshez futtasd: nav_sync { invoice: "…", resubmitFailed: true }.” Újra csak a számla
    kifejezett megadásakor egyeztet (`nav_sync { invoice: "<sorszám>", resubmitFailed: true }`, vagy
    `invoice` `resubmitFailed` nélkül, pl. a webes felületen a bizonylat NAV részének gombja, 8.3), és
    csak akkor küldi be, ha a NAV-nál ezen a sorszámon már nincs érvényes számla;
  - a NAV-nál nincs érvényes számla ezzel a sorszámmal: `aborted` marad, az `OPENSZAMLA_HINT` leírja a
    teendőt (ha az onlineszamla.nav.gov.hu felületén sem szerepel: `nav_sync resubmitFailed: true`);
  - a sorszám a NAV-nál többször is érvényes (MULTIPLE_QUERY_RESULT_FOUND): `aborted` marad, az
    `OPENSZAMLA_HINT` szerint a fölösleget a NAV felületén technikai érvénytelenítéssel kell visszavonni;
  - a lekérdezés átmenetileg nem sikerült: `aborted` marad `OPENSZAMLA_RECONCILE_RETRY` üzenettel, a
    következő `nav_sync` újra megpróbálja; végleges NAV-hibánál `OPENSZAMLA_RECONCILE_BLOCKED` a
    teendővel, mint az előző pontban.

  A még egyeztetendő (le nem kérdezett vagy átmeneti hiba miatt újra lekérdezendő) ismétléseket a
  `resubmitFailed` nélküli `nav_sync` is feldolgozza (csak ezt az egyeztetést végzi rajtuk), és a
  módosító/sztornó számla beküldése előtt az ismétlésként elutasított, még nem egyeztetett eredetit is
  egyezteti. A már egyeztetett eredetit (sorszám-ütközés, végleges NAV-hiba miatt elakadt egyeztetés,
  `OPENSZAMLA_HINT`) a javító okiratai miatt nem kérdezi le újra: a végleges NAV-hibát a hiba
  elhárítása utáni `nav_sync resubmitFailed: true` egyezteti (utána a javító okiratok ugyanabban a
  futásban követik az eredetit), a sorszám-ütközést a fenti kifejezett kérés.
- Ha egy számla adataiból a NAV-adat nem állítható elő (NAV_DATA_INVALID – a kiállítás előtti ellenőrzés
  ezt kiszűri, így csak egy régebbi változattal kiállított számlánál fordulhat elő), a számla `error`
  állapotú lesz a hiba leírásával, a többi számla szinkronja folytatódik. Ez programhiba: a javaslat
  ilyenkor nem módosító vagy sztornó számla (amíg az eredeti nincs a NAV-nál, azokat sem fogadja be),
  hanem hibajelzés a fejlesztőknek és segítségkérés (könyvelő, NAV ügyfélszolgálat), mert az eredeti
  számla jelentését pótolni kell ([nav-beallitas.md](nav-beallitas.md), 5. pont).
- Használható NAV-kapcsolat nélkül a `nav_sync` hibát ad (NAV_NOT_CONFIGURED / NAV_INVALID_CONFIG, a
  beállító paranccsal, 3.4).

Eredmény: `summary` („N számla feldolgozva, ebből M sikeresen jelentve a NAV TESZT rendszerébe – éles
adatszolgáltatás NEM történt.” / „… sikeresen jelentve (éles környezet).”), `environment` (`test` /
`production`), `results` – számlánként `invoiceId`, `number`, `navStatus`, `transactionId`,
`messages` (a NAV és a program üzenetei: súlyosság, kód, szöveg, hely), `environment` (a
NAV-rendszer, amelyhez a számla NAV-állapota tartozik), `note` (rövid magyarázat, a futás végi
állapot szerint) és – csak ha a futás leállása miatt ennél a számlánál nem fordult (tovább) a NAV-hoz,
amit a `note` el is mond – `notProcessed`: `time` (letelt az időkeret, lásd **Időkeret**), `outage`
(a NAV ebben a futásban nem érhető el, lásd **NAV-kiesés**) vagy `pause` (a NAV szünetet kért, lásd
**Forgalomkorlátozás, Retry-After**); a teendő ilyenkor: később újra `nav_sync`. A `summary`
„sikeresen jelentve” száma csak a beállított környezetben befogadott számlákat számolja. Ha volt
nem feldolgozott számla, az eredményben `notProcessed` is van – az érintett számlák
sorszámai (sorszám nélkül az azonosítójuk) –, a `summary` végén pedig okonként egy mondat: „K számlára
ebben a hívásban nem jutott idő (a NAV-ra szánt 45 mp letelt): futtasd újra a nav_sync-et, a
következő hívás folytatja.”, „K számlához a program nem fordult a NAV-hoz, mert a NAV ebben a futásban
nem volt elérhető: futtasd később újra a nav_sync-et.”, illetve „K számlához a program nem fordult a
NAV-hoz, mert a NAV szünetet kért (Retry-After): a megjegyzésben megadott időpont után futtasd újra a
nav_sync-et.”

Állapotok és megjegyzéseik: `pending` (beküldésre vár; „Átmeneti hiba miatt nem sikerült elküldeni –
később újrapróbálható (nav_sync).”, bizonytalan kimenetelnél lásd fent), `processing` (a NAV
feldolgozza; ha a NAV a tranzakcióról nem ad eredményt – nem ismeri, pl. mert a tesztrendszert
kiürítették, vagy megváltozott a technikai felhasználó vagy az eladó adószáma –, a program a beküldés
után 5 perccel lezárja a kísérletet, és a sorszám alapján dönt (`queryInvoiceData`, az összevetés a fenti
szabályok szerint): ha a számla a NAV-nál szerepel, `done`; ha másik számla, sorszám-ütközés; ha a
sorszám többször érvényes, `aborted` a teendővel; ha nincs ott, a számla `pending` lesz
`OPENSZAMLA_TRANSACTION_UNKNOWN` üzenettel – „A NAV … nem ismeri a korábbi beküldés tranzakcióját, és
ezzel a sorszámmal sincs nála számla: a következő nav_sync újra beküldi.” –, és a következő szinkron
beküldi; amíg a NAV nem kérdezhető le, `processing` marad), `done` („A NAV sikeresen befogadta.”; teszt környezetben „A NAV TESZT rendszere befogadta
– éles adatszolgáltatás NEM történt.”), `done_with_warnings` (befogadta, figyelmeztetéssel – nézd át az
üzeneteket), `aborted` („… elutasította (ABORTED): hárítsd el a hiba okát (lásd az üzeneteket), majd
küldd újra: nav_sync resubmitFailed: true.”; sorszám-ütközésnél „Sorszám-ütközés: a NAV ezzel a
sorszámmal egy másik számlát tárol, ez a számla nincs jelentve – a teendőt az üzenetek írják le (az
újraküldés nem segít).”), `error` („Végleges hiba (pl. hibás hitelesítő adatok): hárítsd el az okát
(lásd az üzeneteket), majd küldd újra: nav_sync resubmitFailed: true.”; ha a NAV-val egyeztetni kellene,
de a lekérdezés végleges hibát ad – `aborted` állapotnál is –: „A NAV lekérdezése végleges hibát ad,
ezért nem egyeztethető, mi van ebből a számlából a NAV-nál – a teendőt az üzenetek írják le, utána:
nav_sync resubmitFailed: true.”),
`not_configured` (kiállításkor nem volt használható NAV-kapcsolat), `not_applicable` (díjbekérő,
nem jelentendő). Teszt környezetben minden megjegyzés jelzi, hogy a NAV TESZT rendszeréről van szó.

#### 6.15.1 `nav_send_to_configured_environment` – a másik NAV-rendszerhez tartozó számla beküldése (visszafordíthatatlan)
Paraméterek: `invoice` (azonosító vagy sorszám), `confirmationCode` (a `nav_sync { invoice,
resubmitFailed: true }` előnézetének megerősítő kódja, 6.15 – csak a felhasználó jóváhagyása után
adható át), `waitSeconds` (mint a `nav_sync`-nél: 0–45, alapértelmezés 15, legfeljebb az időkeret
végéig).
- Egyetlen számlát küld be – amelynek NAV-állapota a másik NAV-rendszerhez tartozik, pl. éles
  környezetben a csak a TESZT rendszerbe jelentett számlát – a beállított rendszerbe, **új
  beküldésként**. Éles környezetben ez **valódi adatszolgáltatás a NAV felé, és nem vonható vissza**;
  csak akkor használd, ha a felhasználó megerősítette, hogy ez valódi számla. Tömegesen soha.
- MCP-annotációi (mint az `invoice_issue`-é, 6.9): `readOnlyHint: false`, `destructiveHint: true`
  (visszafordíthatatlan), `idempotentHint: true` (a megismételt hívás nem küld újra), `openWorldHint:
  true` (a NAV-hoz fordul), valamint `anthropic/requiresUserInteraction: true`: a kliens minden
  hívásnál a felhasználó engedélyét kéri.
- **Megerősítés**, mint a kiállításnál (6.9): `code` és `elicit` módban (3.3) a megerősítő kód
  kötelező – nélküle CONFIRMATION_REQUIRED („Hiányzik a megerősítő kód.”; javaslat: „A kódot a nav_sync
  { invoice, resubmitFailed: true } adja az előnézettel. …”). A kód csak arra érvényes, amit az előnézet
  mutatott: érvénytelen vagy lejárt kódra, illetve ha az előnézet óta megváltozott a számla
  NAV-állapota (az ottani állapota, vagy hogy melyik NAV-rendszerhez tartozik) vagy a beállított
  NAV-környezet: CONFIRMATION_INVALID („A megerősítő kód érvénytelen vagy lejárt, vagy az előnézet óta
  megváltozott a számla NAV-állapota (az állapota, vagy hogy melyik NAV-rendszerhez tartozik), illetve a
  beállított NAV-környezet.”; javaslat: friss előnézet és kód: `nav_sync { invoice, resubmitFailed: true
  }`). `elicit` módban a kód mellett a kliens párbeszédablakában is jóvá kell hagyni („Beküldöd a(z) …
  számlát az ÉLES NAV-rendszerbe? …” – a TESZT rendszerbe: „… a TESZT NAV-rendszerbe? …” –, utána az
  előnézet szövege); elutasításra semmi nem történik (`status: cancelled_by_user`); ha a kliens nem tud
  párbeszédet nyitni, ELICITATION_UNSUPPORTED, a 2025-ös protokollú HTTP-kapcsolaton
  ELICITATION_UNAVAILABLE_LEGACY_HTTP (6.9) – és nem küld be semmit. `OPENSZAMLA_CONFIRM_MODE=none`
  esetén kód és párbeszéd sem kell.
- **Ha nincs mit beküldeni**, semmit nem küld be, és hibát ad: használható NAV-kapcsolat nélkül a
  `nav_sync` hibáját (NAV_NOT_CONFIGURED / NAV_INVALID_CONFIG, 3.4); egyébként NOT_OTHER_NAV_SYSTEM:
  „A(z) … számla NAV-állapota nem a másik NAV-rendszerhez tartozik (az éles NAV-rendszerhez tartozik
  | a TESZT NAV-rendszerhez tartozik | még egyik NAV-rendszerbe sem került, állapota: …): nincs mit
  átküldeni.” (javaslat: „Részletek: invoice_get …; a beállított NAV-rendszer számláit a nav_sync
  kezeli.”) – így egy már beküldött számlára megismételt hívás sem küld újra; piszkozatnál és
  díjbekérőnél „A(z) … nem jelentendő a NAV-nak (piszkozat vagy díjbekérő): nincs mit beküldeni.”; ha
  egy korábbi beküldését a beállított rendszer már befogadta (a környezetet oda-vissza állították): „A(z)
  … számla egy korábbi beküldését az éles | a TESZT NAV-rendszer már befogadta: nincs mit beküldeni.”
  (javaslat: „A befogadott beküldést beküldés nélkül átveszi: nav_sync { invoice: "…", resubmitFailed:
  true }.”).
- A beküldés egyébként mint a `nav_sync` egy számlára (6.15): az időkeret (kb. 45 másodperc, lásd
  **Időkeret**), a NAV-kiesés, a NAV által kért szünet, a kettős beküldés kizárása és a bizonytalan
  kimenetel szabályai szerint. Eredmény: a `nav_sync` eredménye (`summary`, `environment`, `results`,
  ha kell, `notProcessed`) és `crossEnvironment` (mint az előnézetben). A beküldési kísérlet után a
  számla NAV-állapota a beállított rendszerhez tartozik – akkor is, ha a NAV elutasította (ennek
  újraküldése a hiba elhárítása után: `nav_sync resubmitFailed: true`), vagy ha átmeneti hiba miatt nem
  sikerült (ezt a következő `nav_sync` küldi be: a megerősítés erre a beküldésre szólt). Ha a beküldés el
  sem indult (pl. letelt az időkeret, a NAV nem érhető el vagy szünetet kért – `notProcessed`), a számla
  a másik rendszerhez tartozik tovább, és később – ha a kód még érvényes, azzal, különben friss
  előnézettel – újra beküldhető.
- Parancssorban ugyanezt az `openszamla nav-send-to-configured-environment` végzi (7.13); a webes
  felület ilyen számlát nem küld be (8.3).

### 6.16 `exchange_rate` – MNB árfolyam (csak olvas)
Paraméterek: `currency` (pl. EUR), `date` (alapértelmezés: a mai nap). Az adott napon érvényes (az
utolsó, aznap vagy korábban közzétett) hivatalos MNB árfolyam 1 egységre: `currency`, `rate`, `date`
(a jegyzés napja), `unit` (1), `source` (`MNB`). Forintra 1. Az MNB elérése kell (a múltbeli napokét a
program tárolja).

### 6.17 `report_summary` – időszaki összesítő (csak olvas)
Paraméterek: `from` (alapértelmezés: a folyó hónap első napja), `to` (alapértelmezés: a mai nap) – a
határnapokkal együtt; a `from` nem lehet későbbi a `to`-nál (INVALID_INPUT: „A kezdő dátum (…) későbbi a
záró dátumnál (…).”, javaslattal; az azonos nap egynapos időszak) –, `dateBasis`: `issue`
(alapértelmezés: az időszakot a kelte szerint veszi), `fulfillment` (a teljesítés dátuma szerint –
főszabály szerint ez az ÁFA szempontjából irányadó nap, egy hónap ÁFA-adataihoz ezt használd: a
szeptemberi teljesítésről októberben kiállított számla szeptemberhez tartozik) vagy `payment` (a
befizetés dátuma szerint, lent). Kivétel a pénzforgalmi elszámolás: ott az adót az ellenérték
megtérülésének (jóváírásának, kézhezvételének) időszakában kell megállapítani, részfizetésnél arányosan
(Áfa tv. 196/B. §) – ezt a `payment` dátumalap mutatja.
- **Befizetés dátuma szerint** (`dateBasis: "payment"`, pénzforgalmi elszámolás): az időszakba eső
  dátumú befizetések és visszafizetések (a befizetési napló sorai, 6.13) azon részei számítanak, amelyek
  pénzforgalmi elszámolással kiállított bizonylatra jutnak – olyanra, amelyen a „pénzforgalmi
  elszámolás” megjelölés szerepel (az eladó a kiállításkor pénzforgalmi elszámolású volt, és a
  bizonylatnak van százalékos ÁFA-kulcsú tétele; a módosító és a sztornó számla az eredeti számla
  ÁFA-helyzetét követi, 6.10, 6.11). Minden rész nettó, ÁFA és bruttó értéke a bizonylatéval arányos: a
  rész × a bizonylat ÁFA-kódonkénti forintos (a bizonylat árfolyamán számolt) nettó, ÁFA, illetve bruttó
  összege ÷ a bizonylat bruttó végösszege a bizonylat pénznemében, befizetés-részenként és ÁFA-kódonként
  0,01 forintra kerekítve. Az eredeti számlán rögzített, a módosító számlát is fedező befizetés módosító
  számlára jutó része a módosító számla ÁFA-ja szerint számít, a sztornó számlán rögzített visszafizetés
  negatív összeggel, a visszavonás a saját dátumán, negatív összeggel. Díjbekérőre rögzített befizetés nem
  számít (a belőle kiállított számlára átvett befizetés igen, a díjbekérőn rögzített dátummal). Egy
  részben, két hónapban fizetett számla ÁFA-ja így a két hónap között oszlik meg, összesen a számla ÁFA-ja
  (a kerekítés miatt legfeljebb néhány fillér eltéréssel). `invoiceCount`: a beszámított bizonylatok, a
  csak ennél az alapnál meglévő `paymentCount`: a beszámított befizetések száma; `byMonth` a befizetés
  dátumának hónapja szerint (a `count` a bizonylatoké), `topCustomers` a beszámított bruttó szerint. A
  `notes` első eleme: „Befizetés dátuma szerinti összesítés (pénzforgalmi elszámolás, Áfa tv. 196/B. §):
  csak a pénzforgalmi elszámolással kiállított bizonylatok befizetései és visszafizetései számítanak, a
  befizetés dátuma szerint. Egy befizetés ÁFA-ja a bizonylat ÁFA-jának a befizetéssel arányos része
  (befizetés × ÁFA ÷ bruttó végösszeg, forintban, a bizonylat árfolyamán, befizetésenként és
  ÁFA-kódonként 0,01 forintra kerekítve); a módosító számlára jutó részt a módosító számla ÁFA-ja
  szerint. Hogy a részfizetés adóját így kell-e megállapítani, és mi a bevallandó adó, a könyvelő dönti
  el.”; ha az időszakban nem pénzforgalmi elszámolással kiállított bizonylatra is érkezett befizetés,
  utána: „Az időszakban további N bizonylatra érkezett befizetés, de azokat nem pénzforgalmi
  elszámolással állították ki (pl. fordítottan adózó, adómentes vagy Közösségen belüli ügylet, vagy az
  eladó a kiállításkor nem volt pénzforgalmi elszámolású): ezek ÁFA-ja nem a befizetéshez kötődik, ezért
  itt nem szerepelnek.” A kelte és a teljesítés szerinti figyelmeztetés és a teljesítési dátum
  javításáról szóló figyelmeztetés ennél az alapnál nincs. A `receivables` ugyanaz, mint a másik két
  alapnál.
- A kiállított és sztornózott számlák, előleg-, vég-, módosító és sztornó számlák számítanak bele
  (piszkozat és díjbekérő nem); a sztornó és a módosító számlák előjelesen számítanak.
- **Időszakba sorolás:** minden bizonylat a saját kelte, illetve (`fulfillment`) a saját teljesítési
  dátuma szerinti időszakba kerül. Ha egy módosító számla a számla teljesítési dátumát javítja, az
  eredeti számla az eredeti teljesítési dátum időszakában marad, a dátumot javító módosító számla és
  az utána kiállított módosító és sztornó számlák (ezek a számla javított teljesítési dátumával
  készülnek, 6.10, 6.11) a javított dátum időszakában számítanak – egy októberi teljesítésű,
  novemberre javított, majd sztornózott számla ÁFA-ja teljesítés szerint októberben pozitív, novemberben
  negatív összeggel jelenik meg. Hogy az eredeti időszakot önellenőrzéssel kell-e helyesbíteni, a
  könyvelő dönti el; erre a `notes` figyelmeztet (lent).
- Eredmény: `from`, `to`, `dateBasis`, `invoiceCount`, `paymentCount` (csak `payment` alapnál),
  `totalsHuf` (nettó, ÁFA, bruttó forintban), `byVatCode` (ÁFA-kódonként), `byMonth` (havonta, a
  választott dátum szerint), `topCustomers` (a 10 legnagyobb vevő bruttó forintösszeg szerint),
  `receivables`, `notes`.
- `receivables` – a mai állapot, az időszaktól függetlenül, akárhány bizonylatról: `unpaidCount` és
  `overdueCount` a kifizetetlen vagy részben fizetett, illetve ezek közül a lejárt határidejű
  kintlévőségek száma (pontosan azok, amelyeket az `invoice_list` kifizetetlenként és lejártként listáz,
  és amelyeket a `setup_status` `counts.unpaid` számol); `unpaidGrossHuf` és `overdueGrossHuf` a
  hátralékuk forintban, mindegyik a saját árfolyamán: a számla és módosító számlái együttes rendezése
  szerint (6.13 – a nyitott jóváírás beszámítva, a túlfizetés átvezetve), így egyik sem lehet 0-nál
  kisebb, és egy bizonylat pontosan akkor számít, ha van rajta hátralék. Forintos bizonylatnál a
  hátralék maga (készpénzes számlánál a 0/5 forintra kerekített fizetendő összegből, 5.1); devizás
  bizonylatnál, amelyen még semmi sincs rendezve, a bizonylat forintban kimutatott bruttó végösszege
  (a tételek forintértékeinek összege, 5.2 – nem a devizás végösszeg × árfolyam, amely néhány fillérrel
  eltérhet), részben rendezett devizás bizonylatnál a hátralék × árfolyam, 0,01 forintra kerekítve. Az
  összegek legfeljebb 2 tizedesjegyűek.
- `notes` – figyelmeztetések (a `payment` alapé fent): ha az eladó pénzforgalmi elszámolású, vagy az időszak bármely számláját
  pénzforgalmi elszámolású eladóként állították ki: „Pénzforgalmi elszámolás: az itt összesített ÁFA a
  kelte vagy a teljesítés dátuma szerinti, NEM a bevallandó adó. Pénzforgalmi elszámolásnál az adót
  abban az időszakban kell megállapítani, amelyben az ellenérték megtérül (jóváírják vagy kézhez veszik
  – Áfa tv. 196/B. §), részfizetésnél arányosan; ezt a befizetés dátuma szerinti összesítés mutatja. A bevalláshoz a
  befizetések alapján a könyvelő számol.”; ha az időszak bizonylatai között olyan számla, illetve
  annak módosító vagy sztornó számlája van, amelynek teljesítési dátumát egy módosító számla javította
  (a számla aktuális teljesítési dátuma – 6.11 – eltér az eredetiétől), mindkét dátumalapon: „Teljesítési
  dátum javítása: a(z) <sorszám> számla teljesítési dátumát a(z) <sorszám> módosító számla javította
  (<eredeti dátum> → <javított dátum>). A teljesítés dátuma szerinti válogatásban minden bizonylat a
  saját teljesítési dátuma szerinti időszakba kerül: az eredeti számla az eredeti dátum időszakában
  marad, a dátumot javító módosító számla és az utána kiállított módosító és sztornó számlák a javított
  dátum időszakában számítanak. Hogy az eredeti időszakot önellenőrzéssel kell-e helyesbíteni, a
  könyvelő dönti el.” (több ilyen számlánál pontosvesszővel elválasztva, legfeljebb 10 néven nevezve,
  a többi: „(és további N számlánál)”); egyébként üres lista.
- Az időszak bizonylatait a program egyetlen lekérdezéssel, egyenként olvassa be (az
  `export_invoices`, a `tax_audit_export` és az `openszamla verify` is): a futási idő a bizonylatok
  számával arányos, egy év több ezer bizonylata is néhány tized másodperc alatt összesíthető.

### 6.18 `export_invoices` – export
Paraméterek: `from`, `to` (kötelezők, a határnapokkal együtt; a `from` nem lehet későbbi a `to`-nál –
mint 6.17, ilyenkor fájl sem készül), `format`: `csv` (alapértelmezés), `json` vagy `xml`; `dateBasis`
(mint 6.17, ugyanazzal az időszakba sorolással: teljesítési dátumot javító módosításnál az eredeti
számla az eredeti dátum időszakában marad – pénzforgalmi elszámolásnál a kelte és a teljesítés szerinti
egyik sem a bevallandó ÁFA időszaka; `payment`: az időszakba eső dátumú befizetést kapott, pénzforgalmi
elszámolással kiállított bizonylatok, ugyanazok, amelyek a 6.17 szerinti befizetés dátuma szerinti
összesítésben szerepelnek, kiállítási sorrendben); `ledger` (`true`: a számlák helyett az időszak
befizetési naplója, lent).
- A választott időszak kiállított és sztornózott számláit, előleg-, vég-, módosító és sztornó számláit
  exportálja (piszkozatot és díjbekérőt nem) az adatkönyvtár `export/` mappájába: `szamlak_<from>_<to>.csv`
  / `.json`, illetve a `szamlak_<from>_<to>_nav-xml/` mappába; teljesítés szerinti válogatásnál
  `szamlak_teljesites_<from>_<to>…`, befizetés szerintinél `szamlak_befizetes_<from>_<to>…`. Az azonos nevű
  korábbi export fájljait felülírja. A befizetés szerinti válogatás fájljai a bizonylatok teljes adatait
  tartalmazzák; az időszakban befizetett részt és annak arányos ÁFA-ját az összesítő (6.17) és a befizetési
  napló adja.
- **CSV** (Excel, UTF-8, pontosvessző, tizedesvessző, magyar fejléc): sorszám, típus, állapot, kelte,
  teljesítés, fizetési határidő, vevő, vevő adószáma (vagy közösségi adószáma), pénznem, árfolyam,
  nettó, ÁFA, bruttó, ugyanezek forintban, fizetési mód, fizetési állapot, NAV-állapot, eredeti számla.
  A típus, az állapot, a fizetési mód, a fizetési állapot és a NAV-állapot szövegesen, a webes felület
  megnevezéseivel szerepel (pl. „számla”, „kiállított”, „átutalás”, „fizetetlen”, „rendben”; a visszavont
  díjbekérő állapota „visszavont”) – a kódokat (`invoice`, `issued`, `TRANSFER` …) a JSON tartalmazza.
  A `=`, `+`, `-` vagy `@` jellel (vagy tabulátorral, kocsivissza jellel) kezdődő szöveges cellák (pl.
  vevőnév) elé a program aposztrófot tesz, hogy a táblázatkezelő ne képletként futtassa őket; az
  összegek számok maradnak. **JSON:** a bizonylatok teljes adata.
- **XML:** számlánként a NAV Online Számla invoiceData, `<fájlnév>.xml` (a fájlnév szabálya mint 6.14).
  Ha egy számla NAV-adata nem állítható elő, a számla kimarad (az export nem szakad meg), és a
  `warnings` megnevezi (`field: "nav-xml"`); a sorszámtól eltérő fájlnév is figyelmeztetést ad (`field:
  "file"`).
- **Befizetési napló** (`ledger: true`): az időszakba eső dátumú minden befizetés, visszafizetés és
  visszavonás (6.13 – a díjbekérőké is, és a 0 Ft-os bizonylat rendezettnek jelölése is), a befizetés
  dátuma, azonos napon a rögzítés sorrendjében, a `befizetesek_<from>_<to>.csv` vagy `.json` fájlba
  (`format`: `csv` vagy `json`; `xml`-re INVALID_INPUT: „A befizetési napló CSV vagy JSON formátumban
  exportálható.”; a `dateBasis` elhagyható vagy `payment`, más: „A befizetési napló a befizetés dátuma
  szerint készül: más dátumalap nem adható meg hozzá.”). **JSON:** befizetésenként `id`, `date`,
  `amount`, `currency`, `kind` (`payment` befizetés, `refund` visszafizetés a vevőnek, `reversal`
  visszavonás, `settled` rendezettnek jelölés), `source` (`manual` rögzítve, `mark_paid` a kiállításkor
  rögzítve, `proforma` a díjbekérőről átvéve), `reference` (a díjbekérő sorszáma), `recordedOn` (a
  bizonylat, amelyre rögzítették), `recordedAt` (a rögzítés ideje) és `allocations`: a lánc bizonylataira
  jutó részek – `invoice`, `amount`, `exchangeRate`, `cashAccounting` (pénzforgalmi elszámolással
  kiállított-e, azaz számít-e a befizetés dátuma szerinti ÁFA-ba), `huf` (az arányos forintos nettó, ÁFA
  és bruttó, 6.17) és `byVatCode`. **CSV** (UTF-8, pontosvessző, tizedesvessző, a fenti
  aposztrófszabállyal): részenként egy sor – Befizetés dátuma; Befizetés azonosítója; Fajta; Forrás;
  Díjbekérő; Rögzítve a bizonylaton; Összeg; Pénznem; Bizonylat; Bizonylat típusa (szövegesen, pl.
  „módosító számla”); Jutó összeg;
  Árfolyam; Nettó (HUF); ÁFA (HUF); Bruttó (HUF); Pénzforgalmi elszámolás (igen/nem) –, a rész nélküli
  befizetés (a 0 Ft-os bizonylat rendezettnek jelölése) egy sor üres rész-oszlopokkal. A `notes` első
  eleme: „Befizetési napló: az időszak minden befizetése, visszafizetése és visszavonása (a díjbekérőké
  is), a befizetés dátuma szerint, azzal, hogy melyik bizonylatra mennyi jutott belőle. A pénzforgalmi
  elszámolás szerinti ÁFA-hoz csak a pénzforgalmi elszámolással kiállított bizonylatokra jutó részek
  számítanak.”, a második a 6.17 szerinti számítási mód.
- Eredmény: `path`, `count` (XML-nél a megírt fájlok száma, befizetési naplónál a befizetéseké, egyébként
  az exportált bizonylatoké), `from`, `to`, `dateBasis` (befizetési naplónál `payment`), `ledger`,
  `warnings` (`invoiceNumber`, `field`, `message`; CSV-nél és JSON-nál üres), `notes` (az export egészére
  vonatkozó figyelmeztetések – a 6.17 szerinti pénzforgalmi elszámolási figyelmeztetés és a teljesítési
  dátum javításáról szóló figyelmeztetés, ugyanazokkal a feltételekkel, a `payment` alapnál és a
  befizetési naplónál a fenti megjegyzések –, egyébként üres lista). Az auditnapló `export` bejegyzése
  a kihagyott sorszámokat is rögzíti, a befizetési naplónál `ledger: true`-val.

### 6.19 `tax_audit_export` – adóhatósági ellenőrzési adatszolgáltatás
A 23/2014. (VI. 30.) NGM rendelet 11/A. §-a szerinti funkció: a megadott **keltezési időszakban**
(`from`, `to` – a `from` nem lehet későbbi a `to`-nál: INVALID_INPUT, „A kezdő dátum (…) későbbi a záró
dátumnál (…).”) vagy egy sorszámtartomány **kezdő és záró sorszáma** közé (`fromNumber`, `toNumber` –
sorszám vagy azonosító, egy sorszámtartományon belül, a kezdő nem lehet a záró után: INVALID_INPUT, „A
kezdő sorszám nem előzi meg a záró sorszámot.”, a felcserélt sorszámokra utaló javaslattal; mindkét
határ kiállított, nem díjbekérő bizonylat) eső kiállított számlák (sztornózottak, módosító és sztornó
számlák is; piszkozat és díjbekérő nem) adatait egy új mappába exportálja:
`export/adohatosagi-ellenorzes_<tartomány>_<időbélyeg>/`.
- `szamlak.xml` – a rendelet 3. melléklete szerinti XML (`http://schemas.nav.gov.hu/2013/szamla`), a
  magánszemély vevő nevével és címével együtt. A fejléc kezdő és záró sorszáma (`kezdo_szla_szam`,
  `zaro_szla_szam`) mindig sorszám (akkor is, ha a határt azonosítóval adták meg); a nem kért
  fejlécadatok (sorszámok, illetve dátumok) az exportált számlákból származnak;
- `nav-osa/<fájlnév>.xml` – számlánként a NAV Online Számla v3.0 adatszerkezete;
- `pdf/<fájlnév>.pdf` – a számlák kiállításkor megőrzött eredeti PDF-je, bájtra pontosan (6.14; a
  fájlnév szabálya is ott). Az eredeti PDF-ek megőrzése előtt kiállított bizonylatnál – amelynek nincs
  megőrzött eredetije – a futó változattal újra előállított PDF, `pdf/<fájlnév>_UJRAELOALLITOTT.pdf`
  néven, megjegyzéssel (lásd alább);
- `OLVASSEL.txt` – az adózó, a program neve, verziója és azonosítója, az export napja, az időszak vagy
  sorszámtartomány, a számlák száma, a tartalom leírása és a **megjegyzések**.

Megjegyzés (`warnings` és az OLVASSEL.txt „Megjegyzések” része) keletkezik, ha egy szöveget a séma
100 karakteres határa miatt rövidíteni kellett, ha egy 4 karakternél rövidebb irányítószámot ki kellett
egészíteni, ha egy bizonylat nem írható a 3. melléklet szerinti sémába (kimarad a `szamlak.xml`-ből és a
darabszámból: „A számla kimaradt a szamlak.xml-ből …”), ha egy NAV-XML (`nav-osa`) vagy PDF (`pdf`)
nem állítható elő, ha egy PDF újra előállított (`pdf`: „Az eredeti PDF nincs megőrizve, mert a
bizonylat az eredeti PDF-ek megőrzése előtt készült: a pdf/<fájlnév>_UJRAELOALLITOTT.pdf a program
jelenlegi változatával újra előállított kép, nem bájtra azonos a vevőnek átadott PDF-fel.”; ilyenkor az
OLVASSEL.txt tartalomleírása is megnevezi az `_UJRAELOALLITOTT.pdf` végű fájlokat, és az
`export.tax_audit` naplóbejegyzés felsorolja a sorszámukat), és ha egy fájl neve a sorszámtól eltér
(`file`). Ha egy bizonylatnak még nincs megőrzött eredetije (a PDF-je a kiállításkor nem készült el),
az export elkészíti és megőrzi (6.14; ha ekkor az adatkönyvtár `pdf/<fájlnév>.pdf` fájlja egy másik
bizonylaté, azt `…_KORABBI_<ééééhhnn-óóppmm>.pdf` néven megőrzi, és a megjegyzések között megnevezi). A
sérült vagy módosult – a lenyomatával nem egyező – megőrzött eredetit az export nem másolja a `pdf/`
mappába, hanem megjegyzésként jelzi (`pdf`: „Az export nem tartalmazza a PDF-jét: A(z) <sorszám>
megőrzött eredeti PDF-je sérült vagy módosult … Futtasd az openszamla verify parancsot, és állítsd vissza
az adatbázist a legutóbbi ép mentésből …”, 6.14). Egy-egy hibás bizonylat nem
szakítja meg az exportot; hiba (SZAMLA2013_DATA_INVALID) csak akkor van, ha a tartomány egyetlen
számlája sem írható a sémába, és NO_INVOICES, ha a tartományban nincs kiállított számla.

Eredmény: `summary` („N számla exportálva: <mappa>”, megjegyzéseknél „– K megjegyzés (lásd warnings és
OLVASSEL.txt)”), `path`, `count` (a `szamlak.xml`-ben szereplő számlák száma), `rangeFrom`, `rangeTo`,
`numberFrom`, `numberTo`, `warnings`. A NAV ellenőrzés esetén ezt a mappát kell rendelkezésre
bocsátani. Parancssorból: `openszamla adohatosagi-export --from 2026-01-01 --to 2026-12-31` vagy
`--from-number SZ-2026-00001 --to-number SZ-2026-00120`.

**Időigény, nagy tartományok:** a megőrzött eredeti PDF-ű bizonylat bizonylatonként kb. 1 ms alatt
kerül az exportba (5 000 bizonylat: kb. 3 másodperc). Ahol a PDF-et elő kell állítani – az eredeti
PDF-ek megőrzése előtt kiállított bizonylatnál, vagy ha egy bizonylat eredetije még nincs megőrizve –,
bizonylatonként kb. 20–25 ms (5 000 ilyen bizonylat: 2 perc körül); ezeket a program egyszerre
legfeljebb négyesével készíti, miközben a következő bizonylatokat írja. Ha a kérés `progressToken`-t
tartalmaz, a program `notifications/progress` értesítéseket küld: az elején (0), közben legfeljebb
másodpercenként egyet és a végén, „Adóhatósági export: <kész> / <összes> bizonylat kész.” üzenettel,
így az ezt figyelő MCP-kliens (pl. a TypeScript SDK `resetTimeoutOnProgress` beállításával) nem szakítja
meg a hosszú hívást. Sok MCP-kliens a választ nem kapó hívást kb. 60 másodperc után feladja; az export
ettől még befejeződik, és a mappája elkészül – ilyenkor ne indítsd újra, mert egy második, teljes export
indulna. Nagyon nagy tartományt (több ezer előállítandó PDF) havonként (hívásonként egy hónap) vagy
parancssorból érdemes exportálni (`openszamla adohatosagi-export`, 7.6: annak nincs időkorlátja); ezt az
eszköz leírása is mondja.

### 6.20 `audit_log` – auditnapló (csak olvas)
A program minden adatváltoztató műveletét (ki – MCP, parancssor, web, rendszer –, mit, mikor)
hash-láncolt, csak bővíthető naplóban rögzíti; ez az eszköz listázza, a legújabb elöl. Paraméterek:
`entityId` (csak egy számla, vevő, termék vagy sorszámtartomány bejegyzései), `limit` (alapértelmezés
50, legfeljebb 100), `offset`. Eredmény: `total`, `entries` (`id`, `at`, `actor`, `action`,
`entityType`, `entityId`, `details`).

Műveletek: `seller.create`, `seller.update`, `settings.defaults`, `series.create` (a kezdő sorszámmal és
az évenkénti újrakezdés beállításával),
`series.update`, `customer.create`, `customer.update` (a módosított mezők nevével), `product.create`,
`product.update`, `invoice.draft.create`, `invoice.draft.update` (a módosított mezők nevével; a
piszkozat vevők közül valónak jelölésénél – 6.7 – szereplő: rendszer), `invoice.draft.delete`,
`invoice.correction.draft`, `invoice.storno.draft`, `invoice.issue` (sorszám, típus, vevő, összeg,
tartalmi hash, sorszámtartomány, sorszámláló, év, a megerősítés lenyomata), `proforma.cancel`,
`invoice.payment` (sorszám, összeg, dátum, fizetési állapot; a díjbekérőről átvett befizetésnél a
díjbekérő sorszáma és azonosítója – a díjbekérő befizetései együtt, az összegükkel és az utolsó dátummal –,
a kiállításkori befizetésnél `markPaid`; a befizetési napló sorai erre a bejegyzésre hivatkoznak, 6.13),
`payment.ledger` (a korábbi változattal rögzített befizetések egyszeri átvétele a befizetési naplóba: az
átvett bejegyzések és az újraszámolt láncok száma; szereplő: rendszer – 6.13), `invoice.payment.status`
(egy számla és módosító számlái együttes rendezése miatt megváltozott fizetési állapot – 6.13 –: sorszám,
új és korábbi állapot, hátralék, a kiváltó bizonylat sorszáma), `nav.submit`, `nav.submit.error`,
`nav.submit.uncertain`, `nav.result`,
`nav.reconcile`, `export` (a dátumalappal és a kihagyott sorszámokkal, a befizetési naplónál `ledger`), `export.tax_audit` (az
újra előállított PDF-ek sorszámával, ha volt ilyen), `invoice.document` (a kiállított bizonylat
eredeti PDF-jének megőrzése: sorszám, fajta, SHA-256 és SHA3-512 lenyomat, méret, az előállító program
neve és verziója – 6.14), `invoice.pdf_regenerated` (az eredeti PDF-ek megőrzése előtt kiállított
bizonylat újra előállított PDF-fájljának megírása: sorszám, fájlnév, SHA-256, méret, program). A napló
titkot nem tartalmaz; a láncot az `openszamla verify` ellenőrzi (7.7).

### 6.21 Erőforrások és promptok
Erőforrások (csak olvashatók):
- `openszamla://setup` – a `setup_status` adatai (az ÁFA-kódok, egységek, mai nap és megerősítési mód
  nélkül);
- `openszamla://vat-codes` – az összes ÁFA-kód: kulcs, NAV-megfeleltetés, kötelező szöveges megjelölés;
- `openszamla://invoices/{id}` – egy bizonylat adatai JSON-ban (a listázás a legutóbbi 50 kiállított
  vagy sztornózott bizonylatot adja);
- `openszamla://invoices/{id}/pdf` – a bizonylat PDF-je, mint az `invoice_pdf` (6.14): kiállított
  bizonylatnál a megőrzött eredeti, bájtra pontosan (a fajtáját és a lenyomatát az `invoice_pdf` adja
  meg), az eredeti PDF-ek megőrzése előtt kiállítottnál az újra előállított, piszkozatnál a tervezet;
- `openszamla://customers/{id}` – egy vevő adatai (a listázás legfeljebb 100 vevőt ad).

Nem létező azonosító olvasása „resource not found” hibát ad (JSON-RPC `-32602`, a `data.uri` a kért
cím, az üzenet pl. „Számla nem található: …”). Ha a lista változik – vevő mentése (`customer_save`,
`taxpayer_lookup` mentéssel, `invoice_draft` `saveCustomer`-rel), kiállítás, sztornó –, a stdio-szerver
(`openszamla mcp`) `notifications/resources/list_changed` értesítést küld (a 2026-07-28-as
protokollnál a kliens `subscriptions/listen` csatornáján). A HTTP-végpont (`openszamla serve`) minden
kéréshez új szervert indít, ezért ilyen értesítést nem küld, és a `resources.listChanged` képességet
sem hirdeti.

Promptok – előre megírt munkamenet-utasítások az ügynöknek; önmagukban nem hajtanak végre műveletet:
- `szamla_kiallitas` (`vevo`, `tetelek` – elhagyhatók): végigvezet egy számla kiállításán (állapot,
  vevő, piszkozat, előnézet és kifejezett jóváhagyás, kiállítás, sorszám, PDF, NAV-állapot);
- `havi_zaras` (`honap` ÉÉÉÉ-HH alakban, alapértelmezés: az előző hónap): havi összesítő a
  könyvelőnek – `report_summary` a teljesítés dátuma szerint (`dateBasis: "fulfillment"`, és ezt a
  válaszban jelezni kell; pénzforgalmi elszámolású eladónál azt is, hogy ez nem a bevallandó adó, mert
  az a befizetéskor esedékes – 6.17 –, és ilyenkor a befizetés dátuma szerinti összesítést is le kell
  kérni, `dateBasis: "payment"`), lejárt számlák, NAV-problémák, CSV-export ugyanígy a teljesítés
  dátuma szerint (pénzforgalmi elszámolású eladónál a hónap befizetési naplója is, `ledger: true`);
- `nav_hibaelharitas`: megkeresi a nem vagy hibásan jelentett számlákat, elmagyarázza a NAV
  üzeneteit, és a 6.15 szerinti javítást javasolja (elutasított jelentésnél az ok elhárítása és
  ugyanannak a számlának az újraküldése – nem sztornó és új számla).

A Claude Desktop-bővítmény mindhárom promptot ugyanezzel a szöveggel kínálja fel.

### 6.22 `backup_create` / `verify_integrity` – mentés és ellenőrzés
- **`backup_create`** (paraméter nélkül): az adatbázis konzisztens másolata – minden bizonylat a megőrzött
  eredeti PDF-jével, a vevők, a termékek, a beállítások és az auditnapló – az adatkönyvtár `backups`
  mappájába, `openszamla_<éééé-hh-nn_óóppmm>.db` néven (azonos másodpercben készült másodiknál `_2`
  végződéssel; meglévő fájlt nem ír felül). A helyet a hívó nem választhatja meg (ismeretlen paraméter:
  hiba). Visszaadja: `path`, `bytes`, `auditHead` (az auditnapló utolsó bejegyzése, 7.7) és az
  összefoglalót: „Mentés elkészült: <útvonal> (N MB). Másold a gépen kívülre is (pendrive, felhő);
  visszaállítani az „openszamla restore <mentésfájl>” paranccsal kell.” Adatot nem módosít, a naplóba nem
  ír. A `nav-credentials.json` és a `http-token` nincs a mentésben (7.8).
- **`verify_integrity`** (paraméter nélkül, csak olvas): az `openszamla verify` (7.7) ellenőrzése.
  Visszaadja: `ok`, `invoicesChecked`, `invoiceMismatches`, `auditMismatches`, `unauditedInvoices`,
  `numberingGaps`, `alteredTriggers`, `paymentMismatches`, `documentsChecked`, `documentMismatches`,
  `warnings` (nem hibák: a megőrzött PDF nélküli bizonylatok és a mentés-visszaállítások
  figyelmeztetései, 7.14), `notes`, `legacyDocuments`, `audit` (a lánc állapota és utolsó bejegyzése).
  Összefoglaló: „Ellenőrzés: rendben – N bizonylat, M naplóbejegyzés, K megőrzött eredeti PDF.”, eltérésnél
  „Ellenőrzés: ELTÉRÉST TALÁLT (N) – az adatbázist a programon kívül módosíthatták. …” – az ügynök ilyenkor
  elmondja a felhasználónak, mit talált az ellenőrzés, ép mentés visszaállítását és könyvelői segítséget
  javasol, a kiállított bizonylatokat nem próbálja „javítani”.

## 7. Parancssor

| Parancs | Funkció |
|---|---|
| `openszamla` | terminálban rövid üdvözlő szöveg az első lépésekkel, egyébként a súgó (3.1) |
| `openszamla setup [--client <kliensek>] [--force]` | első beállítás lépésenként: futtatókörnyezet, adatkönyvtár, eladó, NAV, AI-kliensek, skill (7.11) |
| `openszamla doctor [--nav]` | a telepítés és a beállítások ellenőrzése, javítási tippekkel (7.12) |
| `openszamla mcp` | MCP szerver stdio-n (3.2: az adatkönyvtár kiírása a hibakimenetre) |
| `openszamla serve [--host <cím>] [--port <port>] [--token <token>]` | MCP Streamable HTTP és webes felület (8. fejezet); leállítás: Ctrl+C vagy az ablak bezárása – a program ilyenkor lezárja az adatbázist |
| `openszamla init` | eladói adatok interaktív megadása (7.2) |
| `openszamla nav-setup [--env test\|production]` | NAV technikai felhasználó adatainak mentése és a kapcsolat tesztelése (7.3) |
| `openszamla nav-send-to-configured-environment <sorszám\|id> [--confirm]` | a másik NAV-rendszerhez tartozó számla beküldése a beállított rendszerbe, mint `nav_send_to_configured_environment`; `--confirm` nélkül csak kiírja, mit jelentene (7.13) |
| `openszamla status` | állapot, mint `setup_status` (7.4) |
| `openszamla list [--from ÉÉÉÉ-HH-NN] [--to ÉÉÉÉ-HH-NN] [--limit N]` | bizonylatok listája (7.5) |
| `openszamla show <sorszám\|id>` | bizonylat részletei (7.5) |
| `openszamla pdf <sorszám\|id> [--out <mappa>]` | a bizonylat PDF-je (kiállítottnál a megőrzött eredeti) / másolása (7.5) |
| `openszamla export --from … --to … [--format csv\|json\|xml] [--date-basis issue\|fulfillment]` | export, mint `export_invoices` (7.6) |
| `openszamla adohatosagi-export --from … --to …` vagy `--from-number … --to-number …` | adóhatósági ellenőrzési adatszolgáltatás, mint `tax_audit_export` (7.6) |
| `openszamla verify` | számla-hash-ek, auditlánc, sorszámfolytonosság, megőrzött eredeti PDF-ek és adatbázis-védelmek ellenőrzése (7.7) |
| `openszamla backup <fájl>` | az adatbázis konzisztens másolata (7.8) |
| `openszamla restore <mentésfájl> [--confirm]` | mentés visszaállítása az adatbázis helyére; `--confirm` nélkül csak kiírja, mi történne; a jelenlegi adatbázist félreteszi, nem törli (7.14) |
| `openszamla config <kliens> [--write [--force]]` | MCP-kliens konfiguráció kiírása; `--write`: beírása a kliens saját beállításába, biztonsági másolattal (7.9) |
| `openszamla install-skill claude\|codex` | az ügynöki skill bemásolása a kliens skill-mappájába (7.10) |
| `openszamla help`, `-h`, `--help`; `-v`, `--version` | súgó; verziószám |

### 7.1 Közös szabályok
- `--data-dir <mappa>`: az adatkönyvtár (3.2), minden parancsnál; üres értéke „nincs megadva”.
- Windows PowerShellben (a Terminál alapértelmezése) a parancsot `.cmd` végződéssel kell írni
  (`openszamla.cmd setup`, `openszamla.cmd doctor` …), ha a Windows alapbeállítása tiltja a parancsfájlok
  futtatását: a végződés nélküli `openszamla` ott az npm `.ps1` indítóját futtatná, és „… cannot be loaded
  because running scripts is disabled on this system” hibát adna (3.1, 3.6). A Parancssorban (`cmd`), macOS-en
  és Linuxon a végződés nélküli parancs működik.
- Minden parancs csak a fenti táblázatban és az alfejezetekben felsorolt kapcsolóit és argumentumait
  fogadja el (mindegyiknél: `--data-dir`, `-h`/`--help`, `-v`/`--version`). Ha a parancssorban
  ismeretlen (pl. elírt) kapcsoló, az adott parancsnál nem használható kapcsoló, érték nélküli kapcsoló
  (pl. a sor végén álló `--data-dir`), értéket kapó jelző (`--help=…`) vagy fölösleges argumentum van, a
  program semmit nem csinál, és INVALID_INPUT hibával (kilépési kód 1) jelzi: „Ismeretlen kapcsoló:
  --datadir”, „A(z) --out kapcsoló a(z) list parancsnál nem használható.”, „A(z) --data-dir kapcsoló
  után hiányzik az érték: --data-dir <érték>”, „A(z) --help kapcsoló nem kap értéket.”, illetve
  „Fölösleges argumentum: …”; a javaslat a parancs kapcsolóit sorolja fel. Kötőjellel kezdődő érték
  egyenlőségjellel adható meg (`--data-dir=-mappa`).
- A kérdéseket és a figyelmeztetéseket a program a hibakimenetre (stderr) írja, az eredményt a
  szabványos kimenetre (stdout) – kivéve a `setup`-ot, amely a teljes párbeszédét (kérdéseit is) a
  szabványos kimenetre írja (7.11).
- Hibánál a hibakimenetre „Hiba [<KÓD>]: <üzenet>” és „Tipp: <javaslat>” kerül, a kilépési kód 1;
  csak előre nem látott hibánál jelenik meg „Hiba: …” után a hiba technikai részlete (hibabejelentéshez).
  Ismeretlen parancsnál „Ismeretlen parancs: …” és a súgó, kilépési kód 1 (az adatkönyvtárat ilyenkor
  nem hozza létre). A `verify` eltérésnél 2-vel lép ki (7.7), a `setup` 1-gyel, ha valamelyik lépése
  hibával zárult (7.11), a `doctor` 1-gyel, ha a használatot akadályozó hibát talált (7.12), a
  `nav-send-to-configured-environment` 1-gyel, ha a beállított NAV-rendszer nem fogadta be és nem is
  dolgozza fel a számlát (7.13); minden más sikeres futás 0.

### 7.2 `openszamla init`
Rákérdez: cégnév / egyéni vállalkozó neve, adószám, irányítószám, település, utca és házszám,
bankszámlaszám (üresen hagyható), alanyi adómentesség (i/n), e-mail (üresen hagyható). A meglévő
értékeket alapértelmezésként felkínálja (üres válasz = az alapértelmezés). Mentés mint
`seller_update` (ország: HU); kiírja: „Mentve: <név> (<adószám>)” és az adatok hibáit,
figyelmeztetéseit. A válaszok csővezetéken is megadhatók, soronként egy. Terminálon az előre – még a
kérdés megjelenése előtt – begépelt szöveg (pl. egyszerre beillesztett több válasz) gépeléskor nem jelenik
meg; a soron következő kérdés után, annak válaszaként látszik. Ha a bemenet hamarabb ér
véget: INPUT_ENDED („A bemenet véget ért, mielőtt minden kérdésre válasz érkezett.”), Ctrl+C esetén
CANCELLED („Megszakítva (Ctrl+C) – semmi nem lett mentve.”); egyik esetben sem ment semmit.

### 7.3 `openszamla nav-setup [--env test|production] [--data-dir <mappa>]`
- A kérdések előtt kiírja, hol hozható létre a technikai felhasználó (az Online Számla teszt –
  https://onlineszamla-test.nav.gov.hu – és éles – https://onlineszamla.nav.gov.hu – felületén, a NAV
  Felhasználókezelőben, a kulcsgenerálással; a NAV útmutatója: https://onlineszamla.nav.gov.hu/dokumentaciok,
  Online Számla felhasználói kézikönyv), és hogy az adatokat melyik fájlba menti.
- Rákérdez a környezetre (ha nincs `--env`; elfogadott: `test` / `teszt`, `production` / `prod` /
  `éles` / `eles`), majd a login névre, a jelszóra, az XML aláírókulcsra és az XML cserekulcsra. A
  környezetet a titkok előtt ellenőrzi: ismeretlen értéknél „Ismeretlen NAV környezet: …”
  (INVALID_CONFIG), és nem ment semmit; mentéskor `test` vagy `production` alakra hozza.
- Terminálon a jelszó és a két kulcs **gépelés közben sem jelenik meg** (a kérdés végén: „(a beírt
  szöveg nem jelenik meg)”); a login név látszik. Az előre begépelt szöveg sem jelenik meg (7.2); a titkos
  adat kérdése előtt a program elveti a kérdés előtt begépelt, még fel nem dolgozott bevitelt (pl. a login
  névvel együtt beillesztett jelszót), és kiírja: „(A kérdés előtt beírt szöveget a program elvetette – a
  titkos adatot a kérdés után írd be.)” – a titkos adat mindig a saját kérdése után begépelt szöveg, így
  soha nem jelenik meg a képernyőn. A válaszok csővezetéken is megadhatók, soronként egy (ilyenkor
  semmi nem vész el); INPUT_ENDED és CANCELLED mint 7.2.
- Mentés előtt ellenőriz: minden mező kötelező („Minden mező kitöltése kötelező.”), a login név 6–15
  betű vagy szám, az XML cserekulcs pontosan 16 karakter. Hibás adatnál: „Hiba [INVALID_INPUT] A
  megadott NAV adatok hibásak, nem mentettem el őket: …”, és nem ment semmit.
- Az adatokat az adatkönyvtár `nav-credentials.json` fájljába menti (Linuxon és macOS-en `0600`
  jogosultsággal; Windowson ilyen jogosultság nem állítható, ott a fájlt az adatkönyvtár helye – az
  alapértelmezett a felhasználói profilban van – védi); a korábbi fájlt – a hibásat, sérültet is –
  felülírja. Az ezzel az adatkönyvtárral futó MCP-szerver és `openszamla serve` a mentett adatokat a
  következő műveletnél, újraindítás nélkül átveszi (3.4).
- Mentés után: ha `OPENSZAMLA_NAV_*` környezeti változók felülírják a mentett beállítást, figyelmeztet
  („Figyelem: a környezeti változók (OPENSZAMLA_NAV_*) felülírják a most mentett beállítást – a
  program … a(z) <környezet> környezetet használja.”); ha a ténylegesen érvényes beállítás így sem
  használható (pl. hibás `OPENSZAMLA_SOFTWARE_ID`), kiírja: „Mentve, de a NAV-kapcsolat így sem
  használható: …”, és 1-es kóddal lép ki. Ha az eladó adószáma még hiányzik: „Mentve. Az eladói
  adatok (adószám) még hiányoznak, ezért a kapcsolatot most nem tudom tesztelni: openszamla init”.
  Egyébként teszteli a kapcsolatot (`tokenExchange`): „Mentve, és a NAV ÉLES|TESZT kapcsolat működik
  (tokenExchange OK).”; sikertelen tesztnél a NAV hibáját írja ki (1-es kód), a mentett adatok
  megmaradnak.

### 7.4 `openszamla status`
Kiírja: verzió, adatkönyvtár, eladó („NINCS BEÁLLÍTVA”, ha hiányzik), NAV-sor – „NAV: <környezet>
(<forrás>)”, hibás beállításnál „NAV: HIBÁS BEÁLLÍTÁS (<környezet>, <forrás>) – <ok>”, beállítás nélkül
„NAV: nincs beállítva” –, a darabszámok (kiállított, piszkozat, kifizetetlen kintlévőség, NAV függő,
NAV hiba), a teendők (6.1) és soronként a megjegyzések („  Megjegyzés: <szöveg>”, pl. pénzforgalmi
elszámolásnál, 6.1). Ha van teendő, alatta egy sor megmondja, hogy a teendőkben zárójelben álló nevek
(pl. `seller_update`, `nav_sync`) az AI-kliens eszközei, és mi a megfelelőjük: „Parancssorban:
openszamla init – eladó; openszamla nav-setup – NAV; a NAV-szinkron és a többi művelet a webes
felületen is elérhető: openszamla serve.”

### 7.5 `list`, `show`, `pdf`
- `list`: a bizonylatok (piszkozatok is) kelte szerint csökkenő sorrendben – sorszám (piszkozatnál
  azonosító), kelte, állapot, vevő, bruttó, NAV-állapot –, végül „(megjelenített/összes)”. Az állapot
  és a NAV-állapot szövegesen, a webes felület megnevezéseivel szerepel (pl. „kiállított”, „piszkozat”,
  „sztornózott”; „NAV: rendben”, „NAV: nincs beállítva”), nem a belső kódokkal. `--from`,
  `--to`: kelte szerinti szűrés (a `--from` nem lehet későbbi a `--to`-nál: INVALID_INPUT, mint 6.8);
  `--limit`: legfeljebb ennyi sor (alapértelmezés 20).
- `show <sorszám|id>`: a bizonylat minden adata JSON-ban; piszkozatnál az előnézet (6.7) a hibákkal és
  a kiállíthatósággal.
- `pdf <sorszám|id>`: a bizonylat PDF-je, mint az `invoice_pdf` (6.14) – kiállított bizonylatnál a
  megőrzött eredeti, piszkozatnál a tervezet. Kiírja a helyét, a következő sorban a fajtáját (a `note`
  szövegét, pl. „A kiállításkor készült és bájtra pontosan megőrzött eredeti PDF.”), eredetinél még egy
  sorban a lenyomatát: „SHA-256: <lenyomat>”. Sérült vagy módosult megőrzött eredetinél semmit nem ír
  ki és nem ír felül: „Hiba [DOCUMENT_INTEGRITY_FAILED]: …” (6.14), kilépési kód 1. `--out <mappa>`: a PDF-et egy létező helyi mappába is
  másolja (relatív mappát a munkakönyvtárhoz képest értelmez; szabályai mint a `copyToDir`-é), és első
  sorban a másolat helyét írja ki.

### 7.6 `export`, `adohatosagi-export`
- `export --from ÉÉÉÉ-HH-NN --to ÉÉÉÉ-HH-NN [--format csv|json|xml] [--date-basis issue|fulfillment|payment] [--ledger]`:
  mint `export_invoices` (6.18; `--ledger`: az időszak befizetési naplója, `ledger: true`). A `--format`
  alapértelmezése `csv`; ismeretlen értéknél (pl. elgépelt „cvs”) nem készül export: „Ismeretlen
  exportformátum: …” (INVALID_INPUT, javaslat: csv, json vagy xml). Ismeretlen `--date-basis`: „Ismeretlen
  dátumalap: …”. Kiírja: „N számla (kelte szerint | teljesítés dátuma szerint | befizetés dátuma szerint) →
  <útvonal>” – a befizetési naplónál „N befizetés (befizetési napló, a befizetés dátuma szerint) →
  <útvonal>” –, soronként a megjegyzéseket („  megjegyzés – <sorszám>
  (<mező>): <üzenet>”), majd az export egészére vonatkozó figyelmeztetéseket („  figyelem – <szöveg>”,
  pl. pénzforgalmi elszámolásnál vagy teljesítési dátumot javító módosításnál, 6.17, 6.18).
- `adohatosagi-export --from … --to …` vagy `--from-number <sorszám> --to-number <sorszám>`: mint
  `tax_audit_export` (6.19). Kiírja: „Adóhatósági ellenőrzési adatszolgáltatás: N számla → <mappa>” és
  a megjegyzéseket. Nincs időkorlátja, ezért egy nagy – pl. több ezer bizonylatos, egész éves –
  tartomány exportjára ez a javasolt mód (6.19).

### 7.7 `openszamla verify`
Ellenőrzi és kiírja:
- „Adatbázis: <útvonal>” – az ellenőrzött adatbázisfájl;
- „Ellenőrzött számlák: N, eltérés: …” – minden kiállított bizonylat tartalmi hash-ét újraszámolja;
- „Auditnapló: rendben | SÉRÜLT (id …) (N bejegyzés)” – az auditnapló hash-láncát;
- „Megőrzött eredeti PDF-ek: N” – a megőrzött eredeti PDF-ek (6.14) száma: mindegyik tartalmát
  összeveti a vele tárolt SHA-256 és SHA3-512 lenyomattal és mérettel, valamint az `invoice.document`
  naplóbejegyzéssel;
- „A naplóval ellentmondó bizonylatok” – a naplóban rögzített kiállítás, amelynek bizonylata hiányzik
  az adatbázisból, más sorszámmal szerepel, vagy a tartalmi hash-e eltér a kiállításkor naplózottól (a
  tartalmi hash-t ez a változat naplózza);
- „Naplózatlan (a programon kívül felvett) bizonylatok”;
- „Sorszámhézagok” – sorszámtartományonként és azon belül számozási szakaszonként: a tartomány
  története (a naplóban a kiállítások éve és az évenkénti újrakezdés be- és kikapcsolásai, 6.3) szerint
  minden évenkénti újrakezdés új szakaszt nyit, kikapcsolt újrakezdésnél a sorszámozás az új évben is
  ugyanabban a szakaszban folytatódik. Egy szakasz sorszámainak hézag nélkül kell követniük egymást a
  kezdő sorszámtól (a tartomány kezdő sorszáma, újrakezdés után 1) a szakasz utolsó naplózott
  sorszámáig, az aktuális szakaszban a tartomány által utoljára kiadott sorszámig. A hiányzó sorszámot
  teljes alakjában írja ki („Számlák: hiányzik a(z) SZ-2026-00002 sorszám.”); ha a hézag két év között
  van, a szomszédos sorszámokkal („… hiányzik a(z) 4. sorszám a(z) SZ-2027-00003 és a(z) SZ-2028-00005
  között.”). Ha a következő kiadandó sorszám a már kiadottak mögé esik: „a következő kiadandó sorszám
  (…) nem követi a már kiadott … sorszámot”. A régebbi változattal naplózott kiállítást tartalmazó
  tartományt nem vizsgálja; ahol a létrehozáskor az évenkénti újrakezdés beállítása nem került a
  naplóba (régebbi változat), ott az első átkapcsolás előtti időszakban az új évben a korábbinál nem
  nagyobb sorszám számít újrakezdésnek;
- „Hiányzó vagy módosított adatbázis-védelmek (triggerek)”;
- „A befizetési naplóval ellentmondó befizetett összegek” – az a bizonylat, amelynek befizetett összege
  nem egyezik azzal, amit a csak bővíthető befizetési napló (6.13) rá juttatott: „<sorszám>: a bizonylat
  befizetett összege (…) eltér a befizetési naplóban rá jutó összegtől (…).” A befizetett összeg és a
  fizetési állapot a bizonylat változó adata (nem része a tartalmi hash-nek), így egy adatbázis-eszközzel
  átírt „kifizetve” jelölés csak ebből az összevetésből látszik;
- „A megőrzött eredeti PDF-ekkel ellentmondó adatok” – a megőrzött eredeti, amelynek tartalma nem
  egyezik a vele tárolt lenyomattal („<sorszám>: a megőrzött eredeti PDF tartalma nem egyezik a vele
  tárolt lenyomattal (SHA-256, SHA3-512, méret).”), amelynek lenyomata eltér a megőrzéskor naplózottól
  („… lenyomata eltér a megőrzéskor naplózottól.” – pl. a tartalmat a lenyomattal együtt írták át, vagy
  az eredetit kicserélték), amelynek megőrzése nincs naplózva („… megőrzése nincs naplózva
  (invoice.document).”), és a naplózott megőrzés, amelynek eredetije hiányzik („<sorszám>: az eredeti
  PDF megőrzése naplózva van (#…), de a megőrzött PDF hiányzik az adatbázisból.”);
- az eredményt nem befolyásoló sorok: mentés visszaállítása után „Figyelmeztetés: <dátum>: mentés
  visszaállítása (naplóbejegyzés #N) – a mentés után kiállított N bizonylat (…) nincs az adatbázisban. A
  félretett adatbázisban megvannak: …” (7.14 – az így hiányzó sorszámok nem számítanak sorszámhézagnak);
  „Figyelmeztetés: <sorszám>: nincs megőrzött eredeti PDF-je (a
  kiállításkor nem készült el, és azóta nem kérték le). Kérd le a PDF-jét (invoice_pdf, openszamla pdf
  vagy a webes „PDF letöltése”): a program akkor elkészíti és megőrzi.”; „Megjegyzés: <sorszám>: a
  pdf/<fájlnév>.pdf fájl hiányzik – a következő PDF-kéréskor a program a megőrzött eredetiből újra
  kiírja.”, illetve „… fájl eltér a megőrzött eredetitől – a következő PDF-kéréskor a program a
  megőrzött eredetivel felülírja.”; ha maga a megőrzött eredeti sérült (a fenti eltérések egyike), ezt
  nem ígéri: „<sorszám>: a pdf/<fájlnév>.pdf fájl hiányzik; a sérült megőrzött eredetiből a program nem
  írja ki újra.”, illetve „… fájl eltér a megőrzött eredetitől, amely sérült: a program nem írja felül
  vele – ha a fájl a kiállításkor átadott PDF, őrizd meg.”; ha vannak az eredeti PDF-ek megőrzése előtt kiállított bizonylatok:
  „Megjegyzés: N bizonylat az eredeti PDF-ek megőrzése előtt készült; ezek PDF-jét kérésre a program
  újra előállítja (_UJRAELOALLITOTT.pdf végű fájl), ez nem az eredeti.”;
- „Az auditnapló utolsó bejegyzése: #<sorszám> <hash> – őrizd meg a mentéssel együtt.”;
- végül „Eredmény: rendben.” (kilépési kód 0) vagy „Eredmény: ELTÉRÉST TALÁLT – az adatbázist a
  programon kívül módosíthatták.” (kilépési kód 2). A figyelmeztetések és a megjegyzések nem eltérések:
  ezekkel az eredmény rendben (kilépési kód 0).

### 7.8 `openszamla backup <fájl>`
Az adatbázis konzisztens másolata a megadott fájlba (relatív útvonalat a munkakönyvtárhoz képest
értelmez); kiírja: „Mentve: <adatbázis> → <fájl>”. Meglévő fájlt nem ír felül (BACKUP_EXISTS).
Windowson a fájl- és mappanevekben – a meghajtó betűjelét (`C:`) és a `\\gép\megosztás\`, illetve
`\\?\` kezdetet nem számítva – nem állhat `:`, `*`, `?`, `"`, `<`, `>`, `|` és vezérlőkarakter: ilyen
névnél a program semmit nem ír, és INVALID_INPUT hibával jelzi („A mentés útvonalában Windowson nem
állhat kettőspont (:): …”, javaslat: pl. `mentes_2026-11-08_1430.db`) – kettősponttal a mentés egy üres
fájl rejtett adatfolyamába kerülne, amit a fájl másolása vagy tömörítése elhagy. Ha a mentés után a
fájl hiányzik vagy üres, a program az üres fájlt törli, és BACKUP_FAILED hibát ad („A mentés nem jött
létre, vagy üres maradt: …”). A mentés az adatbázist tartalmazza, benne a kiállított bizonylatok
megőrzött eredeti PDF-jével (6.14): a `pdf/` mappát nem kell külön menteni – egy másik adatkönyvtárba
visszaállított mentésből a program a PDF-kéréskor az eredetit írja ki, bájtra pontosan. A
`nav-credentials.json` és a `http-token` nincs benne. Visszaállítás: `openszamla restore` (7.14) – a
mentést ne kézzel másold az adatbázis helyére.

### 7.9 `openszamla config <kliens> [--data-dir <mappa>] [--write [--force]]`
**Kiírás** (`--write` nélkül): a bemásolható MCP-konfiguráció; nem változtat semmit. Kliensek:
`claude-code`, `claude-desktop`, `codex`, `vscode`, `cursor`, `http`. Ismeretlen kliens: INVALID_INPUT.
- A szerver indítóparancsa a Node.js és a telepített program indítófájljának (`…/openszamla/dist/cli/main.js`)
  **abszolút útvonala**, utána az `mcp` argumentum: így a kliens parancsértelmező (shell) és PATH nélkül
  is elindítja – Windowson az `openszamla` és az `npx` parancsértelmezőt igénylő `.cmd` fájl, macOS-en
  az asztali alkalmazások nem látják a terminál PATH-ját. A Node.js a futó Node.js; ha ugyanez a fájl a
  PATH-on más néven is elérhető (pl. Homebrew: `/opt/homebrew/bin/node` a változatszámos mappa helyett),
  azon a néven. A Node.js frissítése, áthelyezése vagy a program más helyre telepítése után az útvonal
  elavulhat: ezt az `openszamla doctor` jelzi (7.12), a javítás `openszamla config <kliens> --write
  --force`. Ha a program az npx ideiglenes mappájából fut, a kiírás figyelmeztetéssel a rövid
  `openszamla mcp` formát adja (ez a globális telepítés után működik).
- Az adatkönyvtárat akkor írja a konfigurációba (`OPENSZAMLA_HOME`), ha az eltér a beépített
  `~/.openszamla`-tól – akkor is, ha az `OPENSZAMLA_HOME`-ból jön (az asztali kliens nem látja a terminál
  változóit).
- Claude Code: `claude mcp add -e "OPENSZAMLA_HOME=<mappa>" --transport stdio --scope user openszamla --
  "<node>" "<main.js>" mcp` (a `-e` után egy másik kapcsolónak kell következnie, nem a szerver nevének),
  valamint a projekt-szintű `.mcp.json` a rövid, gépfüggetlen `openszamla mcp` paranccsal (megosztott
  projektben minden gépen kell az `openszamla` parancs). Claude Desktop: az ezen a gépen használt
  `claude_desktop_config.json` helye és a bejegyzés. Codex: `codex mcp add openszamla --env
  "OPENSZAMLA_HOME=<mappa>" -- "<node>" "<main.js>" mcp`, valamint a `config.toml` táblája – az
  útvonalak literális TOML-szövegként (`'…'`; ha az útvonalban `'` van, escape-elt TOML-szövegként), pl.
  `env = { OPENSZAMLA_HOME = '<mappa>' }`. VS Code: a munkaterület `.vscode/mcp.json` fájlja (`servers`,
  `"type": "stdio"`). Cursor: `~/.cursor/mcp.json`. HTTP: `openszamla serve --data-dir "<mappa>" --host
  127.0.0.1 --port 8787`, és a tokenfájl helye (`<mappa>/http-token`). A parancssori értékeket
  idézőjelek közé teszi.

**Beírás** (`--write`): a bejegyzést a kliens saját beállításába írja.

| Kliens | Hová |
|---|---|
| `claude-desktop` | `claude_desktop_config.json`, `mcpServers.openszamla`: Windowson `%APPDATA%\Claude\` – a Microsoft Store-ból (MSIX) telepített változatnál a gépen használt fájl: az újabb kiadások adatmappájáé (`%LOCALAPPDATA%\Claude-Data\claude_…\`), ha ott van a fájl, vagy ha a mappa nem üres, azaz az app használja (ezek a kiadások csak ezt olvassák; a fájl többi része – az app saját beállításai – változatlan marad; több ilyen mappa közül a legutóbb módosított számít; egy eltávolított kiadás után üresen maradt mappa nem számít), egyébként a régebbi kiadásoké (`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\`), ha az létezik, vagy ha a klasszikus fájl nem létezik, de ez a mappa igen; macOS-en `~/Library/Application Support/Claude/`; Linuxon `$XDG_CONFIG_HOME/Claude/` (alapértelmezés: `~/.config/Claude/`) |
| `cursor` | `~/.cursor/mcp.json`, `mcpServers.openszamla` |
| `vscode` | a munkakönyvtár – a VS Code-munkaterület – `.vscode/mcp.json` fájlja, `servers.openszamla` (`"type": "stdio"`); a saját mappádból (home) futtatva nem ír semmit (INVALID_INPUT, a javaslat a projekt mappája, illetve a felhasználói szintű beállítás: VS Code → Parancspaletta → „MCP: Open User Configuration”) |
| `codex` | `~/.codex/config.toml` (megadott `CODEX_HOME` esetén `$CODEX_HOME/config.toml`): a fájl végére egy `[mcp_servers.openszamla]` tábla (`command`, `args`, szükség esetén `env`, `startup_timeout_sec = 30`, `tool_timeout_sec = 300`), előtte a `# OpenSzámla – openszamla config codex --write, <dátum>` megjegyzéssor |
| `claude-code` | ha a `claude` parancs a PATH-on parancsértelmező nélkül indítható program (Windowson `.exe` vagy `.com`), parancsértelmező nélkül lefuttatja a `claude mcp add … --transport stdio --scope user openszamla -- …` parancsot, és kiírja a kimenetét („claude: …”); ha nincs ilyen (nincs a PATH-on, vagy csak parancsértelmezőt igénylő indító, pl. az npm `claude.cmd` fájlja), nem futtat semmit, hanem kiírja a futtatandó parancsot (kilépési kód 0). A meglévő bejegyzést a felhasználói beállításból (`~/.claude.json`, megadott `CLAUDE_CONFIG_DIR` esetén abban) olvassa |
| `http` | nem írható be (a távoli kliensben kell megadni): INVALID_INPUT |

- A fájl többi részét – a többi szervert és beállítást – megtartja. A JSON-fájlt egységes formázással
  (az eredeti behúzással és sorvégekkel) írja vissza; a `config.toml` meglévő sorait nem változtatja, a
  sorvégeket (CRLF vagy LF) és a fájl eleji bájtsorrend-jelet megtartja. Szimbolikus hivatkozásnál a
  hivatkozott fájlt írja. Hiányzó fájlt (és mappát) létrehoz.
- Módosítás előtt a meglévő fájlról **biztonsági másolatot** készít mellé: `<fájl>.bak-ÉÉÉÉHHNN-ÓÓPPMM`
  (ha már van ilyen, `-1`, `-2`… végződéssel); az új tartalmat átmeneti fájlon át, az eredeti
  jogosultságaival írja.
- Kiírja, mit változtatott: „<kliens>: létrehoztam | módosítottam – <fájl>”, a hozzáadott bejegyzést,
  hogy a fájl többi része változatlan (a többi szerver nevével), a biztonsági másolat helyét, a
  visszavonás parancsát (Windowson PowerShellben: `Copy-Item -Force '<másolat>' '<fájl>'`, új fájlnál
  `Remove-Item '<fájl>'`; macOS-en és Linuxon `cp '<másolat>' '<fájl>'`, illetve `rm '<fájl>'`; Claude
  Code-nál `claude mcp remove --scope user openszamla`) és a következő lépést (pl. a Claude Desktopból
  teljesen ki kell lépni és újraindítani – az ablak bezárása nem elég).
- Ha a bejegyzés már pontosan így szerepel: „<kliens>: már be van állítva, nem változtattam semmit –
  <fájl>” (nem ír, nem készít másolatot).
- Ha más `openszamla` bejegyzés van benne (pl. más adatkönyvtárral vagy régi útvonallal), nem írja
  felül: CLIENT_ENTRY_EXISTS (kilépési kód 1), a javaslat a `--force`-os parancs. A **`--force`**
  lecseréli a bejegyzést (a `config.toml`-ban a táblát az altábláival együtt; Claude Code-nál előbb a
  `claude mcp remove --scope user openszamla` parancsot futtatja); a régi bejegyzés a biztonsági
  másolatban marad. A meglévő bejegyzésből csak a parancsot, az argumentumok számát és a környezeti
  változók nevét írja ki – az értékeiket (pl. NAV-jelszó, token) soha.
- Nem módosít semmit, és hibával (kilépési kód 1) jelzi, ha: a fájl nem érvényes JSON
  (CLIENT_CONFIG_INVALID, mindig az első hiba sorával és oszlopával, a fájl tartalmát nem idézi; a VS Code
  megjegyzéseket megengedő fájljánál a megjegyzéseken túli első valódi hibáéval, és a javaslat sem a
  megjegyzést okolja: „… a megjegyzés és a záró vessző itt megengedett …”), vagy az
  `mcpServers` / `servers` nem objektum; a VS Code `mcp.json` fájlja megjegyzést (`//`, `/* */`) vagy
  záró vesszőt tartalmaz – a VS Code ezeket megengedi, az átírás viszont elveszítené őket
  (CLIENT_CONFIG_HAS_COMMENTS; a javaslat megadja a kézzel beírandó bejegyzést; az `openszamla doctor`
  az ilyen fájlt is érvényesként olvassa) –; a `config.toml` az `mcp_servers`-t egy sorban vagy tömbként adja
  meg, vagy az `openszamla` szervert nem táblaként (pontozott kulcsokkal, egysoros táblával) – ez utóbbit
  `--force`-szal sem cseréli (CLIENT_CONFIG_UNSUPPORTED); a fájl nem olvasható vagy nem írható
  (CLIENT_CONFIG_UNREADABLE, CLIENT_CONFIG_WRITE_FAILED); a program az npx ideiglenes mappájából fut
  (TRANSIENT_INSTALL – előbb telepítsd); a `claude` parancs hibával lép ki (CLAUDE_COMMAND_FAILED, a kézzel
  futtatandó paranccsal).
- A `--force` csak a `--write`-tal együtt használható (INVALID_INPUT).

### 7.10 `openszamla install-skill claude|codex`
A csomaggal szállított `magyar-szamlazas` skillt bemásolja a `~/.claude/skills/magyar-szamlazas`
(Claude Code), illetve a `~/.agents/skills/magyar-szamlazas` (Codex) mappába, és kiírja a helyét.

### 7.11 `openszamla setup [--client <kliensek>] [--force] [--data-dir <mappa>]`
Az első beállítás lépésenként. A teljes párbeszédét a szabványos kimenetre írja. Minden lépés
kihagyható, és a parancs újra futtatható: ami kész, azt csak ellenőrzi és kiírja. Ha az adatkönyvtár
nem a beépített `~/.openszamla`, minden kiírt parancsban szerepel a `--data-dir "<mappa>"`, és az
AI-kliensek beállításába is az kerül.
1. **Futtatókörnyezet** – a Node.js változata és helye, a szükséges legkisebb változat és a beépített
   SQLite (`node:sqlite`) működése.
2. **Adatkönyvtár** – ha nincs, létrehozza („létrehoztam: …”, különben „megvan: …”), megnyitja (ha kell,
   létrehozza) az adatbázist, és kiírja a helyét, a kiállított bizonylatok és a piszkozatok számát, mi
   kerül még ide (PDF-ek, exportok, NAV-beállítás), a mentés parancsát és hogy más mappához a `--data-dir`
   kell. Ha az adatkönyvtár OneDrive-mappában vagy hálózati helyen van, figyelmeztet („FIGYELEM – …”, a
   javaslattal: „Tipp: …”, 3.2). Nem használható adatkönyvtárnál (3.2) a beállítás hibával leáll.
3. **Eladói adatok** – kiírja a meglévőket; terminálban megkérdezi: „Megadod most?” (alapértelmezés:
   igen), illetve „Módosítod?” (alapértelmezés: nem), és az `openszamla init` kérdéseit teszi fel (7.2) a
   meglévő értékeket felkínálva. Hibás adatnál kiírja a hibát és a tippet, és felajánlja az újrapróbálást
   a beírt értékekkel.
4. **NAV Online Számla** – közérthetően elmagyarázza a NAV-adatszolgáltatást és a két NAV-rendszert: a
   TESZT (`test`) próbarendszer, az ide küldött számla nem valódi adatszolgáltatás; az ÉLES
   (`production`) a valódi adatszolgáltatás; mindkettőhöz külön regisztráció és külön technikai
   felhasználó kell (https://onlineszamla-test.nav.gov.hu, https://onlineszamla.nav.gov.hu; a NAV
   útmutatója: https://onlineszamla.nav.gov.hu/dokumentaciok; a program ezen változatának leírása:
   `https://github.com/openszamla/openszamla/blob/v<verzió>/docs/nav-beallitas.md`), hogy élesre később
   az éles technikai felhasználó adataival kell átállni (`openszamla nav-setup --env production --data-dir
   "<adatkönyvtár>"`), és hová menti az adatokat; majd kiírja az állapotot. Terminálban megkérdezi: „Megvannak a technikai felhasználó adatai? Megadod most?”
   (alapértelmezés: nem; beállított NAV-nál „Újra megadod …?”, hibás beállításnál „Most javítod …?”,
   alapértelmezés: igen), és az `openszamla nav-setup` kérdéseit teszi fel (7.3: a környezet
   alapértelmezése `test`; a jelszó és a kulcsok gépelés közben sem látszanak). Hibás formátumú adatot nem
   ment, és felajánlja az újrapróbálást; mentés után – ha az eladó adószáma már megvan – teszteli a
   kapcsolatot, sikertelen tesztnél a mentett adatok megmaradnak, és a javító parancsot írja ki. Ha a
   NAV-adatokat `OPENSZAMLA_NAV_*` környezeti változók adják, nem kérdez. Végül TESZT környezetnél az éles
   átállás parancsát írja ki, ÉLES környezetnél azt, hogy minden kiállított számla valódi
   adatszolgáltatás.
5. **AI-kliensek** – felsorolja a Claude Desktopot, a Claude Code-ot, a Codexet, a Cursort és a VS Code-ot
   (ez utóbbit a munkakönyvtár `.vscode/mcp.json` fájljával) az állapotukkal: „már csatlakoztatva”, „van
   openszamla bejegyzése, más beállítással”, „telepítve”, „nem találom”. Terminálban megkérdezi, melyikhez
   csatlakoztasson (számok vesszővel; alapértelmezés: a telepített, még bejegyzés nélküli kliensek, a VS
   Code kivételével; `0`: egyikhez sem); a beírás pontosan az, amit a `config <kliens> --write` végez
   (7.9). Meglévő, más bejegyzésnél terminálban megkérdezi, lecserélje-e (alapértelmezés: nem). Claude
   Code-hoz és Codexhez a skillt is felajánlja (7.10; alapértelmezés: igen), ha a telepített példány nem
   egyezik a program ezen változatáéval.

Végül összegzést ír (lépésenként: kész, kihagyva, teendő, hiba), és „Mit tovább?”: a most beállított
Claude Desktopból teljes kilépés és újraindítás, a többi beállított kliensben új munkamenet; egy első
kérdés az AI-nak („Mi a helyzet a számlázóval?”) és egy példa a számla kiállítására; a webes felület
(`openszamla serve` – a kiírt címet a böngészőben kell megnyitni, a terminál maradjon nyitva); az
`openszamla doctor`; Windowson azt is, hogy a PowerShell a parancsokat `.cmd` végződéssel futtatja,
ha tiltja a parancsfájlokat („• Windows PowerShellben, ha egy parancs „running scripts is disabled on this
system” („a parancsfájlok futtatása le van tiltva”) hibát ad, írd .cmd végződéssel (pl. openszamla.cmd
doctor, npm.cmd install -g openszamla), vagy engedélyezd egyszer a saját felhasználódnak:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned.”, 7.1); és a hátralévő teendők a parancsukkal.

- **Terminál nélkül** (ha a bemenet nem terminál, pl. szkriptből vagy átirányítással) semmit nem kérdez
  és nem vár bemenetre: az eladói és a NAV-adatokhoz kiírja a futtatandó parancsot (`openszamla init`,
  `openszamla nav-setup`, más adatkönyvtárnál a `--data-dir`-rel, 3.4 – a NAV-titkok kapcsolóként nem adhatók meg), az
  AI-klienseket a `--client` adja meg; `--client` nélkül nem csatlakoztat klienst (a kiírás mutatja a
  parancsot). Ilyenkor a megadott Claude Code-hoz és Codexhez a skillt is telepíti. Windowson a Git Bash
  (mintty) sem ad terminált a programoknak: ott a kiírás szerint `winpty openszamla setup`, vagy
  PowerShell / Terminál kell a kérdésekhez.
- `--client <kliensek>`: vesszővel elválasztva a csatlakoztatandó kliensek (`claude-desktop`,
  `claude-code`, `codex`, `cursor`, `vscode`); terminálban is megadható (akkor a kliensekre nem kérdez
  rá). Ismeretlen név: INVALID_INPUT („Ismeretlen kliens a --client kapcsolóban: …”), mielőtt bármi
  történne.
- `--force`: a meglévő, más `openszamla` bejegyzést kérdés nélkül lecseréli (mint a `config --write
  --force`); nélküle terminál nélkül a meglévő más bejegyzés az adott kliens hibája.
- Ctrl+C: „Megszakítva (Ctrl+C). Ami eddig elkészült, megmaradt; a beállítás folytatható: openszamla
  setup”; ha a bemenet közben véget ér: „A bemenet véget ért. …” (kilépési kód 1).
- Kilépési kód: 1, ha valamelyik lépés hibával zárult (pl. hibás adatok újrapróbálás nélkül, egy kliens
  beírása nem sikerült); egyébként 0 – akkor is, ha egy lépés ki van hagyva, vagy kiírt parancsra vár.

### 7.12 `openszamla doctor [--nav] [--data-dir <mappa>]`
Ellenőrzi a telepítést és a beállításokat, és minden problémához javítási tippet ír („→ …”). Szintek:
`rendben`, `info`, `figyelem`, `HIBA`. Nem hoz létre semmit: az adatkönyvtár írhatóságát egy azonnal
törölt próbafájllal nézi, a régebbi sémájú adatbázist – mint minden parancs – frissíti; a NAV-hoz csak
`--nav` mellett fordul; titkot (NAV-jelszó, kulcs, token, a kliensbeállítások környezeti változóinak
értéke) nem ír ki.
- **Futtatókörnyezet:** a Node.js változata, helye, a szükséges legkisebb változat, a `node:sqlite`
  működése; Windowson tájékoztatás a PowerShell `.cmd` végződéséről (ugyanaz a szöveg, mint a `setup`
  „Mit tovább?” részében, 7.1).
- **Adatkönyvtár és adatbázis:** betölthetők-e a beállítások (pl. hiányos `OPENSZAMLA_NAV_*`, ismeretlen
  `OPENSZAMLA_CONFIRM_MODE`: HIBA); létezik-e az adatkönyvtár (ha nem: figyelmeztetés – az első
  használatkor létrejön), nem fájl-e, írható-e; megnyitható-e az adatbázis, és mi a sémaverziója (újabb
  programverzió adatbázisa, nem OpenSzámla-adatbázis: HIBA); OneDrive-mappában vagy hálózati helyen van-e
  (figyelmeztetés, 3.2).
- **Eladó:** megadták-e, hibátlanok-e az adatai.
- **NAV Online Számla:** be van-e állítva (ha nem: figyelmeztetés a jelentési kötelezettséggel, a
  javításban a technikai felhasználó létrehozásának leírásával –
  `https://github.com/openszamla/openszamla/blob/v<verzió>/docs/nav-beallitas.md` – és a beállító
  paranccsal),
  használható-e (a hiba okával, 3.4), melyik környezet és forrás (a TESZT környezet figyelmeztetés az
  éles átállás parancsával); Linuxon és macOS-en a `nav-credentials.json` jogosultsága; a NAV-jelentésre
  váró és a hibás számlák száma. `--nav`: élő kapcsolatteszt (`tokenExchange`), sikertelen tesztnél HIBA;
  használható beállítás vagy az eladó adószáma nélkül nem tesztel.
- **AI-kliensek:** minden ismert konfigurációs fájl – a Claude Desktopé (Windowson a Microsoft Store-os
  újabb kiadásainak adatmappájáé, a régebbi Store-os kiadásoké és a klasszikus is; a `config --write` által
  írt fájl „a config --write ezt a fájlt írja” megjegyzést kap), a Claude Code felhasználói beállítása (`~/.claude.json`, ill. `CLAUDE_CONFIG_DIR`) és
  a munkakönyvtár `.mcp.json` fájlja, a Codex `config.toml` fájlja, a Cursoré, valamint a VS Code
  felhasználói és munkaterület-szintű `mcp.json` fájlja –, amely `openszamla` bejegyzést tartalmaz:
  létezik-e a beállított parancs (abszolút útvonalnál a fájl, egyébként a PATH-on; a csak parancsértelmezővel
  indítható `.cmd` és a csak a terminál PATH-ján keresett parancs: figyelmeztetés), és ha a Node.js-nek
  programfájlt ad, az létezik-e; npx-es indításnál figyelmeztetés, HTTP-bejegyzésnél (url) tájékoztatás;
  eltér-e a bejegyzés adatkönyvtára az ellenőrzöttől (figyelmeztetés). Nem olvasható vagy nem érvényes
  konfigurációs fájl, nem létező parancs vagy programfájl: HIBA, a javítás többnyire `openszamla config
  <kliens> --write --force`. Ha egyik kliensben sincs bejegyzés: figyelmeztetés; a konfigurációs fájl
  nélküli klienseket egy sorban sorolja fel.
- **Skill:** a Claude Code és a Codex skill-mappájában lévő példány egyezik-e a program ezen változatáéval
  (eltérésnél figyelmeztetés, hiánynál – ha a kliens be van állítva – tájékoztatás az `install-skill`
  paranccsal).

Végül: „Összesen: N hiba, M figyelmeztetés.”, majd „A program használható.”, illetve „A hibák
akadályozzák a használatot – javítsd őket a fenti tippek szerint, majd futtasd újra: openszamla doctor”.
Kilépési kód: 1, ha HIBA volt, egyébként 0.

### 7.13 `openszamla nav-send-to-configured-environment <sorszám|id> [--confirm]`
Egy olyan számlát küld be a beállított NAV-rendszerbe, **új beküldésként**, amelynek NAV-állapota a
másik NAV-rendszerhez tartozik (pl. éles környezetben a csak a TESZT rendszerbe jelentett számlát) –
mint a `nav_send_to_configured_environment` (6.15.1). Éles környezetben ez valódi adatszolgáltatás a
NAV felé, és nem vonható vissza.
- Először mindig kiírja (stdout), mit jelentene, pl. „A(z) SZ-2026-00001 számla NAV-állapota a TESZT
  rendszerhez tartozik (ott: jelentve), az éles rendszerbe nincs jelentve. Most az ÉLES NAV-rendszerbe
  kerülne beküldésre, új beküldésként: ez valódi adatszolgáltatás a NAV felé, és nem vonható vissza.
  Csak akkor küldd be, ha ez valódi számla.” (mint a `nav_sync` előnézete, 6.15).
- `--confirm` nélkül semmit nem küld be: „Hiba [CONFIRMATION_REQUIRED]: Nem küldtem be: a másik
  NAV-rendszerhez tartozó számla beküldéséhez kifejezett megerősítés kell (--confirm).”, „Tipp: Ha ez
  valódi számla, és az éles NAV-rendszerbe is be kell küldeni: openszamla
  nav-send-to-configured-environment "<sorszám>" --confirm”, más adatkönyvtárnál a `--data-dir`-rel (a 3.4
  szerinti legrövidebb alakban), kilépési kód 1.
- `--confirm`-mal (a kifejezett megerősítés) beküldi, a `nav_sync` szabályai szerint (6.15), időkeret
  nélkül, és kiírja az eredményt: „<sorszám>: <NAV-állapot> (éles | TESZT rendszer) – <megjegyzés>”, pl.
  „SZ-2026-00001: done (éles rendszer) – A NAV sikeresen befogadta.”. A kilépési kód 0, ha a beállított
  rendszer befogadta vagy feldolgozza (`done`, `done_with_warnings`, `processing`), különben 1 (a
  megjegyzés megmondja, miért, pl. bizonytalan kimenetelnél mikor futtasd újra a `nav_sync`-et).
- Ha nincs mit beküldeni (a számla nem a másik NAV-rendszerhez tartozik, nincs használható
  NAV-kapcsolat stb.), a hiba mint a `nav_send_to_configured_environment`-nél (6.15.1), pl. „Hiba
  [NOT_OTHER_NAV_SYSTEM]: A(z) … számla NAV-állapota nem a másik NAV-rendszerhez tartozik (az éles
  NAV-rendszerhez tartozik, állapota: done): nincs mit átküldeni.”, kilépési kód 1.

### 7.14 `openszamla restore <mentésfájl> [--confirm] [--data-dir <mappa>]`
Egy mentést (7.8) tesz az adatbázis helyére. **A mentést ne kézzel másold az adatbázisfájl helyére:** a
használatban lévő adatbázis három fájlból áll (`openszamla.db`, `openszamla.db-wal`, `openszamla.db-shm`);
ha a mentés egy futó program adatbázisa helyére, vagy a régi adatbázis ottmaradt naplófájlja mellé kerül,
a két adatbázis összekeveredik, és a program DB_DAMAGED hibát ad („Az adatbázisfájl sérült, vagy nem a hozzá
tartozó naplófájlokkal (-wal, -shm) áll együtt.”, javaslat: minden OpenSzámla-folyamat leállítása és
`openszamla restore <mentésfájl> --confirm`).

- **`--confirm` nélkül** semmit nem változtat, csak kiírja, mi történne („Visszaállítás – előnézet (semmi
  nem változott)”): a mentés és a jelenlegi adatbázis adatait (eladó, kiállított bizonylatok száma, az
  utolsó sorszám, piszkozatok, vevők, termékek); azt, hogy a mentés ennek az adatbázisnak egy korábbi
  állapota-e („A mentés ennek az adatbázisnak egy korábbi állapota.”, vagy ha a mentés óta nem történt
  naplózott változás: „A mentés az adatbázis mostani állapotával egyezik …”); a jelenlegi adatbázis azon kiállított bizonylatait, amelyek a mentésben nincsenek meg
  (sorszám, típus, kelte – az első 20 egyenként); a mindkettőben szereplő, de eltérő tartalmú sorszámokat;
  és a futtatandó parancsot.
- **`--confirm` kapcsolóval** visszaállít:
  1. a mentésfájlt nem módosítja – egy másolatán dolgozik; ha a fájl nem OpenSzámla-adatbázis, újabb
     programverzióval készült, üres vagy az SQLite ellenőrzése szerint sérült, BACKUP_UNUSABLE hibával
     megáll (a nem létező fájl: BACKUP_NOT_FOUND), és semmi nem változik; a régebbi programverzióval
     készült mentést a másolaton a mostani szerkezetre hozza;
  2. ha az adatbázist más program is nyitva tartja (a webes felület – `openszamla serve` –, vagy egy
     AI-kliens háttérben futó MCP-szervere), DB_IN_USE hibával megáll („Az adatbázist most egy másik
     program is használja, ezért nem cserélhető le: …”), és semmi nem változik: állítsd le a webes
     felületet (Ctrl+C), lépj ki teljesen az AI-kliensekből (Claude Desktop: a tálcaikonról is), és
     futtasd újra;
  3. a jelenlegi adatbázist **nem törli**: az adatbázis mellé félreteszi
     `<adatbázis>.visszaallitas-elott-<ééééhhnn-óóppmm>` néven (a naplófájljaival együtt, ha vannak), és
     a mentés másolatát teszi a helyére; a félretett fájl teljes adatbázis: `OPENSZAMLA_DB` változóval
     megnyitható (3.2), a benne lévő bizonylatok és PDF-jeik onnan kiadhatók – őrizd meg (8 év);
  4. a visszaállítást a visszaállított adatbázis auditnaplójába írja (`database.restore`: a mentésfájl
     neve, a félretett adatbázis neve, a mentésből hiányzó bizonylatok sorszámai – legfeljebb 5000 –, az
     eltérő tartalmú sorszámok, a továbbvitt sorszámozás);
  5. lefuttatja a `verify` ellenőrzését az eredményen („Ellenőrzés: rendben (N bizonylat, M
     naplóbejegyzés).”, eltérésnél kilépési kód 2), és kiírja a teendőket (a webes felület és az
     AI-kliensek újraindítása, NAV-szinkron).
- **Sorszámozás korábbi állapot visszaállítása után.** Ha a mentés ennek az adatbázisnak egy korábbi
  állapota (az auditnaplójának utolsó bejegyzése a jelenlegi naplóban is megvan, azonos lenyomattal), a
  mentés óta kiállított bizonylatok az adatbázisból hiányozni fognak, a sorszámukat viszont a program már
  kiadta – a vevők megkapták, a NAV-nál szerepelhetnek. Ezért minden sorszámtartomány számozása a már
  kiadott sorszámok **után** folytatódik („Számlák: a következő sorszám SZ-2026-00028 (a mentés szerint
  SZ-2026-00024 lenne)”): ugyanaz a sorszám nem kerül két különböző számlára. A `verify` a hiányzó
  sorszámokat ilyenkor nem sorszámhézagként, hanem figyelmeztetésként mutatja („… mentés visszaállítása
  (naplóbejegyzés #N) – a mentés után kiállított 4 bizonylat (SZ-2026-00024 – SZ-2026-00027) nincs az
  adatbázisban. A félretett adatbázisban megvannak: …”); az eredmény ettől még „rendben”. A hiányzó
  bizonylatok rendezéséhez (a könyvelésben szerepelniük kell) kérj könyvelői segítséget; a legjobb védelem
  a friss mentés.
- Ha a mentés **nem** ennek az adatbázisnak egy korábbi állapota (másik adatbázis mentése, vagy a mentés
  óta külön folytatódott), a program ezt „FIGYELEM” sorral jelzi – másik eladó adószámánál külön is –, a
  sorszámozás a mentés szerint folytatódik, a jelenlegi adatbázis pedig ugyanúgy félretéve megmarad.
- Új gépen, ahol még nincs adatbázis, a mentés egyszerűen a helyére kerül („Itt még nincs adatbázis: a
  mentés kerül a helyére.”). A NAV-beállítást (`nav-credentials.json`) és a webes tokent (`http-token`)
  a mentés nem tartalmazza: az új gépen `openszamla nav-setup` (7.3), a token magától elkészül.
- A mentés óta rögzített minden más adat (piszkozatok, vevők, termékek, befizetések, NAV-állapotok) is a
  mentéskori állapotra áll vissza; a NAV-állapotokat a következő szinkron (`nav_sync`) egyezteti a
  NAV-val (6.15).

## 8. Webes felület

Az `openszamla serve` indítja, alapértelmezésben a `http://127.0.0.1:8787` címen – csak a saját
gépről érhető el. Kapcsolói: `--host`, `--port`, `--token` (megfelelőik: `OPENSZAMLA_HTTP_HOST`,
`OPENSZAMLA_HTTP_PORT`, `OPENSZAMLA_HTTP_TOKEN`); az üres kapcsolóérték – mint az üres változó (3.3) –
„nincs megadva”. A port 0 és 65535 közötti egész szám (0: tetszőleges szabad port); más értéknél:
„Érvénytelen port (--port): …” (INVALID_INPUT).

A hozzáférési token forrása sorrendben: `--token`, `OPENSZAMLA_HTTP_TOKEN`, az adatkönyvtár
`http-token` fájlja; ha egyik sincs, a program újat készít (32 véletlen karakter), és a `http-token`
fájlba menti. A meglévő `http-token` fájlt soha nem írja felül; ha a fájl üres, a `serve` nem indul el
(„A hozzáférési token fájlja üres: …”, INVALID_CONFIG – töröld a fájlt, vagy írd bele a tokent). A
`--token`-nel vagy `OPENSZAMLA_HTTP_TOKEN`-nel megadott saját tokennek legalább 20 karakteresnek kell
lennie, és csak az angol ábécé betűiből, számjegyekből, `_` és `-` jelből állhat; ennél gyengébb
tokennel a `serve` nem indul el („A(z) --token kapcsolóval megadott hozzáférési token túl gyenge: …”,
INVALID_INPUT; a javaslat: hagyd el, és a program a `http-token` fájl tokenjét használja). A token
értékét a hibaüzenet nem tartalmazza. Ha a `http-token` fájlban lévő token gyenge, a program elindul
(a beállított kliensek továbbra is kapcsolódhatnak), de figyelmeztet: „FIGYELEM: a(z) <fájl> fájlban
lévő hozzáférési token gyenge: … Cseréld le: …”. A `--token`-nel vagy `OPENSZAMLA_HTTP_TOKEN`-nel
megadott token, amely pontosan a `http-token` fájlban lévő (pl. a Codexnek a fájlból exportált
változó, [kliensek.md](kliensek.md)), a mentett tokennek számít: gyenge értéknél sem utasítja el, hanem
ugyanígy figyelmeztet és elindul.

Induláskor a hibakimenetre kiírja az adatkönyvtárat (3.2), a webes felület belépési címét
(`…/?token=…`, a token URL-kódolva), alatta: „Nyisd meg ezt a címet a böngészőben. Amíg használod, ezt az
ablakot hagyd nyitva; leállítás: Ctrl+C.”, majd „AI-kliensek (MCP) ugyanitt csatlakozhatnak:” után az MCP
végpontot és a tokenfájl helyét, végül haladó beállításként, hogy az AI-kliens kérésére a PDF mappába
másolása (`invoice_pdf` `copyToDir`, 6.14) engedélyezett-e („Haladó beállítás – PDF másolása mappába
(AI-kliens kérésére): kikapcsolva (OPENSZAMLA_ALLOW_FILE_COPY=1 engedélyezi)” – ez az alapállapot –,
illetve „… engedélyezve”), előtte pedig, hogy az automatikus NAV-szinkron (6.15) be van-e kapcsolva
(„Automatikus NAV-szinkron (a megkezdett beküldések befejezése, 5 percenként): bekapcsolva”, illetve
„… kikapcsolva (OPENSZAMLA_NAV_AUTO_SYNC=0)”);
`OPENSZAMLA_TRUST_PROXY=1` mellett ezt is: „Kliens címe a /mcp korlátjához: a saját gépről érkező
kapcsolatnál az X-Forwarded-For fejléc utolsó eleme (OPENSZAMLA_TRUST_PROXY)”.
Ha a szerver nem tud elindulni: PORT_IN_USE („A port már foglalt: <cím>:<port>.” – fut már egy
`openszamla serve` vagy más program ezen a porton), PORT_ACCESS_DENIED („Nincs jogosultság a port
használatához: …”), HOST_UNAVAILABLE („Ezen a gépen nincs ilyen cím, ezért nem figyelhet rajta: …”),
mindegyik javaslattal. Ctrl+C-ig fut.

Ugyanazon a porton:
- a **webes felület** (8.1–8.7);
- az **MCP végpont** (`/mcp`, Streamable HTTP): a tokent `Authorization: Bearer <token>` fejlécben,
  vagy – a fejlécet küldeni nem tudó klienseknek (pl. claude.ai egyedi connector), csak HTTPS mögött –
  az útvonalban kell megadni: `/mcp/<token>` (az útvonalban a token URL-kódolva is megadható). Token
  nélkül vagy hibás tokennel: 401.
  **Próbálgatás elleni korlát:** egy címről percenként legfeljebb 10 hibás tokenű kérést fogad el
  (a token nélküli kérés nem számít); utána arról a címről minden `/mcp`-kérés – a token
  ellenőrzése nélkül, tehát a helyes tokennel érkező is – 429-es választ kap („Túl sok hibás
  hozzáférési token erről a címről – próbáld újra N másodperc múlva.”, `Retry-After` fejléccel), amíg
  a legrégebbi számolt kísérlet ki nem esik az egyperces ablakból. Ha egy percen belül az összes
  címről együtt 100 hibás kísérlet érkezik, utána csak az a cím küldhet tokent, ahonnan az elmúlt 60
  percben helyes tokenű kérés jött (a saját, címenkénti korlátján belül); minden más cím – a token
  ellenőrzése nélkül, tehát a helyes tokennel is – 429-es választ kap („Túl sok hibás hozzáférési
  token érkezett a szerverre, ezért most csak az elmúlt 60 percben sikeresen azonosított címekről fogad
  kérést – próbáld újra N másodperc múlva.”, `Retry-After` fejléccel), amíg az egyperces ablak hibás
  kísérletei 100 alá nem csökkennek. Így a sok (akár hamisított) címre elosztott próbálgatás is
  percenként legfeljebb 100 kísérletet kap, a már működő kliens (pl. a helyes tokennel dolgozó
  claude.ai-összekötő vagy Codex) pedig zavartalanul dolgozik tovább; az a kliens, amely az elmúlt
  órában nem kapcsolódott, a próbálgatás idején kivár. A cím a kapcsolódó gép címe (IPv6-nál a /64-es
  hálózat). Az `X-Forwarded-For` fejlécet a szerver alapból figyelmen kívül hagyja; csak
  `OPENSZAMLA_TRUST_PROXY=1` mellett (3.3) veszi a saját gépről (loopback) érkező kapcsolatnál – a
  szerver mellett futó reverse proxyn át – a fejléc utolsó elemét a kliens címének (8.7). A számlálás a
  memóriában történik, újraindításkor nullázódik. A webes belépés korlátja külön működik (8.1). A
  2025-ös protokollú kéréseket a végpont munkamenet nélkül szolgálja ki, ezért `elicit` megerősítési
  módban ezeken nem állít ki, nem sztornóz, és a másik NAV-rendszerhez tartozó számlát sem küldi be
  (ELICITATION_UNAVAILABLE_LEGACY_HTTP, 6.9, 6.15.1);
- **`/healthz`** – token nélkül elérhető állapotjelző: `{"ok":true,"name":"openszamla","version":"<verzió>"}`.
  Más adatot nem ad ki, és nem változtat semmit (pl. reverse proxy állapotfigyeléséhez).

Minden kérésnél ellenőrzi a `Host` és – ha van – az `Origin` fejlécet (a saját cím, illetve az
`OPENSZAMLA_ALLOWED_HOSTS` / `OPENSZAMLA_ALLOWED_ORIGINS`); más értéknél 403: az `/mcp` végpont JSON-RPC
hibát ad („Forbidden host: …” / „Forbidden origin: …”), a webes felület oldalai pedig magyar szöveges
választ („A program ezt a kérést elutasította: a böngésző olyan címen (gépnéven) érte el, amely nincs az
engedélyezettek között.” / „… az űrlapot egy másik címről (origin) küldték, mint amelyiken a webes
felület fut.”, a teendővel: a program által kiírt címen kell megnyitni, más gépnévhez az
`OPENSZAMLA_ALLOWED_HOSTS` és az `OPENSZAMLA_ALLOWED_ORIGINS` változó kell). Ismeretlen cím: 404.

A webes felület ugyanazokat a műveleteket hívja, mint az MCP szerver és a parancssor, ugyanazokkal az
ellenőrzésekkel; minden módosítás `web` szereplővel kerül az auditnaplóba. Minden adatot a program
magyar nyelvű hibaüzenettel és javítási tanáccsal utasít el, ha hibás. Ha az üzenet egy mezőt a
programozói nevén idéz (pl. „Érvénytelen dátum a(z) "from" mezőben”), a felület az űrlapmező
feliratával mondja („… a(z) „Időszak kezdete” mezőben”; így a `to`, `date`, `amount`, `exchangeRate`,
`issueDate`, `fulfillmentDate`, `dueDate`, `unitPrice`, `quantity` nevet is). Ahol a javítási tanács MCP-re
vagy parancssorra szól, a felület a weben követhetőt mutatja (a hibakód alapján): beállítatlan eladónál (SELLER_NOT_CONFIGURED)
„Először állítsd be az eladó adatait (név, adószám, cím, ÁFA-státusz) a Beállítások oldalon.” és
hivatkozás a Beállításokra („Beállítások megnyitása”); már létező vevőnél (DUPLICATE_CUSTOMER – új
vevő felvételekor, vagy „Mentés a vevők közé is” jelölővel) „Ez a vevő már szerepel a vevők között:
válaszd ki a vevőt a listából (új bizonylatnál a „Vevő a vevőlistából” mezőben); az adatait az
adatlapján módosíthatod.”; hibás számnál (INVALID_NUMBER) „Számot írj be, ezres elválasztó nélkül; a
tizedesjel vessző vagy pont lehet (pl. 12500 vagy 1,5).”; az egy ponttal és utána pontosan három
számjeggyel írt, vessző nélküli számot (pl. „1.000”, „10.000”, „2.125”) a webes űrlapok nem fogadják
el, mert a pont ezres tagolás és tizedesjel is lehet (a találgatás ezerszeres eltérést adhatna):
„A(z) „10.000” nem egyértelmű a(z) „1. tétel – egységár” mezőben: a pont ezres tagolás és tizedesjel
is lehet.”, a javaslat a beírt értékkel mindkét olvasatot kiírja: „Tizedes törtként vesszővel írd:
10,000. Ezresként pont nélkül: 10000 (vagy szóközzel: 10 000).” – a beírt érték az űrlapon marad; a
pontokkal tagolt, tizedesvesszős szám (pl. „1.000,50”) ezer egész ötvenet jelent, a két vagy több
ponttal hármasával tagolt szám (pl. „1.000.000”) pedig egymilliót – ezeknek csak egy olvasatuk van;
az űrlapok a tárolt számokat (mennyiség, egységár, kézi árfolyam, a terméklistából beírt ár)
tizedesvesszővel töltik ki (pl. „2,125”, „615,943”), így a változatlanul hagyott mező mindig
menthető; mindez az egységárra, a mennyiségre, az árfolyamra és a befizetés összegére egyaránt
érvényes; ha a választott termék ára más pénznemben
van, mint a bizonylat (CURRENCY_MISMATCH), „Írd be az egységárat a tétel sorába, a bizonylat
pénznemében – a termék árát a program nem váltja át.”. A piszkozat ellenőrzési üzeneteit, a teendőket
(8.2), a kiállítás és a NAV-beküldés eredményét a felület a saját szavaival mondja (8.3): MCP-eszköz-
vagy mezőnevet (pl. `nav_sync`, `invoice_draft`, `vatReason`) egyik sem tartalmaz.

**A felület felépítése.** Minden oldal tetején a programnév (az Áttekintőre visz), a főmenü – Áttekintés,
Számlák, Új számla (kiemelve), Vevők, Termékek, Export, Beállítások; az aktuális oldal félkövér, aláhúzott
és a képernyőolvasónak is jelölt („aktuális oldal”) – és a **Kilépés** gomb. Telefonon a menü két sorban,
négy oszlopban jelenik meg. Az oldal fő művelete az oldal címe mellett (telefonon alatta) áll; egy
nézetben egy elsődleges (kitöltött) gomb van, a végleges, vissza nem vonható műveletek gombjai pirosak,
a „Mégsem” és a „Vissza…” jellegű gombok szövegesek. A gombok felirata megnevezi a tárgyat és az
eredményt (pl. „Számla kiállítása és beküldése a NAV-nak”); a „…”-ra végződő gomb még nem hajt végre
semmit, csak a művelethez tartozó részhez vagy következő lépéshez visz. Az állapotjelvények (pl.
„kiállított”, „fizetetlen”, „lejárt”, „NAV: rendben”) szöveggel és ikonnal is jeleznek, nem csak színnel.
A felület a rendszer világos vagy sötét beállítását követi, telefonon is használható (a gombok és mezők
legalább 44 képpont magasak; 1100 képpontnál keskenyebb ablakban – telefonon, tableten vagy egy nagy
képernyő felén – a számlalisták kártyaként jelennek meg, szélesebb ablakban táblázatként, amelynek
NAV-oszlopában az állapot „NAV:” előtag nélkül áll), billentyűzettel is kezelhető
(első Tab: „Ugrás a tartalomra”; jól látható fókuszkeret, a dátummezőkön is; az űrlapok ablak aljához
rögzített mentés-sávja a Tab-bal elért mezőt nem takarja el), és JavaScript nélkül is működik; a kis
beépített szkriptek csak kényelmi funkciók (a tartalék tételsorok elrejtése és az új tételsor, a
választott termék adatainak kitöltése a tételsorban, az új vevő mezőinek nyitása-zárása, parancs
másolása). A parancsokat tartalmazó blokkok a parancsot soha nem törik szó közben: a hosszú parancs
oldalra görgethető, a **Parancs másolása** gomb egészben másolja. Külső betűkészletet vagy más külső
erőforrást nem tölt be.

### 8.1 Belépés és kilépés
- **Belépés** a `serve` által kiírt hivatkozással (`…/?token=…`; a token benne URL-kódolva szerepel, így
  a régebbi, `+`, `#`, `&` vagy `%` jelet tartalmazó tokennel is működik), vagy a belépő oldalon
  (`/login`) a hozzáférési token beírásával („Hozzáférési kulcs” mező, **Belépés** gomb; a mező súgója
  szerint a legegyszerűbb az indításkor kiírt teljes belépési címet megnyitni). A token azonnal eltűnik a
  címsorból; a böngésző csak egy aláírt, 12 óráig érvényes munkamenet-sütit kap, magát a tokent nem.
- A token ugyanaz, mint az MCP végponté, és teljes hozzáférést ad: saját token csak legalább 20
  karakteres, az angol ábécé betűiből, számjegyekből, `_` és `-` jelből álló lehet (8. fejezet); a
  legegyszerűbb a `serve` által készített `http-token` tokent használni.
- **Kilépés** (a fejléc Kilépés gombja; a `/logout` címen megerősítő oldal „Biztosan kilépsz a webes
  felületről?” kérdéssel, **Kilépés** és **Mégsem** gombbal): a süti törlődik, és a munkamenet a
  szerveren is érvénytelenné válik. A kilépést a szerver csak a memóriájában tartja nyilván, a szerver újraindításáig: az
  újraindítás után a kilépett munkamenet régi sütije – ha valaki eltette – a lejáratáig (legfeljebb a
  belépéstől számított 12 óráig) ismét érvényes. Új hozzáférési tokennel indított szerver minden
  korábbi munkamenetet érvénytelenít (lásd még a 10. fejezetet).
- **Belépési korlát, címenként:** egy címről percenként 10 hibás belépési kísérlet után a belépés arról a
  címről szünetel, amíg a kísérletek ki nem futnak az egyperces ablakból („Túl sok sikertelen belépési
  kísérlet erről a gépről.”, a javaslat megmondja, hány másodperc múlva próbálható újra; 429-es válasz
  `Retry-After` fejléccel) – a többi címről közben be lehet lépni, tehát a hálózatról érkező
  próbálgatás nem zárja ki a jogos felhasználót. Ha percenként összesen 100 hibás kísérlet érkezik,
  utána csak az elmúlt 60 percben sikeresen belépett címek próbálkozhatnak („Túl sok sikertelen
  belépési kísérlet érkezett a szerverre.”). A kliens címét ugyanúgy állapítja meg, mint az `/mcp`
  végpont (`OPENSZAMLA_TRUST_PROXY`, 8. fejezet eleje); az `/mcp` végpont a sajátját külön számolja.
  Más weboldalba ágyazott (kép, keret, szkript) token-hivatkozást a program nem fogad el.

### 8.2 Áttekintő (`/`)
- **Első indításkor** – amíg nincs se kiállított bizonylat, se piszkozat – az oldalon csak az Első lépések
  útmutató és az Eladó és a NAV Online Számla kártya látszik (nulla darabszámok és üres táblázatok
  nélkül); az első piszkozat vagy bizonylat után a teljes áttekintő.
- **Első lépések** (amíg a beállítás nem teljes; ha már van kiállított bizonylat, a címe „Beállítás
  befejezése”): lépésenkénti útmutató, „N / 4 lépés kész” jelzéssel; minden lépés állapota szövegesen
  is látszik („kész”, „teendő”, „javítandó”); az első még nyitott, a webes felületen elvégezhető lépés
  gombja az oldal elsődleges gombja (a NAV-kapcsolat beállítása a program gépén történik).
  Az útmutató eltűnik, ha mind a négy lépés kész. A lépések:
  1. **Eladó (saját céged) adatai** – „Állítsd be az eladó adatait: név, adószám, cím, bankszámla és
     ÁFA-státusz. Ezek kerülnek minden számlára.”, gomb: **Eladó adatainak megadása** (a Beállítások
     eladói űrlapja, 8.5); ha az eladói adatokban hiba van: „javítandó”, gomb: **Eladói adatok
     javítása**; kész: „Megadva: <név>.”
  2. **NAV Online Számla kapcsolat – először a TESZT rendszerrel** (az oldal más részei a
     `#guide-nav` horgonnyal ide mutatnak) – a NAV technikai felhasználó beállításának lépései:
     létrehozása az onlineszamla.nav.gov.hu oldalon (előbb a teszt-, valódi számlázás előtt az éles
     rendszerben), majd „Egy új terminálablakban (az openszamla serve ablakát hagyd nyitva) futtasd ezt
     a parancsot, és add meg a kért adatokat” – egyetlen parancs a 3.4 szerinti legrövidebb alakban (a
     beépített adatkönyvtárnál `openszamla nav-setup`, másnál `openszamla nav-setup --data-dir
     "<adatkönyvtár>"`), külön blokkban, **Parancs másolása** gombbal (szkript nélkül a parancs
     kijelölhető); alatta összecsukva **Ha az „openszamla” parancs nem található**: ugyanez `npx -y`
     előtaggal, saját másoló gombbal –, végül az oldal frissítése. A hitelesítő adatok a webes felületen
     nem adhatók meg. Hibás beállításnál „javítandó”, a hiba okával és ugyanezzel a paranccsal. TESZT
     környezetben kész, a megjegyzéssel, hogy éles adatszolgáltatás nem történik, és az éles környezetre
     állító paranccsal (`openszamla nav-setup --env production`, más adatkönyvtárnál a `--data-dir`-rel).
  3. **Első vevő** – gomb: **Első vevő felvétele** (a Vevők oldal kinyitott új-vevő űrlapja,
     `/customers?new=1`); kész: „Kész: N vevő elmentve.”
  4. **Első számla** – a piszkozat és a kiállítás különbségének magyarázata; gomb: **Első számla
     elkészítése** (`/invoices/new`), ha már van piszkozat: **Piszkozatok megnyitása**; az eladó adatai
     nélkül gomb helyett: „Előbb az eladó adatait add meg (1. lépés).”
- **Új számla készítése** gomb a cím mellett (az eladó adatainak megadása után; amíg az útmutató
  látszik, másodlagos gomb).
- **Eladó**: név, adószám, cím; a javítandó adatok száma és **Eladói adatok javítása** hivatkozás, vagy
  – beállítás nélkül – utalás az Első lépések 1. lépésére.
- **NAV Online Számla**: jelvény – „TESZT környezet”, „ÉLES környezet”, „nincs beállítva” vagy „hibás
  beállítás” –, a beküldés módja (kiállításkor automatikus / kézzel, az alábbi gombbal). Beállítás
  nélkül vagy hibás beállításnál rövid magyarázat és hivatkozás az Első lépések 2. lépésére (ha az
  útmutató valamiért nem jeleníthető meg, ugyanitt a beállítás lépései); teszt környezetben: „TESZT
  környezet: a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás nem történik.” Ha
  nincs mit beküldeni: „Nincs függő NAV-jelentés.”; éles környezetben, ha csak a TESZT rendszerbe
  jelentett számlák vannak: „N számla csak a NAV TESZT rendszerébe került – az éles rendszerbe nincs
  jelentve. A számla oldalán olvasható, hogyan küldheted be.” és **A számlák megnyitása** hivatkozás;
  ha csak az eredeti számlájukra váró javító okiratok függenek: „Most nincs beküldhető NAV-jelentés: a
  függő javító számlák az eredeti számlájukra várnak (lásd a Teendőket).”
- **Függő számlák beküldése a NAV-nak** (használható NAV-kapcsolatnál, ha a gomb tud mit beküldeni:
  függő vagy feldolgozás alatti jelentés, a kapcsolat beállítása előtt kiállított számla, egyeztetendő
  ismétlés, elutasított vagy a NAV-val nem egyeztethető jelentés – ez utóbbiakhoz a jelölővel; a csak
  az eredeti számlájukra váró javító okiratokhoz és a másik NAV-rendszer számláihoz nincs gomb):
  beküldi a még nem jelentett számlákat, és lekérdezi a feldolgozás alattiak állapotát (mint
  `nav_sync`, legfeljebb 8 másodperc várakozással). Az „Az elutasított / hibás számlák újraküldése is”
  jelölővel az elutasított vagy hibás jelentéseket is újraküldi – csak a hiba elhárítása után használd.
  Egy futás a NAV-val legfeljebb kb. 60 másodpercig foglalkozik (időkeret, mint a `nav_sync`-nél, 6.15):
  amelyik számlához a futás így nem jutott el, annak megjegyzése „A rendelkezésre álló idő letelt,
  mielőtt a program ennél a számlánál a NAV-hoz fordult volna – …”. Az eredmény: „N számla
  feldolgozva, ebből M sikeresen jelentve” (teszt környezetben „… a NAV TESZT rendszerébe (éles
  adatszolgáltatás NEM történt)”), ha a futás leállása miatt (időkeret, NAV-kiesés, a NAV által kért
  szünet) néhány számlához nem fordult a NAV-hoz, utána „K számlához ez a futás nem fordult a NAV-hoz
  (lásd a megjegyzéseket) – később kattints újra a „Függő számlák beküldése a NAV-nak” gombra.”;
  számlánként az állapottal és a felület saját szavaival írt megjegyzéssel (pl. „A NAV befogadta.”, „A
  NAV elutasította: az okát a számla NAV részében, a NAV üzeneteinél olvashatod. A hiba javítása után
  küldd újra.”, az eredetire váró javító okiratnál, hogy melyik eredetire és miért vár). A dupla
  kattintás nem okoz kettős beküldést.
- **Darabszámok** (a megfelelő szűrt listára vagy oldalrészre mutatnak, „›” jellel): piszkozat,
  kiállított bizonylat, nyitott (fizetetlen) számla – a kintlévőségek –, NAV: függő / folyamatban;
  ha van ilyen, a NAV-kapcsolat nélkül kiállított számlák: beállítás nélkül semleges színű „NAV-ra vár –
  a kapcsolat még nincs beállítva” (az Első lépések 2. lépésére visz), beállított kapcsolatnál
  figyelmeztető színű „NAV-ra vár – a kapcsolat beállítása előtt kiállítva” (a listára, `?nav=not_configured`);
  **NAV-probléma** – csak az elutasított vagy hibás jelentések (piros, ha nem 0; a listára,
  `?nav=problem`); ha van ilyen, a másik NAV-rendszerhez tartozó számlák: éles környezetben „csak a
  TESZT rendszerben jelentve” (figyelmeztető színnel), teszt környezetben „az éles rendszerben jelentve
  (itt nincs teendő)” (a listára, `?nav=other`); vevő, termék. A NAV-darabszámok használható
  NAV-kapcsolatnál a beállított NAV-rendszer számláit számolják (mint `setup_status`, 6.1).
- **Teendők** (mint `setup_status` `todos`, 6.1 – a felület saját szavaival, mindegyik mellett a
  hozzá tartozó hivatkozással vagy gombbal; az Első lépések által már elmagyarázott teendők – az eladó
  beállítása vagy javítása, a NAV-kapcsolat beállítása vagy javítása, látható útmutató mellett a TESZT
  környezet – nélkül). Például: „N kiállított számla még nincs jelentve a NAV-nak, mert nincs
  NAV-kapcsolat. A beállítás után (Első lépések, 2. lépés) a „Függő számlák beküldése a NAV-nak” gomb
  mindet beküldi.” (**NAV-kapcsolat beállítása…**); „N számla jelentését a NAV elutasította, vagy
  végleges hibával zárult: nyisd meg, olvasd el a NAV üzenetét, hárítsd el az okát, majd a számla
  oldalán küldd újra.” (**NAV-problémás számlák**); „N számla jelentésre vár: küldd be a „Függő számlák
  beküldése a NAV-nak” gombbal.” (**Függő számlák beküldése a NAV-nak…** – a NAV-kártya gombjához
  ugrik); „N számla feldolgozása a NAV-nál folyamatban …”; „TESZT környezet: … Valódi számlázás előtt
  állítsd át élesre – a parancsot a Beállítások oldal NAV részén másolhatod.” (**NAV-beállítás
  megnyitása**); a NAV által kért szünet vége; a sorszám-ütközéses, a NAV-val nem egyeztethető és az
  ismétlésként elutasított jelentések teendője; az eredeti miatt nem jelenthető módosító/sztornó
  számlák az eredeti sorszámaival; éles környezetben „N számla csak a NAV TESZT rendszerébe került, az
  éles rendszerbe nincs jelentve (<sorszámok>). Ha valamelyik valódi számla, a számla oldalán olvasható,
  hogyan küldheted be – a webes felület (a „Függő számlák beküldése a NAV-nak” gomb sem) nem teszi meg
  helyetted.” (**A számlák megnyitása**), és külön: „N sztornó/módosító számla az eredeti számla éles
  beküldésére vár (az eredeti csak a TESZT rendszerben van); a webes felület ezeket addig nem küldi be.”
- **E havi forgalom (kelte szerint)**: darabszám, nettó, ÁFA, bruttó, ÁFA-kódonként és az 5 legnagyobb
  vevő (mint `report_summary`), a `report_summary` figyelmeztetéseivel (pénzforgalmi elszámolásnál,
  teljesítési dátumot javító módosításnál, 6.17).
- **Kintlévőség**: nyitott és lejárt számlák darabszáma és összege (mint a `report_summary`
  `receivables`, 6.17), a megjegyzéssel: „A darabszám a fizetendő (pozitív végösszegű), nem rendezett
  számláké; az összeg a hátralékuk a módosító számláikkal együtt (a jóváírás beszámítva, a túlfizetés
  átvezetve).”; gombok: „Nyitott számlák” (kintlévőség-szűrő), „Lejárt számlák”.
- A lejárt határidejű számlák (legfeljebb 5, többnél „Mind a(z) N lejárt számla” hivatkozással) és az 5
  legutóbbi bizonylat („Mind a(z) N bizonylat”, illetve „Összes bizonylat” hivatkozással; a lejárt
  határidejű, nem rendezett kintlévőségen „lejárt” jelvénnyel – ugyanaz a szabály, mint a „Csak a
  lejárt határidejű, nem fizetett számlák” szűrőé); bizonylat nélkül „Még nincs bizonylat.” és **Új
  számla készítése** gomb.

### 8.3 Számlák
- **Lista** (`/invoices`, 25 tétel oldalanként): keresés (sorszám, vevő neve, megjegyzés,
  rendelésszám); állapot (piszkozat, kiállított, sztornózott, kiállított vagy sztornózott); típus
  (bizonylattípusonként, vagy „számlák (díjbekérő és sztornó nélkül)”); fizetés (fizetetlen, részben
  fizetve, fizetve, „nyitott (fizetetlen vagy részben fizetve)” – minden bizonylatra szó szerint –,
  „kintlévőség (fizetendő, nem vagy csak részben fizetett számla)” – csak a kintlévőségek,
  `?payment=receivable`); NAV-állapot (állapotonként, „folyamatban”, „NAV-probléma (elutasítva vagy
  hiba)” – `?nav=problem` –, „a másik NAV-rendszerhez tartozik (pl. csak a TESZT rendszerben jelentve)” –
  `?nav=other`; használható NAV-kapcsolatnál az állapotszűrők a beállított NAV-rendszer – vagy még egyik
  rendszer – bizonylatait választják, mint az Áttekintő darabszámai); kelte ettől–eddig (érvénytelen dátumot figyelmeztetéssel figyelmen kívül hagy; ha az
  „ettől” későbbi az „eddig”-nél, a találatok helyén a hibaüzenet jelenik meg, mint 6.8);
  rendezés (kelte szerint csökkenő vagy növekvő, létrehozás szerint); „Csak a lejárt határidejű, nem
  fizetett számlák” (csak kintlévőségek). A fizetési állapot a módosító számlákkal együtt értendő (6.13).
  Üres listánál „Még nincs bizonylat.” és **Új számla készítése** gomb, üres szűrési eredménynél „Nincs a szűrésnek megfelelő
  bizonylat.”; ha a kért oldal a (nem üres) lista végén túl van – pl. egy régi hivatkozásból –, „Ez az
  oldal üres – utolsó oldal: N.” és „Ugrás az utolsó oldalra” hivatkozás (a szűrők megmaradnak).
  Ugyanígy a vevő- és a terméklistán (8.4). Gombok: **Új számla készítése** (a cím mellett), **Szűrés**,
  szűrés után **Szűrők törlése**; lapozás: **Előző** / **Következő**. A lejárt határidejű, nem rendezett
  kintlévőség a fizetési állapota mellett „lejárt” jelvényt kap (ugyanaz a szabály, mint a „Csak a
  lejárt határidejű, nem fizetett számlák” szűrőé). A fizetési jelvény a sztornózott számlán „nem
  fizetendő (sztornózva)”, ha pedig befizettek rá, „befizetve – sztornózva, visszajár”, amíg a
  visszafizetést a sztornó számlán teljes egészében nem rögzítették – utána „befizetve – sztornózva,
  visszafizetve”; a visszavont
  díjbekérőn „nem fizetendő (visszavonva)”, illetve „befizetve – visszavonva, visszajár”; a negatív
  fizetendő összegű módosító számlán (jóváírás) „jóváírás – nem fizetendő”. A NAV-oszlopban a másik
  NAV-rendszerhez tartozó számla jelvénye megnevezi a rendszert: éles környezetben „NAV (TESZT): <állapot>”
  (súgója: „Az éles rendszerbe nincs jelentve”), teszt környezetben „NAV (éles): <állapot>”. Telefonon
  minden bizonylat egy kártya, amely bárhol megérintve megnyílik: sorszám (mellette a típusa) és bruttó
  összeg, vevő, az állapotjelvények, végül egy sorban a kelte és a határidő.
- **Új piszkozat** (`/invoices/new`, menü: „Új számla”; `?customerId=<vevő azonosítója>` a vevőt előre
  kiválasztja, `?productId=<termék azonosítója>` – a termék oldalának **Új számla ezzel a termékkel**
  gombja, 8.4 – az első tételsorba a terméket teszi 1-es mennyiséggel, és a pénznemet a termék
  pénznemére állítja). Amíg az eladó adatai nincsenek megadva, az űrlap tetején: „Számlát csak az eladó
  (saját céged) adatainak megadása után készíthetsz.” és **Eladó adatainak megadása** hivatkozás, a
  **Piszkozat mentése** gomb pedig nem használható („Mentés előtt add meg az eladó (saját céged) adatait
  a Beállítások oldalon.”). Az űrlap részei sorrendben:
  - **Bizonylat típusa**: számla, előlegszámla vagy díjbekérő (a mező súgója: a díjbekérő fizetési
    felszólítás, nem számla, a NAV-nak nem jelentendő; fizetés után számla készíthető belőle);
  - **Vevő**: „Vevő a vevőlistából” (az első 500 mentett vevő; első sora „— új vevő (az adatait lent add
    meg) —”), vagy az **Új vevő adatai (ha nincs a listában)** rész minden adatával („Mentés a vevők
    közé is” jelölővel: a vevő csak a piszkozattal együtt mentődik – ha a mentés hibával visszautasul, a
    vevő sem kerül a vevők közé, 6.7). Az új vevő része nyitva van, ha nincs kiválasztott mentett vevő,
    vagy ha már van benne beírt adat; szkripttel a választás változásakor magától nyílik-zárul. Ha sem
    mentett vevő, sem új vevő nincs megadva: „Hiányzik a vevő.” – „Válassz egy mentett vevőt a „Vevő a
    vevőlistából” mezőben, vagy add meg az új vevő adatait (név és cím; cégnél az adószám is).”;
  - **Tételek** (megnevezés, mennyiség, mennyiségi egység, egységár, nettó/bruttó, ÁFA-kód; az üres sorok
    nem kerülnek a bizonylatra; tizedesjel vessző vagy pont, ezres tagolásnak szóköz – az „1.000” alakot
    az űrlap nem fogadja el, lásd a 8. fejezet elején; legfeljebb 200 tétel). Ha vannak mentett
    termékek, minden tételsorban terméklista is van (az oszlop neve ekkor „Termék / megnevezés”, a lista
    első sora „Válassz terméket…”; az archivált termék csak akkor szerepel, ha a tételsor már arra
    hivatkozik): szkripttel a választott termék azonnal kitölti a sor megnevezését, egységét, egységárát
    (csak ha a termék pénzneme a bizonylatéval azonos), az ár típusát és az ÁFA-kódját, és üres
    mennyiségnél 1-et ír be. Amit a sorban üresen hagysz, azt mentéskor a termékből veszi a program
    (szkript nélkül is): a megnevezést és az egységet, üres egységárnál pedig az egységárat, az ár
    típusát és az ÁFA-kódot együtt; a beírt értékek maradnak. Szkripttel az űrlap egy üres tételsorral
    indul (szerkesztéskor a meglévő tételekkel): a tartalék üres sorok rejtve vannak, és az **Új tételsor
    hozzáadása** gomb előbb ezeket mutatja meg, utána ad újat; JavaScript nélkül 5 sor látszik (és
    legalább annyi, ahány tétel van);
  - **Dátumok, fizetés, pénznem**: teljesítés dátuma; fizetési határidő (üresen hagyva az
    alapértelmezés szerinti, a keltével együtt mozgó határidő; kitöltve megadott határidő, 6.7); fizetési
    mód; pénznem; árfolyam (kitöltve kézi árfolyam; üresen hagyva MNB-beállításnál az MNB-árfolyam, 5.2);
    nyelv; megrendelésszám;
  - **Megjegyzések**: megjegyzés (a bizonylatra kerül); belső megjegyzés.

  A kelte a kiállítás napja, a megjelenés az alapértelmezés szerinti. A **Piszkozat mentése** és a
  **Mégsem** gomb hosszú űrlapnál görgetés közben is az ablak alján marad, „A mentés még nem állít ki
  számlát: utána ellenőrizheted, és külön lépésben, megerősítéssel állíthatod ki.” megjegyzéssel
  (telefonon a megjegyzés nélkül). Mentés mint `invoice_draft`. Hibás mentésnél az űrlap a beírt
  értékekkel jelenik meg újra; a hibaüzenet az oldal tetején áll, és ha a vevőről vagy egy tételről
  szól, az érintett rész elején is, a tetejéről pedig **Ugrás a Vevő részhez** / **Ugrás a Tételek
  részhez** hivatkozás visz oda.
- **Piszkozat szerkesztése** (`/invoices/<id>/edit`, ugyanaz az űrlap): számla, előlegszámla és díjbekérő piszkozata
  szerkeszthető, ha egyik tételén sincs mentességi jogcím, előleglevonás vagy módosított sorra
  hivatkozás; más piszkozat (végszámla, módosító és sztornó piszkozat) MCP-n javítható (a piszkozat
  oldalán és a szerkesztés címén: „Ez a piszkozat a webes felületen nem szerkeszthető. Előleglevonást,
  módosított tételt vagy egyedi mentességi okot tartalmaz (vagy módosító, illetve sztornó számla
  piszkozata), amelyhez a webes űrlapon nincs mező: az AI-asszisztenssel javíttasd, vagy töröld, és
  készíts újat.”). Az űrlap az
  összes mezőt elküldi, a tételek mind kicserélődnek. Ha a piszkozat az űrlap megnyitása óta
  megváltozott (ugyanaz az űrlap másodszor érkezik, vagy közben MCP-n, másik ablakban módosították), a
  mentés elmarad: „A piszkozat az űrlap megnyitása óta megváltozott, ezért ezt a mentést nem hajtottam
  végre.” Két előre kitöltött mező csak akkor számít megadottnak, ha átírod (a betűre változatlan
  tartalom átíratlannak számít):
  - a fizetési határidő mező a tárolt határidővel töltődik ki. A fizetési feltételből számolt határidő
    átíratlanul vagy kiürítve számolt marad (kiállításkor a kiállítás napjával együtt eltolódik); a
    fizetési mód módosítása nem számolja újra (mint MCP-n). Más napra átírva megadott határidő lesz
    (nem mozog, 6.7); a jelenlegi napjára így nem rögzíthető, arra MCP-n a `dueDate` való. A megadott
    határidő kiürítve is megmarad. A mező súgója jelzi, melyik eset áll fenn;
  - az árfolyam mező a tárolt kézi árfolyammal töltődik ki (MNB-árfolyammal nem). Ha a teljesítés
    dátumát vagy a pénznemet módosítod, és az árfolyamot nem írod át, a régi kézi árfolyam nem marad
    meg, és a mentés ezt jelzi: „Piszkozat mentve; a korábbi kézi árfolyamot (1 EUR = 398,5 Ft) nem
    vettem át.” MNB-beállításnál az MNB-árfolyam lép a helyére, kézi beállításnál EXCHANGE_RATE_MISSING
    hibát kapsz (5.2); ugyanazt az árfolyamot a következő mentéssel adhatod meg újra. Változatlan
    dátum és pénznem mellett a kézi árfolyam marad.
- **Bizonylat adatai** (`/invoices/<id>`): eladó, vevő, bizonylatadatok (típus, sorszám,
  sorszámtartomány, kelte, teljesítés, fizetési határidő és mód, pénznem és árfolyam forrással,
  nyelv, megjelenés, megrendelésszám, időpontok, azonosító, tartalmi lenyomat), tételek (a
  mentességi jogcímmel, az előleglevonással és „Az eredeti számla N. tételét módosítja” jelöléssel),
  ÁFA-összesítő és végösszeg (devizásnál forintban is, készpénzes kerekítéssel), kötelező szöveges
  megjelölések, megjegyzések, kapcsolódó bizonylatok (sztornónál „Sztornózott számla: <sorszám>”,
  módosító számlánál „Eredeti számla: <sorszám> (N. módosítás)”), fizetés, NAV-állapot, napló (a műveletek magyar nevével – a
  NAV-egyeztetés és a bizonytalan eredményű NAV-beküldés is –, az összegek a bizonylat pénznemében, a
  sorszámtartomány a nevével, belső azonosítók nélkül). **Piszkozatnál** az
  oldal az előnézetet mutatja (mint `invoice_get`): a hibákat és figyelmeztetéseket, a kelténél
  „(kiállításkor a kiállítás napja lesz)” megjegyzést, és ha a kiállításkor nyomtatandó eladói adatok
  eltérnek a piszkozattal mentettektől, ezt: „Az eladó adatai a piszkozat mentése óta megváltoztak.” (az
  Eladó rész már a nyomtatandó adatokat mutatja); ha a vevők közül választott vevő adatai változtak
  meg (6.7): „A vevő adatai a piszkozat mentése óta megváltoztak.” (a Vevő rész már a kiállításkor
  nyomtatandó adatokat mutatja). Minden hiba és figyelmeztetés mellett az érintett mező magyar neve áll
  („– érintett mező: vevő típusa”, „1. tétel – adómentesség oka”, „kelte”), és ahol a weben javítható,
  hivatkozás oda: a piszkozat űrlapjának megfelelő részére (Vevő, Tételek, Dátumok…), a vevők közül
  választott – az adatait követő – vevőnél a vevő adatlapjára, az eladó adatainál a Beállításokra. Az
  MCP-kliensnek szóló üzenetek helyett a felület az űrlap szavaival fogalmaz (a kód alapján), pl. a
  KBAET, EUFAD37 vagy EUFADE kódú tétel nem uniós vevőjénél: „A(z) KBAET kódú tétel csak más uniós
  tagállamban nyilvántartott cégnek (adóalanynak) számlázható: a vevő típusa legyen „egyéb (külföldi,
  vagy nem áfaalany szervezet)”, és add meg a közösségi adószámát.”; ugyanígy a vevő típusáról és
  adószámáról, az eladó bankszámlájáról és közösségi adószámáról, a tételek hiányáról szólóknál; a
  kiállításkor változó keltéről: „A piszkozat kelte <dátum>; kiállításkor a kelte a kiállítás napja
  (<dátum>) lesz, a fizetési határidő ugyanennyivel eltolódik: <dátum> → <dátum>” (a dátumok magyar
  formában). Az egyforma szövegű üzenet egyszer látszik. A TAM vagy NAM kódú tétel pontos mentességi
  jogszabályhelyét kérő figyelmeztetés (LINE_EXEMPTION_REFERENCE_RECOMMENDED) szövege: „A(z) N. tétel
  tárgyi adómentes: a számlán a mentesség pontos jogszabályhelye is feltüntethető (pl. „Áfa tv. 85. §
  (1) e) – oktatás”), hogy egyértelmű legyen (Áfa tv. 169. § m)).”, alatta: „A webes űrlapon ehhez
  nincs mező: a pontos jogszabályhelyet az AI-asszisztens írhatja be (pl. „Az 1. tételhez írd be a
  mentesség jogszabályhelyét: Áfa tv. 85. § (1) e)”); utána a piszkozat a weben már nem szerkeszthető.
  Enélkül is kiállítható: a számlára az általános mentességi megjelölés kerül.” A tárolt vevőtől eltérő
  vevőadatú piszkozat figyelmeztetése (BUYER_DIFFERS_FROM_RECORD, 6.7) alatt: „A webes felületen: a
  Piszkozat szerkesztése oldalon mentve a piszkozat a vevőlistában kiválasztott vevő tárolt adatait
  kapja. A weben nem szerkeszthető piszkozatnál ezt az AI-asszisztens teheti meg: kérd meg, hogy a
  piszkozat vevőjének állítsa vissza a mentett vevőt.”; a díjbekérő át nem kerülő befizetéséről szóló
  figyelmeztetés (PROFORMA_PAYMENT_NOT_CARRIED) alatt: „A webes felületen a befizetést a kiállítás után,
  a bizonylat oldalán rögzítheted (Befizetés rögzítése).” A webes űrlapon nem szerkeszthető, kiállítható
  piszkozatnál a Kiállítás rész is megmondja: „Ez a piszkozat a webes felületen nem szerkeszthető. …”
- **A bizonylat oldalának feje**: a sorszám (piszkozatnál „Piszkozat”), a típus és a vevő; az
  állapotjelvények (állapot, fizetés – a lejárt határidejű, nem rendezett kintlévőségnél „lejárt” is –,
  NAV-állapot; ha a számla NAV-állapota a másik NAV-rendszerhez tartozik, mellette „csak a TESZT
  rendszerben”, illetve „az éles rendszerben”); kiállított, pozitív fizetendő összegű bizonylatnál
  „Fizetendő: …” és „Fizetési határidő: …”, egyébként „Bruttó: …”; alatta, hogy a **PDF letöltése** mit
  ad (mint az `invoice_pdf` `kind`-ja, 6.14, a PDF előállítása nélkül): „PDF: a megőrzött eredeti – a
  kiállításkor készült, a letöltés bájtra pontosan ezt adja” és „SHA-256: <lenyomat>”; ha a PDF a
  kiállításkor nem készült el, „PDF: eredeti – Az eredeti PDF a kiállításkor nem készült el: az első
  PDF-kérés (letöltés) készíti el, és azt őrzi meg eredetiként.”; az eredeti PDF-ek megőrzése előtt
  kiállított bizonylatnál „PDF: újra előállított, nem az eredeti” jelvény, a 6.14 szerinti magyarázat és
  a letöltött fájl neve (`<sorszám>_UJRAELOALLITOTT.pdf`); piszkozatnál „PDF: tervezet („TERVEZET – NEM
  SZÁMLA” vízjellel) – nem számla”; ha a megőrzött eredeti hiányzik (DOCUMENT_MISSING, 6.14), „a PDF
  most nem tölthető le” jelvény a hiba szövegével. Mellette (telefonon alatta) a műveletek: **PDF
  letöltése**, piszkozatnál **Piszkozat szerkesztése** (ha a webes űrlapon szerkeszthető) és
  **Piszkozat törlése…**; kiállított bizonylatnál – ahol az adott művelet elérhető – **Befizetés
  rögzítése…** (sztornó számlán **Visszafizetés rögzítése…**), a NAV-gomb felirata „…”-tal (használható NAV-kapcsolatnál, ha a NAV még nem fogadta be,
  és a számla NAV-állapota nem a másik NAV-rendszerhez tartozik), és **Sztornó számla készítése…** /
  **Díjbekérő visszavonása…**; kiállított díjbekérőnél **Számla készítése ebből a díjbekérőből**,
  kiállított vagy sztornózott számlánál és előlegszámlánál **Új számla ennek mintájára** (lásd a
  műveleteknél). A „…”-ra végződő gombok az oldal megfelelő részéhez ugranak (ott történik a művelet).
  A javító okiratnál, amely az eredeti számlájára vár, nincs NAV-gomb a fejben (8.3, NAV rész). Kiállított
  díjbekérőnél a fej alatt: „Fizetés után készíts belőle számlát: a „Számla készítése ebből a
  díjbekérőből” gomb számlapiszkozatot nyit a díjbekérő adataival, a rögzített befizetés pedig a számla
  kiállításakor átkerül rá.”; ha már kiállítottak belőle számlát: „Számla készült belőle: <sorszám>”
  (hivatkozással).
- **Műveletek** a bizonylat oldalán:
  - **PDF letöltése** (`/invoices/<id>.pdf`, mint `invoice_pdf`, 6.14): kiállított bizonylatnál a
    megőrzött eredeti PDF, bájtra pontosan (`<sorszám>.pdf`); az eredeti PDF-ek megőrzése előtt
    kiállított bizonylatnál az újra előállított PDF (`<sorszám>_UJRAELOALLITOTT.pdf`); piszkozatnál a
    tervezet (`TERVEZET_<azonosító>.pdf`);
  - **Befizetés rögzítése** összeggel (üresen: a teljes hátralék) és dátummal (mint
    `invoice_record_payment`, a visszavonás szabályaival – az üresen hagyott összeg pozitív fizetendő
    összegű bizonylatnál a számla és módosító számlái együttes hátraléka, 6.13); az űrlap a
    kiállított, nem teljesen kifizetett bizonylatnál látszik. A hátraléknál nagyobb összeget az űrlap
    csak a „Túlfizetést rögzítek” jelölővel rögzít (alapból nincs bejelölve; a jelölő nélkül a hibaüzenet:
    „A megadott összeg (…) nagyobb a hátraléknál (…): a különbözet (…) túlfizetés lenne.”, a javaslat:
    „Ellenőrizd az összeget (nem csúszott el egy számjegy vagy a tizedesjel?). Ha a vevő valóban
    ennyit fizetett, jelöld be a „Túlfizetést rögzítek” jelölőt a befizetés űrlapján, és küldd el
    újra.”). Ha az üresen hagyott összeg több a bizonylat hátralékánál, mert a lánc más
    bizonylatán is van hátralék, az összeg mező alatti tipp megmondja, mennyi kerül rögzítésre:
    „Üresen hagyva a teljes hátralék kerül rögzítésre – a számla és módosító számlái együtt:
    <összeg>.” Az űrlap véletlen dupla beküldése nem rögzít kétszer.
  - **Téves befizetés visszavonása…** (lenyíló rész a Fizetés részben): minden kiállított bizonylatnál
    megjelenik, amelyre magára rögzítettek befizetést – a teljesen kifizetettnél is –; sztornózott
    számlánál, egy sztornózott számla módosító számlájánál és a sztornó számlán nem. Mezői: „Visszavont
    összeg” (pozitív számként; üresen hagyva az ezen a bizonylaton rögzített teljes összeg, amelyet a
    rész ki is ír: „Ezen a bizonylaton rögzítve: …”) és „Visszavonás dátuma”; a „Visszavonás rögzítése”
    gomb az összeget ellentétes előjellel rögzíti (mint `invoice_record_payment` negatív összeggel,
    6.13 **Visszavonás**; jóváíró bizonylatnál a rész neve „Téves visszafizetés visszavonása…”). A téves
    tétel a visszavonásával együtt a befizetések között marad. Az eredmény: „Visszavonás rögzítve:
    <fizetési állapot> (<befizetve> / <fizetendő>).”; negatív összegnél „A visszavont összeget pozitív
    számként add meg.”; a rögzítettnél nagyobb összegnél a 6.13 szerinti hiba; a dupla beküldés nem
    von vissza kétszer.
  - A Fizetés rész a fizetendő és a
    befizetett összeg mellett a hátralékot is mutatja, a módosító számlákkal együtt számolva (6.13;
    jóváíró bizonylatnál „Visszafizetendő a vevőnek”). Sztornózott számlánál az összeg neve „Eredetileg
    fizetendő”, alatta: „A számlát sztornózták, nem kell kifizetni.” – ha befizettek rá: „A számlát
    sztornózták: a befizetett összeg a vevőnek visszajár, vagy a helyette kiállított számlába
    beszámítható. Mindkét esetben a(z) <sztornó> sztornó számlán rögzítsd visszafizetésként –
    beszámításnál az új számlán befizetésként is.” (a sztornó sorszáma a sztornó oldalára mutat), a
    sztornón rögzített teljes visszafizetés után: „A számlát sztornózták, a befizetett összeget a
    vevőnek visszafizették (rögzítve a(z) <sztornó> sztornó számlán).” (visszavont díjbekérőnél: „A
    díjbekérőt visszavonták, …”). Sztornózott számla módosító számláján (a sztornó azt is
    semlegesítette) nincs hátralék- vagy visszafizetendő-sor és befizetési űrlap, helyette: „Az eredeti
    számlát sztornózták: a sztornó számla ezt a módosító számlát is semlegesítette, ezért rá fizetés nem
    rögzíthető.” A „Befizetve” a bizonylatra jutó összeg, a „Teljes kifizetés napja” az a befizetési nap,
    amellyel a bizonylat teljesen kifizetetté vált (6.13). A rögzítés után az oldal tetején: „Befizetés
    rögzítve: <állapot> (<befizetve> / <fizetendő>).”;
  - **Befizetések (a befizetés dátuma szerint):** a bizonylat befizetési előzményei (6.13) táblázatban –
    dátum, az erre a bizonylatra jutó összeg („Erre a bizonylatra”), fajta (befizetés, visszafizetés a
    vevőnek, visszavonás, rendezettnek jelölve) és forrás (rögzítve, a kiállításkor rögzítve, a
    díjbekérőről átvéve – a díjbekérő sorszámával); a lánc másik bizonylatán rögzített befizetésnél azt
    is, hogy melyik bizonylaton és mekkora összeggel rögzítették (hivatkozással). Befizetés nélkül nincs
    táblázat;
  - **Visszafizetés a vevőnek** (sztornó számlán, ha a sztornózott számlára vagy módosító számláira
    befizetés érkezett; egyébként a sztornó számlának nincs fizetési része): a visszafizetett és a még
    visszafizetendő összeg, a teljes visszafizetés napja, a magyarázat („A sztornózott <számla> számlára
    (és módosító számláira) befizetett összeg visszafizetését ezen a sztornó számlán kell rögzíteni, negatív
    összeggel; ha mindet visszafizették, a számla láncának egyenlege nulla.”), a visszafizetések táblázata,
    és amíg van visszafizetendő összeg, a **Visszafizetés rögzítése** űrlap (összeg – negatív, üresen a
    teljes visszafizetendő összeg – és dátum, mint `invoice_record_payment` a sztornón, 6.13 **Sztornó
    számla**). A rögzítés után: „Visszafizetés rögzítve: eddig visszafizetve <összeg>, még visszafizetendő
    <összeg>.”;
  - a NAV rész gombja (használható NAV-kapcsolatnál; mint `nav_sync` egy számlára –
    az elutasított vagy hibás jelentést is újraküldi, ezért csak a hiba elhárítása után használd; egy
    kattintás a NAV-val legfeljebb kb. 60 másodpercig foglalkozik, mint az Áttekintő gombja, 8.2 és
    6.15 **Időkeret**). A felirata és a fölötte álló magyarázat a bizonylat NAV-állapota szerint: függő vagy beállítás
    nélkül kiállított bizonylatnál **<Típus> beküldése a NAV-nak** (pl. „Számla beküldése a NAV-nak”;
    „Beküldi a bizonylatot a NAV-nak, és megvárja a NAV válaszát (legfeljebb néhány másodpercig).”),
    feldolgozás alattinál **NAV-feldolgozás állapotának lekérdezése**, elutasítottnál vagy hibásnál
    **<Típus> újraküldése a NAV-nak** („Csak a hiba javítása után küldd újra…”), befogadottnál **NAV-állapot
    ellenőrzése** („…a gomb csak megerősíti az állapotát, újra nem küldi be.”). NAV-kapcsolat nélkül
    a gomb helyén: „A NAV-kapcsolat nincs beállítva. A számlát a beállítás után azonnal be kell küldeni
    a NAV-nak – a beállítás lépései az Áttekintés oldalon (Első lépések) és a Beállítások oldalon
    olvashatók.” A
    NAV részben a NAV üzenetei. A gomb eredménye: „NAV-állapot: <állapot>.” és a felület saját
    szavaival, mit jelent (pl. „A NAV befogadta.”, „A NAV elutasította: az okát a számla NAV részében, a
    NAV üzeneteinél olvashatod. A hiba javítása után küldd újra.”, „A NAV még feldolgozza – később kérdezd
    le újra az állapotát.”), a NAV üzeneteivel. **A módosító/sztornó számla, amely az eredeti számlájára
    vár** (a NAV a javító okiratot csak az eredeti után fogadja be, 6.15): a NAV részében nincs NAV-gomb
    (és a fejben sincs rá ugró gomb), mert az nem tudná beküldeni; helyette, hogy miért vár, és **Az
    eredeti számla (<sorszám>) megnyitása** hivatkozás. Pl. ha az eredeti még nincs jelentve: „Ez a
    sztornó számla az eredeti számlára vár: előbb a(z) <sorszám> számlát kell jelenteni a NAV-nak. A
    „Függő számlák beküldése a NAV-nak” gomb sorban mindkettőt beküldi.”; elutasított eredetinél: „… a(z)
    <sorszám> NAV-jelentését a NAV elutasította, vagy hibával zárult. Nyisd meg az eredeti számlát,
    hárítsd el a hiba okát, és küldd újra – utána ez is beküldésre kerül.”; éles környezetben, ha az
    eredeti csak a TESZT rendszerben van: „Ez a sztornó számla az eredeti számlára vár: a(z) <sorszám>
    csak a NAV TESZT rendszerében van, az éles rendszerbe nincs jelentve, a NAV pedig a javító számlát
    csak az eredeti után fogadja be. Ha az eredeti valódi számla, előbb azt küldd be az éles rendszerbe
    (lásd az eredeti számla oldalán); utána a „Függő számlák beküldése a NAV-nak” gomb ezt is beküldi.”;
    ugyanígy a feldolgozás alatti, a sorszám-ütközéses és a NAV-val nem egyeztethető eredetinél.
  - **A másik NAV-rendszerhez tartozó számla** (6.15 **Teszt és éles környezet**): az ilyen számlát a
    webes felület nem küldi be, ezért a NAV részében nincs NAV-gomb (és a fejben sincs rá ugró gomb).
    Éles környezetben, a csak a TESZT rendszerbe jelentett számlánál a NAV rész közérthetően elmondja:
    „Ez a számla a NAV TESZT rendszerébe került (ott az állapota: …), az éles rendszerbe nincs jelentve – a
    tesztrendszerbe küldött számla nem adatszolgáltatás.”, „A webes felület ilyen számlát nem küld be az
    éles rendszerbe: az valódi adatszolgáltatás a NAV felé, és nem vonható vissza, ezért csak kifejezett
    megerősítéssel történhet. Ha ez valódi számla, kétféleképpen küldheted be:” – **az AI-asszisztensben**
    (a kérésedre előbb megmutatja, mit jelent a beküldés, és csak a jóváhagyásod után küldi be – MCP-n ez
    a `nav_send_to_configured_environment`, 6.15.1), vagy **parancssorban**, a program gépén (a
    `--confirm` a kifejezett megerősítés, nélküle a parancs csak kiírja, mit jelentene, 7.13):
    `openszamla nav-send-to-configured-environment "<sorszám>" --confirm` (más adatkönyvtárnál a
    `--data-dir`-rel, 3.4), külön blokkban, **Parancs másolása** gombbal; végül: „A beküldés után frissítsd
    ezt az oldalt.”
    TESZT környezetben, az éles rendszerbe jelentett számlánál: „Ez a számla az éles NAV-rendszerbe
    került (ott az állapota: …). A program most a NAV TESZT rendszerét használja: itt nincs vele teendő,
    és a webes felület a tesztrendszerbe sem küldi be. Az éles jelentéséhez állítsd vissza az éles
    környezetet, azon a gépen, ahol a program fut:” és az `openszamla nav-setup --env production` parancs
    (más adatkönyvtárnál a `--data-dir`-rel, 3.4), **Parancs másolása** gombbal;
  - piszkozatnál **törlés** (mint `invoice_delete_draft`) és **kiállítás** (mint `invoice_issue`, a
    NAV-beküldés az `OPENSZAMLA_NAV_AUTO_SUBMIT` szerint). A kiállításhoz be kell jelölni a megerősítő
    négyzetet, és a szerver által az oldallal kiadott megerősítés kell. A megerősítés a munkamenethez és
    a látott tartalomhoz kötött, 10–20 percig érvényes, és érvénytelen, ha azóta a piszkozat, az eladó
    vagy – a vevők közül választott vevőnél (6.7) – a vevő adatai, a dátum, (módosító számlánál) a
    módosítási sorszám, vagy (díjbekérőből készült bizonylatnál) a díjbekérő befizetése, illetve a
    belőle kiállított bizonylatok megváltoztak (mint a megerősítő kódnál, 6.9). Fizetendő (0-nál
    nagyobb fizetendő összegű) bizonylatnál – díjbekérőnél nem – „A vevő kifizette (befizetés a
    kiállítás napjával)” jelölő is van (mint a `markPaid`, 6.9; a megerősítésnek nem része):
    készpénzes és bankkártyás fizetési módnál alapból bejelölve, egyébként nem – ugyanaz a szabály,
    amely szerint az `invoice_issue` `nextStep`-je a befizetés rögzítését kéri (6.9);
  - a piszkozat oldalán a **Kiállítás** rész áll legfelül, végleges műveletként kiemelve (figyelmeztető
    színű szegéllyel): a piszkozat
    ellenőrzésének eredménye, majd „A kiállítás végleges – mi történik?” felsorolás (a bizonylat
    sorszámot kap, a kelte a kiállítás napja lesz; utána nem módosítható és nem törölhető – díjbekérő
    csak visszavonható, számla csak sztornó vagy módosító számlával javítható; a NAV-beküldés: kiállításkor
    azonnal – TESZT környezetben a tesztrendszerbe –, kikapcsolt automatikus beküldésnél a bizonylat oldalán,
    beállítás nélkül vagy hibás beállításnál a javítás után; díjbekérőnél: nem jelentendő), a legfontosabb
    adatok, a jelölők és a gomb. A gomb felirata: **<Típus> kiállítása és beküldése a NAV-nak** (használható
    éles NAV-kapcsolat és automatikus beküldés mellett, pl. „Számla kiállítása és beküldése a NAV-nak”),
    TESZT környezetben **<Típus> kiállítása és beküldése a NAV TESZT rendszerébe**, egyébként **<Típus>
    kiállítása (végleges)**; díjbekérőnél **Díjbekérő kiállítása (végleges)**. Módosító (és sztornó)
    számlánál, amelynek eredetijét a beállított NAV-rendszer még nem fogadta be, a NAV-sor nem ígér
    beküldést, a gomb **<Típus> kiállítása (végleges)**: pl. „A módosító számla most nem kerül a NAV-hoz: a
    NAV a javító számlát csak az eredeti számla (<sorszám>) sikeres jelentése után fogadja be – utána a
    program beküldi.”, éles környezetben a csak TESZT rendszerbe jelentett eredetinél: „… most nem kerül
    a NAV-hoz: az eredeti számla (<sorszám>) csak a NAV TESZT rendszerében van, az éles rendszerbe nincs
    jelentve. A program az eredeti éles beküldése után küldi be.” Alatta, elválasztva: **Piszkozat
    törlése…** – kinyitva: „A piszkozat még nem számla: véglegesen törölhető, a törlés nem vonható
    vissza.” és **Piszkozat végleges törlése** gomb. A kiállítás eredménye: „Kiállítva: <sorszám> –
    <vevő>, bruttó <összeg>.”, alatta a felület saját szavaival: ha a kelte a kiállítás napjára változott,
    „A kelte a kiállítás napja (<dátum>) lett; a fizetési határidő ehhez igazodott: <dátum>” (megadott
    határidőnél: „… nem változott.”); ha a PDF nem készült el, „A PDF előállítása nem sikerült; a „PDF
    letöltése” gomb később újra megpróbálja.”; TESZT környezetben, hogy éles adatszolgáltatás nem
    történik; kikapcsolt automatikus beküldésnél, hogy a bizonylat oldalán kell beküldeni; a NAV-beküldés
    eredménye („NAV: <állapot> – …”, mint a NAV gombnál); és a sorszámtartományról, az átkerült díjbekérő-
    befizetésről, a rögzített befizetésről szóló megjegyzések. Használható NAV-kapcsolat nélkül az
    üzenet figyelmeztetés: „Ez a bizonylat még nincs jelentve a NAV-nak, mert nincs beállítva a
    NAV-kapcsolat (hibás beállításnál: „… mert a NAV-kapcsolat beállítása hibás”) – a törvény szerint
    azonnal jelenteni kell. Állítsd be a kapcsolatot (Áttekintés → Első lépések, 2. lépés); utána az
    Áttekintés „Függő számlák beküldése a NAV-nak” gombja beküldi.”, és **NAV-kapcsolat beállítása**
    hivatkozás;
  - kiállított számlánál **sztornó**: ok megadása (3–200 karakter) → előnézet (a sztornó számla bruttó
    összege: az eredeti számla és kiállított módosító számlái együttes ellentéte, a módosító számlák
    sorszámával és bruttó összegével; az eredeti bruttó összege; a sztornó számla teljesítési dátuma –
    ha egy módosító számla javította a számla teljesítési dátumát, „(javított; az eredeti számláé:
    <dátum>)” megjegyzéssel, 6.10 –; az eredeti számla kelte; a sztornó esetleges ellenőrzési hibái)
    → megerősítő négyzet (mint `invoice_cancel_preview` és `invoice_cancel`, ugyanazokkal a
    megerősítési szabályokkal); díjbekérőnél visszavonás. Ha a sztornónak ellenőrzési hibája van, az
    előnézeten nincs megerősítő négyzet és gomb, csak a hibák, alattuk: „A sztornó most nem állítható
    ki: előbb a fenti hibaüzenetben megnevezett okot kell rendezni (például a végszámla sztornójával
    vagy módosításával), utána kérj új sztornó-előnézetet.”, és a „Vissza a számlához” gomb. Ha a
    sztornó a megerősítéskor utasul el (az előnézet óta megváltozott a helyzet), a hibaüzenet alatt a
    6.10 szerinti javaslat áll – akkor is, ha a megerősítés közben egy másik folyamat (pl. egy
    MCP-szerver) módosító számlát állított ki a számlához: ilyenkor sztornó nem készül
    (STORNO_CHAIN_CHANGED, 6.10), és az új előnézet már a módosító számlát is semlegesítő összeget
    mutatja. Az ok – a díjbekérő visszavonásáé is – egy sorba rendezve kerül a
    sztornóra (6.10), az előnézet és a megerősítő űrlap is így mutatja. A csak szóközökből álló, illetve
    3 karakternél rövidebb vagy 200 karakternél hosszabb okra az űrlap „Add meg a sztornó okát (3–200
    karakter).” (díjbekérőnél „Add meg a visszavonás okát (3–200 karakter).”) üzenetet ad; ha az egy sorba rendezett okban 3-nál kevesebb látható karakter
    marad (pl. csak irányváltó vezérlőkarakterekből áll), előnézet és megerősítő négyzet helyett a 6.10
    szerinti hibaüzenet jelenik meg („A sztornó oka legalább 3 látható karakterből álljon.”, díjbekérőnél
    „A visszavonás oka …”). Mindkét üzenet a számla oldalának Sztornózás (díjbekérőnél Díjbekérő
    visszavonása) részében, az ok mezője fölött jelenik meg: az oldal oda ugrik, a rész nyitva van, és az
    ok újra megadható. Sztornó és módosító számlánál nincs ilyen művelet.
  - a sztornó gombjai: a Sztornózás részben – a magyarázat alatt: „Kisebb hibát (ár, mennyiség,
    engedmény) módosító számlával is javíthatsz: ezt az AI-asszisztens készíti el (pl. „Az <sorszám>
    számlán adj 10% engedményt.”), a kész piszkozatot pedig itt, a webes felületen is kiállíthatod. A
    sztornó a teljes számlát érvényteleníti.” – **Sztornó számla készítése…** (díjbekérőnél **Díjbekérő
    visszavonása…**) nyitja ki az ok mezőjét, a magyarázattal, hogy az előnézet még nem végleges; **Sztornó előnézete (még nem végleges)** / **Visszavonás előnézete (még nem végleges)**
    nyitja meg az előnézetet. Az előnézeten „A művelet végleges – mi történik?” felsorolás (új sorszámú
    sztornó számla készül, az eredeti számla ezután sztornózott; a NAV-beküldés, mint a kiállításnál; a
    művelet nem vonható vissza – díjbekérőnél: visszavont állapotba kerül, sztornó bizonylat nem készül,
    a NAV-nak nem jelentendő), a megerősítő négyzet, és a piros gomb: **Sztornó számla kiállítása és
    beküldése a NAV-nak** / **Sztornó számla kiállítása és beküldése a NAV TESZT rendszerébe** / **Sztornó
    számla kiállítása (végleges)** (a NAV-kapcsolat szerint, mint a kiállításnál – ha az eredeti számlát a
    beállított NAV-rendszer még nem fogadta be, pl. éles környezetben csak a TESZT rendszerben van, a
    NAV-sor ezt mondja, és a gomb **Sztornó számla kiállítása (végleges)**), díjbekérőnél **Díjbekérő
    visszavonása (végleges)**; mellette **Mégsem, vissza a számlához** (díjbekérőnél **Mégsem, vissza a
    díjbekérőhöz**). A sztornó eredménye: „Sztornó számla kiállítva: <sorszám> (eredeti: <sorszám>).”, a
    kiállításéval azonos megjegyzésekkel; díjbekérőnél „Díjbekérő visszavonva: <sorszám>.”
  - **Számla készítése ebből a díjbekérőből** (kiállított, vissza nem vont díjbekérőnél) és **Új számla
    ennek mintájára** (kiállított vagy sztornózott számlánál és előlegszámlánál – pl. a sztornó után a
    helyes számla elkészítéséhez): új piszkozatot készít a bizonylat adataival (mint `invoice_draft`
    `copyFromId`, 6.7: a teljesítés dátuma a mai nap, a fizetési határidő a mintáéval azonos hosszú, a
    vevő a vevőlistából a mostani adataival; a díjbekérőből készült számla a díjbekérő befizetését a
    kiállításkor átveszi), és megnyitja a piszkozat űrlapjában (ha a webes űrlapon nem szerkeszthető, a
    piszkozat oldalán). Semmit nem állít ki: a kiállítás a szokásos, megerősített lépés. Az eredmény
    díjbekérőnél: „Számlapiszkozat készült a(z) <sorszám> díjbekérőből – még nem számla.”, alatta: „A
    teljesítés dátuma a mai nap lett: ha a teljesítés máskor történt (vagy még nem történt meg), írd át.”,
    „Ha a vevő a teljesítés előtt fizetett, előlegszámla kellhet (Bizonylat típusa: előlegszámla) –
    ebben a könyvelőd segít.”, „A díjbekérőre rögzített befizetés a kiállításkor átkerül a számlára; ha
    valamiért nem, a piszkozat oldala jelzi.”; számlánál: „Új piszkozat készült a(z) <sorszám> mintájára –
    még nem számla.” Az ugyanabból az űrlapból kétszer érkező kérés (pl. dupla kattintás) egy piszkozatot
    készít: „Ebből az űrlapból már készült piszkozat, nem készítünk még egyet.” Más bizonylatból (sztornó,
    módosító számla, végszámla, piszkozat) nem készíthető így piszkozat: „Ebből a bizonylatból a webes
    felületen nem készíthető új piszkozat.”
- Módosító számlát az AI-asszisztens (MCP-n az `invoice_correct`) készít; a kész piszkozat a webes
  felületen is megtekinthető és kiállítható.

### 8.4 Vevők és termékek
- **Vevők** (`/customers`, 25 vevő oldalanként): **Új vevő felvétele** gomb a cím mellett
  (`/customers?new=1`: az oldal alján kinyitja az új vevő űrlapját – akkor is, ha szkript nincs);
  keresés (név, adószám, közösségi adószám, e-mail, település), „Archivált vevők is” jelölő, **Keresés**
  és keresés után **Szűrők törlése** gomb; vevő nélkül „Még nincs elmentett vevő.” és **Új vevő
  felvétele** gomb. A lista és az új vevő része egy-egy címsor (a lista címe csak a képernyőolvasónak
  látszik: „Vevőlista”). Az **Új vevő felvétele** rész (vevő nélkül, és a fenti gombbal nyitva; típus – teljes
  szélességű mezőben –, név,
  adószám, csoporttagi adószám, közösségi adószám, harmadik országbeli adóazonosító, ország,
  irányítószám, település, régió, cím, e-mail, telefon, bankszámlaszám, belső megjegyzés) mentése:
  **Vevő mentése**. Adatlap (`/customers/<id>`): **Új számla ennek a vevőnek**, **Vissza a
  vevőlistához**, adatok, **Adatok módosítása** (minden mező és az „Archivált” jelölő; az űrlap minden
  mezőt elküld, a kiürített mező törlődik; mentés: **Vevő adatainak mentése**), a vevő legutóbbi 25
  bizonylata (a lejárt határidejűeken „lejárt” jelvénnyel). Mint `customer_save` / `customer_find`. A
  lista végén túli oldalon: „Ez az oldal üres – utolsó oldal: N.” (8.3).
- **Termékek** (`/products`, 25 tétel oldalanként; a lista végén túli oldalon mint 8.3): **Új termék /
  szolgáltatás felvétele** gomb a cím mellett (`/products?new=1`: kinyitja az új tétel űrlapját);
  keresés (megnevezés, cikkszám, leírás), „Archivált tételek is” jelölő, **Keresés** és **Szűrők
  törlése**; üres listánál „Még nincs elmentett termék vagy szolgáltatás.” és a felvétel gombja (a
  lista – „Terméklista” – és az új tétel része itt is címsor);
  új termék vagy szolgáltatás (megnevezés, mennyiségi egység, egységár, nettó/bruttó, pénznem, ÁFA-kód,
  jelleg – „automatikus (az egység alapján)” –, cikkszám, leírás; mentés: **Termék mentése**); adatlap
  (`/products/<id>`, **Új számla ezzel a termékkel** – nem archivált terméknél: az új számla űrlapja a
  termékkel az első tételsorban, 8.3 –, **Vissza a terméklistához**): szerkesztés és archiválás (mentés:
  **Termék adatainak mentése**). A mentett termékek a számla űrlapjának minden tételsorában
  választhatók (8.3). A szerkesztő űrlap a jelleget „automatikus”-nak mutatja, ha a tárolt
  jelleg az, ami a mennyiségi egységből adódik: így hagyva a mennyiségi egység módosításakor a jelleg
  újraszámolódik (mint `product_save`-nél `nature` nélkül); a másként választott jelleg (pl. egyéb,
  vagy `db` egységű szolgáltatás) kiválasztva jelenik meg, és megmarad. Mint `product_save` /
  `product_find`.

### 8.5 Beállítások (`/settings`)
- **Eladó (saját cég)** (mint `seller_update`): név, adószám, közösségi adószám, csoporttag adószáma,
  ÁFA-státusz, cím, bankszámla, bank, SWIFT, elérhetőségek, weboldal, cégjegyzék- vagy nyilvántartási
  szám, pénzforgalmi elszámolás, KATA, számla lábléce; az **Eladói adatok mentése** gomb görgetés
  közben is látszik.
- **Új bizonylatok alapértelmezései**: fizetési mód, fizetési határidő (nap, átutalásnál), nyelv,
  megjelenés, pénznem, árfolyamforrás (MNB vagy kézi); mentés: **Alapértelmezések mentése**.
- **Sorszámtartományok** (név, típus, minta, következő sorszám, évenkénti újraindulás, állapot) és a
  **NAV Online Számla kapcsolat** (jelvény, a hitelesítő adatok forrása – „a program indításakor megadott
  beállítások (környezeti változók)” vagy „nav-credentials.json az adatkönyvtárban” –, a beküldés módja:
  automatikusan, a kiállításkor, vagy kézzel, a bizonylat oldalán vagy az Áttekintés „Függő számlák
  beküldése a NAV-nak” gombjával) csak megtekinthetők. Új sorszámtartományt az AI-asszisztens hoz létre
  (MCP-n a `series_manage`; az oldal: „Új sorszámtartományt (pl. külön előtaggal) az AI-asszisztenssel
  hozhatsz létre – kérd meg rá.”). Beállított NAV-kapcsolatnál a NAV rész alján: „A technikai felhasználó
  adatai (jelszó, aláíró- és cserekulcs) biztonsági okból sehol nem jelennek meg. Beállításuk és
  módosításuk – azon a gépen, ahol a program fut: <parancs>” (a 3.4 szerinti `openszamla nav-setup`
  parancs); TESZT környezetben előtte: „TESZT környezet: a számlák csak a NAV tesztrendszerébe kerülnek,
  éles adatszolgáltatás nem történik. Valódi számlázás előtt állítsd éles környezetre – egy új
  terminálablakban, az éles technikai felhasználó adataival:” és az `openszamla nav-setup --env
  production` parancs (3.4), **Parancs másolása** gombbal. Beállítás nélkül vagy hibás beállításnál a NAV részben – a parancsot csak egyszer
  mutatva – a beállítás lépései (mint az Áttekintő Első lépések 2. lépésében, 8.2, **Parancs másolása**
  gombokkal). A NAV-hitelesítő adatok semmilyen oldalon nem jelennek meg.
- **Mentés és ellenőrzés**: a **Mentés készítése most** gomb az adatbázis teljes másolatát írja az
  adatkönyvtár `backups` mappájába `openszamla_<éééé-hh-nn_óóppmm>.db` néven (mint `backup_create`,
  6.22; meglévő fájlt nem ír felül), és megnevezi: „Mentés elkészült (N MB).”, „A mentésfájl: …”, azzal a
  tanáccsal, hogy a gépen kívülre is másolni kell, és visszaállítani az `openszamla restore` paranccsal
  lehet (7.14). Az **Adatbázis ellenőrzése** gomb az `openszamla verify` (7.7) ellenőrzését futtatja:
  „Ellenőrzés: rendben – nem találtam a programon kívüli módosítás nyomát.”, vagy „Ellenőrzés:
  ELTÉRÉST TALÁLT – az adatbázist a programon kívül módosíthatták.”, alatta az ellenőrzött bizonylatok,
  a napló és a megőrzött PDF-ek száma, a talált eltérések csoportonként (csoportonként legfeljebb 20) és
  a figyelmeztetések; eltérésnél a tanács: ép mentés visszaállítása és könyvelői segítség.
- **Rendszer**: a program verziója és az adatkönyvtár.

### 8.6 Export (`/export`)
Időszak kezdete és vége, „Melyik dátum szerint” (kelte szerint / teljesítés dátuma szerint
(ÁFA-időszak) / befizetés dátuma szerint (pénzforgalmi elszámolás); a mező súgója: főszabály szerint a
teljesítés napja az irányadó, pénzforgalmi elszámolásnál az adó a befizetéskor esedékes – a befizetés
dátuma szerinti válogatás a pénzforgalmi elszámolással kiállított bizonylatok közül azokat adja, amelyekre
az időszakban befizetés érkezett, 6.18 –, a befizetési napló pedig mindig a befizetés dátuma szerint
készül), majd CSV (Excel) vagy
JSON letöltés (**CSV letöltése (Excel)**, **JSON letöltése**), NAV XML fájlok készítése (**NAV XML
fájlok készítése**), illetve az időszak befizetési naplójának letöltése (**Befizetési napló (CSV)**,
**Befizetési napló (JSON)** – mint `export_invoices` `ledger: true`, a „Melyik dátum szerint” értékétől
függetlenül) az adatkönyvtár `export/` mappájába (mint
`export_invoices`; a letöltött fájl is ott marad). A NAV XML eredménye megnevezi a dátumalapot, a
mappát, a kihagyott vagy átnevezett fájlú számlákat és az export figyelmeztetéseit (`notes`, 6.18).

**Adóhatósági ellenőrzési adatszolgáltatás** (az oldal második része, mint `tax_audit_export`, 6.19, és
az `openszamla adohatosagi-export`): „Időszak kezdete (kelte)” és „Időszak vége (kelte)”, vagy – ha a
„kezdő sorszám” és a „záró sorszám” ki van töltve – sorszámtartomány (ilyenkor a dátumok nem
számítanak; mindkét sorszám kell, ugyanabból a sorszámtartományból); az **Adatszolgáltatás készítése**
gomb az adatkönyvtár `export/` mappájába írja az exportot, és megnevezi: „Az adóhatósági ellenőrzési
adatszolgáltatás elkészült: N számla (…).”, alatta „Mappa a szerveren: …” és a megjegyzések (6.19). Hibánál
(pl. üres tartomány: „A megadott tartományban nincs kiállított számla.”) a beírt értékek az űrlapon
maradnak. Több ezer bizonylatnál az elkészítés percekig tarthat: ilyenkor a parancssor a javasolt mód.

### 8.7 Biztonság
- Módosító művelet csak a felület saját oldaláról indítható (CSRF-token és eredet-ellenőrzés); más weboldal
  nem indíthat műveletet a nevedben. Az űrlapok legfeljebb 256 kB-osak lehetnek.
- Szigorú tartalombiztonsági szabályok (CSP); minden megjelenített adat kódolva (escape-elve) jelenik meg.
- A hozzáférési token és a NAV-hitelesítő adatok semmilyen oldalon nem jelennek meg; ha mégis bekerülnének
  egy tárolt szövegbe, a felület „[rejtett]” jelöléssel takarja ki őket – a futás közben `nav-setup`-pal
  mentett új adatokat is (a korábbiakat továbbra is). A takarás csak a megjelenítést
  érinti, a tárolt adatot soha: az űrlap olyan mezője, amelynek értékében ilyen titok van, takarva és
  letiltva jelenik meg, alatta: „A mező értéke a hozzáférési tokent vagy egy NAV-hitelesítő adatot
  tartalmaz, ezért rejtve jelenik meg, és itt nem módosítható: az űrlap nem küldi el, mentéskor a mező
  tárolt értéke változatlan marad.” Az eladó, a vevő, a termék és a piszkozat szerkesztésekor az ilyen
  mező a tárolt értékét tartja meg (a „[rejtett]” jelölés nem kerülhet az adatokba, a számlára vagy a
  NAV-hoz); módosítani MCP-n lehet. Ha egy hibás mentés után újra megjelenő űrlapon a most beírt érték
  tartalmazna ilyen titkot, a mező a tárolt értékét (új adatnál üresen) mutatja, és a felület szól:
  „Egy beírt érték a hozzáférési tokent vagy egy NAV-hitelesítő adatot tartalmaz, ezért az űrlapon nem
  jeleníthető meg újra.” – ilyenkor az értéket újra be kell írni.
- Munkamenet vagy token nélkül csak a belépő oldal és a `/healthz` állapotjelző érhető el.
- Reverse proxy mögött a proxynak meg kell őriznie a `Host` fejlécet, vagy `X-Forwarded-Host`-ot kell
  küldenie, különben a felület minden műveletet elutasít. Az `/mcp` próbálgatás elleni korlátja (8.
  fejezet) alapból a kapcsolódó gép címét nézi, az `X-Forwarded-For` fejlécet figyelmen kívül hagyja:
  a proxy mögött minden kliens a proxy címével számít, így egy idegen hibás próbálkozásai a helyes
  tokennel dolgozó klienst is kivárásra kényszeríthetik. Ha a proxy ugyanazon a gépen fut, és maga
  állítja be az `X-Forwarded-For` fejlécet (a Caddy alapból; nginx-nél: `proxy_set_header
  X-Forwarded-For $proxy_add_x_forwarded_for;`), indítsd a szervert `OPENSZAMLA_TRUST_PROXY=1`-gyel
  (3.3): ekkor a fejléc utolsó elemét – a proxy által látott kliens címét – veszi a kliens címének. A
  kliens fejlécét változatlanul továbbadó proxynál (pl. nginx a fenti sor nélkül) vagy TCP-alagútnál
  (ssh -R, frp, ngrok TCP módban) ne kapcsold be: ott a kliens maga írhatna minden kéréséhez új címet
  (a 100-as összesített korlát ekkor is érvényes).

## 9. Adatbiztonság és megőrzés

- A kiállított számla nem módosítható és nem törölhető (adatbázis-szintű védelem, triggerek); a javítás
  új okirattal történik.
- **Az átadott PDF megőrzése:** az e-mailben vagy más elektronikus úton átadott PDF-számla elektronikus
  számla, amelynek hitelességét, sértetlenségét és olvashatóságát a megőrzés végéig biztosítani kell.
  A program minden kiállított bizonylat kiállításkor elkészült PDF-jét eredetiként, bájtra pontosan
  megőrzi az adatbázisban, SHA-256 és SHA3-512 lenyomattal; a megőrzést a hash-láncolt auditnapló is
  rögzíti (`invoice.document`). Később – programfrissítés után is – mindig ezt adja ki (MCP, erőforrás,
  parancssor, web, adóhatósági export), soha nem állítja elő újra; a megőrzött eredetit
  adatbázis-szintű védelem (trigger) óvja a cserétől, módosítástól és törléstől (6.14). A vevőnek ezt
  a PDF-et kell átadni; a lenyomata (`invoice_pdf` `sha256`, `openszamla pdf`) összevethető egy
  máshol tárolt példány lenyomatával. Sérült vagy módosult – a lenyomatával nem egyező – megőrzött
  eredetit a program nem ad ki eredetiként, és a `pdf/` mappában lévő példányt sem írja felül vele
  (DOCUMENT_INTEGRITY_FAILED, 6.14): ilyenkor `openszamla verify`, és visszaállítás egy ép mentésből. Az
  eredeti PDF-ek megőrzése előtt kiállított bizonylatnak
  nincs megőrzött eredetije: a PDF-jét a program kérésre `_UJRAELOALLITOTT` jelöléssel állítja elő, és
  ezt nem tekinti eredetinek.
- A befizetési napló (a rögzített befizetések és felosztásuk, 6.13) csak bővíthető: rögzített sor
  adatbázis-szintű védelem (trigger) miatt nem módosítható és nem törölhető, piszkozathoz nem rögzíthető;
  a téves befizetést ellentétes előjelű összeggel kell visszavonni.
- `openszamla verify` (7.7) kimutatja: ha egy kiállított bizonylat tartalma megváltozott, ha az
  auditnapló lánca megsérült, ha egy naplózott kiállítás bizonylata hiányzik, más sorszámmal vagy más
  tartalommal szerepel (a tartalmi hash újraszámolásával együtt is), ha egy bizonylat a program
  megkerülésével került az adatbázisba, ha a sorszámozásban hézag van, ha egy adatbázis-védelmet
  eltávolítottak vagy módosítottak, és ha egy megőrzött eredeti PDF tartalma vagy lenyomata
  megváltozott, az eredetit kicserélték vagy törölték, illetve a megőrzése nincs naplózva. Ha valaki
  az auditnapló **végéről** vág le bejegyzéseket, a lánc érvényes marad: ez – ha a fenti ellenőrzések
  egyike sem jelzi – csak a korábban feljegyzett utolsó
  bejegyzéssel (a `verify` kiírja) összevetve derül ki. Az adatbázis – az auditnaplóval együtt –
  teljes, önmagában következetes átírása (a láncot kulcs nélküli SHA-256 védi) külön megőrzött utolsó
  bejegyzés vagy mentés nélkül nem mutatható ki; ezért a `verify` által kiírt utolsó bejegyzést a
  mentésekkel együtt őrizd meg.
- Mentés: `openszamla backup <fájl>` (7.8) – rendszeresen, a gépen kívülre is. A megőrzési idő 8 év.
  Visszaállítás: `openszamla restore <mentésfájl>` (7.14), nem a fájl kézi másolásával.
  A mentés a megőrzött eredeti PDF-eket is tartalmazza (az adatbázis bizonylatonként kb. 25–50 KB-tal
  nő, 6.14), így a mentésből visszaállítva is az átadott PDF adható ki, bájtra pontosan.
- Egy régebbi mentés `openszamla restore` paranccsal történő visszaállítása után a sorszámozás a már
  kiadott sorszámok után folytatódik (7.14). Ha viszont a mentést kézzel másolták az adatbázis helyére
  (vagy a mentés nem ennek az adatbázisnak egy korábbi állapota), a program a mentés óta kiadott
  sorszámokat újra kiadja, pedig azok a NAV-nál már egy-egy másik számláé. Az ilyen számlát a NAV ismétlésként utasítja el, a program
  pedig sorszám-ütközésként jelzi (`OPENSZAMLA_NUMBER_COLLISION`, 6.15): nem tekinti jelentettnek, és a
  módosító/sztornó számláját sem küldi be. Ilyenkor a sorszámozást a NAV-nál már foglalt sorszámok után
  kell folytatni (pl. új sorszámtartomány eltérő előtaggal, 6.3), a már kiállított, ütköző számlák
  rendezéséhez pedig szakértői segítség kell. Az elveszett számla PDF-jét – amely a `pdf/` mappában még
  megvan, az adatbázisban már nincs – az újra kiadott sorszámú bizonylat nem írja felül: a program
  kiállításkor `pdf/<sorszám>_KORABBI_<ééééhhnn-óóppmm>.pdf` néven megőrzi, naplózza és a kiállítás
  megjegyzésében megnevezi (6.9, 6.14). Ezt a fájlt őrizd meg (8 évig), és vidd a könyvelődhöz.
- A NAV-hitelesítő adatok nem kerülnek az adatbázisba, a naplóba, hibaüzenetbe vagy MCP-válaszba, és a
  képernyőn sem jelennek meg: az `openszamla nav-setup` a jelszót és a két kulcsot gépelés közben sem
  mutatja (csak a login név látszik), a webes felület semmilyen oldalon nem mutatja őket.

## 10. Korlátok

Lásd [jogi-megfeleles.md](jogi-megfeleles.md#amit-a-01-es-verzió-nem-tud).
