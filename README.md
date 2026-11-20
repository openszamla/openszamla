# OpenSzámla

**Nyílt forráskódú magyar számlázó program, amit AI-ügynökök kezelnek.**
Claude (Claude Code, Claude Desktop, claude.ai), OpenAI Codex és bármely más MCP-kliens
természetes nyelven állít ki számlát, díjbekérőt, sztornó és módosító számlát – a program
pedig gondoskodik a sorszámozásról, az ÁFA-számításról, a kötelező tartalomról, a PDF-ről
és a **NAV Online Számla** adatszolgáltatásról.

> „Állíts ki számlát a Minta Kft.-nek 10 óra szoftverfejlesztésről, 15 000 Ft/óra + ÁFA,
> 8 napos átutalással.” → az ügynök megkeresi a vevőt (NAV adószám-lekérdezéssel), piszkozatot
> készít, megmutatja az előnézetet, a jóváhagyásod után kiállítja, PDF-et ad és jelenti a NAV-nak.

- 🧾 Számla, előlegszámla, végszámla, díjbekérő, **sztornó** és **módosító** számla
- 🏛️ NAV Online Számla v3.0: valós idejű adatszolgáltatás, adószám-lekérdezés, státuszkövetés
- 🤖 MCP szerver 27 eszközzel, erőforrásokkal és promptokkal – stdio és Streamable HTTP, mindkét
  MCP protokoll-generáció (2025-ös és 2026-07-28)
- 🔒 Megváltoztathatatlan kiállított számlák (SQLite triggerek), hézagmentes sorszámozás,
  hash-láncolt auditnapló, szerver által kiadott megerősítő kód minden visszafordíthatatlan művelethez
- 💱 Devizás számla MNB árfolyammal, ÁFA forintban; készpénzes 0/5 Ft kerekítés
- 📄 Magyar (és angol / kétnyelvű) PDF a kötelező szöveges megjelölésekkel
- 📦 Egyetlen helyi fájl az adatbázis (`node:sqlite`, natív függőség nélkül), CSV/JSON/XML export,
  és a kötelező „adóhatósági ellenőrzési adatszolgáltatás” (a 23/2014. NGM rendelet 3. melléklete szerinti XML)

> **Korai változat (0.1).** A program kiterjedt automatikus tesztekkel készült (a NAV-adatot a hivatalos
> sémákkal ellenőrzi), de éles NAV-környezetben és sok felhasználónál még nem bizonyított. Mielőtt éles
> számlát állítasz ki vele: próbáld ki a NAV **teszt**környezetével, egyeztess a könyvelőddel, ments
> rendszeresen (`openszamla backup`), és az első éles számlákat ellenőrizd a NAV Online Számla felületén.
> A program használata a saját felelősségedre történik (MIT licenc, garancia nélkül) – lásd
> [Fontos jogi tudnivalók](#fontos-jogi-tudnivalók) és [Korlátok](docs/jogi-megfeleles.md#amit-a-01-es-verzió-nem-tud).

## Telepítés

Három lépés – a harmadik végigvezet minden beállításon.

**1. Node.js 22.13 vagy újabb** (ajánlott: az aktuális LTS-változat, pl. 24)

| Rendszer | Telepítés |
|---|---|
| Windows 10/11 | PowerShellben vagy a Terminálban: `winget install OpenJS.NodeJS.LTS` – vagy a https://nodejs.org oldalról az LTS-telepítő (a „Tools for Native Modules” jelölő nem kell) |
| macOS | a https://nodejs.org LTS-telepítője, vagy Homebrew-val: `brew install node` |
| Linux | a disztribúció csomagkezelője, ha legalább 22.13-at telepít (`node --version`); különben a NodeSource-csomagok (https://github.com/nodesource/distributions) vagy az nvm |

Utána **nyiss új terminálablakot** (a már nyitottak nem látják az új programot), és ellenőrizd:
`node --version`.

**Windowson** a további parancsokat a Terminálban (PowerShellben) `.cmd` végződéssel írd: `npm.cmd`,
`openszamla.cmd`. A Windows alapbeállítása a PowerShellben letiltja az npm és az OpenSzámla `.ps1`
indítóját („running scripts is disabled on this system”), a `.cmd` változat így is fut. A Parancssorban
(`cmd`) a végződés nélküli parancs is működik. macOS-en és Linuxon a végződés nélküli parancsokat használd.

**2. Az OpenSzámla telepítése**

Windowson (Terminál, PowerShell):

```powershell
npm.cmd install -g openszamla
```

macOS-en és Linuxon:

```bash
npm install -g openszamla
```

Amíg a csomag nem érhető el az npm-en, csomagfájlból telepíthető: a kapott (vagy a forráskódból
`npm install`, `npm run build`, `npm pack` paranccsal készített) `openszamla-<verzió>.tgz` fájl mappájában –
Windowson:

```powershell
npm.cmd install -g .\openszamla-0.1.1.tgz
```

macOS-en és Linuxon:

```bash
npm install -g ./openszamla-0.1.1.tgz
```

Forráskódból, fejlesztéshez: a letöltött mappában `npm install`, `npm run build`, majd `npm link`
(Windows PowerShellben `npm.cmd install` stb.). Ellenőrzés: `openszamla --version` (Windows PowerShellben
`openszamla.cmd --version`).

**3. Első beállítás**

Windowson (Terminál, PowerShell):

```powershell
openszamla.cmd setup
```

macOS-en és Linuxon:

```bash
openszamla setup
```

Lépésenként végigvezet: ellenőrzi a Node.js-t, megmutatja (és létrehozza) az adatkönyvtárat, bekéri az
eladó adatait, kérésre a NAV technikai felhasználóját (előbb a TESZT környezethez), és a kiválasztott
AI-kliensek – Claude Desktop, Claude Code, Codex, Cursor, VS Code – saját beállításába beírja az
OpenSzámlát (a meglévő beállításokat megtartja, előtte biztonsági másolatot készít). Végül megmondja,
mit kérdezz először az AI-tól, és hogyan indul a webes felület (`openszamla serve`). Bármelyik lépés
kihagyható, a parancs újra futtatható. Ellenőrzés bármikor: `openszamla doctor`. Windows PowerShellben a
program által kiírt minden `openszamla …` parancsot `.cmd`-vel írj (pl. `openszamla.cmd doctor`).

### Claude Desktop egy kattintással (.mcpb)

A kiadásokhoz mellékelt `openszamla-<verzió>.mcpb` bővítményt dupla kattintással (vagy Settings →
Extensions → Advanced settings → Install Extension…) telepítheted; parancssor nem kell hozzá. A
telepítő bekéri az adatkönyvtárat és – ha már megvannak – a NAV technikai felhasználó adatait; az
eladó adatait utána az AI-nak mondhatod meg („Állítsd be a cégem adatait: …”). A bővítmény a Claude
Desktop saját vagy a gépre telepített Node.js-ével fut; ha a naplójában a „Node.js 22.13.0 vagy újabb
szükséges” hiba áll, telepítsd az 1. lépés szerint a Node.js-t, és a Claude Desktop Settings →
Extensions → Advanced settings részén kapcsold ki a „Use Built-in Node.js for MCP” beállítást.
Részletek: [docs/kliensek.md](docs/kliensek.md).

### Ha elakadsz

- **PowerShell: „running scripts is disabled on this system” („a parancsfájlok futtatása le van tiltva”)** –
  a Windows alapbeállítása tiltja az npm `.ps1` indítóit. Írd ki a `.cmd` végződést:
  `npm.cmd install -g openszamla`, `openszamla.cmd setup`; vagy engedélyezd egyszer, a saját
  felhasználódnak: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **„'node' is not recognized…” / „A(z) node kifejezés nem ismerhető fel…” rögtön a telepítés után** –
  a már nyitott terminál nem látja az új programot: zárd be, és nyiss újat (ha ez sem segít, jelentkezz
  ki és be).
- **„OpenSzámla: Node.js 22.13.0 vagy újabb szükséges …”** – a Node.js túl régi (`node --version`):
  telepítsd az LTS-változatot az 1. lépés szerint.
- **EACCES a globális telepítésnél (macOS, Linux)** – ne `sudo`-val telepíts: Homebrew-val vagy nvm-mel
  telepített Node.js-nél ez nem fordul elő; vagy adj saját mappát: `npm config set prefix ~/.npm-global`
  (és tedd a `~/.npm-global/bin` mappát a PATH-ra).
- **Proxy mögött** – az npm-nek:
  `npm config set proxy http://proxy.cegem.hu:8080` és
  `npm config set https-proxy http://proxy.cegem.hu:8080`;
  a forgalmat saját tanúsítvánnyal vizsgáló céges hálózatban: `npm config set cafile <tanúsítvány.pem>`.
  A program saját NAV- és MNB-kapcsolata a `HTTPS_PROXY` és a `NODE_OPTIONS=--use-env-proxy` környezeti
  változóval megy a proxyn át (Node.js 24; MCP-kliensnél a szerver `env` beállításában), a céges
  tanúsítványt a `NODE_EXTRA_CA_CERTS=<tanúsítvány.pem>` adja meg.
- **Az AI nem látja az OpenSzámla eszközeit** – `openszamla doctor`: megmutatja, melyik kliens
  beállításában szerepel, létezik-e a beállított parancs, és mit kell javítani. A Claude Desktopból
  beállítás után teljesen ki kell lépni (Windowson a tálcán a Claude ikon → Quit), az ablak bezárása nem
  elég.

## Tartalom

- [Telepítés](#telepítés)
- [Fontos jogi tudnivalók](#fontos-jogi-tudnivalók)
- [A csomagról](#a-csomagról)
- [Első beállítás kézzel](#első-beállítás-kézzel)
- [Csatlakoztatás AI-ügynökhöz](#csatlakoztatás-ai-ügynökhöz)
- [Használat](#használat)
- [MCP eszközök](#mcp-eszközök)
- [Parancssor](#parancssor)
- [Adatok, biztonság, mentés](#adatok-biztonság-mentés)
- [Fejlesztés](#fejlesztés)
- [English summary](#english-summary)

## Fontos jogi tudnivalók

Az OpenSzámla a 2026. októberi jogszabályok (Áfa tv., 23/2014. (VI. 30.) NGM rendelet, NAV
Online Számla v3.0 interfész-specifikáció) alapján készült, de **nem jogi vagy adótanácsadás**,
és a szoftvert „ahogy van” alapon, garancia nélkül adjuk (lásd [LICENSE](LICENSE)). A számlázás
helyességéért a számlát kiállító vállalkozás felel – bizonytalan esetben kérdezd a könyvelődet.

A program használójaként neked kell:

1. **NAV Online Számla regisztráció és technikai felhasználó** – az onlineszamla.nav.gov.hu
   oldalon (előbb a teszt-, majd az éles környezetben) technikai felhasználót hozol létre
   aláíró- és cserekulccsal, és ezt megadod a programnak (`openszamla nav-setup`). NAV-kapcsolat
   nélkül a program kiállít számlát, de figyelmeztet: **minden számláról haladéktalanul adatot kell
   szolgáltatni**, a mulasztás számlánként akár 1 000 000 Ft bírság. A NAV **teszt** környezetébe
   (ez az alapértelmezés) küldött számla nem valódi adatszolgáltatás – a program minden ilyen
   eredményt „TESZT környezet” jelöléssel ad vissza; éles számlázáshoz `production` környezet kell.
2. **Árfolyam-választás bejelentése** – devizás számlánál a program alapból az MNB hivatalos
   árfolyamát használja. Ezt a választást előzetesen be kell jelentened a NAV-nak (Áfa tv. 80. §);
   ha nem tetted meg, állítsd az árfolyamforrást „manual”-ra, és add meg a bankod deviza eladási
   árfolyamát.
3. **Megőrzés** – a számlákat (elektronikus számlát elektronikusan) 8 évig meg kell őrizni:
   ments rendszeresen (`openszamla backup`), és őrizd meg a program dokumentációját is
   ([felhasználói dokumentáció](docs/felhasznaloi-dokumentacio.md)).
4. A „SZAMLAZO” bejelentés a számlázó program használatáról **2021. január 4. óta megszűnt**,
   ilyen teendőd nincs.

Részletek és források: [docs/jogi-megfeleles.md](docs/jogi-megfeleles.md) és
[docs/research/02-jogi-kovetelmenyek.md](docs/research/02-jogi-kovetelmenyek.md).

## A csomagról

Szükséges: **Node.js 22.13.0 vagy újabb** (ajánlott: 24 LTS). Telepítés nélkül is futtatható:
`npx -y openszamla <parancs>` (az első indítás lassabb, és az AI-kliensek beállításába így nem írható
tartós útvonal, ezért ügynökökhöz a globális telepítést ajánljuk). A csomag parancssori program és MCP
szerver; programkönyvtárként (`import`) nem használható.

A program neve **OpenSzámla**, azonosítója (NAV `softwareId`) **OPENSZAMLA-0000001**; a telepített
változat számát az `openszamla --version` írja ki. A változathoz tartozó felhasználói dokumentáció
és a változásnapló a telepített csomag része (`docs/felhasznaloi-dokumentacio.md`, `CHANGELOG.md` –
a csomag mappája: `npm root -g` → `openszamla`), a 0.1.1-es változaté online is:
https://github.com/openszamla/openszamla/blob/v0.1.1/docs/felhasznaloi-dokumentacio.md

## Első beállítás kézzel

Az `openszamla setup` ugyanezt teszi lépésenként; a lépések külön is futtathatók (Windows PowerShellben
`openszamla.cmd init` stb.):

```bash
openszamla init
openszamla nav-setup
openszamla status
openszamla doctor
```

- `openszamla init` – az eladó adatai: név, adószám, cím, bankszámla, ÁFA-státusz;
- `openszamla nav-setup` – a NAV technikai felhasználója (alapból a TESZT környezethez);
- `openszamla status` – állapot és teendők;
- `openszamla doctor` – a telepítés és a beállítások ellenőrzése, javítási tippekkel.

Az adatok alapértelmezett helye `~/.openszamla` (Windows: `C:\Users\<név>\.openszamla`); más
mappa: `OPENSZAMLA_HOME` környezeti változó vagy `--data-dir`, abszolút útvonallal (a `~/…` alakot
a program maga fejti ki). Ha az MCP-kliensnek más adatkönyvtárat adsz meg, a NAV-adatokat is oda
mentsd: `openszamla nav-setup --data-dir <ugyanaz a mappa>` (a pontos parancsot az `openszamla
status` teendői is kiírják). Éles NAV környezet: a `nav-setup` kérdésénél `production`, vagy
`OPENSZAMLA_NAV_ENV=production` – a megadott (nem üres) `OPENSZAMLA_NAV_ENV` felülírja a `nav-setup`
választását.

Az eladói adatokat az ügynök is beállíthatja („Állítsd be a cégem adatait: …”).

## Csatlakoztatás AI-ügynökhöz

A pontos, kliensenkénti leírás: **[docs/kliensek.md](docs/kliensek.md)**. A legegyszerűbb:

```bash
openszamla config claude-desktop --write
```

A `claude-desktop` helyén a kliens lehet `claude-code`, `codex`, `cursor` vagy `vscode` is (Windows
PowerShellben: `openszamla.cmd config …`). Ez a kliens saját beállításába írja az OpenSzámlát (a többi
beállítást megtartja, előtte biztonsági másolatot készít, és kiírja, mit változtatott és hogyan vonható
vissza); meglévő, más `openszamla` bejegyzést csak `--force`-szal cserél le. A `--write` nélkül csak kiírja a bemásolható konfigurációt
(`--data-dir <mappa>` megadásával a nem alapértelmezett adatkönyvtárral együtt). A beírt parancs a
Node.js és az OpenSzámla abszolút útvonala, így a kliens parancsértelmező és PATH nélkül is elindítja
(Windowson az `openszamla` és az `npx` parancsértelmezőt igénylő `.cmd` fájl, macOS-en az asztali
alkalmazások nem látják a terminál PATH-ját). Az alábbi rövid forma (`"command": "openszamla"`) akkor
működik, ha a kliens megtalálja az `openszamla` parancsot.

**Claude Code**

```bash
claude mcp add --transport stdio --scope user openszamla -- openszamla mcp
```

**OpenAI Codex (CLI és IDE)**

```bash
codex mcp add openszamla -- openszamla mcp
```

vagy `~/.codex/config.toml`:

```toml
[mcp_servers.openszamla]
command = "openszamla"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

**Claude Desktop** – `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, a Microsoft Store-os
változatnál `%LOCALAPPDATA%\Claude-Data\claude_…\`, régebbi kiadásainál
`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\`; macOS:
`~/Library/Application Support/Claude/`; Linux: `~/.config/Claude/`; az
`openszamla config claude-desktop --write` a gépen használt fájlba írja):

```json
{
  "mcpServers": {
    "openszamla": { "command": "openszamla", "args": ["mcp"] }
  }
}
```

**claude.ai, ChatGPT, távoli kliensek** – `openszamla serve` Streamable HTTP végpontot ad
(`/mcp`, Bearer tokennel vagy `/mcp/<token>` alakban, alapból csak `127.0.0.1`-en). Nyilvános
eléréshez HTTPS reverse proxy kell; lásd [docs/kliensek.md](docs/kliensek.md).

Mellékeltünk egy **skillt** is ([skills/magyar-szamlazas/SKILL.md](skills/magyar-szamlazas/SKILL.md)),
ami a magyar számlázási munkamenetre tanítja az ügynököt (Claude Code pluginként és Codex skillként is).

## Használat

Példák, amiket az ügynöknek mondhatsz:

- „Mi a helyzet a számlázóval?” – beállítások, függő NAV-jelentések, teendők
- „Keresd ki a 12345676 adószámú céget a NAV-nál, és mentsd el vevőként.”
- „Állíts ki számlát Kovács Annának (magánszemély, 1111 Budapest, Fő utca 1.) egy 12 990 Ft-os
  bruttó árú könyvről, készpénzes fizetéssel.”
- „Készíts díjbekérőt az Alfa Kft.-nek 300 000 Ft + ÁFA tanácsadásról.” – majd fizetés után:
  „A díjbekérőből állíts ki számlát.”
- „Ugyanazt számlázd ki, mint múlt hónapban a Béta Bt.-nek.”
- „Sztornózd az SZ-2026-00042-es számlát, mert rossz vevőre állítottuk ki.”
- „Az SZ-2026-00040-es számlán utólag adj 10% árengedményt.” (módosító számla)
- „Mennyi volt az októberi forgalom és ÁFA? Melyik számlák lejártak?”
- „Exportáld a harmadik negyedév számláit a könyvelőnek.”

A kiállítás mindig két lépésben történik: az ügynök előbb **előnézetet** mutat, és csak a te
jóváhagyásod után – a szerver által adott megerősítő kóddal – állítja ki a számlát.

### Webes felület

Ügynök nélkül a böngészőből is számlázhatsz: az `openszamla serve` elindítja a webes felületet
(alapból `http://127.0.0.1:8787`, csak a saját gépedről érhető el), és kiírja a belépési címet
(`…/?token=…`) – azt megnyitva be is léptet. Első indításkor az Áttekintő **Első lépések** útmutatója
végigvezet a beállításon: eladó adatai → NAV-kapcsolat (először a TESZT rendszerrel; a beállító parancsot
egy kattintással kimásolhatod, a beépített adatkönyvtárnál egyszerűen `openszamla nav-setup`) → első vevő →
első számla. A teendőket az Áttekintő a saját szavaival, a hozzájuk tartozó gombbal vagy hivatkozással
mutatja. A számla tételsoraiban a mentett termékek közül is választhatsz (a sor magától kitöltődik), a
díjbekérőből egy kattintással számlapiszkozat lesz (a rögzített befizetés átkerül rá), egy korábbi
számlából pedig új a mintájára. Itt is két lépés a kiállítás: a mentés piszkozatot készít, a kiállítás
külön, a következmények felsorolásával és megerősítéssel történik, és a gombok megmondják, mi következik
(pl. „Számla kiállítása és beküldése a NAV-nak”, TESZT környezetben „… a NAV TESZT rendszerébe”). A
felület telefonon, világos és sötét módban, billentyűzettel és JavaScript nélkül is használható.
Részletek: [felhasználói dokumentáció, 8. fejezet](docs/felhasznaloi-dokumentacio.md#8-webes-felület).

## MCP eszközök

| Eszköz | Mire való |
|---|---|
| `setup_status` | állapot, eladó, sorszámtartományok, NAV-kapcsolat, teendők |
| `seller_update` | eladó adatai, számlázási alapértelmezések |
| `series_manage` | sorszámtartományok (pl. `SZ-{YYYY}-{SEQ:5}`) |
| `taxpayer_lookup` | adószám-lekérdezés a NAV-tól |
| `customer_save`, `customer_find` | vevők |
| `product_save`, `product_find` | termékek, szolgáltatások |
| `invoice_draft` | piszkozat létrehozása / módosítása, előnézet + megerősítő kód |
| `invoice_get`, `invoice_list` | számlák lekérdezése, keresése |
| `invoice_issue` | **kiállítás** (visszafordíthatatlan) |
| `invoice_cancel_preview`, `invoice_cancel` | **sztornó** előnézet és végrehajtás |
| `invoice_correct` | módosító számla piszkozata |
| `invoice_delete_draft` | piszkozat törlése |
| `invoice_record_payment` | befizetés rögzítése (sztornón a vevőnek visszafizetett összegé) |
| `invoice_pdf` | a kiállításkor megőrzött eredeti PDF (lenyomattal) / másolása helyi mappába |
| `nav_sync` | NAV-jelentés és státusz-frissítés |
| `nav_send_to_configured_environment` | a másik NAV-rendszerhez tartozó (pl. csak a TESZT rendszerbe jelentett) számla beküldése (visszafordíthatatlan) |
| `exchange_rate` | MNB árfolyam |
| `report_summary` | időszaki forgalom, ÁFA (pénzforgalmi elszámolásnál a befizetés dátuma szerint is), kintlévőség |
| `export_invoices` | CSV / JSON / NAV XML export, befizetési napló |
| `tax_audit_export` | **adóhatósági ellenőrzési adatszolgáltatás** (23/2014. NGM rendelet 11/A. §) |
| `audit_log` | auditnapló |
| `backup_create` | az adatbázis mentése az adatkönyvtár `backups` mappájába |
| `verify_integrity` | annak ellenőrzése, hogy az adatbázist nem módosították a programon kívül |

Részletes leírás minden eszközről és paraméterről:
[docs/felhasznaloi-dokumentacio.md](docs/felhasznaloi-dokumentacio.md).

## Parancssor

```text
openszamla setup               első beállítás lépésenként (adatkönyvtár, eladó, NAV, AI-kliensek)
openszamla doctor              a telepítés és a beállítások ellenőrzése, javítási tippekkel
openszamla mcp                 MCP szerver stdio-n
openszamla serve               MCP Streamable HTTP + webes felület (127.0.0.1:8787)
openszamla init                eladói adatok
openszamla nav-setup           NAV technikai felhasználó (a jelszó és a kulcsok gépeléskor rejtve)
openszamla nav-send-to-configured-environment <sorszám> [--confirm]
                               a csak a másik NAV-rendszerbe jelentett számla beküldése a beállítottba
openszamla status              állapot
openszamla list | show | pdf   számlák
openszamla export              export időszakra (csv, json, xml; kelte, teljesítés vagy befizetés szerint; --ledger: befizetési napló)
openszamla adohatosagi-export  adóhatósági ellenőrzési adatszolgáltatás (dátum- vagy sorszámtartomány)
openszamla verify              számla-hash-ek, auditlánc, sorszámfolytonosság ellenőrzése
openszamla backup <fájl>       adatbázis mentése
openszamla restore <fájl>      mentés visszaállítása (--confirm nélkül csak előnézet; a régi adatbázist félreteszi)
openszamla config <kliens>     MCP konfiguráció kiírása; --write: beírás a kliens beállításába
openszamla install-skill <cél> a skill bemásolása (claude | codex)
```

Minden parancs és kapcsoló leírása: [docs/felhasznaloi-dokumentacio.md](docs/felhasznaloi-dokumentacio.md#7-parancssor).

## Adatok, biztonság, mentés

- Minden adat a gépeden marad: `~/.openszamla/openszamla.db` (SQLite), `pdf/`, `export/`. Az
  adatkönyvtárat ne tedd OneDrive-mappába vagy hálózati meghajtóra – ott az adatbázis megsérülhet; az
  `openszamla doctor` és az `openszamla setup` figyelmeztet is rá –, a mentéseket (`openszamla backup`)
  viszont nyugodtan. Mentést visszaállítani az `openszamla restore <fájl>` paranccsal kell, nem a fájl
  kézi másolásával: a parancs ellenőrzi a mentést, félreteszi (nem törli) a jelenlegi adatbázist, és a
  sorszámozást a már kiadott sorszámok után folytatja.
- A NAV hitelesítő adatai környezeti változóból (`OPENSZAMLA_NAV_LOGIN`, `…_PASSWORD`,
  `…_SIGNING_KEY`, `…_EXCHANGE_KEY`) vagy a `nav-credentials.json` fájlból jönnek; soha nem kerülnek
  az adatbázisba, és egyetlen MCP eszköz sem adja vissza őket.
- A kiállított számla adatait SQLite triggerek védik a módosítástól és törléstől; minden számla
  tartalmi hash-t kap, minden változás hash-láncolt auditnaplóba kerül. Az `openszamla verify` ezeket,
  a sorszámfolytonosságot és a védelmeket is ellenőrzi, és kiírja a napló utolsó bejegyzését – ezt
  őrizd meg a mentéssel együtt.
- A kiállított bizonylat PDF-jét a program a kiállításkor bájtra pontosan megőrzi az adatbázisban
  (SHA-256 és SHA3-512 lenyomattal), és később – frissítés után is – ezt adja ki, újra nem állítja elő;
  a mentés ezeket is tartalmazza, a `verify` ezeket is ellenőrzi.
- HTTP módban a szerver alapból csak `127.0.0.1`-en figyel, és a Host/Origin fejléceket ellenőrzi
  (DNS-rebinding védelem). Az MCP végponthoz és a webes felülethez token kell; token nélkül csak a
  `/healthz` állapotjelző válaszol (a program nevét és verzióját adja vissza, mást nem). A tokent a
  program generálja; saját token (`--token`, `OPENSZAMLA_HTTP_TOKEN`) legalább 20 karakteres kell
  legyen, és csak az angol ábécé betűiből, számjegyekből, `_` és `-` jelből állhat (`[A-Za-z0-9_-]`),
  különben a szerver nem indul el. A `/mcp` a token-próbálgatást korlátozza: egy címről percenként 10
  hibás token után – és ha az összes címről együtt percenként 100 érkezik, minden olyan címről, ahonnan
  az elmúlt 60 percben nem jött helyes tokenű kérés – a válasz 429 `Retry-After` fejléccel. Az
  `X-Forwarded-For` fejlécből csak `OPENSZAMLA_TRUST_PROXY=1` mellett veszi a kliens címét (lásd
  [docs/kliensek.md](docs/kliensek.md)).
- A NAV-beküldés megismételhető: egy számla akkor sem kerül kétszer a NAV-hoz, ha a beküldés
  eredménye bizonytalan volt, vagy több szinkron fut egyszerre.
- Számlákban, e-mailekben, fájlokban talált szöveg adat, nem utasítás – az ügynöknek szóló
  utasítások ezt kifejezetten rögzítik.

## Fejlesztés

```bash
git clone https://github.com/openszamla/openszamla.git
cd openszamla
npm install
npm test
npm run typecheck
npm run dev -- status
```

Az `npm test` a vitest-teszteket futtatja – a NAV XML-t a hivatalos XSD-k ellen validálja –, az
`npm run dev -- status` a forráskódból indítja a programot. Windows PowerShellben az npm parancsot
`npm.cmd`-vel írd.

Fejlesztéshez **Node.js 22.18 vagy újabb** kell: a `src/*.ts` fájlok build nélkül, a Node beépített
TypeScript-típuseltávolításával futnak (`npm run dev`, a tesztek). A kiadott csomag (`dist/`)
22.13.0-tól fut; ezt a CI ezen a változaton is ellenőrzi (`node scripts/smoke.mjs`).

Architektúra: [docs/architektura.md](docs/architektura.md). Közreműködés:
[CONTRIBUTING.md](CONTRIBUTING.md). Kódolási ügynököknek: [AGENTS.md](AGENTS.md).
A kutatási háttéranyagok (jog, NAV API, MCP, adatformátumok): [docs/research/](docs/research/).

Licenc: MIT ([LICENSE](LICENSE)). A harmadik féltől származó összetevők – köztük a PDF-ekbe ágyazott
Roboto betűkészlet (SIL Open Font License 1.1) – licencei: [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

## English summary

OpenSzámla is an open-source Hungarian invoicing program designed to be operated by AI agents
through the **Model Context Protocol**. It issues invoices, advance/final invoices, pro-forma
requests, cancellations (storno) and corrections, computes Hungarian VAT, renders PDFs, and reports
every invoice in real time to the Hungarian tax authority (**NAV Online Számla v3.0**). Issued
invoices are immutable (SQLite triggers), numbering is gap-free, every irreversible operation
requires a server-issued confirmation code, and all changes go to a hash-chained audit log.
It runs locally (Node.js ≥ 22.13.0, built-in `node:sqlite`) and works with Claude Code, Claude
Desktop, claude.ai custom connectors, OpenAI Codex and any MCP client (stdio or Streamable HTTP).
Licensed under MIT. Not legal or tax advice.
