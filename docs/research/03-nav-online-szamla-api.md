# 03 – NAV Online Számla API v3: pontos technikai specifikáció és hivatalos XSD-k

> Kutatási anyag az `openszamla` nyílt forráskódú számlázó NAV-integrációjához (MCP-szerver + CLI + web UI, TypeScript / Node.js 24).
> **Állapot: 2026-10-27.** XML-elem-, típus- és API-nevek eredeti formában.
> Bizalmi szintek: **[magas]** = XSD-ből / hivatalos NAV-dokumentumból ellenőrizve vagy általunk lefuttatva; **[közepes]** = elsődleges forrás, de értelmezést igényel vagy nem minden részlete ellenőrzött; **[alacsony]** = másodlagos forrás vagy következtetés.
> Hivatkozott források: lásd 1.1 (S1–S16). Ahol fejezetszám áll (pl. „S2 1.5.1”), az a 2026.08.11-i HU interfészspecifikáció fejezete.

---

## 0. Összefoglaló (TL;DR)

- **Egyetlen támogatott API-verzió: v3.0.** `requestVersion` = `3.0`, `headerVersion` = `1.0`, context root: `/invoiceService/v3`. Újabb Online Számla API-főverziót (3.x/4.0) 2026-10-27-ig nem találtunk bejelentve (NAV hírlista, Dokumentációk oldal, GitHub discussions). [közepes]
- **Az XSD-k 2020 vége óta változatlanok.** `invoiceData.xsd`/`invoiceApi.xsd` utolsó módosítása 2020-12-01, `invoiceBase.xsd`/`invoiceAnnulment.xsd` 2020-09-07. A `common.xsd` a `nav-gov-hu/Common` repó `common-1.0.0` kiadásából (2025-08-29) való; egyetlen újdonsága az opcionális `user/predecessorTaxNumber`. A NAV oldaláról letölthető hivatalos `OSA Schemas_v3.zip` tartalma **normalizálás nélkül is bájtra azonos** a GitHub-os (LF sorvégű) fájlokkal; csak a helyi scratch-másolat és a `vendor/` CRLF-es (a hash-eket lásd 1.3). [magas]
  > ⚠️ Javítva (verifikáció): nem „CR/LF-től eltekintve” azonos – a zip 7 fájlja és a GitHub raw blobok SHA-256-a nyersen is egyezik (pl. `invoiceData.xsd` = `e9053b21…6c1d`); a CRLF csak a helyi Windows-checkout terméke. Bizonyíték: https://onlineszamla.nav.gov.hu/api/files/container/download/OSA%20Schemas_v3.zip és https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/src/schemas/nav/gov/hu/OSA/invoiceData.xsd
- **A legfrissebb specifikáció a 2026.08.11-i** (NAV Dokumentációk oldal, frissítve 2026-08-26); a GitHubon csak a 2026.02.12-i van. Újdonság (3.49-es alkalmazásverzió): **HTTP 429 `TOO_MANY_REQUESTS` + `Retry-After`** fejléc, és több hibakód HTTP-státusza megváltozott (`FORBIDDEN` 500→403, `INVALID_CUSTOMER`/`NOT_REGISTERED_CUSTOMER`/`INVALID_USER_RELATION`/`INVALID_PREDECESSOR_TAX_NUMBER` 500→400). [magas]
- **2025-09-15-től 15 korábbi WARN blokkoló ERROR lett** (pl. HUF pénznem ≠ 1-es árfolyam, extrém árfolyam, KBAET/EUFAD37/EUFADE ↔ vevőstátusz, adómentes tételen áfa-összeg, gyűjtőszámla tételadat). **2026-01-01-től** további ERROR-ok (`INVALID_ORIGINAL_INVOICE_NUMBER`, `INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL`). [magas]
- **Kriptográfia reprodukálva** `node:crypto`-val: a specifikáció hivatalos példája és a NAV mind a 11 minta-kérése (signKey-jel együtt publikálva): **24/24 ellenőrzés OK**. Az `electronicInvoiceHash` a NAV mintában a **dekódolt** számla-XML bájtjainak SHA3-512-je (a spec szövege ezzel ellentmondásos – de `completenessIndicator=true` jelenleg úgyis tiltott). [magas]
- **3 InvoiceData példa** (belföldi B2B 27%+5%, AAM B2C készpénz, STORNO) és **4 API-kérés + 5 válasz XSD-validált** xmllint-wasm 5.3.0-val (libxml2 2.13.8); a negatív tesztek igazolják, hogy a sorrend-, névtér- és facet-hibákat a validálás elkapja; a NAV mind a 41 hivatalos minta-XML-je is validál ugyanezzel a beállítással. [magas]

---

## 1. Források, verziók, licenc

### 1.1 Források (as of 2026-10-27)

| ID | Forrás | URL | Verzió / dátum | Bizalom |
|---|---|---|---|---|
| S1 | NAV GitHub – Online-Invoice repó | https://github.com/nav-gov-hu/Online-Invoice | `master` @ `cc7a775d6dce361311e409abb9934eb755f2749c` (2026-02-13T09:35:27+01:00, „11400, 11401 WARN frissítés”) | magas |
| S2 | Interfészspecifikáció HU v3.0 – **2026.08.11** (NAV Dokumentációk oldal) | https://onlineszamla.nav.gov.hu/files/container/download/Online_Szamla_interfesz%20specifikacio_HU_v3.0_2026_08_11.pdf | 373 oldal; dokumentumtörténet utolsó sora: „2026.08.11 3.0 HTTP-státuszkód-változások” | magas |
| S3 | Interfészspecifikáció HU v3.0 – 2026.02.12 (GitHub) | https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu | 374 oldal; S2-től csak a HTTP-kódokban, a 429-ben és apró szövegezésben tér el (szöveges diff alapján) | magas |
| S4 | NAV GitHub – Common repó, `common-1.0.0` tag | https://github.com/nav-gov-hu/Common | tag commit `ab8d7887967492e5f6d6e25447be853fd767add8` (2025-08-29); fájl: `schemas/src/main/resources/xsd/hu/gov/nav/schemas/NTCA/1.0/common/common.xsd` | magas |
| S5 | Hivatalos sémacsomag „OSA Schemas_v3.zip” | https://onlineszamla.nav.gov.hu/api/files/container/download/OSA%20Schemas_v3.zip | Dokumentációk oldal szerint frissítve 2025.08.28; zip-bejegyzések 2025-11-05 | magas |
| S6 | Online Számla „Dokumentációk” oldal (CMS-tartalom) | https://onlineszamla.nav.gov.hu/dokumentaciok (tartalom: https://onlineszamla.nav.gov.hu/api/menu-items/link/dokumentaciok?lang=hu) | `updatedAt` 2026-08-26T08:53:08Z | magas |
| S7 | Online Számla hírek (CMS-API) | https://onlineszamla.nav.gov.hu/api/news/visible/list | 140 hír; legutóbbi releváns: 2026-08-27 „Az Online Számla és API GW interfészspecifikáció módosítása” | magas |
| S8 | NAV API Gateway M2M REST API autentikáció leírás v0.4 | https://onlineszamla.nav.gov.hu/files/container/download/API_GW_interfesz_specifikacio_v0.4.pdf | v0.4 (2026.08.06) – **jelenleg csak az eÁFA M2M-et szolgálja ki** | magas |
| S9 | NAV hír: „Módosulnak az Online Számla rendszer validációi” | https://nav.gov.hu/ado/egyeb/Modosulnak_az_Online_Szamla_rendszer_validacioi | 2025-07-21; teszt 2025-09-01, éles 2025-09-15 | magas |
| S10 | GitHub discussion #1180 „2026. január 1-től módosuló validációk” (NTCA-tax) | https://github.com/nav-gov-hu/Online-Invoice/discussions/1180 | 2025-11-20 + válaszok 2025-12-08, 2026-03-20 | közepes–magas |
| S11 | NAV hír: „Online Számla rendszer: szeptember 18-tól új ERROR-üzenet” | https://nav.gov.hu/ado/egyeb/Online_Szamla_rendszer_szeptember_18-tol_uj_ERROR-uzenet | 2023-08-16 (`INVALID_LINE_OPERATION`, éles: 2023-09-18) | magas |
| S12 | Online Számla felhasználói kézikönyv 3.35 | https://onlineszamla.nav.gov.hu/files/container/download/Online%20Sz%C3%A1mla%20Felhaszn%C3%A1l%C3%B3i%20k%C3%A9zik%C3%B6nyv_3.35.pdf | 2025.01.15 (felhasználókezelés → NAV Felhasználókezelő, https://uam.nav.gov.hu) | magas |
| S13 | Online Számla felhasználói kézikönyv (régi, 3.21) | https://onlineszamla.nav.gov.hu/api/files/container/download/Online%20Sz%C3%A1mla%20Felhaszn%C3%A1l%C3%B3i%20k%C3%A9zik%C3%B6nyv.pdf | 2022. november – technikai felhasználó/kulcsgenerálás lépései | közepes (elavulhatott) |
| S14 | GitHub API commit-történet az XSD-útvonalakra | https://api.github.com/repos/nav-gov-hu/Online-Invoice/commits?path=src/schemas/nav/gov/hu/OSA/invoiceData.xsd | lekérdezve 2026-10-27 | magas |
| S15 | Saját élő próba a **teszt** API-n (érvénytelen kérésekkel, hitelesítő adatok nélkül) és TLS-ellenőrzés | `https://api-test.onlineszamla.nav.gov.hu/...` | 2026-10-27 13:36 UTC | magas (csak tesztkörnyezetre) |
| S16 | Harmadik fél (csak „lead”): `angro-kft/nav-connector` token-dekódolás | https://github.com/angro-kft/nav-connector/blob/master/src/get-exchange-token.js | – | alacsony (nem hivatalos) |

### 1.2 Repó, licenc, sémák eredete

- **Online-Invoice repó** (S1): `git clone --depth 1` → `master`, HEAD `cc7a775d6dce361311e409abb9934eb755f2749c`, 2026-02-13T09:35:27+01:00, szerző „NTCA-Developer”. **Licenc: `LICENCE.md` – MIT** („Copyright (c) 2019 Nemzeti Adó - és Vámhivatal”, magyar és angol szöveggel). A copyright-sort és az engedélyezési nyilatkozatot a sémák minden példányához mellékelni kell. [magas]
- A repó tartalma: `src/schemas/nav/gov/hu/OSA/{invoiceApi,invoiceBase,invoiceData,invoiceAnnulment,serviceMetrics}.xsd`, `catalog.xml`, `CHANGELOG_2.0.md`, `CHANGELOG_3.0.md`; `docs/API docs/{hu,en}/*.pdf`; `sample/API sample/*.xml` (11 db), `sample/Data sample/*.xml` (30 db) és egy PDF; `sample/WADL/application.wadl`; `src/i18n/*.properties` (2021-es állapot, a 2025–26-os kódok hiányoznak). [magas]
- **Utolsó XSD-módosítások** (S14): `invoiceData.xsd` és `invoiceApi.xsd` – `74c70529d3`, 2020-12-01; `invoiceBase.xsd` és `invoiceAnnulment.xsd` – `f85c5cd35b`, 2020-09-07. Fejléc-kommentek: invoiceData „v3.0 2020/11/23”, invoiceApi „v3.0 2020/11/09”, invoiceBase „v3.0 2020/07/31”. [magas]
- **`common.xsd` nincs az Online-Invoice repóban**, a `nav-gov-hu/Common` repóból kell venni (S4). Tagek vizsgálata [magas]:
  - `Common-1.0.RC3` (2020-10-01): még `PageType`-ot tartalmaz, a v3 OSA-sémák viszont `common:RequestPageType`/`common:ResponsePageType`-ot használnak → **inkompatibilis**.
  - `Common-1.0.RC4`/`RC5`: azonos blob (`28e1941…`), **nincs benne** `predecessorTaxNumber`.
  - `Common-1.0.RC6` (2025-01-23): a `common.xsd` **0 bájtos** (hibás tag).
  - **`common-1.0.0`** (2025-08-29, `release/common-1.0.x`): RC4 + `UserHeaderType/predecessorTaxNumber` [0..1]. **Ez az érvényes.** Megjegyzés: a fájl fejléc-kommentje továbbra is „Version: v1.0 RC4 2023/02/10” – ne ebből azonosítsuk a verziót.
  - `common-2.0.0` (2026-09-02): új `http://schemas.nav.gov.hu/NTCA/2.0/...` névtér, több fájlra bontva – az Online Számla v3 sémái **nem** használják.
- **Hivatalos keresztellenőrzés** (S5): az `OSA Schemas_v3.zip` 7 fájlja (`catalog.xml`, `common.xsd`, `invoiceAnnulment.xsd`, `invoiceApi.xsd`, `invoiceBase.xsd`, `invoiceData.xsd`, `serviceMetrics.xsd`) **nyers bájtokban (SHA-256) azonos** a GitHub-os OSA-fájlokkal (raw blob, LF sorvég) és a `common-1.0.0` `common.xsd`-vel. [magas]
  > ⚠️ Javítva (verifikáció): az eredeti szöveg „CR/LF normalizálás után” azonosságot állított; valójában normalizálás nélkül is egyeznek (a zip és a GitHub raw fájlok egyaránt LF-esek, git blob SHA-1 egyezik, pl. `invoiceData.xsd` blob `c644a711…`). Bizonyíték: https://onlineszamla.nav.gov.hu/api/files/container/download/OSA%20Schemas_v3.zip, https://github.com/nav-gov-hu/Online-Invoice/tree/master/src/schemas/nav/gov/hu/OSA
- A projektben már létező `vendor/nav-online-invoice/schemas/*.xsd` (más csapattag munkája) tartalma szintén azonos ezzel a készlettel (CR/LF-től eltekintve) – a hozzá tartozó README a common.xsd-t „v1.0 RC4, 2023-02-10”-ként jelöli, ami a fejléc-komment; valójában a `common-1.0.0` tartalma (van benne `predecessorTaxNumber`). [magas]

### 1.3 Az XSD-k helye

A hivatalos XSD-k a projektben: `vendor/nav-online-invoice/schemas/` (forrás: a NAV GitHub-tárolói, `nav-gov-hu/Online-Invoice` és `nav-gov-hu/Common`, MIT licenc); a tesztek ezek ellen validálnak (`test/helpers/nav-xsd.ts`).

A kutatás további anyagai (az S1 és S4 tároló klónja, a NAV letöltései – S2 PDF, S5 zip, S8 PDF, S12 PDF –, a szkriptek, a példák és a kinyert szövegek) a kutatás ideiglenes munkamappájában voltak; a tárolónak nem részei.

A struktúra a repó relatív szerkezetét követi; a `common.xsd` a Common repó régi (≤RC6) elérési útjára került (`src/schemas/nav/gov/hu/NTCA/common.xsd`), amelyre az Online-Invoice `catalog.xml` kikommentezett URI-ja is mutat:

| Fájl (a kutatási másolatban) | Forrás | SHA-256 (helyi, CRLF-re konvertált másolat – azonos a jelenlegi `vendor/` fájlokkal) | SHA-256 (**eredeti upstream bájtok**, LF: GitHub raw blob = `OSA Schemas_v3.zip`) |
|---|---|---|---|
| `src/schemas/nav/gov/hu/NTCA/common.xsd` | Common `common-1.0.0` | `0ad7a99292d9b5c967d0cf1f37ceafd9945ac456b534963c7c72a6e7bb42971c` | `0ad7a99292d9b5c967d0cf1f37ceafd9945ac456b534963c7c72a6e7bb42971c` (azonos, LF) |
| `src/schemas/nav/gov/hu/OSA/catalog.xml` | Online-Invoice S1 | `7e2eee9594740d0e702875d636f2fc3b33998bc3bae048ac92eba8b73b89ec7c` | `4e42a14ad00fbe1be2f43d69398f7a0108a41001e44c713f583ea52c5bf74d27` |
| `src/schemas/nav/gov/hu/OSA/invoiceAnnulment.xsd` | S1 | `82fa0ad25cb30356e7a29b84c6525bd4e51e436170a9576907e015036183eab3` | `b46b10041026a5f552982c5a2bdf864974147defa2dceee1ff3d5fdf8cdd2289` |
| `src/schemas/nav/gov/hu/OSA/invoiceApi.xsd` | S1 | `c50bec9a88270f759a2784608699ce79b073d2ca8db52c380094d598ab9ab197` | `268c923298fea89832699c509d57fbe3b28d1b2956322294cffc9840dd78e656` |
| `src/schemas/nav/gov/hu/OSA/invoiceBase.xsd` | S1 | `6bca8e2958bdc64d58717228fe8bbe8e2653d2685f840884fa31fe1ef9edc254` | `49362a6ede64afcfeba1c5c3726f6216e3a8cd1dbad0c071b85811759ad4acc9` |
| `src/schemas/nav/gov/hu/OSA/invoiceData.xsd` | S1 | `94b7daff23678922addf1163dbe7d56503dcfc22584abb7908212934355d805d` | `e9053b21904c406adb8fce87cb83361f888247e6cd6409eac4aa651de7a86c1d` |
| `src/schemas/nav/gov/hu/OSA/serviceMetrics.xsd` | S1 | `22994936f90ab3a762930d0b0b8078d9233835803da5f493f744881d73c4744f` | `68a4ed2f736a871346eda61766bdcc06cc70e906b32142731499d4f201bfd2d8` |
> ⚠️ Javítva (verifikáció): a táblázat „SHA-256 (eredeti bájtok)” oszlopa valójában a helyi Windows-checkout **CRLF-re konvertált** fájljainak hash-e volt (a 6 OSA-fájlnál; a `common.xsd` LF-es, ott helyes). Az upstream fájlok LF sorvégűek: a GitHub raw tartalom git blob SHA-1-e megegyezik a fában lévővel (pl. `invoiceApi.xsd` blob `53d12091…`), és a NAV `OSA Schemas_v3.zip` fájljai bájtra ugyanezek. A `vendor/nav-online-invoice/schemas/*.xsd` jelenleg szintén CRLF-es (a bal oszlop hash-eivel egyezik), tartalmilag (sorvégtől eltekintve) azonos. Provenance-hoz a jobb oszlopot használjuk, vagy vendoroljuk az upstream bájtokat változatlanul (pl. `.gitattributes`: `*.xsd -text`, `*.xml -text`). Bizonyíték: https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/src/schemas/nav/gov/hu/OSA/invoiceApi.xsd, https://onlineszamla.nav.gov.hu/api/files/container/download/OSA%20Schemas_v3.zip

### 1.4 Hogyan validáljunk (import schemaLocation nélkül)

- Mind az öt OSA-séma `xs:import namespace="…"` elemet használ **`schemaLocation` nélkül** (a NAV XML-katalógusra hagyatkozik). A repóbeli `catalog.xml` URI-jai (`./files/NTCA/Common/common.xsd`, `./files/OSA/Invoice/invoiceBase.xsd`) a NAV belső könyvtárszerkezetére mutatnak, **a repóban nem léteznek** → a katalógus változtatás nélkül nem használható. [magas]
- Működő megoldás (libxml2/xmllint-wasm): egy **wrapper-séma**, ami minden névteret `schemaLocation`-nel importál (a sorrend számít: előbb `common`, aztán `base`, majd `data`/`api`/`annul`); a többi XSD „preload”-ként kerül az in-memory FS-be. Az `xmllint` több `--schema` esetén csak az utolsót használja, ezért kell a wrapper.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common" schemaLocation="common.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/base" schemaLocation="invoiceBase.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/data" schemaLocation="invoiceData.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/api" schemaLocation="invoiceApi.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/annul" schemaLocation="invoiceAnnulment.xsd"/>
</xs:schema>
```

- Ezzel a beállítással a NAV **mind a 41** hivatalos minta-XML-je (30 Data + 11 API) validál, és a mi példáink is (10. és 11. fejezet). A teljes szkript: 12.1. [magas]

### 1.5 Verzió- és változástörténet (ami a kliensre hat)

| Mikor (éles, ill. „dok.” = csak a dokumentáció dátuma ismert) | Alkalmazásverzió | Változás | Forrás | Bizalom |
|---|---|---|---|---|
| 2020-12 | – | v3.0 XSD végleges (azóta változatlan) | S1, S14 | magas |
| 2021-01-04 | – | 3.0 kötelező; magánszemély-, EU-s, export-számlák is jelentendők | S1 CHANGELOG_3.0 | magas |
| 2023-09-18 | 3.21.5 | `INVALID_LINE_OPERATION` ERROR: `lineOperation=MODIFY` tilos, csak `CREATE` | S11, S2 2.5.3 | magas |
| 2023-12-08 (dok.) | – | „RequestId egyediségvizsgálat módosítása” (dok.-történet). Jelenlegi szabály: a sikeres és az `INVALID_REQUEST_SIGNATURE`/`FORBIDDEN` hibával elutasított kérések azonosítója sem használható újra | S2 1.3.1, dok.-történet | magas |
| 2025-01 (dok.: 2025-01-17) | 3.34–3.35 | jogelőd-kezelés: `user/predecessorTaxNumber`, új ERROR-ok (`INVALID_PREDECESSOR_OPERATION`, `SUPPLIER_NOT_IDENTICAL`, `PREDECESSOR_REFERENCE_NOT_IDENTICAL`) | S2 1.10, 5.4; S7 (2025-01-17, 2025-01-24) | magas |
| 2025-09-15 (teszt: 09-01) | 3.40 | 15 WARN → ERROR; 3 új WARN (435, 734, 1311); 3 inaktív WARN (690, 700, 1301); 1 INFO → WARN (11400) | S9, S2 5.4 | magas |
| 2025-10-07 | – | 11400 éles környezetben átmenetileg inaktív (tesztben aktív) | S7 (2025-10-07) | magas |
| 2026-01-01 | 3.44–3.44.3 | 691 → ERROR; új ERROR 79 `INVALID_ORIGINAL_INVOICE_NUMBER`; új WARN 72, 11401; 11400 átdolgozva és újra aktív; 61 módosult | S10, S7 (2025-11-21, 2026-01-05), S2 5.4 | magas |
| 2026-02 | 3.45.1 | 11400/11401 az utolsó módosító/sztornó számla teljesítési dátumához hasonlít | S2 5.4 | magas |
| 2026-08 (spec: 2026.08.11, publikálva 2026-08-27) | 3.49 | Rate limit: **HTTP 429 `TOO_MANY_REQUESTS`** + `Retry-After`; HTTP-kódok: `FORBIDDEN` 500→403, `INVALID_CUSTOMER`/`NOT_REGISTERED_CUSTOMER`/`INVALID_USER_RELATION`/`INVALID_PREDECESSOR_TAX_NUMBER` 500→400; doksi-javítás: `MULTIPLE_QUERY_RESULT_FOUND` = 500 | S2 3.2, 5.4; S7 (2026-08-27) | magas (pontos élesítési nap: közepes) |
| 2026-01-01 (**csak teszt**) / élesben tervezett, dátum nélkül | – | 60 `INCORRECT_VAT_CODE_SUPPLIER_GROUPMEMBER_MISSING`: a **tesztkörnyezetben 2026-01-01 óta már ERROR**, élesben „átmeneti időszak után” lesz ERROR; 11401: WARN, „megfelelő felkészülési idő után” ERROR lesz; 2026-03-20-án élesben még WARN, dátum nincs | S10 | közepes–magas |
> ⚠️ Javítva (verifikáció): a 60-as validáció nem csak „tervezett”: a #1180-as NAV-bejegyzés szerint „A validáció szigorítása egyelőre csak adózói teszt környezetben valósul meg” – vagyis a teszt API már ERROR-t (→ `ABORTED`) ad, ha az eladó áfacsoport-tag és hiányzik/hibás a `groupMemberTaxNumber`. Bizonyíték: https://github.com/nav-gov-hu/Online-Invoice/discussions/1180

Egyéb: SSL-tanúsítványcsere 2025-01-30 (ECC) és 2026-02-12 (S7). Az API Gateway (S8) a NAV szerint egyelőre csak az eÁFA M2M-et szolgálja ki, de ugyanazokat a common-típusokat és hitelesítési hibakódokat használja; ugyanaz a technikai felhasználó használható. [magas]

---

## 2. Végpontok, környezetek, HTTP

### 2.1 Környezetek [magas] (S1 README, S2 6. fejezet)

| Környezet | Webes felület | API base URL |
|---|---|---|
| Éles | https://onlineszamla.nav.gov.hu | `https://api.onlineszamla.nav.gov.hu` |
| Felhasználói teszt | https://onlineszamla-test.nav.gov.hu | `https://api-test.onlineszamla.nav.gov.hu` |

Teljes URL = base + `/invoiceService/v3` + erőforrás. A tesztkörnyezetben **nincs garantált rendelkezésre állás**, hibáit nem kell bejelenteni (S2 3.2). Teszt-helpdesk (fejlesztői kérdések): `init.onlineszamla_teszt_support@nav.gov.hu` (S6). Kérés esetén a teljes HTTP requestet (header + body) és a beküldés pontos időpontját kell mellékelni (S2 7.2).

### 2.2 Operációk [magas] (S2 1.6.2, 1.7, 1.8; XSD)

Minden operáció **HTTP POST**, body = a megadott root elemű XML (UTF-8).

| Erőforrás (`/invoiceService/v3/…`) | Request root (api ns) | Response root (api ns) | requestSignature | Megjegyzés |
|---|---|---|---|---|
| `/tokenExchange` | `TokenExchangeRequest` | `TokenExchangeResponse` | egyszerű | egyszer használatos token kiadása |
| `/manageInvoice` | `ManageInvoiceRequest` | `ManageInvoiceResponse` | index-hash-es | számlaadat beküldés (CREATE/MODIFY/STORNO), max 100 db/kérés |
| `/manageAnnulment` | `ManageAnnulmentRequest` | `ManageAnnulmentResponse` | index-hash-es | technikai érvénytelenítés (ANNUL), max 100 db/kérés |
| `/queryTransactionStatus` | `QueryTransactionStatusRequest` | `QueryTransactionStatusResponse` | egyszerű | aszinkron feldolgozási eredmény |
| `/queryTransactionList` | `QueryTransactionListRequest` | `QueryTransactionListResponse` | egyszerű | beküldött tranzakciók listája (max 35 nap) |
| `/queryTaxpayer` | `QueryTaxpayerRequest` | `QueryTaxpayerResponse` | egyszerű | belföldi adószám-ellenőrzés |
| `/queryInvoiceData` | `QueryInvoiceDataRequest` | `QueryInvoiceDataResponse` | egyszerű | egy számla teljes adattartalma |
| `/queryInvoiceCheck` | `QueryInvoiceCheckRequest` | `QueryInvoiceCheckResponse` | egyszerű | létezik-e pontosan egyszer érvényesként |
| `/queryInvoiceDigest` | `QueryInvoiceDigestRequest` | `QueryInvoiceDigestResponse` | egyszerű | kivonatos, lapozható keresés |
| `/queryInvoiceChainDigest` | `QueryInvoiceChainDigestRequest` | `QueryInvoiceChainDigestResponse` | egyszerű | számlalánc kivonat (módosítások, sorszám-intervallumok) |

Hibaválasz-rootok: `GeneralErrorResponse` (api ns) és `GeneralExceptionResponse` (**common** ns) – 6. fejezet.
Diagnosztika (hitelesítés nélkül, **HTTP GET**): `/metricService/v3/queryServiceMetrics/metric`, `/queryServiceMetrics/list`, `/queryServiceMetrics/metric/{metricName}` (S2 8.1; élőben ellenőrizve a teszten, S15).

### 2.3 HTTP-szintű követelmények [magas] (S2 1.6)

- Kötelező fejlécek: `content-type=application/xml`, `accept=application/xml`. A tárolás és a válasz mindig UTF-8 → a kérést is UTF-8-ban küldjük (és az `<?xml … encoding="UTF-8"?>` deklarációval).
- Helyes kérésre **mindig HTTP 200**, akkor is, ha a válaszban üzleti hibakód van; hibás kérésre 4xx/5xx + `GeneralErrorResponse`/`GeneralExceptionResponse` (6.2).
- **POST body ≤ 10 MB** minden operációban. Nagyobb számla-XML-t a BASE64 előtt **GZIP**-pel kell tömöríteni; számlánként max. **15 MB tömörítetlen** méret; NAV kéri a leggyorsabb, `gzip -1` szintet (nagyobb tömörítésű kérések a sor végére kerülnek). (S2 1.6.5)
- Válaszidő jellemzően < 200 ms; szinkron blokkoló timeout 5000 ms – **csak ennél hosszabb választ kezeljünk időtúllépésként**; abszolút timeout 60 s (60 s után sincs garancia, hogy a beküldés sikertelen volt → 6.5). (S2 1.6.6)
- Verziókezelés: a szolgáltatás verziója az URL-ben (`/v3`), az adatmodellé a `requestVersion`-ben. A főverziók tokenjei nem átjárhatók; státusz csak ≥ beküldéskori `requestVersion`-nel kérdezhető le. (S2 1.6.9)
- Karbantartás: két mód (csak tokenkérés tiltva / minden tiltva); `MAINTENANCE_MODE` hibakód, amit a hálózati eszköz **HTTP 503**-ra fordít. (S2 1.6.8, 3.2)

### 2.4 TLS [magas] (S15, 2026-10-27)

`api.onlineszamla.nav.gov.hu` és `api-test.onlineszamla.nav.gov.hu`: `*.onlineszamla.nav.gov.hu` (ECC P-256, érvényes 2026-01-14 – 2027-02-14) ← `e-Szigno OV TLS CA 2023` ← `Microsec e-Szigno Root CA 2009`. A Node.js 24 alapértelmezett CA-tára **elfogadja** (TLS 1.2). Egyedi CA-beállítás nem kell; **leaf-tanúsítványt ne pinneljünk** (NAV évente cseréli, utoljára 2026-02-12-én; a láncot a Dokumentációk oldalon is publikálja – S6).

### 2.5 Tesztkörnyezet, technikai felhasználó, kulcsok

1. **Belépés** az adózó nevében eljárni jogosult személlyel (adózó maga, törvényes képviselő vagy megfelelő EGYKE-jogosultságú állandó meghatalmazott) KAÜ-azonosítással a teszt felületen (https://onlineszamla-test.nav.gov.hu → „Bejelentkezés”). Az első belépő lesz az **elsődleges felhasználó**; kötelező e-mail, kapcsolattartási nyelv, adatkezelési tájékoztató elfogadása. A teszt és az éles regisztráció **teljesen külön** van; a teszt-felhasználók/kulcsok élesben nem használhatók. [magas] (S13 7.3, 8–9; S12 7.2; S2 Bevezetés)
2. 2025 óta a felhasználókezelés a **NAV Felhasználókezelő** alkalmazásban történik (éles: https://uam.nav.gov.hu); itt hozza létre az elsődleges felhasználó a **technikai felhasználót** (jelszó + megerősítés, kapcsolattartási nyelv, jogosultságok). A teszt-UAM pontos URL-jét nem ellenőriztük. [közepes] (S12 6. fejezet; S7 2025-12-19)
3. **Jogosultságok** (S13 16.4.1): „Számlák kezelése” (beküldés – kell a `manageInvoice`/`manageAnnulment`-hez), „Számlák lekérdezése” *vagy* „Saját számlák lekérdezése” (egyszerre csak az egyik), „OPG-napló-lekérdezés”. Opcionálisan **vevőadószámokhoz rendelhető** – ekkor csak ezekre a vevőkre küldhet (különben `CUSTOMER_NOT_ASSIGNED` ERROR). [közepes – a 3.21-es kézikönyvből; a UAM-ban a megnevezés eltérhet]
4. **Kulcsgenerálás** (csak elsődleges felhasználó): „Kulcsgenerálás” → **XML-aláírókulcs** (signKey; a `requestSignature`-höz) és **XML-cserekulcs** (exchange key; a token AES-dekódolásához). Újragenerálás után a régi kulcsok azonnal érvénytelenek. A technikai felhasználó login neve 15 karakteres, a rendszer generálja; a webes felületre nem lehet vele belépni. [magas a funkcióra; a kulcsok pontos hosszát hivatalos dokumentumban nem láttuk – a NAV példákban az aláírókulcs 32, a cserekulcs AES-128 miatt 16 karakter] (S13 16.4.2, S2 1.3.2)
5. Ha az API „Nem regisztrált felhasználó” (`NOT_REGISTERED_CUSTOMER`) hibát ad: az adózóhoz az elsődleges felhasználónak be kell lépnie a NAV Felhasználókezelőbe, ezután a technikai felhasználó automatikusan helyreáll. [magas] (S7 2025-12-19)

---

## 3. Névterek és a közös kérés-/válaszelemek

### 3.1 Névterek [magas] (XSD `targetNamespace`)

| Prefix (konvenció) | Névtér URI | Séma | Mi van benne |
|---|---|---|---|
| (default) / `api` | `http://schemas.nav.gov.hu/OSA/3.0/api` | invoiceApi.xsd | minden request/response root, `software`, operáció-specifikus elemek |
| `common` | `http://schemas.nav.gov.hu/NTCA/1.0/common` | common.xsd | `header`, `user`, `result`, `GeneralExceptionResponse`, atomi/katalógus típusok |
| `base` | `http://schemas.nav.gov.hu/OSA/3.0/base` | invoiceBase.xsd | `TaxNumberType`, `AddressType` és gyerekei, dátum/pénz típusok, enumok |
| (default) / `data` | `http://schemas.nav.gov.hu/OSA/3.0/data` | invoiceData.xsd | `InvoiceData` root és a számla üzleti tartalma |
| `annul` | `http://schemas.nav.gov.hu/OSA/3.0/annul` | invoiceAnnulment.xsd | `InvoiceAnnulment` root |
| `metrics` | `http://schemas.nav.gov.hu/OSA/3.0/metrics` | serviceMetrics.xsd | metrika-válaszok |

Minden séma `elementFormDefault="qualified"` → **minden lokális elem abban a névtérben van, ahol a deklarációja áll**, nem ott, ahol használjuk. Gyakorlati következmények (a negatív teszt bizonyítja: `<taxpayerId>` data-névtérben → `INVALID`):
- `supplierTaxNumber`, `customerTaxNumber`, `groupMemberTaxNumber`, `fiscalRepresentativeTaxNumber`, `taxNumberDetail` maga a data/api névtérben van, de a **gyerekei** (`taxpayerId`, `vatCode`, `countyCode`) a **base** névtérben (a `TaxNumberType` a base sémában deklarált). A `CustomerTaxNumberType` kiterjesztés `groupMemberTaxNumber` eleme viszont **data** névtérű.
- `…Address` elemek (data) gyereke `base:simpleAddress` / `base:detailedAddress`, és ezek összes gyereke is **base**.
- Kérésben: `header` és `user` és gyerekeik **common**, a `software` és gyerekei **api** névtérben.
- A válaszokban a NAV más prefixeket használ (élő példa: default = common, `ns2` = api, …; S15). **Mindig névtér-URI alapján parse-oljunk, ne prefix alapján.** (S1 CHANGELOG_3.0 3.1.2)

### 3.2 Közös kérés-boríték: `BasicOnlineInvoiceRequestType` [magas] (XSD; S2 1.3)

Minden request root ezt terjeszti ki; a sorrend kötött: **`common:header` → `common:user` → `software` → (operáció-specifikus elemek)**.

`common:header` (`common:BasicHeaderType`):

| # | Elem | Típus | Kötelező | Megkötés / érték |
|---|---|---|---|---|
| 1 | `requestId` | `common:EntityIdType` | igen | pattern `[+a-zA-Z0-9_]{1,30}`, minLength 1, maxLength 30 (kötőjel NEM megengedett). Adószámonként egyedi; a sikeres kérések **és** az `INVALID_REQUEST_SIGNATURE`/`FORBIDDEN` hibával elutasítottak azonosítója sem használható újra. Része a requestSignature-nek. |
| 2 | `timestamp` | `common:GenericTimestampType` (xs:dateTime) | igen | pattern `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z` – **UTC, `Z`-vel, max. 3 tizedes másodperc**. Szerveridőhöz képest ±1 nap tűrés (`INVALID_TIMESTAMP`). Része a requestSignature-nek. |
| 3 | `requestVersion` | `common:AtomicStringType15` | igen | egyetlen elfogadott érték: **`3.0`** (üzleti validáció; `INVALID_REQUEST_VERSION`) |
| 4 | `headerVersion` | `common:AtomicStringType15` | nem | ha megadjuk: csak **`1.0`** (`INVALID_HEADER_VERSION`) |

`common:user` (`common:UserHeaderType`):

| # | Elem | Típus | Kötelező | Megkötés / érték |
|---|---|---|---|---|
| 1 | `login` | `common:LoginType` | igen | `[a-zA-Z0-9]{6,15}` (a rendszer 15 karakterrel generálja) |
| 2 | `passwordHash` | `common:CryptoType` | igen | szöveg: `SimpleText512NotBlankType`; **kötelező attribútum `cryptoType="SHA-512"`**; érték: a jelszó nagybetűs SHA-512 hexája (4.1) |
| 3 | `taxNumber` | `common:TaxpayerIdType` | igen | `[0-9]{8}`, length 8 – az adózó (akihez a technikai felhasználó tartozik) adószámának törzsszáma; csak magyar |
| 4 | `predecessorTaxNumber` | `common:TaxpayerIdType` | nem | jogelőd törzsszáma (common 1.0.0); `ManageInvoice`, `TokenExchange`, `QueryTaxpayer` esetén csak validálják, a lekérdezéseknél és `manageAnnulment`-nél a jogelőd adataira vonatkozik (S2 1.3.2, 1.10) |
| 5 | `requestSignature` | `common:CryptoType` | igen | **kötelező `cryptoType="SHA3-512"`**; nagybetűs hex (4.2–4.3) |

`software` (`api:SoftwareType`):

| # | Elem | Típus | Kötelező | Megkötés |
|---|---|---|---|---|
| 1 | `softwareId` | `api:SoftwareIdType` | igen | **length 18**, pattern `[0-9A-Z\-]{18}`. Ajánlás: 2 betűs fejlesztői országkód + fejlesztő adószám-törzsszáma + egyedi karakterek; ugyanazon szoftver ugyanazon példánya mindig ugyanazt küldje (S2 1.3.3) |
| 2 | `softwareName` | `common:SimpleText50NotBlankType` | igen | 1–50 karakter, nem csupa whitespace |
| 3 | `softwareOperation` | `api:SoftwareOperationType` | igen | `LOCAL_SOFTWARE` \| `ONLINE_SERVICE` |
| 4 | `softwareMainVersion` | `common:SimpleText15NotBlankType` | igen | 1–15 karakter |
| 5 | `softwareDevName` | `common:SimpleText512NotBlankType` | igen | fejlesztő neve |
| 6 | `softwareDevContact` | `common:SimpleText200NotBlankType` | igen | fejlesztő **működő e-mail címe** |
| 7 | `softwareDevCountryCode` | `common:CountryCodeType` | nem | `[A-Z]{2}`, length 2 |
| 8 | `softwareDevTaxNumber` | `common:SimpleText50NotBlankType` | nem | fejlesztő adószáma |

Megjegyzés: a spec „Gyártó” definíciója szerint gyártónak minősülhet „a Számlázó program felhasználója” is (S2 Kifejezések) – nyílt forrású projektnél a `software*` mezők konfigurálhatóságát ez indokolja (13. fejezet).

### 3.3 Közös válasz-boríték: `BasicOnlineInvoiceResponseType` [magas]

Sorrend: **`common:header` → `common:result` → `software` → (operáció-specifikus elemek)**. A válasz `header`-je és `software`-e megegyezik a kérésével.

`common:result` (`common:BasicResultType`): `funcCode` (`OK` \| `ERROR`, kötelező) → `errorCode` (`SimpleText50NotBlankType`, opc.) → `message` (`SimpleText1024NotBlankType`, opc.) → `notifications` (opc.; `notification`[1..*] = `notificationCode` + `notificationText`). A `funcCode` mindig a teljes válasszal együtt értelmezendő (pl. `queryTransactionStatus` sikeres lekérdezésnél `OK`, akkor is, ha a számla `ABORTED`).

A request/response root elemek teljes listája és bázistípusa: Függelék C.

---

## 4. Kriptográfia

Minden hash **nagybetűs hexadecimális** string. A hashelt input UTF-8 bájtsorozat (a requestSignature inputja a gyakorlatban ASCII). [magas] (S2 1.3.2, 1.5, 1.8)

### 4.1 `passwordHash`
`passwordHash = UPPER(hex(SHA-512(jelszó)))`, attribútum `cryptoType="SHA-512"` (más érték: `INVALID_PASSWORD_HASH_CRYPTO`; a régi `SHA2-512` már nem elfogadott). Hivatalos tesztvektor (ismert jelszóval) **nincs** publikálva – az algoritmust a FIPS 180-4 „abc” vektorral és a NAV-minták hash-formátumával ellenőriztük.

### 4.2 `requestSignature` – minden operációnál, kivéve `manageInvoice`/`manageAnnulment`
`requestSignature = UPPER(hex(SHA3-512( requestId + mask(timestamp) + signKey )))`, `cryptoType="SHA3-512"`.

### 4.3 `requestSignature` – `manageInvoice` és `manageAnnulment`
```
partial      = requestId + mask(timestamp) + signKey
indexHash[i] = UPPER(hex(SHA3-512( invoiceOperation[i] + invoiceData[i] )))      // manageInvoice
indexHash[i] = UPPER(hex(SHA3-512( annulmentOperation[i] + invoiceAnnulment[i] ))) // manageAnnulment
requestSignature = UPPER(hex(SHA3-512( partial + indexHash[1] + indexHash[2] + … + indexHash[n] )))
```
- `invoiceOperation[i]` a literál műveleti érték (`CREATE`/`MODIFY`/`STORNO`, ill. `ANNUL`), `invoiceData[i]` pontosan az a **base64 szöveg**, ami az XML-ben szerepel (whitespace nélkül, ahogy elküldjük).
- Az index-hash-eket az `index` sorrendjében (1..n, hézag és ismétlés nélkül) fűzzük; a nem sorfolytonos index `INDEX_NOT_SEQUENTIAL` hibát ad.
- A requestSignature **nem** függ a `compressedContent`-től, az `electronicInvoiceHash`-től, a `software`-től és a `user` többi mezőjétől.

### 4.4 Timestamp-maszk
`mask("2017-12-30T18:25:45.000Z") = "20171230182545"` – a **`header/timestamp` UTC értékéből** (a szeparátorok, a tört másodperc és a zóna elhagyásával, `yyyyMMddHHmmss`). A maszkot mindig az elküldött stringből képezzük (ne egy újabb `Date.now()`-ból), különben `INVALID_REQUEST_SIGNATURE`.

### 4.5 `electronicInvoiceHash` (opcionális, `InvoiceOperationType` 4. eleme)
- `completenessIndicator=true` esetén kötelező, `cryptoType` csak `SHA3-512`, nagybetűs, és a szerver ellenőrzi; `false` esetén elfogadott `SHA3-512` vagy `SHA-256`, értékét **nem** validálják (S1 CHANGELOG_3.0; S2 1.8.2.1 6. pont; ERROR 26–28).
- **Ellentmondás:** a spec szerint „az invoiceData csomópont BASE64 enkódolt értékének … hash értéke” (S2 3.3.2 #28, 1.8.5.2), a NAV hivatalos `manageInvoice.xml` mintájában (mindhárom számla `completenessIndicator=true`) viszont a hash = **SHA3-512 a dekódolt számla-XML bájtjain**; a base64 szövegre számolt hash egyik esetben sem egyezik (12.2 kimenet). [magas a mintára; a szerver tényleges viselkedését nem tudtuk tesztelni]
- Mivel `completenessIndicator=true` jelenleg **blokkolt** (`INVOICE_COMPLETENESS_NOT_ALLOWED`, S2 3.3.2 #40), a programunk ne küldjön `electronicInvoiceHash`-t.

### 4.6 Csere-token dekódolása (`encodedExchangeToken`)
- Algoritmus: **AES-128, ECB mód**, kulcs = a technikai felhasználó **cserekulcsa**; a válaszban base64 (`xs:base64Binary`). A spec önellenőrzési útmutatója szerint online eszközben „AES ECB PKCS5PADDING” opciót kell választani → **PKCS#5/PKCS#7 padding**. A dekódolt token (pl. `b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U` alakú, ≤ 50 karakter) megy a `manageInvoice`/`manageAnnulment` `exchangeToken` elemébe. [magas] (S2 1.8.2.1, 1.8.10.2, 7.1)
- A kulcs bájtjai: a cserekulcs literál értéke UTF-8-ban (16 karakter = 16 bájt). Ezt hivatalos példa nem rögzíti; a széles körben használt `nav-connector` így csinálja (S16). [közepes]
- **Érvényesség:** a válasz `tokenValidityFrom`/`tokenValidityTo` (UTC) határozza meg; jelenleg 5 perc. **Egyszer használatos**, adózóra szól (más technikai felhasználó is felhasználhatja, ha a kérelmező cserekulcsával dekódolták); a lejáratot a szerveridő dönti el. Főverziók között nem átjárható. (S2 1.1, 1.6.9, 1.8.10)
- Hivatalos AES-tesztvektor **nincs** publikálva; round-trip tesztet futtattunk (12.2).

### 4.7 Reprodukció a hivatalos példán és a NAV mintáin [magas]

A spec 1.5.1 fiktív példája: `requestId=TSTKFT1222564`, `timestamp=2017-12-30T18:25:45.000Z`, aláírókulcs `ce-8f5e-215119fa7dd621DLMRHRLH2S`, 1. index `CREATE`+`QWJjZDEyMzQ=`, 2. index `MODIFY`+`RGNiYTQzMjE=`; várt requestSignature `60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42`. Ezen felül a NAV `sample/API sample/*.xml` fájljai XML-kommentben közlik a signKey-t (`ac-ac3a-7f661bff7d342N43CYX4U9FG`) és a manageInvoice index-hash-eit – így mind a 11 minta-kérés aláírása ellenőrizhető. A szkript (12.2) kimenete:

```text
OK   SHA-512("abc") KAT
     got      DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F
     expected DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F
OK   SHA3-512("abc") KAT
     got      B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0
     expected B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0
OK   spec 1.5.1 partial auth
     got      TSTKFT122256420171230182545ce-8f5e-215119fa7dd621DLMRHRLH2S
     expected TSTKFT122256420171230182545ce-8f5e-215119fa7dd621DLMRHRLH2S
OK   spec 1.5.1 index hash #1
     got      4317798460962869BC67F07C48EA7E4A3AFA301513CEB87B8EB94ECF92BC220A89C480F87F0860E85E29A3B6C0463D4F29712C5AD48104A6486CE839DC2F24CB
     expected 4317798460962869BC67F07C48EA7E4A3AFA301513CEB87B8EB94ECF92BC220A89C480F87F0860E85E29A3B6C0463D4F29712C5AD48104A6486CE839DC2F24CB
OK   spec 1.5.1 index hash #2
     got      A881218238933F6FFB9E167445CB4DAA9749BCF484FDE48AB7649FD25E8B634A4736A65A7C4A8E2831119F739837E006566F97370415AAD55E268605206F2A6C
     expected A881218238933F6FFB9E167445CB4DAA9749BCF484FDE48AB7649FD25E8B634A4736A65A7C4A8E2831119F739837E006566F97370415AAD55E268605206F2A6C
OK   spec 1.5.1 requestSignature
     got      60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42
     expected 60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42
OK   sample tokenExchange.xml requestSignature (requestId=RID896801578348, ts=2019-09-11T10:55:31.440Z)
     got      B4B5E0F197BFFD3DF69BCC98D3BE775F65FD5445EEF95C9D6B6C59425F2B81C4F6DA1FD563B0C7E7D98AF1E1725E5C63C2803B5D3A93D1C02ED354AC92F2CC94
     expected B4B5E0F197BFFD3DF69BCC98D3BE775F65FD5445EEF95C9D6B6C59425F2B81C4F6DA1FD563B0C7E7D98AF1E1725E5C63C2803B5D3A93D1C02ED354AC92F2CC94
OK   sample queryTaxpayer.xml requestSignature (requestId=RID215118906689, ts=2019-09-11T11:11:08.579Z)
     got      C5ADE8A2231C509D2887E6C2C4406CC5F72CA25B070AD3E94FADFA3F91A8A3667AF882DEDC7D67E9086E3D34A95886E929ACD8C924CD1E8357C89BEF43BA9126
     expected C5ADE8A2231C509D2887E6C2C4406CC5F72CA25B070AD3E94FADFA3F91A8A3667AF882DEDC7D67E9086E3D34A95886E929ACD8C924CD1E8357C89BEF43BA9126
OK   sample queryTransactionStatus.xml requestSignature (requestId=RID603063244730, ts=2019-09-11T10:55:34.063Z)
     got      3461426EDF923610281B5B24562F2EBA44A3118FEB7CCDD299B7ACAA6E7A5EA889B1965F1E3372F7F34064AC16C867958704089C9354F150248754D45C9A36F5
     expected 3461426EDF923610281B5B24562F2EBA44A3118FEB7CCDD299B7ACAA6E7A5EA889B1965F1E3372F7F34064AC16C867958704089C9354F150248754D45C9A36F5
OK   sample queryInvoiceData.xml requestSignature (requestId=RID005176453519, ts=2019-09-11T11:24:30.037Z)
     got      A3C2FE7C2068350B1B56B535ED1A4F8CA6C84AD5F19893556FFBD7B4655C79FBAC2A4BE271121174288B99BE2EDF5128028A67ACA1D0E883336362BF14E0BB39
     expected A3C2FE7C2068350B1B56B535ED1A4F8CA6C84AD5F19893556FFBD7B4655C79FBAC2A4BE271121174288B99BE2EDF5128028A67ACA1D0E883336362BF14E0BB39
OK   sample queryInvoiceDigest_outbound_query_params.xml requestSignature (requestId=RID242585074285, ts=2019-09-11T12:16:48.177Z)
     got      DB5EB960D80F120F2EEE21F6F46E21FB47CE5925EB7E6F8A72CFC12A24F3E1AB1C5D17EBD60163933457108C8D46C2B297F2CE8357C973AEE76A68CA5F70B6C6
     expected DB5EB960D80F120F2EEE21F6F46E21FB47CE5925EB7E6F8A72CFC12A24F3E1AB1C5D17EBD60163933457108C8D46C2B297F2CE8357C973AEE76A68CA5F70B6C6
OK   sample queryInvoiceDigest_inbound_invoice_chain.xml requestSignature (requestId=RID109071670896, ts=2019-09-13T07:41:26.467Z)
     got      457F27FBA25543B25B910673623654B53EDAF9DE2AB2D92785FD95FC310622283196074FA3419AD6A0E4D1B6352275A72716A259076F2DC3CFAAAB4112E82554
     expected 457F27FBA25543B25B910673623654B53EDAF9DE2AB2D92785FD95FC310622283196074FA3419AD6A0E4D1B6352275A72716A259076F2DC3CFAAAB4112E82554
OK   sample queryTransactionList.xml requestSignature (requestId=RID269353674733, ts=2020-02-05T08:54:27.238Z)
     got      54741EAEC6D929A4CA0B18CBC0839B229413EE972F16E7188873326A3DACBCF8A65447DC6C5E1141F790E7608B1F5FA7A70059D71BC7F2BF2C7FB3C0A77ABE58
     expected 54741EAEC6D929A4CA0B18CBC0839B229413EE972F16E7188873326A3DACBCF8A65447DC6C5E1141F790E7608B1F5FA7A70059D71BC7F2BF2C7FB3C0A77ABE58
OK   sample queryInvoiceCheck.xml requestSignature (requestId=RID016714253462, ts=2019-09-11T11:14:36.598Z)
     got      528B23AB4202FC7327F895A51B64EDE4199A81D776DEF1C7AF625A037D41BB98D61A9F2A2A444D8AAB7BB55737E0DAD9E1E46420C8FF1B7AA8EBBE4459CCF351
     expected 528B23AB4202FC7327F895A51B64EDE4199A81D776DEF1C7AF625A037D41BB98D61A9F2A2A444D8AAB7BB55737E0DAD9E1E46420C8FF1B7AA8EBBE4459CCF351
OK   sample queryInvoiceChainDigest.xml requestSignature (requestId=RID802364680498, ts=2020-02-05T09:10:48.488Z)
     got      27DF128E7E4D863E0B98F9A991219D0105DFBF7E8E7FFE3CC5182AAE3E04A3035BAEFAFC94CF25D011CAEAEECEC39C90F088DC5111F0197B7476FA0E2AF74070
     expected 27DF128E7E4D863E0B98F9A991219D0105DFBF7E8E7FFE3CC5182AAE3E04A3035BAEFAFC94CF25D011CAEAEECEC39C90F088DC5111F0197B7476FA0E2AF74070
OK   sample manageInvoice.xml index hash #1 (CREATE)
     got      41DB40243BFA1E80FE2DC0E8E28D1041CFC663BB31C4E65989BA8725FCFFF7A192FFFEBA299A1FD9C16A7CEE11981BA2D37AD6BFF4B1DB4C3D43DF863BD6CC7E
     expected 41DB40243BFA1E80FE2DC0E8E28D1041CFC663BB31C4E65989BA8725FCFFF7A192FFFEBA299A1FD9C16A7CEE11981BA2D37AD6BFF4B1DB4C3D43DF863BD6CC7E
OK   sample manageInvoice.xml index hash #2 (CREATE)
     got      94F8A2941BCCF88AA3EF6AC323D74146C1C4B243C181CDE373F1937753AE5F9361B23C5F41470D9444D5606DBA86241361F69C5DF3AF60A3C2CAF7ADD30E8C11
     expected 94F8A2941BCCF88AA3EF6AC323D74146C1C4B243C181CDE373F1937753AE5F9361B23C5F41470D9444D5606DBA86241361F69C5DF3AF60A3C2CAF7ADD30E8C11
OK   sample manageInvoice.xml index hash #3 (CREATE)
     got      9CEF0DA1FB6548DC474DCD9F760138E4019FD97B47C3D0DA794221C2DF37EE83F3F4835939B767337932ACCB84177B3F2C2947E03B0BF188AE103D1A9526F920
     expected 9CEF0DA1FB6548DC474DCD9F760138E4019FD97B47C3D0DA794221C2DF37EE83F3F4835939B767337932ACCB84177B3F2C2947E03B0BF188AE103D1A9526F920
OK   sample manageInvoice.xml requestSignature (3 ops)
     got      A111DD79CAE8E76EAD02E4E7C2D0C866292E50EDDF38D3E7312F1B950B53C08CBBFE12AD07DA10FB1876597DF49F2B6B7A9932B28933728B2E5E29AD05D20EED
     expected A111DD79CAE8E76EAD02E4E7C2D0C866292E50EDDF38D3E7312F1B950B53C08CBBFE12AD07DA10FB1876597DF49F2B6B7A9932B28933728B2E5E29AD05D20EED
OK   sample manageInvoice.xml electronicInvoiceHash #1 = SHA3-512(decoded invoiceData bytes)
     got      06327A94D9482F1162179A1A2CEEE80DE4E7BCE94F848DC53257921452F9AB781A38FE55835BB38479253451D674E768622BA5485EF659383907990EBDA3012D
     expected 06327A94D9482F1162179A1A2CEEE80DE4E7BCE94F848DC53257921452F9AB781A38FE55835BB38479253451D674E768622BA5485EF659383907990EBDA3012D
     (for comparison SHA3-512(base64 text) = 58535C34CC9C442E063FCE20301CD245... -> NO match)
OK   sample manageInvoice.xml electronicInvoiceHash #2 = SHA3-512(decoded invoiceData bytes)
     got      44423BA28A8988AD2091EF009DB7682730630961617D04657F1C645FACC649FEAC52B9ACE0ACE6ED1C07AC85823161EAAFF78EDE98F34512C6AF5049B40B6FB7
     expected 44423BA28A8988AD2091EF009DB7682730630961617D04657F1C645FACC649FEAC52B9ACE0ACE6ED1C07AC85823161EAAFF78EDE98F34512C6AF5049B40B6FB7
     (for comparison SHA3-512(base64 text) = 495EACC43C773DE44ABAC84680FB7843... -> NO match)
OK   sample manageInvoice.xml electronicInvoiceHash #3 = SHA3-512(decoded invoiceData bytes)
     got      1F1C1E8BDA6C52CA4F2CF805D402997B7ADD6B57705032F7AEA99308B84C5A9D0FCB70BBD52FEA572F4064D19227C2E78D6ADF047DBB058AAD0A4CE4A457888C
     expected 1F1C1E8BDA6C52CA4F2CF805D402997B7ADD6B57705032F7AEA99308B84C5A9D0FCB70BBD52FEA572F4064D19227C2E78D6ADF047DBB058AAD0A4CE4A457888C
     (for comparison SHA3-512(base64 text) = 28493A4D06D5AAE6ACE62966D2B48145... -> NO match)
OK   sample manageAnnulment.xml requestSignature (1 ops)
     got      96AA3EA7857159C9CC08E418B6A6BA744462C3DBC2D15C4FA82316032934B505D89F1501FD47780FA98E45C6D97C6875912911857223062946261304BC2A9378
     expected 96AA3EA7857159C9CC08E418B6A6BA744462C3DBC2D15C4FA82316032934B505D89F1501FD47780FA98E45C6D97C6875912911857223062946261304BC2A9378

passwordHash("Example-Pass1") = F64FC795528D1E53C0D39C5D076280AA9149054583B08C54ECDE32B8D580010D39F3838AD5121D3F3675394F546D6E685C083382E9D4823E70951FD1071D59C2
AES-128-ECB round trip: encodedExchangeToken = wNW1t6H1Qpy+Hb6qu5LmlGwUqNHCuwuhTsRSpjpR81IlIJ4qhnW183j42Bz7i7lRsGy6YJHSszOo1//Mc+GIew==
OK   AES-128-ECB decode round trip
     got      b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U
     expected b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U

24/24 checks passed
```

---

## 5. Operációk (kérés → válasz, pontos elemsorrend)

Az alábbiakban „+ boríték” = a 3.2/3.3 szerinti `common:header`, `common:user`, `software` (kérés), ill. `common:header`, `common:result`, `software` (válasz) – mindig ezek állnak elöl. Az összes típus teljes, XSD-ből generált táblázata: Függelék B. [magas – XSD; szabályok: S2 1.8]

### 5.1 `/tokenExchange`
- Kérés `TokenExchangeRequest` = csak a boríték (nincs extra elem).
- Válasz `TokenExchangeResponse`: + `encodedExchangeToken` (`xs:base64Binary`) → `tokenValidityFrom` → `tokenValidityTo` (`base:InvoiceTimestampType`, UTC).
- A predecessorTaxNumber-t csak validálják. Karbantartási „1. módban” csak ez az operáció tilt.

### 5.2 `/manageInvoice`
- Kérés `ManageInvoiceRequest` (`ManageInvoiceRequestType`): + `exchangeToken` (`SimpleText50NotBlankType`, a **dekódolt** token) → `invoiceOperations` (`InvoiceOperationListType`):
  - `compressedContent` (`xs:boolean`, kötelező, kérés-szintű: minden számla vagy tömörített, vagy egyik sem)
  - `invoiceOperation` [1..**100**] (`InvoiceOperationType`): `index` (`base:InvoiceIndexType`, xs:int 1–100, sorfolytonos 1-től) → `invoiceOperation` (`CREATE` \| `MODIFY` \| `STORNO`) → `invoiceData` (`xs:base64Binary`: az `InvoiceData` XML UTF-8 bájtjai base64-ben; tömörítve: base64(gzip(xml))) → `electronicInvoiceHash` [0..1] (`common:CryptoType`).
- Válasz `ManageInvoiceResponse` (`TransactionResponseType`): + `transactionId` (`common:EntityIdType`). A `transactionId` csak a szinkron rész sikerét jelzi; a tényleges eredmény a `/queryTransactionStatus`-ból jön.
- Szabályok: egy kérés = egy token; max. 100 számla; ugyanaz a számlaszám kétszer egy kérésben → `DUPLICATE_IN_REQUEST` (minden érintett index elutasítva); `batchInvoice` csak egyetlen indexű, `MODIFY`/`STORNO` kérésben (5.11). A base számla és a rá hivatkozó módosítás ne menjen egy kérésben – a feldolgozási sorrend nem garantált; a módosítás előtt érdemes megvárni az alapszámla `DONE` státuszát (S2 2.5).

### 5.3 `/queryTransactionStatus`
- Kérés: + `transactionId` (`common:EntityIdType`) → `returnOriginalRequest` [0..1] (`xs:boolean`, default false).
- Válasz `QueryTransactionStatusResponse`: + `processingResults` [0..1] (`ProcessingResultListType`):
  - `processingResult` [1..*] (`ProcessingResultType`): `index` → `batchIndex` [0..1] → `invoiceStatus` → `technicalValidationMessages` [0..*] (`common:TechnicalValidationResultType`: `validationResultCode` (`CRITICAL`\|`ERROR`), `validationErrorCode` [0..1], `message` [0..1]) → `businessValidationMessages` [0..*] (`BusinessValidationResultType`: `validationResultCode` (`ERROR`\|`WARN`\|`INFO`), `validationErrorCode` [0..1] (`SimpleText100NotBlankType`), `message` [0..1] (az XSD-ben **`SimpleText512NotBlankType`**, a spec táblázatában 1024), `pointer` [0..1] (`tag` [0..1], `value` [0..1], `line` [0..1] (`base:LineNumberType`), `originalInvoiceNumber` [0..1])) → `compressedContentIndicator` (`xs:boolean`, kötelező; a spec táblázata „compressedContent”-et ír – az XSD-név a helyes) → `originalRequest` [0..1] (`xs:base64Binary`).
  - `originalRequestVersion` (`1.0`\|`1.1`\|`2.0`\|`3.0`)
  - `annulmentData` [0..1]: `annulmentVerificationStatus` (`NOT_VERIFIABLE`\|`VERIFICATION_PENDING`\|`VERIFICATION_DONE`\|`VERIFICATION_REJECTED`) → `annulmentDecisionDate` [0..1] → `annulmentDecisionUser` [0..1].
- Ha nincs ilyen tranzakció: csak `funcCode=OK`, `processingResults` nélkül.
- **`invoiceStatus`** (`InvoiceStatusType`) jelentése (S2 1.8.8.2):

| Érték | Jelentés | Végleges? |
|---|---|---|
| `RECEIVED` | befogadva | nem |
| `PROCESSING` | feldolgozás megkezdődött | nem |
| `SAVED` | blokkoló hiba nélkül mentve, de a feldolgozás még tart | nem |
| `DONE` | sikeresen befejeződött → **csak ez teljesített adatszolgáltatás**; üzletileg hibátlan, ha nincs `businessValidationMessages` | igen |
| `ABORTED` | sikertelen (ERROR) → javítás után újra kell küldeni | igen |

- A `message` lokalizációja a lekérdező technikai felhasználó kapcsolattartási nyelvét követi. A `pointer` a WARN-oknál mutatja a taget/értéket/sort.

### 5.4 `/queryTaxpayer`
- Kérés: + `taxNumber` (`common:TaxpayerIdType`, 8 számjegy; csak magyar).
- Válasz: + `infoDate` [0..1] (xs:dateTime, utolsó változás) → `taxpayerValidity` [0..1] (`true`, ha az adószám létezik és érvényes; nem létező/érvénytelen → `false`) → `taxpayerData` [0..1] (csak ha létezik):
  - `taxpayerName` (`SimpleText512NotBlankType`) → `taxpayerShortName` [0..1] → `taxNumberDetail` (`base:TaxNumberType`: `base:taxpayerId`, `base:vatCode` [0..1], `base:countyCode` [0..1]) → `incorporation` (`ORGANIZATION` gazdasági társaság \| `SELF_EMPLOYED` egyéni vállalkozó \| `TAXABLE_PERSON` adószámos magánszemély) → `vatGroupMembership` [0..1] (áfacsoport törzsszáma) → `taxpayerAddressList` [0..1] → `taxpayerAddressItem` [1..*]: `taxpayerAddressType` (`HQ` székhely \| `SITE` telephely \| `BRANCH` fióktelep) → `taxpayerAddress` (`base:DetailedAddressType`, gyerekei `base:` névtérben).
- Felhasználás: vevő-adatok kitöltése/ellenőrzése a számlakiállítás folyamatában (kliens-diszkrecionális).

### 5.5 `/queryInvoiceData`
- Kérés: + `invoiceNumberQuery`: `invoiceNumber` → `invoiceDirection` (`OUTBOUND` kiállítóként \| `INBOUND` vevőként) → `batchIndex` [0..1] → `supplierTaxNumber` [0..1] (csak vevő oldali keresésnél; kiállítóként megadva `BAD_QUERY_PARAM_SUPPLIER_NOT_EXPECTED`).
- Válasz: + `invoiceDataResult` [0..1]: `invoiceData` (base64; ha tömörítve küldték, tömörítve jön vissza) → `auditData` (`insdate` **kisbetűs d-vel!**, `insCusUser`, `source` (`WEB`\|`XML`\|`MGM`\|`OPG`\|`OSZ`), `transactionId` [0..1], `index` [0..1], `batchIndex` [0..1], `originalRequestVersion`) → `compressedContentIndicator` → `electronicInvoiceHash` [0..1].
- Csak akkor van eredmény, ha a számla pontosan egyszer érvényes; többszörös → `MULTIPLE_QUERY_RESULT_FOUND` (HTTP 500).

### 5.6 `/queryInvoiceCheck`
- Kérés `QueryInvoiceCheckRequest` – **ugyanaz a típus**, mint a `queryInvoiceData` kérése (`invoiceNumberQuery`).
- Válasz: + `invoiceCheckResult` (`xs:boolean`): `true`, ha a számlaszám pontosan egyszer szerepel érvényesként.

### 5.7 `/queryInvoiceDigest`
- Kérés: + `page` (`common:RequestPageType`, ≥ 1) → `invoiceDirection` → `invoiceQueryParams`:
  - `mandatoryQueryParams` – **choice**: `invoiceIssueDate` (`dateFrom`, `dateTo`) \| `insDate` (`dateTimeFrom`, `dateTimeTo`, UTC) \| `originalInvoiceNumber`. Intervallum ≤ 35 nap (`BAD_QUERY_PARAM_RANGE_EXCEEDED`), from ≤ to (`BAD_QUERY_PARAM_OVERLAP`).
  - `additionalQueryParams` [0..1]: `taxNumber`, `groupMemberTaxNumber`, `name` (`QueryNameType`, min. 5 karakter, szó eleji egyezés), `invoiceCategory`, `paymentMethod`, `invoiceAppearance`, `source`, `currency` (mind [0..1], ebben a sorrendben).
  - `relationalQueryParams` [0..1]: `invoiceDelivery`, `paymentDate`, `invoiceNetAmount`, `invoiceNetAmountHUF`, `invoiceVatAmount`, `invoiceVatAmountHUF` (mind [0..2]; elem = `queryOperator` (`EQ`\|`GT`\|`GTE`\|`LT`\|`LTE`) + `queryValue`; EQ csak önmagában, tartománynál GT/GTE + LT/LTE pár).
  - `transactionQueryParams` [0..1]: `transactionId` → `index` [0..1] → `invoiceOperation` [0..1].
- Válasz: + `invoiceDigestResult`: `currentPage` → `availablePage` (0, ha nincs találat) → `invoiceDigest` [0..*] (lapnként max. 100; lapméretet/rendezést a szerver dönti el). Egyetlen lekérdezés, amely a többszörösen érvényes számlákat is listázza (`transactionId` alapján különböztethetők meg).

### 5.8 `/queryInvoiceChainDigest`
- Kérés: + `page` → `invoiceChainQuery`: `invoiceNumber` → `invoiceDirection` → `taxNumber` [0..1].
- Válasz: + `invoiceChainDigestResult`: `currentPage` → `availablePage` → `invoiceChainElement` [0..*]: `invoiceChainDigest` (`invoiceNumber`, `batchIndex` [0..1], `invoiceOperation`, `supplierTaxNumber`, `customerTaxNumber` [0..1], `insDate`, `originalRequestVersion`) → `invoiceLines` [0..1] (`maxLineNumber` → `newCreatedLines` [0..*]: `lineNumberIntervalStart`, `lineNumberIntervalEnd` – zárt intervallum) → `invoiceReferenceData` [0..1] (`originalInvoiceNumber`, `modifyWithoutMaster`, choice `modificationTimestamp` (1.x) \| `modificationIndex` (≥2.0)).
- **Hasznos** a módosítás előtti ellenőrzéshez: a lánc legnagyobb sorszáma és a felhasznált `modificationIndex`-ek.

### 5.9 `/queryTransactionList`
- Kérés: + `page` → `insDate` (`dateTimeFrom`, `dateTimeTo`, UTC, ≤ 35 nap) → `requestStatus` [0..1] (`RECEIVED`\|`PROCESSING`\|`SAVED`\|`FINISHED`\|`NOTIFIED`).
- Válasz: + `transactionListResult`: `currentPage` → `availablePage` → `transaction` [0..*]: `insDate`, `insCusUser`, `source`, `transactionId`, `requestStatus`, `technicalAnnulment`, `originalRequestVersion`, `itemCount`.
- Fő felhasználás: elveszett `transactionId` felderítése (6.5).

### 5.10 `/manageAnnulment` (technikai érvénytelenítés)
- Kérés: + `exchangeToken` → `annulmentOperations`: `annulmentOperation` [1..100]: `index` → `annulmentOperation` (`ANNUL`) → `invoiceAnnulment` (base64 egy `InvoiceAnnulment` XML-ről; annul névtér).
- `InvoiceAnnulment` (`annul:InvoiceAnnulmentType`): `annulmentReference` (`SimpleText50NotBlankType` – az érvénytelenítendő számla/okirat `invoiceNumber`-e) → `annulmentTimestamp` (`base:InvoiceTimestampType`, UTC) → `annulmentCode` (`ERRATIC_DATA`\|`ERRATIC_INVOICE_NUMBER`\|`ERRATIC_INVOICE_ISSUE_DATE`\|`ERRATIC_ELECTRONIC_HASH_VALUE`) → `annulmentReason` (`SimpleText1024NotBlankType`).
- Válasz: `TransactionResponseType` (`transactionId`).
- Szabályok (S2 2.4): csak `DONE` (legfeljebb WARN-os) adatszolgáltatásra; **webes jóváhagyás kell** (elsődleges felhasználó) – állapot az `annulmentData`-ban; egy számlára egyszerre csak egy elbírálás alatti kérés (`ANNULMENT_IN_PROGRESS`); alapszámla érvénytelenítése a rá épülő módosításokat is érinti; `completenessIndicator=true` adatszolgáltatás nem érvényteleníthető. **Nem azonos a számla sztornózásával** (9.6). Implementálása nem kötelező (kézzel is elvégezhető a webes felületen).

### 5.11 `batchInvoice` (kötegelt módosítás) röviden
`invoiceMain` choice: `invoice` \| `batchInvoice` [1..*] (`batchIndex` + `invoice`). Csak ha **egy okirat ≥ 2 számlát** módosít; csak `MODIFY`/`STORNO`, csak 1 indexes kérésben, `batchIndex` 1-től sorfolytonos, azonos vevő és eladó; bármelyik elem `ABORTED` → mind `ABORTED`. Egyszerű számlázónak **nem kell** (S2 2.5.6).

---

## 6. Hibakezelés

### 6.1 Hibaválasz-típusok [magas] (XSD; S2 3.1; S15)

- **`GeneralExceptionResponse`** (névtér: **common**; = `BasicResultType`: `funcCode`, `errorCode`, `message`, `notifications`): technikailag feldolgozhatatlan üzenet (rosszul formázott XML, rossz névtér/context root, rossz metódus/média típus). Élő példa a teszt API-ról (sémába nem illő body, 2026-10-27):
  ```xml
  <GeneralExceptionResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:ns2="http://schemas.nav.gov.hu/EAR/2.0/api" xmlns:ns3="http://schemas.nav.gov.hu/EAR/2.0/data" xmlns:ns4="http://schemas.nav.gov.hu/EAR/2.0/base" xmlns:ns5="http://schemas.nav.gov.hu/SSO/1.0/authentication">
    <funcCode>ERROR</funcCode><errorCode>INVALID_REQUEST</errorCode><message>Érvénytelen kérés!</message>
    <notifications><notification><notificationCode>SCHEMA_VIOLATION</notificationCode>
      <notificationText>Request body contains on line: [1] and column: [47] error: [cvc-elt.1.a: Cannot find the declaration of element 'Probe'.]</notificationText>
    </notification></notifications>
  </GeneralExceptionResponse>
  ```
  (HTTP 400.) Ugyanitt GET-re **HTTP 405** + `errorCode=NOT_ALLOWED_EXCEPTION` („Nincs ilyen művelet!”), `Content-Type: text/plain`-re **HTTP 415** + `INVALID_REQUEST` jött – a válaszban eÁFA/SSO névterek is deklarálva voltak, ami arra utal, hogy a teszt API előtt a közös NAV gateway áll. [magas a teszt-megfigyelésre; éles: nem próbáltuk]
  > ⚠️ Javítva (verifikáció): a fenti élő példában eredetileg `xmlns:ns2="http://schemas.nav.gov.hu/OSA/3.0/api"` szerepelt; a 2026-10-27-i ismételt próbán (`POST /invoiceService/v3/tokenExchange`, `<Probe/>` body) a 400-as válasz `ns2`–`ns5` prefixei az eÁFA (`EAR/2.0`) és SSO névterekre mutattak, az OSA-ra csak a 405-ös (GET) válaszban. A prefix-kiosztás tehát válaszonként változik – csak névtér-URI alapján parse-oljunk (3.1). A 400/405/415 státuszok és hibakódok megerősítve. Bizonyíték: élő próba a https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/tokenExchange végponton (hitelesítő adat nélkül).
- **`GeneralErrorResponse`** (névtér: **api**; `GeneralErrorResponseType` = `common:header` → `common:result` → `software` → `technicalValidationMessages` [0..*]): minden egyéb szinkron hiba (hitelesítés, jogosultság, aláírás, token, verzió…). A `technicalValidationMessages` az invoiceApi-sémasértéseket sorolja fel (`validationResultCode` jelenleg mindig `ERROR`).
- A szinkron hibát mindig a HTTP body hiba-root eleme jelzi; a normál response root csak sikeres szinkron feldolgozáskor képződik.

### 6.2 Szinkron (technikai és hitelesítési) hibakódok – 2026.08.11-es állapot [magas] (S2 3.2, 5.4)

| # | HTTP | Body | `errorCode` | Ok (röviden) | Kliens teendő |
|---|---|---|---|---|---|
| 1 | 404 | – | – | rossz endpoint | konfigurációs hiba, ne ismételjük |
| 2 | 500 | „Undertow … Generic exception occured!” | – | szerverhiba | backoff + újrapróbálás **új requestId-val** |
| 3 | 400 | GeneralExceptionResponse | `INVALID_REQUEST` | rosszul formázott XML / rossz névtér / sémasértés | kliens bug; `notifications` naplózása; ne ismételjük |
| 4 | 400 | GeneralErrorResponse | `INVALID_REQUEST` | invoiceApi-sémasértés | kliens bug |
| 5 | 401 | GeneralErrorResponse | `INVALID_SECURITY_USER` | hibás login + passwordHash | hitelesítő adatok ellenőrzése; leállás, felhasználó értesítése |
| 6 | 400 (korábban 500) | GeneralErrorResponse | `NOT_REGISTERED_CUSTOMER` | az adózó nincs regisztrálva | elsődleges felhasználó lépjen be a NAV Felhasználókezelőbe (2.5) |
| 7 | 400 (korábban 500) | GeneralErrorResponse | `INVALID_CUSTOMER` | nem létező / tiltott státuszú adószám | konfiguráció/ügyfél ellenőrzése |
| 8 | 400 (korábban 500) | GeneralErrorResponse | `INVALID_USER_RELATION` | a technikai felhasználó nem ehhez az adózóhoz tartozik / inaktív | konfiguráció |
| 9 | **403** (korábban 500) | GeneralErrorResponse | `FORBIDDEN` | nincs jogosultság az endpointhoz | jogosultság beállítása (2.5) |
| 10 | 400 | GeneralErrorResponse | `REQUEST_ID_NOT_UNIQUE` | már használt requestId | új requestId, újraküldés |
| 11 | 400 | GeneralErrorResponse | `INVALID_REQUEST_SIGNATURE` | aláírás nem egyezik | signKey / algoritmus ellenőrzése; a requestId elhasználódott |
| 12 | 400 | GeneralErrorResponse | `INDEX_NOT_SEQUENTIAL` | index nem 1..n | kliens bug |
| 13 | 400 | GeneralErrorResponse | `INVALID_EXCHANGE_TOKEN` | token nincs/lejárt/más adózóé/nincs vagy rossz AES-dekódolás | új token, egyszeri újrapróbálás; ismétlődésnél cserekulcs-ellenőrzés |
| 14 | 400 | GeneralErrorResponse | `REQUEST_VERSION_NOT_ALLOWED` | már nem támogatott verzió | frissítés szükséges |
| 15 | 527 → kívülről **503** | GeneralErrorResponse | `MAINTENANCE_MODE` | karbantartás | későbbi újrapróbálás (perces backoff), státusz-hír figyelése |
| 16 | 500 | GeneralErrorResponse | `STATUS_QUERY_NOT_ALLOWED` | státuszlekérdezés alacsonyabb requestVersion-nel | kliens bug |
| 17 | 500 | GeneralErrorResponse | `MULTIPLE_QUERY_RESULT_FOUND` | a számlaszám többször érvényes | technikai érvénytelenítés + újraküldés (kézi folyamat) |
| 18–23 | 400 | GeneralErrorResponse | `BAD_QUERY_PARAM_OVERLAP`, `…_RANGE_EXCEEDED`, `…_EQ_NOT_STANDALONE`, `…_OPERATOR_COLLISION`, `…_SUPPLIER_NOT_EXPECTED`, `…_SUPPLIER_EXPECTED` | lekérdezési paraméterhiba | kliens bug (lekérdezés-építés) |
| 24 | 400 | GeneralErrorResponse | `INVALID_TIMESTAMP` | timestamp a szerveridő ±1 napján kívül | órabeállítás |
| 25 | 400 | GeneralErrorResponse | `INVALID_PASSWORD_HASH_CRYPTO` | `cryptoType` ≠ `SHA-512` | kliens bug |
| 26 | 400 | GeneralErrorResponse | `INVALID_REQUEST_SIGNATURE_HASH_CRYPTO` | `cryptoType` ≠ `SHA3-512` | kliens bug |
| 27 | 400 | GeneralErrorResponse | `INVALID_REQUEST_VERSION` | `requestVersion` ≠ `3.0` | kliens bug |
| 28 | 400 | GeneralErrorResponse | `INVALID_HEADER_VERSION` | `headerVersion` megadva és ≠ `1.0` | kliens bug |
| 29 | 400 (korábban 500) | GeneralErrorResponse | `INVALID_PREDECESSOR_TAX_NUMBER` | nincs jogelőd-jogutód viszony | konfiguráció |
| 30 | **429** | GeneralErrorResponse | `TOO_MANY_REQUESTS` | technikai felhasználónkénti időablak-limit túllépve | **`Retry-After` (mp) kivárása**, utána újra |
| F1 | 500 | GeneralErrorResponse | `OPERATION_FAILED` | váratlan feldolgozási hiba (csak szinkron) | rövid várakozás után ismétlés; tartós hibánál NAV-helpdesk |
| F2 | 500 (élőben a teszten: **405**) | GeneralErrorResponse / GeneralExceptionResponse | `NOT_ALLOWED_EXCEPTION` | rossz HTTP-metódus / nem létező művelet | kliens bug |

A hibakódokat a NAV szándékosan nem enumként definiálja (bővülhetnek) → a kliens ismeretlen `errorCode`-ot is kezeljen (általános hibaként, naplózva). (S2 3.)

### 6.3 Aszinkron eredmények: technikai és üzleti validáció [magas] (S2 3.3)

- **`technicalValidationMessages`** (a `processingResult`-ban): `SCHEMA_VIOLATION` (az InvoiceData nem séma-valid; a `message` a hibás taget és értéket tartalmazza), `DUPLICATE_IN_REQUEST`, `COMPRESSION_TOLERANCE_EXCEEDED`, `DECOMPRESSION_ERROR` (pl. `compressedContent=true`, de nem gzip), `CREATE_WITH_BATCH_INVOICE_FOUND`, `MULTIPLE_INDICES_WITH_BATCH_INVOICE_FOUND`, `DUPLICATE_IN_INVOICE_REFERENCE`, `BATCH_INDEX_NOT_SEQUENTIAL`, `BATCH_INVOICE_CARDINALITY_ERROR`, `DUPLICATE_INVOICE_LINE_CREATION` – mind blokkoló (`ERROR`) → `ABORTED`.
- **`businessValidationMessages`**: `ERROR` = blokkoló (→ `ABORTED`), `WARN` = befogadva, de tartalmilag (valószínűleg) hibás, `INFO` = tájékoztató. Mindig az adott **indexre** vonatkozik, sosem a teljes kérésre. A `/queryTransactionStatus` maga ilyenkor is `funcCode=OK`.
- A NAV a WARN-okat szolgáltatásként adja; hiányuk nem bizonyítja a helyességet; a WARN-ok listája bővülhet. Számszaki eltérésnél a kerekítésből adódó eltérésre nem jelez (tűrés: lásd 8.4). (S2 3.3.3)

### 6.4 Idő-, méret- és forgalomkorlátok [magas, kivéve ahol jelölve]

| Korlát | Érték | Forrás |
|---|---|---|
| POST body | ≤ 10 MB | S2 1.6.5 |
| tömörített számla kicsomagolva | ≤ 15 MB / számla (`COMPRESSION_TOLERANCE_EXCEEDED`) | S2 1.6.5, 3.3.1 |
| számla / kérés | 1–100 (`InvoiceIndexType`) | XSD |
| szinkron válaszidő | jellemzően < 200 ms; blokkoló timeout 5000 ms; abszolút timeout 60 s | S2 1.6.6 |
| token érvényesség | jelenleg 5 perc (`tokenValidityTo` a mérvadó) | S2 1.1 |
| timestamp tűrés | ±1 nap | S2 1.3.1 |
| lekérdezési intervallum | ≤ 35 nap (840 óra) | S2 1.8.6, 1.8.7 |
| lapméret (digest/chain/list) | ≤ 100 tétel/lap, szerver dönti el | S2 1.8.3, 1.8.6 |
| rate limit (3.49) | technikai felhasználónként időablakos limit, HTTP 429 + `Retry-After`; a limit értéke nem publikus, NAV időszakosan felülvizsgálja | S2 3.2 #30, 5.4 |
| régi forgalomkorlátozás | IP-nként 1 kérés/s, további kérésenként +4000 ms késleltetés, 60 s felett terminálás – a spec szerint **csak a v1-es végpontokra** (`/tokenExchange`, `/manageInvoice`, `/queryInvoiceData`, `/queryInvoiceStatus`, `/queryTaxpayer`) | S2 1.6.11 [közepes – a lista elavultnak tűnik, de ajánlott ehhez igazodni] |

### 6.5 Ajánlott pollozás és az elveszett `transactionId` kezelése

- A NAV szerint a státusz „tetszőleges számban és gyakorisággal” lekérdezhető (S2 1.1), de 3.49 óta 429 is jöhet. **Javaslatunk** [közepes – saját ajánlás, hivatalos intervallum nincs]: első lekérdezés ~2 s-mal a `transactionId` után; utána exponenciális backoff (2 → 4 → 8 → 15 → 30 → 60 s, max. 60 s), összesen ~30 percig; utána háttérfeladatként óránként. Egy tranzakció összes indexe egy válaszban jön; `invoiceStatus ∈ {DONE, ABORTED}` minden indexen = vége (`SAVED` **nem** végleges). 429-nél a `Retry-After` az irányadó. Ne pollozzunk párhuzamosan ugyanarra a tranzakcióra; a kérések között tartsunk ≥ 1 s-ot.
- Adatszolgáltatás csak `DONE`-nal teljesített; az azonnaliság követelménye miatt a beküldést automatikusan, emberi beavatkozás nélkül kell végezni; kötegelés megengedett az első token érvényességén belül (S2 1.9.1).
- **Időtúllépés (nincs `transactionId`)** – NAV logikai referencia-implementáció (S2 1.9.2): ne küldjük újra azonnal; várjunk **5 percet** a beküldéstől, majd `/queryTransactionList` kb. az **utolsó 10 percre** (`insDate`); minden ismeretlen `transactionId`-ra `/queryTransactionStatus` **`returnOriginalRequest=true`**-val → az eredeti tartalomból (számlaszámok) párosítunk; ha nincs ismeretlen tranzakció, a beküldés szinkron hibával elutasult → **azonnal újraküldjük** (új token, új requestId). Mindezt emberi beavatkozás nélkül, szoftverlogikával.
- Duplikátum-védelem: ugyanazon számlaszám második beküldése, ha az első már `DONE`, `INVOICE_NUMBER_NOT_UNIQUE` (ERROR) lesz. Ha egy számla mégis kétszer szerepel érvényesként (a spec szerint ez csak külön tranzakciókból adódhat; a `/queryInvoiceDigest` listázza, a többi lekérdezés `MULTIPLE_QUERY_RESULT_FOUND`-ot ad), az egyiket technikailag érvényteleníteni kell (S2 1.8.6.2).

---

## 7. InvoiceData séma – teljes, rendezett elemfa és típusok

### 7.1 Alapok [magas]
- Root: **`InvoiceData`** a `http://schemas.nav.gov.hu/OSA/3.0/data` névtérben (`InvoiceDataType` kiterjesztése); a base-névterű gyerekekhez `xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base"` deklaráció kell. `xsi:schemaLocation` nem szükséges.
- Ez **külön XML-dokumentum**, amelyet UTF-8 bájtokként base64-elünk az `invoiceData` elembe (opcionálisan előtte gzip). Tizedes elválasztó mindig pont (S2 2.1.7). Az index-hash (és így a requestSignature) a base64 **szövegre** számolódik (4.3).
- `invoiceMain` choice: `invoice` (normál eset: CREATE, vagy 1 db MODIFY/STORNO) \| `batchInvoice` [1..*] (5.11).

### 7.2 Rendezett elemfa (XSD-ből generálva)

Jelölés: `[min..max]`, `{choice[..]}` = choice-ág, `base:` prefix = a base névtérben deklarált elem (a többi a data névtérben van); „… (lásd X fent)” = már kibontott típus. A `lineAmountsNormal`/`lineAmountsSimplified` két **opcionális** elemből álló choice → legfeljebb az egyik szerepel (módosításnál akár egyik sem).

```text
InvoiceData (data) : InvoiceDataType
  invoiceNumber [1..1] : common:SimpleText50NotBlankType
  invoiceIssueDate [1..1] : base:InvoiceDateType
  completenessIndicator [1..1] : xs:boolean
  invoiceMain [1..1] : data:InvoiceMainType
    invoice [1..1] {choice[1..1]} : data:InvoiceType
      invoiceReference [0..1] : data:InvoiceReferenceType
        originalInvoiceNumber [1..1] : common:SimpleText50NotBlankType
        modifyWithoutMaster [1..1] : xs:boolean
        modificationIndex [1..1] : base:InvoiceUnboundedIndexType
      invoiceHead [1..1] : data:InvoiceHeadType
        supplierInfo [1..1] : data:SupplierInfoType
          supplierTaxNumber [1..1] : base:TaxNumberType
            base:taxpayerId [1..1] : common:TaxpayerIdType
            base:vatCode [0..1] : common:VatCodeType
            base:countyCode [0..1] : common:CountyCodeType
          groupMemberTaxNumber [0..1] : base:TaxNumberType
            … (lásd base:TaxNumberType fent)
          communityVatNumber [0..1] : common:CommunityVatNumberType
          supplierName [1..1] : common:SimpleText512NotBlankType
          supplierAddress [1..1] : base:AddressType
            base:simpleAddress [1..1] {choice[1..1]} : base:SimpleAddressType
              base:countryCode [1..1] : common:CountryCodeType
              base:region [0..1] : common:SimpleText50NotBlankType
              base:postalCode [1..1] : common:PostalCodeType
              base:city [1..1] : common:SimpleText255NotBlankType
              base:additionalAddressDetail [1..1] : common:SimpleText255NotBlankType
            base:detailedAddress [1..1] {choice[1..1]} : base:DetailedAddressType
              base:countryCode [1..1] : common:CountryCodeType
              base:region [0..1] : common:SimpleText50NotBlankType
              base:postalCode [1..1] : common:PostalCodeType
              base:city [1..1] : common:SimpleText255NotBlankType
              base:streetName [1..1] : common:SimpleText255NotBlankType
              base:publicPlaceCategory [1..1] : common:SimpleText50NotBlankType
              base:number [0..1] : common:SimpleText50NotBlankType
              base:building [0..1] : common:SimpleText50NotBlankType
              base:staircase [0..1] : common:SimpleText50NotBlankType
              base:floor [0..1] : common:SimpleText50NotBlankType
              base:door [0..1] : common:SimpleText50NotBlankType
              base:lotNumber [0..1] : common:SimpleText50NotBlankType
          supplierBankAccountNumber [0..1] : common:BankAccountNumberType
          individualExemption [0..1] : xs:boolean
          exciseLicenceNum [0..1] : common:SimpleText50NotBlankType
        customerInfo [0..1] : data:CustomerInfoType
          customerVatStatus [1..1] : data:CustomerVatStatusType
          customerVatData [0..1] : data:CustomerVatDataType
            customerTaxNumber [1..1] {choice[1..1]} : data:CustomerTaxNumberType
              base:taxpayerId [1..1] : common:TaxpayerIdType
              base:vatCode [0..1] : common:VatCodeType
              base:countyCode [0..1] : common:CountyCodeType
              groupMemberTaxNumber [0..1] : base:TaxNumberType
                … (lásd base:TaxNumberType fent)
            communityVatNumber [1..1] {choice[1..1]} : common:CommunityVatNumberType
            thirdStateTaxId [1..1] {choice[1..1]} : common:SimpleText50NotBlankType
          customerName [0..1] : common:SimpleText512NotBlankType
          customerAddress [0..1] : base:AddressType
            … (lásd base:AddressType fent)
          customerBankAccountNumber [0..1] : common:BankAccountNumberType
        fiscalRepresentativeInfo [0..1] : data:FiscalRepresentativeType
          fiscalRepresentativeTaxNumber [1..1] : base:TaxNumberType
            … (lásd base:TaxNumberType fent)
          fiscalRepresentativeName [1..1] : common:SimpleText512NotBlankType
          fiscalRepresentativeAddress [1..1] : base:AddressType
            … (lásd base:AddressType fent)
          fiscalRepresentativeBankAccountNumber [0..1] : common:BankAccountNumberType
        invoiceDetail [1..1] : data:InvoiceDetailType
          invoiceCategory [1..1] : base:InvoiceCategoryType
          invoiceDeliveryDate [1..1] : base:InvoiceDateType
          invoiceDeliveryPeriodStart [0..1] : base:InvoiceDateType
          invoiceDeliveryPeriodEnd [0..1] : base:InvoiceDateType
          invoiceAccountingDeliveryDate [0..1] : base:InvoiceDateType
          periodicalSettlement [0..1] : xs:boolean
          smallBusinessIndicator [0..1] : xs:boolean
          currencyCode [1..1] : common:CurrencyType
          exchangeRate [1..1] : data:ExchangeRateType
          utilitySettlementIndicator [0..1] : xs:boolean
          selfBillingIndicator [0..1] : xs:boolean
          paymentMethod [0..1] : base:PaymentMethodType
          paymentDate [0..1] : base:InvoiceDateType
          cashAccountingIndicator [0..1] : xs:boolean
          invoiceAppearance [1..1] : base:InvoiceAppearanceType
          conventionalInvoiceInfo [0..1] : data:ConventionalInvoiceInfoType
            orderNumbers [0..1] : data:OrderNumbersType
              orderNumber [1..*] : common:SimpleText100NotBlankType
            deliveryNotes [0..1] : data:DeliveryNotesType
              deliveryNote [1..*] : common:SimpleText100NotBlankType
            shippingDates [0..1] : data:ShippingDatesType
              shippingDate [1..*] : common:SimpleText100NotBlankType
            contractNumbers [0..1] : data:ContractNumbersType
              contractNumber [1..*] : common:SimpleText100NotBlankType
            supplierCompanyCodes [0..1] : data:SupplierCompanyCodesType
              supplierCompanyCode [1..*] : common:SimpleText100NotBlankType
            customerCompanyCodes [0..1] : data:CustomerCompanyCodesType
              customerCompanyCode [1..*] : common:SimpleText100NotBlankType
            dealerCodes [0..1] : data:DealerCodesType
              dealerCode [1..*] : common:SimpleText100NotBlankType
            costCenters [0..1] : data:CostCentersType
              costCenter [1..*] : common:SimpleText100NotBlankType
            projectNumbers [0..1] : data:ProjectNumbersType
              projectNumber [1..*] : common:SimpleText100NotBlankType
            generalLedgerAccountNumbers [0..1] : data:GeneralLedgerAccountNumbersType
              generalLedgerAccountNumber [1..*] : common:SimpleText100NotBlankType
            glnNumbersSupplier [0..1] : data:GlnNumbersType
              glnNumber [1..*] : common:SimpleText100NotBlankType
            glnNumbersCustomer [0..1] : data:GlnNumbersType
              … (lásd data:GlnNumbersType fent)
            materialNumbers [0..1] : data:MaterialNumbersType
              materialNumber [1..*] : common:SimpleText100NotBlankType
            itemNumbers [0..1] : data:ItemNumbersType
              itemNumber [1..*] : common:SimpleText100NotBlankType
            ekaerIds [0..1] : data:EkaerIdsType
              ekaerId [1..*] : data:EkaerIdType
          additionalInvoiceData [0..*] : data:AdditionalDataType
            dataName [1..1] : data:DataNameType
            dataDescription [1..1] : common:SimpleText255NotBlankType
            dataValue [1..1] : common:SimpleText512NotBlankType
      invoiceLines [0..1] : data:LinesType
        mergedItemIndicator [1..1] : xs:boolean
        line [1..*] : data:LineType
          lineNumber [1..1] : base:LineNumberType
          lineModificationReference [0..1] : data:LineModificationReferenceType
            lineNumberReference [1..1] : base:LineNumberType
            lineOperation [1..1] : data:LineOperationType
          referencesToOtherLines [0..1] : data:ReferencesToOtherLinesType
            referenceToOtherLine [1..*] : base:LineNumberType
          advanceData [0..1] : data:AdvanceDataType
            advanceIndicator [1..1] : xs:boolean
            advancePaymentData [0..1] : data:AdvancePaymentDataType
              advanceOriginalInvoice [1..1] : common:SimpleText50NotBlankType
              advancePaymentDate [1..1] : base:InvoiceDateType
              advanceExchangeRate [1..1] : data:ExchangeRateType
          productCodes [0..1] : data:ProductCodesType
            productCode [1..*] : data:ProductCodeType
              productCodeCategory [1..1] : data:ProductCodeCategoryType
              productCodeValue [1..1] {choice[1..1]} : data:ProductCodeValueType
              productCodeOwnValue [1..1] {choice[1..1]} : common:SimpleText255NotBlankType
          lineExpressionIndicator [1..1] : xs:boolean
          lineNatureIndicator [0..1] : data:LineNatureIndicatorType
          lineDescription [0..1] : common:SimpleText512NotBlankType
          quantity [0..1] : data:QuantityType
          unitOfMeasure [0..1] : data:UnitOfMeasureType
          unitOfMeasureOwn [0..1] : common:SimpleText50NotBlankType
          unitPrice [0..1] : data:QuantityType
          unitPriceHUF [0..1] : data:QuantityType
          lineDiscountData [0..1] : data:DiscountDataType
            discountDescription [0..1] : common:SimpleText255NotBlankType
            discountValue [0..1] : base:MonetaryType
            discountRate [0..1] : data:RateType
          lineAmountsNormal [0..1] {choice[1..1]} : data:LineAmountsNormalType
            lineNetAmountData [1..1] : data:LineNetAmountDataType
              lineNetAmount [1..1] : base:MonetaryType
              lineNetAmountHUF [1..1] : base:MonetaryType
            lineVatRate [1..1] : data:VatRateType
              vatPercentage [1..1] {choice[1..1]} : data:RateType
              vatContent [1..1] {choice[1..1]} : data:RateType
              vatExemption [1..1] {choice[1..1]} : data:DetailedReasonType
                case [1..1] : common:SimpleText50NotBlankType
                reason [1..1] : common:SimpleText200NotBlankType
              vatOutOfScope [1..1] {choice[1..1]} : data:DetailedReasonType
                … (lásd data:DetailedReasonType fent)
              vatDomesticReverseCharge [1..1] {choice[1..1]} : xs:boolean (fixed=true)
              marginSchemeIndicator [1..1] {choice[1..1]} : data:MarginSchemeType
              vatAmountMismatch [1..1] {choice[1..1]} : data:VatAmountMismatchType
                vatRate [1..1] : data:RateType
                case [1..1] : common:SimpleText50NotBlankType
              noVatCharge [1..1] {choice[1..1]} : xs:boolean (fixed=true)
            lineVatData [0..1] : data:LineVatDataType
              lineVatAmount [1..1] : base:MonetaryType
              lineVatAmountHUF [1..1] : base:MonetaryType
            lineGrossAmountData [0..1] : data:LineGrossAmountDataType
              lineGrossAmountNormal [1..1] : base:MonetaryType
              lineGrossAmountNormalHUF [1..1] : base:MonetaryType
          lineAmountsSimplified [0..1] {choice[1..1]} : data:LineAmountsSimplifiedType
            lineVatRate [1..1] : data:VatRateType
              … (lásd data:VatRateType fent)
            lineGrossAmountSimplified [1..1] : base:MonetaryType
            lineGrossAmountSimplifiedHUF [1..1] : base:MonetaryType
          intermediatedService [0..1] : xs:boolean
          aggregateInvoiceLineData [0..1] : data:AggregateInvoiceLineDataType
            lineExchangeRate [0..1] : data:ExchangeRateType
            lineDeliveryDate [1..1] : base:InvoiceDateType
          newTransportMean [0..1] : data:NewTransportMeanType
            brand [0..1] : common:SimpleText50NotBlankType
            serialNum [0..1] : common:SimpleText255NotBlankType
            engineNum [0..1] : common:SimpleText255NotBlankType
            firstEntryIntoService [0..1] : base:InvoiceDateType
            vehicle [1..1] {choice[1..1]} : data:VehicleType
              engineCapacity [1..1] : data:QuantityType
              enginePower [1..1] : data:QuantityType
              kms [1..1] : data:QuantityType
            vessel [1..1] {choice[1..1]} : data:VesselType
              length [1..1] : data:QuantityType
              activityReferred [1..1] : xs:boolean
              sailedHours [1..1] : data:QuantityType
            aircraft [1..1] {choice[1..1]} : data:AircraftType
              takeOffWeight [1..1] : data:QuantityType
              airCargo [1..1] : xs:boolean
              operationHours [1..1] : data:QuantityType
          depositIndicator [0..1] : xs:boolean
          obligatedForProductFee [0..1] : xs:boolean
          GPCExcise [0..1] : base:MonetaryType
          dieselOilPurchase [0..1] : data:DieselOilPurchaseType
            purchaseLocation [1..1] : base:SimpleAddressType
              … (lásd base:SimpleAddressType fent)
            purchaseDate [1..1] : base:InvoiceDateType
            vehicleRegistrationNumber [1..1] : common:PlateNumberType
            dieselOilQuantity [0..1] : data:QuantityType
          netaDeclaration [0..1] : xs:boolean
          productFeeClause [0..1] : data:ProductFeeClauseType
            productFeeTakeoverData [1..1] {choice[1..1]} : data:ProductFeeTakeoverDataType
              takeoverReason [1..1] : data:TakeoverType
              takeoverAmount [0..1] : base:MonetaryType
            customerDeclaration [1..1] {choice[1..1]} : data:CustomerDeclarationType
              productStream [1..1] : data:ProductStreamType
              productFeeWeight [0..1] : data:QuantityType
          lineProductFeeContent [0..*] : data:ProductFeeDataType
            productFeeCode [1..1] : data:ProductCodeType
              … (lásd data:ProductCodeType fent)
            productFeeQuantity [1..1] : data:QuantityType
            productFeeMeasuringUnit [1..1] : data:ProductFeeMeasuringUnitType
            productFeeRate [1..1] : base:MonetaryType
            productFeeAmount [1..1] : base:MonetaryType
          conventionalLineInfo [0..1] : data:ConventionalInvoiceInfoType
            … (lásd data:ConventionalInvoiceInfoType fent)
          additionalLineData [0..*] : data:AdditionalDataType
            … (lásd data:AdditionalDataType fent)
      productFeeSummary [0..2] : data:ProductFeeSummaryType
        productFeeOperation [1..1] : data:ProductFeeOperationType
        productFeeData [1..*] : data:ProductFeeDataType
          … (lásd data:ProductFeeDataType fent)
        productChargeSum [1..1] : base:MonetaryType
        paymentEvidenceDocumentData [0..1] : data:PaymentEvidenceDocumentDataType
          evidenceDocumentNo [1..1] : common:SimpleText50NotBlankType
          evidenceDocumentDate [1..1] : base:InvoiceDateType
          obligatedName [1..1] : common:SimpleText255NotBlankType
          obligatedAddress [1..1] : base:AddressType
            … (lásd base:AddressType fent)
          obligatedTaxNumber [1..1] : base:TaxNumberType
            … (lásd base:TaxNumberType fent)
      invoiceSummary [1..1] : data:SummaryType
        summaryNormal [1..1] {choice[1..1]} : data:SummaryNormalType
          summaryByVatRate [1..*] : data:SummaryByVatRateType
            vatRate [1..1] : data:VatRateType
              … (lásd data:VatRateType fent)
            vatRateNetData [1..1] : data:VatRateNetDataType
              vatRateNetAmount [1..1] : base:MonetaryType
              vatRateNetAmountHUF [1..1] : base:MonetaryType
            vatRateVatData [1..1] : data:VatRateVatDataType
              vatRateVatAmount [1..1] : base:MonetaryType
              vatRateVatAmountHUF [1..1] : base:MonetaryType
            vatRateGrossData [0..1] : data:VatRateGrossDataType
              vatRateGrossAmount [1..1] : base:MonetaryType
              vatRateGrossAmountHUF [1..1] : base:MonetaryType
          invoiceNetAmount [1..1] : base:MonetaryType
          invoiceNetAmountHUF [1..1] : base:MonetaryType
          invoiceVatAmount [1..1] : base:MonetaryType
          invoiceVatAmountHUF [1..1] : base:MonetaryType
        summarySimplified [1..*] {choice[1..1]} : data:SummarySimplifiedType
          vatRate [1..1] : data:VatRateType
            … (lásd data:VatRateType fent)
          vatContentGrossAmount [1..1] : base:MonetaryType
          vatContentGrossAmountHUF [1..1] : base:MonetaryType
        summaryGrossData [0..1] : data:SummaryGrossDataType
          invoiceGrossAmount [1..1] : base:MonetaryType
          invoiceGrossAmountHUF [1..1] : base:MonetaryType
    batchInvoice [1..*] {choice[1..1]} : data:BatchInvoiceType
      batchIndex [1..1] : base:InvoiceUnboundedIndexType
      invoice [1..1] : data:InvoiceType
        … (lásd data:InvoiceType fent)
```

### 7.3 Típusonkénti megjegyzések (amire a builder-nek figyelnie kell)

- **`InvoiceDataType`**: `invoiceNumber` (`SimpleText50NotBlankType`: 1–50 kar., nem csupa whitespace; **üzletileg nem kezdődhet/végződhet whitespace-szel** → `INVALID_INVOICE_NUMBER` ERROR; adózónként egyedi), `invoiceIssueDate` (`base:InvoiceDateType` ≥ 2010-01-01, minta `\d{4}-\d{2}-\d{2}` – időzóna-utótag tilos), `completenessIndicator` (kötelező; jelenleg mindig `false`, 9.1).
- **`InvoiceReferenceType`** (csak MODIFY/STORNO-ban, CREATE-ben tilos): `originalInvoiceNumber` → `modifyWithoutMaster` → `modificationIndex` (`InvoiceUnboundedIndexType`, xs:int ≥ 1).
- **`InvoiceHeadType`**: `supplierInfo` → `customerInfo` [0..1] (CREATE-nél üzletileg kötelező: `CUSTOMER_INFO_MISSING`) → `fiscalRepresentativeInfo` [0..1] → `invoiceDetail`.
- **`TaxNumberType`** (base): `taxpayerId` (8 számjegy) → `vatCode` [0..1] (`[1-5]{1}`, length 1) → `countyCode` [0..1] (`[0-9]{2}`). Csoportos áfaalanynál `supplierTaxNumber`/`customerTaxNumber` = csoportazonosító (áfakód 5), a tag saját száma (áfakód 4) a `groupMemberTaxNumber`-be. Eladó áfakódja nem lehet 4 (WARN 50). Az áfakód 1/2/3 jogi jelentését a jogi kutatás tisztázza; a NAV 1311-es WARN-ja az „1”-es áfakódú vevőt kivételként kezeli. [közepes]
- **`AddressType`** (base): choice `simpleAddress` \| `detailedAddress`. `SimpleAddressType`: `countryCode` → `region` [0..1] → `postalCode` → `city` → `additionalAddressDetail`. `DetailedAddressType`: `countryCode` → `region` [0..1] → `postalCode` → `city` → `streetName` → `publicPlaceCategory` → `number` → `building` → `staircase` → `floor` → `door` → `lotNumber` (az utolsó hat [0..1]). Ha nincs irányítószám az adott országban: `0000`.
- **`SupplierInfoType`**: `supplierTaxNumber` → `groupMemberTaxNumber` [0..1] → `communityVatNumber` [0..1] → `supplierName` → `supplierAddress` → `supplierBankAccountNumber` [0..1] → `individualExemption` [0..1] (true = alanyi áfamentes eladó) → `exciseLicenceNum` [0..1]. A `supplierTaxNumber/taxpayerId`-nek egyeznie kell a `user/taxNumber`-rel (`SUPPLIER_TAX_NUMBER_MISMATCH`, kivéve jogelőd-pótlás).
- **`CustomerInfoType`**: `customerVatStatus` (`DOMESTIC` \| `OTHER` \| `PRIVATE_PERSON`) → `customerVatData` [0..1] → `customerName` [0..1] → `customerAddress` [0..1] → `customerBankAccountNumber` [0..1]. **`CustomerVatDataType`** = choice: `customerTaxNumber` (`CustomerTaxNumberType` = `base:TaxNumberType` + `groupMemberTaxNumber` [0..1]) \| `communityVatNumber` (`[A-Z]{2}[0-9A-Z]{2,13}`, 4–15 kar.) \| `thirdStateTaxId` (`SimpleText50NotBlankType`) – **csak egy adható meg**. Szabályok: 8.5.
- **`InvoiceDetailType`** (pontos sorrend): `invoiceCategory` → `invoiceDeliveryDate` → `invoiceDeliveryPeriodStart` [0..1] → `invoiceDeliveryPeriodEnd` [0..1] → `invoiceAccountingDeliveryDate` [0..1] → `periodicalSettlement` [0..1] → `smallBusinessIndicator` [0..1] → `currencyCode` → `exchangeRate` → `utilitySettlementIndicator` [0..1] → `selfBillingIndicator` [0..1] → `paymentMethod` [0..1] → `paymentDate` [0..1] → `cashAccountingIndicator` [0..1] → `invoiceAppearance` → `conventionalInvoiceInfo` [0..1] → `additionalInvoiceData` [0..*]. Ha a számlán nincs teljesítési dátum, `invoiceDeliveryDate` = `invoiceIssueDate`. Gyűjtőszámlánál a tételek közül a legkésőbbi. `currencyCode`+`exchangeRate` mindig kötelező (HUF → `1`).
- **`LineType`**: 28 elem, sorrendben (teljes táblázat: Függelék A) – a leggyakoribbak: `lineNumber` → `lineModificationReference` [0..1] → `referencesToOtherLines` [0..1] → `advanceData` [0..1] → `productCodes` [0..1] → `lineExpressionIndicator` → `lineNatureIndicator` [0..1] → `lineDescription` [0..1] → `quantity` [0..1] → `unitOfMeasure` [0..1] → `unitOfMeasureOwn` [0..1] → `unitPrice` [0..1] → `unitPriceHUF` [0..1] → `lineDiscountData` [0..1] → (`lineAmountsNormal` \| `lineAmountsSimplified`) → `intermediatedService` [0..1] → `aggregateInvoiceLineData` [0..1] → … → `conventionalLineInfo` [0..1] → `additionalLineData` [0..*]. `lineNumber` 1-től ismétlés és hézag nélkül (`LINE_NUMBER_NOT_SEQUENTIAL`). Ha `lineExpressionIndicator=true` → `lineDescription`, `quantity`, `unitOfMeasure`, `unitPrice` kötelező; ha `false` → csak `lineDescription` (`MANDATORY_LINE_CONTENT_MISSING`). `unitOfMeasure=OWN` → `unitOfMeasureOwn` kötelező (ERROR, 2025-09-15-től). Túl hosszú megnevezést 512 karakterre kell csonkolni.
- **`AdvanceDataType`**: `advanceIndicator` (true = előleg jellegű tétel) → `advancePaymentData` [0..1] (`advanceOriginalInvoice` = az előlegszámla **számlaszáma**, `advancePaymentDate`, `advanceExchangeRate`) – az előlegszámlán csak `advanceIndicator=true`, a végszámlán az `advancePaymentData` is megadható.
- **`LineAmountsNormalType`**: `lineNetAmountData` (`lineNetAmount`, `lineNetAmountHUF`) → `lineVatRate` → `lineVatData` [0..1] (`lineVatAmount`, `lineVatAmountHUF`) → `lineGrossAmountData` [0..1] (`lineGrossAmountNormal`, `lineGrossAmountNormalHUF`). **`LineAmountsSimplifiedType`**: `lineVatRate` → `lineGrossAmountSimplified` → `lineGrossAmountSimplifiedHUF`.
- **`VatRateType`** – choice, pontosan egy (sorrendben): `vatPercentage` (`RateType` 0–1, max. 4 tizedes; **0.27 és nem 27**) \| `vatContent` (csak egyszerűsített számlán) \| `vatExemption` (`DetailedReasonType`) \| `vatOutOfScope` (`DetailedReasonType`) \| `vatDomesticReverseCharge` (`fixed=true`) \| `marginSchemeIndicator` (`TRAVEL_AGENCY`\|`SECOND_HAND`\|`ARTWORK`\|`ANTIQUES`) \| `vatAmountMismatch` (`vatRate` + `case`) \| `noVatCharge` (`fixed=true`). A boolean ágakban csak `true` (vagy `1`) írható.
- **`DetailedReasonType`**: `case` (`SimpleText50NotBlankType`) → `reason` (`SimpleText200NotBlankType`). A **`case` nem XSD-enum** (csak „nem üres” pattern), az értékkészletet **üzleti validáció** ellenőrzi, csak nagybetűvel: `vatExemption/case` ∈ {`AAM`, `TAM`, `KBAET`, `KBAUK`, `EAM`, `NAM`, `UNKNOWN`*}; `vatOutOfScope/case` ∈ {`ATK`, `EUFAD37`, `EUFADE`, `EUE`, `HO`, `UNKNOWN`*}; `vatAmountMismatch/case` ∈ {`REFUNDABLE_VAT`, `NONREFUNDABLE_VAT`, `UNKNOWN`*} (*`UNKNOWN` csak MODIFY/STORNO-nál, ha `modifyWithoutMaster=true` vagy a hivatkozott számla < 3.0). Hibakódok: `INVALID_LINE_VAT_EXEMPTION_CODE`, `INVALID_SUMMARY_VAT_EXEMPTION_CODE`, `INVALID_LINE_VAT_OUT_OF_SCOPE_CODE`, … (S2 2.2.3.2.1, 3.3.2 #31–37). A `reason` szabad szöveg (a spec az esetek magyarázatát adja meg, pl. „Alanyi adómentes”).
- **`SummaryType`**: choice (`summaryNormal` [1..1] \| `summarySimplified` [1..*]) → `summaryGrossData` [0..1] (`invoiceGrossAmount`, `invoiceGrossAmountHUF`). **`SummaryNormalType`**: `summaryByVatRate` [1..*] → `invoiceNetAmount` → `invoiceNetAmountHUF` → `invoiceVatAmount` → `invoiceVatAmountHUF`. **`SummaryByVatRateType`**: `vatRate` → `vatRateNetData` (`vatRateNetAmount`, `vatRateNetAmountHUF`) → `vatRateVatData` (`vatRateVatAmount`, `vatRateVatAmountHUF`) – **mentes/hatályon kívüli kulcsnál is kötelező elem, 0 értékkel** → `vatRateGrossData` [0..1]. `vatExemption`/`vatOutOfScope` esetén azonos `case`-hez elég egy összesítő; `vatAmountMismatch`-nél minden különböző (`case`, `vatRate`) párra külön.
- **`LineModificationReferenceType`**: `lineNumberReference` (`LineNumberType`) → `lineOperation` (`LineOperationType`: XSD-ben `CREATE` \| `MODIFY`, de **2023-09-18 óta csak `CREATE` fogadható el** – `INVALID_LINE_OPERATION`).

### 7.4 Egyszerű típusok (facetek, enumok – XSD-ből generálva)

| típus | alap | facetek | enum értékek |
|---|---|---|---|
| `common:SimpleText50NotBlankType` | `common:AtomicStringType50` | pattern=`.*[^\s].*` | – |
| `common:SimpleText100NotBlankType` | `common:AtomicStringType100` | pattern=`.*[^\s].*` | – |
| `common:SimpleText200NotBlankType` | `common:AtomicStringType200` | pattern=`.*[^\s].*` | – |
| `common:SimpleText255NotBlankType` | `common:AtomicStringType255` | pattern=`.*[^\s].*` | – |
| `common:SimpleText512NotBlankType` | `common:AtomicStringType512` | pattern=`.*[^\s].*` | – |
| `common:SimpleText1024NotBlankType` | `common:AtomicStringType1024` | pattern=`.*[^\s].*` | – |
| `common:TaxpayerIdType` | `common:AtomicStringType8` | length=`8`, pattern=`[0-9]{8}` | – |
| `common:VatCodeType` | `common:AtomicStringType2` | length=`1`, pattern=`[1-5]{1}` | – |
| `common:CountyCodeType` | `common:AtomicStringType2` | length=`2`, pattern=`[0-9]{2}` | – |
| `common:CountryCodeType` | `common:AtomicStringType2` | length=`2`, pattern=`[A-Z]{2}` | – |
| `common:PostalCodeType` | `common:AtomicStringType15` | minLength=`3`, maxLength=`10`, pattern=`[A-Z0-9][A-Z0-9\s\-]{1,8}[A-Z0-9]` | – |
| `common:CurrencyType` | `common:AtomicStringType4` | length=`3`, pattern=`[A-Z]{3}` | – |
| `common:BankAccountNumberType` | `common:AtomicStringType50` | minLength=`15`, maxLength=`34`, pattern=`[0-9]{8}[-][0-9]{8}[-][0-9]{8}\|[0-9]{8}[-][0-9]{8}\|[A-Z]{2}[0-9]{2}[0-9A-Za-z]{11,30}` | – |
| `common:CommunityVatNumberType` | `common:AtomicStringType15` | minLength=`4`, maxLength=`15`, pattern=`[A-Z]{2}[0-9A-Z]{2,13}` | – |
| `common:EntityIdType` | `common:AtomicStringType32` | maxLength=`30`, minLength=`1`, pattern=`[+a-zA-Z0-9_]{1,30}` | – |
| `common:LoginType` | `common:AtomicStringType15` | minLength=`6`, maxLength=`15`, pattern=`[a-zA-Z0-9]{6,15}` | – |
| `common:GenericTimestampType` | `xs:dateTime` | pattern=`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z` | – |
| `common:AtomicStringType15` | `xs:string` | minLength=`1`, maxLength=`15` | – |
| `common:FunctionCodeType` | `common:AtomicStringType8` | – | `OK`, `ERROR` |
| `common:BusinessResultCodeType` | `common:AtomicStringType8` | – | `ERROR`, `WARN`, `INFO` |
| `common:TechnicalResultCodeType` | `common:AtomicStringType8` | – | `CRITICAL`, `ERROR` |
| `common:RequestPageType` | `xs:int` | minInclusive=`1` | – |
| `common:ResponsePageType` | `xs:int` | minInclusive=`0` | – |
| `base:InvoiceDateType` | `xs:date` | minInclusive=`2010-01-01`, pattern=`\d{4}-\d{2}-\d{2}` | – |
| `base:InvoiceTimestampType` | `xs:dateTime` | minInclusive=`2010-01-01T00:00:00Z`, pattern=`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d{1,3})?Z` | – |
| `base:InvoiceIndexType` | `xs:int` | minInclusive=`1`, maxInclusive=`100` | – |
| `base:InvoiceUnboundedIndexType` | `xs:int` | minInclusive=`1` | – |
| `base:LineNumberType` | `xs:nonNegativeInteger` | minInclusive=`1`, totalDigits=`20` | – |
| `base:MonetaryType` | `common:GenericDecimalType` | totalDigits=`18`, fractionDigits=`2` | – |
| `base:InvoiceAppearanceType` | `common:AtomicStringType15` | – | `PAPER`, `ELECTRONIC`, `EDI`, `UNKNOWN` |
| `base:InvoiceCategoryType` | `common:AtomicStringType15` | – | `NORMAL`, `SIMPLIFIED`, `AGGREGATE` |
| `base:PaymentMethodType` | `common:AtomicStringType15` | – | `TRANSFER`, `CASH`, `CARD`, `VOUCHER`, `OTHER` |
| `data:QuantityType` | `common:GenericDecimalType` | totalDigits=`22`, fractionDigits=`10` | – |
| `data:RateType` | `common:GenericDecimalType` | minInclusive=`0`, maxInclusive=`1`, totalDigits=`5`, fractionDigits=`4` | – |
| `data:ExchangeRateType` | `xs:decimal` | totalDigits=`14`, fractionDigits=`6`, minExclusive=`0` | – |
| `data:CustomerVatStatusType` | `common:AtomicStringType15` | – | `DOMESTIC`, `OTHER`, `PRIVATE_PERSON` |
| `data:LineNatureIndicatorType` | `common:AtomicStringType15` | – | `PRODUCT`, `SERVICE`, `OTHER` |
| `data:LineOperationType` | `common:AtomicStringType15` | – | `CREATE`, `MODIFY` |
| `data:MarginSchemeType` | `common:AtomicStringType15` | – | `TRAVEL_AGENCY`, `SECOND_HAND`, `ARTWORK`, `ANTIQUES` |
| `data:UnitOfMeasureType` | `common:AtomicStringType15` | – | `PIECE`, `KILOGRAM`, `TON`, `KWH`, `DAY`, `HOUR`, `MINUTE`, `MONTH`, `LITER`, `KILOMETER`, `CUBIC_METER`, `METER`, `LINEAR_METER`, `CARTON`, `PACK`, `OWN` |
| `data:ProductCodeCategoryType` | `common:AtomicStringType8` | minLength=`2`, maxLength=`6` | `VTSZ`, `SZJ`, `KN`, `AHK`, `CSK`, `KT`, `EJ`, `TESZOR`, `OWN`, `OTHER` |
| `data:ProductCodeValueType` | `common:AtomicStringType32` | minLength=`2`, maxLength=`30`, pattern=`[A-Z0-9]{2,30}` | – |
| `data:DataNameType` | `common:AtomicStringType255` | minLength=`1`, maxLength=`255`, pattern=`[A-Z][0-9]{5}[_][_A-Z0-9]{1,249}` | – |
| `data:EkaerIdType` | `common:AtomicStringType15` | pattern=`[E]{1}[0-9]{6}[0-9A-F]{8}` | – |
| `api:SoftwareIdType` | `common:AtomicStringType32` | length=`18`, pattern=`[0-9A-Z\-]{18}` | – |
| `api:SoftwareOperationType` | `common:AtomicStringType15` | – | `LOCAL_SOFTWARE`, `ONLINE_SERVICE` |
| `api:ManageInvoiceOperationType` | `common:AtomicStringType8` | – | `CREATE`, `MODIFY`, `STORNO` |
| `api:ManageAnnulmentOperationType` | `common:AtomicStringType8` | – | `ANNUL` |
| `api:InvoiceStatusType` | `common:AtomicStringType15` | – | `RECEIVED`, `PROCESSING`, `SAVED`, `DONE`, `ABORTED` |
| `api:OriginalRequestVersionType` | `common:AtomicStringType8` | – | `1.0`, `1.1`, `2.0`, `3.0` |
| `api:IncorporationType` | `common:AtomicStringType15` | – | `ORGANIZATION`, `SELF_EMPLOYED`, `TAXABLE_PERSON` |
| `api:TaxpayerAddressTypeType` | `common:AtomicStringType8` | – | `HQ`, `SITE`, `BRANCH` |
| `api:InvoiceDirectionType` | `common:AtomicStringType15` | – | `INBOUND`, `OUTBOUND` |
| `api:QueryOperatorType` | `common:AtomicStringType8` | – | `EQ`, `GT`, `GTE`, `LT`, `LTE` |
| `api:RequestStatusType` | `common:AtomicStringType15` | – | `RECEIVED`, `PROCESSING`, `SAVED`, `FINISHED`, `NOTIFIED` |
| `api:SourceType` | `common:AtomicStringType8` | – | `WEB`, `XML`, `MGM`, `OPG`, `OSZ` |
| `api:AnnulmentVerificationStatusType` | `common:AtomicStringType32` | – | `NOT_VERIFIABLE`, `VERIFICATION_PENDING`, `VERIFICATION_DONE`, `VERIFICATION_REJECTED` |
| `api:QueryNameType` | `common:SimpleText512NotBlankType` | minLength=`5` | – |
| `annul:AnnulmentCodeType` | `common:AtomicStringType32` | – | `ERRATIC_DATA`, `ERRATIC_INVOICE_NUMBER`, `ERRATIC_INVOICE_ISSUE_DATE`, `ERRATIC_ELECTRONIC_HASH_VALUE` |

Megjegyzések: a `SimpleText*NotBlankType` mintája `.*[^\s].*` – XSD-regexben a `.` nem illeszkedik sortörésre, így ezekben a mezőkben **sortörés nem lehet**; a vezető/záró szóközt viszont a séma megengedi (a számlaszámnál üzleti ERROR tiltja). `MonetaryType` negatív is lehet. Dátumok: `InvoiceDateType` ≥ 2010-01-01 (időzóna nélkül), `InvoiceTimestampType` ≥ 2010-01-01T00:00:00Z (UTC, `Z`).

### 7.5 Eltérések a dokumentáció és az XSD között (az XSD a mérvadó a validációnál) [magas]

| Téma | Spec (S2) | XSD | Teendő |
|---|---|---|---|
| `QuantityType` (quantity, unitPrice, unitPriceHUF) | „legfeljebb 22 számjegy, ebből legfeljebb 6 tizedes” (2.3.12) | `totalDigits=22`, **`fractionDigits=10`** | a buildert 10 tizedesig engedjük, de alapértelmezésként ≤ 6 tizedest írjunk |
| `marginSchemeIndicator` a `LineType` facet-táblájában | szerepel | **nincs** a `LineType`-ban (3.0 óta a `VatRateType` choice-ban van) | csak a `lineVatRate`-ben használjuk |
| `BusinessValidationResultType/message` | `SimpleText1024NotBlankType` | **`SimpleText512NotBlankType`** | parsernél ≤ 1024-et engedjünk |
| `ProcessingResultType` tömörítés-jelző | „compressedContent” | **`compressedContentIndicator`** | XSD-név |
| `AuditDataType` első eleme | – | **`insdate`** (kisbetűs d), máshol `insDate` | pontos név |
| `electronicInvoiceHash` számítása | „a BASE64 enkódolt érték hash-e” | (a NAV minta: dekódolt bájtok hash-e) | ne használjuk (4.5) |
| `vatAmountMismatch/vatRate` értékek | changelog 2020: 0.0426 | spec 2026: 0.0476 | a spec 2026-os listája a mérvadó (8.3) |

---

## 8. Üzleti validációk (ERROR vs WARN) – ami egy alap számlázót érint

Forrás: S2 3.3.2 (blokkoló), 3.3.3 + I. melléklet (WARN), II. melléklet (INFO), 5.4 (verziók); S9, S10. A „#” a spec ERROR-táblájának sorszáma, az „ID” a WARN-ok azonosítója. [magas, ha másképp nem jelölt]

### 8.1 Blokkoló hibák (ERROR → `ABORTED`), válogatás

| # | `validationErrorCode` | Művelet | Szabály | Óta |
|---|---|---|---|---|
| 1 | `SUPPLIER_TAX_NUMBER_MISMATCH` | C/M/S | `supplierTaxNumber/taxpayerId` ≠ `user/taxNumber` (kivéve `A10000_JOGELOD_POTLAS`) | 1.0 |
| 2 | `INVOICE_NUMBER_NOT_UNIQUE` | C/M/S | a számlaszámon az adózó már szolgáltatott adatot (a jóváhagyott technikai érvénytelenítés felszabadítja) | 1.0 |
| 3 | `LINE_NUMBER_NOT_SEQUENTIAL` | C/M/S | `lineNumber` nem 1..n | 1.0 |
| 4 | `INVOICE_LINE_MISSING` | C/S | nincs tétel | 1.0 |
| 5 | `INVALID_INVOICE_REFERENCE` | M/S | a hivatkozott alapszámla (CREATE) nem létezik, és `modifyWithoutMaster=false` | 1.0 (mód. 2026) |
| 6 | `INVOICE_TYPE_MISMATCH` | M/S | `invoiceCategory` ≠ alapszámláé | 1.0 |
| 7 | `INVOICE_LINE_ALREADY_EXISTS` | M/S | `lineNumberReference` (CREATE) már létezik a láncban | 1.0 |
| 9 | `ANNULMENT_IN_PROGRESS` | ANNUL (és M/S) | jóváhagyásra váró technikai érvénytelenítés van a számlán | 1.0 |
| 10 | `CUSTOMER_NOT_ASSIGNED` | C/M/S | a technikai felhasználó vevőkörre korlátozott | 1.0 |
| 12 | `LINE_NUMBER_REFERENCE_NOT_UNIQUE` | M/S | ugyanarra a `lineNumberReference`-re több tétel egy okiraton | 1.1 |
| 13 | `MANDATORY_LINE_CONTENT_MISSING` | C/M/S | `lineExpressionIndicator=true` → megnevezés, mennyiség, egység, egységár kötelező; `false` → megnevezés | 1.1 |
| 14 | `INVALID_VAT_DATA` | C/M/S | nem megengedett áfakulcs/áfatartalom (8.3) | 1.1 |
| 16 | `MODIFICATION_INDEX_NOT_UNIQUE` | M/S | a `modificationIndex` már használt az alapszámlán | 2.0 |
| 17 | `CUSTOMER_INFO_MISSING` | C | nincs `customerInfo` | 2.0 |
| 18 / 19 | `INVOICE_REFERENCE_EXPECTED` / `…_NOT_EXPECTED` | M/S vs. C | `invoiceReference` kötelező, ill. tilos | 2.0 |
| 20 | `MODIFY_WITHOUT_MASTER_MISMATCH` | M/S | `modifyWithoutMaster=true`, de az alapszámla létezik | 2.0 |
| 21 / 22 | `LINE_MODIFICATION_EXPECTED` / `…_NOT_EXPECTED` | M/S vs. C | `lineModificationReference` minden tételen kötelező, ill. tilos | 2.0 |
| 24 | `CUSTOMER_DATA_NOT_EXPECTED` | C/M/S | `PRIVATE_PERSON` mellett `customerVatData`/`customerName`/`customerAddress` szerepel | 3.0 |
| 25 | `CUSTOMER_DATA_EXPECTED` | C/M/S | nem `PRIVATE_PERSON` → `customerName` és `customerAddress` kötelező | 3.0 |
| 31–37 | `INVALID_LINE_VAT_EXEMPTION_CODE`, `INVALID_SUMMARY_VAT_EXEMPTION_CODE`, `INVALID_LINE_VAT_OUT_OF_SCOPE_CODE`, `INVALID_SUMMARY_VAT_OUT_OF_SCOPE_CODE`, `INVALID_LINE_VAT_AMOUNT_MISMATCH_CODE`, `INVALID_SUMMARY_VAT_AMOUNT_MISMATCH_CODE`, (`INCOMPLETE_ELECTRONIC_INVOICE_REFERENCE`) | C/M/S | érvénytelen `case` (7.3) | 3.0 |
| 38–40 | `INVOICE_COMPLETENESS_MERGED_ITEM_INDICATOR_MISMATCH`, `…_PRIVATE_PERSON_INDICATOR_MISMATCH`, **`INVOICE_COMPLETENESS_NOT_ALLOWED`** | C/M/S | `completenessIndicator=true` nem engedett (átmeneti kód) | 3.0 |
| 41–44 | `INVALID_LINE_VAT_RATE_NORMAL`, `…_SIMPLIFIED`, `INVALID_SUMMARY_VAT_RATE_NORMAL`, `…_SIMPLIFIED` | C/M/S | normál számlán `vatContent`, egyszerűsítetten `vatPercentage` tilos | 3.0 |
| 45 | `MISSING_CUSTOMER_DOMESTIC_TAXNUMBER` | C/M/S | `DOMESTIC` → magyar adószám (`customerTaxNumber`) kötelező (kivéve áfaregisztrált eladó) | 3.0 |
| 46 / 47 | `CUSTOMER_COMMUNITY_TAXNUMBER_NOT_EXPECTED` / `CUSTOMER_THIRD_STATE_TAXNUMBER_NOT_EXPECTED` | C/M/S | `DOMESTIC` mellett közösségi / harmadik országbeli adószám tilos | 3.0 |
| 50 | `DOMESTIC_TAXNUMBER_EXPECTED_REVERSE_CHARGE` | C/M | belföldi fordított adózású tétel → vevő magyar adószáma kötelező | 3.0 |
| 51 | `INVALID_INVOICE_NUMBER` | C/M/S | `invoiceNumber` elején/végén whitespace (LF, CR, HT, space) | 3.0 |
| 54 | `INVOICE_DELIVERY_DATE_LATE` | C/M/S | teljesítés > kiállítás + 5 év | 3.0 |
| 55 | `INVOICE_ISSUE_DATE_LATE` | C/M/S | kiállítás > beküldés + 1 év | 3.0 |
| 56–59 | `LINE_SUMMARY_TYPE_MISMATCH_LINE_SIMPLIFIED` / `…_SUMMARY_SIMPLIFIED` / `…_LINE_NORMAL` / `…_SUMMARY_NORMAL` | C/M/S | normál/gyűjtő számlán egyszerűsített tétel-/összesítő-adat, ill. fordítva | 3.0 |
| 60 | `INVALID_LINE_OPERATION` | M/S | `lineOperation=MODIFY` | éles 2023-09-18 |
| 64 | `INCORRECT_DATE_INVOICE_DELIVERY_TO_FROM` | C/M | `invoiceDeliveryPeriodEnd` < `…Start` | 2025-09-15 |
| 65 | `INCORRECT_LINE_DATA_UOM_INCOMPLETE` | C/M | `unitOfMeasure=OWN`, de nincs `unitOfMeasureOwn` | 2025-09-15 |
| 66 | `INCORRECT_HEAD_DATA_MOD_REF_INVOICE_NUMBER` | M | `invoiceNumber` = `originalInvoiceNumber` | 2025-09-15 |
| 67–70 | `INCORRECT_LINE_DATA_VAT_STATUS_VAT_DATA_MISMATCH_KBAET` / `_KBAUK` / `_EUFAD37` / `_EUFADE` | C/M (NORMAL, AGGREGATE) | KBAET/EUFAD37/EUFADE → vevő csak `OTHER`; KBAUK → `PRIVATE_PERSON` vagy `OTHER` | 2025-09-15 |
| 71 | `INCORRECT_LINE_DATA_VAT_EXEMPTION_NORMAL` | C/M (NORMAL, AGGREGATE) | `vatExemption` tételen a `lineVatAmount`/`lineVatAmountHUF` csak 0 lehet | 2025-09-15 |
| 72 | `INCORRECT_LINE_DATA_VAT_OUT_OF_SCOPE_NORMAL` | C/M/S (NORMAL, AGGREGATE) | `vatOutOfScope` tételen áfa csak 0 | 2025-09-15 |
| 73 | `INCORRECT_LINE_DATA_VAT_DOMESTIC_REVERSE_CHARGE` | C/M | fordított adózású tétel → vevő csak `DOMESTIC` | 2025-09-15 |
| 74 | `INCORRECT_LINE_DATA_AGGREGATE_INV_LINE_DATA_MANDATORY` | C/M (AGGREGATE) | gyűjtőszámla tételén kötelező `aggregateInvoiceLineData` | 2025-09-15 |
| 75 | `INCORRECT_SUMMARY_DATA_VAT_OUT_OF_SCOPE_NORMAL` | C/M | `vatOutOfScope` összesítőben áfa csak 0 | 2025-09-15 |
| 76 | `INCONSISTENT_MODIFICATION_DATA_MODIFICATIONINDEX_UNREAL` | M | `modificationIndex` > 1000 | 2025-09-15 |
| 77 | `INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF` | C/M | `currencyCode=HUF`, de `exchangeRate` ≠ 1 | 2025-09-15 |
| 78 | `INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME` | C/M | árfolyam a figyelt sávon kívül (8.7) | 2025-09-15 |
| 79 | `INVALID_ORIGINAL_INVOICE_NUMBER` | M/S | `originalInvoiceNumber` elején/végén whitespace | 2026-01-01 |
| 80 | `INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL` | C/M (NORMAL, AGGREGATE) | `vatExemption` összesítőben `vatRateVatAmount`/`…HUF` csak 0 | 2026-01-01 |

Nem listázott, de létező ERROR-ok: `REQUEST_VERSION_REFERENCE_ERROR`, `MULTIPLE_INVOICES_FOUND`, `CUSTOMER_NOT_IDENTICAL`, `ELECTRONIC_INVOICE_HASH_EXPECTED`, `INVALID_INVOICE_HASH_CRYPTO`, `INVALID_INVOICE_HASH`, `INVOICE_APPEARANCE_MISMATCH`, `ELECTRONIC_INVOICE_ANNULMENT_NOT_ALLOWED`, `INVALID_LINE_VAT_AMOUNT_MISMATCH_VAT_RATE`, `INVALID_SUMMARY_VAT_AMOUNT_MISMATCH_VAT_RATE`, `MODIFICATION_SOURCE_MISMATCH`, `INVALID_INVOICE_CATEGORY` (OPG), `INVALID_PREDECESSOR_OPERATION`, `SUPPLIER_NOT_IDENTICAL`, `PREDECESSOR_REFERENCE_NOT_IDENTICAL`, `INVALID_ANNULMENT_REFERENCE` (S2 3.3.2: összesen 80 sor).

### 8.2 Friss változások

- **2025-09-15 (3.40; teszt 2025-09-01)** – 15 WARN → ERROR (a STORNO kikerült a hatókörükből, hogy a régi számlák sztornózhatók maradjanak): 330 `INCORRECT_DATE_INVOICE_DELIVERY_TO_FROM`, 434 `INCORRECT_LINE_DATA_UOM_INCOMPLETE`, 560 `INCORRECT_HEAD_DATA_MOD_REF_INVOICE_NUMBER`, 581–584 (KBAET, KBAUK, EUFAD37, EUFADE vevőstátusz; az utolsó hármat az AGGREGATE-re is kiterjesztették), 591 `INCORRECT_LINE_DATA_VAT_EXEMPTION_NORMAL`, 593 `INCORRECT_LINE_DATA_VAT_OUT_OF_SCOPE_NORMAL`, 596 `INCORRECT_LINE_DATA_VAT_DOMESTIC_REVERSE_CHARGE`, 620 `INCORRECT_LINE_DATA_AGGREGATE_INV_LINE_DATA_MANDATORY`, 701 `INCORRECT_SUMMARY_DATA_VAT_OUT_OF_SCOPE_NORMAL`, 1150 `INCONSISTENT_MODIFICATION_DATA_MODIFICATIONINDEX_UNREAL`, 1300 `INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF`, 1310 `INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME`. Új WARN: 435 `INCORRECT_LINE_DATA_BY_VATRATE`, 734 `INCORRECT_SUMMARY_DATA_BY_VATRATE`, 1311 `INCORRECT_HEAD_DATA_CUSTOMERVATSTATUS`. Inaktív WARN: 690, 700, 1301. INFO → WARN: 11400 `UNINTENDED_MODIFICATION_DELIVERY_DATE` (2025-10-07-től élesben átmenetileg inaktív). (S9, S2 5.4)
- **2026-01-01 (3.44–3.44.3)** – 691 `INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL` → ERROR; új ERROR 79 `INVALID_ORIGINAL_INVOICE_NUMBER`; új WARN 72 `INCORRECT_HEAD_DATA_SUPPLIER_TAXPAYERID` (eladó adószáma nem „élő”), 11401 `UNINTENDED_CANCELLATION_DELIVERY_DATE`; 11400 átdolgozva és újra aktív; módosult ERROR 5 és 61. (S10, S2 5.4)
- **Részben már élő / tervezett**: 60 `INCORRECT_VAT_CODE_SUPPLIER_GROUPMEMBER_MISSING` a **tesztkörnyezetben 2026-01-01 óta ERROR**, élesben átmeneti idő után lesz az (dátum nincs); 11401 később válik ERROR-rá. A tesztkörnyezeti integrációs tesztekben tehát csoporttag eladónál a `groupMemberTaxNumber` hiánya már `ABORTED`-ot okoz. [közepes–magas] (S10)
  > ⚠️ Javítva (verifikáció): az eredeti szöveg mindkettőt csak „tervezett”-nek írta; a 60-as a tesztkörnyezetben már blokkoló. Bizonyíték: https://github.com/nav-gov-hu/Online-Invoice/discussions/1180 (a nyitó bejegyzés 60-as pontja: a szigorítás egyelőre csak a teszt környezetben él, élesben átmeneti idő után).
- **2026-08 (3.49)** – HTTP 429 és HTTP-kód-változások (6.2).

### 8.3 Megengedett áfakulcsok (`INVALID_VAT_DATA`, S2 3.3.2 #14) és `vatAmountMismatch` (#48–49)

| Hol | Elfogadott érték |
|---|---|
| `vatPercentage` (normál, gyűjtő) | `0.05`, `0.07`, `0.12`, `0.18`, `0.27`; `0.2` és `0.25` csak MODIFY/STORNO-nál vagy 2013-01-01 előtti teljesítésű CREATE-nél; `0` csak 2024-01-01-jei vagy későbbi teljesítésnél |
| `vatContent` (egyszerűsített) | `0.0476`, `0.1525`, `0.2126`; `0.1667` és `0.2` csak MODIFY/STORNO-nál vagy 2013-01-01 előtti CREATE-nél; `0` csak ≥ 2024-01-01 teljesítésnél |
| `vatAmountMismatch/vatRate` (tétel és összesítő) | `0.27`, `0.18`, `0.05`, `0.2126`, `0.1525`, `0.0476`; `0` csak ≥ 2024-01-01 teljesítésnél |

### 8.4 Számszaki WARN-ok és tűrések (S2 I. melléklet)

- Általános tűrés: a számított **forintérték 1%-a, de legalább 1 HUF és a számla pénznemében 0,01 egység közül a nagyobb** (pl. 740, 741, 743, 745, 750, 751; összesítőknél a vonatkozó összeg 1%-a, ugyanezzel a minimummal).
- **740 `INCORRECT_LINE_CALCULATION_NET_AMOUNT`**: `quantity × unitPrice − discountValue` (vagy `× (1 − discountRate)`) ≠ `lineNetAmount`; csak ha mindhárom ki van töltve, és MODIFY/STORNO-nál csak `lineOperation=CREATE` tételen.
- **741/743/745/751**: `lineNetAmount × exchangeRate ≠ lineNetAmountHUF`, ugyanez az áfára, egységárra (`unitPriceHUF`), bruttóra; **754**: nettó HUF + áfa HUF ≠ bruttó HUF.
- **820/821**: tételek nettó összege áfakulcsonként ≠ `vatRateNetAmount(HUF)`; **840/841**: Σ `vatRateNetAmount` ≠ `invoiceNetAmount`; **850/860**: Σ `vatRateVatAmount` ≠ `invoiceVatAmount`; **880/881**: nettó + áfa ≠ `invoiceGrossAmount`; **890/891**: `vatRateNetAmount × kulcs` ≠ `vatRateVatAmount`; **941**: Σ tétel nettó HUF ≠ `invoiceNetAmountHUF`; **1070/1071**: összesítő × árfolyam ≠ HUF-összesítő; **680**: eltérő áfakulcs a tételekben és az összesítőben; **435/734**: összesítőben szereplő áfajelhez nincs tétel, ill. fordítva.
- **STORNO-konzisztencia** (WARN, tűrés: 1 egység): **1200** az alapszámla + módosítások + STORNO nettó összege ≠ 0; **1220** ugyanez az áfára; **1210** egyszerűsített bruttóra; **1140** az alapszámlára már érkezett STORNO.
- **Dátum-WARN-ok**: 310 számla kelte > beküldés + 5 nap; 312 teljesítés korábbi, mint a beküldés előtti 6. év első napja; 313 teljesítés ≥ 397 nappal a kelte után; 340 módosító okirat kelte jövőbeli (5 nap tűrés); 341 módosító okirat kelte ≥ 15 nappal a beküldés előtt; 342 módosító okirat kelte korábbi, mint az eredetié; **11400/11401** a módosítás/érvénytelenítés az eredeti (ill. utolsó módosító) teljesítési dátumát a módosító okirat keltére írja át (11400: eltérő naptári hónap esetén és csak ha van tételsor vagy vevőváltozás; 11401: eltérő nap esetén). INFO 10311: kelte > 10 nappal a beküldés előtt.
- **Partner-WARN-ok**: 10/11/20 eladó = vevő (adószám/név/bankszámla); 50 eladó áfakódja 4; 60 csoporttag-adószám hiányzik (tervezett ERROR); 72/81 eladó/vevő adószáma nem „élő”; 510 vevő adószáma nem létezik; 1311 `OTHER` státusz belföldi áfaalany vevőnél (nem fut, ha az eladó megyekódja 51 vagy a vevő áfakódja 1).

### 8.5 Vevőtípus-szabályok (`customerVatStatus`) [magas] (S2 2.1.4.1, 2.2.2.2; ERROR 24/25/45/46/47/50/67–70/73)

| Státusz | Jelentés | `customerVatData` | `customerName` + `customerAddress` |
|---|---|---|---|
| `DOMESTIC` | belföldi áfaalany | **kötelező `customerTaxNumber`** (kivéve, ha az eladó csak áfaregisztrált és nem belföldi fordított adózás); közösségi/harmadik országbeli adószám tilos; csoportos áfaalanynál csoportazonosító + `groupMemberTaxNumber` | kötelező |
| `OTHER` | belföldi nem áfaalany nem természetes személy, külföldi áfaalany, külföldi nem áfaalany nem természetes személy | opcionális, a háromból **egy**: `customerTaxNumber` \| `communityVatNumber` (KBAET-nél kötelező) \| `thirdStateTaxId` | kötelező |
| `PRIVATE_PERSON` | nem áfaalany (belföldi vagy külföldi) természetes személy | **tilos** | **tilos** (a számlán szerepel, az adatszolgáltatásban nem!) |

### 8.6 Dátumok (összefoglalva)
XSD: minden dátum ≥ 2010-01-01. ERROR: teljesítés ≤ kiállítás + 5 év; kiállítás ≤ beküldés + 1 év; időszak vége ≥ eleje. WARN: 310/312/313/340/341/342/11400/11401 (8.4). `periodicalSettlement=true` kell, ha időszak-dátum van megadva (WARN 561).

### 8.7 Pénznem és árfolyam [magas]
- `currencyCode` (ISO 4217, `[A-Z]{3}`) és `exchangeRate` (`ExchangeRateType`: > 0, `totalDigits=14`, `fractionDigits=6`) **mindig kötelező**; HUF → pontosan `1` (ERROR 77). 0-s árfolyam a séma szerint sem adható meg.
- Az árfolyam az Áfa tv. 80. § és 80/A. § szerinti; a `…HUF` mezők = összeg × árfolyam (WARN 741, 743, 751, 1070, 1071). Gyűjtőszámlánál devizában a tételenkénti `lineExchangeRate`, a fejbeli árfolyam = `invoiceNetAmountHUF / invoiceNetAmount`. Ha a módosító okiratban nincs tétel, a korábbi utolsó érvényes árfolyamot kell megadni. (S2 2.2.2.4)
- ERROR 78 – figyelt devizák sávjai (a NAV előzetes értesítés nélkül módosíthatja): EUR 250–600, USD 200–600, GBP 250–720, CHF 200–600, BGN 120–360, RON 50–180, PLN 50–180, SEK 20–72, NOK 20–72, CZK 5–48, ILS 40–240, DKK 20–120, BAM 100–360. (S2 3.3.2 #78)

### 8.8 AAM (alanyi adómentes) és kisadózó
- Tétel: `lineAmountsNormal/lineVatRate/vatExemption` `case=AAM` (+ `reason`); ha van `lineVatData`, csak 0 (ERROR 71). Összesítő: `summaryByVatRate/vatRate/vatExemption` `case=AAM`, a kötelező `vatRateVatData` 0 (ERROR 80, 2026-01-01). `supplierInfo/individualExemption=true` ajánlott (a séma „true, ha a számlakibocsátó alanyi áfamentes”). [magas]
- Az eladó áfakódja és a tétel áfakulcsa közötti összefüggést (pl. AAM eladó 27%-os tétele) **NAV-validáció nem vizsgálja** (nem találtunk ilyet) → saját üzleti szabályként kezeljük. [közepes]
- `smallBusinessIndicator` („Kisadózó jelzése”, opcionális boolean) – jogi alkalmazhatóságát a jogi kutatás tisztázza. [közepes]

### 8.9 Számlaszám
- Séma: `SimpleText50NotBlankType` (1–50 karakter, legalább egy nem-whitespace, sortörés nélkül). Üzleti: nincs vezető/záró whitespace (ERROR 51; `originalInvoiceNumber`-re ERROR 79); adózónként egyedi (ERROR 2); módosító okirat saját, az eredetitől eltérő sorszámot kap (ERROR 66 MODIFY-nál).

---

## 9. Gyakorlati kérdések

### 9.1 `completenessIndicator`
Mindig **`false`**: a `true` („az adatszolgáltatás maga a számla”) jelenleg blokkolt (`INVOICE_COMPLETENESS_NOT_ALLOWED` – „átmeneti hibakód, ami a jogszabályok érvényre jutásának időpontjáig adhat a rendszer”); magánszemélynél és `mergedItemIndicator=true` mellett amúgy is tilos. `true` esetén technikai érvénytelenítés sem lehetséges. [magas] (S2 3.3.2 #38–40, 2.4.1)

### 9.2 `invoiceAppearance`
`PAPER` (papír), `ELECTRONIC` (elektronikus, nem EDI – az Áfa tv. 259. § 5. pont szerinti e-számla), `EDI`, `UNKNOWN` (a szoftver a kiállításkor nem ismeri). Javasolt leképezés: nyomtatott/átadott számla → `PAPER`; e-mailben küldött PDF, ha jogilag elektronikus számlának minősül → `ELECTRONIC`; ha a kiállításkor nem dönthető el → `UNKNOWN`. A PDF e-számlaként való minősítése (vevői elfogadás stb.) jogi kérdés. [közepes] (S2 2.3.5)

### 9.3 Módosítás és sztornó (MODIFY/STORNO) [magas] (S2 2.2.1, 2.5)
- A módosító/érvénytelenítő okirat **saját, új számlaszámot** kap (`InvoiceData/invoiceNumber`), saját keltével (`invoiceIssueDate`); az eredetire az `invoiceReference/originalInvoiceNumber` hivatkozik. `modificationIndex`: az alapszámla első módosítása `1`, minden további +1 (egyedi; sorrendet nem ellenőriz; hézag → INFO 11250 `MODIFICATIONINDEX_SEQUENCE_INCOMPLETE`; > 1000 → ERROR).
- API-ban `invoiceOperation` = `STORNO` (érvénytelenítés) vagy `MODIFY` (módosítás); a belső XML ugyanaz a struktúra.
- Kötelező elemek MODIFY/STORNO-nál: `originalInvoiceNumber`, `modificationIndex`, `invoiceIssueDate`, `supplierTaxNumber/taxpayerId`, `supplierAddress` kötelező ága, `invoiceNumber`, `invoiceCategory` (**az eredeti számla típusa**), `invoiceDeliveryDate` (**az eredeti teljesítési dátuma**, kivéve ha azt módosítjuk – különben WARN 11400/11401), `currencyCode`, `exchangeRate`, `invoiceAppearance`, `invoiceSummary`.
- **STORNO tartalma** (ha az eredetit korábban nem módosították): az eredeti tételsorok **ellentétes előjelű mennyiséggel** (az egységár a NAV mintájában pozitív marad), így a tétel- és összesítő-összegek negatívak; minden tételsoron `lineModificationReference` (`lineNumberReference` = a lánc eddigi legnagyobb sorszámát folytató új szám, `lineOperation=CREATE`); az `invoiceSummary` az eredeti + korábbi módosítások eredményének ellentettje. Ellenőrzés: WARN 1200/1220 (összeg = 0 ± 1 egység).
- **MODIFY**: csak a változást közöljük **különbségként** (árak, mennyiségek); a módosított tételt új sorként (`CREATE`) adjuk hozzá, a tételt „módosító” `MODIFY` sor tilos. Ha fejadat változik, a szülőelemet teljes tartalommal újraközöljük (eladó → `supplierInfo`, vevő → `customerInfo`, `invoiceDetail` bármely adata → `invoiceDetail`, tétel → `line`). Az `invoiceSummary` mindig kötelező, és **csak a változás hatását** tartalmazza (az „egybeszerkesztett” új állapot közlése kifejezetten tilos).
- Módosító okirat nem módosítható; egy hibás módosítás javítása az eredeti számla újabb módosítása.
- A spec szerint „egy számla érvénytelenítése és újabb (immár helyes) számla kiállítása esetén, mind az érvénytelenítő okirat, mind az új számla az eredeti számla módosító okiratának tekintendő” (S2 2.5). Ez azt sugallja, hogy a sztornó utáni helyes számla is MODIFY lehet – ugyanakkor a 1140-es WARN jelez, ha STORNO után módosítás érkezik. **Jogi/üzleti döntést igényel** (13. fejezet).
- Az alapszámla `DONE` státuszát érdemes megvárni a módosítás beküldése előtt (aszinkron, a sorrend nem garantált).

### 9.4 `modifyWithoutMaster`
`true`, ha az alapszámláról nem történt és nem is fog történni adatszolgáltatás: 2018-07-01 előtti számla; akkor még nem jelentésköteles számla, de a módosítás már az; közmű-elszámolószámla speciális esete. Saját, NAV-nak jelentett számláinknál **mindig `false`**; migrált (más programmal kiállított, nem jelentett) régi számláknál lehet `true`. Ilyenkor a `lineNumberReference` bármely értéktől (akár 1-től) indulhat. Eltérés: ERROR 5 / 20. [magas] (S2 2.2.1)

### 9.5 `lineModificationReference`
Csak MODIFY/STORNO tételen kötelező (CREATE-en tilos). `lineNumberReference` = az eredeti számla és az összes korábbi módosítás által létrehozott sorszámozás **folytatása** (pl. 2 tételes eredeti → az első módosítás új sorai 3, 4, …); egy okiraton belül egy referencia csak egyszer (ERROR 12); már létező sorszám CREATE-tel → ERROR 7. A lánc aktuális maximumát a `/queryInvoiceChainDigest` (`maxLineNumber`, `newCreatedLines`) is megadja. `lineOperation` csak `CREATE`. [magas]

### 9.6 Technikai érvénytelenítés ≠ sztornó
A technikai érvénytelenítés (`/manageAnnulment`) **hibás adatszolgáltatást** von vissza, amikor maga a számla helyes volt (pl. elírt számlaszám az XML-ben); webes jóváhagyás kell, utána a számlaszám újra felhasználható. Gazdasági esemény visszavonása vagy hibás számla javítása = **STORNO/MODIFY** (új okirat). [magas] (S2 2.4)

### 9.7 Jogelőd (`predecessorTaxNumber`, `A10000_JOGELOD_*`) – röviden
A jogutód a `user/predecessorTaxNumber`-rel lekérdezhet/érvényteleníthet a jogelőd nevében; pótlás/hivatkozás/jogelőd-időszaki ügylet jelzése az `invoiceDetail/additionalInvoiceData` `dataName` = `A10000_JOGELOD_POTLAS` \| `A10000_JOGELOD_ADOSZAM` \| `A10000_JOGELOD_IDOSZAK` kóddal (legfeljebb egy, egyszer). MVP-hez nem szükséges. (S2 1.10)

### 9.8 Kötegelés és token
Egy token = egy `manageInvoice` kérés (max. 100 számla). Megengedett: az első lezárt számlánál azonnal tokent kérni, és a token érvényességén belül lezárt további számlákat egy kötegben küldeni – de csak automatikusan, emberi beavatkozás nélkül; sikertelen beküldést azonnal ismételni kell. A token lejártát a szerveridő dönti el → hagyjunk biztonsági ráhagyást (pl. 30 s). (S2 1.1, 1.9.1)

---

## 10. Példa InvoiceData XML-ek (XSD-validálva)

Közös: `completenessIndicator=false`, `mergedItemIndicator=false`, HUF → `exchangeRate=1`, a base-névterű elemek `base:` prefixszel. Az adószámok (11111111, 22222222, 33333333) a NAV mintáihoz hasonló **fiktív** értékek (a törzsszám ellenőrzőjegye stimmel, de nem valós adózók → éles/teszt beküldésnél WARN 510 várható). A példafájlok a kutatás ideiglenes munkamappájában készültek (a tárolónak nem részei).

### 10.1 (1) Belföldi B2B: normál áfás eladó → DOMESTIC vevő, HUF, 2 tétel (27% szolgáltatás, 5% termék), átutalás, `ELECTRONIC`

Számítás: 10 óra × 15 000 = 150 000 nettó, 27% = 40 500 áfa; 2 db × 4 500 = 9 000 nettó, 5% = 450 áfa; összesen nettó 159 000, áfa 40 950, bruttó 199 950 (minden 740/820/840/850/880/890 ellenőrzés pontosan teljesül).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <invoiceNumber>PSZ-2026-000123</invoiceNumber>
  <invoiceIssueDate>2026-10-27</invoiceIssueDate>
  <completenessIndicator>false</completenessIndicator>
  <invoiceMain>
    <invoice>
      <invoiceHead>
        <supplierInfo>
          <supplierTaxNumber>
            <base:taxpayerId>11111111</base:taxpayerId>
            <base:vatCode>2</base:vatCode>
            <base:countyCode>41</base:countyCode>
          </supplierTaxNumber>
          <supplierName>Példa Szoftver Kft.</supplierName>
          <supplierAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>1051</base:postalCode>
              <base:city>Budapest</base:city>
              <base:streetName>Példa</base:streetName>
              <base:publicPlaceCategory>utca</base:publicPlaceCategory>
              <base:number>1</base:number>
            </base:detailedAddress>
          </supplierAddress>
          <supplierBankAccountNumber>11111111-22222222-33333333</supplierBankAccountNumber>
        </supplierInfo>
        <customerInfo>
          <customerVatStatus>DOMESTIC</customerVatStatus>
          <customerVatData>
            <customerTaxNumber>
              <base:taxpayerId>22222222</base:taxpayerId>
              <base:vatCode>2</base:vatCode>
              <base:countyCode>06</base:countyCode>
            </customerTaxNumber>
          </customerVatData>
          <customerName>Vevő Minta Zrt.</customerName>
          <customerAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>6720</base:postalCode>
              <base:city>Szeged</base:city>
              <base:streetName>Kárász</base:streetName>
              <base:publicPlaceCategory>utca</base:publicPlaceCategory>
              <base:number>5</base:number>
            </base:detailedAddress>
          </customerAddress>
        </customerInfo>
        <invoiceDetail>
          <invoiceCategory>NORMAL</invoiceCategory>
          <invoiceDeliveryDate>2026-10-20</invoiceDeliveryDate>
          <currencyCode>HUF</currencyCode>
          <exchangeRate>1</exchangeRate>
          <paymentMethod>TRANSFER</paymentMethod>
          <paymentDate>2026-11-04</paymentDate>
          <invoiceAppearance>ELECTRONIC</invoiceAppearance>
        </invoiceDetail>
      </invoiceHead>
      <invoiceLines>
        <mergedItemIndicator>false</mergedItemIndicator>
        <line>
          <lineNumber>1</lineNumber>
          <lineExpressionIndicator>true</lineExpressionIndicator>
          <lineNatureIndicator>SERVICE</lineNatureIndicator>
          <lineDescription>Szoftverfejlesztési szolgáltatás</lineDescription>
          <quantity>10</quantity>
          <unitOfMeasure>HOUR</unitOfMeasure>
          <unitPrice>15000</unitPrice>
          <lineAmountsNormal>
            <lineNetAmountData>
              <lineNetAmount>150000.00</lineNetAmount>
              <lineNetAmountHUF>150000.00</lineNetAmountHUF>
            </lineNetAmountData>
            <lineVatRate>
              <vatPercentage>0.27</vatPercentage>
            </lineVatRate>
            <lineVatData>
              <lineVatAmount>40500.00</lineVatAmount>
              <lineVatAmountHUF>40500.00</lineVatAmountHUF>
            </lineVatData>
            <lineGrossAmountData>
              <lineGrossAmountNormal>190500.00</lineGrossAmountNormal>
              <lineGrossAmountNormalHUF>190500.00</lineGrossAmountNormalHUF>
            </lineGrossAmountData>
          </lineAmountsNormal>
        </line>
        <line>
          <lineNumber>2</lineNumber>
          <productCodes>
            <productCode>
              <productCodeCategory>VTSZ</productCodeCategory>
              <productCodeValue>49019900</productCodeValue>
            </productCode>
          </productCodes>
          <lineExpressionIndicator>true</lineExpressionIndicator>
          <lineNatureIndicator>PRODUCT</lineNatureIndicator>
          <lineDescription>Szakkönyv</lineDescription>
          <quantity>2</quantity>
          <unitOfMeasure>PIECE</unitOfMeasure>
          <unitPrice>4500</unitPrice>
          <lineAmountsNormal>
            <lineNetAmountData>
              <lineNetAmount>9000.00</lineNetAmount>
              <lineNetAmountHUF>9000.00</lineNetAmountHUF>
            </lineNetAmountData>
            <lineVatRate>
              <vatPercentage>0.05</vatPercentage>
            </lineVatRate>
            <lineVatData>
              <lineVatAmount>450.00</lineVatAmount>
              <lineVatAmountHUF>450.00</lineVatAmountHUF>
            </lineVatData>
            <lineGrossAmountData>
              <lineGrossAmountNormal>9450.00</lineGrossAmountNormal>
              <lineGrossAmountNormalHUF>9450.00</lineGrossAmountNormalHUF>
            </lineGrossAmountData>
          </lineAmountsNormal>
        </line>
      </invoiceLines>
      <invoiceSummary>
        <summaryNormal>
          <summaryByVatRate>
            <vatRate>
              <vatPercentage>0.27</vatPercentage>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>150000.00</vatRateNetAmount>
              <vatRateNetAmountHUF>150000.00</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>40500.00</vatRateVatAmount>
              <vatRateVatAmountHUF>40500.00</vatRateVatAmountHUF>
            </vatRateVatData>
            <vatRateGrossData>
              <vatRateGrossAmount>190500.00</vatRateGrossAmount>
              <vatRateGrossAmountHUF>190500.00</vatRateGrossAmountHUF>
            </vatRateGrossData>
          </summaryByVatRate>
          <summaryByVatRate>
            <vatRate>
              <vatPercentage>0.05</vatPercentage>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>9000.00</vatRateNetAmount>
              <vatRateNetAmountHUF>9000.00</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>450.00</vatRateVatAmount>
              <vatRateVatAmountHUF>450.00</vatRateVatAmountHUF>
            </vatRateVatData>
            <vatRateGrossData>
              <vatRateGrossAmount>9450.00</vatRateGrossAmount>
              <vatRateGrossAmountHUF>9450.00</vatRateGrossAmountHUF>
            </vatRateGrossData>
          </summaryByVatRate>
          <invoiceNetAmount>159000.00</invoiceNetAmount>
          <invoiceNetAmountHUF>159000.00</invoiceNetAmountHUF>
          <invoiceVatAmount>40950.00</invoiceVatAmount>
          <invoiceVatAmountHUF>40950.00</invoiceVatAmountHUF>
        </summaryNormal>
        <summaryGrossData>
          <invoiceGrossAmount>199950.00</invoiceGrossAmount>
          <invoiceGrossAmountHUF>199950.00</invoiceGrossAmountHUF>
        </summaryGrossData>
      </invoiceSummary>
    </invoice>
  </invoiceMain>
</InvoiceData>
```

### 10.2 (2) B2C: alanyi adómentes (AAM, áfakód 1) eladó → `PRIVATE_PERSON`, 1 tétel `vatExemption/case=AAM`, készpénz

Magánszemély vevőnél **csak** a `customerVatStatus` szerepel (név/cím/adószám tilos – ERROR 24). A `vatRateVatData` az összesítőben kötelező elem, 0 értékkel (ERROR 80). `individualExemption=true`. Papíralapú (`PAPER`) megjelenés.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <invoiceNumber>AAM-2026-000045</invoiceNumber>
  <invoiceIssueDate>2026-10-27</invoiceIssueDate>
  <completenessIndicator>false</completenessIndicator>
  <invoiceMain>
    <invoice>
      <invoiceHead>
        <supplierInfo>
          <supplierTaxNumber>
            <base:taxpayerId>33333333</base:taxpayerId>
            <base:vatCode>1</base:vatCode>
            <base:countyCode>33</base:countyCode>
          </supplierTaxNumber>
          <supplierName>Minta Mária e.v.</supplierName>
          <supplierAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>2000</base:postalCode>
              <base:city>Szentendre</base:city>
              <base:streetName>Fő</base:streetName>
              <base:publicPlaceCategory>tér</base:publicPlaceCategory>
              <base:number>3</base:number>
            </base:detailedAddress>
          </supplierAddress>
          <individualExemption>true</individualExemption>
        </supplierInfo>
        <customerInfo>
          <customerVatStatus>PRIVATE_PERSON</customerVatStatus>
        </customerInfo>
        <invoiceDetail>
          <invoiceCategory>NORMAL</invoiceCategory>
          <invoiceDeliveryDate>2026-10-27</invoiceDeliveryDate>
          <currencyCode>HUF</currencyCode>
          <exchangeRate>1</exchangeRate>
          <paymentMethod>CASH</paymentMethod>
          <paymentDate>2026-10-27</paymentDate>
          <invoiceAppearance>PAPER</invoiceAppearance>
        </invoiceDetail>
      </invoiceHead>
      <invoiceLines>
        <mergedItemIndicator>false</mergedItemIndicator>
        <line>
          <lineNumber>1</lineNumber>
          <lineExpressionIndicator>true</lineExpressionIndicator>
          <lineNatureIndicator>SERVICE</lineNatureIndicator>
          <lineDescription>Hajvágás</lineDescription>
          <quantity>1</quantity>
          <unitOfMeasure>PIECE</unitOfMeasure>
          <unitPrice>8000</unitPrice>
          <lineAmountsNormal>
            <lineNetAmountData>
              <lineNetAmount>8000.00</lineNetAmount>
              <lineNetAmountHUF>8000.00</lineNetAmountHUF>
            </lineNetAmountData>
            <lineVatRate>
              <vatExemption>
                <case>AAM</case>
                <reason>Alanyi adómentes</reason>
              </vatExemption>
            </lineVatRate>
            <lineGrossAmountData>
              <lineGrossAmountNormal>8000.00</lineGrossAmountNormal>
              <lineGrossAmountNormalHUF>8000.00</lineGrossAmountNormalHUF>
            </lineGrossAmountData>
          </lineAmountsNormal>
        </line>
      </invoiceLines>
      <invoiceSummary>
        <summaryNormal>
          <summaryByVatRate>
            <vatRate>
              <vatExemption>
                <case>AAM</case>
                <reason>Alanyi adómentes</reason>
              </vatExemption>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>8000.00</vatRateNetAmount>
              <vatRateNetAmountHUF>8000.00</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>0</vatRateVatAmount>
              <vatRateVatAmountHUF>0</vatRateVatAmountHUF>
            </vatRateVatData>
            <vatRateGrossData>
              <vatRateGrossAmount>8000.00</vatRateGrossAmount>
              <vatRateGrossAmountHUF>8000.00</vatRateGrossAmountHUF>
            </vatRateGrossData>
          </summaryByVatRate>
          <invoiceNetAmount>8000.00</invoiceNetAmount>
          <invoiceNetAmountHUF>8000.00</invoiceNetAmountHUF>
          <invoiceVatAmount>0</invoiceVatAmount>
          <invoiceVatAmountHUF>0</invoiceVatAmountHUF>
        </summaryNormal>
        <summaryGrossData>
          <invoiceGrossAmount>8000.00</invoiceGrossAmount>
          <invoiceGrossAmountHUF>8000.00</invoiceGrossAmountHUF>
        </summaryGrossData>
      </invoiceSummary>
    </invoice>
  </invoiceMain>
</InvoiceData>
```

### 10.3 (3) STORNO az (1)-re

Saját számlaszám (`PSZ-2026-000124`), `invoiceReference` (`originalInvoiceNumber=PSZ-2026-000123`, `modifyWithoutMaster=false`, `modificationIndex=1`); az eredeti 2 tétele ellentétes előjelű mennyiséggel, `lineNumberReference` 3 és 4 (az eredeti 1–2 folytatása), `lineOperation=CREATE`; az összesítő az eredeti ellentettje; `invoiceCategory` és `invoiceDeliveryDate` (2026-10-20) az eredetiből (különben WARN 11401); a kelte (2026-10-28) nem korábbi az eredetinél (WARN 342). API-ban `invoiceOperation=STORNO`, és csak az eredeti `DONE` státusza után küldjük.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<InvoiceData xmlns="http://schemas.nav.gov.hu/OSA/3.0/data" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <invoiceNumber>PSZ-2026-000124</invoiceNumber>
  <invoiceIssueDate>2026-10-28</invoiceIssueDate>
  <completenessIndicator>false</completenessIndicator>
  <invoiceMain>
    <invoice>
      <invoiceReference>
        <originalInvoiceNumber>PSZ-2026-000123</originalInvoiceNumber>
        <modifyWithoutMaster>false</modifyWithoutMaster>
        <modificationIndex>1</modificationIndex>
      </invoiceReference>
      <invoiceHead>
        <supplierInfo>
          <supplierTaxNumber>
            <base:taxpayerId>11111111</base:taxpayerId>
            <base:vatCode>2</base:vatCode>
            <base:countyCode>41</base:countyCode>
          </supplierTaxNumber>
          <supplierName>Példa Szoftver Kft.</supplierName>
          <supplierAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>1051</base:postalCode>
              <base:city>Budapest</base:city>
              <base:streetName>Példa</base:streetName>
              <base:publicPlaceCategory>utca</base:publicPlaceCategory>
              <base:number>1</base:number>
            </base:detailedAddress>
          </supplierAddress>
          <supplierBankAccountNumber>11111111-22222222-33333333</supplierBankAccountNumber>
        </supplierInfo>
        <customerInfo>
          <customerVatStatus>DOMESTIC</customerVatStatus>
          <customerVatData>
            <customerTaxNumber>
              <base:taxpayerId>22222222</base:taxpayerId>
              <base:vatCode>2</base:vatCode>
              <base:countyCode>06</base:countyCode>
            </customerTaxNumber>
          </customerVatData>
          <customerName>Vevő Minta Zrt.</customerName>
          <customerAddress>
            <base:detailedAddress>
              <base:countryCode>HU</base:countryCode>
              <base:postalCode>6720</base:postalCode>
              <base:city>Szeged</base:city>
              <base:streetName>Kárász</base:streetName>
              <base:publicPlaceCategory>utca</base:publicPlaceCategory>
              <base:number>5</base:number>
            </base:detailedAddress>
          </customerAddress>
        </customerInfo>
        <invoiceDetail>
          <invoiceCategory>NORMAL</invoiceCategory>
          <invoiceDeliveryDate>2026-10-20</invoiceDeliveryDate>
          <currencyCode>HUF</currencyCode>
          <exchangeRate>1</exchangeRate>
          <paymentMethod>TRANSFER</paymentMethod>
          <paymentDate>2026-11-04</paymentDate>
          <invoiceAppearance>ELECTRONIC</invoiceAppearance>
        </invoiceDetail>
      </invoiceHead>
      <invoiceLines>
        <mergedItemIndicator>false</mergedItemIndicator>
        <line>
          <lineNumber>1</lineNumber>
          <lineModificationReference>
            <lineNumberReference>3</lineNumberReference>
            <lineOperation>CREATE</lineOperation>
          </lineModificationReference>
          <lineExpressionIndicator>true</lineExpressionIndicator>
          <lineNatureIndicator>SERVICE</lineNatureIndicator>
          <lineDescription>Szoftverfejlesztési szolgáltatás</lineDescription>
          <quantity>-10</quantity>
          <unitOfMeasure>HOUR</unitOfMeasure>
          <unitPrice>15000</unitPrice>
          <lineAmountsNormal>
            <lineNetAmountData>
              <lineNetAmount>-150000.00</lineNetAmount>
              <lineNetAmountHUF>-150000.00</lineNetAmountHUF>
            </lineNetAmountData>
            <lineVatRate>
              <vatPercentage>0.27</vatPercentage>
            </lineVatRate>
            <lineVatData>
              <lineVatAmount>-40500.00</lineVatAmount>
              <lineVatAmountHUF>-40500.00</lineVatAmountHUF>
            </lineVatData>
            <lineGrossAmountData>
              <lineGrossAmountNormal>-190500.00</lineGrossAmountNormal>
              <lineGrossAmountNormalHUF>-190500.00</lineGrossAmountNormalHUF>
            </lineGrossAmountData>
          </lineAmountsNormal>
        </line>
        <line>
          <lineNumber>2</lineNumber>
          <lineModificationReference>
            <lineNumberReference>4</lineNumberReference>
            <lineOperation>CREATE</lineOperation>
          </lineModificationReference>
          <productCodes>
            <productCode>
              <productCodeCategory>VTSZ</productCodeCategory>
              <productCodeValue>49019900</productCodeValue>
            </productCode>
          </productCodes>
          <lineExpressionIndicator>true</lineExpressionIndicator>
          <lineNatureIndicator>PRODUCT</lineNatureIndicator>
          <lineDescription>Szakkönyv</lineDescription>
          <quantity>-2</quantity>
          <unitOfMeasure>PIECE</unitOfMeasure>
          <unitPrice>4500</unitPrice>
          <lineAmountsNormal>
            <lineNetAmountData>
              <lineNetAmount>-9000.00</lineNetAmount>
              <lineNetAmountHUF>-9000.00</lineNetAmountHUF>
            </lineNetAmountData>
            <lineVatRate>
              <vatPercentage>0.05</vatPercentage>
            </lineVatRate>
            <lineVatData>
              <lineVatAmount>-450.00</lineVatAmount>
              <lineVatAmountHUF>-450.00</lineVatAmountHUF>
            </lineVatData>
            <lineGrossAmountData>
              <lineGrossAmountNormal>-9450.00</lineGrossAmountNormal>
              <lineGrossAmountNormalHUF>-9450.00</lineGrossAmountNormalHUF>
            </lineGrossAmountData>
          </lineAmountsNormal>
        </line>
      </invoiceLines>
      <invoiceSummary>
        <summaryNormal>
          <summaryByVatRate>
            <vatRate>
              <vatPercentage>0.27</vatPercentage>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>-150000.00</vatRateNetAmount>
              <vatRateNetAmountHUF>-150000.00</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>-40500.00</vatRateVatAmount>
              <vatRateVatAmountHUF>-40500.00</vatRateVatAmountHUF>
            </vatRateVatData>
            <vatRateGrossData>
              <vatRateGrossAmount>-190500.00</vatRateGrossAmount>
              <vatRateGrossAmountHUF>-190500.00</vatRateGrossAmountHUF>
            </vatRateGrossData>
          </summaryByVatRate>
          <summaryByVatRate>
            <vatRate>
              <vatPercentage>0.05</vatPercentage>
            </vatRate>
            <vatRateNetData>
              <vatRateNetAmount>-9000.00</vatRateNetAmount>
              <vatRateNetAmountHUF>-9000.00</vatRateNetAmountHUF>
            </vatRateNetData>
            <vatRateVatData>
              <vatRateVatAmount>-450.00</vatRateVatAmount>
              <vatRateVatAmountHUF>-450.00</vatRateVatAmountHUF>
            </vatRateVatData>
            <vatRateGrossData>
              <vatRateGrossAmount>-9450.00</vatRateGrossAmount>
              <vatRateGrossAmountHUF>-9450.00</vatRateGrossAmountHUF>
            </vatRateGrossData>
          </summaryByVatRate>
          <invoiceNetAmount>-159000.00</invoiceNetAmount>
          <invoiceNetAmountHUF>-159000.00</invoiceNetAmountHUF>
          <invoiceVatAmount>-40950.00</invoiceVatAmount>
          <invoiceVatAmountHUF>-40950.00</invoiceVatAmountHUF>
        </summaryNormal>
        <summaryGrossData>
          <invoiceGrossAmount>-199950.00</invoiceGrossAmount>
          <invoiceGrossAmountHUF>-199950.00</invoiceGrossAmountHUF>
        </summaryGrossData>
      </invoiceSummary>
    </invoice>
  </invoiceMain>
</InvoiceData>
```

### 10.4 Validálási kimenet

Pozitív (a 3 InvoiceData + a 11. fejezet 4 kérése és 5 válasza; xmllint-wasm 5.3.0 / libxml2 2.13.8, 12.1 szkript, wrapper-séma, 2026-10-27):

```text
$ node validate.mjs <nav-xsd> ex1-b2b-domestic.xml ex2-b2c-aam.xml ex3-storno-of-ex1.xml api-*.xml resp-*.xml
VALID   ex1-b2b-domestic.xml
   | ex1-b2b-domestic.xml validates
VALID   ex2-b2c-aam.xml
   | ex2-b2c-aam.xml validates
VALID   ex3-storno-of-ex1.xml
   | ex3-storno-of-ex1.xml validates
VALID   api-manageInvoice.xml
   | api-manageInvoice.xml validates
VALID   api-queryTaxpayer.xml
   | api-queryTaxpayer.xml validates
VALID   api-queryTransactionStatus.xml
   | api-queryTransactionStatus.xml validates
VALID   api-tokenExchange.xml
   | api-tokenExchange.xml validates
VALID   resp-generalError.xml
   | resp-generalError.xml validates
VALID   resp-manageInvoice.xml
   | resp-manageInvoice.xml validates
VALID   resp-queryTaxpayer.xml
   | resp-queryTaxpayer.xml validates
VALID   resp-queryTransactionStatus.xml
   | resp-queryTransactionStatus.xml validates
VALID   resp-tokenExchange.xml
   | resp-tokenExchange.xml validates
exit code: 0
```

Negatív tesztek (az (1) példa egy-egy szándékos rontásával – bizonyítja, hogy a sorrendet, névteret és facet-eket valóban ellenőrzi; az utolsó kettő üzleti szabály, amit az XSD **nem** fog meg):

```text
$ node validate.mjs <nav-xsd> negative/*.xml
INVALID neg1-order-swap.xml
   | neg1-order-swap.xml:55: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}paymentMethod': This element is not expected. Expected is one of ( {http://schemas.nav.gov.hu/OSA/3.0/data}cashAccountingIndicator, {http://schemas.nav.gov.hu/OSA/3.0/data}invoiceAppearance ).
   | neg1-order-swap.xml fails to validate
INVALID neg2-wrong-namespace.xml
   | neg2-wrong-namespace.xml:11: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}taxpayerId': This element is not expected. Expected is ( {http://schemas.nav.gov.hu/OSA/3.0/base}taxpayerId ).
   | neg2-wrong-namespace.xml fails to validate
INVALID neg3-exchangerate-zero.xml
   | neg3-exchangerate-zero.xml:53: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}exchangeRate': [facet 'minExclusive'] The value '0' must be greater than '0'.
   | neg3-exchangerate-zero.xml fails to validate
INVALID neg4-bad-enum.xml
   | neg4-bad-enum.xml:54: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}paymentMethod': [facet 'enumeration'] The value 'BANK' is not an element of the set {'TRANSFER', 'CASH', 'CARD', 'VOUCHER', 'OTHER'}.
   | neg4-bad-enum.xml fails to validate
INVALID neg5-monetary-3-decimals.xml
   | neg5-monetary-3-decimals.xml:103: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}lineNetAmount': [facet 'fractionDigits'] The value '9000.001' has more fractional digits than are allowed ('2').
   | neg5-monetary-3-decimals.xml fails to validate
INVALID neg6-vat-27.xml
   | neg6-vat-27.xml:75: Schemas validity error : Element '{http://schemas.nav.gov.hu/OSA/3.0/data}vatPercentage': [facet 'maxInclusive'] The value '27' is greater than the maximum value allowed ('1').
   | neg6-vat-27.xml fails to validate
VALID   neg7-private-person-with-data-schema-valid.xml
   | neg7-private-person-with-data-schema-valid.xml validates
VALID   neg8-invoicenumber-trailing-space-schema-valid.xml
   | neg8-invoicenumber-trailing-space-schema-valid.xml validates
exit code: 1
```

---

## 11. Példa API-kérések és -válaszok (XSD-validálva)

Fiktív technikai felhasználó: login `testlogin000001`, jelszó `Example-Pass1`, aláírókulcs `ab-cd12-0123456789abcdefEXAMPLE0`, adószám `11111111` – a `passwordHash` és a `requestSignature` ezekből a 4. fejezet szerint számolva (12.3 szkript). A `software` blokk mintaérték. A válaszok **szintetikus, sémahelyes illusztrációk** (nem valós szerverválaszok; a valós válaszok más névtér-prefixeket használhatnak).

### 11.1 `TokenExchangeRequest`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<TokenExchangeRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110000001</common:requestId>
    <common:timestamp>2026-10-27T11:00:00.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>testlogin000001</common:login>
    <common:passwordHash cryptoType="SHA-512">F64FC795528D1E53C0D39C5D076280AA9149054583B08C54ECDE32B8D580010D39F3838AD5121D3F3675394F546D6E685C083382E9D4823E70951FD1071D59C2</common:passwordHash>
    <common:taxNumber>11111111</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">76866B64EEC9AAD8BCFB492BC5B8A659B0C8AE9D625B33145D37E7C7FB53B9884461161BEBCFFA60C951ACC5CB2BF72860CF6A0727CD79A3CE4D7F8A287AACFE</common:requestSignature>
  </common:user>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
</TokenExchangeRequest>
```

### 11.2 `ManageInvoiceRequest` (1 db CREATE: a 10.1 példa base64-ben)
requestId `RID20261027110005002`, timestamp `2026-10-27T11:00:05.000Z` → maszk `20261027110005`; index-hash = SHA3-512(`CREATE` + base64) = `52DB449B6B5DBD5FA6DE64EB7F0C7746073B026504E1D1BB5587173DA38ECC649205B2083EEFF78B9C7D52A02996E0ECB434DCB0FE3D64798175E005CDFAEF91`; requestSignature = SHA3-512(requestId + maszk + aláírókulcs + index-hash) = `022A9A068A9310F1A00988B60B0A9019546D5B89327A5820A77FC5DE3939EF3714426BF9450214498F747BBE6AAD3C5D4A34C712B0A1A47F100E1273C1185F7C`. Az `exchangeToken` itt fiktív dekódolt token.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ManageInvoiceRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110005002</common:requestId>
    <common:timestamp>2026-10-27T11:00:05.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>testlogin000001</common:login>
    <common:passwordHash cryptoType="SHA-512">F64FC795528D1E53C0D39C5D076280AA9149054583B08C54ECDE32B8D580010D39F3838AD5121D3F3675394F546D6E685C083382E9D4823E70951FD1071D59C2</common:passwordHash>
    <common:taxNumber>11111111</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">022A9A068A9310F1A00988B60B0A9019546D5B89327A5820A77FC5DE3939EF3714426BF9450214498F747BBE6AAD3C5D4A34C712B0A1A47F100E1273C1185F7C</common:requestSignature>
  </common:user>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <exchangeToken>8e6f2b4a-1c3d-4e5f-9a0b-1c2d3e4f5a6bEXAMPLE0001</exchangeToken>
  <invoiceOperations>
    <compressedContent>false</compressedContent>
    <invoiceOperation>
      <index>1</index>
      <invoiceOperation>CREATE</invoiceOperation>
      <invoiceData>PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPEludm9pY2VEYXRhIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5uYXYuZ292Lmh1L09TQS8zLjAvZGF0YSIgeG1sbnM6YmFzZT0iaHR0cDovL3NjaGVtYXMubmF2Lmdvdi5odS9PU0EvMy4wL2Jhc2UiPgogIDxpbnZvaWNlTnVtYmVyPlBTWi0yMDI2LTAwMDEyMzwvaW52b2ljZU51bWJlcj4KICA8aW52b2ljZUlzc3VlRGF0ZT4yMDI2LTEwLTI3PC9pbnZvaWNlSXNzdWVEYXRlPgogIDxjb21wbGV0ZW5lc3NJbmRpY2F0b3I+ZmFsc2U8L2NvbXBsZXRlbmVzc0luZGljYXRvcj4KICA8aW52b2ljZU1haW4+CiAgICA8aW52b2ljZT4KICAgICAgPGludm9pY2VIZWFkPgogICAgICAgIDxzdXBwbGllckluZm8+CiAgICAgICAgICA8c3VwcGxpZXJUYXhOdW1iZXI+CiAgICAgICAgICAgIDxiYXNlOnRheHBheWVySWQ+MTExMTExMTE8L2Jhc2U6dGF4cGF5ZXJJZD4KICAgICAgICAgICAgPGJhc2U6dmF0Q29kZT4yPC9iYXNlOnZhdENvZGU+CiAgICAgICAgICAgIDxiYXNlOmNvdW50eUNvZGU+NDE8L2Jhc2U6Y291bnR5Q29kZT4KICAgICAgICAgIDwvc3VwcGxpZXJUYXhOdW1iZXI+CiAgICAgICAgICA8c3VwcGxpZXJOYW1lPlDDqWxkYSBTem9mdHZlciBLZnQuPC9zdXBwbGllck5hbWU+CiAgICAgICAgICA8c3VwcGxpZXJBZGRyZXNzPgogICAgICAgICAgICA8YmFzZTpkZXRhaWxlZEFkZHJlc3M+CiAgICAgICAgICAgICAgPGJhc2U6Y291bnRyeUNvZGU+SFU8L2Jhc2U6Y291bnRyeUNvZGU+CiAgICAgICAgICAgICAgPGJhc2U6cG9zdGFsQ29kZT4xMDUxPC9iYXNlOnBvc3RhbENvZGU+CiAgICAgICAgICAgICAgPGJhc2U6Y2l0eT5CdWRhcGVzdDwvYmFzZTpjaXR5PgogICAgICAgICAgICAgIDxiYXNlOnN0cmVldE5hbWU+UMOpbGRhPC9iYXNlOnN0cmVldE5hbWU+CiAgICAgICAgICAgICAgPGJhc2U6cHVibGljUGxhY2VDYXRlZ29yeT51dGNhPC9iYXNlOnB1YmxpY1BsYWNlQ2F0ZWdvcnk+CiAgICAgICAgICAgICAgPGJhc2U6bnVtYmVyPjE8L2Jhc2U6bnVtYmVyPgogICAgICAgICAgICA8L2Jhc2U6ZGV0YWlsZWRBZGRyZXNzPgogICAgICAgICAgPC9zdXBwbGllckFkZHJlc3M+CiAgICAgICAgICA8c3VwcGxpZXJCYW5rQWNjb3VudE51bWJlcj4xMTExMTExMS0yMjIyMjIyMi0zMzMzMzMzMzwvc3VwcGxpZXJCYW5rQWNjb3VudE51bWJlcj4KICAgICAgICA8L3N1cHBsaWVySW5mbz4KICAgICAgICA8Y3VzdG9tZXJJbmZvPgogICAgICAgICAgPGN1c3RvbWVyVmF0U3RhdHVzPkRPTUVTVElDPC9jdXN0b21lclZhdFN0YXR1cz4KICAgICAgICAgIDxjdXN0b21lclZhdERhdGE+CiAgICAgICAgICAgIDxjdXN0b21lclRheE51bWJlcj4KICAgICAgICAgICAgICA8YmFzZTp0YXhwYXllcklkPjIyMjIyMjIyPC9iYXNlOnRheHBheWVySWQ+CiAgICAgICAgICAgICAgPGJhc2U6dmF0Q29kZT4yPC9iYXNlOnZhdENvZGU+CiAgICAgICAgICAgICAgPGJhc2U6Y291bnR5Q29kZT4wNjwvYmFzZTpjb3VudHlDb2RlPgogICAgICAgICAgICA8L2N1c3RvbWVyVGF4TnVtYmVyPgogICAgICAgICAgPC9jdXN0b21lclZhdERhdGE+CiAgICAgICAgICA8Y3VzdG9tZXJOYW1lPlZldsWRIE1pbnRhIFpydC48L2N1c3RvbWVyTmFtZT4KICAgICAgICAgIDxjdXN0b21lckFkZHJlc3M+CiAgICAgICAgICAgIDxiYXNlOmRldGFpbGVkQWRkcmVzcz4KICAgICAgICAgICAgICA8YmFzZTpjb3VudHJ5Q29kZT5IVTwvYmFzZTpjb3VudHJ5Q29kZT4KICAgICAgICAgICAgICA8YmFzZTpwb3N0YWxDb2RlPjY3MjA8L2Jhc2U6cG9zdGFsQ29kZT4KICAgICAgICAgICAgICA8YmFzZTpjaXR5PlN6ZWdlZDwvYmFzZTpjaXR5PgogICAgICAgICAgICAgIDxiYXNlOnN0cmVldE5hbWU+S8OhcsOhc3o8L2Jhc2U6c3RyZWV0TmFtZT4KICAgICAgICAgICAgICA8YmFzZTpwdWJsaWNQbGFjZUNhdGVnb3J5PnV0Y2E8L2Jhc2U6cHVibGljUGxhY2VDYXRlZ29yeT4KICAgICAgICAgICAgICA8YmFzZTpudW1iZXI+NTwvYmFzZTpudW1iZXI+CiAgICAgICAgICAgIDwvYmFzZTpkZXRhaWxlZEFkZHJlc3M+CiAgICAgICAgICA8L2N1c3RvbWVyQWRkcmVzcz4KICAgICAgICA8L2N1c3RvbWVySW5mbz4KICAgICAgICA8aW52b2ljZURldGFpbD4KICAgICAgICAgIDxpbnZvaWNlQ2F0ZWdvcnk+Tk9STUFMPC9pbnZvaWNlQ2F0ZWdvcnk+CiAgICAgICAgICA8aW52b2ljZURlbGl2ZXJ5RGF0ZT4yMDI2LTEwLTIwPC9pbnZvaWNlRGVsaXZlcnlEYXRlPgogICAgICAgICAgPGN1cnJlbmN5Q29kZT5IVUY8L2N1cnJlbmN5Q29kZT4KICAgICAgICAgIDxleGNoYW5nZVJhdGU+MTwvZXhjaGFuZ2VSYXRlPgogICAgICAgICAgPHBheW1lbnRNZXRob2Q+VFJBTlNGRVI8L3BheW1lbnRNZXRob2Q+CiAgICAgICAgICA8cGF5bWVudERhdGU+MjAyNi0xMS0wNDwvcGF5bWVudERhdGU+CiAgICAgICAgICA8aW52b2ljZUFwcGVhcmFuY2U+RUxFQ1RST05JQzwvaW52b2ljZUFwcGVhcmFuY2U+CiAgICAgICAgPC9pbnZvaWNlRGV0YWlsPgogICAgICA8L2ludm9pY2VIZWFkPgogICAgICA8aW52b2ljZUxpbmVzPgogICAgICAgIDxtZXJnZWRJdGVtSW5kaWNhdG9yPmZhbHNlPC9tZXJnZWRJdGVtSW5kaWNhdG9yPgogICAgICAgIDxsaW5lPgogICAgICAgICAgPGxpbmVOdW1iZXI+MTwvbGluZU51bWJlcj4KICAgICAgICAgIDxsaW5lRXhwcmVzc2lvbkluZGljYXRvcj50cnVlPC9saW5lRXhwcmVzc2lvbkluZGljYXRvcj4KICAgICAgICAgIDxsaW5lTmF0dXJlSW5kaWNhdG9yPlNFUlZJQ0U8L2xpbmVOYXR1cmVJbmRpY2F0b3I+CiAgICAgICAgICA8bGluZURlc2NyaXB0aW9uPlN6b2Z0dmVyZmVqbGVzenTDqXNpIHN6b2xnw6FsdGF0w6FzPC9saW5lRGVzY3JpcHRpb24+CiAgICAgICAgICA8cXVhbnRpdHk+MTA8L3F1YW50aXR5PgogICAgICAgICAgPHVuaXRPZk1lYXN1cmU+SE9VUjwvdW5pdE9mTWVhc3VyZT4KICAgICAgICAgIDx1bml0UHJpY2U+MTUwMDA8L3VuaXRQcmljZT4KICAgICAgICAgIDxsaW5lQW1vdW50c05vcm1hbD4KICAgICAgICAgICAgPGxpbmVOZXRBbW91bnREYXRhPgogICAgICAgICAgICAgIDxsaW5lTmV0QW1vdW50PjE1MDAwMC4wMDwvbGluZU5ldEFtb3VudD4KICAgICAgICAgICAgICA8bGluZU5ldEFtb3VudEhVRj4xNTAwMDAuMDA8L2xpbmVOZXRBbW91bnRIVUY+CiAgICAgICAgICAgIDwvbGluZU5ldEFtb3VudERhdGE+CiAgICAgICAgICAgIDxsaW5lVmF0UmF0ZT4KICAgICAgICAgICAgICA8dmF0UGVyY2VudGFnZT4wLjI3PC92YXRQZXJjZW50YWdlPgogICAgICAgICAgICA8L2xpbmVWYXRSYXRlPgogICAgICAgICAgICA8bGluZVZhdERhdGE+CiAgICAgICAgICAgICAgPGxpbmVWYXRBbW91bnQ+NDA1MDAuMDA8L2xpbmVWYXRBbW91bnQ+CiAgICAgICAgICAgICAgPGxpbmVWYXRBbW91bnRIVUY+NDA1MDAuMDA8L2xpbmVWYXRBbW91bnRIVUY+CiAgICAgICAgICAgIDwvbGluZVZhdERhdGE+CiAgICAgICAgICAgIDxsaW5lR3Jvc3NBbW91bnREYXRhPgogICAgICAgICAgICAgIDxsaW5lR3Jvc3NBbW91bnROb3JtYWw+MTkwNTAwLjAwPC9saW5lR3Jvc3NBbW91bnROb3JtYWw+CiAgICAgICAgICAgICAgPGxpbmVHcm9zc0Ftb3VudE5vcm1hbEhVRj4xOTA1MDAuMDA8L2xpbmVHcm9zc0Ftb3VudE5vcm1hbEhVRj4KICAgICAgICAgICAgPC9saW5lR3Jvc3NBbW91bnREYXRhPgogICAgICAgICAgPC9saW5lQW1vdW50c05vcm1hbD4KICAgICAgICA8L2xpbmU+CiAgICAgICAgPGxpbmU+CiAgICAgICAgICA8bGluZU51bWJlcj4yPC9saW5lTnVtYmVyPgogICAgICAgICAgPHByb2R1Y3RDb2Rlcz4KICAgICAgICAgICAgPHByb2R1Y3RDb2RlPgogICAgICAgICAgICAgIDxwcm9kdWN0Q29kZUNhdGVnb3J5PlZUU1o8L3Byb2R1Y3RDb2RlQ2F0ZWdvcnk+CiAgICAgICAgICAgICAgPHByb2R1Y3RDb2RlVmFsdWU+NDkwMTk5MDA8L3Byb2R1Y3RDb2RlVmFsdWU+CiAgICAgICAgICAgIDwvcHJvZHVjdENvZGU+CiAgICAgICAgICA8L3Byb2R1Y3RDb2Rlcz4KICAgICAgICAgIDxsaW5lRXhwcmVzc2lvbkluZGljYXRvcj50cnVlPC9saW5lRXhwcmVzc2lvbkluZGljYXRvcj4KICAgICAgICAgIDxsaW5lTmF0dXJlSW5kaWNhdG9yPlBST0RVQ1Q8L2xpbmVOYXR1cmVJbmRpY2F0b3I+CiAgICAgICAgICA8bGluZURlc2NyaXB0aW9uPlN6YWtrw7ZueXY8L2xpbmVEZXNjcmlwdGlvbj4KICAgICAgICAgIDxxdWFudGl0eT4yPC9xdWFudGl0eT4KICAgICAgICAgIDx1bml0T2ZNZWFzdXJlPlBJRUNFPC91bml0T2ZNZWFzdXJlPgogICAgICAgICAgPHVuaXRQcmljZT40NTAwPC91bml0UHJpY2U+CiAgICAgICAgICA8bGluZUFtb3VudHNOb3JtYWw+CiAgICAgICAgICAgIDxsaW5lTmV0QW1vdW50RGF0YT4KICAgICAgICAgICAgICA8bGluZU5ldEFtb3VudD45MDAwLjAwPC9saW5lTmV0QW1vdW50PgogICAgICAgICAgICAgIDxsaW5lTmV0QW1vdW50SFVGPjkwMDAuMDA8L2xpbmVOZXRBbW91bnRIVUY+CiAgICAgICAgICAgIDwvbGluZU5ldEFtb3VudERhdGE+CiAgICAgICAgICAgIDxsaW5lVmF0UmF0ZT4KICAgICAgICAgICAgICA8dmF0UGVyY2VudGFnZT4wLjA1PC92YXRQZXJjZW50YWdlPgogICAgICAgICAgICA8L2xpbmVWYXRSYXRlPgogICAgICAgICAgICA8bGluZVZhdERhdGE+CiAgICAgICAgICAgICAgPGxpbmVWYXRBbW91bnQ+NDUwLjAwPC9saW5lVmF0QW1vdW50PgogICAgICAgICAgICAgIDxsaW5lVmF0QW1vdW50SFVGPjQ1MC4wMDwvbGluZVZhdEFtb3VudEhVRj4KICAgICAgICAgICAgPC9saW5lVmF0RGF0YT4KICAgICAgICAgICAgPGxpbmVHcm9zc0Ftb3VudERhdGE+CiAgICAgICAgICAgICAgPGxpbmVHcm9zc0Ftb3VudE5vcm1hbD45NDUwLjAwPC9saW5lR3Jvc3NBbW91bnROb3JtYWw+CiAgICAgICAgICAgICAgPGxpbmVHcm9zc0Ftb3VudE5vcm1hbEhVRj45NDUwLjAwPC9saW5lR3Jvc3NBbW91bnROb3JtYWxIVUY+CiAgICAgICAgICAgIDwvbGluZUdyb3NzQW1vdW50RGF0YT4KICAgICAgICAgIDwvbGluZUFtb3VudHNOb3JtYWw+CiAgICAgICAgPC9saW5lPgogICAgICA8L2ludm9pY2VMaW5lcz4KICAgICAgPGludm9pY2VTdW1tYXJ5PgogICAgICAgIDxzdW1tYXJ5Tm9ybWFsPgogICAgICAgICAgPHN1bW1hcnlCeVZhdFJhdGU+CiAgICAgICAgICAgIDx2YXRSYXRlPgogICAgICAgICAgICAgIDx2YXRQZXJjZW50YWdlPjAuMjc8L3ZhdFBlcmNlbnRhZ2U+CiAgICAgICAgICAgIDwvdmF0UmF0ZT4KICAgICAgICAgICAgPHZhdFJhdGVOZXREYXRhPgogICAgICAgICAgICAgIDx2YXRSYXRlTmV0QW1vdW50PjE1MDAwMC4wMDwvdmF0UmF0ZU5ldEFtb3VudD4KICAgICAgICAgICAgICA8dmF0UmF0ZU5ldEFtb3VudEhVRj4xNTAwMDAuMDA8L3ZhdFJhdGVOZXRBbW91bnRIVUY+CiAgICAgICAgICAgIDwvdmF0UmF0ZU5ldERhdGE+CiAgICAgICAgICAgIDx2YXRSYXRlVmF0RGF0YT4KICAgICAgICAgICAgICA8dmF0UmF0ZVZhdEFtb3VudD40MDUwMC4wMDwvdmF0UmF0ZVZhdEFtb3VudD4KICAgICAgICAgICAgICA8dmF0UmF0ZVZhdEFtb3VudEhVRj40MDUwMC4wMDwvdmF0UmF0ZVZhdEFtb3VudEhVRj4KICAgICAgICAgICAgPC92YXRSYXRlVmF0RGF0YT4KICAgICAgICAgICAgPHZhdFJhdGVHcm9zc0RhdGE+CiAgICAgICAgICAgICAgPHZhdFJhdGVHcm9zc0Ftb3VudD4xOTA1MDAuMDA8L3ZhdFJhdGVHcm9zc0Ftb3VudD4KICAgICAgICAgICAgICA8dmF0UmF0ZUdyb3NzQW1vdW50SFVGPjE5MDUwMC4wMDwvdmF0UmF0ZUdyb3NzQW1vdW50SFVGPgogICAgICAgICAgICA8L3ZhdFJhdGVHcm9zc0RhdGE+CiAgICAgICAgICA8L3N1bW1hcnlCeVZhdFJhdGU+CiAgICAgICAgICA8c3VtbWFyeUJ5VmF0UmF0ZT4KICAgICAgICAgICAgPHZhdFJhdGU+CiAgICAgICAgICAgICAgPHZhdFBlcmNlbnRhZ2U+MC4wNTwvdmF0UGVyY2VudGFnZT4KICAgICAgICAgICAgPC92YXRSYXRlPgogICAgICAgICAgICA8dmF0UmF0ZU5ldERhdGE+CiAgICAgICAgICAgICAgPHZhdFJhdGVOZXRBbW91bnQ+OTAwMC4wMDwvdmF0UmF0ZU5ldEFtb3VudD4KICAgICAgICAgICAgICA8dmF0UmF0ZU5ldEFtb3VudEhVRj45MDAwLjAwPC92YXRSYXRlTmV0QW1vdW50SFVGPgogICAgICAgICAgICA8L3ZhdFJhdGVOZXREYXRhPgogICAgICAgICAgICA8dmF0UmF0ZVZhdERhdGE+CiAgICAgICAgICAgICAgPHZhdFJhdGVWYXRBbW91bnQ+NDUwLjAwPC92YXRSYXRlVmF0QW1vdW50PgogICAgICAgICAgICAgIDx2YXRSYXRlVmF0QW1vdW50SFVGPjQ1MC4wMDwvdmF0UmF0ZVZhdEFtb3VudEhVRj4KICAgICAgICAgICAgPC92YXRSYXRlVmF0RGF0YT4KICAgICAgICAgICAgPHZhdFJhdGVHcm9zc0RhdGE+CiAgICAgICAgICAgICAgPHZhdFJhdGVHcm9zc0Ftb3VudD45NDUwLjAwPC92YXRSYXRlR3Jvc3NBbW91bnQ+CiAgICAgICAgICAgICAgPHZhdFJhdGVHcm9zc0Ftb3VudEhVRj45NDUwLjAwPC92YXRSYXRlR3Jvc3NBbW91bnRIVUY+CiAgICAgICAgICAgIDwvdmF0UmF0ZUdyb3NzRGF0YT4KICAgICAgICAgIDwvc3VtbWFyeUJ5VmF0UmF0ZT4KICAgICAgICAgIDxpbnZvaWNlTmV0QW1vdW50PjE1OTAwMC4wMDwvaW52b2ljZU5ldEFtb3VudD4KICAgICAgICAgIDxpbnZvaWNlTmV0QW1vdW50SFVGPjE1OTAwMC4wMDwvaW52b2ljZU5ldEFtb3VudEhVRj4KICAgICAgICAgIDxpbnZvaWNlVmF0QW1vdW50PjQwOTUwLjAwPC9pbnZvaWNlVmF0QW1vdW50PgogICAgICAgICAgPGludm9pY2VWYXRBbW91bnRIVUY+NDA5NTAuMDA8L2ludm9pY2VWYXRBbW91bnRIVUY+CiAgICAgICAgPC9zdW1tYXJ5Tm9ybWFsPgogICAgICAgIDxzdW1tYXJ5R3Jvc3NEYXRhPgogICAgICAgICAgPGludm9pY2VHcm9zc0Ftb3VudD4xOTk5NTAuMDA8L2ludm9pY2VHcm9zc0Ftb3VudD4KICAgICAgICAgIDxpbnZvaWNlR3Jvc3NBbW91bnRIVUY+MTk5OTUwLjAwPC9pbnZvaWNlR3Jvc3NBbW91bnRIVUY+CiAgICAgICAgPC9zdW1tYXJ5R3Jvc3NEYXRhPgogICAgICA8L2ludm9pY2VTdW1tYXJ5PgogICAgPC9pbnZvaWNlPgogIDwvaW52b2ljZU1haW4+CjwvSW52b2ljZURhdGE+Cg==</invoiceData>
    </invoiceOperation>
  </invoiceOperations>
</ManageInvoiceRequest>
```

### 11.3 `QueryTaxpayerRequest`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<QueryTaxpayerRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110010003</common:requestId>
    <common:timestamp>2026-10-27T11:00:10.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>testlogin000001</common:login>
    <common:passwordHash cryptoType="SHA-512">F64FC795528D1E53C0D39C5D076280AA9149054583B08C54ECDE32B8D580010D39F3838AD5121D3F3675394F546D6E685C083382E9D4823E70951FD1071D59C2</common:passwordHash>
    <common:taxNumber>11111111</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">B9C5DC3F4070AE219CF15714DCB4E623227F1777073B9C52B765C4214DE721526F73B19717DB19ADBB4D481D4FBA85BF530D937666AF6192B19B901A619AA326</common:requestSignature>
  </common:user>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <taxNumber>22222222</taxNumber>
</QueryTaxpayerRequest>
```

### 11.4 `QueryTransactionStatusRequest`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<QueryTransactionStatusRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110015004</common:requestId>
    <common:timestamp>2026-10-27T11:00:15.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>testlogin000001</common:login>
    <common:passwordHash cryptoType="SHA-512">F64FC795528D1E53C0D39C5D076280AA9149054583B08C54ECDE32B8D580010D39F3838AD5121D3F3675394F546D6E685C083382E9D4823E70951FD1071D59C2</common:passwordHash>
    <common:taxNumber>11111111</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">362526D271B1C155D3C9FDBD489F092541229A248CBEA0D77AD476AE56576F3F86E1C970624A18CEA1B01069763B7A337214F58B19ACD33E95FC8777AC7BCFB4</common:requestSignature>
  </common:user>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <transactionId>4ZXYFG0PQRSTUV12</transactionId>
  <returnOriginalRequest>false</returnOriginalRequest>
</QueryTransactionStatusRequest>
```

### 11.5 Válaszok (szintetikus)

`TokenExchangeResponse` (az `encodedExchangeToken` a 12.2 round-trip teszt kimenete a fiktív `ABCDEF0123456789` cserekulccsal):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<TokenExchangeResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110000001</common:requestId>
    <common:timestamp>2026-10-27T11:00:00.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:result>
    <common:funcCode>OK</common:funcCode>
  </common:result>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <encodedExchangeToken>wNW1t6H1Qpy+Hb6qu5LmlGwUqNHCuwuhTsRSpjpR81IlIJ4qhnW183j42Bz7i7lRsGy6YJHSszOo1//Mc+GIew==</encodedExchangeToken>
  <tokenValidityFrom>2026-10-27T11:00:00.512Z</tokenValidityFrom>
  <tokenValidityTo>2026-10-27T11:05:00.512Z</tokenValidityTo>
</TokenExchangeResponse>
```

`ManageInvoiceResponse`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ManageInvoiceResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110005002</common:requestId>
    <common:timestamp>2026-10-27T11:00:05.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:result>
    <common:funcCode>OK</common:funcCode>
  </common:result>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <transactionId>4ZXYFG0PQRSTUV12</transactionId>
</ManageInvoiceResponse>
```

`QueryTransactionStatusResponse` (DONE + 1 WARN pointerrel):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<QueryTransactionStatusResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110015004</common:requestId>
    <common:timestamp>2026-10-27T11:00:15.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:result>
    <common:funcCode>OK</common:funcCode>
  </common:result>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <processingResults>
    <processingResult>
      <index>1</index>
      <invoiceStatus>DONE</invoiceStatus>
      <businessValidationMessages>
        <validationResultCode>WARN</validationResultCode>
        <validationErrorCode>INCORRECT_LINE_CALCULATION_NET_AMOUNT</validationErrorCode>
        <message>A tétel mennyiség és egységár szorzata eltér a nettó értékétől.</message>
        <pointer>
          <tag>InvoiceData/invoiceMain/invoice/invoiceLines/line/lineAmountsNormal/lineNetAmountData/lineNetAmount</tag>
          <value>150000.00</value>
          <line>1</line>
        </pointer>
      </businessValidationMessages>
      <compressedContentIndicator>false</compressedContentIndicator>
    </processingResult>
    <originalRequestVersion>3.0</originalRequestVersion>
  </processingResults>
</QueryTransactionStatusResponse>
```

`QueryTaxpayerResponse`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<QueryTaxpayerResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns:base="http://schemas.nav.gov.hu/OSA/3.0/base">
  <common:header>
    <common:requestId>RID20261027110010003</common:requestId>
    <common:timestamp>2026-10-27T11:00:10.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:result>
    <common:funcCode>OK</common:funcCode>
  </common:result>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
  <infoDate>2024-05-02T00:00:00.000Z</infoDate>
  <taxpayerValidity>true</taxpayerValidity>
  <taxpayerData>
    <taxpayerName>VEVŐ MINTA ZÁRTKÖRŰEN MŰKÖDŐ RÉSZVÉNYTÁRSASÁG</taxpayerName>
    <taxpayerShortName>VEVŐ MINTA ZRT.</taxpayerShortName>
    <taxNumberDetail>
      <base:taxpayerId>22222222</base:taxpayerId>
      <base:vatCode>2</base:vatCode>
      <base:countyCode>06</base:countyCode>
    </taxNumberDetail>
    <incorporation>ORGANIZATION</incorporation>
    <taxpayerAddressList>
      <taxpayerAddressItem>
        <taxpayerAddressType>HQ</taxpayerAddressType>
        <taxpayerAddress>
          <base:countryCode>HU</base:countryCode>
          <base:postalCode>6720</base:postalCode>
          <base:city>SZEGED</base:city>
          <base:streetName>KÁRÁSZ</base:streetName>
          <base:publicPlaceCategory>UTCA</base:publicPlaceCategory>
          <base:number>5</base:number>
        </taxpayerAddress>
      </taxpayerAddressItem>
    </taxpayerAddressList>
  </taxpayerData>
</QueryTaxpayerResponse>
```

`GeneralErrorResponse` (rossz aláírás; az üzenetszöveg a NAV i18n-fájljából):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<GeneralErrorResponse xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>RID20261027110005002</common:requestId>
    <common:timestamp>2026-10-27T11:00:05.000Z</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:result>
    <common:funcCode>ERROR</common:funcCode>
    <common:errorCode>INVALID_REQUEST_SIGNATURE</common:errorCode>
    <common:message>Érvénytelen kérés aláírás!</common:message>
  </common:result>
  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>
</GeneralErrorResponse>
```

---

## 12. Szkriptek (Node.js 24, a kutatás ideiglenes `research-nav` munkamappájában)

Telepítés: `npm init -y && npm i xmllint-wasm @xmldom/xmldom pdfjs-dist` (verziók: xmllint-wasm 5.3.0, @xmldom/xmldom 0.9.12, pdfjs-dist 6.4.299). Futtatás pl.: `node validate.mjs <nav-xsd> <fájl.xml>…`, `node nav-crypto-check.mjs "<Online-Invoice repó>/sample/API sample"`.

### 12.1 `validate.mjs` – XSD-validálás xmllint-wasm-mal
```js
// Validate XML files against the official NAV Online Számla v3 XSDs with xmllint-wasm (libxml2 in WebAssembly).
// Usage: node validate.mjs <nav-xsd dir> <file.xml> [<file.xml> ...]
// The OSA XSDs use <xs:import namespace="..."/> WITHOUT schemaLocation (NAV relies on an XML catalog), so we
// load every schema file into xmllint's in-memory FS and validate against a small wrapper schema that imports
// each namespace with an explicit schemaLocation (common first, then base, data, api, annul).
import { validateXML } from 'xmllint-wasm';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [xsdRoot, ...files] = process.argv.slice(2);
const read = (p) => readFileSync(join(xsdRoot, p), 'utf8');
const preload = [
  { fileName: 'common.xsd', contents: read('src/schemas/nav/gov/hu/NTCA/common.xsd') },
  { fileName: 'invoiceBase.xsd', contents: read('src/schemas/nav/gov/hu/OSA/invoiceBase.xsd') },
  { fileName: 'invoiceData.xsd', contents: read('src/schemas/nav/gov/hu/OSA/invoiceData.xsd') },
  { fileName: 'invoiceApi.xsd', contents: read('src/schemas/nav/gov/hu/OSA/invoiceApi.xsd') },
  { fileName: 'invoiceAnnulment.xsd', contents: read('src/schemas/nav/gov/hu/OSA/invoiceAnnulment.xsd') },
];
export const WRAPPER_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:import namespace="http://schemas.nav.gov.hu/NTCA/1.0/common" schemaLocation="common.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/base" schemaLocation="invoiceBase.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/data" schemaLocation="invoiceData.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/api" schemaLocation="invoiceApi.xsd"/>
  <xs:import namespace="http://schemas.nav.gov.hu/OSA/3.0/annul" schemaLocation="invoiceAnnulment.xsd"/>
</xs:schema>
`;

let allValid = true;
for (const f of files) {
  const res = await validateXML({
    xml: [{ fileName: basename(f).replace(/\s+/g, '_'), contents: readFileSync(f, 'utf8') }],
    schema: [{ fileName: 'nav-all.xsd', contents: WRAPPER_XSD }],
    preload,
  });
  allValid &&= res.valid;
  console.log(`${res.valid ? 'VALID  ' : 'INVALID'} ${basename(f)}`);
  const out = res.rawOutput.trim();
  if (out) console.log(out.split('\n').map((l) => '   | ' + l).join('\n'));
}
process.exit(allValid ? 0 : 1);
```

### 12.2 `nav-crypto-check.mjs` – hivatalos példa + NAV-minták reprodukálása (`node:crypto`)
```js
// NAV Online Számla v3 crypto check (node:crypto only).
// Usage: node nav-crypto-check.mjs <path-to "sample/API sample" dir of nav-gov-hu/Online-Invoice>
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sha512U = (s) => createHash('sha512').update(s, 'utf8').digest('hex').toUpperCase();
const sha3U = (s) => createHash('sha3-512').update(s, 'utf8').digest('hex').toUpperCase();

/** ISO-8601 UTC timestamp (as sent in header/timestamp) -> yyyyMMddHHmmss mask used in the signature. */
export function maskTimestamp(isoUtc) {
  // Accepts e.g. 2017-12-30T18:25:45.000Z or 2017-12-30T18:25:45Z; milliseconds and 'Z' are dropped.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/.exec(isoUtc);
  if (!m) throw new Error('timestamp must be UTC ISO with Z: ' + isoUtc);
  return m.slice(1, 7).join('');
}

/** requestSignature for every operation except manageInvoice / manageAnnulment. */
export function signatureSimple(requestId, isoUtc, signKey) {
  return sha3U(requestId + maskTimestamp(isoUtc) + signKey);
}

/** requestSignature for manageInvoice / manageAnnulment. ops = [{operation:'CREATE', data:'<base64>'}...] in index order. */
export function signatureManage(requestId, isoUtc, signKey, ops) {
  const partial = requestId + maskTimestamp(isoUtc) + signKey;
  const indexHashes = ops.map((o) => sha3U(o.operation + o.data));
  return { partial, indexHashes, signature: sha3U(partial + indexHashes.join('')) };
}

const results = [];
const check = (name, got, expected) => {
  const ok = got === expected;
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}\n     got      ${got}\n     expected ${expected}`);
};

// 0) Known-answer tests of the primitives (FIPS 180-4 / FIPS 202 "abc" vectors)
check('SHA-512("abc") KAT', sha512U('abc'),
  'DDAF35A193617ABACC417349AE20413112E6FA4E89A97EA20A9EEEE64B55D39A2192992A274FC1A836BA3C23A3FEEBBD454D4423643CE80E2A9AC94FA54CA49F');
check('SHA3-512("abc") KAT', sha3U('abc'),
  'B751850B1A57168A5693CD924B6B096E08F621827444F70D884F5D0240D2712E10E116E9192AF3C91A7EC57647E3934057340B4CF408D5A56592F8274EEC53F0');

// 1) Official worked example, interface spec v3.0 (2026.02.12) chapter 1.5.1
{
  const r = signatureManage('TSTKFT1222564', '2017-12-30T18:25:45.000Z', 'ce-8f5e-215119fa7dd621DLMRHRLH2S', [
    { operation: 'CREATE', data: 'QWJjZDEyMzQ=' },
    { operation: 'MODIFY', data: 'RGNiYTQzMjE=' },
  ]);
  check('spec 1.5.1 partial auth', r.partial, 'TSTKFT122256420171230182545ce-8f5e-215119fa7dd621DLMRHRLH2S');
  check('spec 1.5.1 index hash #1', r.indexHashes[0],
    '4317798460962869BC67F07C48EA7E4A3AFA301513CEB87B8EB94ECF92BC220A89C480F87F0860E85E29A3B6C0463D4F29712C5AD48104A6486CE839DC2F24CB');
  check('spec 1.5.1 index hash #2', r.indexHashes[1],
    'A881218238933F6FFB9E167445CB4DAA9749BCF484FDE48AB7649FD25E8B634A4736A65A7C4A8E2831119F739837E006566F97370415AAD55E268605206F2A6C');
  check('spec 1.5.1 requestSignature', r.signature,
    '60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B74EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42');
}

// 2) Official sample request XMLs (sample/API sample/*.xml): the signKey is given there in an XML comment.
const dir = process.argv[2];
const pick = (xml, re) => { const m = re.exec(xml); if (!m) throw new Error('not found: ' + re); return m[1]; };
for (const f of ['tokenExchange.xml', 'queryTaxpayer.xml', 'queryTransactionStatus.xml', 'queryInvoiceData.xml', 'queryInvoiceDigest_outbound_query_params.xml', 'queryInvoiceDigest_inbound_invoice_chain.xml', 'queryTransactionList.xml', 'queryInvoiceCheck.xml', 'queryInvoiceChainDigest.xml']) {
  const xml = readFileSync(join(dir, f), 'utf8');
  const requestId = pick(xml, /<common:requestId>([^<]+)</);
  const ts = pick(xml, /<common:timestamp>([^<]+)</);
  const signKey = pick(xml, /<signKey>([^<]+)<\/signKey>/);
  const expected = pick(xml, /<common:requestSignature cryptoType="SHA3-512">([^<]+)</);
  check(`sample ${f} requestSignature (requestId=${requestId}, ts=${ts})`, signatureSimple(requestId, ts, signKey), expected);
}
{
  const xml = readFileSync(join(dir, 'manageInvoice.xml'), 'utf8');
  const requestId = pick(xml, /<common:requestId>([^<]+)</);
  const ts = pick(xml, /<common:timestamp>([^<]+)</);
  const signKey = pick(xml, /<signKey>([^<]+)<\/signKey>/);
  const expected = pick(xml, /<common:requestSignature cryptoType="SHA3-512">([^<]+)</);
  const ops = [...xml.matchAll(/<invoiceOperation>\s*<index>(\d+)<\/index>\s*<invoiceOperation>([A-Z]+)<\/invoiceOperation>\s*<invoiceData>([^<]+)<\/invoiceData>\s*(?:<electronicInvoiceHash cryptoType="([^"]+)">([^<]+)<\/electronicInvoiceHash>)?/g)]
    .map((m) => ({ index: +m[1], operation: m[2], data: m[3], hashType: m[4], hash: m[5] }));
  const r = signatureManage(requestId, ts, signKey, ops);
  const commentHashes = [...xml.matchAll(/<(first|second|third)IndexHash>([0-9A-F]+)</g)].map((m) => m[2]);
  r.indexHashes.forEach((h, i) => check(`sample manageInvoice.xml index hash #${i + 1} (${ops[i].operation})`, h, commentHashes[i]));
  check(`sample manageInvoice.xml requestSignature (${ops.length} ops)`, r.signature, expected);
  // The spec text (1.8.2.1 / ERROR INVALID_INVOICE_HASH) is ambiguous; the official sample (completenessIndicator=true)
  // matches SHA3-512 over the DECODED invoiceData bytes, NOT over the base64 text:
  ops.forEach((o, i) => {
    const overDecoded = createHash('sha3-512').update(Buffer.from(o.data, 'base64')).digest('hex').toUpperCase();
    check(`sample manageInvoice.xml electronicInvoiceHash #${i + 1} = SHA3-512(decoded invoiceData bytes)`, overDecoded, o.hash);
    console.log(`     (for comparison SHA3-512(base64 text) = ${sha3U(o.data).slice(0, 32)}... -> ${sha3U(o.data) === o.hash ? 'match' : 'NO match'})`);
  });
}
{
  const xml = readFileSync(join(dir, 'manageAnnulment.xml'), 'utf8');
  const requestId = pick(xml, /<common:requestId>([^<]+)</);
  const ts = pick(xml, /<common:timestamp>([^<]+)</);
  const signKey = pick(xml, /<signKey>([^<]+)<\/signKey>/);
  const expected = pick(xml, /<common:requestSignature cryptoType="SHA3-512">([^<]+)</);
  const ops = [...xml.matchAll(/<annulmentOperation>\s*<index>(\d+)<\/index>\s*<annulmentOperation>([A-Z]+)<\/annulmentOperation>\s*<invoiceAnnulment>([^<]+)<\/invoiceAnnulment>/g)]
    .map((m) => ({ operation: m[2], data: m[3] }));
  check(`sample manageAnnulment.xml requestSignature (${ops.length} ops)`, signatureManage(requestId, ts, signKey, ops).signature, expected);
}

// 3) passwordHash: SHA-512 of the literal password, uppercase hex (no official vector with a known password is published).
console.log('\npasswordHash("Example-Pass1") =', sha512U('Example-Pass1'));

// 4) exchange token: AES-128-ECB, key = 16-char exchange key (cserekulcs) as UTF-8 bytes, PKCS#5/7 padding, input base64.
//    No official vector is published -> round-trip with the decoded token value shown in the official manageInvoice sample.
{
  const exchangeKey = 'ABCDEF0123456789'; // dummy 16-char key (NOT an official value)
  const plainToken = 'b1aca173-d9e8-4561-9237-0511eed99eaa2P0ZHLXBRI2U'; // decoded token from sample manageInvoice.xml
  const c = createCipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null);
  const encoded = Buffer.concat([c.update(plainToken, 'utf8'), c.final()]).toString('base64');
  const d = createDecipheriv('aes-128-ecb', Buffer.from(exchangeKey, 'utf8'), null); // setAutoPadding(true) is the default
  const decoded = Buffer.concat([d.update(Buffer.from(encoded, 'base64')), d.final()]).toString('utf8');
  console.log('AES-128-ECB round trip: encodedExchangeToken =', encoded);
  check('AES-128-ECB decode round trip', decoded, plainToken);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
```

### 12.3 `gen-api.mjs` – a 11. fejezet kéréseinek előállítása (referencia-implementáció a boríték + aláírás képzéséhez)
```js
// Generates sample NAV Online Számla v3 API request XMLs (dummy credentials) into <outDir>.
// Usage: node gen-api.mjs <outDir> <invoiceData.xml used for manageInvoice>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, invoiceFile] = process.argv.slice(2);
const sha512U = (s) => createHash('sha512').update(s, 'utf8').digest('hex').toUpperCase();
const sha3U = (s) => createHash('sha3-512').update(s, 'utf8').digest('hex').toUpperCase();
const mask = (iso) => iso.replace(/\.\d{1,3}Z$|Z$/, '').replace(/[-:T]/g, '');

// ---- DUMMY technical user (not real) ----
const user = {
  login: 'testlogin000001',
  password: 'Example-Pass1',
  taxNumber: '11111111',
  signKey: 'ab-cd12-0123456789abcdefEXAMPLE0',
};
const software = `  <software>
    <softwareId>HU11111111-NAVCLI1</softwareId>
    <softwareName>Nyilt Szamlazo (pelda)</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>0.1.0</softwareMainVersion>
    <softwareDevName>Example Open Source Project</softwareDevName>
    <softwareDevContact>dev@example.org</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
  </software>`;

function envelope(root, requestId, timestamp, signature, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="http://schemas.nav.gov.hu/OSA/3.0/api" xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common">
  <common:header>
    <common:requestId>${requestId}</common:requestId>
    <common:timestamp>${timestamp}</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>${user.login}</common:login>
    <common:passwordHash cryptoType="SHA-512">${sha512U(user.password)}</common:passwordHash>
    <common:taxNumber>${user.taxNumber}</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">${signature}</common:requestSignature>
  </common:user>
${software}${body ? '\n' + body : ''}
</${root}>
`;
}

// 1) TokenExchangeRequest
{
  const id = 'RID20261027110000001', ts = '2026-10-27T11:00:00.000Z';
  writeFileSync(join(outDir, 'api-tokenExchange.xml'),
    envelope('TokenExchangeRequest', id, ts, sha3U(id + mask(ts) + user.signKey), ''));
}
// 2) ManageInvoiceRequest (1 CREATE operation, invoiceData = base64 of the given InvoiceData file bytes)
{
  const id = 'RID20261027110005002', ts = '2026-10-27T11:00:05.000Z';
  const b64 = readFileSync(invoiceFile).toString('base64');
  const indexHash = sha3U('CREATE' + b64);
  const sig = sha3U(id + mask(ts) + user.signKey + indexHash);
  const body = `  <exchangeToken>8e6f2b4a-1c3d-4e5f-9a0b-1c2d3e4f5a6bEXAMPLE0001</exchangeToken>
  <invoiceOperations>
    <compressedContent>false</compressedContent>
    <invoiceOperation>
      <index>1</index>
      <invoiceOperation>CREATE</invoiceOperation>
      <invoiceData>${b64}</invoiceData>
    </invoiceOperation>
  </invoiceOperations>`;
  writeFileSync(join(outDir, 'api-manageInvoice.xml'), envelope('ManageInvoiceRequest', id, ts, sig, body));
  console.log('manageInvoice: base64 length', b64.length, 'indexHash', indexHash, 'signature', sig);
}
// 3) QueryTaxpayerRequest
{
  const id = 'RID20261027110010003', ts = '2026-10-27T11:00:10.000Z';
  writeFileSync(join(outDir, 'api-queryTaxpayer.xml'),
    envelope('QueryTaxpayerRequest', id, ts, sha3U(id + mask(ts) + user.signKey), '  <taxNumber>22222222</taxNumber>'));
}
// 4) QueryTransactionStatusRequest
{
  const id = 'RID20261027110015004', ts = '2026-10-27T11:00:15.000Z';
  writeFileSync(join(outDir, 'api-queryTransactionStatus.xml'),
    envelope('QueryTransactionStatusRequest', id, ts, sha3U(id + mask(ts) + user.signKey),
      '  <transactionId>4ZXYFG0PQRSTUV12</transactionId>\n  <returnOriginalRequest>false</returnOriginalRequest>'));
}
console.log('passwordHash', sha512U(user.password));
```

---

## 13. Nyitott kérdések, bizonytalanságok

1. **`electronicInvoiceHash` számítása**: spec = base64 szöveg hash-e, NAV minta = dekódolt bájtok hash-e. Csak `completenessIndicator=true` esetén számít, ami jelenleg tiltott → most nem blokkoló. [magas a tényre]
2. **AES-kulcs képzése**: a cserekulcs UTF-8 bájtjai (16 karakter) – hivatalos tesztvektor nincs; első valós teszt-tokennel ellenőrizni kell. [közepes]
3. **Rate limit (429) konkrét értékei** nem publikusak; a régi „1 kérés/s/IP” szabály a spec szerint csak v1-es végpontokra vonatkozik. [közepes]
4. **3.49 HTTP-kód-változások élesítési napja**: a spec 2026.08.11-i, a hír 2026-08-27-i, előtte 2026-08-26-án karbantartás volt – pontos napot nem találtunk. A kliens kezelje a régi (500) és az új (400/403) kódot is. [közepes]
   > ❓ Nem ellenőrizhető: a NAV hírlista (2026-08-27: „Az Online Számla és API GW interfészspecifikáció módosítása”) és a spec 5.4 (3.49) sem ad élesítési dátumot; a tartalom (FORBIDDEN→403, a többi négy →400, 429 + `Retry-After`) a spec 3.2 táblájából megerősítve.
5. **Sztornó utáni helyes számla**: CREATE (új alapszámla) vagy MODIFY (az eredeti módosító okirata)? A spec 2.5 szövege az utóbbit sugallja, a gyakorlat és a 1140-es WARN ellentmondásos → jogi kutatás döntsön.
6. **Áfakód (`vatCode`) 1/2/3 jelentése, `smallBusinessIndicator`, `individualExemption`, PDF = `ELECTRONIC`?** – jogi kutatás.
7. **Nyílt forrású `software` blokk**: projekt-szintű vagy telepítésenkénti `softwareId`? Ki a „Gyártó” (`softwareDevName`, `softwareDevContact`, `softwareDevTaxNumber`)? A spec „Gyártó” definíciója szerint lehet a program felhasználója is. Javaslat: konfigurálható, alapértelmezés a projekt adataival, `HU` + 8 számjegy + 8 egyedi karakter formátum.
8. **Tesztkörnyezeti felhasználókezelés**: a teszt-UAM pontos URL-je és lépései (a 3.35-ös kézikönyv csak az éleset nevezi meg) – első regisztrációkor dokumentálni.
9. **Éles hibaválaszok formája** (405/415 vs. a spec 500-as `NOT_ALLOWED_EXCEPTION`-je): csak a tesztkörnyezetet próbáltuk.
10. **Jövőbeli API-verzió** (pl. az EU ViDA miatti változások): 2026-10-27-ig semmilyen jel; a Common 2.0 (NTCA/2.0) más NAV-projekteké. A NAV híreit figyelni kell. [közepes]

---

## 14. Implementációs teendők

### 14.1 NAV-kliens – MUST
1. **Végpontok**: környezetenként konfigurálható base URL (`https://api.onlineszamla.nav.gov.hu` / `https://api-test.onlineszamla.nav.gov.hu`) + `/invoiceService/v3/<operáció>`; mindig `POST`; fejlécek `Content-Type: application/xml` és `Accept: application/xml`; UTF-8 body XML-deklarációval. Alapértelmezett környezet fejlesztésben: **teszt**; éles ellen soha ne teszteljünk.
2. **requestId**: HTTP-próbálkozásonként új, `[+a-zA-Z0-9_]{1,30}` (kötőjel tilos!), adózónként egyedi, soha ne használjuk újra (az `INVALID_REQUEST_SIGNATURE`/`FORBIDDEN` hibás kérésé sem).
3. **timestamp**: aktuális UTC, `YYYY-MM-DDTHH:mm:ss.sssZ` (≤ 3 tizedes); az aláírás maszkját **ugyanebből a stringből** képezzük.
4. **Kripto**: `passwordHash = UPPER(SHA-512(jelszó))`, `cryptoType="SHA-512"`; `requestSignature` a 4.2/4.3 szerint, `cryptoType="SHA3-512"` (`createHash('sha3-512')`); index-hash a ténylegesen elküldött base64 szövegből, index-sorrendben.
5. **Kripto-tesztek**: a 12.2 24 ellenőrzése (spec 1.5.1 + a NAV 11 minta-kérése) kerüljön a unit tesztek közé (a NAV minta-XML-ek MIT licencűek, vendorolhatók).
6. **Token**: minden `manageInvoice`/`manageAnnulment` előtt `tokenExchange`; dekódolás AES-128-ECB, kulcs = cserekulcs UTF-8 (16 bájt), PKCS#7 padding; egy token = egy kérés; ne küldjük `tokenValidityTo − 30 s` után.
7. **manageInvoice**: ≤ 100 számla/kérés, `index` 1..n; `invoiceData` = base64(UTF-8 XML) (gzip csak nagy számlánál, `gzip -1`, és akkor `compressedContent=true` az egész kérésre); `electronicInvoiceHash`-t ne küldjünk; alapszámla és módosítása ne legyen egy kérésben; módosítást csak az alapszámla `DONE`-ja után.
8. **Válasz-parse**: névtér-URI alapú (prefixfüggetlen); ismerje a `GeneralErrorResponse` (api) és `GeneralExceptionResponse` (common) rootot; ismeretlen `errorCode` → általános hiba, naplózva.
9. **HTTP-kód-kezelés** (6.2): 200 → üzleti feldolgozás; 400/401/403 → nem ismételhető (kivéve `INVALID_EXCHANGE_TOKEN` → új token 1×, `REQUEST_ID_NOT_UNIQUE` → új id); **429 → `Retry-After` másodperc várakozás**; 500 `OPERATION_FAILED`/Undertow és 503 (karbantartás) → exponenciális backoff; 404/405/415 → konfigurációs/kódhiba. Kezeljük a 3.49 előtti (500) és utáni (400/403) kódokat is.
10. **Státusz-pollozás**: a 6.5 szerinti backoff; számla „bejelentett” csak `DONE`-nál; `ABORTED` → hiba a felhasználónak/ügynöknek, a hibás adatszolgáltatást javítva **ugyanazzal a számlaszámmal** kell újra beküldeni (az `ABORTED` beküldés nem „teljesített”, így nem foglalja a számlaszámot [közepes]); minden `technicalValidationMessages`/`businessValidationMessages` (kód, szöveg, pointer) tárolása számlánként.
    > ❓ Nem ellenőrizhető: a 2026.08.11-i specifikáció kifejezetten nem mondja ki, hogy `ABORTED` után ugyanaz a számlaszám újra beküldhető (a hibaleírások csak „javítani kell az adatszolgáltatást” teendőt adnak, a `INVOICE_NUMBER_NOT_UNIQUE` pedig a már *szolgáltatott* adatra vonatkozik). Első teszt-`ABORTED` esetén a tesztkörnyezetben ellenőrizni kell.
11. **Timeout-helyreállítás** a NAV referencia-implementáció szerint (6.5): 5 perc várakozás → `queryTransactionList` (utolsó 10 perc) → `queryTransactionStatus` `returnOriginalRequest=true` → párosítás vagy azonnali újraküldés – automatikusan.
12. **Perzisztencia (SQLite)**: requestId, timestamp, transactionId, index↔számla megfeleltetés, token-érvényesség, nyers kérés/válasz XML (audit), `invoiceStatus` és üzenetek; a `passwordHash`, `exchangeToken`, kulcsok **redaktálva** a naplókban.
13. **Titokkezelés (AI-operátorok miatt kiemelten)**: login, jelszó, aláírókulcs, cserekulcs titkosítva tárolva; **soha ne kerüljenek az LLM-kontextusba** (MCP-eszközök csak hivatkozzanak rájuk, ne adják vissza); teszt és éles hitelesítő adatok szigorúan elkülönítve.
14. **TLS**: Node alapértelmezett CA-tár; tanúsítvány-pinning nélkül.

### 14.2 XML-builder – MUST
1. **Pontos XSD-sorrend és névterek**: data default névtér + `base:` prefix a `TaxNumberType`-gyerekekhez (`taxpayerId`, `vatCode`, `countyCode`) és az `AddressType` alatti összes elemhez; API-ban `common:` a `header`/`user` alatt, `software` és a többi api névtérben. A builder típusvezérelt legyen (a 7.2 fa / Függelék A–B alapján), ne kézi stringösszefűzés.
2. **Validálás**: minden generált InvoiceData és API-kérés validálása a vendorolt XSD-k ellen a 1.4 wrapper-sémával – **tesztben kötelezően, futásidőben beküldés előtt** (xmllint-wasm vagy libxml2-binding); sémahibás XML-t ne küldjünk el.
3. **Számformátumok decimális aritmetikával** (nem lebegőpontos): `MonetaryType` ≤ 18 számjegy, ≤ 2 tizedes, pont tizedes-elválasztó, negatív megengedett; `quantity`/`unitPrice` ≤ 22 számjegy, ≤ 10 tizedes (alapból ≤ 6-ot írjunk); áfakulcs törtként (`0.27`), ≤ 4 tizedes; `exchangeRate` > 0, ≤ 14 számjegy, ≤ 6 tizedes, HUF → `1`.
4. **Dátumok**: `YYYY-MM-DD` időzóna nélkül, ≥ 2010-01-01; `invoiceDeliveryDate` mindig (ha a számlán nincs, = kelte); időszaknál `periodicalSettlement=true` és vége ≥ eleje.
5. **Számlaszám**: trimelt, ≤ 50 karakter, sortörés nélkül, eladónként egyedi; `originalInvoiceNumber` ugyanígy trimelve.
6. **Fix értékek**: `completenessIndicator=false`, `mergedItemIndicator=false`, `requestVersion=3.0`, `headerVersion=1.0`.
7. **Vevő** a 8.5 szerint (PRIVATE_PERSON → csak státusz; DOMESTIC → adószám + név + cím; OTHER → név + cím, max. egy adóazonosító; KBAET/EUFAD37/EUFADE → OTHER).
8. **Áfa**: `VatRateType` choice pontosan egy ággal; `vatExemption`/`vatOutOfScope`/`vatAmountMismatch` `case`-értékei saját enumként a kódban (7.3), nagybetűvel; mentes/hatályon kívüli tétel- és összesítő-áfa 0; csak a 8.3 szerinti kulcsok.
9. **Összesítő**: áfajelenként (VatRateType-előfordulásonként) egy `summaryByVatRate`, mentességnél `case`-enként; `vatRateVatData` mindig (0 is); `invoiceNet/VatAmount(HUF)` = összegek; `summaryGrossData` töltése ajánlott; a NAV-tűrésen belüli kerekítés (8.4).
10. **Tétel**: `lineNumber` 1..n; `lineExpressionIndicator` szerinti kötelező mezők; `unitOfMeasure=OWN` → `unitOfMeasureOwn`; `lineDescription` 512 karakterre csonkolva; `lineNatureIndicator` (`PRODUCT`/`SERVICE`/`OTHER`) a termék-/szolgáltatástörzsből.
11. **MODIFY/STORNO** a 9.3–9.5 szerint: új számlaszám, `invoiceReference`, `modificationIndex` számláló alapszámlánként (DB-ben, ≤ 1000), `lineModificationReference` a lánc legnagyobb sorszámát folytatva, `lineOperation=CREATE`, különbségek (STORNO: ellentétes előjelű mennyiség), összesítő = változás, `invoiceCategory` és `invoiceDeliveryDate` az eredetiből; `modifyWithoutMaster=false` saját számláinknál.

### 14.3 SHOULD
1. A sémák vendorolása megvan (`vendor/nav-online-invoice/schemas`); egészítsük ki a provenance-t (Online-Invoice commit `cc7a775…`, Common `common-1.0.0` / `ab8d788…`, SHA-256 a 1.3 táblázat **upstream (LF) oszlopa** szerint), cseréljük a jelenlegi CRLF-es fájlokat az upstream bájtokra (és tiltsuk a sorvég-konverziót, pl. `.gitattributes`: `*.xsd -text`), majd javítsuk a README-ben a common.xsd verziójelölését („common-1.0.0, predecessorTaxNumber-rel”).
   > ⚠️ Javítva (verifikáció): az eredeti pont a 1.3 „eredeti bájtok” hash-eire hivatkozott, amelyek valójában CRLF-es helyi másolatok hash-ei voltak (lásd 1.3); a vendorolt fájlok jelenleg ugyanezek a CRLF-es változatok. Bizonyíték: https://raw.githubusercontent.com/nav-gov-hu/Online-Invoice/master/src/schemas/nav/gov/hu/OSA/invoiceData.xsd
2. A NAV 41 hivatalos minta-XML-je legyen regressziós teszt (mind validál), és a 10./11. fejezet példái is.
3. **Helyi üzleti előellenőrzés** beküldés előtt: a 8.1 ERROR-ok közül minden lokálisan ellenőrizhető (vevőszabályok, kulcsok, `case`-ek, dátumok, árfolyam-sávok, számlaszám) + a 740/741/754/820/840/850/880/890 számítások a NAV-tűréssel; MCP-eszközként is kiajánlva (az AI-ügynök a beküldés előtt lássa a hibát).
4. `queryTaxpayer` integráció a vevőfelvételhez (név, cím, `incorporation`, áfacsoport) és `taxpayerValidity` ellenőrzés.
5. MODIFY/STORNO előtt opcionális kereszt-ellenőrzés `/queryInvoiceChainDigest`-tel (`maxLineNumber`, felhasznált `modificationIndex`-ek).
6. Technikai érvénytelenítés (`/manageAnnulment`) később, opcionálisan; addig dokumentáljuk a webes utat.
7. Változásfigyelés: CI-feladat, amely a NAV hír-API-t (`https://onlineszamla.nav.gov.hu/api/news/visible/list`), a Dokumentációk oldal `updatedAt`-jét (`/api/menu-items/link/dokumentaciok?lang=hu`) és a GitHub repókat figyeli.
8. NAV hiba-/WARN-kódok magyar felhasználói üzenetekre képezése (a repó i18n-fájljai 2021-esek, a spec I. mellékletéből kell frissíteni).
9. A `software` blokk telepítésenként konfigurálható (`softwareId` 18 karakter, `[0-9A-Z-]`), értelmes alapértékekkel.
10. NTP-szinkron ajánlása a telepítési útmutatóban; `INVALID_TIMESTAMP` esetén egyértelmű hibaüzenet.
11. Válaszok mentett nyers XML-jének névtér-prefix-független feldolgozására tesztek (pl. `ns2:`-es válaszok).

---

## Függelék A – InvoiceData típusok (XSD-ből generálva, sorrendhelyes)

Oszlopok: `#` = pozíció a sequence-ben (öröklött elemek elöl), `elem (névtér)` = a lokális elem névtere, `min`/`max` = előfordulás, megjegyzés: choice-tagság, `fixed`/`default`.

**data:InvoiceDataType** — A számla adatszolgáltatás adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceNumber` (data) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `invoiceIssueDate` (data) | `base:InvoiceDateType` | 1 | 1 |  |
| 3 | `completenessIndicator` (data) | `xs:boolean` | 1 | 1 |  |
| 4 | `invoiceMain` (data) | `data:InvoiceMainType` | 1 | 1 |  |

**data:InvoiceMainType** — Számlaadatok leírására szolgáló közös típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoice` (data) | `data:InvoiceType` | 1 | 1 | choice[1..1] |
| 2 | `batchInvoice` (data) | `data:BatchInvoiceType` | 1 | * | choice[1..1] |

**data:InvoiceType** — Egy számla vagy módosító okirat adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceReference` (data) | `data:InvoiceReferenceType` | 0 | 1 |  |
| 2 | `invoiceHead` (data) | `data:InvoiceHeadType` | 1 | 1 |  |
| 3 | `invoiceLines` (data) | `data:LinesType` | 0 | 1 |  |
| 4 | `productFeeSummary` (data) | `data:ProductFeeSummaryType` | 0 | 2 |  |
| 5 | `invoiceSummary` (data) | `data:SummaryType` | 1 | 1 |  |

**data:InvoiceReferenceType** — A módosítás vagy érvénytelenítés hivatkozási adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `originalInvoiceNumber` (data) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `modifyWithoutMaster` (data) | `xs:boolean` | 1 | 1 |  |
| 3 | `modificationIndex` (data) | `base:InvoiceUnboundedIndexType` | 1 | 1 |  |

**data:InvoiceHeadType** — Számla fejléc adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `supplierInfo` (data) | `data:SupplierInfoType` | 1 | 1 |  |
| 2 | `customerInfo` (data) | `data:CustomerInfoType` | 0 | 1 |  |
| 3 | `fiscalRepresentativeInfo` (data) | `data:FiscalRepresentativeType` | 0 | 1 |  |
| 4 | `invoiceDetail` (data) | `data:InvoiceDetailType` | 1 | 1 |  |

**data:SupplierInfoType** — A szállító (eladó) adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `supplierTaxNumber` (data) | `base:TaxNumberType` | 1 | 1 |  |
| 2 | `groupMemberTaxNumber` (data) | `base:TaxNumberType` | 0 | 1 |  |
| 3 | `communityVatNumber` (data) | `common:CommunityVatNumberType` | 0 | 1 |  |
| 4 | `supplierName` (data) | `common:SimpleText512NotBlankType` | 1 | 1 |  |
| 5 | `supplierAddress` (data) | `base:AddressType` | 1 | 1 |  |
| 6 | `supplierBankAccountNumber` (data) | `common:BankAccountNumberType` | 0 | 1 |  |
| 7 | `individualExemption` (data) | `xs:boolean` | 0 | 1 |  |
| 8 | `exciseLicenceNum` (data) | `common:SimpleText50NotBlankType` | 0 | 1 |  |

**base:TaxNumberType** — Adószám típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxpayerId` (base) | `common:TaxpayerIdType` | 1 | 1 |  |
| 2 | `vatCode` (base) | `common:VatCodeType` | 0 | 1 |  |
| 3 | `countyCode` (base) | `common:CountyCodeType` | 0 | 1 |  |

**base:AddressType** — Cím típus, amely vagy egyszerű, vagy részletes címet tartalmaz

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `simpleAddress` (base) | `base:SimpleAddressType` | 1 | 1 | choice[1..1] |
| 2 | `detailedAddress` (base) | `base:DetailedAddressType` | 1 | 1 | choice[1..1] |

**base:SimpleAddressType** — Egyszerű címtípus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `countryCode` (base) | `common:CountryCodeType` | 1 | 1 |  |
| 2 | `region` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 3 | `postalCode` (base) | `common:PostalCodeType` | 1 | 1 |  |
| 4 | `city` (base) | `common:SimpleText255NotBlankType` | 1 | 1 |  |
| 5 | `additionalAddressDetail` (base) | `common:SimpleText255NotBlankType` | 1 | 1 |  |

**base:DetailedAddressType** — Részletes címadatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `countryCode` (base) | `common:CountryCodeType` | 1 | 1 |  |
| 2 | `region` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 3 | `postalCode` (base) | `common:PostalCodeType` | 1 | 1 |  |
| 4 | `city` (base) | `common:SimpleText255NotBlankType` | 1 | 1 |  |
| 5 | `streetName` (base) | `common:SimpleText255NotBlankType` | 1 | 1 |  |
| 6 | `publicPlaceCategory` (base) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 7 | `number` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 8 | `building` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 9 | `staircase` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 10 | `floor` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 11 | `door` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 12 | `lotNumber` (base) | `common:SimpleText50NotBlankType` | 0 | 1 |  |

**data:CustomerInfoType** — A vevő adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `customerVatStatus` (data) | `data:CustomerVatStatusType` | 1 | 1 |  |
| 2 | `customerVatData` (data) | `data:CustomerVatDataType` | 0 | 1 |  |
| 3 | `customerName` (data) | `common:SimpleText512NotBlankType` | 0 | 1 |  |
| 4 | `customerAddress` (data) | `base:AddressType` | 0 | 1 |  |
| 5 | `customerBankAccountNumber` (data) | `common:BankAccountNumberType` | 0 | 1 |  |

**data:CustomerVatDataType** — A vevő ÁFA alanyisági adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `customerTaxNumber` (data) | `data:CustomerTaxNumberType` | 1 | 1 | choice[1..1] |
| 2 | `communityVatNumber` (data) | `common:CommunityVatNumberType` | 1 | 1 | choice[1..1] |
| 3 | `thirdStateTaxId` (data) | `common:SimpleText50NotBlankType` | 1 | 1 | choice[1..1] |

**data:CustomerTaxNumberType** — Adószám, amely alatt a számlán szereplő termékbeszerzés vagy szolgáltatás igénybevétele történt. Lehet csoportazonosító szám is

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxpayerId` (base) | `common:TaxpayerIdType` | 1 | 1 |  |
| 2 | `vatCode` (base) | `common:VatCodeType` | 0 | 1 |  |
| 3 | `countyCode` (base) | `common:CountyCodeType` | 0 | 1 |  |
| 4 | `groupMemberTaxNumber` (data) | `base:TaxNumberType` | 0 | 1 |  |

**data:FiscalRepresentativeType** — A pénzügyi képviselő adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `fiscalRepresentativeTaxNumber` (data) | `base:TaxNumberType` | 1 | 1 |  |
| 2 | `fiscalRepresentativeName` (data) | `common:SimpleText512NotBlankType` | 1 | 1 |  |
| 3 | `fiscalRepresentativeAddress` (data) | `base:AddressType` | 1 | 1 |  |
| 4 | `fiscalRepresentativeBankAccountNumber` (data) | `common:BankAccountNumberType` | 0 | 1 |  |

**data:InvoiceDetailType** — Számla részletező adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceCategory` (data) | `base:InvoiceCategoryType` | 1 | 1 |  |
| 2 | `invoiceDeliveryDate` (data) | `base:InvoiceDateType` | 1 | 1 |  |
| 3 | `invoiceDeliveryPeriodStart` (data) | `base:InvoiceDateType` | 0 | 1 |  |
| 4 | `invoiceDeliveryPeriodEnd` (data) | `base:InvoiceDateType` | 0 | 1 |  |
| 5 | `invoiceAccountingDeliveryDate` (data) | `base:InvoiceDateType` | 0 | 1 |  |
| 6 | `periodicalSettlement` (data) | `xs:boolean` | 0 | 1 |  |
| 7 | `smallBusinessIndicator` (data) | `xs:boolean` | 0 | 1 |  |
| 8 | `currencyCode` (data) | `common:CurrencyType` | 1 | 1 |  |
| 9 | `exchangeRate` (data) | `data:ExchangeRateType` | 1 | 1 |  |
| 10 | `utilitySettlementIndicator` (data) | `xs:boolean` | 0 | 1 |  |
| 11 | `selfBillingIndicator` (data) | `xs:boolean` | 0 | 1 |  |
| 12 | `paymentMethod` (data) | `base:PaymentMethodType` | 0 | 1 |  |
| 13 | `paymentDate` (data) | `base:InvoiceDateType` | 0 | 1 |  |
| 14 | `cashAccountingIndicator` (data) | `xs:boolean` | 0 | 1 |  |
| 15 | `invoiceAppearance` (data) | `base:InvoiceAppearanceType` | 1 | 1 |  |
| 16 | `conventionalInvoiceInfo` (data) | `data:ConventionalInvoiceInfoType` | 0 | 1 |  |
| 17 | `additionalInvoiceData` (data) | `data:AdditionalDataType` | 0 | * |  |

**data:ConventionalInvoiceInfoType** — A számlafeldolgozást segítő, egyezményesen nevesített egyéb adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `orderNumbers` (data) | `data:OrderNumbersType` | 0 | 1 |  |
| 2 | `deliveryNotes` (data) | `data:DeliveryNotesType` | 0 | 1 |  |
| 3 | `shippingDates` (data) | `data:ShippingDatesType` | 0 | 1 |  |
| 4 | `contractNumbers` (data) | `data:ContractNumbersType` | 0 | 1 |  |
| 5 | `supplierCompanyCodes` (data) | `data:SupplierCompanyCodesType` | 0 | 1 |  |
| 6 | `customerCompanyCodes` (data) | `data:CustomerCompanyCodesType` | 0 | 1 |  |
| 7 | `dealerCodes` (data) | `data:DealerCodesType` | 0 | 1 |  |
| 8 | `costCenters` (data) | `data:CostCentersType` | 0 | 1 |  |
| 9 | `projectNumbers` (data) | `data:ProjectNumbersType` | 0 | 1 |  |
| 10 | `generalLedgerAccountNumbers` (data) | `data:GeneralLedgerAccountNumbersType` | 0 | 1 |  |
| 11 | `glnNumbersSupplier` (data) | `data:GlnNumbersType` | 0 | 1 |  |
| 12 | `glnNumbersCustomer` (data) | `data:GlnNumbersType` | 0 | 1 |  |
| 13 | `materialNumbers` (data) | `data:MaterialNumbersType` | 0 | 1 |  |
| 14 | `itemNumbers` (data) | `data:ItemNumbersType` | 0 | 1 |  |
| 15 | `ekaerIds` (data) | `data:EkaerIdsType` | 0 | 1 |  |

**data:AdditionalDataType** — További adat leírására szolgáló típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `dataName` (data) | `data:DataNameType` | 1 | 1 |  |
| 2 | `dataDescription` (data) | `common:SimpleText255NotBlankType` | 1 | 1 |  |
| 3 | `dataValue` (data) | `common:SimpleText512NotBlankType` | 1 | 1 |  |

**data:LinesType** — Termék/szolgáltatás tételek

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `mergedItemIndicator` (data) | `xs:boolean` | 1 | 1 |  |
| 2 | `line` (data) | `data:LineType` | 1 | * |  |

**data:LineType** — A számla tételek (termék vagy szolgáltatás) adatait tartalmazó típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineNumber` (data) | `base:LineNumberType` | 1 | 1 |  |
| 2 | `lineModificationReference` (data) | `data:LineModificationReferenceType` | 0 | 1 |  |
| 3 | `referencesToOtherLines` (data) | `data:ReferencesToOtherLinesType` | 0 | 1 |  |
| 4 | `advanceData` (data) | `data:AdvanceDataType` | 0 | 1 |  |
| 5 | `productCodes` (data) | `data:ProductCodesType` | 0 | 1 |  |
| 6 | `lineExpressionIndicator` (data) | `xs:boolean` | 1 | 1 |  |
| 7 | `lineNatureIndicator` (data) | `data:LineNatureIndicatorType` | 0 | 1 |  |
| 8 | `lineDescription` (data) | `common:SimpleText512NotBlankType` | 0 | 1 |  |
| 9 | `quantity` (data) | `data:QuantityType` | 0 | 1 |  |
| 10 | `unitOfMeasure` (data) | `data:UnitOfMeasureType` | 0 | 1 |  |
| 11 | `unitOfMeasureOwn` (data) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 12 | `unitPrice` (data) | `data:QuantityType` | 0 | 1 |  |
| 13 | `unitPriceHUF` (data) | `data:QuantityType` | 0 | 1 |  |
| 14 | `lineDiscountData` (data) | `data:DiscountDataType` | 0 | 1 |  |
| 15 | `lineAmountsNormal` (data) | `data:LineAmountsNormalType` | 0 | 1 | choice[1..1] |
| 16 | `lineAmountsSimplified` (data) | `data:LineAmountsSimplifiedType` | 0 | 1 | choice[1..1] |
| 17 | `intermediatedService` (data) | `xs:boolean` | 0 | 1 |  |
| 18 | `aggregateInvoiceLineData` (data) | `data:AggregateInvoiceLineDataType` | 0 | 1 |  |
| 19 | `newTransportMean` (data) | `data:NewTransportMeanType` | 0 | 1 |  |
| 20 | `depositIndicator` (data) | `xs:boolean` | 0 | 1 |  |
| 21 | `obligatedForProductFee` (data) | `xs:boolean` | 0 | 1 |  |
| 22 | `GPCExcise` (data) | `base:MonetaryType` | 0 | 1 |  |
| 23 | `dieselOilPurchase` (data) | `data:DieselOilPurchaseType` | 0 | 1 |  |
| 24 | `netaDeclaration` (data) | `xs:boolean` | 0 | 1 |  |
| 25 | `productFeeClause` (data) | `data:ProductFeeClauseType` | 0 | 1 |  |
| 26 | `lineProductFeeContent` (data) | `data:ProductFeeDataType` | 0 | * |  |
| 27 | `conventionalLineInfo` (data) | `data:ConventionalInvoiceInfoType` | 0 | 1 |  |
| 28 | `additionalLineData` (data) | `data:AdditionalDataType` | 0 | * |  |

**data:LineModificationReferenceType** — Módosításról történő adatszolgáltatás esetén a tételsor módosítás jellegének jelölése

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineNumberReference` (data) | `base:LineNumberType` | 1 | 1 |  |
| 2 | `lineOperation` (data) | `data:LineOperationType` | 1 | 1 |  |

**data:ReferencesToOtherLinesType** — Hivatkozások kapcsolódó tételekre, ha ez az ÁFA törvény alapján szükséges

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `referenceToOtherLine` (data) | `base:LineNumberType` | 1 | * |  |

**data:AdvanceDataType** — Előleghez kapcsolódó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `advanceIndicator` (data) | `xs:boolean` | 1 | 1 |  |
| 2 | `advancePaymentData` (data) | `data:AdvancePaymentDataType` | 0 | 1 |  |

**data:AdvancePaymentDataType** — Előlegfizetéshez kapcsolódó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `advanceOriginalInvoice` (data) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `advancePaymentDate` (data) | `base:InvoiceDateType` | 1 | 1 |  |
| 3 | `advanceExchangeRate` (data) | `data:ExchangeRateType` | 1 | 1 |  |

**data:ProductCodesType** — Termékkódok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `productCode` (data) | `data:ProductCodeType` | 1 | * |  |

**data:ProductCodeType** — Különböző termék- vagy szolgáltatáskódokat tartalmazó típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `productCodeCategory` (data) | `data:ProductCodeCategoryType` | 1 | 1 |  |
| 2 | `productCodeValue` (data) | `data:ProductCodeValueType` | 1 | 1 | choice[1..1] |
| 3 | `productCodeOwnValue` (data) | `common:SimpleText255NotBlankType` | 1 | 1 | choice[1..1] |

**data:DiscountDataType** — Árengedmény adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `discountDescription` (data) | `common:SimpleText255NotBlankType` | 0 | 1 |  |
| 2 | `discountValue` (data) | `base:MonetaryType` | 0 | 1 |  |
| 3 | `discountRate` (data) | `data:RateType` | 0 | 1 |  |

**data:LineAmountsNormalType** — Normál vagy gyűjtő számla esetén kitöltendő tétel érték adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineNetAmountData` (data) | `data:LineNetAmountDataType` | 1 | 1 |  |
| 2 | `lineVatRate` (data) | `data:VatRateType` | 1 | 1 |  |
| 3 | `lineVatData` (data) | `data:LineVatDataType` | 0 | 1 |  |
| 4 | `lineGrossAmountData` (data) | `data:LineGrossAmountDataType` | 0 | 1 |  |

**data:LineNetAmountDataType** — Tétel nettó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineNetAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `lineNetAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:LineVatDataType** — Tétel ÁFA adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineVatAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `lineVatAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:LineGrossAmountDataType** — Tétel bruttó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineGrossAmountNormal` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `lineGrossAmountNormalHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:LineAmountsSimplifiedType** — Egyszerűsített számla esetén kitöltendő tétel érték adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineVatRate` (data) | `data:VatRateType` | 1 | 1 |  |
| 2 | `lineGrossAmountSimplified` (data) | `base:MonetaryType` | 1 | 1 |  |
| 3 | `lineGrossAmountSimplifiedHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:VatRateType** — Az adómérték vagy az adómentes értékesítés jelölése

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatPercentage` (data) | `data:RateType` | 1 | 1 | choice[1..1] |
| 2 | `vatContent` (data) | `data:RateType` | 1 | 1 | choice[1..1] |
| 3 | `vatExemption` (data) | `data:DetailedReasonType` | 1 | 1 | choice[1..1] |
| 4 | `vatOutOfScope` (data) | `data:DetailedReasonType` | 1 | 1 | choice[1..1] |
| 5 | `vatDomesticReverseCharge` (data) | `xs:boolean` | 1 | 1 | choice[1..1]; fixed=true |
| 6 | `marginSchemeIndicator` (data) | `data:MarginSchemeType` | 1 | 1 | choice[1..1] |
| 7 | `vatAmountMismatch` (data) | `data:VatAmountMismatchType` | 1 | 1 | choice[1..1] |
| 8 | `noVatCharge` (data) | `xs:boolean` | 1 | 1 | choice[1..1]; fixed=true |

**data:DetailedReasonType** — Mentesség, kivétel részletes indokolása

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `case` (data) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `reason` (data) | `common:SimpleText200NotBlankType` | 1 | 1 |  |

**data:VatAmountMismatchType** — Adóalap és felszámított adó eltérésének adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRate` (data) | `data:RateType` | 1 | 1 |  |
| 2 | `case` (data) | `common:SimpleText50NotBlankType` | 1 | 1 |  |

**data:AggregateInvoiceLineDataType** — A gyűjtő számlára vonatkozó speciális adatokat tartalmazó típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineExchangeRate` (data) | `data:ExchangeRateType` | 0 | 1 |  |
| 2 | `lineDeliveryDate` (data) | `base:InvoiceDateType` | 1 | 1 |  |

**data:SummaryType** — Számla összesítés adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `summaryNormal` (data) | `data:SummaryNormalType` | 1 | 1 | choice[1..1] |
| 2 | `summarySimplified` (data) | `data:SummarySimplifiedType` | 1 | * | choice[1..1] |
| 3 | `summaryGrossData` (data) | `data:SummaryGrossDataType` | 0 | 1 |  |

**data:SummaryNormalType** — Számla összesítés (nem egyszerűsített számla esetén)

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `summaryByVatRate` (data) | `data:SummaryByVatRateType` | 1 | * |  |
| 2 | `invoiceNetAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 3 | `invoiceNetAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |
| 4 | `invoiceVatAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 5 | `invoiceVatAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:SummaryByVatRateType** — ÁFA mértékek szerinti összesítés

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRate` (data) | `data:VatRateType` | 1 | 1 |  |
| 2 | `vatRateNetData` (data) | `data:VatRateNetDataType` | 1 | 1 |  |
| 3 | `vatRateVatData` (data) | `data:VatRateVatDataType` | 1 | 1 |  |
| 4 | `vatRateGrossData` (data) | `data:VatRateGrossDataType` | 0 | 1 |  |

**data:VatRateNetDataType** — Adott adómértékhez tartozó nettó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRateNetAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `vatRateNetAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:VatRateVatDataType** — Adott adómértékhez tartozó ÁFA adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRateVatAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `vatRateVatAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:VatRateGrossDataType** — Adott adómértékhez tartozó bruttó adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRateGrossAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `vatRateGrossAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:SummarySimplifiedType** — Egyszerűsített számla összesítés

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `vatRate` (data) | `data:VatRateType` | 1 | 1 |  |
| 2 | `vatContentGrossAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 3 | `vatContentGrossAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:SummaryGrossDataType** — A számla összesítő bruttó adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceGrossAmount` (data) | `base:MonetaryType` | 1 | 1 |  |
| 2 | `invoiceGrossAmountHUF` (data) | `base:MonetaryType` | 1 | 1 |  |

**data:BatchInvoiceType** — Kötegelt módosító okirat adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `batchIndex` (data) | `base:InvoiceUnboundedIndexType` | 1 | 1 |  |
| 2 | `invoice` (data) | `data:InvoiceType` | 1 | 1 |  |

**data:ProductFeeSummaryType** — Termékdíj összegzés adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `productFeeOperation` (data) | `data:ProductFeeOperationType` | 1 | 1 |  |
| 2 | `productFeeData` (data) | `data:ProductFeeDataType` | 1 | * |  |
| 3 | `productChargeSum` (data) | `base:MonetaryType` | 1 | 1 |  |
| 4 | `paymentEvidenceDocumentData` (data) | `data:PaymentEvidenceDocumentDataType` | 0 | 1 |  |

## Függelék B – API-, common- és annulment-típusok (XSD-ből generálva)

**common:BasicRequestType** — Alap kérés adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |

**common:BasicHeaderType** — A kérés tranzakcionális adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `requestId` (common) | `common:EntityIdType` | 1 | 1 |  |
| 2 | `timestamp` (common) | `common:GenericTimestampType` | 1 | 1 |  |
| 3 | `requestVersion` (common) | `common:AtomicStringType15` | 1 | 1 |  |
| 4 | `headerVersion` (common) | `common:AtomicStringType15` | 0 | 1 |  |

**common:UserHeaderType** — A kérés authentikációs adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `login` (common) | `common:LoginType` | 1 | 1 |  |
| 2 | `passwordHash` (common) | `common:CryptoType` | 1 | 1 |  |
| 3 | `taxNumber` (common) | `common:TaxpayerIdType` | 1 | 1 |  |
| 4 | `predecessorTaxNumber` (common) | `common:TaxpayerIdType` | 0 | 1 |  |
| 5 | `requestSignature` (common) | `common:CryptoType` | 1 | 1 |  |

**common:CryptoType** — Kriptográfiai metódust leíró típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `@cryptoType` | `common:SimpleText50NotBlankType` | 1 | 1 | attribute |
| 2 | `(text)` | `common:SimpleText512NotBlankType` | 1 | 1 | simpleContent |

**api:SoftwareType** — A számlázóprogram adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `softwareId` (api) | `api:SoftwareIdType` | 1 | 1 |  |
| 2 | `softwareName` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 3 | `softwareOperation` (api) | `api:SoftwareOperationType` | 1 | 1 |  |
| 4 | `softwareMainVersion` (api) | `common:SimpleText15NotBlankType` | 1 | 1 |  |
| 5 | `softwareDevName` (api) | `common:SimpleText512NotBlankType` | 1 | 1 |  |
| 6 | `softwareDevContact` (api) | `common:SimpleText200NotBlankType` | 1 | 1 |  |
| 7 | `softwareDevCountryCode` (api) | `common:CountryCodeType` | 0 | 1 |  |
| 8 | `softwareDevTaxNumber` (api) | `common:SimpleText50NotBlankType` | 0 | 1 |  |

**common:BasicResponseType** — Alap válasz adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |

**common:BasicResultType** — Alap válaszeredmény adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `funcCode` (common) | `common:FunctionCodeType` | 1 | 1 |  |
| 2 | `errorCode` (common) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 3 | `message` (common) | `common:SimpleText1024NotBlankType` | 0 | 1 |  |
| 4 | `notifications` (common) | `common:NotificationsType` | 0 | 1 |  |

**common:NotificationsType** — Egyéb értesítések

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `notification` (common) | `common:NotificationType` | 1 | * |  |

**common:NotificationType** — Értesítés

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `notificationCode` (common) | `common:SimpleText100NotBlankType` | 1 | 1 |  |
| 2 | `notificationText` (common) | `common:SimpleText1024NotBlankType` | 1 | 1 |  |

**api:GeneralErrorResponseType** — Online Számla rendszerre specifikus általános hibaválasz típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `technicalValidationMessages` (api) | `common:TechnicalValidationResultType` | 0 | * |  |

**common:TechnicalValidationResultType** — Technikai validációs választípus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `validationResultCode` (common) | `common:TechnicalResultCodeType` | 1 | 1 |  |
| 2 | `validationErrorCode` (common) | `common:SimpleText100NotBlankType` | 0 | 1 |  |
| 3 | `message` (common) | `common:SimpleText1024NotBlankType` | 0 | 1 |  |

**api:ManageInvoiceRequestType** — A POST /manageInvoice REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `exchangeToken` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 5 | `invoiceOperations` (api) | `api:InvoiceOperationListType` | 1 | 1 |  |

**api:InvoiceOperationListType** — A kéréshez tartozó kötegelt számlaműveletek

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `compressedContent` (api) | `xs:boolean` | 1 | 1 |  |
| 2 | `invoiceOperation` (api) | `api:InvoiceOperationType` | 1 | 100 |  |

**api:InvoiceOperationType** — A kéréshez tartozó számlaművelet

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `index` (api) | `base:InvoiceIndexType` | 1 | 1 |  |
| 2 | `invoiceOperation` (api) | `api:ManageInvoiceOperationType` | 1 | 1 |  |
| 3 | `invoiceData` (api) | `xs:base64Binary` | 1 | 1 |  |
| 4 | `electronicInvoiceHash` (api) | `common:CryptoType` | 0 | 1 |  |

**api:TransactionResponseType** — A POST /manageInvoice és a POST /manageAnnulment REST operáció közös válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `transactionId` (api) | `common:EntityIdType` | 1 | 1 |  |

**api:TokenExchangeResponseType** — A POST /tokenExchange REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `encodedExchangeToken` (api) | `xs:base64Binary` | 1 | 1 |  |
| 5 | `tokenValidityFrom` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 6 | `tokenValidityTo` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |

**api:QueryTransactionStatusRequestType** — A POST /queryTransactionStatus REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `transactionId` (api) | `common:EntityIdType` | 1 | 1 |  |
| 5 | `returnOriginalRequest` (api) | `xs:boolean` | 0 | 1 |  |

**api:QueryTransactionStatusResponseType** — A POST /queryTransactionStatus REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `processingResults` (api) | `api:ProcessingResultListType` | 0 | 1 |  |

**api:ProcessingResultListType** — A kéréshez tartozó feldolgozási eredmények

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `processingResult` (api) | `api:ProcessingResultType` | 1 | * |  |
| 2 | `originalRequestVersion` (api) | `api:OriginalRequestVersionType` | 1 | 1 |  |
| 3 | `annulmentData` (api) | `api:AnnulmentDataType` | 0 | 1 |  |

**api:ProcessingResultType** — Számla feldolgozási eredmény

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `index` (api) | `base:InvoiceIndexType` | 1 | 1 |  |
| 2 | `batchIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 3 | `invoiceStatus` (api) | `api:InvoiceStatusType` | 1 | 1 |  |
| 4 | `technicalValidationMessages` (api) | `common:TechnicalValidationResultType` | 0 | * |  |
| 5 | `businessValidationMessages` (api) | `api:BusinessValidationResultType` | 0 | * |  |
| 6 | `compressedContentIndicator` (api) | `xs:boolean` | 1 | 1 |  |
| 7 | `originalRequest` (api) | `xs:base64Binary` | 0 | 1 |  |

**api:BusinessValidationResultType** — Üzleti validációs választípus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `validationResultCode` (api) | `common:BusinessResultCodeType` | 1 | 1 |  |
| 2 | `validationErrorCode` (api) | `common:SimpleText100NotBlankType` | 0 | 1 |  |
| 3 | `message` (api) | `common:SimpleText512NotBlankType` | 0 | 1 |  |
| 4 | `pointer` (api) | `api:PointerType` | 0 | 1 |  |

**api:PointerType** — Feldolgozási kurzor adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `tag` (api) | `common:SimpleText1024NotBlankType` | 0 | 1 |  |
| 2 | `value` (api) | `common:SimpleText1024NotBlankType` | 0 | 1 |  |
| 3 | `line` (api) | `base:LineNumberType` | 0 | 1 |  |
| 4 | `originalInvoiceNumber` (api) | `common:SimpleText50NotBlankType` | 0 | 1 |  |

**api:AnnulmentDataType** — Technikai érvénytelenítés státusz adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `annulmentVerificationStatus` (api) | `api:AnnulmentVerificationStatusType` | 1 | 1 |  |
| 2 | `annulmentDecisionDate` (api) | `base:InvoiceTimestampType` | 0 | 1 |  |
| 3 | `annulmentDecisionUser` (api) | `common:LoginType` | 0 | 1 |  |

**api:QueryTaxpayerRequestType** — A POST /queryTaxpayer REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `taxNumber` (api) | `common:TaxpayerIdType` | 1 | 1 |  |

**api:QueryTaxpayerResponseType** — A POST /queryTaxpayer REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `infoDate` (api) | `xs:dateTime` | 0 | 1 |  |
| 5 | `taxpayerValidity` (api) | `xs:boolean` | 0 | 1 |  |
| 6 | `taxpayerData` (api) | `api:TaxpayerDataType` | 0 | 1 |  |

**api:TaxpayerDataType** — Az adózó lekérdezés válasz adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxpayerName` (api) | `common:SimpleText512NotBlankType` | 1 | 1 |  |
| 2 | `taxpayerShortName` (api) | `common:SimpleText200NotBlankType` | 0 | 1 |  |
| 3 | `taxNumberDetail` (api) | `base:TaxNumberType` | 1 | 1 |  |
| 4 | `incorporation` (api) | `api:IncorporationType` | 1 | 1 |  |
| 5 | `vatGroupMembership` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 6 | `taxpayerAddressList` (api) | `api:TaxpayerAddressListType` | 0 | 1 |  |

**api:TaxpayerAddressListType** — Adózói cím lista típus

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxpayerAddressItem` (api) | `api:TaxpayerAddressItemType` | 1 | * |  |

**api:TaxpayerAddressItemType** — Adózói címsor adat

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxpayerAddressType` (api) | `api:TaxpayerAddressTypeType` | 1 | 1 |  |
| 2 | `taxpayerAddress` (api) | `base:DetailedAddressType` | 1 | 1 |  |

**api:QueryInvoiceDataRequestType** — A POST /queryInvoiceData REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `invoiceNumberQuery` (api) | `api:InvoiceNumberQueryType` | 1 | 1 |  |

**api:InvoiceNumberQueryType** — Számla lekérdezés számlaszám paramétere

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `invoiceDirection` (api) | `api:InvoiceDirectionType` | 1 | 1 |  |
| 3 | `batchIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 4 | `supplierTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |

**api:QueryInvoiceDataResponseType** — A POST /queryInvoiceData REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `invoiceDataResult` (api) | `api:InvoiceDataResultType` | 0 | 1 |  |

**api:InvoiceDataResultType** — Számlaszámra történő lekérdezés eredménye

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceData` (api) | `xs:base64Binary` | 1 | 1 |  |
| 2 | `auditData` (api) | `api:AuditDataType` | 1 | 1 |  |
| 3 | `compressedContentIndicator` (api) | `xs:boolean` | 1 | 1 |  |
| 4 | `electronicInvoiceHash` (api) | `common:CryptoType` | 0 | 1 |  |

**api:AuditDataType** — A számla audit adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `insdate` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 2 | `insCusUser` (api) | `common:LoginType` | 1 | 1 |  |
| 3 | `source` (api) | `api:SourceType` | 1 | 1 |  |
| 4 | `transactionId` (api) | `common:EntityIdType` | 0 | 1 |  |
| 5 | `index` (api) | `base:InvoiceIndexType` | 0 | 1 |  |
| 6 | `batchIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 7 | `originalRequestVersion` (api) | `api:OriginalRequestVersionType` | 1 | 1 |  |

**api:QueryInvoiceCheckResponseType** — A POST /queryInvoiceCheck REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `invoiceCheckResult` (api) | `xs:boolean` | 1 | 1 |  |

**api:QueryInvoiceDigestRequestType** — A POST /queryInvoiceDigest REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `page` (api) | `common:RequestPageType` | 1 | 1 |  |
| 5 | `invoiceDirection` (api) | `api:InvoiceDirectionType` | 1 | 1 |  |
| 6 | `invoiceQueryParams` (api) | `api:InvoiceQueryParamsType` | 1 | 1 |  |

**api:InvoiceQueryParamsType** — Számla lekérdezési paraméterek

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `mandatoryQueryParams` (api) | `api:MandatoryQueryParamsType` | 1 | 1 |  |
| 2 | `additionalQueryParams` (api) | `api:AdditionalQueryParamsType` | 0 | 1 |  |
| 3 | `relationalQueryParams` (api) | `api:RelationalQueryParamsType` | 0 | 1 |  |
| 4 | `transactionQueryParams` (api) | `api:TransactionQueryParamsType` | 0 | 1 |  |

**api:MandatoryQueryParamsType** — A számla lekérdezés kötelező paraméterei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceIssueDate` (api) | `api:DateIntervalParamType` | 1 | 1 | choice[1..1] |
| 2 | `insDate` (api) | `api:DateTimeIntervalParamType` | 1 | 1 | choice[1..1] |
| 3 | `originalInvoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 | choice[1..1] |

**api:DateIntervalParamType** — Dátumos számla kereső paraméter

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `dateFrom` (api) | `base:InvoiceDateType` | 1 | 1 |  |
| 2 | `dateTo` (api) | `base:InvoiceDateType` | 1 | 1 |  |

**api:DateTimeIntervalParamType** — Időpontos számla kereső paraméter

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `dateTimeFrom` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 2 | `dateTimeTo` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |

**api:AdditionalQueryParamsType** — A számla lekérdezés kiegészítő paraméterei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `taxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 2 | `groupMemberTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 3 | `name` (api) | `api:QueryNameType` | 0 | 1 |  |
| 4 | `invoiceCategory` (api) | `base:InvoiceCategoryType` | 0 | 1 |  |
| 5 | `paymentMethod` (api) | `base:PaymentMethodType` | 0 | 1 |  |
| 6 | `invoiceAppearance` (api) | `base:InvoiceAppearanceType` | 0 | 1 |  |
| 7 | `source` (api) | `api:SourceType` | 0 | 1 |  |
| 8 | `currency` (api) | `common:CurrencyType` | 0 | 1 |  |

**api:RelationalQueryParamsType** — A számla lekérdezés relációs paraméterei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceDelivery` (api) | `api:RelationQueryDateType` | 0 | 2 |  |
| 2 | `paymentDate` (api) | `api:RelationQueryDateType` | 0 | 2 |  |
| 3 | `invoiceNetAmount` (api) | `api:RelationQueryMonetaryType` | 0 | 2 |  |
| 4 | `invoiceNetAmountHUF` (api) | `api:RelationQueryMonetaryType` | 0 | 2 |  |
| 5 | `invoiceVatAmount` (api) | `api:RelationQueryMonetaryType` | 0 | 2 |  |
| 6 | `invoiceVatAmountHUF` (api) | `api:RelationQueryMonetaryType` | 0 | 2 |  |

**api:RelationQueryDateType** — Kereső paraméter dátum értékekhez

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `queryOperator` (api) | `api:QueryOperatorType` | 1 | 1 |  |
| 2 | `queryValue` (api) | `base:InvoiceDateType` | 1 | 1 |  |

**api:RelationQueryMonetaryType** — Kereső paraméter monetáris értékekhez

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `queryOperator` (api) | `api:QueryOperatorType` | 1 | 1 |  |
| 2 | `queryValue` (api) | `base:MonetaryType` | 1 | 1 |  |

**api:TransactionQueryParamsType** — A számla lekérdezés tranzakciós paraméterei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `transactionId` (api) | `common:EntityIdType` | 1 | 1 |  |
| 2 | `index` (api) | `base:InvoiceIndexType` | 0 | 1 |  |
| 3 | `invoiceOperation` (api) | `api:ManageInvoiceOperationType` | 0 | 1 |  |

**api:QueryInvoiceDigestResponseType** — A POST /queryInvoiceDigest REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `invoiceDigestResult` (api) | `api:InvoiceDigestResultType` | 1 | 1 |  |

**api:InvoiceDigestResultType** — Számla lekérdezési eredmények

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `currentPage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 2 | `availablePage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 3 | `invoiceDigest` (api) | `api:InvoiceDigestType` | 0 | * |  |

**api:InvoiceDigestType** — Kivonatos lekérdezési eredmény

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `batchIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 3 | `invoiceOperation` (api) | `api:ManageInvoiceOperationType` | 1 | 1 |  |
| 4 | `invoiceCategory` (api) | `base:InvoiceCategoryType` | 1 | 1 |  |
| 5 | `invoiceIssueDate` (api) | `base:InvoiceDateType` | 1 | 1 |  |
| 6 | `supplierTaxNumber` (api) | `common:TaxpayerIdType` | 1 | 1 |  |
| 7 | `supplierGroupMemberTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 8 | `supplierName` (api) | `common:SimpleText512NotBlankType` | 1 | 1 |  |
| 9 | `customerTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 10 | `customerGroupMemberTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 11 | `customerName` (api) | `common:SimpleText512NotBlankType` | 0 | 1 |  |
| 12 | `paymentMethod` (api) | `base:PaymentMethodType` | 0 | 1 |  |
| 13 | `paymentDate` (api) | `base:InvoiceDateType` | 0 | 1 |  |
| 14 | `invoiceAppearance` (api) | `base:InvoiceAppearanceType` | 0 | 1 |  |
| 15 | `source` (api) | `api:SourceType` | 0 | 1 |  |
| 16 | `invoiceDeliveryDate` (api) | `base:InvoiceDateType` | 0 | 1 |  |
| 17 | `currency` (api) | `common:CurrencyType` | 0 | 1 |  |
| 18 | `invoiceNetAmount` (api) | `base:MonetaryType` | 0 | 1 |  |
| 19 | `invoiceNetAmountHUF` (api) | `base:MonetaryType` | 0 | 1 |  |
| 20 | `invoiceVatAmount` (api) | `base:MonetaryType` | 0 | 1 |  |
| 21 | `invoiceVatAmountHUF` (api) | `base:MonetaryType` | 0 | 1 |  |
| 22 | `transactionId` (api) | `common:EntityIdType` | 0 | 1 |  |
| 23 | `index` (api) | `base:InvoiceIndexType` | 0 | 1 |  |
| 24 | `originalInvoiceNumber` (api) | `common:SimpleText50NotBlankType` | 0 | 1 |  |
| 25 | `modificationIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 26 | `insDate` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 27 | `completenessIndicator` (api) | `xs:boolean` | 0 | 1 |  |

**api:QueryInvoiceChainDigestRequestType** — A POST /queryInvoiceChainDigest REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `page` (api) | `common:RequestPageType` | 1 | 1 |  |
| 5 | `invoiceChainQuery` (api) | `api:InvoiceChainQueryType` | 1 | 1 |  |

**api:InvoiceChainQueryType** — Számlalánc kivonat lekérdezés számlaszám paramétere

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `invoiceDirection` (api) | `api:InvoiceDirectionType` | 1 | 1 |  |
| 3 | `taxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |

**api:QueryInvoiceChainDigestResponseType** — A POST /queryInvoiceChainDigest REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `invoiceChainDigestResult` (api) | `api:InvoiceChainDigestResultType` | 1 | 1 |  |

**api:InvoiceChainDigestResultType** — Számlalánc kivonat lekérdezés eredményei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `currentPage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 2 | `availablePage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 3 | `invoiceChainElement` (api) | `api:InvoiceChainElementType` | 0 | * |  |

**api:InvoiceChainElementType** — Számlalánc elem

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceChainDigest` (api) | `api:InvoiceChainDigestType` | 1 | 1 |  |
| 2 | `invoiceLines` (api) | `api:InvoiceLinesType` | 0 | 1 |  |
| 3 | `invoiceReferenceData` (api) | `api:InvoiceReferenceDataType` | 0 | 1 |  |

**api:InvoiceChainDigestType** — Számlalánc kivonat adatok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `invoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `batchIndex` (api) | `base:InvoiceUnboundedIndexType` | 0 | 1 |  |
| 3 | `invoiceOperation` (api) | `api:ManageInvoiceOperationType` | 1 | 1 |  |
| 4 | `supplierTaxNumber` (api) | `common:TaxpayerIdType` | 1 | 1 |  |
| 5 | `customerTaxNumber` (api) | `common:TaxpayerIdType` | 0 | 1 |  |
| 6 | `insDate` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 7 | `originalRequestVersion` (api) | `api:OriginalRequestVersionType` | 1 | 1 |  |

**api:InvoiceLinesType** — A számlán vagy módosító okiraton szereplő tételek kivonatos adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `maxLineNumber` (api) | `base:LineNumberType` | 1 | 1 |  |
| 2 | `newCreatedLines` (api) | `api:NewCreatedLinesType` | 0 | * |  |

**api:NewCreatedLinesType** — A módosító okirat által újként létrehozott számlasorok

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `lineNumberIntervalStart` (api) | `base:LineNumberType` | 1 | 1 |  |
| 2 | `lineNumberIntervalEnd` (api) | `base:LineNumberType` | 1 | 1 |  |

**api:InvoiceReferenceDataType** — A módosítás vagy érvénytelenítés adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `originalInvoiceNumber` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `modifyWithoutMaster` (api) | `xs:boolean` | 1 | 1 |  |
| 3 | `modificationTimestamp` (api) | `base:InvoiceTimestampType` | 1 | 1 | choice[1..1] |
| 4 | `modificationIndex` (api) | `base:InvoiceUnboundedIndexType` | 1 | 1 | choice[1..1] |

**api:QueryTransactionListRequestType** — A POST /queryTransactionList REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `page` (api) | `common:RequestPageType` | 1 | 1 |  |
| 5 | `insDate` (api) | `api:DateTimeIntervalParamType` | 1 | 1 |  |
| 6 | `requestStatus` (api) | `api:RequestStatusType` | 0 | 1 |  |

**api:QueryTransactionListResponseType** — A POST /queryTransactionList REST operáció válasz típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `result` (common) | `common:BasicResultType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `transactionListResult` (api) | `api:TransactionListResultType` | 1 | 1 |  |

**api:TransactionListResultType** — Tranzakció lekérdezési eredményei

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `currentPage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 2 | `availablePage` (api) | `common:ResponsePageType` | 1 | 1 |  |
| 3 | `transaction` (api) | `api:TransactionType` | 0 | * |  |

**api:TransactionType** — Tranzakció lekérdezési eredmény

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `insDate` (api) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 2 | `insCusUser` (api) | `common:LoginType` | 1 | 1 |  |
| 3 | `source` (api) | `api:SourceType` | 1 | 1 |  |
| 4 | `transactionId` (api) | `common:EntityIdType` | 1 | 1 |  |
| 5 | `requestStatus` (api) | `api:RequestStatusType` | 1 | 1 |  |
| 6 | `technicalAnnulment` (api) | `xs:boolean` | 1 | 1 |  |
| 7 | `originalRequestVersion` (api) | `api:OriginalRequestVersionType` | 1 | 1 |  |
| 8 | `itemCount` (api) | `base:InvoiceIndexType` | 1 | 1 |  |

**api:ManageAnnulmentRequestType** — A POST /manageAnnulment REST operáció kérés típusa

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `header` (common) | `common:BasicHeaderType` | 1 | 1 |  |
| 2 | `user` (common) | `common:UserHeaderType` | 1 | 1 |  |
| 3 | `software` (api) | `api:SoftwareType` | 1 | 1 |  |
| 4 | `exchangeToken` (api) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 5 | `annulmentOperations` (api) | `api:AnnulmentOperationListType` | 1 | 1 |  |

**api:AnnulmentOperationListType** — A kéréshez tartozó kötegelt technikai érvénytelenítések

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `annulmentOperation` (api) | `api:AnnulmentOperationType` | 1 | 100 |  |

**api:AnnulmentOperationType** — A kéréshez tartozó technikai érvénytelenítő művelet

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `index` (api) | `base:InvoiceIndexType` | 1 | 1 |  |
| 2 | `annulmentOperation` (api) | `api:ManageAnnulmentOperationType` | 1 | 1 |  |
| 3 | `invoiceAnnulment` (api) | `xs:base64Binary` | 1 | 1 |  |

**annul:InvoiceAnnulmentType** — Korábbi adatszolgáltatás technikai érvénytelenítésének adatai

| # | elem (névtér) | típus | min | max | megjegyzés |
|---|---|---|---|---|---|
| 1 | `annulmentReference` (annul) | `common:SimpleText50NotBlankType` | 1 | 1 |  |
| 2 | `annulmentTimestamp` (annul) | `base:InvoiceTimestampType` | 1 | 1 |  |
| 3 | `annulmentCode` (annul) | `annul:AnnulmentCodeType` | 1 | 1 |  |
| 4 | `annulmentReason` (annul) | `common:SimpleText1024NotBlankType` | 1 | 1 |  |

## Függelék C – Root elemek

| elem | névtér | típus/bázis |
|---|---|---|
| `GeneralErrorHeaderResponse` | common | `common:GeneralErrorHeaderResponseType` |
| `GeneralExceptionResponse` | common | `common:BasicResultType` |
| `InvoiceData` | data | `data:InvoiceDataType` |
| `GeneralErrorResponse` | api | `api:GeneralErrorResponseType` |
| `ManageAnnulmentRequest` | api | `api:ManageAnnulmentRequestType` |
| `ManageAnnulmentResponse` | api | `api:TransactionResponseType` |
| `ManageInvoiceRequest` | api | `api:ManageInvoiceRequestType` |
| `ManageInvoiceResponse` | api | `api:TransactionResponseType` |
| `QueryInvoiceChainDigestRequest` | api | `api:QueryInvoiceChainDigestRequestType` |
| `QueryInvoiceChainDigestResponse` | api | `api:QueryInvoiceChainDigestResponseType` |
| `QueryInvoiceCheckRequest` | api | `api:QueryInvoiceDataRequestType` |
| `QueryInvoiceCheckResponse` | api | `api:QueryInvoiceCheckResponseType` |
| `QueryInvoiceDataRequest` | api | `api:QueryInvoiceDataRequestType` |
| `QueryInvoiceDataResponse` | api | `api:QueryInvoiceDataResponseType` |
| `QueryInvoiceDigestRequest` | api | `api:QueryInvoiceDigestRequestType` |
| `QueryInvoiceDigestResponse` | api | `api:QueryInvoiceDigestResponseType` |
| `QueryTaxpayerRequest` | api | `api:QueryTaxpayerRequestType` |
| `QueryTaxpayerResponse` | api | `api:QueryTaxpayerResponseType` |
| `QueryTransactionListRequest` | api | `api:QueryTransactionListRequestType` |
| `QueryTransactionListResponse` | api | `api:QueryTransactionListResponseType` |
| `QueryTransactionStatusRequest` | api | `api:QueryTransactionStatusRequestType` |
| `QueryTransactionStatusResponse` | api | `api:QueryTransactionStatusResponseType` |
| `TokenExchangeRequest` | api | `api:BasicOnlineInvoiceRequestType` |
| `TokenExchangeResponse` | api | `api:TokenExchangeResponseType` |
| `InvoiceAnnulment` | annul | `annul:InvoiceAnnulmentType` |

---

## Verifikáció (2026-10-27)

Független, adverz ellenőrzés. **Módszer:** minden forrást újra letöltöttünk (nem a kutatás scratch-másolatait használtuk): XSD-k a GitHubról (`nav-gov-hu/Online-Invoice` `master` = `cc7a775…`, `nav-gov-hu/Common` `common-1.0.0` = `ab8d788…`) és a NAV `OSA Schemas_v3.zip`-ből; a 2026.08.11-i HU specifikáció PDF-je (373 oldal, SHA-256 `52c27343906dcc90…e823`) a NAV-ról, szövegkinyerés `pdftotext`/PyMuPDF; NAV CMS (Dokumentációk, hírlista) JSON; GitHub discussion #1180; élő TLS-kézfogás és hitelesítés nélküli próbák a **teszt** API-n. Validálás: xmllint-wasm 5.3.0 (libxml2 2.13.8) saját wrapper-sémával; az elemsorrendeket saját, `@xmldom/xmldom`-alapú XSD-modellel generáltuk és gépileg hasonlítottuk össze a dokumentummal; kriptográfia `node:crypto`-val. Szkriptek (a verifikátor ideiglenes munkamappájában, a tárolónak nem részei: `validate-doc.mjs`, `negatives.mjs`, `xsdmodel.mjs`, `simpletypes.mjs`, `roots.mjs`, `crypto-verify.mjs`, `tlscheck.mjs`, `probe-test.mjs`, `multischema.mjs`).

| # | Állítás (fejezet) | Verdikt | Bizonyíték |
|---|---|---|---|
| 1 | Végpontok: éles `https://api.onlineszamla.nav.gov.hu`, teszt `https://api-test.onlineszamla.nav.gov.hu`, context root `/invoiceService/v3`, a 10 operáció neve, mind POST; metrika `/metricService/v3/queryServiceMetrics/{metric,list,metric/{name}}` GET, hitelesítés nélkül (2.1–2.2) | ✅ megerősítve | Online-Invoice README; spec 6. fejezet (a teszt URL-lista mind a 10 operációval) és 8.1; élő GET a teszt `…/queryServiceMetrics/list`-re → HTTP 200 (megj.: `Accept` fejléc nélkül JSON-t ad vissza) |
| 2 | `requestVersion` csak `3.0`, `headerVersion` (opcionális) csak `1.0` – üzleti validáció, nincs XSD-enum; requestId nem használható újra sikeres és `INVALID_REQUEST_SIGNATURE`/`FORBIDDEN` kérés után; timestamp ±1 nap (3.2) | ✅ megerősítve | spec 1.3.1 1)–4) és 3.2 #24, #27, #28. Megj.: a spec az egyediséget „adózónként, a timestamp-tűrésen belül” írja elő – a dokumentum (időkorlát nélkül) szigorúbb, ami biztonságos |
| 3 | `BasicHeaderType`, `UserHeaderType` (`predecessorTaxNumber` a 4. helyen, `requestSignature` előtt), `CryptoType` (kötelező `cryptoType` attribútum), `SoftwareType` sorrend, típusok, facetek (3.2) | ✅ megerősítve | XSD-modell; negatív tesztek INVALID-ot adnak: kötőjeles / 31 karakteres requestId, `Z` nélküli, `+01:00`-s, 4 tizedes timestamp, 17 karakteres vagy kisbetűs softwareId, 5/16 karakteres login, `software` a `user` előtt, `predecessorTaxNumber` a `requestSignature` után; a `headerVersion` elhagyása és a tizedes nélküli timestamp VALID |
| 4 | Kérésrootok sorrendje: `ManageInvoiceRequest` (… `software` → `exchangeToken` → `invoiceOperations`), `QueryTaxpayerRequest` (→ `taxNumber`), `QueryTransactionStatusRequest` (→ `transactionId` → `returnOriginalRequest`), `TokenExchangeRequest` (csak boríték); `InvoiceOperationType`, `InvoiceOperationListType` [1..100] (5.x) | ✅ megerősítve | `invoiceApi.xsd` (a root elemek `complexContent/extension` bázisai is), saját modell |
| 5 | InvoiceData-típusok pontos sorrendje: `InvoiceDetailType` (17 elem), `LineType` (28), `LineAmountsNormalType`/`SimplifiedType`, `VatRateType` (8 choice-ág, kettő `fixed=true`), `SummaryByVatRateType`, `SummaryNormalType`, `SummaryType`, `CustomerInfoType`, `CustomerVatDataType`, `CustomerTaxNumberType`, `SupplierInfoType`, `AddressType`/`DetailedAddressType`/`SimpleAddressType`, `TaxNumberType` (7.2–7.3, Függ. A–C) | ✅ megerősítve | XSD-ből újragenerált 7.2-es fa **soronként azonos** (269 sor); Függelék A–B: 109 táblázat / 471 sor összevetve (név, névtér, típus, min/max, choice, fixed) → **0 eltérés**; Függelék C: mind a 25 root helyes (a 2 metrika-root nem szerepel, ez nem hiba) |
| 6 | 7.4 egyszerű típusok: bázis, facetek, enum-értékek (59 sor) | ✅ megerősítve | gépi összevetés az XSD-vel → 0 eltérés |
| 7 | A dokumentum minden példa-XML-je séma-valid: 10.1–10.3 InvoiceData, 11.1–11.4 kérések, 11.5 öt válasz (+ a 11.2 base64-ből dekódolt számla) (10.4) | ✅ megerősítve | `validate-doc.mjs`: 12/12 + 1 dekódolt VALID. Pozitív kontroll: a NAV 41 minta-XML-je (11 API + 30 Data) VALID. Negatív kontroll: sorrend-, névtér-, facet-, enum-, `fixed`- és choice-hibák INVALID; a csak üzleti hibák (PRIVATE_PERSON + név, záró szóköz a számlaszámban, `lineOperation=MODIFY`, `cryptoType="SHA2-512"`, `requestVersion=2.0`) séma-validok – ahogy a dokumentum írja |
| 8 | `requestSignature` algoritmus (4.2–4.4) és a spec 1.5.1 tesztvektora (`60BC8060…0C42`), a NAV 11 minta-kérése, a 11. fejezet 4 kérésének aláírása és index-hash-e (`52DB449B…EF91`, `022A9A06…5F7C`) | ✅ megerősítve | `crypto-verify.mjs`: **37/37 OK**; a 1.5.1 bemenő értékeit és várt hash-eit közvetlenül a 2026.08.11-i PDF 12–13. oldaláról vettük; a 11.2 base64-e bájtra a 10.1 XML-re dekódol |
| 9 | `passwordHash` = a jelszó nagybetűs SHA-512 hexája, `cryptoType="SHA-512"` (a régi `SHA2-512` nem elfogadott); `passwordHash("Example-Pass1")` = `F64FC795…59C2` (4.1) | ✅ megerősítve | spec 1.3.2 2) és 6); `CHANGELOG_3.0.md` („SHA2-512 helyett SHA-512”); újraszámolva |
| 10 | `electronicInvoiceHash`: a NAV `manageInvoice.xml` mintában a dekódolt számla-bájtok SHA3-512-je, nem a base64 szövegé; a spec szövege a „BASE64 enkódolt érték” hash-ét írja (4.5) | ✅ megerősítve | mindhárom minta-hash a dekódolt bájtokra egyezik, a base64 szövegre egyik sem; spec 3.3.2 (#28 környéke) szövege |
| 11 | Csere-token: AES-128-ECB, PKCS5/7 padding, kulcs = a cserekulcs UTF-8 bájtjai; érvényesség jelenleg 5 perc; adózóra szól (4.6) | ✅ megerősítve (a kulcsképzés: közepes) | spec 1.1, 1.8.x, 7.1 („AES ECB PKCS5PADDING”); a 11.5 szintetikus tokenje dekódolható; `nav-connector` forrása szintén a kulcs-stringet használja (nem hivatalos) |
| 12 | 2026.08.11 / 3.49: `FORBIDDEN` 500→403; `NOT_REGISTERED_CUSTOMER`, `INVALID_CUSTOMER`, `INVALID_USER_RELATION`, `INVALID_PREDECESSOR_TAX_NUMBER` 500→400; új HTTP 429 `TOO_MANY_REQUESTS` + `Retry-After`; `MAINTENANCE_MODE` 527 → kívül 503; `MULTIPLE_QUERY_RESULT_FOUND` = 500 (0., 1.5, 6.2) | ✅ megerősítve | spec 3.2 szinkron hibatábla (#6–#9, #15–#17, #29, #30) és 5.4 (3.49); NAV hír 2026-08-27 |
| 13 | Méret- és időkorlátok: POST body ≤ 10 MB, tömörítetlen ≤ 15 MB/számla, `gzip -1` (nagyobb tömörítés → sor vége); < 200 ms, blokkoló timeout 5000 ms, abszolút 60 s; lekérdezési intervallum ≤ 35 nap (840 óra) (2.3, 6.4) | ✅ megerősítve | spec 1.6.5, 1.6.6, 1.8.x |
| 14 | Régi forgalomkorlátozás (1 kérés/s/IP, +4000 ms, 60 s-os küszöb) csak a v1 végpontokra (6.4) | ✅ megerősítve | spec 1.6.11 |
| 15 | 2025-09-15 (teszt 09-01): 15 WARN→ERROR, 3 új WARN (435, 734, 1311), 3 inaktív (690, 700, 1301), 11400 INFO→WARN; STORNO kivétel; 11400 élesben 2025-10-07-től átmenetileg inaktív (1.5, 8.2) | ✅ megerősítve | NAV hír 2025-07-21 (https://nav.gov.hu/ado/egyeb/Modosulnak_az_Online_Szamla_rendszer_validacioi); spec 5.4 (3.40 kódlista); NAV hír 2025-10-07 |
| 16 | 2026-01-01 (3.44): 691→ERROR, új ERROR 79, új WARN 72 és 11401, 11400 átdolgozva, 5 és 61 módosult; a 60-as és a 11401 „tervezett” ERROR (1.5, 8.2) | ⚠️ javítva | a felsorolás helyes, de a **60-as a tesztkörnyezetben 2026-01-01 óta már ERROR** – javítva a 1.5 táblában és a 8.2-ben. https://github.com/nav-gov-hu/Online-Invoice/discussions/1180 |
| 17 | ERROR 78 árfolyamsávok (EUR 250–600 … BAM 100–360, 13 deviza) (8.7) | ✅ megerősítve | spec 3.3.2 #78 táblázata, mind a 13 sor egyezik |
| 18 | Elfogadott áfakulcsok: normál `0.05, 0.07, 0.12, 0.18, 0.27` (+ `0.2`/`0.25` korlátozva, `0` ≥ 2024-01-01), egyszerűsített `0.0476, 0.1525, 0.2126` (+ `0.1667`/`0.2` korlátozva), `vatAmountMismatch/vatRate` hat értéke; a 2020-as changelog `0.0426`-ot írt (8.3, 7.5) | ✅ megerősítve | spec 3.3.2 #14, #48, #49 és 2.x; `CHANGELOG_3.0.md` |
| 19 | `case`-értékkészletek: `vatExemption` {AAM, TAM, KBAET, KBAUK, EAM, NAM, UNKNOWN*}, `vatOutOfScope` {ATK, EUFAD37, EUFADE, EUE, HO, UNKNOWN*}, `vatAmountMismatch` {REFUNDABLE_VAT, NONREFUNDABLE_VAT, UNKNOWN*}; csak nagybetű (7.3) | ✅ megerősítve | spec 3.3.2 #31–#37 |
| 20 | STORNO-tartalom: ellentétes előjelű mennyiség, `lineNumberReference` a lánc sorszámozását folytatja, `lineOperation=CREATE`, összesítő ellentett; `MODIFY` sor tilos (`INVALID_LINE_OPERATION`, éles 2023-09-18, 3.21.5) (9.3, 10.3, 1.5) | ✅ megerősítve | spec 2.5.1 és 2.5.x; NAV hír 2023-08-16 (S11) és 2023-03-23 („3.21.5-ös verzió”); a spec 5.4 rövidítve „3.21”-et ír |
| 21 | Kiemelt ERROR-szabályok: #24 (PRIVATE_PERSON → nincs `customerVatData`/név/cím), #45 (DOMESTIC → `customerTaxNumber`), #54 (+5 év), #55 (+1 év), #74/#75 számozás, #76 (`modificationIndex` > 1000), #77 (HUF → 1); WARN 310/312/313 küszöbök (8.1, 8.4) | ✅ megerősítve | spec 3.3.2 hibatábla és I. melléklet |
| 22 | 1.3 SHA-256 táblázat „eredeti bájtok” | ⚠️ javítva | a 6 OSA-fájl hash-e a CRLF-re konvertált helyi másolaté volt; upstream (LF) hash-ek pótolva; a `vendor/` jelenleg CRLF-es. GitHub raw + git blob SHA-1 + NAV zip |
| 23 | Hivatalos zip = GitHub-készlet „CR/LF-től eltekintve” (0., 1.2) | ⚠️ javítva (pontosítás) | nyers bájtokban is azonos (7/7 fájl SHA-256 egyezik) |
| 24 | Repó-provenance: `master` = `cc7a775` (2026-02-13, „11400, 11401 WARN frissítés”), XSD-k utolsó módosítása `74c7052` (2020-12-01) ill. `f85c5cd` (2020-09-07); MIT licenc (2019 NAV); 11 + 30 minta; Common: RC3 `PageType` (inkompatibilis), RC4 = RC5 (blob `28e1941`), RC6 0 bájtos, `common-1.0.0` = RC4 + `predecessorTaxNumber` (2025-08-29, fejléc-komment „v1.0 RC4”), `common-2.0.0` (2026-09-02, NTCA/2.0, több fájl); GitHubon a legújabb HU spec a 2026.02.12-i (1.1–1.2) | ✅ megerősítve | `git ls-remote`, saját bare clone-ok, `git log`/`ls-tree`/`diff` |
| 25 | TLS: `*.onlineszamla.nav.gov.hu` (EC P-256, 2026-01-14 – 2027-02-14) ← e-Szigno OV TLS CA 2023 ← Microsec e-Szigno Root CA 2009; Node 24 alap CA-tárral elfogadva, TLS 1.2; csere 2026-02-12 (2.4) | ✅ megerősítve | élő TLS-kézfogás mindkét hosztra (`authorized=true`); NAV hír 2026-01-22; Dokumentációk oldal |
| 26 | Élő hibaválaszok a teszten: sémasértő body → 400 `GeneralExceptionResponse` (common default névtér, `SCHEMA_VIOLATION`), GET → 405 `NOT_ALLOWED_EXCEPTION`, `text/plain` → 415 `INVALID_REQUEST` (6.1) | ⚠️ javítva (apróság) | státuszok/kódok megerősítve; a példa `ns2` deklarációja (OSA api) nem egyezett a mai 400-as válasszal (eÁFA `EAR/2.0` + SSO) – javítva |
| 27 | Dokumentációk oldal: v3.0 az egyetlen támogatott verzió, spec „frissítve 2026.08.26”, OSA v3 sémák 2025.08.28, teszt-helpdesk `init.onlineszamla_teszt_support@nav.gov.hu`; API GW v0.4 (2026.08.06) egyelőre csak az eÁFA M2M-et szolgálja ki, ugyanazokra a common-típusokra és hitelesítési hibakódokra épül (1.1, 1.5, 2.1) | ✅ megerősítve | https://onlineszamla.nav.gov.hu/api/menu-items/link/dokumentaciok?lang=hu (`updatedAt` 2026-08-26T08:53:08Z); API GW PDF dokumentumtörténet és 1. fejezet |
| 28 | xmllint több `--schema` esetén csak az utolsót használja → wrapper-séma kell (1.4) | ✅ megerősítve | `multischema.mjs`: [teljes, csak-common] → INVALID („No matching global declaration”), [csak-common, teljes] → VALID; az OSA-sémák importja valóban `schemaLocation` nélküli, a `catalog.xml` URI-jai a repóban nem léteznek |
| 29 | A 3.49-es HTTP-kódváltozások pontos élesítési napja (13. #4) | ❓ nem ellenőrizhető | sem a hír, sem a spec nem közöl dátumot |
| 30 | `ABORTED` adatszolgáltatás után ugyanazzal a számlaszámmal újraküldhető (14.1 #10) | ❓ nem ellenőrizhető | a spec nem mondja ki explicit módon; tesztkörnyezetben ellenőrizendő |

**Összegzés:** 30 ellenőrzött állítás – 24 ✅ megerősítve, 4 ⚠️ javítva (ebből 2 implementációt érintő: a 1.3-as hash-táblázat, amelyre a 14.3/1. provenance-pont is épült, és a 60-as validáció tesztkörnyezeti ERROR-ja; 2 pontosítás: zip-azonosság, élő példa névterei), 2 ❓ nem ellenőrizhető. Az elemsorrendek, enumok, facetek, példák és kriptográfiai tesztvektorok hibátlanok voltak.

