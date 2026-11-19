# 06 – Magyar adatformátumok, validátorok, ÁFA-kód leképezés, mértékegységek, árfolyamok

> **Állapot:** 2026-10-27 · **Téma:** azonosítók és formátumok, amelyeket az OpenSzámla magjának (`src/core/validate.ts`,
> `src/core/vat.ts`, `src/core/units.ts`, `src/core/format.ts`, `src/core/numbering.ts`, `src/mnb/rates.ts`) ismernie kell.
> **Bizalmi szint:** **[magas]** = elsődleges forrás (jogszabály, NAV XSD/specifikáció, élő API-hívás) és saját futtatott teszt;
> **[közepes]** = elsődleges forrásból következtetett, vagy csak egy elsődleges + másodlagos forrás; **[alacsony]** = csak másodlagos forrás.
> A forrásokra `[F..]` azonosítóval hivatkozom; URL és állapot/lekérési dátum a **Források** fejezetben.
> A jogszabályszöveget (nem szerzői jogi mű) szó szerint idézem; NAV-/szállítói dokumentációt csak összefoglalok.
> Minden alább közölt TypeScript-kódot Node v24.19.0-n (beépített type stripping) ténylegesen lefuttattam – kimenet a 12. fejezetben.

---

## 0. Vezetői összefoglaló

1. **Adószám-CDV** – a törzsszám 8. jegye: `(10 − (9c1+7c2+3c3+c4+9c5+7c6+3c7) mod 10) mod 10`. Hat valós, nyilvános adószámon
   (NAV, MOL, OTP, OTP-áfacsoport, Magyar Telekom, Richter) igazoltam, köztük két „10 → 0" esettel. **[magas]**
2. **Megyekód** érvényes értékkészlete a NAV szerint `02–20, 22–44, 51`; **áfakód** `1–5` (4 = csoporttag saját adószáma,
   5 = csoportazonosító; 3 = volt EVA-alany – az eva 2020-01-01-jén megszűnt, a kód történeti). **[magas]** (Az 1 = adómentes,
   2 = általános jelentésre elsődleges NAV-táblát nem találtam: **[közepes]**.)
3. **Bankszámla-CDV** (35/2017. MNB rendelet 1. melléklet): 24 jegyű számnál a **9–23. jegyekre egyetlen** 9-7-3-1 ellenőrzés
   fut, a 16. jegy *szabadon képezhető*. A sok helyen látott „3 × 8 külön blokk" ellenőrzés **hibás** – a NAV saját
   `10032000-00009722-05020029` számláját elutasítaná. 123 NAV-számlaszámon és 125 IBAN-on teszteltem. **[magas]**
4. **Van 0%-os áfakulcs** (Áfa tv. 82. § (4), 3/B. melléklet): napilap 2024-01-01-től, vényköteles gyógyszer és magisztrális
   készítmény **2026-09-01-től**. `vatPercentage=0` csak erre (és csak ≥ 2024-01-01 teljesítésnél) – minden más „0 Ft áfás"
   eset `vatExemption`/`vatOutOfScope`/… ág. **[magas]**
5. **Kulcsok 2026-ban:** 27 / 18 / 5 / 0 %. 2026-os változások: darabolt marhahús, marha-belsőség 5 % (01-01; az egész/fél/negyed
   marhatest már korábban is 5 % volt), gyógyszer 0 % (09-01), tűzifa/pellet 5 %
   (09-15). Új lakás 5 %: a 3. melléklet 50–51. sora **2027-01-01-jén hatályát veszti**, átmenet **2030-12-31-ig** (Áfa tv. 371. §,
   2027-01-01-jén lép hatályba). AAM-értékhatár 2026: **20 M Ft**, 2027: **22 M Ft**, 2028: **24 M Ft**. **[magas]**
   > ⚠️ Javítva (verifikáció): a 2028-as AAM-értékhatár (24 M Ft) hiányzott; a „marhahús 5 % (01-01)” pontosítva (a 3. melléklet I.
   > 31–38. sora – szarvasmarhafélék egész/fél/negyed teste – 2025-ben is 5 % volt; a 2026-01-01-jén beiktatott 60. sor a darabolt
   > húst, vágási mellékterméket és belsőséget hozza 5 %-ra) – https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20280101 ;
   > https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20251122 ; https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20260101
6. **Készpénzes kerekítés** (2008. évi III. tv.): csak a *fizetendő végösszegre*, csak készpénznél (kártyánál az elfogadó
   dönthet, tájékoztatással). Ha a számla a kerekítetlen végösszeget tartalmazza, a NAV-ba is az megy (NAV GYIK II.36). **[magas]**
7. **MNB SOAP** (`arfolyamok.asmx`): 2026-10-27-én **csak `http://` POST működik, `https://` → 404**; tizedesvessző; JPY/IDR/KRW
   100 egységre; hétvégén/ünnepnapon (pl. 10-23) nincs jegyzés → az utolsó közzétett érvényes (Áfa tv. 80. § (2)). A NAV
   `exchangeRate` 1 egységre vonatkozik, max. 6 tizedes; EUR-nál 250–600 sávon kívül **ERROR**. **[magas]**
8. **VIES REST**: `POST /check-vat-number`; a hibák **HTTP 200-zal** is jöhetnek (`actionSucceed:false`). A teljes hibakód-listát
   a teszt-szolgáltatással feltérképeztem. **[magas]**
9. **Intl `hu-HU`** (Node 24.19 / ICU 78.3 / CLDR 48): csoportelválasztó **U+00A0**, tizedesvessző; **4 jegyű számot nem
   csoportosít** (AkH 274. pont is így); `currency: 'HUF'` alapból **0 tizedesre kerekít**; dátum `2026. 10. 27.` (AkH 295. pont). **[magas]**
10. **Sorszám**: NAV `invoiceNumber` 1–50 karakter, elején/végén nem lehet whitespace (ERROR 51), **adózónként egyedi**
    (ERROR `INVOICE_NUMBER_NOT_UNIQUE`) → éves újrakezdés csak évszámos előtaggal; a számlázóprogram számozása „kihagyás és
    ismétlés nélküli, folyamatos" (Számlarendelet 8. §). **[magas]**
11. **Mennyiségi egység**: 16 NAV-enum; m², g, év, alkalom, hét … → `OWN` + `unitOfMeasureOwn` (enélkül **ERROR 65**). **[magas]**
12. **Közterület jellege**: hivatalos lista a 322/2024. (XI. 6.) Korm. rendelet 5. mellékletében (70 érték; a korábbi
    345/2014. rendelet 2024-11-07-én hatályát vesztette). A NAV `publicPlaceCategory` szabad szöveg (≤ 50). **[magas]**

---

## 1. Adószám (`xxxxxxxx-y-zz`)

### 1.1 Szerkezet és leképezés a NAV `TaxNumberType`-ra

| Rész | Hossz | Jelentés | NAV elem (`invoiceBase.xsd` `TaxNumberType`) | XSD típus / minta |
|---|---|---|---|---|
| `xxxxxxxx` | 8 | törzsszám (7 jegy + 1 ellenőrző jegy); csoportnál a **csoportazonosító** törzsszáma | `base:taxpayerId` (kötelező) | `common:TaxpayerIdType`, `[0-9]{8}` |
| `y` | 1 | áfakód | `base:vatCode` (opcionális) | `common:VatCodeType`, `[1-5]{1}` |
| `zz` | 2 | illetékességi (megye)kód | `base:countyCode` (opcionális) | `common:CountyCodeType`, `[0-9]{2}` |

Forrás: [F1] `invoiceBase.xsd`, [F2] `common.xsd`. **[magas]**

* A vevő belföldi adószámából az Áfa tv. 169. § dc) pontja szerint **elég az első 8 jegy** (belföldi letelepedett eladó, belföldi
  B2B ügylet); **fordított adózásnál a teljes adószám kell** (169. § da)), és az adatszolgáltatásnak is ezt kell tartalmaznia [F3
  2.1.4.1], [F5]. **[magas]**
* A számlán a vevőnek csak egy azonosítója kerül a NAV-adatba (`customerTaxNumber` | `communityVatNumber` | `thirdStateTaxId`
  – XSD `choice`) [F1].

### 1.2 A törzsszám ellenőrző jegye (CDV)

Az első hét jegyet helyiérték szerint csökkenő sorrendben a `9, 7, 3, 1, 9, 7, 3` súlyokkal kell szorozni, a szorzatokat
összeadni, és az összeg egyes helyiértékét 10-ből kivonni; a különbség a 8. jegy [F11]. **[magas]**

```
c8 = (10 − (9·c1 + 7·c2 + 3·c3 + 1·c4 + 9·c5 + 7·c6 + 3·c7) mod 10) mod 10
⇔  Σ wᵢ·cᵢ ≡ 0 (mod 10),  w = 9,7,3,1,9,7,3,1   (ugyanaz az algoritmus, mint a bankszámla-CDV-nél)
```

A forrás nem mondja ki külön, mi a teendő, ha a különbség 10; a valós számok (MOL `10625790`, OTP-csoport `17780010`, mindkettő
összege 10-zel osztható) és az azonos algoritmusú MNB-rendelet („Ha a különbség „10", az ellenőrző szám értéke „0".") alapján: **0**.

### 1.3 Ellenőrzés valós, nyilvános adószámokon (lefuttatva: 2026-10-27)

| Adószám | Szervezet | Honnan | Σ(1–7. jegy súlyozva) | számított CDV | 8. jegy | Eredmény |
|---|---|---|---|---|---|---|
| `15789934-2-51` | Nemzeti Adó- és Vámhivatal | NAV szöveges beszámoló (nav.gov.hu) [F20] | 226 | 4 | 4 | ✅ |
| `10625790-4-44` | MOL Nyrt. | törzsszám: MOL 2021-es éves jelentés statisztikai számjele `10625790-1920-114-01` [F20]; teljes szám: cégadatbázis **[közepes]** | 150 | 0 | 0 | ✅ (10 → 0 eset) |
| `10537914-4-44` | OTP Bank Nyrt. | otpbank.hu impresszum [F20] | 156 | 4 | 4 | ✅ |
| `17780010-5-44` | OTP áfacsoport (csoportazonosító) | otpbank.hu impresszum [F20] | 90 | 0 | 0 | ✅ (10 → 0 eset) |
| `10773381-2-44` | Magyar Telekom Nyrt. | telekom.hu impresszum [F20] | 109 | 1 | 1 | ✅ |
| `10484878-2-44` | Richter Gedeon Nyrt. | Richter 2008-as éves jelentés (gedeonrichter.com) [F20] | 142 | 8 | 8 | ✅ |

Negatív esetek (mind elutasítva a 12. fejezet tesztjében): `10773382-2-44` (CDV), `15789934-6-51` és `…-0-…` (áfakód),
`15789934-2-21`, `…-01`, `…-45` (megyekód), `1578993-2-51`, `15789934-2-5` (formátum).
VIES-szel is visszaellenőrizve: `HU10773381` → valid (Magyar Telekom), `HU17780010` → valid („Áfa csoport / VAT Group") [F15].

### 1.4 Az áfakód (9. jegy) jelentése 2026-ban

| Kód | Jelentés | Bizalom / forrás |
|---|---|---|
| `1` | adómentes adóalany (alanyi adómentes, ill. csak tárgyi adómentes tevékenységet végző) – áfát nem számít fel | **[közepes]** – NAV-elsődleges táblát nem találtam; a NAV-spec. egy WARN-ja a „vevő áfakódja = 1" esetet külön kezeli [F3]; jelentés: Wikipédia (archivált NAV-oldalakra hivatkozva) |
| `2` | általános szabályok szerint áfakörös | **[közepes]** (mint fent) |
| `3` | egyszerűsített vállalkozói adó (eva) alanya volt – az eva-törvényt a 2019. évi LXXIII. tv. 36. §-a **2020-01-01-jével** hatályon kívül helyezte → csak régi adószámokon | **[magas]** a megszűnésre (njt) |
| `4` | áfacsoport **tagjának saját** adószáma | **[magas]** [F3 2.1.4] |
| `5` | áfacsoport **csoportazonosító** száma | **[magas]** [F3 2.1.4] |

> ❓ Nem ellenőrizhető: az `1` (adómentes) és a `2` (általános) jelentésére a verifikáció során sem találtam elsődleges NAV-táblát
> (a NAV 2023-09-07-i közleménye csak a `4`/`5` jelentését és a `177`-es előtagot rögzíti). A kódokat csak címkeként használjuk.

NAV-értékkészletek (WARN-ok) [F3]: eladó `supplierTaxNumber/vatCode ∈ {1,2,3,5}` („eladó áfakódja nem lehet 4-es");
pénzügyi képviselő `∈ {1,2,4}`; termékdíj-kötelezett `∈ {1,2,3,5}`. **Ne** vezessünk le adózási státuszt a 9. jegyből
(az alanyi mentesség év közben is változhat) – az élő státuszt a NAV `queryTaxpayer` adja (nem kötelező hívni, de a NAV
javasolja: GYIK II.22 [F4]).

### 1.5 Megyekód (illetékességi kód)

NAV interfészspecifikáció 4.1 „Törzsek" [F3] **[magas]**:

| Megye | Társas vállalkozás | Egyéni vállalkozás |
|---|---|---|
| Baranya | 02 | 22 |
| Bács-Kiskun | 03 | 23 |
| Békés | 04 | 24 |
| Borsod-Abaúj-Zemplén | 05 | 25 |
| Csongrád(-Csanád) | 06 | 26 |
| Fejér | 07 | 27 |
| Győr-Moson-Sopron | 08 | 28 |
| Hajdú-Bihar | 09 | 29 |
| Heves | 10 | 30 |
| Komárom-Esztergom | 11 | 31 |
| Nógrád | 12 | 32 |
| Pest | 13 | 33 |
| Somogy | 14 | 34 |
| Szabolcs-Szatmár-Bereg | 15 | 35 |
| Jász-Nagykun-Szolnok | 16 | 36 |
| Tolna | 17 | 37 |
| Vas | 18 | 38 |
| Veszprém | 19 | 39 |
| Zala | 20 | 40 |
| **Észak-Budapest** | 41 | 41 |
| **Kelet-Budapest** | 42 | 42 |
| **Dél-Budapest** | 43 | 43 |
| **Pest Megyei és Fővárosi Kiemelt Adózók Igazgatósága** | 44 | 44 |
| **Kizárólagos illetékességű adóalanyok** (pl. maga a NAV: `…-2-51`; külföldi, áfa-regisztrált) | 51 | 51 |

* Érvényes halmaz a NAV WARN-jai szerint (`INCORRECT_COUNTY_CODE_SUPPLIER/…_GROUPMEMBER/…_CUSTOMER`): **02–20; 22–44; 51**.
  `01`, `21`, `45–50`, `52+` érvénytelen.
* A pénzügyi képviselő adatai csak akkor tölthetők, ha az eladó megyekódja `51` (WARN `INCORRECT_HEAD_DATA_FISCALREPRESENTATIVE`).
* A megyekód **nem cím**: székhelyváltozáskor sem feltétlenül változik – címet ebből ne képezzünk.

### 1.6 Csoportos áfaalanyiság

* **Eladó** csoporttag: `supplierTaxNumber` = **csoportazonosító** (áfakód 5), `groupMemberTaxNumber` = a tag **saját** adószáma
  (áfakód 4) [F3 2.1.4]. Ha a tag saját törzsszámát adjuk meg eladóként: WARN `INCORRECT_HEAD_DATA_SUPPLIER_GROUPMEMBER_TAXPAYERID`.
* **Vevő** csoporttag: `customerTaxNumber` = csoportazonosító; `groupMemberTaxNumber` = tag adószáma, ha a számlán szerepel.
  A 169. § dc) szerint a számlán a *csoportazonosító* első 8 jegye a kötelező.
* **Közösségi adószám** csoporttagnál: `HU` + a **csoport** törzsszáma (OTP: `HU17780010`; a VIES név: „Áfa csoport / VAT Group",
  és a NAV csoportos áfaalany-listájára mutat) [F15], [F20]. **[magas]**
* A csoportazonosítók `177`-tel kezdődnek, 9. jegyük `5` (NAV-közlemény, 2023-09-07; erre épít a NAV
  `INCORRECT_HEAD_DATA_CUSTOMER_GROUPMEMBER_TAXNUMBER` WARN – I. melléklet 82. – is, amely a spec. szerint hamarosan ERROR-rá válik;
  az OTP `17780010` és a MÁV `17784447` megfelel). **[magas]** – `groupMemberTaxNumber`-ben `177`-tel kezdődő törzsszám →
  validációs hiba; `177`-es törzsszám és ≠ 5 áfakód együtt → figyelmeztetés.
  > ⚠️ Javítva (verifikáció): korábban „[közepes] – csak heurisztika, ne blokkoljunk rá”; elsődleges NAV-forrás szerint a
  > csoportazonosító első három karaktere mindig 177, a WARN 82 pedig a spec. szerint ERROR lesz –
  > https://nav.gov.hu/igazgatosagok/igazgatosagok/Komarom_Esztergom_megye/helyi_hirek/segitseg-csoportos-afaalanytol-vasaroltam ;
  > https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu (spec. 2026.02.12, I. melléklet, 82. WARN)
* A csoport tagjai a belső (nem számla) bizonylatokat és a külső számlákat azonos sorszámtartományban is kibocsáthatják
  (Számlarendelet 8. § (3)) [F9].

---

## 2. Közösségi adószám, uniós áfaszámok, VIES

### 2.1 Magyar közösségi adószám

* Formátum: `HU` + **8 jegyű törzsszám** (csoporttagnál a csoportazonosító törzsszáma). Az ellenőrző jegy ugyanaz, mint 1.2-ben.
* NAV WARN `INCORRECT_HEAD_DATA_SUPPLIER_COMMUNITY_VAT_NUMBER`: ha az eladó törzsszáma ≠ közösségi adószámának utolsó 8 karaktere [F3].
* NAV XSD `CommunityVatNumberType`: `[A-Z]{2}[0-9A-Z]{2,13}`, hossz 4–15 [F2] → szóköz, pont, kötőjel tilos; a VIES-ben
  megengedett `+` és `*` (ír/holland formátum „S" karaktere) a NAV-mintába **nem fér bele** (szélső eset).

### 2.2 Tagállami formátumok (VIES GYIK táblázat, lekérve 2026-10-27) [F15] **[magas]**

Jelmagyarázat a VIES szerint: `9` = számjegy, `X` = betű vagy számjegy, `S` = betű, számjegy, `+` vagy `*`, `L` = betű.
A regexek a táblázatból általam képzett **formátum**ellenőrzések (prefixszel együtt, normalizálás után: nagybetű, szóköz/pont/kötőjel nélkül).

| Prefix | VIES formátum | Regex (prefix nélkül) | Megjegyzés |
|---|---|---|---|
| AT | `ATU99999999` | `U\d{8}` | |
| BE | `BE0999999999`, `BE1999999999` | `[01]\d{9}` | |
| BG | 9 vagy 10 jegy | `\d{9,10}` | |
| CY | `CY99999999L` | `\d{8}[A-Z]` | |
| CZ | 8, 9 vagy 10 jegy | `\d{8,10}` | |
| DE | 9 jegy | `\d{9}` | |
| DK | `DK99 99 99 99` | `\d{8}` | szóközök nélkül tároljuk |
| EE | 9 jegy | `\d{9}` | |
| **EL** | 9 jegy | `\d{9}` | **Görögország = `EL`** (nem GR!) |
| ES | `ESX9999999X` | `[0-9A-Z]\d{7}[0-9A-Z]`, nem lehet mindkét szélső jegy szám | |
| FI | 8 jegy | `\d{8}` | |
| FR | `FRXX 999999999` | `[0-9A-Z]{2}\d{9}` | |
| HR | 11 jegy | `\d{11}` | |
| HU | 8 jegy | `\d{8}` + CDV | |
| IE | `IE9S99999L`, `IE9999999LL` | `\d[0-9A-Z+*]\d{5}[A-Z]` vagy `\d{7}[A-Z]{2}` | |
| IT | 11 jegy | `\d{11}` | |
| LT | 9 vagy 12 jegy | `\d{9}` vagy `\d{12}` | |
| LU | 8 jegy | `\d{8}` | |
| LV | 11 jegy | `\d{11}` | |
| MT | 8 jegy | `\d{8}` | |
| NL | `NLSSSSSSSSSSSS` | `[0-9A-Z+*]{12}` | gyakorlatban `\d{9}B\d{2}` |
| PL | 10 jegy | `\d{10}` | |
| PT | 9 jegy | `\d{9}` | |
| RO | 2–10 jegy | `\d{2,10}` | |
| SE | 12 jegy | `\d{12}` | |
| SI | 8 jegy | `\d{8}` | |
| SK | 10 jegy | `\d{10}` | |
| **XI** | `XI999 9999 99[ 999]`, `XIGD999`, `XIHA999` | `\d{9}`, `\d{12}`, `GD\d{3}`, `HA\d{3}` | Észak-Írország (áruk); a `GB` prefix a VIES-ben **nincs** |

Fontos különbségek: **címben** az ISO 3166-1 kódot használjuk (`GR`, `GB`), **áfaszámban** a VIES-prefixet (`EL`, `XI`).
A NAV vevő-közösségi-adószám WARN-jának prefixlistája (spec. 2026.02.12) tartalmazza a `GB`-t, de **nem** az `XI`-t, és
CDV-t is vizsgál [F3] – `XI` vevőnél WARN várható. (A 3.0 változásnapló szerint ezt a WARN-t törölték, a WARN-katalógus
mégis felsorolja – ellentmondás, **[közepes]**.) Tagállami ellenőrzőjegy-algoritmusokat itt nem implementáltam; erre
(ha kell) a `stdnum` (1.12.6, MIT) vagy `jsvat` (2.5.4, MIT) npm-csomag értékelhető (`npm view`, 2026-10-27) – nem teszteltem.

### 2.3 VIES REST API (élő teszt: 2026-10-27) [F15] **[magas]**

| Művelet | Végpont | Megjegyzés |
|---|---|---|
| Ellenőrzés | `POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number` | a nyilvános swaggerben dokumentált |
| Tagállamok állapota | `GET …/rest-api/check-status` | `vow.available`, `countries[].availability` ∈ `Available`/`Unavailable`/`Monitoring Disabled`; élőben 27 tagállam + `XI` |
| Tesztszolgáltatás | `POST …/rest-api/check-vat-test-service` | ugyanaz a séma, fix válaszok (lent) |
| (nem dokumentált) | `GET …/rest-api/ms/{cc}/vat/{number}` | a webes felület használja; más válaszséma (`isValid`, `userError`, `viesApproximate`) – **ne erre építsünk** |
| Régi SOAP | WSDL: `https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl` (`checkVat`, `checkVatApprox`) | `vatNumber` minta: `[0-9A-Za-z\+\*\.]{2,12}` |

Kérés (JSON): `countryCode`, `vatNumber`, opcionálisan `requesterMemberStateCode`, `requesterNumber` (ezek megadásakor kap
`requestIdentifier`-t, azaz konzultációs számot – ezt **nem teszteltem**, mert valós saját áfaszám kellene hozzá),
valamint `traderName`, `traderStreet`, `traderPostalCode`, `traderCity`, `traderCompanyType` (közelítő egyezés).

Válasz (élő, `HU` / `17780010`):

```json
{
  "countryCode" : "HU", "vatNumber" : "17780010", "requestDate" : "2026-10-27T13:25:38.425Z",
  "valid" : true, "requestIdentifier" : "",
  "name" : "Áfa csoport / VAT Group (Az áfa csoport tagjai lekérdezhetőek: / Members of the VAT group can be checked on: https://nav.gov.hu/adatbazisok/adatbleker/csoportos_afaalanyok)",
  "address" : "NÁDOR U 16. 1051 BUDAPEST",
  "traderName" : "---", "traderStreet" : "---", "traderPostalCode" : "---", "traderCity" : "---", "traderCompanyType" : "---",
  "traderNameMatch" : "NOT_PROCESSED", "traderStreetMatch" : "NOT_PROCESSED", "traderPostalCodeMatch" : "NOT_PROCESSED",
  "traderCityMatch" : "NOT_PROCESSED", "traderCompanyTypeMatch" : "NOT_PROCESSED"
}
```

* Érvénytelen szám (`HU12345676`, formailag jó, CDV is jó): HTTP 200, `"valid": false`, `name`/`address` `"---"` vagy üres.
* Hibás bemenet (`XX`/`123`): **HTTP 200** és `{"actionSucceed": false, "errorWrappers": [{"error": "INVALID_INPUT"}]}` – a
  klienst a **válasz törzse** alapján kell ágaztatni, nem a státuszkód alapján (a swagger 400/500-at is ír).
* A tesztszolgáltatás leképezése (élőben feltérképezve; a `vatNumber` értéke határozza meg a választ):
  `100` → valid, `200` → invalid, `201` INVALID_INPUT, `202` INVALID_REQUESTER_INFO, `300` SERVICE_UNAVAILABLE,
  `301` MS_UNAVAILABLE, `302` TIMEOUT, `400` VAT_BLOCKED, `401` IP_BLOCKED, `500` GLOBAL_MAX_CONCURRENT_REQ,
  `501` GLOBAL_MAX_CONCURRENT_REQ_TIME, `600` MS_MAX_CONCURRENT_REQ, `601` MS_MAX_CONCURRENT_REQ_TIME.
* `MS_UNAVAILABLE`, `TIMEOUT`, `*_MAX_CONCURRENT_REQ*`, `SERVICE_UNAVAILABLE` ⇒ **„ismeretlen"**, nem „érvénytelen" – később újrapróbálni.
* Felhasználási feltétel (WSDL-dokumentáció): az adatok csak a jogszerű ellenőrzéshez (pl. saját számla kiállításához)
  használhatók, továbbadásuk tilos → az eredményt (dátum, név, cím, konzultációs szám) **bizonyítékként tároljuk**, de ne
  publikáljuk.

---

## 3. Adóazonosító jel (magánszemély, 10 jegy) – röviden

1996. évi XX. törvény 1. számú melléklete (njt, 2026.10.01. állapot) [F6] **[magas]**:

> 1. Az adóazonosító jel tízjegyű szám.
> 2. Az adóazonosító számot az alábbiak szerint kell képezni: a) az 1. számjegy konstans 8-as szám, mely az adóalany
> magánszemély voltára utal, b) a 2–6. számjegyek a személy születési időpontja és az 1867. január 1. között eltelt napok
> száma, c) a 7–9. számjegyek az azonos napon születettek megkülönböztetésére szolgáló véletlenszerűen képzett sorszám,
> d) a 10. számjegy az 1–9 számjegyek felhasználásával matematikai módszerekkel képzett ellenőrző szám.
> 3. Az adóazonosító jel 10. számjegyét úgy kell képezni, hogy a 2. a)–c) pontok szerint képzett 9 számjegy mindegyikét
> szorozni kell azzal a sorszámmal, ahányadik helyet foglalja el az azonosítón belül. (Első számjegy szorozva eggyel, második
> számjegy szorozva kettővel és így tovább.) Az így kapott szorzatok összegét el kell osztani 11-gyel, és az osztás maradéka a
> 10. számjeggyel lesz egyenlő. A 2. c) pont szerinti születési sorszám nem adható ki, ha a 11-gyel való osztás maradéka egyenlő tízzel.

* Képlet: `d10 = (Σ_{i=1..9} i·dᵢ) mod 11`, a 10-es maradék nem fordulhat elő. Születési dátum = 1867-01-01 + `d2..d6` nap.
* A NAV `invoiceData` v3.0 **nem** használja (az NTCA `TaxIdentificationNumberType` létezik: `xs:integer`, 10 jegy) [F1][F2].
* **Személyes adat** (a születési dátum visszafejthető): csak akkor tároljuk, ha üzleti ok van rá; logba, MCP-válaszba ne kerüljön.
* Teszt csak **szintetikus** azonosítókkal (pl. `8123456786` → 1900-10-20; `8414091237` → 1980-05-17).

---

## 4. Bankszámlaszám

### 4.1 Belföldi pénzforgalmi jelzőszám (GIRO, 2×8 / 3×8 jegy)

35/2017. (XII. 14.) MNB rendelet (njt, 2026.01.31. állapot) 3. § (3): a belföldi forint fizetési forgalomban a pénzforgalmi
jelzőszám **16 (2×8) vagy 24 (3×8)** numerikus karakter [F8]. Az 1. melléklet 1. pontja **[magas]**:

> a) az első nyolc karakter az irányító kód; az irányító kód első három számjegye a pénzforgalmi szolgáltató azonosító kódja,
> amely a számlavezető pénzforgalmi szolgáltatót, a következő négy számjegy a pénzforgalmi szolgáltató fiókját jelöli, a
> nyolcadik számjegy ellenőrző szám;
> b) a 9–16. karakter vagy a 9–24. karakter a fizetési számla azonosító száma; 16 karakter hosszúságú számsor esetében a 16.
> számjegy, 24 karakter hosszúságú számsor esetében a 24. számjegy ellenőrző szám, és a 24 karakter hosszúságú pénzforgalmi
> jelzőszám 16. számjegye értelemszerűen szabadon kialakítható;
> c) az ellenőrző számok az előttük álló számjegyek ellenőrzésére szolgálnak, melyeket a következő algoritmus szerint kell
> képezni: külön az 1–7., valamint külön a 9–15. vagy 9–23. számjegyeket helyi értékük csökkenő sorrendjében meg kell szorozni a
> „9, 7, 3, 1 ... 9, 7, 3, 1" számokkal, a szorzatokat össze kell adni, és az eredmény egyes helyi értékén lévő számot ki kell
> vonni 10-ből. A különbség az ellenőrző szám. (Ha a különbség „10", az ellenőrző szám értéke „0".)

**Következmény:** 24 jegyű számnál nem három külön blokkot kell ellenőrizni, hanem `1–8` és `9–24` két blokkot (a 9–23.
jegyre ismétlődő 9-7-3-1 súlyokkal). A NAV hivatalos listáján szereplő `10032000-00009722-05020029` ezt bizonyítja: a rendelet
szerint érvényes, a „3 × 8 külön blokk" szerint (9–16. jegyre: számított 4 ≠ 2) **érvénytelen** lenne (lásd 12. fejezet).

### 4.2 IBAN (HU)

Az 1. melléklet 2. pontja [F8] **[magas]**: `HU` + 2 jegyű ellenőrzőszám (ECBS/ISO 13616 IBAN-szabvány: mod 97) + 24 jegyű
belföldi jelzőszám; **16 jegyű számnál az utolsó 8 karaktert nullával kell feltölteni**. Teljes hossz **28**.

* Ellenőrzés: a 4 első karaktert a végére tesszük, betű → szám (A=10 … Z=35), a szám mod 97 = 1.
* A `HU` IBAN BBAN-jára **a 4.1-es CDV-t is** futtassuk (az IBAN mod 97 nem fogja meg az összes GIRO-hibát).
* Nyomtatási forma: 4-es csoportok szóközzel (`HU57 1003 2000 0107 6019 0000 0000`); XML-ben szóköz nélkül.
* Széles körben használt példa: `HU42 1177 3016 1111 1018 0000 0000` (pl. Wise; a SWIFT IBAN Registry HU-példájaként ismert –
  a Registry-t nem ellenőriztem, **[közepes]**) – a teszt szerint mod 97 és GIRO-CDV is rendben.
  > ❓ Nem ellenőrizhető: a SWIFT IBAN Registry HU-bejegyzését a verifikáció során sem értem el; a mod 97 = 1 és a BBAN-CDV
  > saját futtatással megerősítve (implementációs szempontból ez a lényeges).

### 4.3 NAV `BankAccountNumberType` [F2] **[magas]**

```
minLength 15, maxLength 34
[0-9]{8}[-][0-9]{8}[-][0-9]{8} | [0-9]{8}[-][0-9]{8} | [A-Z]{2}[0-9]{2}[0-9A-Za-z]{11,30}
```

* GIRO-formát **kötőjellel** kell küldeni (`1003200001076019` nem felel meg a mintának!); IBAN-t **szóköz nélkül**.
* A NAV specifikáció szövege szerint az IBAN-ág „11–30 számjegyű" jelzőszámot ír, a minta valójában alfanumerikus BBAN-t enged [F3 2.3.1].
* Használat: `supplierBankAccountNumber`, `customerBankAccountNumber`, `fiscalRepresentativeBankAccountNumber` [F1].

### 4.4 Tesztadat: a NAV hivatalos adóztatási számlái (2026-07-01-től érvényes lista) [F14]

A NAV PDF-listájából kinyert **123 számlaszám (108 × 16 jegy, 15 × 24 jegy) és 125 IBAN mind érvényes** a referencia-
implementáció szerint, és minden számlaszám IBAN-ja szerepel a NAV által közölt IBAN-ok között. Példák:

| Adónem | Belföldi | IBAN |
|---|---|---|
| 101 Társasági adó | `10032000-01076019` | `HU57100320000107601900000000` |
| 103 SZJA | `10032000-06056353` | `HU16100320000605635300000000` |
| 104 Általános forgalmi adó | `10032000-01076868` | `HU68100320000107686800000000` |
| 258 Szociális hozzájárulási adó | `10032000-06055912` | `HU12100320000605591200000000` |
| 24 jegyű példa | `10032000-00009722-05020029` | (a NAV PDF-ben) |

Negatív esetek: `10032001-01076019` (CDV1), `10032000-01076018` (CDV2), `HU58…` (mod 97), `GB82WEST12345698765433` (mod 97).

---

## 5. Címek

### 5.1 Irányítószám

* **Formátum:** pontosan 4 számjegy, az első 1–9. **[magas]** A Magyar Posta hivatalos jegyzéke (`Iranyitoszam-Internet_uj.xlsx`,
  Last-Modified 2026-10-12; a NAV specifikáció 4.3 pontja is erre mutat) [F18], [F3]:
  * „Települések" lap: **2801** különböző kód, tartomány **2000–9985**, első jegy 2–9 (1-gyel csak Budapest kezdődik, 0-val semmi).
  * 332 kód több településhez tartozik (pl. `2066` Szár/Újbarok), 113 településnek több kódja van (pl. Nyíregyháza 8) →
    **irányítószámból ne töltsük ki automatikusan a települést** választás nélkül.
  * „Bp.u." lap (budapesti utcajegyzék): kódok **1007–1239**; 9701 sorból **9696-nál a 2–3. jegy = kerület** (1011 = I., 1239 = XXIII.);
    az eltérés csak az `1007` (Margitsziget, közigazgatásilag XIII. ker.).
    > ⚠️ Javítva (verifikáció): 9695 helyett 9696 (az eltérő 5 sor mind `1007`; 9696 + 5 = 9701) – saját újraszámolás az
    > IRSZ és KER oszlopból: https://www.posta.hu/static/internet/download/Iranyitoszam-Internet_uj.xlsx (Last-Modified 2026-10-12)
  * Budapesti **postafiók/nagyfelhasználói** kódok is léteznek az 1007–1239 tartományon kívül (pl. NAV: `1438 Budapest, Pf. 512`,
    `1397 Budapest, Pf. 535`; az AkH is „Budapest 1810"-et hoz példának) → `1000–1999` között **ne utasítsunk el**, csak a kerületet
    ne képezzük. **[magas]**
* NAV `PostalCodeType`: `[A-Z0-9][A-Z0-9\s\-]{1,8}[A-Z0-9]`, 3–10 karakter; ha az országban nem értelmezhető: **`0000`** [F2][F3 2.1.3.1].
  Külföldi kódot nagybetűsíteni, a mintának meg nem felelőt „sémára érvényessé konvertálni" (NAV javaslat).

### 5.2 Országkód

`CountryCodeType`: ISO 3166-1 alpha-2, `[A-Z]{2}` [F2]. Görögország a címben `GR`, áfaszámban `EL`; Észak-Írország a címben `GB`,
áfaszámban `XI`. A `region` (opcionális, ≤ 50) ISO 3166-2 tartománykód, ha az adott országban értelmezhető [F1].

### 5.3 `simpleAddress` vs `detailedAddress` (NAV `AddressType` = `choice`) [F1][F3 2.1.3] **[magas]**

| Elem | `simpleAddress` | `detailedAddress` | XSD típus |
|---|---|---|---|
| `countryCode` | kötelező | kötelező | `CountryCodeType` |
| `region` | opc. | opc. | `SimpleText50NotBlankType` |
| `postalCode` | kötelező | kötelező | `PostalCodeType` |
| `city` | kötelező | kötelező | `SimpleText255NotBlankType` |
| `additionalAddressDetail` | **kötelező** (közterület neve+jellege, házszám, emelet, ajtó, hrsz. …) | – | `SimpleText255NotBlankType` |
| `streetName` | – | **kötelező** | `SimpleText255NotBlankType` |
| `publicPlaceCategory` | – | **kötelező** | `SimpleText50NotBlankType` |
| `number`, `building`, `staircase`, `floor`, `door`, `lotNumber` | – | opc. | `SimpleText50NotBlankType` |

* A NAV szerint a számlán szereplő címet a megfelelő címtípus szerinti bontásban kell közölni; **egyszerű cím** akkor
  is megengedett, ha a részletes bontás nem valósítható meg (pl. ország, ahol nincs utca/házszám; szétválaszthatatlan
  „Beispielstrasse"; vagy aránytalan erőforrásigényű régi vevőtörzs) [F3].
* **Magánszemély vevő** (`customerVatStatus = PRIVATE_PERSON`): a NAV-adatban **semmilyen** vevői név/cím nem szerepelhet
  (különben elutasítás) – a számlaképen viszont kötelező (169. § e)) [F3 2.1.4.1].
* Gyakorlat: magyar címnél, ha van közterületnév **és** jelleg → `detailedAddress`; csak helyrajzi számos/tanyás/külföldi
  szabad szöveges cím → `simpleAddress` (`additionalAddressDetail`, pl. „Hrsz. 0123/4").

### 5.4 Közterület jellege

* **Hivatalos lista:** 322/2024. (XI. 6.) Korm. rendelet 5. melléklet „Központi címregiszterben rögzíthető közterületjellegek"
  (njt, 2026.10.23. állapot) – **70 érték**, ingatlan-nyilvántartási kóddal; ettől eltérő jelleg a központi címregiszterben
  nem rögzíthető [F10] **[magas]**:
  allé, alsó rakpart, alsósor, bekötőút, bokor, dűlő, fasor, felső rakpart, felsősor, főtér, főút, gát, határ, határsor, határút,
  ipartelep, kert, kertsor, korzó, környék, körönd, körtér, körút, köz, lakópark, lakótelep, lejtő, lépcső, lépcsősor, liget, major,
  majorság, mélyút, negyed, oldal, országút, park, part, pincesor, puszta, rakpart, sétány, sikátor, sor, sugárút, szállás, szektor,
  szél, szer, sziget, szőlőhegy, tag, tanya, telep, tér, tere, tető, udvar, út, utca, útja, üdülőpart, üdülősor, üdülőtelep, vár,
  várkert, város, villasor, völgy, zug. (A korábbi 345/2014. Korm. rendeletet a 322/2024. 2024-11-07-ével hatályon kívül helyezte.)
* **Gyakoriság** (Magyar Posta utcajegyzékei: Budapest, Debrecen, Győr, Miskolc, Pécs, Szeged) [F18]: utca 12692, út 1385, köz 929,
  tér 659, dűlő 356, sor 172, tanya 165, park 150, sétány 139, körút 85, útja 70, lépcső 69, tere 36, lejtő 34, sugárút 26, fasor 20,
  telep 20, rakpart 18, liget 16, kert 13 … (összesen 94 különböző érték, köztük a KCR-listán kívüliek is: „dűlőút", „erdősor",
  „árok", „kapu", „parkja", „MÁV pályaudvar" stb.).
* NAV oldalon a `publicPlaceCategory` **szabad szöveg** – ne korlátozzuk a KCR-listára, csak ajánljuk fel.
  AkH-rövidítések (AkH 12, rövidítésjegyzék) [F19]: `u.` = utca, `krt.` = körút, `em.` = emelet, `fszt.` = földszint,
  `ker.` = kerület, `Pf.` = postafiók. Normalizáláskor a rövidítést írjuk ki teljes alakra.

---

## 6. Szám-, pénz- és dátumformátum

### 6.1 Helyesírási szabály (AkH 12, MTA 2015) [F19] **[magas]**

* 274. pont: tizedesvessző (`38,6`); **az öt- vagy többjegyű** számokat hátulról hármas csoportokra tagoljuk szóközzel
  (`23 816`), a négyjegyűeket nem (294. pont példája: `2500 Ft`).
* 295. pont, keltezés: `2014. február 28.`, `2014. II. 28.`, `2014. febr. 28.`, **`2014. 02. 28.`** (pont + szóköz).
* `Ft` = forint (rövidítésjegyzék); ISO-kód `HUF` (NAV `currencyCode`).

### 6.2 Node 24 `Intl` tényleges kimenete (v24.19.0, ICU 78.3, CLDR 48.0, futtatva 2026-10-27) [F23] **[magas]**

| Hívás | Kimenet | Kódpontok |
|---|---|---|
| `NumberFormat('hu-HU').format(1234)` | `1234` | – (4 jegyű: **nincs** csoportosítás) |
| `.format(9999)` / `.format(10000)` | `9999` / `10 000` | `10U+00A0000` |
| `.format(1234567.891)` | `1 234 567,891` | `1U+00A0234U+00A0567,891` |
| `.format(-1234.5)` | `-1234,5` | ASCII `-` (U+002D) |
| `{useGrouping:'always'}.format(1234)` | `1 234` | `1U+00A0234` |
| `{minimumFractionDigits:2,…}.format(1234.5)` | `1234,50` | |
| `{style:'currency',currency:'HUF'}.format(1234)` | `1234 Ft` | `1234U+00A0Ft` |
| `… currency:'HUF' }.format(1234567.5)` | `1 234 568 Ft` | **0 tizedes, kerekít!** (`maximumFractionDigits: 0`) |
| `{currencyDisplay:'code'}` HUF `12345` | `12 345 HUF` | |
| `currency:'EUR'`, `1234.5` | `1234,50 EUR` | a `hu` locale `EUR`-t ír, nem `€`-t |
| `{style:'percent'}.format(0.27)` | `27%` | szóköz nélkül |
| `DateTimeFormat('hu-HU')` 2026-10-27 | `2026. 10. 27.` | `literal` részek: `". "`, záró `"."` |
| `dateStyle:'long'` / `'full'` | `2026. október 27.` / `2026. október 27., kedd` | |
| `{dateStyle:'short',timeStyle:'short'}` | `2026. 10. 27. 13:00` | |
| 2026-01-05 alap | `2026. 01. 05.` | vezető nulla |

`formatToParts(1234567.891)` = `integer "1", group U+00A0, integer "234", group U+00A0, integer "567", decimal ",", fraction "891"`.

### 6.3 Számlákon követendő konvenció

* Pénzösszeg: `1 234 567 Ft` / `1 234,50 EUR` – csoportelválasztó **U+00A0** (PDF-ben ne törjön sort), tizedesvessző, pénznem
  utána szóközzel. A 4 jegyű számok csoportosítása ízlés kérdése: az AkH és a CLDR szerint `1234 Ft`; táblázatos oszlopokban
  az egységes `1 234 Ft` is elterjedt – egy dokumentumon belül legyen következetes.
* HUF-számla: a NAV `MonetaryType` 2 tizedest enged (18 jegy) [F1], a gyakorlat egész forint; **ne** hagyatkozzunk az
  `Intl` HUF-alapértelmezésére (rejtett kerekítés) – a kerekítést a számítási réteg végezze.
* Dátum a számlán: `2026. 10. 27.` (AkH-forma) vagy a gyakorlatban elterjedt `2026.10.27.`; XML-ben mindig `YYYY-MM-DD`
  (`InvoiceDateType`, min. 2010-01-01) [F1].

---

## 7. Készpénzes kerekítés (2008. évi III. törvény)

Hatályos szöveg (njt) [F7] **[magas]**:

> 1. § (1) Forintban, készpénzzel (bankjegy vagy érme átadásával) történő fizetés esetén, ha a fizetendő végösszeg nem 5 forintra
> vagy annak egész számú többszörösére végződik, úgy – a 4. §-ban foglaltak kivételével – a 2. §-ban meghatározott kerekítési
> szabály alapján kell a készpénzben fizetendő végösszeget meghatározni és a pénzfizetésre irányuló kötelezettséget teljesíteni.
> (2) A nem 5 forintra vagy annak egész számú többszörösére végződő fizetendő végösszeg és az (1) bekezdés alapján meghatározott
> készpénzben fizetendő összeg különbsége kerekítési különbözetnek minősül.
> (3) A kerekítési különbözet vagyoni előnynek vagy hátránynak nem minősül, arról bizonylat kiállítása, illetve annak bizonylaton
> történő feltüntetése nem kötelező.
> (4) Az e törvényben meghatározott kerekítéssel teljesített pénzfizetésre irányuló kötelezettséget pénzügyileg rendezettnek kell tekinteni.
>
> 2. § A kerekítés szabálya a következő: a) 0,01 forinttól 2,49 forintig végződő összegeket lefelé, a legközelebbi 0; b) a 2,50
> forinttól 4,99 forintig végződő összegeket felfelé, a legközelebbi 5; c) az 5,01 forinttól 7,49 forintig végződő összegeket
> lefelé, a legközelebbi 5; d) a 7,50 forinttól 9,99 forintig végződő összegeket felfelé, a legközelebbi 0 forintra végződő összegre kell kerekíteni.
>
> 3. § Bankkártyával való fizetés elfogadója dönthet úgy, hogy a bankkártyával való fizetés elfogadása során az 1. § szerinti
> kerekítési szabályokat alkalmazza. Erre a tényre a bankkártyával fizető személy figyelmét kifejezetten fel kell hívni.

* **Mire:** csak a *fizetendő végösszegre* (nem tételenként, nem az áfára), csak **forintban, készpénzzel**; kártyánál
  opcionális (az elfogadó dönt, és tájékoztatnia kell); átutalásnál nincs. (A NAV `paymentMethod`: `CASH`/`CARD`/`TRANSFER`… [F1])
* **NAV-adat:** a NAV GYIK II.36 (utolsó módosítás 2025-03-24) szerint, ha a számla végösszege nem változik, csak a
  készpénzben kifizetett összeg tér el 1–2 forinttal, ezt az adatszolgáltatásban nem kell szerepeltetni, mert a számla is a
  kerekítés nélküli végösszeget tartalmazza; ha viszont az adóalany a tételsorokat vagy a végösszeget maga kerekíti a számlán,
  akkor a kerekített összeg a számla végösszege, és az adatszolgáltatásnak is azt kell tartalmaznia [F4]. **[magas]**
* **Számlakép:** ajánlott a kerekítetlen végösszeg mellett külön sorban „Kerekítés: −2 Ft" és „Fizetendő (készpénz): 125 Ft"
  (nem kötelező, 1. § (3)); **ne** vegyünk fel „kerekítés" számlatételt (áfakezelése és NAV-tétele zavart okoz).
* Referencia: `roundHufCash()` (12. fejezet) – fillérben számol, tesztelt határesetek: `127→125`, `128→130`, `122,49→120`,
  `122,50→125`, `1234→1235`, `1236→1235`, `1237,49→1235`, `1237,50→1240`. Negatív (készpénzes visszatérítés) összegre a törvény
  hallgat – a referencia szimmetrikusan kerekít (szakmai döntés, **[alacsony]**).

---

## 8. ÁFA-kulcsok 2026-ban és a teljes ÁFA-kód → NAV `VatRateType` leképezés

### 8.1 Érvényes adómértékek (Áfa tv. 82–83. §, 2026.IX.15–XII.31. időállapot) [F5] **[magas]**

> 82. § (1) Az adó mértéke az adó alapjának 27 százaléka.
> (2) A 3. számú mellékletben felsorolt termékek, szolgáltatások esetében az adó mértéke az adó alapjának 5 százaléka.
> (3) A 3/A. számú mellékletben felsorolt termékek, szolgáltatások esetében az adó mértéke az adó alapjának 18 százaléka.
> (4) A 3/B. számú mellékletben felsorolt termékek esetében az adó mértéke az adó alapjának 0 százaléka.
> (5) A 8. számú melléklet I. részében felsorolt műalkotások 24. § szerinti importja esetében az adó mértéke az adó alapjának 5 százaléka.

| Kulcs | Melléklet / tipikus kör | Egyszerűsített számla `vatContent` (83. §) |
|---|---|---|
| **27 %** | általános | `0.2126` (21,26 %) |
| **18 %** | 3/A.: tej és tejtermékek (részben), ízesített tej, gabona/liszt/keményítő/tej alapú termékek (pl. 1905 90), desszert jellegű sajtkészítmény (2024-01-01-től), alkalmi szabadtéri rendezvény belépője | `0.1525` (15,25 %) |
| **5 %** | 3.: humángyógyszer (a vényköteles kivételével), könyv, folyóirat (évente ≥ 1×), kotta; sertés-, baromfi-, hal-, tojás-, tej- és marhahús-tételek (marha: egész/fél/negyed test korábban is; darabolt hús, vágási melléktermék, belsőség 2026-01-01-től); új lakás (50., 51., 59. sor); **tűzifa, pellet (2026-09-15-től)**; távhő, élőzene, éttermi szolgáltatás, internet-hozzáférés, kereskedelmi szálláshely, buszos turisztikai szállítás; gyógyászati segédeszközök (I/A.) | `0.0476` (4,76 %) |
| **0 %** | 3/B.: 1. napilap (hetente ≥ 4×, vtsz. 4902-ből) – 2024-01-01-től; **2. kizárólag orvosi rendelvényhez kötött gyógyszerek; 3. humán gyógyászati célú magisztrális készítmények – 2026-09-01-től** | `0` |

**2026–2027 időrendben** [F5] (jogtar-lábjegyzetek alapján, **[magas]**):

| Hatály | Változás | Módosító |
|---|---|---|
| 2026-01-01 | 3. melléklet I. 60. sor: háziasított szarvasmarha (darabolt) húsa, vágási mellékterméke, belsősége 5 % (0201 20 90, 0201 30 00, 0202 20 90, 0202 30 50/90, 0206 10/21/22/29); az egész/fél/negyed test (I. 31–38. sor) már előtte is 5 % | 2025. évi LXXXIII. tv. 25. § |
| 2026-01-01 | AAM-értékhatár 20 000 000 Ft (188. § (2)) | 2025. évi LXXXIV. tv. |
| 2026-09-01 | 3/B. 2–3. sor (vényköteles gyógyszer, magisztrális) 0 %; 3. melléklet I. 1. sor módosul, 4. és 6. sor hatályon kívül | 2026. évi XL. tv. |
| 2026-09-15 | 3. melléklet I. 61–62. sor: tűzifa, fűtési célú fűrészpor/pellet/brikett 5 % | 2026. évi XLVIII. tv. |
| **2027-01-01** | 3. melléklet I. **50–51. sor (új lakás) hatályon kívül**; 59. sor (rozsdaövezet) marad | 2024. évi LV. tv. 57. § 8. |
| **2027-01-01** | **371. § átmenet**: a 2026-12-31-i 5 % alkalmazandó, ha a teljesítés 2027-01-01 – 2030-12-31 közé esik és a) az építési engedély 2026-12-31-ig véglegessé vált, vagy b) az egyszerű bejelentéshez kötött tevékenységet 2024-09-30-ig bejelentették, vagy c) az egyszerű bejelentést 2026-12-31-ig tudomásul vették | 2024. évi LV. tv. 53. § |
| 2027-01-01 | AAM-értékhatár 22 000 000 Ft | (jogtar 2027-es időállapot) |
| 2028-01-01 | AAM-értékhatár 24 000 000 Ft | (jogtar 2028.I.1-i időállapot; a 2025. évi LXXXIV. tv. 2028-01-01-jén hatályba lépő Áfa tv.-módosítása) |

> ⚠️ Javítva (verifikáció): a 2028-as AAM-sor hiányzott; a 60. sor (marha) leírása – és a fenti kulcstáblázat 5 %-os sora – pontosítva, a 2025-ös időállapotban a 31–38. sor
> (szarvasmarhafélék egész/fél/negyed teste) már 5 % – https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20280101 ;
> https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20251122 ; https://njt.jog.gov.hu/jogszabaly/2025-83-00-00 (119. § (3))

Bizonytalanság: a kormány 2026. szeptemberi nyilatkozata szerint az őszi adócsomagban az új lakások 5 %-áról is döntés
születhet (Világgazdaság, 2026-09-28) – 2026-10-27-ig erről kihirdetett jogszabályt nem találtam. **[közepes]**

> ❓ Nem ellenőrizhető: jövőbeli jogalkotás. A net.jogtar.hu 2027.I.1-i időállapota (lekérve 2026-10-27) továbbra is az 50–51. sor
> hatályon kívül helyezését és a 371. §-t mutatja; benyújtott vagy kihirdetett módosítást nem találtam.

### 8.2 0 % ≠ adómentes

* A 0 % **adókötelezett** ügylet (levonási joggal); a NAV szerint ilyenkor adómentesség (pl. AAM) vagy hatályon kívüliség
  **nem** alkalmazható – sem a számlán, sem az adatszolgáltatásban [F13]. **[magas]**
* NAV: normál/gyűjtőszámlán `vatPercentage` engedett értékei `0.05, 0.07, 0.12, 0.18, 0.2*, 0.25*, 0.27` és **`0` csak
  2024-01-01-i vagy későbbi teljesítésnél**; egyszerűsítettnél `vatContent` `0.0476, 0.1525, 0.1667*, 0.2*, 0.2126` és `0`
  (≥ 2024-01-01). `*` = csak MODIFY/STORNO vagy 2013-01-01 előtti teljesítés. Más érték: **ERROR `INVALID_VAT_DATA`** (14.) [F3].
* Előlegnél a teljesítési időpont az előleg időpontja (NAV: 0 % csak ha az is ≥ 2024-01-01) [F13].

### 8.3 Leképezési táblázat (projektkód → NAV → számlaszöveg)

A `case` értékek nem XSD-enumok (`SimpleText50NotBlankType`), hanem **üzleti validáció** kényszeríti ki őket: rossz érték →
ERROR `INVALID_LINE/SUMMARY_VAT_EXEMPTION_CODE` / `…_VAT_OUT_OF_SCOPE_CODE` / `…_VAT_AMOUNT_MISMATCH_CODE` (31–37.) [F3].
A `reason` (`SimpleText200NotBlankType`) szabad szöveg – ide a számlán is szereplő hivatkozást írjuk. A „számlaszöveg"
oszlopban a **jogszabály által szó szerint előírt** kifejezéseket félkövér idézőjel jelzi; a többi javasolt szöveg.

| Projektkód (`vat.ts`) | Mikor | NAV `VatRateType` ág | Számlaszöveg (min.) | Jogalap | NAV-megkötés |
|---|---|---|---|---|---|
| `27` / `18` / `5` | adóköteles, kulcs szerint | `<vatPercentage>0.27</vatPercentage>` (0.18, 0.05) | „27%" (adómérték, 169. § j)) | 82. § (1)–(3) | `vatPercentage` 0–1 közötti szám, nem `27` (GYIK II.24) |
| `0` | csak 3/B. melléklet | `<vatPercentage>0</vatPercentage>` | „0%" | 82. § (4) | teljesítés ≥ 2024-01-01, különben ERROR |
| (egyszerűsített) | 176. § szerinti egyszerűsített számla | `<vatContent>0.2126</vatContent>` (0.1525, 0.0476, 0) | bruttó ár + „21,26%" – áfaösszeg **nem** tüntethető fel (176. § (2) a)) | 83. §, 176. § | `vatPercentage` tilos SIMPLIFIED-ben, `vatContent` tilos NORMAL/AGGREGATE-ben (ERROR) |
| `AAM` | alanyi adómentes eladó minden tétele | `<vatExemption><case>AAM</case><reason>…</reason></vatExemption>` | „Alanyi adómentes (Áfa tv. XIII. fejezet)"; áfa és 83. §-os % nem szerepelhet (187. § (2) c)) | 169. § m), 187–196. § | értékhatár 2026: 20 M Ft; AAM eladónál 176. § (1) e) szerinti egyszerűsített adattartalom is lehet |
| `TAM` | 85–86. § szerinti tárgyi mentesség | `vatExemption` / `TAM` | „Tárgyi adómentes – Áfa tv. 85. § (1) bek. [x] pont" (konkrét pont!) | 169. § m), 85–86. § | egyes TAM ügyletekről elég számviteli bizonylat (165. § (1) a)) |
| `KBAET` | Közösségen belüli termékértékesítés más tagállami adóalanynak (nem új közl. eszköz) | `vatExemption` / `KBAET` | „Adómentes Közösségen belüli termékértékesítés – Áfa tv. 89. §" (+ EN: „Exempt intra-Community supply – Art. 138 Directive 2006/112/EC") | 89. §, 169. § db) | `customerVatStatus=OTHER` (különben **ERROR 67**); vevő közösségi adószáma kötelező (WARN, ha más adószám); számla a teljesítést követő hó 15-ig (163. § (2) a)) |
| `KBAUK` | új közlekedési eszköz Közösségen belüli értékesítése | `vatExemption` / `KBAUK` | „Adómentes Közösségen belüli új közlekedési eszköz értékesítés – Áfa tv. 89. § (2)" + 259. § 25. pont adatai (169. § o)) | 89. § | vevő `PRIVATE_PERSON` vagy `OTHER` (DOMESTIC → **ERROR 68**) |
| `EAM` | termékexport harmadik országba | `vatExemption` / `EAM` | „Adómentes termékexport – Áfa tv. 98. §" | 98–109. § | – |
| `NAM` | egyéb nemzetközi ügylet (közvetítés, nemzetközi fuvarozáshoz kapcsolódó stb.) | `vatExemption` / `NAM` | „Adómentes – Áfa tv. [93–95. § / 110–118. § konkrét pont]" | 93–95., 110–118. § | – |
| `ATK` | Áfa tv. tárgyi hatályán kívül (pl. kártérítés, közhatalmi tevékenység, közcélú adomány) | `<vatOutOfScope><case>ATK</case>…` | „Az Áfa tv. tárgyi hatályán kívüli ügylet" | 2–3. § | kizárólag ATK tételről nem kell számla, de lehet ATK tétel a számlán |
| `EUFAD37` | szolgáltatás más tagállami adóalanynak, teljesítési hely a 37. § (1) szerint | `vatOutOfScope` / `EUFAD37` | **„fordított adózás"** (169. § n)) + EN „Reverse charge" | 37. § (1), 169. § n) | `OTHER` vevő (különben **ERROR 69**); közösségi adószám kötelező; összesítő nyilatkozat |
| `EUFADE` | más tagállamban teljesített, nem 37. § alá eső, fordítottan adózó ügylet (pl. fel-/összeszerelt termék) | `vatOutOfScope` / `EUFADE` | **„fordított adózás"** | 169. § n) | `OTHER` vevő (különben **ERROR 70**) |
| `EUE` | más tagállamban teljesített, **nem** fordítottan adózó ügylet | `vatOutOfScope` / `EUE` | javasolt: „A teljesítés helye: [tagállam]" – az ottani szabályok szerint helyi áfa-regisztráció/számla kellhet | 10. mell. 5/A. pont (adatszolgáltatás) | – |
| `HO` | harmadik országban teljesített ügylet (pl. EU-n kívüli ingatlanhoz kapcsolódó vagy B2B szolgáltatás) | `vatOutOfScope` / `HO` | javasolt: „A teljesítés helye harmadik ország – az Áfa tv. területi hatályán kívül" | 10. mell. 5/A. pont | – |
| `FAD` | belföldi fordított adózás (142. §: építési-szerelési munka hatósági engedélyhez kötött ingatlanra, munkaerő-kölcsönzés ehhez, 6. mell. hulladék, választott ingatlanértékesítés, fizetésképtelenség, kibocsátási egység, 6/A., 6/B. mell., adóalany-kereskedő) | `<vatDomesticReverseCharge>true</vatDomesticReverseCharge>` (`fixed="true"`) | **„fordított adózás"** + a vevő **teljes** adószáma (169. § da)) | 142. §, 169. § n) | vevő magyar adószám nélkül **ERROR 50** (`DOMESTIC_TAXNUMBER_EXPECTED_REVERSE_CHARGE`); a jelölésnek tételben és összesítőben is szerepelnie kell |
| `KUL_UTAZAS` | utazásszervezés különbözet szerint | `<marginSchemeIndicator>TRAVEL_AGENCY</…>` | **„különbözet szerinti szabályozás – utazási irodák"** | 169. § p), 206–212. § | a számlán adóalap/áfa elhagyható (210/A. § (1)), de **a NAV-adatnak tartalmaznia kell a forintos adóalapot és áfát** (210/A. § (3)) |
| `KUL_HASZNALT` / `KUL_MUALKOTAS` / `KUL_REGISEG` | viszonteladó használt cikk / műalkotás / gyűjteménydarab-régiség | `marginSchemeIndicator` `SECOND_HAND` / `ARTWORK` / `ANTIQUES` | **„különbözet szerinti szabályozás – használt cikkek"** / **„– műalkotások"** / **„– gyűjteménydarabok és régiségek"** | 169. § q), 222. § (1) b) | áthárított áfa és 83. §-os % **nem** szerepelhet; NAV WARN, ha a tétel áfaadata ≠ 0 (nem utazási iroda esetén) |
| *(hiányzik)* `NOVAT` | 17. § szerinti apport / jogutódlás (nem áll be értékesítési joghatás) | `<noVatCharge>true</noVatCharge>` | javasolt: „Áfa tv. 17. § – nem áll be termékértékesítéshez fűződő joghatás" | 17–18. § | – |
| *(hiányzik)* `ELTERES` | ingyenes / ellenérték fejében végzettnek minősülő átadás (11. §, 14. §), ahol adóalap és felszámított adó nem következik egymásból | `<vatAmountMismatch><vatRate>0.27</vatRate><case>REFUNDABLE_VAT</case></…>` (vagy `NONREFUNDABLE_VAT`) | – | 11. §, 14. § | `vatRate` ∈ {0.27, 0.18, 0.05, 0.2126, 0.1525, 0.0476, 0 (≥ 2024)} (ERROR 48/49) |
| `UNKNOWN` (case) | **csak** 3.0 előtti számlára hivatkozó vagy előzmény nélküli (`modifyWithoutMaster`) MODIFY/STORNO | bármely `case` | – | – | máshol ERROR |

Kapcsolódó (nem áfakód, de kötelező) számlaszövegek: **„pénzforgalmi elszámolás"** (169. § h)), **„önszámlázás"** (169. § l)).
A teljes jogszabályi szöveg [F5]:

> 169. § m) adómentesség esetében jogszabályi vagy a Héa-irányelv vonatkozó rendelkezéseire történő hivatkozás vagy bármely más,
> de egyértelmű utalás arra, hogy a termék értékesítése, szolgáltatás nyújtása mentes az adó alól;
> n) a „fordított adózás" kifejezés, ha adófizetésre a termék beszerzője, szolgáltatás igénybevevője kötelezett;
> p) a „különbözet szerinti szabályozás – utazási irodák" kifejezés, a XV. fejezetben meghatározott különös szabályok szerinti
> utazásszervezési szolgáltatás nyújtása esetében;
> q) a „különbözet szerinti szabályozás – használt cikkek" vagy a „különbözet szerinti szabályozás – műalkotások", vagy a
> „különbözet szerinti szabályozás – gyűjteménydarabok és régiségek" kifejezések közül a megfelelő kifejezés, a XVI. fejezetben
> meghatározott különös szabályok szerinti használt ingóság, műalkotás, gyűjteménydarab vagy régiség értékesítése esetében;

A `case`-értékek NAV-leírása és Áfa tv.-hivatkozása a specifikáció táblázata szerint [F3]: AAM – XIII. fejezet; TAM – 85–86. §;
KBAET – 89. §; KBAUK – 89. § (2); EAM – 98–109. §; NAM – 93–95. §, 110–118. §; ATK – 2–3. §; EUFAD37 – 37. § (1); EUFADE, EUE, HO –
(nincs §); REFUNDABLE_VAT / NONREFUNDABLE_VAT – 11. §, 14. §. **[magas]**

### 8.4 Gyakorlati / örökölt kódok más szoftverekben

A Számlázz.hu Számla Agent (szállítói dokumentáció, 2026-10-27) [F21] **[közepes]** a NAV-kódok mellett régi kódokat is ismer:
`EU` → `EUT`, `EUK` → `EUKT` átnevezve, `TAHK` (= ATK), `TEHK` (= HO), `F.AFA` (fordított adózás), `K.AFA` (különbözeti), és
számos külföldi kulcsot (pl. 19, 20, 21, 25.5). Importnál ezek **nem képezhetők le egyértelműen**: az `EU(T)` lehet KBAET (áru)
vagy EUFAD37/EUFADE (szolgáltatás), az `EUK(T)` lehet EAM, HO vagy NAM, a `K.AFA`-hoz a négy `marginSchemeIndicator`
egyikét kell választani → importáláskor kötelező emberi/ügynöki döntés.

---

## 9. Mennyiségi egységek

NAV `UnitOfMeasureType` (pontos enum, `invoiceData.xsd` v3.0) [F1] **[magas]**: `PIECE`, `KILOGRAM`, `TON`, `KWH`, `DAY`, `HOUR`,
`MINUTE`, `MONTH`, `LITER`, `KILOMETER`, `CUBIC_METER`, `METER`, `LINEAR_METER`, `CARTON`, `PACK`, `OWN`.

* A kanonikus érték megadása kötelező, **ha alkalmazható**; ha nem sorolható be, `OWN` + `unitOfMeasureOwn`
  (`SimpleText50NotBlankType`) [F3 2.3.16]. `OWN` mellett hiányzó `unitOfMeasureOwn` → **ERROR 65**
  (`INCORRECT_LINE_DATA_UOM_INCOMPLETE`). Kanonikus érték mellett is **szabad** `unitOfMeasureOwn`-t küldeni (a nyomtatott
  címkét) [F3 változásnapló].
* Ha a `lineExpressionIndicator = true`, a tételben megnevezés, mennyiség, mennyiségi egység és egységár kötelező (ERROR 13);
  `false` esetén csak a megnevezés [F3].
* A 169. § f) szerint a mennyiség csak akkor kötelező, ha „természetes mértékegységben kifejezhető" – átalánydíjas szolgáltatásnál
  a mennyiség/egység elhagyható (`lineExpressionIndicator=false`).
* **Ne váltsunk át** mértékegységet (pl. g → kg) a NAV kedvéért: a NAV-adatnak a számlán szereplő mennyiséget kell tükröznie.

| Magyar egység (számlán) | NAV `unitOfMeasure` | `unitOfMeasureOwn` | Megjegyzés |
|---|---|---|---|
| db, darab | `PIECE` | – | AkH: „db" |
| kg | `KILOGRAM` | – | |
| t, tonna | `TON` | – | metrikus tonna |
| kWh | `KWH` | – | |
| nap, munkanap | `DAY` | – | |
| óra, munkaóra, üzemóra | `HOUR` | – | |
| perc | `MINUTE` | – | |
| hó, hónap | `MONTH` | – | |
| l, liter | `LITER` | – | |
| km | `KILOMETER` | – | |
| m³, köbméter | `CUBIC_METER` | – | |
| m, méter | `METER` | – | |
| fm, folyóméter | `LINEAR_METER` | – | |
| karton | `CARTON` | – | |
| csomag, cs. | `PACK` | – | |
| év | `OWN` | `év` | nincs YEAR enum |
| alkalom | `OWN` | `alkalom` | |
| hét | `OWN` | `hét` | |
| m², nm | `OWN` | `m²` | nincs négyzetméter enum |
| g, dkg | `OWN` | `g` / `dkg` | ne váltsuk kg-ra |
| dl, cl, ml | `OWN` | `dl` … | |
| MWh, GJ | `OWN` | `MWh` … | |
| pár, készlet, szett, garnitúra | `OWN` | a címke | |
| doboz, tekercs, zsák, raklap, palack | `OWN` | a címke | „doboz" ≠ „karton" – ha nem karton, OWN |
| fő, oldal, leütés | `OWN` | a címke | |
| szolgáltatás, átalány, tétel | `OWN` vagy egység nélkül | a címke | átalánynál inkább `lineExpressionIndicator=false` |

Pontosság: `quantity`, `unitPrice` = `QuantityType` (22 jegy, 10 tizedes az XSD-ben; a spec. szövege „hat tizedesjegyet" említ –
ellentmondás, az XSD a mérvadó); ha ez sem elég, a NAV a mennyiségi egység átválasztását javasolja (pl. „1000 darab") [F1][F3].

---

## 10. Árfolyam a számlán

### 10.1 Melyik napi árfolyam? (Áfa tv. 80–80/A. §, njt 2026.09.15. állapot) [F5] **[magas]**

> 80. § (1) Termék értékesítése, szolgáltatás nyújtása, valamint termék Közösségen belüli beszerzése esetében, ha az adó alapja
> külföldi pénznemben kifejezett, a forintra történő átszámításhoz azt a (2) bekezdésben meghatározott árfolyamot kell alkalmazni, amely
> a) termék Közösségen belüli beszerzése, illetőleg előleg fizetése esetében, valamint a 60. §-ban említett esetekben a fizetendő adó megállapításakor,
> b) az 58. §-ban említett esetben a számla kibocsátásakor,
> c) egyéb esetekben pedig a teljesítéskor érvényes.
> (2) Az alkalmazandó árfolyam az az utolsó, az (1) bekezdésben meghatározott időpontban érvényes, az adott külföldi pénznem
> valamely egységének forintban kifejezett ára, amelyet
> a) belföldön pénzváltási engedéllyel rendelkező hitelintézet devizában eladási árként jegyez; vagy
> b) a Magyar Nemzeti Bank (a továbbiakban: MNB) hivatalosan közzé tesz, feltéve, hogy a forintra történő átszámításra kötelezett
> (e § alkalmazásában a továbbiakban: kötelezett) így dönt, és erről a döntéséről az állami adóhatóságnak előzetes bejelentést tesz.
> (3) A (2) bekezdés b) pontja szerinti választási jog úgy gyakorolható, hogy az valamennyi olyan termékértékesítésre,
> szolgáltatásnyújtásra és termék Közösségen belüli beszerzésre kiterjed, amely esetében az adó alapja külföldi pénznemben kifejezett.
> (4) Az a kötelezett, aki (amely) élt a (2) bekezdés b) pontjában említett választási jogával, attól a választása évét követő
> naptári év végéig nem térhet el.
>
> 80/A. § (1) A 80. § (2) bekezdésétől eltérően az adó alapjának forintra történő átszámításához választható az EKB által a 80. §
> (1) bekezdésében meghatározott időpontban hivatalosan közzétett legutolsó árfolyam is.

| Eset | Árfolyam-időpont | Hivatkozás |
|---|---|---|
| Általános (teljesítés) | a teljesítés napja (55–57. §) | 80. § (1) c) |
| Előleg | a fizetendő adó megállapítása = az előleg jóváírása/kézhezvétele | 80. § (1) a), 59. § (1) |
| Időszakos elszámolás (58. §) | a **számla kibocsátása** | 80. § (1) b) |
| Fordított adózás, vevő fizeti (60. §) | a számla kézhezvétele / ellenérték megtérítése / teljesítést követő hó 15. közül a legkorábbi | 80. § (1) a), 60. § (1)–(2) |
| Közösségen belüli beszerzés | a fizetendő adó megállapítása | 80. § (1) a) |
| Nem jegyzett deviza (bank sem jegyzi) | MNB/EKB euró-árfolyam az előző naptári negyedévre | 80. § (5) |

* **Alapértelmezés a törvényben a hitelintézeti deviza eladási árfolyam**; MNB- vagy EKB-árfolyam csak előzetes NAV-bejelentés
  után, minden devizás ügyletre, és a választás évét követő év végéig kötelező; MNB és EKB együtt nem választható [F12]. → a
  beállításoknál ezt rögzíteni kell (`rateSource: 'BANK' | 'MNB' | 'ECB'` + bejelentés dátuma).
* A forintban kifejezett áthárított adót devizás számlán is fel kell tüntetni (172. §), belföldön kívül teljesített ügyletnél nem [F5][F12].

### 10.2 MNB közzétételi szabályok [F17] **[magas]**

Az MNB hétfőtől péntekig – a nem munkanapok kivételével – **11:00-kor** állapítja meg a hivatalos árfolyamokat; egy árfolyam a
következő közzétételig érvényes. EUR/HUF: a nyolc legaktívabb hazai bank jegyzéseinek a szélső értékek elhagyásával számított
súlyozatlan átlaga; USD/HUF az EUR/HUF és EUR/USD keresztárfolyamból, a többi devizáé a 11:00-s nemzetközi keresztárfolyamokból.

* Hétvégén és ünnepnapon nincs jegyzés → az **utolsó közzétett** az érvényes (80. § (2) „utolsó … érvényes"). Élő példa:
  2026-10-23 (péntek, nemzeti ünnep) és 24–25. (hétvége) nincs adat; az EUR-ra 10-22-én `366,52`, 10-26-án `366,95`.
* Munkanapon 11:00 előtt még az előző munkanapi árfolyam érvényes; a NAV álláspontja másodlagos források szerint az, hogy mivel
  a számlán csak dátum van, ilyenkor mindkét árfolyam elfogadható. **[alacsony]** → tároljuk az árfolyam **dátumát és forrását**,
  és engedjük felülírni.
  > ❓ Nem ellenőrizhető: elsődleges NAV-állásfoglalást a 11:00 előtti időszakra a verifikáció során sem találtam; a 11:00-s
  > megállapítás és a „következő közzétételig érvényes” szabály az mnb.hu oldalán megerősítve.

### 10.3 MNB webszolgáltatás (élő hívások: 2026-10-27) [F16] **[magas]**

* WSDL: `https://www.mnb.hu/arfolyamok.asmx?wsdl` (+ `?wsdl=wsdl0`, `?xsd=xsd1`); SOAP 1.1, document/literal.
  `soap:address`: **`http://www.mnb.hu/arfolyamok.asmx`**. **A `https://` végpontra küldött POST 2026-10-27-én HTTP 404-et ad,
  csak a `http://` működik** (TLS nélkül → integritás nem garantált; lásd teendők).
* Névtér: `http://www.mnb.hu/webservices/`; `SOAPAction: "http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/<Művelet>"`.
* Műveletek: `GetInfo`, `GetCurrencies`, `GetCurrencyUnits(currencyNames)`, `GetDateInterval`, `GetCurrentExchangeRates`,
  `GetExchangeRates(startDate, endDate, currencyNames)` – a paraméterek `xs:string`-ek; dátum `YYYY-MM-DD`, devizák vesszővel
  elválasztva. Minden válasz egyetlen `…Result` **stringet** ad vissza, amely **escape-elt XML**.

Kérés:

```xml
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.mnb.hu/webservices/">
  <soapenv:Body>
    <web:GetExchangeRates>
      <web:startDate>2026-10-23</web:startDate>
      <web:endDate>2026-10-27</web:endDate>
      <web:currencyNames>EUR,USD,JPY,GBP,CHF</web:currencyNames>
    </web:GetExchangeRates>
  </soapenv:Body>
</soapenv:Envelope>
```

Válasz (borítékban az escape-elt string; alább már dekódolva):

```xml
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <GetExchangeRatesResponse xmlns="http://www.mnb.hu/webservices/"><GetExchangeRatesResult>&lt;MNBExchangeRates&gt;…</GetExchangeRatesResult></GetExchangeRatesResponse>
</s:Body></s:Envelope>

<MNBExchangeRates>
  <Day date="2026-10-27"><Rate unit="1" curr="CHF">397,67</Rate><Rate unit="1" curr="EUR">367,14</Rate><Rate unit="1" curr="GBP">438,81</Rate><Rate unit="100" curr="JPY">208,89</Rate><Rate unit="1" curr="USD">329,51</Rate></Day>
  <Day date="2026-10-26"><Rate unit="1" curr="CHF">396,43000</Rate><Rate unit="1" curr="EUR">366,95000</Rate><Rate unit="1" curr="GBP">437,07000</Rate><Rate unit="100" curr="JPY">208,10000</Rate><Rate unit="1" curr="USD">327,49000</Rate></Day>
</MNBExchangeRates>
```

Megfigyelések: **tizedesvessző**; a napok **csökkenő** dátumsorrendben; a mai nap 2 tizedessel, a korábbiak 5 tizedessel
(`366,95000`); `unit="100"` a JPY, IDR, KRW esetén (`GetCurrencyUnits`); ünnep/hétvége tartományra `<MNBExchangeRates />`;
`GetCurrentExchangeRates` → `<MNBCurrentExchangeRates><Day date="2026-10-27">…`; `GetInfo` → `<MNBExchangeRatesQueryValues>`
(`FirstDate` 1949-01-03, `LastDate`, devizalista); `GetDateInterval` → `<MNBStoredInterval><DateInterval startdate="1949-01-03" enddate="2026-10-27" />`.
A szolgáltatás a `2026.10.19.` formátumú dátumot is elfogadta (laza parser) – ne támaszkodjunk rá.

### 10.4 NAV `exchangeRate` szabályok [F1][F3] **[magas]**

* `ExchangeRateType`: `xs:decimal`, max. 14 jegy, ebből 6 tizedes, `> 0`. **Egy egység** értéke forintban → JPY-nál
  `208,89 / 100 = 2.0889`, IDR-nél `0.0182`.
* Minden számlán kötelező; HUF-számlán `1` (más érték: **ERROR 77** `INCORRECT_HEAD_DATA_CURRENCY_CODE_HUF`; 1 nem-HUF devizánál WARN).
* **ERROR 78** `INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME`, ha a sávon kívül esik (HUF/egység; a NAV előzetes értesítés nélkül
  módosíthatja): EUR 250–600, USD 200–600, GBP 250–720, CHF 200–600, BGN 120–360, RON 50–180, PLN 50–180, SEK 20–72, NOK 20–72,
  CZK 5–48, ILS 40–240, DKK 20–120, BAM 100–360. (JPY nincs a listán – a „100 egységes" hibát a NAV nem fogja meg!)
* Végszámlának **egy** árfolyama van, az előleg beszámítása is ezzel történik; `advanceExchangeRate` csak számviteli célú.
  Devizás gyűjtőszámlán tételenként `lineExchangeRate`, a fejben a nettó HUF/nettó deviza hányados.
* Tűrés a forintos átszámítást vizsgáló WARN-oknál: a számított forintérték 1 %-a, de legalább 1 HUF és a pénznem 0,01 egysége
  közül a nagyobb.

---

## 11. Számla sorszáma

* **Jog:** a számla sorszáma „a számlát kétséget kizáróan azonosítja" (Áfa tv. 169. § b)) [F5]. Számlázóprogramnál
  (23/2014. (VI. 30.) NGM rendelet, njt 2026.01.01. állapot) [F9] **[magas]**:

> 8. § (1) A számlázó programmal szemben követelmény, hogy a) a számlázó program – a (2)–(4) bekezdésben meghatározott
> eltérésekkel – kihagyás és ismétlés nélküli, folyamatos sorszámozást biztosítson, és […]
> (2) A számlázó programnak az adóalany nem magyarországi adószámán történő számla kibocsátásához a belfölditől elkülönített
> sorszámtartományt kell biztosítania.
> […] (5) Abban az esetben, ha a program egyaránt alkalmas számla és nyugta előállítására, számla és nyugta kibocsátása
> elkülönített sorszámtartományon is történhet.
> (6) A számlázó programmal előállított számla, számlával egy tekintet alá eső okirat az (1) bekezdés d) pontja alkalmazásában
> abban az időpontban minősül kiállítottnak, amely időponttal a számlázó program az előállított számla, számlával egy tekintet
> alá eső okirat adatait lezárja.

* **NAV `invoiceNumber`**: `common:SimpleText50NotBlankType` – 1–50 karakter, minta `.*[^\s].*` (bármilyen Unicode) [F1][F2];
  elején/végén whitespace (space, CR, LF, TAB) → **ERROR 51** `INVALID_INVOICE_NUMBER`; az `originalInvoiceNumber`-re ugyanez
  (ERROR 79) [F3].
* **Egyediség:** az adózó már szolgáltatott adatot ugyanerre a sorszámra → **ERROR 2** `INVOICE_NUMBER_NOT_UNIQUE`; a számlasorszám
  **adózónként** (nem évenként, nem tartományonként) egyedi; csak a jóváhagyott technikai érvénytelenítés szabadítja fel [F3]. **[magas]**
* **Több tartomány** megengedett (pl. külön számla/nyugta/díjbekérő, devizás, külföldi adószám); **éves újrakezdés** csak úgy,
  hogy az évszám a sorszám része (különben ütközik a NAV-egyediséggel). A NAV saját Online Számlázója is így képez:
  `<tömb előtag>-<kiállítás éve>-<sorszám>` (pl. `METST-2018-30`), az előtag ≤ 5 alfanumerikus karakter, évente egyedi [F22]. **[magas]**
* Ajánlott karakterkészlet: `A–Z a–z 0–9 - / _ .` (a `numbering.ts` szerződése már így szól); ékezet és szóköz kerülendő
  (PDF-ből/OCR-ből másolva hibázik).

---

## 12. TypeScript referencia-implementáció és futtatott tesztek

A modul önálló (külső csomag nélkül), Node 24 type strippinggel fut (`node --test hu-validators.test.ts`). A tesztben a NAV
számlalista egy kinyert fixture (`nav-accounts.fixture.json`: 123 számlaszám, 125 IBAN a NAV 2026-07-01-től érvényes PDF-jéből).

### 12.1 `hu-validators.ts`

```ts
/**
 * Hungarian identifier validators – research reference implementation (2026-10-27).
 * Runs on Node 24 with built-in type stripping (no enums/namespaces/parameter properties).
 *
 * Sources (see docs/research/06-adatformatumok.md):
 *  - adószám törzsszám CDV: Céginformációs Szolgálat "Adószám ellenőrzése" (9,7,3,1,9,7,3 → 10 - last digit)
 *  - megyekód / áfakód value sets: NAV Online Számla interfész specifikáció v3.0 (2026.02.12), 4.1 + WARN 50/120/130/140
 *  - adóazonosító jel: 1996. évi XX. törvény 1. számú melléklet
 *  - pénzforgalmi jelzőszám + IBAN: 35/2017. (XII. 14.) MNB rendelet 1. melléklet
 *  - EU VAT formats: VIES FAQ table (ec.europa.eu/taxation_customs/vies, translations endpoint, 2026-10-27)
 *  - NAV XSD patterns: NTCA common.xsd 1.0 (BankAccountNumberType, PostalCodeType, CommunityVatNumberType, ...)
 */

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: string): Err => ({ ok: false, error });

const onlyDigits = (s: string): boolean => /^[0-9]+$/.test(s);

/* ------------------------------------------------------------------ */
/* Shared 9-7-3-1 check digit (adószám törzsszám + GIRO account CDV)   */
/* ------------------------------------------------------------------ */

const W9731 = [9, 7, 3, 1];

/** Check digit for `payload` using weights 9,7,3,1 repeated (from the left). (10 - sum mod 10) mod 10. */
export function cdv9731(payload: string): number {
  if (!onlyDigits(payload)) throw new Error('digits only');
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += Number(payload[i]) * W9731[i % 4];
  return (10 - (sum % 10)) % 10;
}

/** True if the last digit of `block` is the 9-7-3-1 check digit of the preceding digits. */
export function hasValid9731(block: string): boolean {
  return onlyDigits(block) && block.length >= 2 && cdv9731(block.slice(0, -1)) === Number(block.at(-1));
}

/* ------------------------------------------------------------------ */
/* 1. Adószám  xxxxxxxx-y-zz                                           */
/* ------------------------------------------------------------------ */

/** NAV-valid illetékességi (megye) codes: 02–20, 22–44, 51 (NAV spec WARN INCORRECT_COUNTY_CODE_*). */
export const HU_COUNTY_CODES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 19 }, (_, i) => String(i + 2).padStart(2, '0')), // 02..20
  ...Array.from({ length: 23 }, (_, i) => String(i + 22)), // 22..44
  '51',
]);

export type VatCodeMeaning = 'ADOMENTES' | 'ALTALANOS' | 'EVA_TORTENETI' | 'CSOPORTTAG' | 'CSOPORTAZONOSITO';
export const HU_VAT_CODE_MEANING: Readonly<Record<string, VatCodeMeaning>> = {
  '1': 'ADOMENTES', // alanyi vagy tárgyi adómentes (nem számít fel áfát)
  '2': 'ALTALANOS', // általános szabályok szerint adózó
  '3': 'EVA_TORTENETI', // volt EVA-alany (eva 2020.01.01-jén megszűnt) – csak régi adószámokon
  '4': 'CSOPORTTAG', // csoportos áfaalany tagjának saját adószáma
  '5': 'CSOPORTAZONOSITO', // áfacsoport csoportazonosító száma
};

export interface HuTaxNumber {
  taxpayerId: string; // 8 digits (törzsszám / csoportazonosító törzsszáma)
  vatCode?: string; // 1 digit
  countyCode?: string; // 2 digits
  /** Canonical "12345678-1-12" (or just the 8 digits if only the törzsszám was given) */
  formatted: string;
  vatCodeMeaning?: VatCodeMeaning;
}

export function isValidTorzsszam(taxpayerId: string): boolean {
  return /^[0-9]{8}$/.test(taxpayerId) && hasValid9731(taxpayerId);
}

/**
 * Accepts "12345678-1-12", "12345678 1 12", "12345678112" or a bare 8-digit törzsszám
 * (169. § dc) allows the first 8 digits only for domestic B2B buyers).
 */
export function parseHuTaxNumber(input: string): Result<HuTaxNumber> {
  const s = input.trim().replace(/[\s.]/g, '');
  const m = /^([0-9]{8})(?:-?([0-9])-?([0-9]{2}))?$/.exec(s);
  if (!m) return err('FORMAT: expected 8 digits or xxxxxxxx-y-zz');
  const [, taxpayerId, vatCode, countyCode] = m;
  if (!hasValid9731(taxpayerId)) return err('CDV: törzsszám check digit mismatch');
  if (vatCode === undefined) return ok({ taxpayerId, formatted: taxpayerId });
  if (!/^[1-5]$/.test(vatCode)) return err('VATCODE: áfakód must be 1–5');
  if (!HU_COUNTY_CODES.has(countyCode)) return err('COUNTY: megyekód not in 02–20, 22–44, 51');
  return ok({ taxpayerId, vatCode, countyCode, formatted: `${taxpayerId}-${vatCode}-${countyCode}`, vatCodeMeaning: HU_VAT_CODE_MEANING[vatCode] });
}

/** Map to NAV TaxNumberType elements (base:taxpayerId, base:vatCode, base:countyCode). */
export function toNavTaxNumberType(t: HuTaxNumber): { taxpayerId: string; vatCode?: string; countyCode?: string } {
  return { taxpayerId: t.taxpayerId, ...(t.vatCode ? { vatCode: t.vatCode } : {}), ...(t.countyCode ? { countyCode: t.countyCode } : {}) };
}

/* ------------------------------------------------------------------ */
/* 2. Közösségi adószám / EU VAT number                                */
/* ------------------------------------------------------------------ */

/**
 * Format-only regexes derived from the VIES FAQ "structure of VAT numbers" table
 * (9 = digit, X = letter or digit, S = letter/digit/'+'/'*', L = letter). Prefix included.
 * NOTE: format ≠ validity. Use VIES for existence; per-country check digits are NOT implemented here
 * except HU (NAV warns on CDV errors: INCORRECT_HEAD_DATA_CUSTOMER_COMMUNITY_VAT_NUMBER).
 */
export const EU_VAT_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^ATU[0-9]{8}$/,
  BE: /^BE[01][0-9]{9}$/,
  BG: /^BG[0-9]{9,10}$/,
  CY: /^CY[0-9]{8}[A-Z]$/,
  CZ: /^CZ[0-9]{8,10}$/,
  DE: /^DE[0-9]{9}$/,
  DK: /^DK[0-9]{8}$/,
  EE: /^EE[0-9]{9}$/,
  EL: /^EL[0-9]{9}$/, // Greece uses EL, not GR
  ES: /^ES(?=[0-9A-Z]{9}$)(?![0-9]{9}$)[0-9A-Z][0-9]{7}[0-9A-Z]$/, // first/last may be letters, not both digits
  FI: /^FI[0-9]{8}$/,
  FR: /^FR[0-9A-Z]{2}[0-9]{9}$/,
  HR: /^HR[0-9]{11}$/,
  HU: /^HU[0-9]{8}$/,
  IE: /^IE(?:[0-9][0-9A-Z+*][0-9]{5}[A-Z]|[0-9]{7}[A-Z]{2})$/,
  IT: /^IT[0-9]{11}$/,
  LT: /^LT(?:[0-9]{9}|[0-9]{12})$/,
  LU: /^LU[0-9]{8}$/,
  LV: /^LV[0-9]{11}$/,
  MT: /^MT[0-9]{8}$/,
  NL: /^NL[0-9A-Z+*]{12}$/, // in practice NL999999999B99
  PL: /^PL[0-9]{10}$/,
  PT: /^PT[0-9]{9}$/,
  RO: /^RO[0-9]{2,10}$/,
  SE: /^SE[0-9]{12}$/,
  SI: /^SI[0-9]{8}$/,
  SK: /^SK[0-9]{10}$/,
  XI: /^XI(?:[0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$/, // Northern Ireland (goods) – still in VIES
};

/** NTCA common:CommunityVatNumberType (length 4–15). */
export const NAV_COMMUNITY_VAT_RE = /^[A-Z]{2}[0-9A-Z]{2,13}$/;

export function normalizeVatNumber(input: string): string {
  return input.toUpperCase().replace(/[\s.\-]/g, '');
}

export function parseEuVatNumber(input: string): Result<{ countryCode: string; number: string; normalized: string }> {
  const n = normalizeVatNumber(input);
  const cc = n.slice(0, 2);
  if (cc === 'GR') return err('COUNTRY: Greece uses EL');
  const re = EU_VAT_FORMATS[cc];
  if (!re) return err(`COUNTRY: ${cc} is not a VIES member-state prefix`);
  if (!re.test(n)) return err(`FORMAT: does not match ${cc} structure`);
  if (cc === 'HU' && !hasValid9731(n.slice(2))) return err('CDV: HU törzsszám check digit mismatch');
  return ok({ countryCode: cc, number: n.slice(2), normalized: n });
}

/** HU közösségi adószám = "HU" + törzsszám (VAT group members: the GROUP's törzsszám!). */
export function huCommunityVatNumber(taxpayerId: string): string {
  if (!isValidTorzsszam(taxpayerId)) throw new Error('invalid törzsszám');
  return `HU${taxpayerId}`;
}

/* ------------------------------------------------------------------ */
/* 3. Adóazonosító jel (10 digits, natural persons)                    */
/* ------------------------------------------------------------------ */

const EPOCH_1867 = Date.UTC(1867, 0, 1);

export function parseAdoazonositoJel(input: string): Result<{ value: string; birthDate: string }> {
  const s = input.replace(/\s/g, '');
  if (!/^8[0-9]{9}$/.test(s)) return err('FORMAT: 10 digits starting with 8');
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (i + 1);
  const r = sum % 11;
  if (r === 10) return err('CDV: remainder 10 is never issued');
  if (r !== Number(s[9])) return err('CDV: check digit mismatch');
  const days = Number(s.slice(1, 6));
  const birthDate = new Date(EPOCH_1867 + days * 86_400_000).toISOString().slice(0, 10);
  return ok({ value: s, birthDate });
}

/* ------------------------------------------------------------------ */
/* 4. Bank accounts: pénzforgalmi jelzőszám (GIRO) and IBAN            */
/* ------------------------------------------------------------------ */

export interface HuBankAccount {
  digits: string; // 16 or 24 digits
  formatted: string; // 8-8 or 8-8-8 with hyphens (NAV BankAccountNumberType compatible)
  bankCode: string; // first 3 digits – pénzforgalmi szolgáltató azonosító
  branchCode: string; // next 4 digits
}

/**
 * 35/2017. (XII. 14.) MNB rendelet 1. melléklet 1. pont:
 *  - 1–7 → check digit 8;
 *  - 9–15 → check digit 16 (16-digit account) OR 9–23 → check digit 24 (24-digit account);
 *    in a 24-digit account digit 16 is "szabadon kialakítható" (NOT a separate check digit).
 */
export function parseHuBankAccount(input: string): Result<HuBankAccount> {
  const s = input.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]{16}([0-9]{8})?$/.test(s)) return err('FORMAT: expected 16 (2×8) or 24 (3×8) digits');
  if (!hasValid9731(s.slice(0, 8))) return err('CDV1: irányító kód (digits 1–8) check digit mismatch');
  if (!hasValid9731(s.slice(8))) return err(`CDV2: account part (digits 9–${s.length}) check digit mismatch`);
  const formatted = s.length === 16 ? `${s.slice(0, 8)}-${s.slice(8)}` : `${s.slice(0, 8)}-${s.slice(8, 16)}-${s.slice(16)}`;
  return ok({ digits: s, formatted, bankCode: s.slice(0, 3), branchCode: s.slice(3, 7) });
}

/** Stricter legacy check some tools use: 9–16 and 17–24 as separate blocks. NOT what the MNB decree says. */
export function legacyThreeBlockCheck(digits24: string): boolean {
  return hasValid9731(digits24.slice(0, 8)) && hasValid9731(digits24.slice(8, 16)) && hasValid9731(digits24.slice(16, 24));
}

/** ISO 13616 mod-97 over an arbitrary-length IBAN (no BigInt needed). */
export function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const val = code >= 65 && code <= 90 ? String(code - 55) : ch; // A=10 … Z=35
    for (const d of val) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

export function normalizeIban(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Generic IBAN structural check (country code, 2 check digits, alnum BBAN, mod 97 == 1). Length table only for a few countries. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = { HU: 28, AT: 20, DE: 22, SK: 24, RO: 24, HR: 21, SI: 19, CZ: 24, PL: 28, GB: 22, FR: 27, IT: 27, ES: 24, NL: 18, BE: 16 };

export function isValidIban(input: string): boolean {
  const s = normalizeIban(input);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const len = IBAN_LENGTHS[s.slice(0, 2)];
  if (len !== undefined && s.length !== len) return false;
  return ibanMod97(s) === 1;
}

export function computeIbanCheckDigits(countryCode: string, bban: string): string {
  const rem = ibanMod97(`${countryCode}00${bban}`);
  return String(98 - rem).padStart(2, '0');
}

/** 16-digit accounts are padded with 8 zeros (MNB rendelet 1. melléklet 2. c) pont). */
export function huAccountToIban(account: string): Result<string> {
  const a = parseHuBankAccount(account);
  if (!a.ok) return a;
  const bban = a.value.digits.padEnd(24, '0');
  return ok(`HU${computeIbanCheckDigits('HU', bban)}${bban}`);
}

/**
 * HU IBAN: HUkk + 24 digits, mod-97 AND the embedded GIRO CDVs (BBAN checked as a 24-digit account;
 * a zero-padded 16-digit account also passes). `short16` is set when the last 8 BBAN digits are zeros
 * (the same IBAN may be written as 8-8 or 8-8-00000000 – both denote the same account).
 */
export function parseHuIban(input: string): Result<{ iban: string; account: HuBankAccount; short16?: string }> {
  const s = normalizeIban(input);
  if (!/^HU[0-9]{26}$/.test(s)) return err('FORMAT: HU + 2 check digits + 24 digits');
  if (ibanMod97(s) !== 1) return err('IBAN: mod-97 check failed');
  const bban = s.slice(4);
  const acc = parseHuBankAccount(bban);
  if (!acc.ok) return acc;
  const short16 = bban.endsWith('00000000') && hasValid9731(bban.slice(8, 16)) ? `${bban.slice(0, 8)}-${bban.slice(8, 16)}` : undefined;
  return ok({ iban: s, account: acc.value, ...(short16 ? { short16 } : {}) });
}

export function formatIbanForPrint(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}

/** NTCA common:BankAccountNumberType – minLength 15, maxLength 34. */
export const NAV_BANK_ACCOUNT_RE = /^(?:[0-9]{8}[-][0-9]{8}[-][0-9]{8}|[0-9]{8}[-][0-9]{8}|[A-Z]{2}[0-9]{2}[0-9A-Za-z]{11,30})$/;
export function isNavBankAccountNumber(v: string): boolean {
  return v.length >= 15 && v.length <= 34 && NAV_BANK_ACCOUNT_RE.test(v);
}

/* ------------------------------------------------------------------ */
/* 5. Postal codes                                                     */
/* ------------------------------------------------------------------ */

export interface HuPostalCode {
  code: string;
  budapest: boolean;
  /** Budapest district (1–23) for street-address codes 1010–1239; 1007 (Margitsziget) → 13 */
  district?: number;
}

/**
 * Hungarian postal code: exactly 4 digits, first digit 1–9 (Magyar Posta list 2026-10: settlements 2000–9985,
 * Budapest street codes 1007–1239; Budapest PO-box/large-customer codes such as 1438 also exist → accepted).
 * Existence must be checked against the Magyar Posta list, not by regex.
 */
export function parseHuPostalCode(input: string): Result<HuPostalCode> {
  const code = input.trim();
  if (!/^[1-9][0-9]{3}$/.test(code)) return err('FORMAT: 4 digits, first digit 1–9');
  if (code[0] !== '1') return ok({ code, budapest: false });
  if (code === '1007') return ok({ code, budapest: true, district: 13 });
  const n = Number(code);
  const d = Number(code.slice(1, 3));
  if (n >= 1010 && n <= 1239 && d >= 1 && d <= 23) return ok({ code, budapest: true, district: d });
  return ok({ code, budapest: true }); // PO box / special Budapest code – no district encoded
}

/** NTCA common:PostalCodeType – 3..10 chars; use "0000" when a country has no postal codes. */
export const NAV_POSTAL_CODE_RE = /^[A-Z0-9][A-Z0-9\s\-]{1,8}[A-Z0-9]$/;
export function toNavPostalCode(raw: string | undefined): string {
  const v = (raw ?? '').toUpperCase().trim().replace(/\s+/g, ' ');
  return v.length >= 3 && v.length <= 10 && NAV_POSTAL_CODE_RE.test(v) ? v : '0000';
}

/* ------------------------------------------------------------------ */
/* 6. Formatting helpers (hu-HU)                                       */
/* ------------------------------------------------------------------ */

/** Default CLDR/AkH behaviour: 4-digit numbers are NOT grouped; group separator U+00A0, decimal ','. */
export function formatHuNumber(value: number, fractionDigits = 0, groupFourDigits = false): string {
  return new Intl.NumberFormat('hu-HU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: groupFourDigits ? 'always' : 'auto',
  }).format(value);
}

/** "2026. 10. 27." (AkH 12 295. pont / CLDR hu short date). Input: ISO date string YYYY-MM-DD (no TZ shift). */
export function formatHuDate(isoDate: string): string {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(isoDate);
  if (!m) throw new Error('expected YYYY-MM-DD');
  return `${m[1]}. ${m[2]}. ${m[3]}.`;
}

/* ------------------------------------------------------------------ */
/* 7. Cash rounding – 2008. évi III. törvény 2. §                      */
/* ------------------------------------------------------------------ */

/**
 * Rounds the FINAL payable HUF total for cash payment (card: only if the merchant opted in, 3. §).
 * Works in fillér integers to avoid float issues. Returns the cash amount; difference = kerekítési különbözet.
 *  a) x,01–2,49 → down to …0   b) 2,50–4,99 → up to …5   c) 5,01–7,49 → down to …5   d) 7,50–9,99 → up to …0
 * Negative totals (cash refunds) are rounded symmetrically on the absolute value (the Act is silent – policy choice).
 */
export function roundHufCash(total: number): { cash: number; difference: number } {
  const sign = total < 0 ? -1 : 1;
  const f = Math.round(Math.abs(total) * 100); // fillér
  const rem = f % 1000; // value of the last forint digit + fillér, 0..999
  let r: number;
  if (rem === 0 || rem === 500) r = f;
  else if (rem < 250) r = f - rem;
  else if (rem < 500) r = f - rem + 500;
  else if (rem < 750) r = f - rem + 500;
  else r = f - rem + 1000;
  const cash = (sign * r) / 100;
  return { cash, difference: Math.round((cash - total) * 100) / 100 };
}

/* ------------------------------------------------------------------ */
/* 8. MNB exchange rates (arfolyamok.asmx inner XML)                   */
/* ------------------------------------------------------------------ */

export interface MnbRate { date: string; currency: string; unit: number; value: string; perUnit: string }

/** Parses <MNBExchangeRates>/<MNBCurrentExchangeRates> inner XML. Values use DECIMAL COMMA and a unit (e.g. JPY per 100). */
export function parseMnbRates(innerXml: string): MnbRate[] {
  const out: MnbRate[] = [];
  const dayRe = /<Day date="([0-9]{4}-[0-9]{2}-[0-9]{2})">([\s\S]*?)<\/Day>/g;
  for (const day of innerXml.matchAll(dayRe)) {
    const rateRe = /<Rate unit="([0-9]+)" curr="([A-Z]{3})">([0-9]+(?:,[0-9]+)?)<\/Rate>/g;
    for (const r of day[2].matchAll(rateRe)) {
      const unit = Number(r[1]);
      const value = r[3].replace(',', '.');
      out.push({ date: day[1], currency: r[2], unit, value, perUnit: divideDecimal(value, unit, 6) });
    }
  }
  return out;
}

/** Exact decimal string division by an integer, rounded half-up to `scale` digits (NAV ExchangeRateType: 6 fraction digits). */
export function divideDecimal(value: string, divisor: number, scale: number): string {
  const [i, f = ''] = value.split('.');
  const scaled = BigInt(i + f.padEnd(scale + 1, '0').slice(0, scale + 1)); // one guard digit
  let q = scaled / BigInt(divisor);
  q = (q + 5n) / 10n; // half-up on the guard digit (positive values only)
  const s = q.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, '') || '0';
}

/** Áfa tv. 80. § (2): the LAST rate valid at the given date → latest published date <= target. */
export function pickRateForDate(rates: MnbRate[], currency: string, isoDate: string): MnbRate | undefined {
  return rates
    .filter(r => r.currency === currency && r.date <= isoDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}
```

### 12.2 `hu-validators.test.ts` (tesztesetek és elvárt eredmények)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cdv9731, parseHuTaxNumber, toNavTaxNumberType, parseEuVatNumber, huCommunityVatNumber,
  parseAdoazonositoJel, parseHuBankAccount, legacyThreeBlockCheck, huAccountToIban, parseHuIban,
  isValidIban, isNavBankAccountNumber, parseHuPostalCode, toNavPostalCode, formatHuNumber, formatHuDate,
  roundHufCash, parseMnbRates, pickRateForDate, divideDecimal, NAV_COMMUNITY_VAT_RE,
} from './hu-validators.ts';

const NBSP = ' ';

test('1. adószám – real, publicly listed tax numbers', () => {
  const real: Array<[string, string]> = [
    ['15789934-2-51', 'NAV (nav.gov.hu 2014-es beszámoló, parlament.hu)'],
    ['10625790-4-44', 'MOL Nyrt. (törzsszám = KSH-számjel eleje; CDV=0 eset)'],
    ['10537914-4-44', 'OTP Bank Nyrt. (otpbank.hu impresszum)'],
    ['17780010-5-44', 'OTP áfacsoport csoportazonosító (otpbank.hu impresszum)'],
    ['10773381-2-44', 'Magyar Telekom Nyrt. (telekom.hu impresszum)'],
    ['10484878-2-44', 'Richter Gedeon Nyrt. (2008-as éves jelentés)'],
  ];
  for (const [n, who] of real) {
    const r = parseHuTaxNumber(n);
    assert.ok(r.ok, `${n} ${who}: ${!r.ok ? r.error : ''}`);
    console.log(`  OK  ${n.padEnd(14)} CDV(${n.slice(0, 7)})=${cdv9731(n.slice(0, 7))}  ${who}`);
  }
  const otpGroup = parseHuTaxNumber('17780010-5-44');
  assert.ok(otpGroup.ok && otpGroup.value.vatCodeMeaning === 'CSOPORTAZONOSITO');
  const mol = parseHuTaxNumber('10625790-4-44');
  assert.ok(mol.ok && mol.value.vatCodeMeaning === 'CSOPORTTAG');
});

test('1. adószám – formats and failures', () => {
  assert.deepEqual(parseHuTaxNumber('10773381 2 44'), parseHuTaxNumber('10773381-2-44'));
  assert.deepEqual(parseHuTaxNumber('10773381244'), parseHuTaxNumber('10773381-2-44'));
  const bare = parseHuTaxNumber('10773381');
  assert.ok(bare.ok && bare.value.vatCode === undefined);
  const fail = (s: string, code: string) => { const r = parseHuTaxNumber(s); assert.ok(!r.ok && r.error.startsWith(code), `${s} -> ${JSON.stringify(r)}`); };
  fail('10773382-2-44', 'CDV');
  fail('15789934-6-51', 'VATCODE');
  fail('15789934-0-51', 'VATCODE');
  fail('15789934-2-21', 'COUNTY');
  fail('15789934-2-01', 'COUNTY');
  fail('15789934-2-45', 'COUNTY');
  fail('1578993-2-51', 'FORMAT');
  fail('15789934-2-5', 'FORMAT');
  const r = parseHuTaxNumber('10773381-2-44');
  assert.ok(r.ok);
  assert.deepEqual(toNavTaxNumberType(r.value), { taxpayerId: '10773381', vatCode: '2', countyCode: '44' });
});

test('2. közösségi adószám / EU VAT formats', () => {
  for (const v of ['HU10773381', 'hu 1077 3381', 'HU17780010', 'HU10484878', 'ATU12345678', 'BE0123456749', 'BE1234567890',
    'DE123456789', 'DK12345678', 'EL123456789', 'ESX1234567X', 'ES12345678Z', 'FRXX123456789', 'FR12345678901',
    'IE1234567WA', 'IE1A23456B', 'NL123456789B01', 'PL1234567890', 'RO12', 'SE123456789001', 'XI123456789', 'XIGD123']) {
    const r = parseEuVatNumber(v);
    assert.ok(r.ok, `${v}: ${!r.ok ? r.error : ''}`);
    assert.ok(NAV_COMMUNITY_VAT_RE.test(r.value.normalized), `NAV pattern ${v}`);
  }
  const fail = (s: string, code: string) => { const r = parseEuVatNumber(s); assert.ok(!r.ok && r.error.startsWith(code), `${s} -> ${JSON.stringify(r)}`); };
  fail('HU10773382', 'CDV');
  fail('GR123456789', 'COUNTRY');
  fail('GB123456789', 'COUNTRY'); // not in VIES since Brexit (except XI)
  fail('ES123456789', 'FORMAT'); // first and last both digits
  fail('ATU1234567', 'FORMAT');
  fail('HU1077338', 'FORMAT');
  assert.equal(huCommunityVatNumber('17780010'), 'HU17780010');
});

test('3. adóazonosító jel (synthetic values only)', () => {
  const r = parseAdoazonositoJel('8123456786'); // 8,1,2,3,4,5,6,7,8 → Σ d_i·i = 248 → 248 mod 11 = 6
  assert.ok(r.ok);
  assert.equal(r.value.birthDate, '1900-10-20'); // 12345 days after 1867-01-01
  assert.ok(!parseAdoazonositoJel('8123456787').ok);
  assert.ok(!parseAdoazonositoJel('7123456786').ok);
  assert.ok(!parseAdoazonositoJel('812345678').ok);
  // build a synthetic ID for 1980-05-17, sequence 123
  const days = (Date.UTC(1980, 4, 17) - Date.UTC(1867, 0, 1)) / 86_400_000;
  const nine = `8${String(days).padStart(5, '0')}123`;
  let sum = 0; for (let i = 0; i < 9; i++) sum += Number(nine[i]) * (i + 1);
  if (sum % 11 !== 10) {
    const id = nine + String(sum % 11);
    const p = parseAdoazonositoJel(id);
    assert.ok(p.ok && p.value.birthDate === '1980-05-17', id);
    console.log(`  synthetic adóazonosító for 1980-05-17/123: ${id}`);
  }
  // remainder-10 case must be rejected for any check digit
  for (let seq = 0; seq < 1000; seq++) {
    const n9 = `8${String(days).padStart(5, '0')}${String(seq).padStart(3, '0')}`;
    let s = 0; for (let i = 0; i < 9; i++) s += Number(n9[i]) * (i + 1);
    if (s % 11 === 10) { for (let c = 0; c <= 9; c++) assert.ok(!parseAdoazonositoJel(n9 + c).ok); console.log(`  remainder-10 sequence rejected: ${n9}x`); break; }
  }
});

test('4. bank accounts – NAV official collection accounts (valid from 2026-07-01)', () => {
  const fx = JSON.parse(readFileSync(new URL('./nav-accounts.fixture.json', import.meta.url), 'utf8')) as { accounts: string[]; ibans: string[] };
  const ibanSet = new Set(fx.ibans);
  let n16 = 0, n24 = 0, legacyFail: string[] = [];
  for (const a of fx.accounts) {
    const r = parseHuBankAccount(a);
    assert.ok(r.ok, `${a}: ${!r.ok ? r.error : ''}`);
    const iban = huAccountToIban(a);
    assert.ok(iban.ok && ibanSet.has(iban.value), `${a} -> ${iban.ok ? iban.value : ''} not in NAV IBAN list`);
    if (r.value.digits.length === 16) n16++; else { n24++; if (!legacyThreeBlockCheck(r.value.digits)) legacyFail.push(a); }
  }
  for (const i of fx.ibans) assert.ok(parseHuIban(i).ok && isValidIban(i), i);
  console.log(`  ${fx.accounts.length} NAV accounts OK (${n16}×16, ${n24}×24); ${fx.ibans.length} IBANs OK; legacy 3-block check would reject ${legacyFail.length}: ${legacyFail.join(', ')}`);
});

test('4. bank accounts – examples and failures', () => {
  assert.equal((huAccountToIban('10032000-01076019') as { value: string }).value, 'HU57100320000107601900000000'); // NAV 101 TAO
  assert.equal((huAccountToIban('10032000-01076868') as { value: string }).value, 'HU68100320000107686800000000'); // NAV 104 ÁFA
  const reg = parseHuIban('HU42 1177 3016 1111 1018 0000 0000'); // SWIFT IBAN registry example for HU
  assert.ok(reg.ok && reg.value.short16 === '11773016-11111018');
  assert.ok(!parseHuBankAccount('10032001-01076019').ok); // CDV1
  assert.ok(!parseHuBankAccount('10032000-01076018').ok); // CDV2
  assert.ok(!parseHuBankAccount('10032000-0107601').ok); // FORMAT
  assert.ok(!parseHuIban('HU58100320000107601900000000').ok); // mod-97
  assert.ok(isValidIban('DE89370400440532013000'));
  assert.ok(isValidIban('GB82WEST12345698765432'));
  assert.ok(!isValidIban('GB82WEST12345698765433'));
  assert.ok(isNavBankAccountNumber('10032000-01076019'));
  assert.ok(isNavBankAccountNumber('10032000-00009722-05020029'));
  assert.ok(isNavBankAccountNumber('HU57100320000107601900000000'));
  assert.ok(!isNavBankAccountNumber('1003200001076019')); // NAV wants hyphens for GIRO form
  assert.ok(!isNavBankAccountNumber('HU57 1003 2000 0107 6019 0000 0000')); // no spaces in XML
});

test('5. postal codes', () => {
  const cases: Array<[string, boolean, number | undefined]> = [
    ['1011', true, 1], ['1051', true, 5], ['1054', true, 5], ['1097', true, 9], ['1117', true, 11], ['1239', true, 23],
    ['1007', true, 13], ['1438', true, undefined], ['9400', false, undefined], ['2000', false, undefined],
  ];
  for (const [c, bp, d] of cases) {
    const r = parseHuPostalCode(c);
    assert.ok(r.ok && r.value.budapest === bp && r.value.district === d, `${c} -> ${JSON.stringify(r)}`);
  }
  for (const bad of ['0123', '123', '12345', '1O11', '']) assert.ok(!parseHuPostalCode(bad).ok, bad);
  assert.equal(toNavPostalCode('D02 X285'), 'D02 X285');
  assert.equal(toNavPostalCode('sw1a 1aa'), 'SW1A 1AA');
  assert.equal(toNavPostalCode(''), '0000');
  assert.equal(toNavPostalCode(undefined), '0000');
});

test('6. formatting (Node 24 / ICU)', () => {
  assert.equal(formatHuNumber(1234), '1234');
  assert.equal(formatHuNumber(12345), `12${NBSP}345`);
  assert.equal(formatHuNumber(1234.5, 2), '1234,50');
  assert.equal(formatHuNumber(1234, 0, true), `1${NBSP}234`);
  assert.equal(formatHuNumber(1234567.891, 2), `1${NBSP}234${NBSP}567,89`);
  assert.equal(formatHuDate('2026-10-27'), '2026. 10. 27.');
  assert.equal(new Intl.NumberFormat('hu-HU', { style: 'currency', currency: 'HUF' }).format(1234567.5), `1${NBSP}234${NBSP}568${NBSP}Ft`); // HUF → 0 decimals by default!
});

test('7. cash rounding (2008. évi III. tv. 2. §)', () => {
  const cases: Array<[number, number]> = [[127, 125], [128, 130], [122.49, 120], [122.5, 125], [1234, 1235], [1236, 1235],
    [1237.49, 1235], [1237.5, 1240], [1240, 1240], [1245, 1245], [1241, 1240], [1242.49, 1240], [1249.99, 1250], [0.01, 0], [-127, -125]];
  for (const [inp, exp] of cases) assert.equal(roundHufCash(inp).cash, exp, String(inp));
  assert.equal(roundHufCash(127).difference, -2);
});

test('8. MNB rate parsing + date fallback', () => {
  const xml = '<MNBExchangeRates><Day date="2026-10-27"><Rate unit="1" curr="EUR">367,14</Rate><Rate unit="100" curr="JPY">208,89</Rate></Day><Day date="2026-10-26"><Rate unit="1" curr="EUR">366,95000</Rate></Day><Day date="2026-10-22"><Rate unit="1" curr="EUR">366,52000</Rate><Rate unit="1" curr="HKD">42</Rate></Day></MNBExchangeRates>';
  const rates = parseMnbRates(xml);
  assert.equal(rates.length, 5);
  assert.equal(rates.find(r => r.currency === 'JPY')!.perUnit, '2.0889');
  assert.equal(rates.find(r => r.currency === 'HKD')!.perUnit, '42');
  assert.equal(pickRateForDate(rates, 'EUR', '2026-10-25')!.date, '2026-10-22'); // Oct 23 holiday + weekend → last published
  assert.equal(pickRateForDate(rates, 'EUR', '2026-10-27')!.value, '367.14');
  assert.equal(divideDecimal('1.82', 100, 6), '0.0182');
});
```

### 12.3 Futási eredmény (Node v24.19.0, 2026-10-27)

```text
  OK  15789934-2-51  CDV(1578993)=4  NAV (nav.gov.hu 2014-es beszámoló, parlament.hu)
  OK  10625790-4-44  CDV(1062579)=0  MOL Nyrt. (törzsszám = KSH-számjel eleje; CDV=0 eset)
  OK  10537914-4-44  CDV(1053791)=4  OTP Bank Nyrt. (otpbank.hu impresszum)
  OK  17780010-5-44  CDV(1778001)=0  OTP áfacsoport csoportazonosító (otpbank.hu impresszum)
  OK  10773381-2-44  CDV(1077338)=1  Magyar Telekom Nyrt. (telekom.hu impresszum)
  OK  10484878-2-44  CDV(1048487)=8  Richter Gedeon Nyrt. (2008-as éves jelentés)
  synthetic adóazonosító for 1980-05-17/123: 8414091237
  remainder-10 sequence rejected: 841409001x
  123 NAV accounts OK (108×16, 15×24); 125 IBANs OK; legacy 3-block check would reject 1: 10032000-00009722-05020029
✔ 1. adószám – real, publicly listed tax numbers (1.4446ms)
✔ 1. adószám – formats and failures (0.5125ms)
✔ 2. közösségi adószám / EU VAT formats (0.3972ms)
✔ 3. adóazonosító jel (synthetic values only) (1.3321ms)
✔ 4. bank accounts – NAV official collection accounts (valid from 2026-07-01) (2.9269ms)
✔ 4. bank accounts – examples and failures (0.1952ms)
✔ 5. postal codes (0.2347ms)
✔ 6. formatting (Node 24 / ICU) (8.9272ms)
✔ 7. cash rounding (2008. évi III. tv. 2. §) (0.1892ms)
✔ 8. MNB rate parsing + date fallback (0.3716ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 105.7244
```

### 12.4 Élő kliensek (VIES REST + MNB SOAP) – `live-clients.ts`

```ts
// Live smoke test for the VIES REST API and the MNB SOAP service (run: node live-clients.ts)
import { parseMnbRates, pickRateForDate } from './hu-validators.ts';

export type ViesResult =
  | { status: 'VALID' | 'INVALID'; countryCode: string; vatNumber: string; name?: string; address?: string; requestDate: string; requestIdentifier?: string }
  | { status: 'ERROR'; error: string }; // e.g. MS_UNAVAILABLE, MS_MAX_CONCURRENT_REQ, GLOBAL_MAX_CONCURRENT_REQ, TIMEOUT, INVALID_INPUT

const VIES = 'https://ec.europa.eu/taxation_customs/vies/rest-api';

export async function checkVies(countryCode: string, vatNumber: string, requester?: { cc: string; number: string }): Promise<ViesResult> {
  const body: Record<string, string> = { countryCode, vatNumber };
  if (requester) { body.requesterMemberStateCode = requester.cc; body.requesterNumber = requester.number; } // → requestIdentifier (consultation number)
  const r = await fetch(`${VIES}/check-vat-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as Record<string, unknown>;
  // Errors may come with HTTP 200 *or* 4xx/5xx: { actionSucceed:false, errorWrappers:[{error:'...'}] }
  if (j.actionSucceed === false || !('valid' in j)) {
    const ew = (j.errorWrappers as Array<{ error: string }> | undefined)?.[0]?.error ?? `HTTP_${r.status}`;
    return { status: 'ERROR', error: ew };
  }
  const clean = (v: unknown) => (typeof v === 'string' && v !== '---' && v !== '' ? v : undefined);
  return {
    status: j.valid ? 'VALID' : 'INVALID',
    countryCode: String(j.countryCode), vatNumber: String(j.vatNumber),
    name: clean(j.name), address: clean(j.address), requestDate: String(j.requestDate),
    requestIdentifier: clean(j.requestIdentifier),
  };
}

// MNB: SOAP 1.1, document/literal. NOTE (2026-10-27): POST works only on http://, https:// returns 404.
const MNB = 'http://www.mnb.hu/arfolyamok.asmx';
const MNB_NS = 'http://www.mnb.hu/webservices/';
export async function mnbCall(op: 'GetCurrentExchangeRates' | 'GetExchangeRates' | 'GetCurrencyUnits' | 'GetInfo' | 'GetDateInterval' | 'GetCurrencies', params: Record<string, string> = {}): Promise<string> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const inner = Object.entries(params).map(([k, v]) => `<web:${k}>${esc(v)}</web:${k}>`).join('');
  const env = `<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="${MNB_NS}"><soapenv:Body><web:${op}>${inner}</web:${op}></soapenv:Body></soapenv:Envelope>`;
  const r = await fetch(MNB, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${MNB_NS}MNBArfolyamServiceSoap/${op}"` }, body: env, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`MNB HTTP ${r.status}`);
  const xml = await r.text();
  const a = xml.indexOf(`<${op}Result>`), b = xml.indexOf(`</${op}Result>`);
  if (a < 0 || b < 0) throw new Error('MNB: no result element');
  return xml.slice(a + op.length + 8, b).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

if (import.meta.main ?? process.argv[1]?.endsWith('live-clients.ts')) {
  console.log(await checkVies('HU', '10773381'));
  console.log(await checkVies('HU', '17780010'));
  console.log(await checkVies('HU', '12345676'));
  console.log(await checkVies('XX', '123'));
  const inner = await mnbCall('GetExchangeRates', { startDate: '2026-10-20', endDate: '2026-10-27', currencyNames: 'EUR,JPY' });
  const rates = parseMnbRates(inner);
  console.log(rates);
  console.log('EUR for 2026-10-24 (Saturday):', pickRateForDate(rates, 'EUR', '2026-10-24'));
  console.log('EUR for 2026-10-23 (national holiday):', pickRateForDate(rates, 'EUR', '2026-10-23'));
}
```

Kimenet (rövidítve, 2026-10-27): `HU 10773381` → `VALID`, „MAGYAR TELEKOM TÁVKÖZLÉSI NYILVÁNOSAN MŰKÖDŐ RÉSZVÉNYTÁRSASÁG";
`HU 17780010` → `VALID` („Áfa csoport / VAT Group"); `HU 12345676` → `INVALID`; `XX 123` → `ERROR INVALID_INPUT`;
MNB 2026-10-20…27, EUR+JPY → 10 árfolyam, JPY `perUnit: '2.0889'`; EUR 2026-10-24-re és 10-23-ra → a 2026-10-22-i `366.52`.

### 12.5 Tesztadat: a NAV-lista mind a 15 darab 24 jegyű számlaszáma [F14]

| Belföldi (3×8) | IBAN (számított = NAV-listában) | NAV-listában? | „3 × 8 külön blokk" ellenőrzés |
|---|---|---|---|
| `10032000-01070044-09060018` | `HU58100320000107004409060018` | igen | átmegy |
| `10032000-01076277-09060025` | `HU96100320000107627709060025` | igen | átmegy |
| `10032000-01076277-09060032` | `HU04100320000107627709060032` | igen | átmegy |
| `10032000-01076040-09060018` | `HU42100320000107604009060018` | igen | átmegy |
| `10032000-01076019-09060018` | `HU88100320000107601909060018` | igen | átmegy |
| `10032000-01076150-09050019` | `HU54100320000107615009050019` | igen | átmegy |
| `10032000-01076277-09060018` | `HU91100320000107627709060018` | igen | átmegy |
| `10032000-01037629-09050019` | `HU11100320000103762909050019` | igen | átmegy |
| `10032000-01076019-09060025` | `HU93100320000107601909060025` | igen | átmegy |
| `10032000-01076019-09060032` | `HU98100320000107601909060032` | igen | átmegy |
| `10032000-01076019-09050019` | `HU13100320000107601909050019` | igen | átmegy |
| `10032000-01076019-09050026` | `HU18100320000107601909050026` | igen | átmegy |
| `10032000-00362186-50000012` | `HU91100320000036218650000012` | igen | átmegy |
| `10032000-01220122-05020797` | `HU45100320000122012205020797` | igen | átmegy |
| `10032000-00009722-05020029` | `HU79100320000000972205020029` | igen | **elbukna** (a rendelet szerint érvényes) |

A PDF-ben két IBAN (`HU52100320000107908100000000`, `HU94100320000107629100000000`) mellől a szövegkinyerés nem adott belföldi
párt; mindkettő érvényes IBAN és érvényes BBAN-CDV.

---

## 13. Eltérések a jelenlegi kódvázhoz képest (2026-10-27-i állapot, csak olvasva)

| Fájl | Megállapítás | Javaslat |
|---|---|---|
| `src/mnb/rates.ts` | a végpont még nincs rögzítve | `http://www.mnb.hu/arfolyamok.asmx` (https → 404); egységosztás; tizedesvessző |
| `src/core/vat.ts` | `NavVatRate` nem ismeri a `noVatCharge`, `vatAmountMismatch`, `vatContent` ágakat | felvenni vagy dokumentáltan „nem támogatott"-nak jelölni |
| `src/core/vat.ts` `'0'` | nincs megkötés a 3/B. körre és a ≥ 2024-01-01 teljesítésre | validáció + figyelmeztető leírás („nem adómentesség") |
| `src/core/vat.ts` `KUL_UTAZAS` | `rate: '0'` → a NAV-adatba 0 áfa kerülne | 210/A. § (3): a NAV-adatnak tartalmaznia kell a forintos adóalapot és áfát → árrés-adat bekérése vagy a kód letiltása az első verzióban |
| `src/core/format.ts` | minden 4+ jegyű számot csoportosít, dátum `2026.10.27.` | elfogadható (tudatos döntés); az AkH-forma `1234 Ft`, `2026. 10. 27.` – dokumentálni |
| `src/core/units.ts` | az enum és az aliasok megfelelnek a 9. fejezetnek | `m2/m²`, `g`, `év`, `alkalom` maradjon `OWN` |
| `src/core/numbering.ts` | karakterkészlet és `yearlyReset ⇒ {YYYY}/{YY}` szabály egyezik | adatbázis-szintű egyedi index: (eladó adószám, sorszám) **minden** tartományon át |

> ⚠️ Javítva (verifikáció): a `src/mnb/rates.ts` sora elavult – a fájl a verifikáció idején (2026-10-27) már a
> `http://www.mnb.hu/arfolyamok.asmx` végpontot használja (`DEFAULT_ENDPOINT`). A `vat.ts` (nincs `noVatCharge`/`vatAmountMismatch`/
> `vatContent` ág; `KUL_UTAZAS` `rate: '0'`), a `units.ts` (16 enum) és a `numbering.ts` (karakterkészlet, `yearlyReset`) sorai a
> jelenlegi kódban is fennállnak; a `format.ts` sort nem ellenőriztem – forrás: a munkakönyvtár `src/` fájljai.

---

## 14. Nyitott kérdések, nem ellenőrzött állítások

* Áfakód `1` és `2` pontos hivatalos definíciója: elsődleges NAV-táblát nem találtam (csak Wikipédia + archivált NAV-oldal hivatkozás). **[közepes]**
* NAV álláspont a munkanapon 11:00 előtt kiállított devizás számla árfolyamáról: csak másodlagos forrás. **[alacsony]**
* VIES `requestIdentifier` (konzultációs szám) élő próbája saját áfaszámmal – nem futtattam.
* `INCORRECT_HEAD_DATA_CUSTOMER_COMMUNITY_VAT_NUMBER` WARN: a 3.0 változásnapló töröltnek mondja, a WARN-katalógus listázza.
* Új lakások 5 %-a: az őszi (2026) adócsomag módosíthatja – 2026-10-27-ig nem találtam kihirdetett szöveget.
* MNB `https` végpont: a 404 lehet átmeneti; a WSDL maga https-en elérhető.

---

## 15. Források

| ID | Forrás | URL | Állapot / lekérve |
|---|---|---|---|
| F1 | NAV Online-Invoice repo: `invoiceData.xsd`, `invoiceBase.xsd`, `invoiceApi.xsd` (v3.0) | https://github.com/nav-gov-hu/Online-Invoice/tree/master/src/schemas/nav/gov/hu/OSA | master `cc7a775` (2026-02-13); lekérve 2026-10-27 |
| F2 | NTCA `common.xsd` 1.0 (nav-gov-hu/Common, tag `common-1.0.0`) | https://github.com/nav-gov-hu/Common/blob/common-1.0.0/schemas/src/main/resources/xsd/hu/gov/nav/schemas/NTCA/1.0/common/common.xsd | lekérve 2026-10-27 |
| F3 | Online Számla interfész specifikáció HU v3.0 (2026.02.12) | https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu | 2026.02.12-i PDF; lekérve 2026-10-27 |
| F4 | NAV Online Számla – Technikai kérdések és válaszok (II.17, II.22, II.24, II.36) | https://onlineszamla.nav.gov.hu/technikai_kerdesek_valaszok (CMS: `/api/menu-items/link/technikai_kerdesek_valaszok?lang=hu`) | módosítva 2025-03-24; lekérve 2026-10-27 |
| F5 | 2007. évi CXXVII. tv. (Áfa tv.) | https://njt.jog.gov.hu/jogszabaly/2007-127-00-00 (2026.09.15. állapot, 1–220. §); https://net.jogtar.hu/jogszabaly?docid=a0700127.tv (2026.IX.15–XII.31. és 2027.I.1– időállapot; mellékletek, átmeneti §-ok) | lekérve 2026-10-27 |
| F6 | 1996. évi XX. tv. 1. számú melléklet | https://njt.jog.gov.hu/jogszabaly/1996-20-00-00 | 2026.10.01. állapot |
| F7 | 2008. évi III. tv. (kerekítés) | https://njt.jog.gov.hu/jogszabaly/2008-3-00-00 | hatályos szöveg, lekérve 2026-10-27 |
| F8 | 35/2017. (XII. 14.) MNB rendelet, 1. melléklet | https://njt.jog.gov.hu/jogszabaly/2017-35-20-2C | 2026.01.31. állapot |
| F9 | 23/2014. (VI. 30.) NGM rendelet (Számlarendelet) 8. § | https://njt.jog.gov.hu/jogszabaly/2014-23-20-2X | 2026.01.01. állapot |
| F10 | 322/2024. (XI. 6.) Korm. rendelet 5. melléklet; 345/2014. (XII. 23.) Korm. rendelet (hatályon kívül 2024-11-07) | https://njt.jog.gov.hu/jogszabaly/2024-322-20-22 ; https://njt.jog.gov.hu/jogszabaly/2014-345-20-22 | 2026.10.23. állapot |
| F11 | Céginformációs Szolgálat: Adószám és adóazonosító ellenőrzése (2018) | https://web.archive.org/web/20200622115229/https://ceginformaciosszolgalat.kormany.hu/download/4/27/02000/adoszam_adoazonosito_ellenorzes_2018.pdf | archív 2020-06-22 |
| F12 | NAV 18. információs füzet: A számla, nyugta kibocsátásának alapvető szabályai | https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2Frejtett%2FInformacios-fuzetek---Aktualis%2F18.-informacios-fuzet---A-szamla-nyugta-kibocsatasanak-alapveto-szabalyai | közzétéve 2026-03-02 |
| F13 | NAV: Új, 0%-os adómérték a számlaadat-szolgáltatásban 2024-től | https://nav.gov.hu/ado/afa/Uj_0_-os_adomertek_a_szamlaadat-szolgaltatasban_2024-tol | 2023-12-20 |
| F14 | NAV adóztatási számlaszámok, IBAN-ok (oldal + PDF) | https://nav.gov.hu/ugyfeliranytu/szamlaszamok/szamlaszamok/nav-adoztatasi-szamlaszamok ; PDF: https://nav.gov.hu/pfile/file?path=/ugyfeliranytu/szamlaszamok/szamlaszamok/adoztatasi-szamlaszamok-iban-szamlaszamok-es-adonemek-jegyzeke-pdf | érvényes 2026-07-01-től; oldal 2026-07-30 |
| F15 | VIES: REST swagger, WSDL, FAQ-táblázat (translations), élő hívások | https://ec.europa.eu/assets/taxud/vow-information/swagger_publicVAT.yaml ; https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl ; https://ec.europa.eu/taxation_customs/vies/rest-api/translations?lang=en | lekérve/futtatva 2026-10-27 |
| F16 | MNB árfolyam-webszolgáltatás (WSDL + élő hívások) | https://www.mnb.hu/arfolyamok.asmx?wsdl | futtatva 2026-10-27 |
| F17 | MNB: A hivatalos devizaárfolyamok megállapítása és publikálása | https://www.mnb.hu/statisztika/statisztikai-adatok-informaciok/adatok-idosorok/arfolyamok-lekerdezese/a-hivatalos-devizaarfolyamok-megallapitasa-es-publikalasa | lekérve 2026-10-27 |
| F18 | Magyar Posta irányítószám-jegyzék (XLSX) | https://www.posta.hu/static/internet/download/Iranyitoszam-Internet_uj.xlsx | Last-Modified 2026-10-12 |
| F19 | A magyar helyesírás szabályai, 12. kiadás (274., 294., 295. pont, rövidítésjegyzék) | https://helyesiras.mta.hu/helyesiras/default/akh12 | lekérve 2026-10-27 |
| F20 | Adószám-források: OTP impresszum; Telekom impresszum; Richter 2008-as éves jelentés; NAV 2014-es szöveges beszámoló; MOL 2021-es éves jelentés | https://www.otpbank.hu/portal/en/Disclaimer ; https://www.telekom.hu/rolunk/impresszum ; https://www.gedeonrichter.com/-/media/sites/hq/documents/investors/financial-reports/annual-report/hu/2008/richterevesjelentes2008.pdf ; https://nav.gov.hu/pfile/file?path=%2Fkozadat%2Faltalanos_kozzeteteli_lista%2F3_2_koltsegvetesek_beszamolok%2Fa_koltsegvetes_vegrehajtasa%2Fld_koltsegvetes_vegrehajtas%2FNAV_szoveges_beszamolo_2014.07.10. ; https://bet.hu/newkibdata/128715302/MOL_plc_Parent_Annual_Report_2021_hun.pdf | lekérve 2026-10-27 |
| F21 | Számlázz.hu Számla Agent – áfakulcsok (szállítói dok.) | https://docs.szamlazz.hu/agent/generating_invoice/vat-rates | lekérve 2026-10-27 |
| F22 | NAV Online Számlázó program felhasználói kézikönyv v0.18 | https://onlineszamla.nav.gov.hu/api/files/container/download/OnlineSzamlazoProgram_FHK_v0.18.pdf | lekérve 2026-10-27 |
| F23 | Saját futtatás: Node v24.19.0, ICU 78.3, CLDR 48.0, tz 2026b | – | 2026-10-27 |
| F24 | Világgazdaság: Új lakások 5 százalékos áfája … (másodlagos) | https://www.vg.hu/vilaggazdasag-magyar-gazdasag/2026/09/uj-lakasok-5-szazalekos-afa-27-szazalek-tisza-kormany | 2026-09-28 |
| F25 | Wikipédia: Adószám (csak az áfakód 1–3 jelentéséhez, másodlagos) | https://hu.wikipedia.org/wiki/Ad%C3%B3sz%C3%A1m | lekérve 2026-10-27 |

---

## Implementációs teendők

**MUST**

1. `parseHuTaxNumber` (`src/core/validate.ts`): 8 jegy CDV `9,7,3,1,9,7,3` + `(10 − Σ mod 10) mod 10`; áfakód `[1-5]`; megyekód
   `02–20 | 22–44 | 51`; elfogad `12345678-1-23`, `12345678123`, szóközös alakot és csak 8 jegyű törzsszámot (169. § dc)); a
   12.1-es kód és a 6 valós teszteset kerüljön a projekt tesztjei közé.
2. Csoportos áfaalanynál: eladó `supplierTaxNumber` = csoportazonosító (áfakód 5), `groupMemberTaxNumber` = tag (áfakód 4); eladónál
   áfakód 4 → validációs hiba; közösségi adószám = `HU` + **csoport** törzsszáma.
3. `parseEuVatNumber`: normalizálás (nagybetű; szóköz, pont, kötőjel törlése), a 2.2-es tagállami regexek, `HU`-nál CDV, `GR`
   prefix → javaslat `EL`-re, `GB` → hiba (nem VIES), `XI` engedett; a NAV-mintának (`[A-Z]{2}[0-9A-Z]{2,13}`) is feleljen meg.
4. VIES-kliens: `POST …/rest-api/check-vat-number`; ágaztatás a **törzs** alapján (`actionSucceed:false` → `errorWrappers[0].error`);
   `MS_UNAVAILABLE`, `TIMEOUT`, `SERVICE_UNAVAILABLE`, `*_MAX_CONCURRENT_REQ*` = **ismeretlen** (újrapróbálás backoff-fal), nem érvénytelen;
   az eredményt (dátum, név, cím, `requestIdentifier`) a vevőhöz/számlához bizonyítékként mentsük; KBAET/EUFAD37 kiállítás előtt
   ellenőrizzünk.
5. `parseBankAccount`: 16 vagy 24 jegy; CDV az **1–8.** és a **9–16. ill. 9–24.** jegyekre (24 jegynél egyetlen blokk, a 16. jegy
   szabad) – **nem** három külön blokk; NAV-ba `8-8` / `8-8-8` kötőjellel, IBAN szóköz nélkül; `HU` IBAN-nál mod 97 **és** BBAN-CDV;
   GIRO → IBAN: 16 jegynél 8 nullás kitöltés.
6. `isValidPostalCode('HU', …)`: `^[1-9][0-9]{3}$`; Budapest (`1xxx`) kerületet csak 1010–1239 között képezzünk (`1007` → XIII.);
   1000–1999 PO-box kódokat ne utasítsuk el; külföldre a NAV-minta, értelmezhetetlennél `0000`.
7. `vat.ts`: a 8.3-as táblázat szerinti NAV-ág és `case`; a `0` kódot csak 3/B. körre és ≥ 2024-01-01 teljesítésre engedni (sem
   AAM, sem tárgyi mentesség helyett); SIMPLIFIED számlán `vatContent` (0.2126/0.1525/0.0476/0), NORMAL/AGGREGATE-en `vatPercentage`;
   `case=UNKNOWN` csak 3.0 előtti/előzmény nélküli módosításnál.
8. Kötelező számlaszövegek: „fordított adózás" (`FAD`, `EUFAD37`, `EUFADE`), a négy különbözeti kifejezés szó szerint (169. § p)–q)),
   adómentességnél jogszabályi hivatkozás (169. § m)), „pénzforgalmi elszámolás", „önszámlázás" – a NAV `reason` mezőbe ugyanaz (≤ 200).
9. Vevőstátusz-szabályok (NAV ERROR): KBAET/EUFAD37/EUFADE → `customerVatStatus=OTHER`; KBAUK → `PRIVATE_PERSON|OTHER`; `FAD` →
   magyar adószám kötelező; `PRIVATE_PERSON` → a NAV-XML-ben nincs vevőnév/-cím.
10. `MnbClient`: végpont `http://www.mnb.hu/arfolyamok.asmx` (https POST → 404), `GetExchangeRates(startDate=d−14, endDate=d, currencyNames)`,
    escape-elt belső XML dekódolása, **tizedesvessző → pont**, osztás a `unit`-tal (6 tizedesre), a `d`-nél nem későbbi legutolsó nap;
    üres válasznál `MNB_RATE_NOT_FOUND`. Mivel TLS nincs: plauzibilitás-ellenőrzés (a NAV-sávok, ±10 % az előző naphoz) és
    gyorsítótárazás SQLite-ban.
11. Árfolyam-dátum a 10.1-es táblázat szerint (teljesítés / előleg jóváírása / 58. §: számla kelte / 60. §: legkorábbi esemény);
    a számlán és DB-ben tároljuk: forrás (`BANK|MNB|ECB`), közzétételi dátum, eredeti (`unit`) és normalizált érték; HUF-számlán `exchangeRate=1`.
12. Árfolyamforrás-beállítás: alapértelmezés a törvény szerint a hitelintézeti eladási árfolyam; MNB/EKB csak NAV-bejelentés
    rögzítése után, év végéig (+1 év) nem váltható.
13. Mennyiségi egység: a 9. fejezet táblázata; `OWN` esetén `unitOfMeasureOwn` kötelező (ERROR 65); mértékegységet ne konvertáljunk.
14. Sorszám: kiosztás csak lezáráskor, `BEGIN IMMEDIATE`-ben; DB-szintű egyedi index (eladó törzsszám, `invoiceNumber`) minden
    tartományon át; elején/végén whitespace tilos; ≤ 50 karakter; `yearlyReset` csak `{YYYY}`/`{YY}` mintával; külföldi adószámhoz
    külön tartomány (Számlarendelet 8. § (2)).
15. Készpénzes kerekítés (`roundHufCash`): csak a végösszegre, csak `CASH` (és opcionálisan `CARD`, ha az eladó bekapcsolta és a
    számlán tájékoztat); a NAV-adat a számla (kerekítetlen) végösszegét kapja; a különbözetet külön sorban, ne számlatételként jelenítsük meg.
16. Pénz/szám formázás: saját formázó (nem `Intl` HUF-currency, mert 0 tizedesre kerekít), U+00A0 csoportelválasztó, tizedesvessző;
    XML-ben pont és `YYYY-MM-DD`.

**SHOULD**

17. Magyar Posta XLSX-ből generált irányítószám–település tábla (build-time), több találatnál választás kérése az ügynöktől.
18. A KCR 70 közterület-jellege legyen javaslatlista (`publicPlaceCategory` szabad szöveg marad); AkH-rövidítések kibontása
    (`u.`→utca, `krt.`→körút); `detailedAddress`, ha van utcanév + jelleg, különben `simpleAddress`.
19. `queryTaxpayer` (NAV) hívás a vevő mentésekor – a 9. jegyből ne következtessünk adózási státuszra.
20. `vat.ts` bővítése `noVatCharge` (17. §) és `vatAmountMismatch` (11/14. §, `REFUNDABLE_VAT|NONREFUNDABLE_VAT`) ágakkal, vagy
    dokumentáltan „nem támogatott".
21. `KUL_UTAZAS`: az első verzióban tiltani, vagy árrés-adat bekérése (210/A. § (3): a NAV-adat a forintos adóalapot és áfát tartalmazza).
22. Kulcs-naptár: a kulcs–melléklet összerendelés **teljesítési dátum** szerint (2026-09-01 gyógyszer 0 %, 2026-09-15 tűzifa 5 %,
    2027-01-01 új lakás 5 % → 27 % a 371. § átmenet kivételével); AAM-határ évenként (2026: 20 M, 2027: 22 M, 2028: 24 M Ft) konfigurációból.
    > ⚠️ Javítva (verifikáció): a 2028-as 24 M Ft-os érték hiányzott – https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20280101
23. Importnál a régi szoftverkódokat (`EU/EUT`, `EUK/EUKT`, `K.AFA`, `TAHK/TEHK`, `F.AFA`) ne képezzük le automatikusan – kérjünk döntést.
24. Adóazonosító jelet csak indokolt esetben tároljunk; logból/MCP-válaszból maszkoljuk.
25. Figyelni: MNB `https` végpont helyreállása; NAV specifikáció újabb verziói (a `case`-listák és árfolyamsávok változhatnak);
    az őszi adócsomag (új lakás 5 %).

---

## Verifikáció (2026-10-27)

Független, kételkedő ellenőrzés elsődleges forrásokból (njt.jog.gov.hu, net.jogtar.hu időállapotok, nav.gov.hu,
onlineszamla.nav.gov.hu, github.com/nav-gov-hu, mnb.hu, ec.europa.eu) és saját futtatással (Node v24.19.0, ICU 78.3, CLDR 48.0,
tz 2026b, Windows 11). A dokumentum hivatkozásait megnyitottam, nem vettem át. A letöltött adatok és a saját ellenőrző szkriptek
a verifikátor helyi munkakönyvtárában vannak (nem részei a repónak). A 12.1–12.2 kódot változtatás nélkül kimásoltam és
lefuttattam; a `nav-accounts.fixture.json`-t a NAV PDF-jéből újraépítve **10/10 teszt zöld**, a `live-clients.ts` kimenete egyezik.

| # | Állítás (fejezet) | Verdikt | Bizonyíték |
|---|---|---|---|
| 1 | Adószám-CDV: súlyok 9,7,3,1,9,7,3; `(10 − Σ mod 10) mod 10`; a 6 valós szám összege (226/150/156/90/109/142) és CDV-je (1.2–1.3) | ✅ megerősítve | Céginformációs Szolgálat PDF (archív) szövege; saját futtatás; 5 **független** valós szám is átmegy: Magyar Posta `10901232-2-44` (posta.hu PDF), MÁV-START `13834492-2-44`, MÁV Pályaműködtetési `32694422-4-43`, MÁV csoportazonosító `17784447-5-44` (mavcsoport.hu), MÁV Zrt. `10856417-2-44` (SZE-tájékoztató, másodlagos). VIES VALID: NAV, Telekom, Richter, MÁV-START, OTP- és MÁV-csoport; a 4-es áfakódú csoporttagok (OTP Bank, MOL, MÁV Pályaműködtetési) a VIES-ben érvénytelenek – egyezik a „HU + csoport törzsszáma” szabállyal (OTP impresszum: `HU17780010`) |
| 2 | `TaxNumberType`: `taxpayerId` `[0-9]{8}`, `vatCode` `[1-5]{1}` (opc.), `countyCode` `[0-9]{2}` (opc.), ebben a sorrendben (1.1) | ✅ megerősítve | invoiceBase.xsd @`cc7a775` (2026-02-13); common.xsd `common-1.0.0` (az OSA 3.0 az NTCA 1.0 névteret importálja) |
| 3 | Megyekód-készlet `02–20; 22–44; 51` és a 4.1-es táblázat (1.5) | ✅ megerősítve | spec. HU v3.0 (2026.02.12) 4.1 + WARN 120–160 |
| 4 | Áfakód-WARN-készletek (eladó {1,2,3,5}, pénzügyi képviselő {1,2,4}, termékdíj {1,2,3,5}); 4 = tag, 5 = csoportazonosító; `INCORRECT_HEAD_DATA_FISCALREPRESENTATIVE` csak 51-es megyekódnál (1.4–1.6) | ✅ megerősítve | spec. WARN-katalógus, 2.1.4; az `1`/`2` jelentése ❓ (lásd lent) |
| 5 | Csoportazonosító `177`-es előtagja (1.6) | ⚠️ javítva | [közepes] → [magas]: nav.gov.hu közlemény (2023-09-07) + spec. WARN 82 (hamarosan ERROR) |
| 6 | Bankszámla-CDV: 24 jegynél egyetlen 9–23-as blokk, a 16. jegy szabad; a „3×8” ellenőrzés hibás (4.1, 4.4, 12.5) | ✅ megerősítve | njt 35/2017. MNB r. 1. melléklet (2026.01.31.) szó szerint; NAV PDF (2026-07-01-től): 123 számla (108×16, 15×24), 125 IBAN – saját, független implementációval és a referencia-kóddal is mind érvényes; a „3×8” csak `10032000-00009722-05020029`-et utasítja el |
| 7 | HU IBAN: 28 karakter, 16 jegynél 8 nullás kitöltés, mod 97; a 4.4 és 12.5 tábla 19 IBAN-ja (4.2) | ✅ megerősítve | 35/2017. 3. § (5), 1. melléklet 2. pont; mind a 19 IBAN újraszámolva, mind szerepel a NAV-listában |
| 8 | `BankAccountNumberType` minta és 15–34 hossz; `PostalCodeType`; `CommunityVatNumberType`; `SimpleText50NotBlankType` (1–50, `.*[^\s].*`); `TaxIdentificationNumberType` nem használt (4.3, 5.1, 2.1, 3, 11) | ✅ megerősítve | common.xsd, invoiceData.xsd (grep) |
| 9 | 0 %: 82. § (4), 3/B. melléklet – napilap 2024-01-01-től; vényköteles gyógyszer és magisztrális 2026-09-01-től (2026. évi XL. tv.); 0 % ≠ adómentesség (8.1–8.2) | ✅ megerősítve | njt Áfa tv. 82. § (2026.09.15.) + 853–855. lábjegyzet; jogtar időállapotok: 2023.XII.1–31 nincs 3/B., 2024.I.1 van; 2026.VII.31–VIII.31 csak napilap, 2026.IX.1-től 3 sor; NAV-közlemény (2023-12-20) |
| 10 | Kulcsok 27/18/5/0 %; 83. § szerinti 21,26/15,25/4,76/0 % (8.1) | ✅ megerősítve | njt 82–83. § szó szerint |
| 11 | 2026-os változások: tűzifa/pellet 2026-09-15 (2026. évi XLVIII. tv.); 3. mell. I. 1. sor módosul, 4. és 6. sor hatályon kívül 2026-09-01 (2026. évi XL. tv.); marhahús 2026-01-01 (2025. évi LXXXIII. tv.); desszert jellegű sajtkészítmény 18 % 2024-01-01-től (8.1) | ✅ / ⚠️ pontosítva | jogtar időállapotok (2023.XII.1, 2024.I.1, 2025.XI.22, 2026.I.1, 2026.IX.1, 2026.IX.15) + njt 851. lábjegyzet; marha: a 31–38. sor (egész/fél/negyed test) már 2025-ben is 5 %, a 60. sor a darabolt húst és belsőséget hozza |
| 12 | Új lakás 5 %: az 50–51. sor 2027-01-01-jén hatályát veszti; 371. § átmenet 2030-12-31-ig az a)–c) feltételekkel (8.1) | ✅ megerősítve | jogtar 2027.I.1-i időállapot (371. § szövege, 50–51. sor „*”); njt 2024. évi LV. tv. 217. § (12): az 53. § és az 57. § 8. pontja 2027-01-01-jén lép hatályba |
| 13 | AAM-értékhatár 2026: 20 M Ft (2025. évi LXXXIV. tv. 14. §), 2027: 22 M Ft (0., 8.1, teendők) | ✅ + ⚠️ kiegészítve | njt 188. § (2) + 487. lábjegyzet; jogtar 2027-es és **2028-as (24 M Ft)** időállapot |
| 14 | Engedett `vatPercentage`/`vatContent` értékek, `0` csak ≥ 2024-01-01 (ERROR 14 `INVALID_VAT_DATA`); ERROR 48/49 `vatRate`-készlet (8.2–8.3) | ✅ megerősítve | spec. hibakód-táblázat és részletes leírás |
| 15 | `VatRateType` 8 `choice`-ága (`vatPercentage` … `noVatCharge`), `DetailedReasonType` (`case`, `reason`), `VatAmountMismatchType` (`vatRate`, `case`), `MarginSchemeType` 4 értéke, `RateType` 0–1 (8.3) | ✅ megerősítve | invoiceData.xsd @`cc7a775` |
| 16 | `case`-értékkészletek (AAM, TAM, KBAET, KBAUK, EAM, NAM, UNKNOWN / ATK, EUFAD37, EUFADE, EUE, HO, UNKNOWN / REFUNDABLE_VAT, NONREFUNDABLE_VAT, UNKNOWN) és Áfa tv.-hivatkozásaik (8.3) | ✅ megerősítve | spec. ERROR 31–37 + case-táblázat |
| 17 | Hibakódok: 2, 13, 24, 50, 51, 65, 67–70, 77, 78 (13 deviza sávja), 79; WARN árfolyam = 1 nem-HUF devizánál; tűrés 1 % / min. 1 HUF / 0,01 egység (5.3, 8.3, 9, 10.4, 11) | ✅ megerősítve | spec. hibakód-táblázat, részletes leírások, WARN-katalógus, 3.0 változáslista |
| 18 | `UnitOfMeasureType` 16 értéke ebben a sorrendben; `OWN` → `unitOfMeasureOwn` (ERROR 65); saját címke kanonikus érték mellett is megengedett; `QuantityType` 22/10 vs. spec.-szöveg „hat tizedes” (9) | ✅ megerősítve | invoiceData.xsd; spec. 2.3.16, 65. hiba, változásnapló 7. pont |
| 19 | `ExchangeRateType` 14/6 jegy, > 0; HUF-számlán 1; végszámlán egy árfolyam, `advanceExchangeRate` csak számviteli; gyűjtőszámlán `lineExchangeRate` (10.4) | ✅ megerősítve | invoiceData.xsd; spec. 2.3.4, előleg- és gyűjtőszámla-fejezet |
| 20 | Áfa tv. 59., 60., 80., 80/A. §, 163. § (2) a), 165. § (1) a), 169. § d)/m)/n)/p)/q), 172., 176. § (1) e) és (2) a), 187. § (2) c), 188. § (2), 210/A. §, 222. § (1) b), 10. melléklet 5/A. pont (8.3, 10.1) | ✅ megerősítve | njt (2026.09.15.) és jogtar szövegek (a 169. § q) njt-n egy helyen „régisek” elírás, a jogtar szerint „régiségek” – a dokumentum idézete helyes) |
| 21 | MNB SOAP: csak `http://` POST működik (`https://` → 404); SOAP 1.1 document/literal, névtér, SOAPAction; 10-22/26/27 árfolyamok, 10-23…25 üres; `unit=100` JPY/IDR/KRW; tizedesvessző, csökkenő sorrend; `GetInfo`/`GetDateInterval` 1949-01-03; laza dátum-parser; 11:00-s megállapítás (10.2–10.3) | ✅ megerősítve | élő hívások 2026-10-27; WSDL (`soap:address` = http); mnb.hu módszertani oldal. Megjegyzés: a `GetCurrencyUnits` a jelenleg nem jegyzett VND-re is 100-at ad → mindig a `unit` attribútummal osszunk (a referencia-kód így tesz) |
| 22 | VIES REST: végpontok; `XX/123` → HTTP 200 + `INVALID_INPUT`; `HU12345676` → `valid:false`; a tesztszolgáltatás 13 kódja; `check-status` 27 tagállam + XI; a nem dokumentált `ms/{cc}/vat` séma; SOAP `vatNumber` minta; VIES-FAQ formátumtábla (2.2–2.3) | ✅ megerősítve | élő hívások 2026-10-27; checkVatService.wsdl; translations JSON (`faq_label_*format`) |
| 23 | `Intl` hu-HU táblázat mind a 15 sora (U+00A0, 4 jegyű szám csoportosítás nélkül, HUF `maximumFractionDigits: 0`, `EUR` szimbólum, dátumformák) (6.2) | ✅ megerősítve | saját futtatás Node v24.19.0 / ICU 78.3 / CLDR 48.0 |
| 24 | AkH 274. (tizedesvessző, 5+ jegy hármas tagolás), 294. (`2500 Ft`), 295. (`2014. 02. 28.`) (6.1) | ✅ megerősítve | helyesiras.mta.hu AkH 12 |
| 25 | 2008. évi III. tv. 1–3. § szövege; `roundHufCash` 15 határesete; NAV GYIK II.36 (mód. 2025-03-24), II.22, II.24 (7, 1.4, 8.3) | ✅ megerősítve | njt; saját futtatás; onlineszamla.nav.gov.hu CMS-API |
| 26 | Adóazonosító jel képzése (1996. évi XX. tv. 1. sz. melléklet, njt 2026.10.01.); szintetikus példák (`8123456786` → 1900-10-20, `8414091237` → 1980-05-17) (3) | ✅ megerősítve | njt; saját futtatás |
| 27 | Sorszám: ERROR 51/79 (whitespace), ERROR 2 adózónkénti egyediség (jóváhagyott technikai érvénytelenítés kivétel); Számlarendelet 8. § (1)–(6); NAV Online Számlázó `METST-2018-30`, előtag ≤ 5 karakter, évente egyedi (11) | ✅ megerősítve | spec.; njt 23/2014. NGM r. (2026.01.01.); Online Számlázó FHK v0.18 |
| 28 | Címek: `simpleAddress`/`detailedAddress` elemsorrend és típusok, `0000`-szabály, `PRIVATE_PERSON` → nincs vevőnév/-cím (ERROR 24); Posta XLSX: 2801 kód (2000–9985), 332 / 113, Nyíregyháza 8, Bp. 1007–1239 (5.1–5.3) | ✅ / ⚠️ javítva | invoiceBase.xsd; spec. 2.1.3.1; XLSX újraszámolva – a „9695” helyesen **9696** |
| 29 | Közterület-jellegek: 322/2024. Korm. r. 5. melléklet, 70 érték (pontos egyezés); 345/2014. hatályon kívül 2024-11-07 (5.4) | ✅ megerősítve | njt (2026.10.23.) |
| 30 | 13. fejezet: `src/mnb/rates.ts` – „a végpont még nincs rögzítve” | ⚠️ javítva (elavult) | a jelenlegi `src/mnb/rates.ts`: `DEFAULT_ENDPOINT = 'http://www.mnb.hu/arfolyamok.asmx'` |

**❓ Nem ellenőrizhető:** az áfakód `1`/`2` hivatalos NAV-definíciója; a NAV álláspontja a munkanapon 11:00 előtt kiállított
devizás számla árfolyamáról; a SWIFT IBAN Registry HU-példája; a 2026 őszi adócsomag (új lakás 5 %); a VIES `requestIdentifier`
saját áfaszámmal (nem futtattam); az F12 (NAV 18. információs füzet) „MNB és EKB együtt nem választható” mondata (az F12-t nem
nyitottam meg – a 80. § (3)–(4) és a 80/A. § (3) alapján következtetés); a 13. fejezet `format.ts`-sora; a MOL teljes adószáma
(`-4-44`) csak másodlagos cégadatbázisból.
