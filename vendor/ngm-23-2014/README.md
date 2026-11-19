# 23/2014. (VI. 30.) NGM rendelet – 3. melléklet: „az XSD séma”

Az „adóhatósági ellenőrzési adatszolgáltatás” adatszerkezete (a rendelet 8. § (1) bekezdés c) pontja,
11/A. §-a és 19. §-a). A `src/export/szamla2013.ts` ilyen XML-t állít elő. A tesztek ezzel a sémával
validálnak (`test/helpers/szamla2013-xsd.ts`, `test/export/szamla2013.test.ts`).

| | |
|---|---|
| Fájl | `szamla-2013.xsd`: 1031 sor, 41 546 bájt, UTF-8 (BOM nélkül), LF sorvég, SHA-256 `c979ab420679ae9543c743c00a8b435a35d2b5eb815f72cfef73719bd1c2351a` |
| Forrás | Nemzeti Jogszabálytár, a rendelet hatályos szövege, 3. melléklet: <https://njt.hu/jogszabaly/2014-23-20-2X> (átirányít ide: <https://njt.jog.gov.hu/jogszabaly/2014-23-20-2X>) |
| Időállapot | 2026.01.01. (a letöltés napján ez a hatályos szöveg) |
| Letöltve | 2026-10-27 |
| Jogállás | **jogszabály – nem szerzői jogi védelem alatt** (1999. évi LXXVI. törvény (Szjt.) 1. § (4) bekezdés) |
| Névtér, gyökérelem | `http://schemas.nav.gov.hu/2013/szamla`, `szamlak` (`szamlak_tipus`) |
| A séma saját verziója | „Elektronikus számlák adatai - Utolsó módosítás: 2014.01.29-.” |

## Hogyan készült a fájl

Az njt a mellékletet szövegként közli. Minden XSD-sor külön szövegrész („szelet”), behúzás nélkül.
A fájl ezeknek a soroknak a **betű szerinti másolata**:

- csak a HTML-entitásokat (`&lt;`, `&gt;`) oldottuk fel;
- behúzást nem adtunk hozzá (a hivatalos szövegben nincs);
- semmit nem javítottunk, a szöveg elírásai is maradtak (pl. „vállakozó”, „veveő”, „Vizi”, „Kilóméteróra”);
- a több soros `xs:documentation` szövegek sortörései is az njt szerintiek.

Az 1–3. mellékletnél az njt-n nincs módosító lábjegyzet, tehát a mellékletek a 2014-es kihirdetés óta
változatlanok.

**Összevetés a NAV által közzétett fájllal.** A NAV „Availability of the XSD scheme given in Schedule
No. 3 of the Decree of the Ministry of National Economy no. 23/2014. (VI. 30.)” oldala
(<https://nav.gov.hu/en/taxation/further_information/Availability_of_the_X20200910>, 2015.10.14.)
fájlként is közzéteszi a sémát: <https://nav.gov.hu/pfile/file?path=/ado/art/adozas_rendje/23-2014_szamlasema>
(`23_2014_szamlasema.xsd`, 45 874 bájt, SHA-256 `f5a10d686e5d275fdca5d63df285e5ba5097fed7814f08611a1f813d99b7643d`,
letöltve 2026-10-27). Ez a fájl a whitespace-től eltekintve **azonos** a vendorolt szöveggel. Eltérések:
tabulátoros behúzás, CRLF sorvég, BOM, és a dokumentációs szövegekben sortörés helyett szóköz. A hiteles
szöveg a jogszabályé, ezért az njt-változatot tároljuk.

## A 3. melléklet (XSD) tartalma

`[ ]` = nem kötelező elem, `+` = ismételhető.

```
szamlak
├─ export_datuma, export_szla_db, kezdo_ido, zaro_ido, kezdo_szla_szam, zaro_szla_szam   (mind kötelező)
└─ szamla+                                                                                (legalább egy)
   ├─ fejlec: szlasorszam, szlatipus, szladatum, teljdatum                                 (mind kötelező)
   ├─ szamlakibocsato: adoszam, [kozadoszam], [kisadozo], nev, cim,
   │                   [egyeni_vallalkozo], [ev_nyilv_tart_szam], [ev_neve]
   ├─ vevo: [adoszam], [kozadoszam], nev, cim
   ├─ [kepviselo]: [adoszam], nev, cim                                                     (pénzügyi képviselő)
   ├─ termek_szolgaltatas_tetelek+: termeknev, [gyujto_szla_csoport], [eloleg], [besorszam], menny,
   │      mertekegys, [kozv_szolgaltatas], [nettoar], [nettoegysar], [dohany_ar], [adokulcs], [adoertek],
   │      [szazalekertek], [bruttoar], [arengedm], [vellenertek], [vkozteher], [vktg], [vkistag],
   │      [kozl_eszk_inf], [asvanyolaj]
   ├─ [modosito_szla]+: eredeti_sorszam
   ├─ [gyujto_szla]+: gyujtocsopo_ossz, gyujtocsopo_nossz, gyujtocsopo_bossz
   ├─ [zaradekok]: [penzforgelsz], [onszamla], [ford_ado], [adoment_hiv], [kulonb_szer_szab], valamint
   │      termékdíj-, energiaadó-, NETA-, jövedéki, betétdíj-, rezsicsökkentés- és beszállókártya-záradékok
   ├─ [nem_kotelezo]: [fiz_hatarido], [fiz_mod], [penznem], [szla_forma], [kibocsato_bankszla], [befogado_bankszla]
   └─ osszesites: [afarovat]+ (nettoar, adokulcs, adoertek, bruttoar – soronként mind kötelező),
                  vegosszeg ([nettoarossz], [afaertekossz], [bruttoarossz], [afa_tartalom])

cim: iranyitoszam, telepules, [kerulet], kozterulet_neve, [kozterulet_jellege], [hazszam], [epulet],
     [lepcsohaz], [szint], [ajto]
```

Típusok és kódlisták:

| Típus | Szabály |
|---|---|
| `string_tipus` | 1–100 karakter |
| `adoszam_tipus` | 8–20 karakter |
| `iranyitoszam` | 4–10 karakter |
| `decimal_tipus` | `xs:decimal`, legfeljebb 12 számjegy, ebből legfeljebb 2 tizedes (tizedesjel: pont) |
| `decimal_egesz_tipus` | egész, legfeljebb 10 számjegy (`export_szla_db`) |
| `szlatipus_tipus` | 1 számla, 2 egyszerűsített adattartalmú számla, 3 módosító számla, 4 érvénytelenítő számla, 5 gyűjtőszámla, 6 számlával egy tekintet alá eső okirat |
| `eloleg_tipus` | 1 előlegszámla, 2 végszámla |
| `kulonb_szer_szab_tipus` | 1 utazási irodák, 2 használt cikkek, 3 műalkotások, 4 gyűjteménydarabok és régiségek |
| `szazalekertek_tipus` | 21.26, 4.76, 15.25 (csak egyszerűsített adattartalmú számlán) |

A dokumentáció szerint a tétel `adoertek` értékét „forintban kifejezve abban az esetben is fel kell
tüntetni, ha az egyéb adatok külföldi pénznemben kifejezettek”. Az `afarovat` és a `nettoarossz`/
`afaertekossz` „csak »számla« típusú számla esetében” kötelező. Az `afa_tartalom` és a `szazalekertek`
csak egyszerűsített adattartalmú számlán szerepel.

## A 2. melléklet: mit kell exportálni

A 2. melléklet címe „Az XML séma mezőinek fogalommagyarázata, elnevezések táblázata”. A táblázat 168
sora a számla minden tartalmi elemét összeköti az XSD-elemmel, és megmagyarázza (oszlopok: a számla
tartalmi eleme, fogalommagyarázat, XSD elnevezés). Az njt a táblázatot RTF-ben is közli
(`/document/5b/5b904K10826_0.rtf`). A 19. § szerint az ellenőrzéskor a számla adatait „a 2. melléklet
szerint és a 3. mellékletben meghatározott adatszerkezetben” kell átadni.

- **Export fejléce:** az előállítás dátuma, a bekerült számlák darabszáma, az adatszolgáltatás
  intervallumának kezdő és záró dátuma, valamint az intervallum első és utolsó számlájának sorszáma.
- **Fejléc:** a sorszám, amely „a számlát kétséget kizáróan azonosítja”, a számla típusa (a 6 típus),
  a kelte, továbbá a teljesítés dátuma. Előlegnél ez a fizetendő adó megállapításának időpontja, ha
  eltér a kelttől.
- **Számlakibocsátó:** adószám, közösségi adószám, a kisadózói státusz jelölése, név és cím (irányítószám,
  település, kerület, közterület neve és jellege, házszám, épület, lépcsőház, szint, ajtó). Egyéni
  vállalkozónál az „egyéni vállalkozó” megjelölés, a nyilvántartási szám és a név (aláírás).
- **Számlabefogadó:** a termék beszerzőjének, szolgáltatás igénybevevőjének adószáma, közösségi
  adószáma, neve és címe.
- **Képviselő:** pénzügyi képviselő alkalmazásakor annak adószáma, neve (a számla kiállítója) és címe.
- **Tételek:**
  - megnevezés, gyűjtőszámla-csoport és az előleg jelölése;
  - besorolási szám (vtsz./SZJ), mennyiség és mértékegység, „feltéve, hogy az természetes
    mértékegységben kifejezhető”;
  - közvetített szolgáltatás jelölése;
  - nettó ár (az adó alapja), nettó egységár, adókulcs, adó (forintban), százalékérték és bruttó ár
    („az ellenérték adót is tartalmazó összege”);
  - árengedmény, árverési adatok, a dohánytermék kiskereskedelmi ára, az új közlekedési eszköz adatai és
    az ásványolaj kitárolási adatai.
- **Módosító számla:** hivatkozás arra a számlára (az eredeti sorszámára), „amelynek adattartalmát
  módosítja”. **Gyűjtőszámla:** csoportonként a nettó és a bruttó összeg.
- **Záradékok:**
  - a „pénzforgalmi elszámolás”, az „önszámlázás”, a „fordított adózás” és a megfelelő „különbözet
    szerinti szabályozás – …” kifejezés feltüntetése;
  - adómentességi hivatkozás;
  - termékdíj-záradékok (átvállalás, visszaigénylés, csomagolószer, reklámhordozó papír);
  - energiaadó, népegészségügyi termékadó, AHK-szám, jövedéki adatok, betétdíj, rezsicsökkentés,
    beszállókártya.
- **Nem kötelező elemek:** fizetési határidő, fizetési mód, pénznem, a számla megjelenési formája
  (e-számla / EDI számla / papír alapon továbbított számla / papír alapon előállított, de elektronikus
  formában továbbított számla), valamint mindkét fél bankszámlaszáma.
- **Összesítés:** ÁFA-kulcsonként az adóalap, az adókulcs, az adó és az ellenérték, továbbá a végösszeg
  (adóalap, ÁFA és ellenérték összesen, ÁFA-tartalom).

Hogy mi kerüljön az exportba, azt a NAV így foglalja össze („Ellenőrzési adatexport teljesítése során
jelentkező jellemző hibák”, Ügyféliránytű, 2022.07.01.,
<https://nav.gov.hu/ugyfeliranytu/nezzen-utana/tudjon_rola/Ellenorzesi_adatexpor20170620>):

- a számla **kötelező** adatai mindig szerepeljenek;
- a nem kötelező adat akkor kell, ha a kiadott számlán szerepel, és az XSD-ben van rá elem (például a
  fizetési határidő);
- ami a számlán sincs rajta és nem is kötelező, az kimarad;
- a magánszemély vevő neve és címe az exportban szerepel, bár a NAV Online Számlába nem küldhető.

Jellemző hibának számít:

- a sémától eltérő elemnév vagy szerkezet;
- hiányzó kötelező cím-elem (irányítószám, település, közterület neve);
- 2-nél több tizedesjegy;
- tizedesvessző;
- 10 karakternél hosszabb irányítószám;
- más mezőbe írt adat;
- nem UTF-8 karakterkészlet.

Az OpenSzámla megfeleltetését (mi hova kerül, mi nem ábrázolható) a `src/export/szamla2013.ts` fejléce
írja le.

## Frissítés

A rendelet módosításakor töltsd le újra a 3. mellékletet az njt-ről, és írd ki soronként, változtatás
nélkül. Utána vesd össze a NAV fájljával (whitespace-től eltekintve), frissítsd a fenti táblázatot és az
SHA-256 értéket, végül futtasd: `npx vitest run test/export`.
