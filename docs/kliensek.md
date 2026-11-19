# MCP-kliensek beállítása

Az OpenSzámla egy MCP (Model Context Protocol) szerver. Bármely MCP-kliens használhatja; az
alábbiakban a gyakoriak beállítása szerepel (2026. októberi állapot, a kliensek dokumentációja és
forráskódja alapján – lásd [research/04-mcp-claude-codex.md](research/04-mcp-claude-codex.md)).

Előfeltétel mindegyikhez a Node.js 22.13.0 vagy újabb és a program (a telepítés lépései és a gyakori
hibák: [README – Telepítés](../README.md#telepítés)). Utána egyetlen parancs elvégzi a beállítást – az
adatkönyvtárat, az eladói adatokat, a NAV-kapcsolatot (előbb a teszt környezethez), az AI-klienseket és
a skillt:

```bash
openszamla setup
```

Windows PowerShellben (a Terminál alapértelmezése) a parancsokat `.cmd` végződéssel írd
(`openszamla.cmd setup`, `openszamla.cmd config claude-desktop --write` …): a Windows alapbeállítása ott
letiltja az npm-es `.ps1` indítókat („running scripts is disabled on this system”). A Parancssorban
(`cmd`) a végződés nélküli parancs is működik.

A `setup` megkérdezi, melyik klienst csatlakoztassa, és a kliens saját beállításába írja az OpenSzámlát;
terminál nélkül (szkriptből) a `--client claude-desktop,codex,…` kapcsoló adja meg őket. A lépések
külön is elvégezhetők:

```bash
openszamla init
openszamla nav-setup
openszamla config claude-desktop --write
openszamla doctor
```

- `openszamla init` – az eladói adatok;
- `openszamla nav-setup` – a NAV technikai felhasználója (alapból a teszt környezethez);
- `openszamla config claude-desktop --write` – a kliens beállítása; a `claude-desktop` helyén `claude-code`,
  `codex`, `cursor` vagy `vscode` is állhat;
- `openszamla doctor` – ellenőrzés: melyik kliensben van benne, működik-e a parancsa.

Az `openszamla config <kliens> --write` a kliens saját konfigurációs fájljába írja a bejegyzést: a többi
szervert és beállítást megtartja, előtte időbélyeges biztonsági másolatot készít mellé, és kiírja, mit
változtatott és hogyan vonható vissza. Meglévő, más `openszamla` bejegyzést csak `--force`-szal cserél
le. A beírt parancs a Node.js és az OpenSzámla abszolút útvonala (pl. `"command": "C:\\Program
Files\\nodejs\\node.exe"`, `"args": ["…\\openszamla\\dist\\cli\\main.js", "mcp"]`): így a kliens
parancsértelmező és PATH nélkül is elindítja. Ez Windowson számít, ahol az `openszamla` és az `npx`
parancsértelmezőt igénylő `.cmd` fájl, és macOS-en, ahol a Dockról indított asztali alkalmazások nem
látják a terminál PATH-ját. Node.js-frissítés vagy -áthelyezés után az `openszamla doctor` jelzi, ha az
útvonal elavult; javítás: `openszamla config <kliens> --write --force`. A `--write` nélkül a parancs csak
kiírja a bemásolható konfigurációt (`claude-code`, `claude-desktop`, `codex`, `vscode`, `cursor`, `http`).

Ha a kliens beállításaiban nem az alapértelmezett adatkönyvtárat adod meg (`OPENSZAMLA_HOME`, a
bővítmény vagy a plugin „Adatkönyvtár” beállítása), a parancsokat is azzal futtasd: `openszamla setup
--data-dir <mappa>`, illetve `openszamla init --data-dir <mappa>`, `openszamla nav-setup --data-dir
<mappa>` – különben az adatok a `~/.openszamla` mappába kerülnek, ahol a szerver nem keresi őket. A
pontos parancsot a szerver `setup_status` teendői is kiírják, az eltérést az `openszamla doctor` jelzi.

**Adatkönyvtár a kliens beállításaiban.** Az alapértelmezett `~/.openszamla`-hoz semmit nem kell
megadni. Más mappát (`OPENSZAMLA_HOME`) **abszolút útvonallal** adj meg: a kliensek a szervert
parancsértelmező nélkül indítják, a munkakönyvtár pedig kliensenként (Claude Code-nál projektenként)
más, így egy relatív útvonal mindenhol külön, üres adatbázist – és külön sorszámozást – eredményezne
(a szerver ilyenkor figyelmeztet a naplójában). A `~/…` alakot a program maga kifejti; a kliens által
ki nem fejtett változót (`${…}`, `$HOME/…`, `%USERPROFILE%\…`) hibaüzenettel elutasítja.

**NAV-beállítások sorrendje.** Ha az `OPENSZAMLA_NAV_LOGIN` (a jelszóval és a két kulccsal együtt) meg
van adva, a program ezeket használja, különben az adatkönyvtár `nav-credentials.json` fájlját (amit az
`openszamla nav-setup` ír). A megadott `OPENSZAMLA_NAV_ENV` (`test` / `production`) felülírja a
`nav-setup`-ban választott környezetet. Az üres, illetve a kliens által ki nem fejtett `${…}` érték
„nincs megadva”: a bővítmény és a plugin üresen hagyott NAV-beállításai így nem írják felül a
`nav-setup` választását.

> Globális telepítés nélkül a `"command": "npx", "args": ["-y", "openszamla", "mcp"]` forma is
> használható, de az első indítás (letöltés) lassú, a kliensek indítási időkorlátja (pl. Claude Code:
> 30 s) ezt kevésnek találhatja, és Windowson az `npx` csak olyan kliensből indul, amely a `.cmd`
> fájlokat is elindítja. Az alábbi kézi példák rövid `openszamla` parancsa ugyanígy csak akkor működik,
> ha a kliens megtalálja; a biztos forma az, amit a `config <kliens> --write` beír.

## Claude Code

```bash
openszamla config claude-code --write
```

Ha a `claude` parancs a PATH-on közvetlenül indítható program, ez parancsértelmező nélkül lefuttatja a
`claude mcp add … --scope user openszamla -- "<node>" "<main.js>" mcp` parancsot; ha nem (például
Windowson az npm-mel telepített `claude.cmd`), kiírja, mit futtass. Kézzel, rövid formában:

```bash
claude mcp add --transport stdio --scope user openszamla -- openszamla mcp
```

- `--scope user`: minden projektben elérhető; `--scope project`: a projekt `.mcp.json` fájljába kerül
  (verziókezelhető, első használatkor jóváhagyást kér).
- Más adatkönyvtár (abszolút útvonallal):
  `claude mcp add -e "OPENSZAMLA_HOME=/út/a/mappához" --transport stdio --scope user openszamla -- openszamla mcp`.
  A `-e` a következő kapcsolóig minden értéket környezeti változónak vesz, ezért közvetlenül utána egy
  másik kapcsoló (itt `--transport`) álljon, ne a szerver neve. A saját mappádra kitöltött parancsot
  az `openszamla config claude-code --data-dir <mappa>` írja ki.
- Ellenőrzés: `claude mcp list`, a munkamenetben `/mcp`.

Projekt-szintű `.mcp.json` (minden projekt ugyanazt, a felhasználói `~/.openszamla` adatbázist
használja – ugyanazt, amit a parancssor és a webes felület):

```json
{
  "mcpServers": {
    "openszamla": {
      "type": "stdio",
      "command": "openszamla",
      "args": ["mcp"]
    }
  }
}
```

Más adatkönyvtárhoz: `"env": { "OPENSZAMLA_HOME": "<abszolút útvonal>" }` – relatív útvonal a projekt
mappájához képest értelmeződne (projektenként külön adatbázis), ezért ne használd.

**Plugin (MCP szerver + skill egyben):**

```text
/plugin marketplace add openszamla/openszamla
/plugin install openszamla@openszamla
```

A plugin beállításai (`/plugin` → *Configure*): **Adatkönyvtár** – üresen hagyva `~/.openszamla`; ha
megadod, a NAV-adatokat is oda mentsd: `npx -y openszamla nav-setup --data-dir <ugyanez a mappa>`.
**NAV környezet** – üresen hagyva a `nav-setup`-ban választott környezet érvényes; ha kitöltöd
(`test` vagy `production`), felülírja azt.

**Csak a skill:** `openszamla install-skill claude` (a `~/.claude/skills/magyar-szamlazas` mappába másol).

A promptok perjeles parancsként érhetők el: `/mcp__openszamla__szamla_kiallitas`,
`/mcp__openszamla__havi_zaras`, `/mcp__openszamla__nav_hibaelharitas`. Az erőforrások `@`-tal
hivatkozhatók (pl. egy számla JSON-ja vagy PDF-je).

A visszafordíthatatlan eszközök – a kiállítás (`invoice_issue`), a sztornó (`invoice_cancel`) és a
másik NAV-rendszerhez tartozó (pl. csak a TESZT rendszerbe jelentett) számla beküldése a beállított
rendszerbe (`nav_send_to_configured_environment`) – minden hívásnál engedélyt kérnek
(`destructiveHint` + `anthropic/requiresUserInteraction`), és a szerver is csak az előnézethez kiadott
megerősítő kóddal hajtja végre őket (`elicit` módban ezen felül a kliens párbeszédablakában adott
jóváhagyással). Az utóbbi előnézetét és kódját a `nav_sync { invoice, resubmitFailed: true }` adja – a
`nav_sync` maga ilyen számlát soha nem küld be. Egy `nav_sync`-hívás legfeljebb kb. 45 másodpercig
foglalkozik a NAV-val, így a kliens (alapból kb. 60 másodperces) időkorlátja előtt válaszol; amit nem
ért el, azt a `notProcessed` sorolja fel.

## Claude Desktop

**A) Bővítmény (.mcpb)** – a kiadások mellé csatolt `openszamla-<verzió>.mcpb` fájlt nyisd meg
dupla kattintással (vagy Settings → Extensions → Advanced settings → Install Extension…). A telepítő
bekéri az adatkönyvtárat és – opcionálisan – a NAV technikai felhasználó adatait, amiket a Claude
Desktop biztonságosan tárol. Ha a NAV-adatokat inkább az `openszamla nav-setup --data-dir <a bővítmény
adatkönyvtára>` paranccsal mented (a futó bővítmény újraindítás nélkül átveszi őket), a bővítmény
NAV-mezőit hagyd üresen: az üres **NAV környezet** a
`nav-setup` választását hagyja érvényben, a kitöltött felülírja. A bővítmény a szerver három
promptját (`szamla_kiallitas`, `havi_zaras`, `nav_hibaelharitas`) is felkínálja. Saját build:
`npm run build:mcpb`. A bővítményhez Node.js 22.13.0 vagy újabb kell: a Claude Desktop a sajátját vagy a
gépre telepítettet használja. Ha a bővítmény naplójában a „Node.js 22.13.0 vagy újabb szükséges” hiba
áll, telepítsd a Node.js LTS-változatát, és a Settings → Extensions → Advanced settings részen kapcsold
ki a „Use Built-in Node.js for MCP” beállítást.

**B) Konfigurációs fájl** – a program beírja:

```bash
openszamla config claude-desktop --write
```

Ez megkeresi a gépen használt fájlt (a Microsoft Store-os Windows-telepítésnél is), a meglévő
beállításokat megtartja, biztonsági másolatot készít, és kiírja a visszavonás parancsát. Utána **lépj
ki teljesen** a Claude Desktopból (Windowson a tálcán, az óra mellett a Claude ikon → Quit; macOS-en
Cmd+Q), és indítsd újra – az ablak bezárása nem elég. Kézzel: Settings → Developer → Edit Config, vagy
közvetlenül:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux (nem hivatalos változatok): `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openszamla": {
      "command": "openszamla",
      "args": ["mcp"],
      "env": { "OPENSZAMLA_HOME": "C:\\Users\\Te\\Documents\\OpenSzamla" }
    }
  }
}
```

A NAV-adatokat ugyanebbe a mappába mentsd: `openszamla nav-setup --data-dir "C:\Users\Te\Documents\OpenSzamla"`
(a futó szerver újraindítás nélkül átveszi őket). A konfigurációs fájl mentése után indítsd újra a
Claude Desktopot. Naplók: Windows `%APPDATA%\Claude\logs` (a Microsoft Store-os változatnál
`%LOCALAPPDATA%\Claude\logs`), macOS `~/Library/Logs/Claude` (`mcp-server-openszamla.log`; a `mcp.log`
megmutatja, mely szervereket indította el a Claude Desktop).

> Ismert buktató: a Microsoft Store-os (MSIX) Windows-telepítés a klasszikus `%APPDATA%\Claude\` helyett
> máshol tartja a fájlt. Az újabb kiadások a saját adatmappájukban
> (`%LOCALAPPDATA%\Claude-Data\claude_…\claude_desktop_config.json`) – a többi beállításukkal együtt, és
> csak ezt olvassák –, a régebbiek a `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\` alatt.
> Az `openszamla config claude-desktop --write` az újabb kiadások adatmappáját írja, ha az létezik (az
> app többi beállításához nem nyúl), egyébként a régebbiek fájlját, ha létezik, vagy ha a klasszikus fájl
> nem létezik, de ez a mappa igen; kiírja, melyiket írta, és az `openszamla doctor` mindegyiket megnézi.
> Ha a beállítás így sem jelenik meg, használd az A) módszert.

## claude.ai (és Claude Desktop/mobil) – egyedi connector

A claude.ai az Anthropic felhőjéből kapcsolódik, ezért a szervernek **nyilvános HTTPS címen** kell
elérhetőnek lennie (localhost nem működik). Ez a mód a saját gépeden futó számlázót az internet felé
nyitja – csak akkor használd, ha érted a kockázatot.

1. Futtasd HTTP módban, a nyilvános hostnév engedélyezésével (az `OPENSZAMLA_TRUST_PROXY=1`-ről lásd a
   2. lépést):

   ```bash
   OPENSZAMLA_ALLOWED_HOSTS=szamla.example.hu OPENSZAMLA_ALLOWED_ORIGINS=https://szamla.example.hu \
     OPENSZAMLA_TRUST_PROXY=1 openszamla serve --host 127.0.0.1 --port 8787
   ```

2. Tegyél elé HTTPS reverse proxyt (pl. Caddy), és korlátozd az Anthropic IP-tartományára
   (`160.79.104.0/21`):

   ```text
   szamla.example.hu {
     @notclaude not remote_ip 160.79.104.0/21
     respond @notclaude 403
     reverse_proxy 127.0.0.1:8787
   }
   ```

   A Caddy megőrzi a `Host` fejlécet; más proxynál (pl. nginx) ezt neked kell beállítanod
   (`proxy_set_header Host $host;`), különben a szerver és a webes felület elutasítja a kéréseket.
   A token-próbálgatás elleni korlát (lent) az `X-Forwarded-For` fejlécet alapból figyelmen kívül
   hagyja: `OPENSZAMLA_TRUST_PROXY` nélkül a proxy mögötti minden kliens a proxy címével számít, így
   egy idegen hibás próbálkozásai a claude.ai-összekötőt is kivárásra kényszeríthetik. Az
   `OPENSZAMLA_TRUST_PROXY=1` mellett a szerver a fejléc utolsó elemét veszi a kliens címének – ezért
   ilyenkor a proxynak magának kell beállítania a fejlécet: a Caddy ezt alapból megteszi, nginx-nél
   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` kell (enélkül az nginx a kliens saját
   fejlécét adná tovább, és a kliens maga választhatna címet). TCP-alagút (ssh -R, frp, ngrok TCP
   módban) mögött ne kapcsold be.

3. claude.ai → Customize → Connectors → **Add custom connector**. URL:
   `https://szamla.example.hu/mcp/<token>` (a token a `~/.openszamla/http-token` fájlban van), a
   hitelesítésnél „No sign in”. A token az URL-ben van, ezért kezeld jelszóként; cseréjéhez töröld a
   fájlt és indítsd újra a szervert.

A `/healthz` cím token nélkül is válaszol (`{"ok":true,"name":"openszamla","version":"…"}`, más adatot
nem ad ki) – a proxy állapotfigyeléséhez használható. Minden más címhez token kell.

**Token-próbálgatás ellen** a `/mcp` (és a `/mcp/<token>`) egy címről percenként legfeljebb 10 hibás
tokent fogad el; utána arról a címről egy ideig minden kérés – a helyes tokenes is – 429-es választ
kap `Retry-After` fejléccel. Ha egy percen belül összesen 100 hibás kísérlet érkezik, utána csak az a
cím küldhet tokent, ahonnan az elmúlt 60 percben helyes tokenű kérés jött; minden más cím kivár. A
már dolgozó, helyes tokenű kliensre (itt a claude.ai-összekötőre) a más címekről érkező próbálkozások
így nincsenek hatással. A címet a szerver csak `OPENSZAMLA_TRUST_PROXY=1` mellett, a saját gépéről
érkező kapcsolatnál veszi az `X-Forwarded-For` fejléc utolsó eleméből (lásd fent). Részletek:
[felhasználói dokumentáció, 8. fejezet](felhasznaloi-dokumentacio.md#8-webes-felület).

HTTP módban az `invoice_pdf` alapból nem másol a szerver gépének mappáiba (`copyToDir` →
FILE_COPY_DISABLED). A PDF-et ugyanennek a szervernek a webes felülete adja („PDF letöltése”,
`/invoices/<id>.pdf`), illetve az eszköz erőforrás-hivatkozása, ha a kliens beolvassa
(`resources/read`; a claude.ai ezt nem minden esetben teszi meg). Ha mégis kell a másolás (pl. a
szerverrel azonos gépen futó HTTP-kliensnél), a szerver gépén az `OPENSZAMLA_ALLOW_FILE_COPY=1`
engedélyezi.

Az OAuth-alapú bejelentkezés (claude.ai „Sign in”) a következő verziók egyike lesz.

## OpenAI Codex (CLI és IDE-bővítmény)

```bash
openszamla config codex --write
```

Ez a `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`; megadott `CODEX_HOME` esetén
az abban lévő) végére egy `[mcp_servers.openszamla]` táblát ír, literális TOML-szövegekkel (a
`"C:\Users\…"` alakú, kézzel írt útvonal a `\U` miatt hibás TOML, és a Codex az egész fájlt nem tölti
be); meglévő `openszamla` táblát csak `--force`-szal cserél le. Kézzel: `codex mcp add openszamla --
openszamla mcp`, vagy a `config.toml` – a CLI, az IDE-bővítmény és a ChatGPT asztali alkalmazás közösen
használja:

```toml
[mcp_servers.openszamla]
command = "openszamla"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 300
default_tools_approval_mode = "auto"   # az eszközök annotációi döntenek

# A kiállítás, a sztornó és a másik NAV-rendszerhez tartozó számla beküldése mindig kérjen jóváhagyást:
[mcp_servers.openszamla.tools.invoice_issue]
approval_mode = "prompt"

[mcp_servers.openszamla.tools.invoice_cancel]
approval_mode = "prompt"

[mcp_servers.openszamla.tools.nav_send_to_configured_environment]
approval_mode = "prompt"
```

- A Codex a szerver folyamatának **csak engedélyezett környezeti változókat** ad át. Más adatkönyvtárhoz:
  `env = { OPENSZAMLA_HOME = 'C:\Users\Te\OpenSzamla' }`; a NAV-adatokhoz vagy a `openszamla nav-setup`
  által írt fájlt használd (ajánlott; más adatkönyvtárnál `openszamla nav-setup --data-dir
  "C:\Users\Te\OpenSzamla"`), vagy engedd át a változókat:
  `env_vars = ["OPENSZAMLA_NAV_LOGIN", "OPENSZAMLA_NAV_PASSWORD", "OPENSZAMLA_NAV_SIGNING_KEY", "OPENSZAMLA_NAV_EXCHANGE_KEY", "OPENSZAMLA_NAV_ENV"]`.
- A Codex a modellnek csak a `structuredContent`-et mutatja – az OpenSzámla minden válaszában ez teljes.
- A Codex nem támogatja az MCP promptokat; helyettük használd a skillt: `openszamla install-skill codex`
  (a `~/.agents/skills/magyar-szamlazas` mappába másol), majd `$magyar-szamlazas` vagy `/skills`.
- Ellenőrzés: `codex mcp list`, a TUI-ban `/mcp`.

HTTP mód (pl. ha a szerver egy másik gépen fut):

```bash
codex mcp add openszamla-http --url http://127.0.0.1:8787/mcp --bearer-token-env-var OPENSZAMLA_HTTP_TOKEN
```

- Az `OPENSZAMLA_HTTP_TOKEN` értéke a szerver `http-token` fájljának tokenje. Ha ugyanebben a
  terminálban indítod az `openszamla serve`-öt is, a változót az is látja: a fájléval azonos tokent a
  mentett tokennek tekinti (régi, gyenge mentett tokennél is elindul, figyelmeztetéssel), más értéket
  saját tokenként kezel.
- Hibás tokennel a szerver 401-et ad; egy címről percenként 10 hibás kísérlet után arról a címről
  egy ideig minden kérésre 429-et (`Retry-After`), a helyes tokenesre is – egy rossz tokennel
  próbálkozó kliens tehát a vele azonos gépről dolgozó többit is kivárásra kényszeríti (lásd fent és a
  [felhasználói dokumentáció 8. fejezetét](felhasznaloi-dokumentacio.md#8-webes-felület)).
- A Codex alapból a 2025-ös MCP-protokollal (`2025-06-18`) kapcsolódik, a HTTP-végpont pedig az
  ilyen kéréseket munkamenet nélkül szolgálja ki: `OPENSZAMLA_CONFIRM_MODE=elicit` mellett ezért
  HTTP-n nem kap jóváhagyó párbeszédet, a kiállítás, a sztornó és a másik NAV-rendszerhez tartozó
  számla beküldése (`nav_send_to_configured_environment`) ELICITATION_UNAVAILABLE_LEGACY_HTTP
  hibával elmarad („A 2025-ös protokollú HTTP-kapcsolaton az elicit mód nem érhető el – használd a
  stdio módot, egy 2026-07-28-as protokollú klienst vagy a code módot.”). Az `elicit` mód stdio-n
  (fent) működik, HTTP-n pedig a `code` mód (alapértelmezés).

## ChatGPT (fejlesztői mód, egyedi MCP)

ChatGPT → Plugins/Connectors → „Add custom MCP server”: nyilvános HTTPS végpont kell, ugyanúgy, mint a
claude.ai-nál (lásd fent). Az író műveletekhez a ChatGPT külön megerősítést kér.

## VS Code (GitHub Copilot) és Cursor

```bash
openszamla config cursor --write
openszamla config vscode --write
```

Az első a `~/.cursor/mcp.json` fájlba ír, a második – a projekt mappájában futtatva – a `.vscode/mcp.json`
fájlba. A VS Code-bejegyzés a munkaterület (projekt) mappájába kerül; a saját mappádból futtatva a program nem
ír semmit. Felhasználói szinten: VS Code → Parancspaletta → „MCP: Open User Configuration”, és másold
be, amit az `openszamla config vscode` kiír. Kézzel, rövid formában `.vscode/mcp.json`:

```json
{ "servers": { "openszamla": { "type": "stdio", "command": "openszamla", "args": ["mcp"] } } }
```

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "openszamla": { "command": "openszamla", "args": ["mcp"] } } }
```

## Kipróbálás és hibakeresés

- **Első lépés: `openszamla doctor`** – ellenőrzi a futtatókörnyezetet, az adatkönyvtárat és az
  adatbázist, az eladót, a NAV-beállítást (élő teszt: `--nav`), minden ismert kliens beállítását
  (benne van-e az OpenSzámla, létezik-e a beírt parancs, melyik adatkönyvtárat használja) és a skillt,
  mindenhez javítási tippel; 1-es kóddal lép ki, ha valami akadályozza a használatot.
- **MCP Inspector:** `npx @modelcontextprotocol/inspector openszamla mcp`
- **Ügynök nélkül:** `openszamla status`, `openszamla list`, `openszamla serve` (webes felület)
- **„Node.js 22.13.0 vagy újabb szükséges” / „node:sqlite” hiba:** a Node.js túl régi (vagy a kliens
  egy beépített, régi Node.js-t használ) – legalább 22.13.0 kell; a program induláskor ellenőrzi. A
  Claude Desktop-bővítménynél lásd fent (A) a beépített Node.js kikapcsolását.
- **A kliens nem indítja el a szervert („spawn openszamla ENOENT”, „env: node: No such file or
  directory”):** a beállításban a rövid `openszamla` vagy `npx` parancs áll, amelyet a kliens
  parancsértelmező, illetve a terminál PATH-ja nélkül nem talál: `openszamla config <kliens> --write
  --force` abszolút útvonalakat ír be.
- **A szerver mást lát, mint a parancssor** (pl. „Eladó: NINCS BEÁLLÍTVA”): a kliens naplójában az
  induláskor kiírt „adatkönyvtár: …” sor mutatja, melyik mappát használja; lásd fent az adatkönyvtárról.
- **A kliens nem látja az eszközöket:** stdio módban a szerver semmit nem ír a szabványos kimenetre a
  protokollon kívül; ha saját burkoló szkriptet használsz, az se írjon oda.
- **„NAV: HIBÁS BEÁLLÍTÁS”** (`openszamla status`) vagy „hibás beállítás” a webes felületen: a sor
  kiírja az okát (pl. nem 16 karakteres cserekulcs) és a javító parancsot az adatkönyvtárral; amíg nem
  javul, a program egyetlen számlát sem jelent (a kiállítás működik).
- **NAV-hibák:** `openszamla status`, illetve az ügynöknek: „Nézd meg a NAV-problémás számlákat.”
  (`nav_hibaelharitas` prompt).
