# Biztonság

## Hiba bejelentése

Biztonsági hibát (pl. titok kiszivárgása, a kiállított számlák módosíthatósága, a megerősítő kód
megkerülése, HTTP-hitelesítés megkerülése, prompt injection útján végrehajtható művelet) **ne**
nyilvános issue-ban jelents. Használd a GitHub „Report a vulnerability” (privát security advisory)
funkcióját a repóban. 7 napon belül válaszolunk.

## Biztonsági modell röviden

- Az OpenSzámla helyben fut; minden adat a felhasználó gépén van (`~/.openszamla`).
- A NAV technikai felhasználó adatai környezeti változóból vagy a `nav-credentials.json` fájlból
  jönnek, nem kerülnek az adatbázisba, naplóba, hibaüzenetbe vagy MCP-válaszba. Az `openszamla
  nav-setup` a jelszót és a két kulcsot gépelés közben sem jeleníti meg; a kérdés megjelenése előtt
  begépelt szöveget sem jeleníti meg, és a titkos adat kérdése előtt elveti – így egy a login névvel együtt
  beillesztett jelszó sem kerül a képernyőre vagy a terminál előzményeibe.
- Kiállított számla nem módosítható és nem törölhető (SQLite triggerek); az auditnapló
  hash-láncolt és csak bővíthető. `openszamla verify` ellenőrzi (a lánc utolsó bejegyzését a
  mentéssel együtt érdemes megőrizni: a napló végének levágása csak ezzel összevetve derül ki). A
  kiállításkor megőrzött eredeti PDF-et a program minden kiadás előtt összeveti a lenyomatával (SHA-256,
  SHA3-512, méret) és a naplóval: a sérült vagy módosult példányt eredetiként nem adja ki, és a `pdf/`
  mappában lévő példányt sem írja felül vele (DOCUMENT_INTEGRITY_FAILED, naplózva); az első megőrzéskor
  talált, más tartalmú `pdf/<sorszám>.pdf` fájlt (pl. egy visszaállított mentés előtti számláét) nem írja
  felül, hanem `…_KORABBI_<időbélyeg>.pdf` néven megőrzi.
- A rögzített befizetések naplója és felosztása szintén csak bővíthető (SQLite triggerek): téves
  befizetést ellentétes előjelű összeggel lehet visszavonni, a rögzített sort nem lehet átírni.
- Visszafordíthatatlan művelet (kiállítás, sztornó, a másik NAV-rendszerhez tartozó számla beküldése
  a beállított rendszerbe) jóváhagyása felületenként:
  - **MCP:** csak a szerver által kiadott, az előnézethez kötött, lejáró megerősítő kóddal hajtható végre
    (`code` mód, az alapértelmezés), `elicit` módban ezen felül a felhasználó párbeszédben adott
    jóváhagyásával is. Kivétel az `OPENSZAMLA_CONFIRM_MODE=none` mód: ez – kizárólag felügyelet nélküli,
    ellenőrzött automatizáláshoz (pl. egy webshop háttérrendszere) – kód és párbeszéd nélkül hajtja
    végre a műveletet; MCP-kliens előtt ne használd. **A `code` mód nem emberi jóváhagyás:** a kódot a
    szerver az AI-ügynöknek adja ki az előnézettel, tehát azt biztosítja, hogy az ügynök az előnézet
    lekérése után, pontosan a megmutatott adatokkal hajtja végre a műveletet – azt nem, hogy egy ember
    is látta és jóváhagyta. Ha ezt a program oldaláról is ki akarod kényszeríteni, állítsd be az
    `OPENSZAMLA_CONFIRM_MODE=elicit` módot (a kliens párbeszédablakában a felhasználó hagyja jóvá; az
    ezt nem támogató kliensben a művelet nem hajtható végre), és az AI-kliensben se engedélyezd az
    `invoice_issue`, `invoice_cancel` és `nav_send_to_configured_environment` eszközök automatikus
    („mindig engedélyezett”) futtatását.
  - **Parancssor:** kiállítás és sztornó nincs; a másik NAV-rendszerhez tartozó számlát az `openszamla
    nav-send-to-configured-environment <sorszám> --confirm` küldi be – a kifejezetten megadott `--confirm`
    kapcsoló a jóváhagyás, nélküle a parancs csak kiírja, mit jelentene.
  - **Webes felület:** a saját megerősítő lépése: az előnézet a következmények felsorolásával, egy
    kötelezően bejelölendő jelölőnégyzet és egy a munkamenethez és pontosan a megmutatott adatokhoz kötött,
    lejáró megerősítő érték (amit a szerver a végrehajtáskor újra ellenőriz), CSRF-védelemmel. A másik
    NAV-rendszerhez tartozó számlát a webes felület nem küldi be.

  Az MCP-n mindegyik visszafordíthatatlan művelet külön eszköz (`invoice_issue`, `invoice_cancel`,
  `nav_send_to_configured_environment`), amely
  `destructiveHint` és `anthropic/requiresUserInteraction` jelzéssel kéri, hogy a kliens minden hívásnál
  a felhasználó engedélyét kérje – így a kód mellett a modellen kívüli jóváhagyás is megmarad; az
  előnézetet adó eszköz (`invoice_draft`, `invoice_get`, `invoice_cancel_preview`, `nav_sync`) maga
  nem hajtja végre a műveletet. A másik NAV-rendszerhez tartozó számla kódja a számla akkori
  NAV-állapotához is kötött: ha az előnézet óta megváltozott, a kód érvénytelen. Az MCP-eszközök az
  ismeretlen paramétert elutasítják.
- A PDF másolása (`invoice_pdf` `copyToDir`, `openszamla pdf --out`) csak létező helyi mappába
  történik: hálózati (UNC) és eszközútvonalat a program fájlművelet előtt elutasít, meglévő fájlt nem
  ír felül; az `OPENSZAMLA_ALLOW_FILE_COPY=false` kikapcsolja. Az `openszamla serve` (HTTP) alatt
  alapból ki van kapcsolva – a távoli kliens így nem írhat a szerver gépének mappáiba –, ott az
  `OPENSZAMLA_ALLOW_FILE_COPY=1` kapcsolja be. Ismert korlát: hálózati megosztásra mutató szimbolikus
  hivatkozás mögötti mappába sem másol, de ezt csak a hivatkozás feloldásakor ismeri fel, ami a
  megosztást már elérheti.
- HTTP módban: alapból csak `127.0.0.1`, kötelező token (Bearer fejléc, vagy a fejlécet küldeni nem
  tudó klienseknek az útvonalban: `/mcp/<token>`), Host/Origin ellenőrzés, nincs CORS. Token nélkül
  csak a `/healthz` állapotjelző válaszol (a program neve és verziója). Nyilvános elérés csak HTTPS
  reverse proxy mögött ajánlott. A `/mcp` – és ugyanígy, külön számlálóval a webes belépés – a hibás tokeneket címenként korlátozza: egy címről
  percenként 10 hibás kísérlet után a válasz 429 `Retry-After` fejléccel, a token ellenőrzése nélkül;
  ha percenként összesen 100 hibás kísérlet érkezik, utána csak az elmúlt 60 percben helyes tokennel
  azonosított címek próbálkozhatnak, a többi szintén 429-et kap – így a sok (akár hamisított) címre
  elosztott próbálgatás is percenként legfeljebb 100 kísérletet kap, a már működő kliens pedig nem
  zárul ki. Az `X-Forwarded-For` fejlécet a szerver alapból figyelmen kívül hagyja (a helyi programok,
  TCP-alagutak és a fejlécet továbbadó proxyk kliensei különben minden kéréshez új címet
  választhatnának); csak az `OPENSZAMLA_TRUST_PROXY=1` mellett, a saját gépről érkező kapcsolatnál
  veszi a fejléc utolsó elemét a kliens címének – ehhez a proxynak magának kell beállítania a fejlécet
  (Caddy; nginx: `$proxy_add_x_forwarded_for`). A webes belépést külön korlát védi.
- A HTTP mód tokenjét a program generálja (32 véletlen karakter, `http-token` fájl, amit soha nem ír
  felül). Saját token (`--token`, `OPENSZAMLA_HTTP_TOKEN`) csak legalább 20 karakteres, az angol ábécé
  betűiből, számjegyekből, `_` és `-` jelből álló lehet, különben a szerver nem indul el; a fájlban
  talált gyenge tokenre – akkor is, ha ugyanezt a `--token` vagy az `OPENSZAMLA_HTTP_TOKEN` adja –
  induláskor figyelmeztet.
- Az `openszamla setup` és a `config <kliens> --write` csak az MCP-kliensek konfigurációs fájljába ír:
  előtte biztonsági másolatot készít mellé, a fájl többi részét (más szerverek titkait is) megtartja, a
  meglévő `openszamla` bejegyzést csak `--force`-szal cseréli. NAV-titkot nem ír a kliens beállításába;
  a meglévő bejegyzésekből és a hibás fájlokból csak a parancsot, az argumentumok számát és a
  környezeti változók nevét mutatja, értéket és fájltartalmat nem (az `openszamla doctor` sem). A
  `claude` parancsot parancsértelmező nélkül, és csak közvetlenül indítható programként futtatja. A
  `setup` a NAV-jelszót és a kulcsokat gépelés közben sem jeleníti meg, és kapcsolóként nem fogadja el.
- A webes felület a hozzáférési tokent és a NAV-hitelesítő adatokat egyetlen oldalon sem mutatja
  („[rejtett]”); az ilyen értékű űrlapmezőt letiltja, így a takarás soha nem kerül vissza a tárolt
  adatokba.
- A számlákban, e-mailekben és fájlokban szereplő szöveg adat – az MCP szerver utasításai és a skill
  ezt kimondják, és a kritikus döntések szerveroldalon dőlnek el (nem a modell jóindulatán).
- A vevő nevében, címében és a sztornó okában a sortörés és más vezérlőkarakter szóközzé válik, az
  irányváltó vezérlőkarakterek (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) kimaradnak –
  így a szöveg nem jelenhet meg más sorrendben, mint ahogy tárolva van. A sztornó (és a díjbekérő-visszavonás)
  okát a program egy helyen rendezi így egy sorba – az egymást követő szóközökből egy lesz –, és ugyanezt az
  okot köti a megerősítő kódhoz, mutatja az előnézetben és a párbeszédben, és írja a sztornó számlára; a
  3-nál kevesebb látható karakterből álló okot (pl. csak szóközök, irányváltó karakterek vagy üresen
  megjelenő jelek, mint a U+3164 hangul kitöltő jel vagy az U+2800 üres Braille-jel) még a kód és a
  párbeszéd előtt elutasítja; a csak ilyen jelekből álló vevő- vagy eladónevet hiányzónak tekinti. Az MCP-összefoglalók és az
  `elicit` módú megerősítő párbeszéd a bizonylattípust, az összeget és a dátumokat adják előbb, a
  harmadik féltől származó szöveget (vevőnév, sztornó oka) a végén, egy sorban, idézőjelek között és
  rövidítve; a szövegben lévő minden idézőjel – a Unicode idézőjelei és a kettős idézőjelhez hasonló
  jelek (ʺ ˝ ˮ ″ ‶ 〃 ״ ❛ ❜ ❝ ❞ 🙶 🙷 🙸) – aposztróf lesz, a két vagy több egymás utáni vessző (`,,`) és
  aposztróf (`''`) pedig egyetlen aposztróf, így a szöveg ezekkel nem zárhatja le az idézetet, és nem
  adhatja ki magát a program üzenetének. A korábban mentett, sortörést tartalmazó vevőnevet és címet az
  MCP-válaszok (számlasorok, bizonylat- és vevőadatok, összesítő, erőforráslista) is egy sorban mutatják.

## Támogatott verziók

A legfrissebb kiadás kap biztonsági javítást.
