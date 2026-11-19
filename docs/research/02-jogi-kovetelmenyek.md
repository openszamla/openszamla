# 02 – Jogi követelmények: számlák és számlázó program (Magyarország, állapot: 2026-10-27)

> **Cél:** azoknak a magyar jogszabályi követelményeknek a pontos összegyűjtése, amelyeknek egy (MI-ügynökök által MCP-n, CLI-n és webes felületen keresztül vezérelt) nyílt forráskódú számlázó programnak és az általa kiállított számláknak 2026. október 27-én meg kell felelniük, implementációs checklistté alakítva.
>
> **Megbízhatósági jelölések:** **[magas]** = elsődleges forrásból (njt.hu konszolidált szöveg, NAV hivatalos kiadvány vagy NAV interfész-specifikáció) szó szerint ellenőrizve; **[közepes]** = elsődleges forrásból levont következtetés, NAV-munkatárs nem hivatalos válasza, illetve több másodlagos forrás egybehangzó állítása; **[alacsony]** = egyetlen másodlagos forrás, javaslat vagy tervezet.
>
> A jogszabályszövegek idézetei a njt.hu (Nemzeti Jogszabálytár) 2026-10-27-én letöltött konszolidált szövegéből származnak (a jogszabályok nem állnak szerzői jogi védelem alatt). Ez a dokumentum nem minősül jogi vagy adótanácsadásnak; az élesítés előtt adószakértői felülvizsgálat ajánlott.

---

## 0. Vezetői összefoglaló

1. **A számla kötelező adattartalma:** Áfa tv. 169. § a)–r) pontjai (18 pont). A vevő adószámát három esetben kell feltüntetni (belföldi fordított adózás: teljes adószám; Közösségen belüli adómentes értékesítés: közösségi adószám; belföldi B2B: az adószám első 8 jegye, ha az eladó belföldön letelepedett). **[magas]**
2. **A kötelező kifejezéseket szó szerint kell feltüntetni:** „fordított adózás”, „pénzforgalmi elszámolás”, „önszámlázás”, valamint négy „különbözet szerinti szabályozás – …” változat. Adómentességnél jogszabályi vagy irányelvi hivatkozás, vagy más egyértelmű utalás kell. Alanyi adómentes számlán **tilos** áthárított adót, adómértéket vagy százalékértéket feltüntetni. **[magas]**
3. **Számlázó program (23/2014. NGM rendelet):**
   - kihagyás és ismétlés nélküli, folyamatos sorszámozás;
   - beépített „adóhatósági ellenőrzési adatszolgáltatás” funkció: XML-export dátum- vagy sorszámtartományra, a 3. melléklet szerinti XSD-ben vagy a NAV Online Számla adatszerkezetében;
   - a NAV felé az adatszolgáltatás a kiállításkor **azonnal**, XML-ben történik;
   - felhasználói dokumentáció kötelező, és a program **„kizárólag a dokumentációban szereplő funkciókat hajthatja végre”**. Ez minden MCP-tool és CLI-parancs dokumentálását jelenti. **[magas]**
4. **Online Számla 2026-ban:**
   - Minden, a magyar számlázási szabályok alá tartozó számláról és számlával egy tekintet alá eső okiratról adatot kell szolgáltatni (B2B, B2C, külföldi vevő, egyszerűsített számla, alanyi adómentes eladó). Kivételt csak az OSS/IOSS (egyablakos) ügyletek képeznek.
   - Nem adóalany magánszemély vevőnél a vevő neve és címe **nem** küldhető be.
   - Kiesés esetén az adatot az üzemzavar megszűnése után 24 órán belül kell pótolni. A számlázó fél saját, 48 óránál hosszabb kiesésekor ezt jeleznie kell a NAV rendszerében, és az adatokat kézzel kell rögzítenie. **[magas]**
5. **2025-09-15 óta 15 korábbi WARN-üzenet ERROR lett.** A kódlista a NAV-spec 3.40-es alkalmazásverziójának változáslistájából származik; a darabszámok egyeznek a KPMG-összefoglalóval, a verzió és a dátum összerendelése ezért közepes megbízhatóságú. Az ERROR-ral elutasított adatszolgáltatás jogilag nem teljesített. **[magas]**
6. **Bírság:** hibás vagy elmulasztott Online Számla adatszolgáltatásért **számlánként legfeljebb 1 000 000 Ft** (nem természetes személy) vagy **400 000 Ft** (természetes személy) szabható ki (Art. 229. § és 220. § (1) bek.). Ez **2025-01-01-től** él, korábban 500 000 / 200 000 Ft volt. A számlakibocsátás elmulasztásáért legfeljebb 2 000 000 Ft jár, és üzletlezárás is lehetséges. **[magas]**
7. **A „SZAMLAZO” bejelentés 2021-01-04-én megszűnt** (17/2020. (XII. 30.) PM rendelet). A fejlesztőt sem terheli NAV-regisztráció. A fejlesztőnek, illetve forgalmazónak a 23/2014. NGM rendelet 9–10. §-a szerinti kötelezettségei maradtak: eladási nyilvántartás és dokumentáció. **[magas]**
8. **Az e-nyugta nem kötelező 2026-09-01-től.** Ettől a naptól a **kézi és a számítógéppel előállított nyugtákról** kell napi összesítésben, 3 naptári napon belül adatot szolgáltatni (Áfa tv. 11. melléklet B) rész). A NAV 2026-12-31-ig nem bírságol. **[magas]**
9. **Az alanyi adómentesség értékhatára:** 2026-ban 20 000 000 Ft, 2027-ben 22 000 000 Ft, 2028-tól 24 000 000 Ft (a 188. § (2) bek. már kihirdetett, 2027-01-01-től, illetve 2028-01-01-től hatályos szövege; a NAV is így közölte). A KATA keretösszege 18 millió Ft; a kisadózó jogállása megszűnik, ha kifizetőtől (cégtől) szerez bevételt. **[magas]**
   > ⚠️ Javítva (verifikáció): a 2028-as 24 M Ft nem csak NAV-közlés, hanem a 188. § (2) bek. jövőbeli időállapotának szövege (2027.I.1.: 22 000 000; 2028.I.1.: 24 000 000 Ft). Forrás: https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20280101 (és …&timeshift=20270101); NAV: https://nav.gov.hu/ado/afa/Emelkedik_az_alanyi_adomentesseg_ertekhatara
10. **Az adókulcsok és listák 2026-ban is változtak:** 0% a vényköteles gyógyszerekre 2026-09-01-től, 5% a tűzifára 2026-09-15-től. Az adómértékeket ezért **időbeli hatállyal, adatként** kell kezelni. **[magas]**
11. **ViDA:** az EU-irányelv 2025-04-14-én hatályba lépett, a Közösségen belüli B2B digitális adatszolgáltatás 2030-07-01-től indul. A hazai NAV–NGM koncepció (2025. november) EN 16931 XML-alapú, akkreditációhoz kötött e-számlázást tervez, de **2026-10-27-ig nincs elfogadott jogszabály és kötelező dátum**. **[közepes]**

---

## 1. Források és időállapotok

| ID | Forrás | URL | Időállapot / letöltés |
|---|---|---|---|
| F1 | 2007. évi CXXVII. törvény az általános forgalmi adóról (**Áfa tv.**) | https://njt.hu/jogszabaly/2007-127-00-00 | hatályos szöveg: 2026.09.15. időállapot; letöltve 2026-10-27 |
| F2 | 2017. évi CL. törvény az adózás rendjéről (**Art.**) | https://njt.hu/jogszabaly/2017-150-00-00 | 2026.10.01. |
| F3 | 2000. évi C. törvény a számvitelről (**Számv. tv.**), nem váltotta fel új törvény | https://njt.hu/jogszabaly/2000-100-00-00 | 2026.02.28. |
| F4 | 23/2014. (VI. 30.) NGM rendelet (**Számlarendelet**) | https://njt.hu/jogszabaly/2014-23-20-2X | 2026.01.01. |
| F5 | 2008. évi III. törvény (készpénzes kerekítés) | https://njt.hu/jogszabaly/2008-3-00-00 | 2008.03.01. (változatlan) |
| F6 | 1/2018. (VI. 29.) ITM rendelet a digitális archiválás szabályairól | https://njt.hu/jogszabaly/2018-1-20-7Q | 2018.07.02. (változatlan) |
| F7 | 8/2025. (III. 31.) NGM rendelet (e-pénztárgép, e-nyugta) | https://njt.hu/jogszabaly/2025-8-20-2X | 2025.12.20. |
| F8 | 2022. évi XIII. törvény (KATA) | https://njt.hu/jogszabaly/2022-13-00-00 | 2023.08.01. |
| F9 | 2009. évi CXV. törvény (egyéni vállalkozó, **Evtv.**) | https://njt.hu/jogszabaly/2009-115-00-00 | 2026.09.27. |
| F10 | 2006. évi V. törvény (**Ctv.**) | https://njt.hu/jogszabaly/2006-5-00-00 | 2026.10.01. |
| F11 | 2024. évi LV. törvény (Art. bírságemelés; hatálybalépés: 217. §) | https://njt.hu/jogszabaly/2024-55-00-00 | letöltve 2026-10-27 |
| F12 | 2025. évi LIV. törvény (Áfa tv. 10. melléklet 5/B–7. pont: 2026-01-01; 11. melléklet: 2026-09-01) | https://njt.hu/jogszabaly/2025-54-00-00 | letöltve 2026-10-27 |
| F13 | 2026. évi XXXV. törvény (Áfa tv. 10. melléklet „Számla befogadása”) | https://njt.hu/jogszabaly/2026-35-00-00 | kihirdetve 2026-07-30 |
| F14 | 2026. évi XL. törvény (0% vényköteles gyógyszer, 2026-09-01) és 2026. évi XLVIII. törvény (tűzifa, 2026-09-15) | https://njt.hu/jogszabaly/2026-40-00-00 · https://njt.hu/jogszabaly/2026-48-00-00 | letöltve 2026-10-27 |
| F15 | Art. 2024-09-01-i és 2025-01-01-i időállapota (bírságösszegek összevetése) | https://net.jogtar.hu/jogszabaly?docid=a1700150.tv&timeshift=20240901 · …&timeshift=20250101 | letöltve 2026-10-27 |
| F16 | NAV 18. információs füzet: „A számla, nyugta kibocsátásának alapvető szabályai” | https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2Frejtett%2FInformacios-fuzetek---Aktualis%2F18.-informacios-fuzet---A-szamla-nyugta-kibocsatasanak-alapveto-szabalyai | közzétéve 2026.03.02. |
| F17 | NAV: SZAMLAZO nyomtatvány oldala (a kötelezettség megszűnése) | https://nav.gov.hu/nyomtatvanyok/letoltesek/nyomtatvanykitolto_programok/nyomtatvanykitolto_programok_nav/SZAMLAZO | 5.0 verzió, 2021.01.18. |
| F18 | NAV: „A számlakibocsátók számlaadat-szolgáltatásának 2021. január 4-től hatályos szabályai” | https://nav.gov.hu/ado/afa/A_szamlakibocsatok_sz20201231 | 2021.01.04. |
| F19 | NAV Online Számla interfész-specifikáció v3.0 (2026.02.12-i kiadás) és XSD-k | https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu · https://github.com/nav-gov-hu/Online-Invoice/tree/master/src/schemas/nav/gov/hu/OSA | letöltve 2026-10-27 |
| F20 | NAV hír: „Szeptember közepétől tisztulnak az online számlarendszer adatai” | https://nav.gov.hu/sajtoszoba/hirek/Szeptember_kozepetol_tisztulnak_az_online_szamlarendszer_adatai | 2025.06.23. |
| F21 | KPMG Taxalert (validációs változások összefoglalója) | https://kpmg.com/hu/hu/home/tanulmanyok/2025/09/taxalert-2025-09-02.html | 2025.09.02. |
| F22 | NAV: Nyugtaadat-szolgáltatás | https://nav.gov.hu/ado/enyugta/nyugtaadat-szolgaltatas | letöltve 2026-10-27 |
| F23 | NAV hír: négy hónapos átállási időszak a nyugtaadat-szolgáltatásban | https://nav.gov.hu/print/igazgatosagok/igazgatosagok/Jasz_Nagykun_Szolnok_megye/helyi_hirek/a-nav-segit-negy-honapos-atallasi-idoszak-a-nyugtaadat-szolgaltatasban | 2026.08.04. |
| F24 | NAV–NGM: „A ViDA implementációja Magyarországon” (koncepció, a konzultáció után frissítve) | https://nav.gov.hu/pfile/file?path=%2Fvida%2Fkoncepcio%2F2025_NAV_ViDA_implementacio_web_kiadvany.pdf1 · https://kormany.hu/dokumentumtar/e-szamla-koncepcio | 2025.11.25. (kormany.hu) |
| F25 | NAV hír: ViDA-konzultáció indul | https://nav.gov.hu/sajtoszoba/hirek/Indul_a_ViDA-konzultacio_NAV_es_vallalkozasok_egyutt_az_afadigitalizacioban | 2025.11.21. |
| F26 | NAV hír: „Több időt adna a NAV a digitális átállásra” (eÁFA) | https://nav.gov.hu/sajtoszoba/hirek/Tobb_idot_adna_a_NAV_a_digitalis_atallasra | 2026.10.15. |
| F27 | NAV hír: „Mától több adó- és vámszabály változik” | https://nav.gov.hu/ado/egyeb/Matol_tobb_ado-_es_vamszabaly_valtozik | 2026.07.31. |
| F28 | NAV hír: „Emelkedik az alanyi adómentesség értékhatára” | https://nav.gov.hu/ado/afa/Emelkedik_az_alanyi_adomentesseg_ertekhatara | 2025.12.11. |
| F29 | NAV Online-Invoice GitHub issue #738 (áfakerekítés; NAV-oldali válasz) | https://github.com/nav-gov-hu/Online-Invoice/issues/738 | válasz: 2021.02.04. |
| F30 | NAV Online-Invoice GitHub issue #716 (készpénzes kerekítés; csak közösségi válaszok) | https://github.com/nav-gov-hu/Online-Invoice/issues/716 | 2021.01. |
| F31 | BDO: „ViDA csomag Magyarországon” (másodlagos) | https://www.bdo.hu/hu-hu/aktualitasok-blog/szakmai-hirek/vida-csomag-magyarorszagon | 2025.12.08. |
| F32 | (EU) 2025/516 tanácsi irányelv (ViDA) | https://eur-lex.europa.eu/eli/dir/2025/516/oj · szöveg: https://publications.europa.eu/resource/celex/32025L0516 | HL L 2025/516, 2025.03.25.; a verifikáció során letöltve és ellenőrizve (7. cikk: hatálybalépés a kihirdetést követő 20. napon = 2025-04-14; 6. cikk (5) bek.: 2030-07-01) |
| F33 | WTS Klient (az „2024. augusztus óta” állítás forrása, másodlagos) | https://wtsklient.hu/en/2025/01/31/failure-to-report-online-invoice-data/ | 2025.01.31. |

> ⚠️ Javítva (verifikáció): az F32 sor korábban „nem sikerült letölteni” megjegyzést tartalmazott; az irányelv szövegét a Kiadóhivatal cellar-végpontjáról letöltöttem és a dátumokat ellenőriztem. Forrás: https://publications.europa.eu/resource/celex/32025L0516

---

## 2. A számla kötelező adattartalma – Áfa tv. 169. §

### 2.1 A törvény szövege (szó szerint) [F1] **[magas]**

> **169. §** A számla kötelező adattartalma a következő:
> a) a számla kibocsátásának kelte;
> b) a számla sorszáma, amely a számlát kétséget kizáróan azonosítja;
> c) a termék értékesítőjének, szolgáltatás nyújtójának adószáma, amely alatt a termék értékesítését, szolgáltatás nyújtását teljesítette;
> d) a termék beszerzőjének, szolgáltatás igénybevevőjének
> da) adószáma, amely alatt mint adófizetésre kötelezettnek a termék értékesítését, szolgáltatás nyújtását teljesítették, vagy
> db) adószáma, amely alatt a 89. §-ban meghatározott termékértékesítést részére teljesítették, vagy
> dc) adószámának vagy csoportos általános forgalmiadó-alanyiság esetén csoportazonosító számának első nyolc számjegye, amely alatt, mint belföldön nyilvántartásba vett adóalany részére a termékértékesítést, szolgáltatásnyújtást teljesítették, feltéve, hogy a termék értékesítője, szolgáltatás nyújtója gazdasági céllal belföldön telepedett le, gazdasági célú letelepedés hiányában pedig lakóhelye vagy szokásos tartózkodási helye van belföldön;
> e) a termék értékesítőjének, szolgáltatás nyújtójának, valamint a termék beszerzőjének, szolgáltatás igénybevevőjének neve és címe;
> f) az értékesített termék megnevezése, annak jelölésére – a számlakibocsátásra kötelezett választása alapján – az e törvényben alkalmazott vtsz., továbbá mennyisége vagy a nyújtott szolgáltatás megnevezése, annak jelölésére – a számlakibocsátásra kötelezett választása alapján – az e törvényben alkalmazott TESZOR'15, továbbá mennyisége, feltéve, hogy az természetes mértékegységben kifejezhető;
> g) a 163. § (1) bekezdés a) és b) pontjában említett időpont, ha az eltér a számla kibocsátásának keltétől;
> h) a „pénzforgalmi elszámolás” kifejezés, a XIII/A. fejezetben meghatározott különös szabályok szerinti adózás alkalmazása esetében;
> i) az adó alapja, továbbá az értékesített termék adó nélküli egységára vagy a nyújtott szolgáltatás adó nélküli egységára, ha az természetes mértékegységben kifejezhető, valamint az alkalmazott árengedmény, feltéve, hogy azt az egységár nem tartalmazza;
> j) az alkalmazott adó mértéke;
> k) az áthárított adó, kivéve, ha annak feltüntetését e törvény kizárja;
> l) az „önszámlázás” kifejezés, ha a számlát a terméket beszerző vagy a szolgáltatást igénybevevő állítja ki;
> m) adómentesség esetében jogszabályi vagy a Héa-irányelv vonatkozó rendelkezéseire történő hivatkozás vagy bármely más, de egyértelmű utalás arra, hogy a termék értékesítése, szolgáltatás nyújtása mentes az adó alól;
> n) a „fordított adózás” kifejezés, ha adófizetésre a termék beszerzője, szolgáltatás igénybevevője kötelezett;
> o) új közlekedési eszköz 89. §-ban meghatározott értékesítése esetében az új közlekedési eszközre vonatkozó, a 259. § 25. pontjában meghatározott adatok;
> p) a „különbözet szerinti szabályozás – utazási irodák” kifejezés, a XV. fejezetben meghatározott különös szabályok szerinti utazásszervezési szolgáltatás nyújtása esetében;
> q) a „különbözet szerinti szabályozás – használt cikkek” vagy a „különbözet szerinti szabályozás – műalkotások”, vagy a „különbözet szerinti szabályozás – gyűjteménydarabok és régisek” kifejezések közül a megfelelő kifejezés, a XVI. fejezetben meghatározott különös szabályok szerinti használt ingóság, műalkotás, gyűjteménydarab vagy régiség értékesítése esetében;
> r) pénzügyi képviselő alkalmazása esetében a pénzügyi képviselő neve, címe és adószáma.

> ⚠️ **Elírás a hivatalos szövegben:** a njt.hu 169. § q) pontjában „régisek” áll. A 173. § h) pontja, a NAV 18. információs füzete [F16] és a Héa-irányelv viszont a „gyűjteménydarabok és **régiségek**” alakot használja. **Javasolt kiírás: „különbözet szerinti szabályozás – gyűjteménydarabok és régiségek”.** **[magas]** (Az elírás tényét a forrás-HTML-ben ellenőriztem.)

### 2.2 Pontonkénti megjegyzések a programhoz

| Pont | Mikor kötelező / megjegyzés | Megbízhatóság |
|---|---|---|
| a) kelt | Mindig. A számla a program általi „lezáráskor” minősül kiállítottnak – a Számlarendelet 8. § (6) bekezdése ezt az (1) bek. d) pont (NAV-adatszolgáltatás) alkalmazásában mondja ki. A 169. § a) szerinti kelt a *kibocsátás* napja; a NAV szerint a kibocsátás a számla rendelkezésre bocsátása [F16]. Gyakorlati szabály: a lezárás és a vevőnek történő átadás/elküldés ugyanazon a napon történjen, és a kelt ez a nap legyen. | magas (szöveg); közepes (gyakorlati szabály) |
| b) sorszám | Mindig, a sorszámnak egyedinek kell lennie. A NAV a kibocsátó adószámán belül vizsgálja az egyediséget (`INVOICE_NUMBER_NOT_UNIQUE` ERROR) [F19]. | magas |
| c) eladó adószáma | Mindig. Csoportos áfaalanyiságnál a csoporttag a csoportazonosító számot **és** saját adószámát is köteles feltüntetni (Art. 30. § (2) bek. [F2]). 2026-01-01-től az Online Számla adatszolgáltatásnak is tartalmaznia kell a tag adószámát (Áfa tv. 10. melléklet 5/C. pont [F1], [F12]). | magas |
| d) vevő adószáma | Lásd a 2.3. pontot. | magas |
| e) nevek, címek | Mindkét félnél mindig, magánszemély vevőnél is (a NAV-nak viszont magánszemély nevét és címét nem szabad beküldeni, lásd a 6. fejezetet). | magas |
| f) megnevezés, mennyiség | Mindig. A vtsz. vagy TESZOR'15 szerepeltetése az eladó választása, hiánya nem teszi hibássá a számlát. A NAV szerint a 6/A–6/B. mellékletes, fordítottan adózó termékeknél különösen hasznos, mert a bevallásban vtsz. szerinti bontás kell (6/C. melléklet) [F16]. Mennyiség akkor kell, ha természetes mértékegységben kifejezhető. | magas |
| g) teljesítés dátuma | **Elhagyható, ha megegyezik a kibocsátás keltével.** Előlegszámlánál az előleg jóváírásának vagy kézhezvételének napja. Gyűjtőszámlán tételenként mindig kell (NAV [F16]). | magas |
| h) „pénzforgalmi elszámolás” | XIII/A. fejezet szerinti adózónál, azoknál az ügyleteknél, amelyekre a módszer vonatkozik. Hiányában a pénzforgalmi elszámolás az adott ügyletre nem alkalmazható, és ez utólag nem pótolható (196/B. § (4) bek.; NAV [F16]). | magas |
| i) adóalap, egységár, árengedmény | Mindig (egyszerűsített számlánál eltérés, lásd a 4. fejezetet). Az adóalap nem lehet negatív (NAV [F16]). | magas |
| j) adómérték | Jelenleg 27%, 18%, 5% vagy 0% (82. §). Egyszerűsített számlán helyette a 83. § szerinti százalékérték kell. | magas |
| k) áthárított adó | Akkor nem tüntethető fel, ha a törvény kizárja (AAM: 187. § (2) bek. c) pont; fordított adózás: 142. § (7) bek.; különbözeti viszonteladó: 222. § (1) bek. b) pont). Utazásszervezésnél (210/A. §) nem tilalomról, hanem mentesítésről van szó: az adóalapot és az áthárított adót *nem kell* feltüntetni, de az adóalany vevő nyilatkozata esetén kötelező, a NAV-adatszolgáltatásban pedig forintban mindig szerepel (210/A. § (1)–(3) bek.). | magas |
| l) „önszámlázás” | Ha a vevő meghatalmazottként állítja ki a számlát. | magas |
| m) adómentesség | Hivatkozás vagy más egyértelmű utalás (lásd a 20. fejezet táblázatát). | magas |
| n) „fordított adózás” | Ha a vevő az adófizetésre kötelezett: belföldi 142. §-os esetek, és a másik tagállamban teljesülő, a vevő által adózott ügyletek (pl. 37. § (1) bek. szerinti B2B szolgáltatás). | magas |
| o) új közlekedési eszköz | 89. §-os értékesítésnél a 259. § 25. pont szerinti adatok: forgalomba helyezés, km vagy üzemóra, hengerűrtartalom vagy teljesítmény, hossz, felszállási tömeg. | magas |
| p), q) különbözeti kifejezések | Lásd a 20. fejezetet. | magas |
| r) pénzügyi képviselő | Ha van pénzügyi képviselő: annak neve, címe és adószáma. | magas |

> ⚠️ Javítva (verifikáció) – a) sor: az eredeti „Ez az időpont a kibocsátás dátuma” állítás összemosta a *kiállítást* (8. § (6): a lezárás időpontja, kifejezetten a 8. § (1) d) pont, azaz az adatszolgáltatás alkalmazásában) és a *kibocsátást* (a NAV szerint a számla rendelkezésre bocsátása: „a kibocsátást – a számla rendelkezésre bocsátását – megelőzően”). Forrás: https://njt.hu/jogszabaly/2014-23-20-2X (8. § (6)); NAV 18. információs füzet, 3. fejezet [F16].
>
> ⚠️ Javítva (verifikáció) – k) sor: a 210/A. § (1) bek. szerint utazásszervezésnél az adóalapot és az áthárított adót „nem kell feltüntetni”, a (2) bek. szerinti vevői nyilatkozat esetén viszont fel kell tüntetni; ez nem azonos a 187. § (2) c), 142. § (7) és 222. § (1) b) szerinti tilalommal. Forrás: https://njt.hu/jogszabaly/2007-127-00-00 (210/A. §).

### 2.3 Mikor kell a vevő adószáma? [F1], [F16] **[magas]**

| Eset | Mit kell feltüntetni | Jogalap |
|---|---|---|
| Belföldi fordított adózás (142. §) | A vevő **teljes, 11 jegyű** adószáma. Belföldön áfaregisztrált külföldi eladó sem mentesül. | 169. § da) pont; NAV [F16] |
| Másik tagállamban teljesített, a vevő által adózott ügylet (pl. 37. § (1) bek. szerinti B2B szolgáltatás, szerelés) | A vevő **közösségi adószáma** | 169. § da) pont; NAV [F16] |
| Közösségen belüli adómentes termékértékesítés (89. §) | A vevő **közösségi adószáma** | 169. § db) pont |
| Belföldi B2B: a vevő belföldön nyilvántartásba vett adóalanyként jár el | Az adószám vagy csoportazonosító szám **első 8 számjegye**. Csak akkor kötelező, ha az eladó belföldön letelepedett; értékhatár nincs. | 169. § dc) pont |
| Nem adóalany magánszemély, harmadik országbeli vevő | Nem kötelező (név és cím igen) | 169. § e) pont |

Megjegyzés: a 169. § dc) pont szerint csoportos áfaalany vevőnél a **csoportazonosító szám** első 8 jegye kell. **[magas]**

### 2.4 Az Áfa tv.-n kívüli kötelező adatok

- **Egyéni vállalkozó:** „Az egyéni vállalkozó gazdasági tevékenysége során az »egyéni vállalkozó« megjelölést (vagy annak e.v. rövidítését) és nyilvántartási számát neve (aláírása) mellett minden esetben köteles feltüntetni.” (Evtv. 16. § (4) bek. [F9]). Ez a számlára is vonatkozik. **[magas]**
- **Cégek:** a cégjegyzékszámot a cég „az iratain fel kell tüntetnie” (Ctv. 44. § (1) bek.). Kft. és rt. írásbeli képviselete és hivatalos levelezése során fel kell tüntetni a cégbíróság nevét, a cég nevét, székhelyét és cégjegyzékszámát (Ctv. 63. § (2) bek. [F10]). Számlán ajánlott. **[közepes]** (a „hivatalos levelezés” fogalmának számlára való kiterjesztése értelmezés kérdése)
- **Aláírás nem követelhető meg:** „Törvény a számla adattartalmára további rendelkezéseket is megállapíthat, de a 175. § (2) bekezdésének a) pontjában említett eset kivételével a számla aláírását nem teheti kötelezővé.” (Áfa tv. 177. §). **[magas]**
- Az Áfa tv.-n kívüli jogszabály által előírt adat hiánya vagy hibája a NAV szerint nem érinti a vevő levonási jogát [F16]. **[magas]**

### 2.5 Gyűjtőszámla (164., 171. §) **[magas]**

- Ugyanannak a vevőnek ugyanazon a napon teljesített több ügyletéről külön megállapodás nélkül, a naptári hónapban teljesített ügyletekről előzetes megállapodás alapján állítható ki. A naptári hónapnál hosszabb, de az adómegállapítási időszakot meg nem haladó időszakról is kiállítható, ha nincs benne 89. §-os vagy fordítottan adózó, más tagállambeli szolgáltatás (164. § (1)–(3) bek.).
- Határidő: a 163. § szerinti ésszerű időt a hónap, illetve az adómegállapítási időszak utolsó napjától kell számítani (164. § (4) bek.). Havi bevallónál ez főszabályként a hónap utolsó napját követő 8. nap [F16].
- Tartalom: „…az összes számlakibocsátásra jogalapot teremtő ügyletet tételesen, egymástól elkülönítve úgy kell feltüntetni, hogy az egyes ügyletek adóalapjai – a 169. § j) és m) pontja szerinti csoportosításban – összesítetten szerepeljenek.” (171. §). A teljesítési időpont ügyletenként kötelező [F16].

---

## 3. Kötelező megjelölések – részletek

A teljes eset → szöveg → jogalap táblázat a **20. fejezetben** található. Itt a nem triviális szabályokat foglalom össze.

1. **Szó szerinti kifejezések.** A 169. § h), l), n), p), q) pontja „kifejezés” feltüntetését írja elő. Ezért a pontos magyar szöveg a biztonságos megoldás. Idegen nyelvű számlánál a magyar kifejezést és mellette a fordítást (pl. „fordított adózás / reverse charge”) javaslom. Hogy a kifejezés kizárólag idegen nyelven is elég-e, azt elsődleges forrásban nem találtam. **[közepes]**
2. **Adómentesség (m) pont).** Elég a jogszabályi (Áfa tv.) vagy irányelvi (2006/112/EK) hivatkozás, **vagy** „bármely más, de egyértelmű utalás”. Rögzített szöveg nincs. A program tárolja és nyomtassa a mentesség **jogcímét**, szöveges indoklását és a jogszabályhelyet. Ugyanezt a NAV-nak a `vatExemption/case` és `vatExemption/reason` mezőben kell beküldeni. A case-kódokat a 20. fejezet tartalmazza. **[magas]**
3. **Alanyi adómentes számla.** „…kizárólag olyan számla kibocsátásáról gondoskodhat, amelyben áthárított adó, illetőleg a 83. §-ban meghatározott százalékérték nem szerepel.” (187. § (2) bek. c) pont). A NAV szerint adómérték sem szerepelhet, mentességi utalás viszont kell [F16]. Egyszerűsített tartalom is választható (176. § (1) bek. e) pont, lásd a 4. fejezetet). **[magas]**
4. **Fordított adózás belföldön (142. §).** Kötelező a „fordított adózás” kifejezés és a vevő teljes adószáma. Tilos az áthárított adó és a százalékérték (142. § (7) bek.). A 142. § (1) bek. b) pontos (építési) és k) pontos (adóalany-kereskedő) esetekben a vevőnek előzetesen írásban kell nyilatkoznia. A program tárolja, hogy ez a nyilatkozat rendelkezésre áll. A 6/A–6/C. mellékletes termékeknél a bevalláshoz vtsz. szerinti bontás kell [F16]. **[magas]**
5. **Más tagállamban teljesülő B2B szolgáltatás (37. § (1) bek.).** Nincs magyar áfa. Kötelező a „fordított adózás” kifejezés (169. § n) pont) és a vevő közösségi adószáma (169. § da) pont). Határidő: a teljesítés hónapját követő hónap 15. napja (163. § (2) bek. a) pont). Egyszerűsített tartalommal is kiállítható (176. § (1) bek. c) pont, (2) bek. b) pont). Az ügyletet az összesítő nyilatkozatban (A60) is szerepeltetni kell; ez a felhasználó feladata. NAV-kód: `vatOutOfScope/case = EUFAD37`. **[magas]**
6. **Közösségen belüli adómentes termékértékesítés (89. §).** Kell a mentességre utalás és a vevő közösségi adószáma. Határidő: a teljesítés hónapját követő hónap 15. napja. Nyugta nem adható, a 900 000 Ft alatti mentesülés nem alkalmazható (165. § (2) bek.). Előlegre nem kell számla (159. § (4) bek.). NAV-kód: `KBAET`, illetve új közlekedési eszköznél `KBAUK`. A „fordított adózás” kifejezést a 169. § n) pont ennél az esetnél a NAV füzete szerint nem írja elő (a vevő a Közösségen belüli beszerzés címén adózik). **[közepes]** (a gyakorlat és a NAV füzete egybevág, kifejezett tilalom vagy előírás nincs)
7. **Termékexport (98. §).** Mentességi hivatkozás kell. NAV-kód: `EAM`. **[magas]**
8. **Harmadik országban teljesülő szolgáltatás.** Kötelező kifejezést nem találtam; „fordított adózás” csak akkor kell, ha a vevő az adófizetésre kötelezett (169. § n) pont). Javasolt szöveg: „Az Áfa tv. területi hatályán kívüli ügylet”. NAV-kód: `HO`. A 10. melléklet 5/A. pontja szerint adatot kell szolgáltatni arról, hogy az ügylet a törvény területi hatályán kívül esik. **[közepes]**
9. **Utazásszervezés (XV. fejezet), 2026-01-01-től.** A számlán az adóalapot és az áthárított adót nem kell feltüntetni, kivéve, ha az adóalany vevő a kiállításig nyilatkozik, hogy nem utazásszervezőként veszi igénybe a szolgáltatást (210/A. § (1)–(2) bek.). A NAV-adatszolgáltatásban az adóalapot és az adót forintban ekkor is szerepeltetni kell (210/A. § (3) bek.). **[magas]**
10. **Különbözet szerinti viszonteladó (XVI. fejezet).** Tilos az áthárított adó, az adómérték és a százalékérték (222. § (1) bek. b) pont, NAV [F16]). Kell a megfelelő „különbözet szerinti szabályozás – …” kifejezés. **[magas]**

---

## 4. Egyszerűsített számla és a nyugta/számla határa

### 4.1 Áfa tv. 176. § (szó szerint) [F1] **[magas]**

> **176. §** (1) A 169. §-tól eltérően a számla egyszerűsített adattartalommal is kibocsátható, ha
> a) a számlakibocsátásra jogalapot teremtő ügylet a 159. § (2) bekezdésének a) pontja alá tartozik, feltéve, hogy a számlán szereplő adatok egyébként forintban kifejezettek;
> b) a 159. § (2) bekezdésének b) pontjában és a 165. § (1) bekezdésének b) pontjában meghatározott esetben az ott említett személy, szervezet az adóalanytól számla kibocsátását kéri, feltéve, hogy a számlán szereplő adatok egyébként forintban kifejezettek;
> c) a számlakibocsátásra jogalapot teremtő ügylet a 159. § (2) bekezdésének c) vagy d) pontjai alá tartozik;
> d) a számla adóval növelt végösszege nem haladja meg a 100 eurónak megfelelő pénzösszeget, feltéve, hogy a számlakibocsátásra jogalapot teremtő ügylet a 29. § vagy a 89. § szerinti termékértékesítéstől eltérő ügylet, továbbá a számlakibocsátásra a 159. § (2) bekezdés c) és d) pontjában említett esetektől eltérő esetben kerül sor.
> e) a számlakibocsátásra jogalapot teremtő ügyletet a 187. § (1) bekezdése vagy a 195/G. § (1) bekezdése szerinti alanyi adómentesség hatálya alá tartozó adóalany e minőségében teljesíti.
> (2) A számla egyszerűsített adattartalma azt jelenti, hogy
> a) az (1) bekezdés a), b) és d) pontjában említett esetben a 169. §-ban felsorolt adatok közül az i) pontban megjelölt helyett az ellenérték adót is tartalmazó összege, valamint a j) pontban megjelölt helyett az alkalmazott adómértéknek megfelelő, a 83. § szerint meghatározott százalékérték feltüntetése kötelező azzal, hogy egyúttal a k) pontban megjelölt adat nem tüntethető fel;
> b) az (1) bekezdés c) pontjában említett esetben a 169. §-ban felsorolt adatok közül csak az a)–g) és n) pontban megjelöltek kitöltése, továbbá az i) pontban megjelölt helyett az ellenérték pénzben kifejezett összegének feltüntetése kötelező.
> c) az (1) bekezdés e) pontjában említett esetben a 169. §-ban felsorolt adatok közül csak az a)–g) és m) pontban megjelöltek kitöltése, továbbá az i) pontban megjelölt helyett az ellenérték pénzben kifejezett összegének feltüntetése kötelező.

**Programszintű következmények:**

- A 100 euró forintösszege a 256. § (1) bek. szerint 252,19 Ft/€ árfolyamon, 1000 Ft-ra kerekítve **25 000 Ft** (NAV [F16]). **[magas]**
- A 83. § szerinti százalékértékek: 27% → **21,26%**, 5% → **4,76%**, 18% → **15,25%**, 0% → **0%**. **[magas]**
- Egyszerűsített számlán (a, b, d esetek) tilos az áthárított adó összegét feltüntetni. A NAV-adatszolgáltatásban `invoiceCategory = SIMPLIFIED`, és a `vatContent` mező kell (a `vatPercentage` nem tölthető ki) [F19]. **[magas]**

### 4.2 Nyugta vagy számla (165–166. §) [F1], [F16] **[magas]**

- **Nyugta adható** (számla helyett), ha a vevő nem adóalany és nem jogi személy, a bruttó ellenértéket legkésőbb a teljesítésig **maradéktalanul megtéríti** – 2021-07-01 óta **bármilyen módon** (készpénz, kártya, átutalás); korábban csak készpénz, készpénz-helyettesítő fizetési eszköz, pénzhelyettesítő eszköz vagy többcélú utalvány számított –, és nem kér számlát (165. § (1) bek. b) pont, a 2020. évi CXVIII. tv. 45. § (1) bekezdésével megállapított szöveg). A 2023-07-15-i módosítás (2023. évi LIX. tv.) ettől független: a 163. § (2) bek. b) pont szerinti *haladéktalan számlakibocsátást* terjesztette ki minden fizetési módra (NAV [F16], 54. lábjegyzet).
  > ⚠️ Javítva (verifikáció): az eredeti szöveg a 2023-07-15-i dátumot a 165. § (1) b) ponthoz kötötte. A 2021.I.4. időállapotban a 165. § (1) b) még fizetőeszköz-korlátos volt, a 2021.VII.1. időállapotban már nem; a NAV 54. lábjegyzete a 163. § (2) b) pontra vonatkozik. Forrás: https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20210104 és …&timeshift=20210701; njt.hu Áfa tv. 426. lábjegyzet (https://njt.hu/jogszabaly/2007-127-00-00); NAV 18. információs füzet 54. lj. [F16].
- **Mindig számla kell**, ha:
  - a vevő adóalany vagy nem adóalany jogi személy (165. § (3) bek. a) pont);
  - a magánszemélytől származó bruttó ellenérték **eléri vagy meghaladja a 900 000 Ft-ot** (165. § (3) bek. b) pont);
  - az ügylet 89. §-os értékesítés vagy 6. § (4) bek. szerinti eset (165. § (2) bek.).
- **Előleg magánszemélytől:** 900 000 Ft-tól mindig számla kell, alatta csak kérésre (159. § (2) bek. b) pont).
- Nyugta helyett mindig adható számla (166. § (2) bek.). Nyugta csak magyar nyelvű lehet (178. § (4) bek.).
- **2026-09-01 óta** a nem (online vagy e-)pénztárgéppel kiállított nyugtákról (kézi és számítógépes) adatot kell szolgáltatni: „a kibocsátást követő 3 naptári napon belül … napi szinten összesítve, adómértékek szerinti bontásban” (Áfa tv. 11. melléklet B) 1. pont; KOBAK kézi rögzítés vagy M2M interfész [F22]). A NAV 2026-12-31-ig nem bírságol [F23]. **[magas]**
- **Számítógéppel előállított nyugta** (Számlarendelet 16. §): kihagyás és ismétlés nélküli sorszámozás és dokumentáció kell. A pénztárgépre kötelezett tevékenységeknél (Pénztárgéprendelet 1. melléklet) csak online pénztárgép vagy hardveralapú e-pénztárgép használható [F16]. **Javaslat: a nyugtakibocsátás ne legyen az MVP része.**

---

## 5. Határidők

### 5.1 Számlakibocsátás (163–164. §) [F1] **[magas]**

> **163. §** (1) Az adóalany a számla kibocsátásáról legkésőbb a) a teljesítésig, b) előleg fizetése esetében a fizetendő adó megállapításáig, de legfeljebb az attól számított ésszerű időn belül köteles gondoskodni.
> (2) Az (1) bekezdésben említett ésszerű idő
> a) a 89. § szerinti termékértékesítés vagy olyan szolgáltatásnyújtás esetén, amely után az adót a Héa-irányelv 196. cikkének tartalmában megfelelő tagállami szabályozás alapján a szolgáltatást igénybevevő fizeti, a teljesítés hónapját követő hónap 15. napján belüli,
> b) az a) pont alá nem tartozó, valamint a 167. § c) pontjától eltérő olyan esetekben, ahol az ellenértéket az (1) bekezdés a) pontjában, illetve a 164. § (1) bekezdés a) pontjában említett időpontig, előleg fizetése esetén a fizetendő adó megállapításáig megtérítik, haladéktalan,
> c) egyéb, a b) pont alá nem tartozó olyan esetben, amelyben a számla áthárított adót tartalmaz, vagy annak áthárított adót kellene tartalmaznia, 8 napon belüli
> számlakibocsátási kötelezettséget jelent.

| Eset | Határidő |
|---|---|
| Közösségen belüli adómentes termékértékesítés; más tagállamban teljesülő, a vevő által adózott B2B szolgáltatás | a teljesítés hónapját követő hónap **15. napja** |
| A vevő a teljesítésig (előlegnél a beérkezéskor) fizetett, bármilyen módon | **haladéktalanul** (kivéve automata berendezés) |
| Utólagos fizetés, és a számla áthárított adót tartalmaz (vagy kellene tartalmaznia) | a teljesítéstől számított **8 napon belül** |
| Utólagos fizetés, áthárított adó nélkül (pl. alanyi vagy tárgyi adómentes) | „ésszerű időn belül”; konkrét napszámot a törvény nem ad **[közepes]** |
| Gyűjtőszámla (havi vagy időszaki) | a fentiek a hónap, illetve az adómegállapítási időszak utolsó napjától számítva (164. § (4) bek.) |
| Számlával egy tekintet alá eső okirat | a 163. § szerinti idő a módosításra okot adó tény bekövetkeztétől számít (170. § (2) bek.) |

### 5.2 Online Számla adatszolgáltatás időzítése [F1], [F4] **[magas]**

- **Számlázó programmal kiállított számla:** a Számlarendelet 13/A. § (1) bekezdése szerint a program a 10. melléklet 4–5/C. pont szerinti adattartalmat „a számla, számlával egy tekintet alá eső okirat kiállításakor **azonnal**, XML-formátumban, az állami adó- és vámhatóság közleményében meghatározott módon és adatszerkezetben, elektronikus úton” továbbítja.
- **A kiállítás pillanata:** a számla akkor minősül kiállítottnak, „amely időponttal a számlázó program az előállított számla, számlával egy tekintet alá eső okirat adatait lezárja” (8. § (6) bek.). A **piszkozat tehát nem számla**; a lezárás visszafordíthatatlan.
- **Teljesítés:** az adatszolgáltatás akkor teljesült, ha szabályszerűen benyújtották, „és a sikeres feldolgozást az állami adó- és vámhatóság rendszere visszaigazolta” (13/A. § (3) bek.).
- **Hibakezelés** (13/A. § (4)–(7) bek.):
  - ha a NAV szerint az adat nem dolgozható fel, a hiba elhárítása után az adatszolgáltatást meg kell ismételni;
  - ha a sikeres visszaigazolás ellenére hiba derül ki, szintén ismételni kell, és az ismételt adatszolgáltatást a NAV rendszerében jóvá kell hagyni;
  - ha a hiba észlelésétől számított **3 munkanapon belül** nem sikerül elhárítani, a hiba elhárulásáig az adatokat a NAV felületén kézzel kell rögzíteni.
- **Üzemzavar** (13/B. § (3)–(5) bek.):
  - NAV-oldali üzemzavar, karbantartás vagy internetkiesés esetén az adatot a kiesés megszűnését követő **24 órán belül** kell továbbítani;
  - a számlázó fél rendszerének üzemzavaránál az elhárulást követő **24 órán belül**;
  - **48 óránál hosszabb** saját kiesésnél ezt legkésőbb a 48. óra leteltekor jelezni kell a NAV rendszerében, majd 24 órán belül kézi rögzítéssel kell teljesíteni. Az időkeret ismételt bejelentéssel 24 óránként meghosszabbítható.
- **Különleges eset** (13/A. § (8)–(9) bek.): ha a meghatalmazottként számlázó vevő külföldi, és belföldön nem nyilvántartott, az adatszolgáltatás más rendszerből, 6 napon belül is teljesíthető.
- **Nyomdai (kézi) számla:** a 10. melléklet 3. pontja szerint, ha az áthárított adó eléri vagy meghaladja az **500 000 Ft-ot**, az adatszolgáltatás határideje a kibocsátást követő naptári nap, egyébként **4 naptári nap**.

---

## 6. Az Online Számla adatszolgáltatás köre 2026-ban

### 6.1 Áfa tv. 10. melléklet (részlet, szó szerint) [F1] **[magas]**

> 1. Az adóalany köteles adatot szolgáltatni az adó- és vámhatóság részére azon általa teljesített termékértékesítésekről, szolgáltatásnyújtásokról kibocsátott vagy kiállított számláról, számlával egy tekintet alá eső okiratról, amelyre e törvény rendelkezéseit kell alkalmazni a 158/A. § értelmében, kivéve azon termékértékesítésről, szolgáltatásnyújtásról, melynek teljesítési helye a Közösség másik tagállama és amely tekintetében az adóalany adófizetési kötelezettségének a XIX/A., illetve a XIX/B. Fejezet szerinti különös szabályok szerint tesz eleget.
> […]
> 4. A számlázási funkcióval rendelkező programmal kiállított számla, számlával egy tekintet alá eső okirat esetében az adóalany külön jogszabályban meghatározott elektronikus módon teljesít adatszolgáltatást a számla, számlával egy tekintet alá eső okirat e törvény szerinti adattartalmáról, továbbá az adó alapjának meghatározásakor használt pénznemről, külföldi pénznem esetén a forintra átszámított adatokról és a forintra történő átszámításhoz alkalmazott, 80. § és 80/A. § szerinti árfolyamról. Nem adóalany természetes személy részére kibocsátott számla, számlával egy tekintet alá eső okirat esetében az adatszolgáltatás nem terjed ki a termék beszerzőjének, szolgáltatás igénybevevőjének nevére és címére.
> 4/A. Amennyiben az adóalany a 11. § szerinti termékértékesítést, a 14. § szerinti szolgáltatásnyújtást teljesít tőle eltérő személy, szervezet részére, köteles adatot szolgáltatni az ügylet 11. §, illetve 14. § hatálya alá tartozásáról, valamint arról, hogy a számlában feltüntetett áfát a termékbeszerző, szolgáltatást igénybe vevő köteles-e számára megtéríteni.
> 5. Amennyiben az adóalany az általa teljesített termékértékesítéshez, szolgáltatáshoz 59. § szerinti előleget kapott, a teljesítésről kibocsátott, kiállított számla, számlával egy tekintet alá eső okirat vonatkozásában az előleg figyelembevételével adódó különbözetről is szolgáltat adatot.
> 5/A. Amennyiben az adóalany belföldön kívül teljesített termékértékesítést, szolgáltatásnyújtást, köteles adatot szolgáltatni arról, hogy az ügylet e törvény területi hatályán kívül esik.
> 5/B. Amennyiben az adóalany a jogelődje által teljesített termékértékesítésről, szolgáltatásnyújtásról állít ki számlát, számlával egy tekintet alá eső okiratot, a jogelőd adószámáról is szolgáltat adatot.
> 5/C. Csoportos adóalany által teljesített termékértékesítésről, szolgáltatásnyújtásról a csoportos adóalany által kiállított számla, számlával egy tekintet alá eső okirat esetén az ügyletben résztvevő tag adószámáról is adatot kell szolgáltatni.
> 6. Az 1–5/C. pont szerinti adatszolgáltatást az állami adó- és vámhatóság által erre a célra biztosított elektronikus felületen kell teljesíteni. Az elektronikus felület az adóalany egyedi azonosítására szolgáló adatok igénylését követően használható. Az azonosító adatokat az adóalany vagy annak Air. szerinti állandó meghatalmazottja igényli.

### 6.2 Mi tartozik bele és mi nem

| Bizonylat vagy ügylet | Adatszolgáltatás | Megbízhatóság / forrás |
|---|---|---|
| Belföldi B2B, B2C (magánszemély), B2G számla | **igen**, értékhatár nélkül (2021-01-04 óta) | magas [F1], [F18] |
| Külföldi (EU-s vagy harmadik országbeli) vevőnek kiállított számla, amelyre a magyar számlázási szabályok vonatkoznak (158/A. §), beleértve a külföldön teljesített ügyletet (159. § (2) bek. c)–d) pont) | **igen** (5/A. pont: területi hatályon kívüli jelzés) | magas [F1], [F18] |
| Egyszerűsített számla, gyűjtőszámla, előlegszámla, végszámla | **igen** | magas [F1], [F19] |
| Módosító és érvénytelenítő okirat | **igen** (MODIFY, STORNO) | magas [F1], [F19] |
| Alanyi adómentes és különös adózási módot alkalmazó eladó számlái | **igen** | magas [F16], [F18] |
| OSS vagy IOSS (XIX/A., XIX/B. fejezet) szerinti, más tagállamban teljesülő ügylet | **nem** | magas [F1] |
| Más tagállam számlázási szabályai alá tartozó számla (158/A. § (2)–(4) bek.) | **nem** | magas [F1], [F18] |
| A 165. § (1) bek. a) pont szerinti tárgyi mentes ügyletről kiállított *számviteli bizonylat* | nem számla, így **nem** kell. A NAV szerint számviteli bizonylat marad akkor is, ha „számla” feliratot visel [F16]. | **közepes** (a NAV kifejezetten nem mondja ki a jelentési mentességet) |
| Díjbekérő, proforma | nem számla, **nem** kell (lásd a 8. fejezetet) | közepes |
| Nyugta | nem az Online Számlába kerül, hanem 2026-09-01-től a nyugtaadat-szolgáltatásba | magas [F1], [F22] |

### 6.3 Mit **nem szabad** beküldeni

Nem adóalany természetes személy vevőnél a vevő **neve és címe** nem küldhető be (10. melléklet 2. és 4. pont). A NAV megfogalmazásában: „nem szerepeltethető a vevő neve és címe, ha az nem adóalany természetes személy” [F18]. Technikailag ez a `customerVatStatus = PRIVATE_PERSON` értéket jelenti, név és cím nélkül [F19]. Az adószámos magánszemély, aki adóalanyként jár el, `DOMESTIC` státuszú. **[magas]**

---

## 7. Számlával egy tekintet alá eső okirat: módosítás és érvénytelenítés

### 7.1 Jogszabályi szöveg [F1] **[magas]**

> **168. §** (2) A számlával egy tekintet alá esik minden más, az (1) bekezdéstől eltérő okirat is, amely megfelel 170. §-ban meghatározott feltételeknek és kétséget kizáróan az adott számlára hivatkozva, annak adattartalmát módosítja.
>
> **170. §** (1) A 168. § (2) bekezdésében említett okirat kötelező adattartalma a következő:
> a) az okirat kibocsátásának kelte;
> b) az okirat sorszáma, amely az okiratot kétséget kizáróan azonosítja;
> c) hivatkozás arra a számlára, amelynek adattartalmát az okirat módosítja;
> d) [hatályon kívül helyezve]
> e) a számla adatának megnevezése, amelyet a módosítás érint, valamint a módosítás természete, illetőleg annak számszerű hatása, ha ilyen van.
> (2) A számlával egy tekintet alá eső okiratra egyebekben e törvénynek a számlára vonatkozó rendelkezéseit kell megfelelően alkalmazni azzal, hogy a 163. §-ban említett ésszerű időt a módosításra [(1) bekezdés e) pontja] jogalapot teremtő tény, egyéb körülmény bekövetkeztétől kell számítani.

### 7.2 Gyakorlati szabályok (NAV [F16], [F19])

- **Módosító (helyesbítő) okirat:** bármely adat (pl. mennyiség, ár, besorolási szám, hiányzó teljesítési dátum) változásakor. Egy okirat több számlát is módosíthat. Ha az adóalap vagy az adó is változik, csak olyan számlák vonhatók össze, amelyek korrekcióját ugyanabban az időszakban kell elszámolni. **[magas]**
- **Érvénytelenítő (sztornó) okirat:** az egész számla hatálytalanítására szolgál, például ha a számlát téves vevőnek állították ki (ilyenkor sztornó és új számla kell, módosítással nem javítható), vagy ha az ügylet meghiúsult. A sztornó és az új, helyes számla együtt módosítja az eredeti számlát (kétlépcsős módszer); mindkettőnek hivatkoznia kell a hibás számla sorszámára. **[magas]**
- **A kibocsátás előtt észlelt hiba** vagy a téves címzett által visszaküldött számla: az érvénytelenítő okiratot nem kell a téves címzettnek átadni, de a számlát a programban érvényteleníteni kell (NAV [F16]). **Törölni nem szabad**, mert a sorszámozás folytonossága sérülne. **[magas]**
- **Az adóalap és az adó nem válhat negatívvá.** Ha az előleg meghaladja a végszámla összegét, az előlegszámlát kell módosítani [F16], [F19]. **[magas]**
- **Módosító okirat nem módosítható.** A hibás módosítást az eredeti számla újabb módosításával kell javítani [F19]. **[magas]**
- **Sorszám:** az okirat saját, egyedi sorszámot kap (170. § (1) bek. b) pont), és a programmal előállított okiratra is kötelező a folytonos sorszámozás (170. § (2) bek., Számlarendelet 8. § (1) bek.). Közös vagy külön sorozat egyaránt elfogadott gyakorlat. **[közepes]** Az okirat sorszáma **nem egyezhet** az eredeti számláéval: 2025-09-15 óta ez ERROR (`560 INCORRECT_HEAD_DATA_MOD_REF_INVOICE_NUMBER`, a NAV-spec szerint MODIFY műveletre; a STORNO a 3.40-es átminősítés hatókörén kívül esik, de a 170. § (1) b) szerinti saját sorszám ott is kötelező) [F19]. **[magas]**
  > ⚠️ Javítva (verifikáció): a KPMG-re [F21] alapozott, közepes megbízhatóságú állítást az elsődleges forrás megerősíti és pontosítja (hatókör: MODIFY). Forrás: NAV-spec 2026.02.12, ERROR-tábla 66. sor és 5. fejezet „3.40-es alkalmazás verzió” – https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu

### 7.3 NAV-fogalmak: `modificationIndex`, `modifyWithoutMaster`, technikai érvénytelenítés [F19] **[magas]**

- **`invoiceOperation`:** `CREATE` (számla), `MODIFY` (módosítás), `STORNO` (érvénytelenítés). A módosító és a sztornó okiratban a `invoiceReference/originalInvoiceNumber` és a `modificationIndex` kitöltése kötelező.
- **`modificationIndex`:** a módosítás logikai sorrendje az eredeti számlán belül („az első módosításnál mindig 1”). Számlánként egyedinek kell lennie (`MODIFICATION_INDEX_NOT_UNIQUE` ERROR). A spec azt ajánlja, hogy a módosítás beküldése előtt az eredeti számla `DONE` státuszát kell megvárni, mert a feldolgozás aszinkron.
- **`modifyWithoutMaster`:** ezt kell jelölni, ha olyan alapszámlát módosítanak, amelyről nem történt adatszolgáltatás, és nem is fog.
- **Technikai érvénytelenítés** (`/manageAnnulment`, `annulmentOperation = ANNUL`): **nem a számla, hanem a hibás adatszolgáltatás** visszavonására szolgál. Szabályai:
  - csak `DONE` állapotú, legfeljebb WARN-t tartalmazó adatszolgáltatásra küldhető;
  - a NAV webes felületén a felhasználónak **jóvá kell hagynia**;
  - a jóváhagyás után a sorszám újra felhasználható;
  - a `completenessIndicator = true` (az adatszolgáltatás maga az e-számla) esetén nem alkalmazható.
  - Kódjai: `ERRATIC_DATA`, `ERRATIC_INVOICE_NUMBER`, `ERRATIC_INVOICE_ISSUE_DATE`, `ERRATIC_ELECTRONIC_HASH_VALUE`.
  - A NAV az ilyen adatokat kockázatelemzésre használhatja.
  - **Ha a számla tartalmilag hibás, nem technikai érvénytelenítés, hanem sztornó vagy módosító okirat kell.**

---

## 8. Előleg, végszámla, díjbekérő

- **Áfa tv. 59. §** [F1] **[magas]**:
  > (1) Termék értékesítése, szolgáltatás nyújtása esetében, ha a teljesítést megelőzően ellenértékbe beszámítható vagyoni előnyt juttatnak (a továbbiakban: előleg), a fizetendő adót pénz vagy készpénz-helyettesítő fizetési eszköz formájában juttatott előleg esetében annak jóváírásakor, kézhezvételekor, egyéb esetben annak megszerzésekor kell megállapítani.
  > (2) A jóváírt, kézhez vett, megszerzett előleget úgy kell tekinteni, mint amely a fizetendő adó arányos összegét is tartalmazza.
  >
  > (4) E § nem alkalmazható a 89. §-ban meghatározott feltételekkel adómentes termékértékesítésre.
- **Számlakötelezettség:** adóalanytól vagy jogi személytől kapott előlegről mindig kell számla; magánszemélytől 900 000 Ft-tól mindig, alatta kérésre (159. § (2) bek. a)–b) pont). A számla annak az ügyletnek az adatait tartalmazza, amelybe az előleg beszámít (159. § (3) bek.). A 89. §-os ügylet előlegéről nem kell számla (159. § (4) bek.). Határidő: az előleg beérkezésekor **haladéktalanul** (163. § (2) bek. b) pont). Egyszerűsített tartalommal is kiállítható, ha forintban szól (176. § (1) bek. a) pont). **[magas]**
- **Végszámla** (NAV-spec 2.9. pont [F19]):
  - a teljes ügyletet tartalmazza, ebből vonja le az előlegszámlá(ka)t, és az összesítés a különbözetet mutatja (10. melléklet 5. pont);
  - az előleg-tételsoron `advanceIndicator = true`; a végszámlán az `advancePaymentData` kitölthető (ilyenkor mindhárom almezője kötelező);
  - negatív végösszeg esetén a számla a hibás, nem az adatszolgáltatás; ha az előleg nagyobb a teljes ellenértéknél, az előlegszámlát kell módosítani;
  - devizás végszámlának **egy** árfolyama van, a beszámítás is ezzel történik; az `advanceExchangeRate` számviteli célú.
  - **[magas]**
- **Az előleg árfolyama:** a fizetendő adó megállapításakor (a jóváíráskor) érvényes árfolyam (80. § (1) bek. a) pont). **[magas]**
- **Díjbekérő (proforma):** ez fizetési felhívás, amely nem keletkeztet számlakötelezettséget. Az adókötelezettség az előleg vagy az ellenérték beérkezésével, illetve a teljesítéssel keletkezik (59., 163. §). Az Online Számla adatszolgáltatás csak „számlára” és „számlával egy tekintet alá eső okiratra” vonatkozik (10. melléklet 1. pont), ezért a díjbekérőt **nem kell és nem is szabad számlaként beküldeni**. Kifejezett NAV-állásfoglalást erről nem találtam. **[közepes]** A kockázat csökkentésére a díjbekérő:
  - viselje a „DÍJBEKÉRŐ – nem számla” feliratot;
  - kapjon a számláktól elkülönített sorszámtartományt;
  - ne tartalmazzon „áthárított adó” megnevezésű sort, csak tájékoztató bruttó, illetve áfa-összeget.

---

## 9. Devizás számla

### 9.1 Árfolyam-választás (80., 80/A. §) [F1] **[magas]**

> **80. §** (1) Termék értékesítése, szolgáltatás nyújtása, valamint termék Közösségen belüli beszerzése esetében, ha az adó alapja külföldi pénznemben kifejezett, a forintra történő átszámításhoz azt a (2) bekezdésben meghatározott árfolyamot kell alkalmazni, amely a) termék Közösségen belüli beszerzése, illetőleg előleg fizetése esetében, valamint a 60. §-ban említett esetekben a fizetendő adó megállapításakor, b) az 58. §-ban említett esetben a számla kibocsátásakor, c) egyéb esetekben pedig a teljesítéskor érvényes.
> (2) Az alkalmazandó árfolyam az az utolsó, az (1) bekezdésben meghatározott időpontban érvényes, az adott külföldi pénznem valamely egységének forintban kifejezett ára, amelyet a) belföldön pénzváltási engedéllyel rendelkező hitelintézet devizában eladási árként jegyez; vagy b) a Magyar Nemzeti Bank (a továbbiakban: MNB) hivatalosan közzé tesz, feltéve, hogy a forintra történő átszámításra kötelezett […] így dönt, és erről a döntéséről az állami adóhatóságnak előzetes bejelentést tesz.
> (3) A (2) bekezdés b) pontja szerinti választási jog úgy gyakorolható, hogy az valamennyi olyan termékértékesítésre, szolgáltatásnyújtásra és termék Közösségen belüli beszerzésre kiterjed, amely esetében az adó alapja külföldi pénznemben kifejezett.
> (4) Az a kötelezett, aki (amely) élt a (2) bekezdés b) pontjában említett választási jogával, attól a választása évét követő naptári év végéig nem térhet el.
>
> **80/A. §** (1) A 80. § (2) bekezdésétől eltérően az adó alapjának forintra történő átszámításához választható az EKB által a 80. § (1) bekezdésében meghatározott időpontban hivatalosan közzétett legutolsó árfolyam is. (2) Az eurótól eltérő fizetőeszközök közötti átváltást az egyes fizetőeszközök euróhoz viszonyított árfolyamának alkalmazásával kell végezni. (3) Az EKB által közzétett árfolyam választására az MNB által közzétett árfolyam választására vonatkozó rendelkezéseket kell alkalmazni.

**Választható árfolyamok:**

- **Banki deviza-eladási árfolyam:** bármely belföldi, pénzváltási engedéllyel rendelkező hitelintézeté, bejelentés nélkül.
- **MNB-árfolyam:** előzetes bejelentés kell, minden devizás ügyletre vonatkozik, és a választás évét követő év végéig kötelező.
- **EKB-árfolyam:** ugyanazokkal a feltételekkel, mint az MNB-árfolyam. Az MNB- és az EKB-árfolyam **együtt nem választható** (NAV [F16]).
- Ha az adott devizának nincs banki jegyzése, euróalapú keresztárfolyamot kell alkalmazni (80. § (5) bek.).

**Az árfolyam időpontja:**

- főszabály: a teljesítés napja;
- előleg és a 60. §-os esetek: a fizetendő adó megállapítása;
- 58. §-os időszakos elszámolás: a számla kibocsátása.

### 9.2 Mit kell forintban feltüntetni? **[magas]**

> **172. §** A 2. § a) pontja szerinti termékértékesítésről, szolgáltatásnyújtásról kibocsátott számlán az áthárított adót [169. § k) pontja] – a 80. § szerint meghatározott árfolyam alkalmazásával – forintban kifejezve abban az esetben is fel kell tüntetni, ha az egyéb adatok külföldi pénznemben kifejezettek.

- A számlán **csak az áthárított adót** kell forintban feltüntetni, és csak **belföldön teljesített** ügyletnél. A NAV szerint ezt a 2022-11-24-től hatályos módosítás tette egyértelművé [F16].
- Maga az árfolyam a számlán **nem kötelező** adat. Az adatszolgáltatásban viszont kötelező a pénznem, az árfolyam (`exchangeRate`: 1 egység értéke forintban) és a forintra átszámított adatok (10. melléklet 4. pont, [F19]). **[magas]**
- **Javaslat** (nem jogszabályi kötelezettség): a számlán is szerepeljen az árfolyam, annak forrása (bank neve, MNB vagy EKB) és dátuma, valamint a forintos adóalap és adó adómértékenként. **[közepes]**
- Az egyszerűsített számla a), b) esete csak forintban kiállított számlára alkalmazható (176. § (1) bek. a)–b) pont).
- **NAV-validáció:** a `1310 INCORRECT_HEAD_DATA_EXCHANGERATE_EXTREME` 2025-09-15 óta ERROR (CREATE és MODIFY; a STORNO kikerült a hatókörből) [F19]. A NAV-spec (2026.02.12) ERROR-táblája szerint a figyelt sávok (minimum–maximum, Ft/egység): **EUR 250–600**, USD 200–600, GBP 250–720, CHF 200–600, BGN 120–360, RON 50–180, PLN 50–180, SEK 20–72, NOK 20–72, CZK 5–48, ILS 40–240, DKK 20–120, BAM 100–360. A határok „külön értesítés nélkül változhatnak”, ezért a sávokat konfigurálható adatként kell kezelni. **[magas]**
  > ⚠️ Javítva (verifikáció): a KPMG-re hivatkozó „euróra 250 alatt vagy 500 felett” állítás hibás; az elsődleges forrásban az EUR felső határa 600 Ft. Forrás: NAV-spec 2026.02.12, ERROR-tábla 78. sor („a megjelölt pénznemhez tartozó árfolyam extrém”), 190. oldal – https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu

---

## 10. Kerekítés

### 10.1 Az áfa kerekítése

- **Az Áfa tv. nem ír elő kerekítési módszert:** nem dönti el, hogy tételenként vagy adómértékenként kell számolni, illetve hogy fillérre vagy egész forintra kell-e kerekíteni. A törvény csak annyit mond, hogy az adó mértéke az adóalap meghatározott százaléka (82. §), és az áthárított adót forintban is fel kell tüntetni (172. §).
- Az adóhatóságnak benyújtott *bevallási* adatok ezer forintra kerekítése (Art. 2. melléklet) a számlára nem vonatkozik. **[magas]**
- **NAV interfész-specifikáció** [F19]: „A beküldött számlaadatok számszaki összefüggéseinek vizsgálatakor a rendszer nem küld figyelmeztetést az olyan esetekben, amikor a számszaki eltérés ugyan létezik, de minden bizonnyal a kerekítésből adódik. Az így »tolerált« legnagyobb eltérés a nettó ár 1 százaléka, legalább 1 egység.” Valamint: „A jogszabály nem ír elő kötelezően követendő eljárást …” **[magas]**
  - **A ténylegesen alkalmazott tűrés (3.0):** „A tolerált eltérés a számított forintban kifejezett érték 1%-a, de legalább 1 HUF és a számla pénznemének 0,01 egysége közül a nagyobb.” Ezt használják az egyes számszaki WARN-ok (pl. `740 INCORRECT_LINE_CALCULATION_LINE_VAT_AMOUNT_HUF`, `INCORRECT_LINE_CALCULATION_NET_AMOUNT`). A tűrés csak WARN-szintű ellenőrzésekre vonatkozik; az ERROR-táblában nincs tűréses számszaki vizsgálat. **[magas]**
  > ⚠️ Javítva (verifikáció): a fenti általános idézet szó szerint szerepel a specifikációban (192. o.), de a tűrés képletét a 3.0-s „WARN működési módosítások” és az I. melléklet WARN-leírásai a fenti, forintalapú formában rögzítik; az implementációnak ezt kell követnie. Forrás: NAV-spec 2026.02.12, 5. fejezet és I. melléklet – https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
- **NAV-munkatárs a GitHubon** [F29]: kerekítési különbözet-sort a jogszabály nem ír elő; „bármely megoldás jó lehet, ha ténylegesen csak kerekítési különbözetet jelent”. **[közepes]**
- **Javasolt algoritmus** (implementációs döntés, nem jogszabályi kötelezettség):
  1. A tételsoron a nettó összeget, az áfát és a bruttó összeget a pénznem tizedesjegyeire kell kerekíteni (forintnál egész forintra, 0,5-től felfelé). Az összesítő adómértékenként a kerekített tételek összege legyen.
  2. Konzisztenciaszabály: nettó + áfa = bruttó, tételenként és összesítve is.
  3. Devizás számlánál a forintos áfát tételenként a forintosított nettó összegből kell számolni, és az összesítő a tételek összege legyen.
  4. Mindig ellenőrizni kell, hogy |áfa – nettó × kulcs| és a forintosított értékek eltérése a NAV-tűrésen belül marad (a számított forintérték 1%-a, de legalább 1 HUF és a pénznem 0,01 egysége közül a nagyobb); a program saját, szigorúbb célértéke: az eltérés 1 egység alatt legyen.
     > ⚠️ Javítva (verifikáció): a tűrés képlete a NAV-spec 3.0 szerint pontosítva (lásd fent, 10.1). Forrás: https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
  - **[közepes]**

### 10.2 Készpénzes kerekítés (2008. évi III. törvény) [F5] **[magas]**

> **1. §** (1) Forintban, készpénzzel (bankjegy vagy érme átadásával) történő fizetés esetén, ha a fizetendő végösszeg nem 5 forintra vagy annak egész számú többszörösére végződik, úgy – a 4. §-ban foglaltak kivételével – a 2. §-ban meghatározott kerekítési szabály alapján kell a készpénzben fizetendő végösszeget meghatározni és a pénzfizetésre irányuló kötelezettséget teljesíteni.
> (2) A nem 5 forintra vagy annak egész számú többszörösére végződő fizetendő végösszeg és az (1) bekezdés alapján meghatározott készpénzben fizetendő összeg különbsége kerekítési különbözetnek minősül.
> (3) A kerekítési különbözet vagyoni előnynek vagy hátránynak nem minősül, arról bizonylat kiállítása, illetve annak bizonylaton történő feltüntetése nem kötelező.
> **2. §** A kerekítés szabálya a következő: a) 0,01 forinttól 2,49 forintig végződő összegeket lefelé, a legközelebbi 0; b) a 2,50 forinttól 4,99 forintig végződő összegeket felfelé, a legközelebbi 5; c) az 5,01 forinttól 7,49 forintig végződő összegeket lefelé, a legközelebbi 5; d) a 7,50 forinttól 9,99 forintig végződő összegeket felfelé, a legközelebbi 0 forintra végződő összegre kell kerekíteni.
> **3. §** Bankkártyával való fizetés elfogadója dönthet úgy, hogy a bankkártyával való fizetés elfogadása során az 1. § szerinti kerekítési szabályokat alkalmazza. Erre a tényre a bankkártyával fizető személy figyelmét kifejezetten fel kell hívni.

**Következmények:**

- A kerekítés csak a **forintban, készpénzzel fizetendő végösszeget** érinti (kártyánál opcionális, előzetes tájékoztatással). Az adóalapot, az áfát és a számla bruttó végösszegét **nem**.
- A számlán nem kötelező feltüntetni. Ha mégis szerepel, külön „Kerekítés” és „Fizetendő (készpénz)” sorként jelenjen meg a bruttó végösszeg alatt.
- Az Online Számla adatszolgáltatás a kerekítetlen összegekkel történik. Ezt NAV-oldali válasz nélküli közösségi GitHub-szál támasztja alá [F30]. **[közepes]**

---

## 11. A 23/2014. (VI. 30.) NGM rendelet – számlázó programmal szembeni követelmények

Hatályos szöveg: **2026.01.01.** időállapot [F4]. Utolsó módosítása a 21/2025. (VII. 7.) NGM rendelet (e-pénztárgép, archiválás).

### 11.1 Fogalmak (2. §) **[magas]**

> 2. **számlázó program:** számla kibocsátására alkalmas számítástechnikai program, programfunkció, programmodul, ideértve az online számlázó rendszereket is;
> 3. **számlázó program azonosítója:** valamely számlázó program készítője vagy fejlesztője által meghatározott megnevezés, elnevezés, valamint a számlázó program különböző előállított változatainak megkülönböztetésére szolgáló betű és szám karaktersorozat, mozaikszó;
> 5. **adatexport:** az adóalany által elektronikus adathordozón tárolt adatoknak az állami adó- és vámhatóság rendelkezésére bocsátása a 2. melléklet szerint és a 3. mellékletben meghatározott adatszerkezetben vagy a 13/A. § (1) bekezdése szerinti közleményben meghatározott adatszerkezetben.

A rendelet hatálya a belföldön nyilvántartásba vett adóalanyra terjed ki (1/A. §).

### 11.2 Funkcionális követelmények (8. §) **[magas]**

> **8. §** (1) A számlázó programmal szemben követelmény, hogy
> a) a számlázó program – a (2)–(4) bekezdésben meghatározott eltérésekkel – kihagyás és ismétlés nélküli, folyamatos sorszámozást biztosítson, és
> b) [hatályon kívül helyezve: 17/2020. (XII. 30.) PM rendelet]
> c) rendelkezzen a 11/A. § szerinti, „adóhatósági ellenőrzési adatszolgáltatás” elnevezésű funkcióval, és
> d) biztosítsa a kiállított számla, valamint számlával egy tekintet alá eső okirat 13/A. § (1) bekezdés szerinti adatainak az állami adó- és vámhatóság részére történő, 13/A–13/B. § szerinti elektronikus úton történő továbbítását.
> (2) A számlázó programnak az adóalany nem magyarországi adószámán történő számla kibocsátásához a belfölditől elkülönített sorszámtartományt kell biztosítania.
> (3) A sorszámozás folyamatossága nem sérül, ha a) a csoportos adóalanyiságban részt vevő tagok belső, egymás közötti kapcsolataiban a számlának nem minősülő egyéb számviteli bizonylat kibocsátása, és b) a csoportos adóalanyiságban részt vevő tagok külső, harmadik személlyel szembeni kapcsolataiban a számla kibocsátása azonos sorszámtartományon belül történik.
> (4) A sorszámozás folyamatossága nem sérül akkor sem, ha a számla, az Áfa tv. 165. § (1) bekezdés a) pontjában meghatározott, valamint egyéb, az Áfa tv. tárgyi hatálya alá nem tartozó ügyletről kibocsátott számviteli bizonylat kibocsátása azonos sorszámtartományon belül történik.
> (5) Abban az esetben, ha a program egyaránt alkalmas számla és nyugta előállítására, számla és nyugta kibocsátása elkülönített sorszámtartományon is történhet.
> (6) A számlázó programmal előállított számla, számlával egy tekintet alá eső okirat az (1) bekezdés d) pontja alkalmazásában abban az időpontban minősül kiállítottnak, amely időponttal a számlázó program az előállított számla, számlával egy tekintet alá eső okirat adatait lezárja.

**Értelmezés:**

- **Több sorozat:** a rendelet több sorszámtartományt feltételez (8. § (2) és (5) bek., 15. § (1) bek. b) pont: a meghatalmazottal egyeztetett tartomány). Több sorozat tehát megengedett, ha **mindegyik sorozaton belül** folyamatos a sorszámozás, és a teljes sorszám az adóalanyon belül egyedi (NAV ERROR). **[közepes]**
- **Évenkénti újraindítás:** évszámos előtaggal (pl. `2026/000001`) a gyakorlatban elfogadott, mert a sorszám egyedi marad. **[közepes]**
- **Törlés és módosítás:** a kiállított számla törlése sorszám-kihagyást okozna (8. § (1) bek. a) pont), és sértené az adattartalom sértetlenségét (Áfa tv. 168/A. §; Számv. tv. 166. § (2) bek., 167. § (7) bek., 169. § (5) bek.). Javítani **csak új okirattal** lehet (Áfa tv. 168. § (2) bek., 170. §). **[magas]**
- **Naplózás:** a rendelet külön audit-logot nem ír elő. A sértetlenség és a „csak dokumentált funkció” követelmény, valamint a digitális archiválás védelmi előírásai [F6] miatt azonban a megváltoztathatatlan eseménynapló erősen ajánlott. **[közepes]**
- **„Eredeti” vagy „másolat” felirat:** jelenleg nincs ilyen jogszabályi előírás. A papíralapú számla kibocsátónál maradó példánya a „másodlati példány” (Áfa tv. 179. § (2) bek.). Az újranyomtatás „Másolat” jelölése jó gyakorlat. **[közepes]**
- **Offline működés:** a számla kiállítása nem függ a NAV elérhetőségétől. Az adatszolgáltatást a 13/B. § szerinti határidőkkel kell pótolni (lásd az 5.2. pontot). **[magas]**

### 11.3 A fejlesztő és a forgalmazó kötelezettségei (9–10. §) **[magas]**

> **9. §** (1) A számlázó programot fejlesztőként, forgalmazóként értékesítő adóalany köteles az általa értékesített számlázó programot annak neve, azonosítója, a vevő neve és az értékesítés időpontja szerint nyilvántartani.
> (2) A számlázó program fejlesztője, forgalmazója a számlázó programot kizárólag adóalanynak értékesítheti, aki vagy amely köteles az értékesítést megelőzően adóalanyiságát igazolni. A számlázó program fejlesztője, forgalmazója köteles a számlázó program értékesítéséről kibocsátott számlán feltüntetni a számlázó programot beszerző adóalany adószámát.
>
> **10. §** (1) A számlázó program értékesítésekor, rendelkezésre bocsátásakor az értékesítő, rendelkezésre bocsátó köteles a vevő, felhasználó részére átadni vagy egyéb módon rendelkezésére bocsátani a számlázó program fejlesztője által készített felhasználói dokumentációt, valamint tájékoztatnia kell a vevőt, felhasználót a számlázó program nevéről és azonosítójáról.
> (2) Az (1) bekezdés szerinti dokumentációnak tartalmaznia kell a számlázó program működésére, használatára vonatkozó részletes leírást és a számlázó program valamennyi funkciójának ismertetését. **A számlázó program kizárólag a dokumentációban szereplő funkciókat hajthatja végre.**
> (3) A számlázó program funkcióinak módosítása esetén az értékesítő, rendelkezésre bocsátó köteles gondoskodni arról, hogy a vevő, felhasználó rendelkezésére álljon az (1) bekezdés szerinti dokumentáció funkciómódosítást leíró kiegészítése, módosítása.
> (4) A számlázó programot használó adóalany az (1) bekezdés szerinti dokumentációt, valamint annak (3) bekezdése szerinti valamennyi kiegészítését, módosítását az ezen számlázó programmal kibocsátott számlában áthárított adó megállapításához való jog elévüléséig köteles megőrizni. […]
> (5) A (2) és a (4) bekezdésben a dokumentáció tekintetében meghatározott kötelezettségek vonatkoznak a saját fejlesztésű programot használó adóalanyra is.
> (6) Amennyiben az (1) bekezdés szerinti dokumentáció nem magyar, német, francia vagy angol nyelvek bármelyikén készült, annak magyar nyelven történő rendelkezésre állásáról a) a számlázó programot értékesítő, rendelkezésre bocsátó köteles gondoskodni, feltéve, hogy belföldön nyilvántartásba vett adóalany, b) egyéb, az a) pont alá nem tartozó esetben a számlázó programot használó adóalany köteles gondoskodni.

**Következmények a projektre:**

- A 9. § az **értékesítést** végző adóalanyra vonatkozik. Ingyenes, nyílt forráskódú terjesztésnél ezt nem tartom alkalmazandónak. Fizetős hosztolt szolgáltatásnál, támogatási szerződésnél vagy terjesztésnél viszont a szolgáltató köteles az eladási nyilvántartásra, az adóalanyiság ellenőrzésére és a vevő adószámának feltüntetésére a számlán. **[közepes]**
- A 10. § **a „rendelkezésre bocsátásra” is vonatkozik**, tehát a nyílt forráskódú kiadásra is. Kötelező:
  - verziózott felhasználói dokumentáció **minden funkcióról**, beleértve **minden MCP-toolt, CLI-parancsot és webes műveletet**;
  - név és verzióazonosító;
  - funkcióváltozáskor dokumentáció-kiegészítés.
  - **[magas]**
- Az MI-ügynökök csak dokumentált funkciókat hívhatnak. Általános adatbázis-író vagy „raw SQL” tool **nem** tehető közzé. **[közepes]** (értelmezés, de a 10. § (2) bek. szövegéből egyenesen következik)

### 11.4 „Adóhatósági ellenőrzési adatszolgáltatás” és export (11/A., 18–19. §) **[magas]**

> **11/A. §** A számlázó programnak olyan önálló, de a programba beépített, „adóhatósági ellenőrzési adatszolgáltatás” elnevezésű funkcióval kell rendelkeznie, amelynek elindításával adatexport végezhető a) a kezdő és záró dátum (év, hónap, nap) megadásával meghatározható időszakban kibocsátott, illetve b) a kezdő és a záró számlasorszám megadásával meghatározható sorszámtartományba tartozó számlákra.
>
> **19. §** Adóhatósági ellenőrzés céljából az adóalany az xml formátumban megőrzött számla adatait a 2. melléklet szerint és a 3. mellékletben meghatározott adatszerkezetben, az egyéb elektronikus formában megőrzött számla esetében a 2. melléklet szerint és a 3. mellékletben meghatározott adatszerkezetben, vagy pdf formátumban köteles rendelkezésre bocsátani.

- **Az export formátuma:**
  - az *adatexport* fogalma (2. § 5. pont) a 3. mellékletbeli XSD-t **vagy** a NAV-közlemény szerinti (Online Számla) adatszerkezetet engedi;
  - a 19. § viszont az XML-ben őrzött számlákra csak a 2–3. melléklet szerinti szerkezetet nevesíti, az egyéb elektronikus számlákra a PDF-et is;
  - a NAV 2026-os füzete [F16] ugyanígy fogalmaz.
  - **Biztonságos megoldás: mindkét XML-export (3. melléklet + OSA v3) és a PDF-ek egyben.** **[magas]**
- **A 3. melléklet szerinti XSD:**
  - névtér `http://schemas.nav.gov.hu/2013/szamla`, gyökérelem `szamlak` (`szamlak_tipus`);
  - fejelemek: `export_datuma`, `export_szla_db`, `kezdo_ido`, `zaro_ido`, `kezdo_szla_szam`, `zaro_szla_szam`;
  - számlánként `szamla` → `fejlec` (`szlasorszam`, `szlatipus`, `szladatum`, `teljdatum`), `szamlakibocsato`, `vevo`, `kepviselo`, `termek_szolgaltatas_tetelek`, `modosito_szla`, `gyujto_szla`, `zaradekok` (`penzforgelsz`, `onszamla`, `ford_ado`, `adoment_hiv`, `kulonb_szer_szab` …), `nem_kotelezo`, `osszesites`;
  - a dokumentáció szerint „Utolsó módosítás: 2014.01.29”;
  - a teljes XSD szövege a njt-n, a rendelet 3. mellékleteként érhető el.
  - **[magas]**
- **Ellenőrzéskor** az adóalany köteles biztosítani az olvasáshoz szükséges eszközöket, azok dokumentációját és a szükséges felvilágosítást, valamint az elektronikus kimenetet és az adatok külső adathordozóra archiválását (18. §). **[magas]**

### 11.5 Online adatszolgáltatás (13/A–13/C. §) **[magas]**

A 13/A. és 13/B. § lényegét az 5.2. pont tartalmazza. Kiegészítések:

- **13/A. § (2) bek.:** a gép-gép interfész használatának feltétele a technikai adatok (technikai felhasználó, kulcsok) adóalany általi bejelentésén alapuló nyilvántartásba vétel. Ez felhasználói feladat.
- **13/C. §: számlakibocsátás a NAV útján.**
  - Az adóalany az elektronikus számlát a NAV infrastruktúráján is a vevő rendelkezésére bocsáthatja (`completenessIndicator = true`, kötelező `electronicInvoiceHash` SHA3-512 értékkel, nagybetűs hexában [F19]).
  - Magánszemély vevőnél nem alkalmazható, és akkor sem, ha a módosított számláról az adatszolgáltatás nem így történt.
  - A számlázási és megőrzési kötelezettségeket nem érinti.
  - Ilyenkor technikai érvénytelenítés nem lehetséges. **MAY.**
- **15. §: meghatalmazott számlakibocsátó.** A számla másolatát vagy elektronikus példányát haladéktalanul a kötelezett rendelkezésére kell bocsátani. Számlázó programnál a felek előzetesen és írásban megállapodnak a sorszámtartományról. Több megbízónál elkülönített nyilvántartás kell.
- **17. §:** a papírra nyomtatott számla kibocsátónál maradó példánya elektronikus adatállományként is megőrizhető az 1/2018. (VI. 29.) ITM rendelet szerint.

---

## 12. Bejelentési és regisztrációs kötelezettségek (felhasználó, fejlesztő)

| Kötelezett | Kötelezettség 2026-10-27-én | Jogalap | Megbízhatóság |
|---|---|---|---|
| Számlázó programot használó adóalany | **„SZAMLAZO” bejelentés: MEGSZŰNT.** A NAV szövege szerint a kötelezettség „2021. január 4-én vesztette hatályát”, a 2021-01-04-én vagy azt követően keletkezett tényekre „már nem áll fenn bejelentési, illetve adatszolgáltatási kötelezettség”. | 17/2020. (XII. 30.) PM rendelet 3–5. §; NAV [F17] | magas |
| Ugyanő | Regisztráció az Online Számla rendszerben (elsődleges felhasználó: törvényes képviselő vagy állandó meghatalmazott), **technikai felhasználó** és kulcsok igénylése a gép-gép kapcsolathoz | Áfa tv. 10. melléklet 6–8. pont; Számlarendelet 13/A. § (2) bek. | magas |
| Ugyanő | Ha MNB- vagy EKB-árfolyamot választ: **előzetes bejelentés** a NAV-nak (bejelentő- vagy változásbejelentő lapon) | 80. § (2) bek. b) pont, 80/A. § (3) bek.; NAV [F16] | magas |
| Ugyanő | Alanyi adómentesség, illetve pénzforgalmi elszámolás választása: nyilatkozat a tárgyévet megelőző év utolsó napjáig | 192. § (2) bek., 196/G. § (2) bek.; NAV [F28] | magas |
| Ugyanő | A program dokumentációjának és minden kiegészítésének megőrzése az elévülésig | Számlarendelet 10. § (4)–(5) bek. | magas |
| Fejlesztő vagy forgalmazó | **Nincs NAV-bejelentés vagy -regisztráció.** Értékesítéskor nyilvántartás és adóalanyiság-ellenőrzés kell (9. §); értékesítéskor és rendelkezésre bocsátáskor dokumentáció, név és azonosító (10. §). | Számlarendelet 9–10. § | magas |
| Fejlesztő (közvetett) | A NAV „hivatalból … elektronikus úton tájékoztatja az online számlaadat-szolgáltatásra használt számlázó programnak az adatszolgáltatásban rögzített adószám alapján beazonosítható fejlesztőjét a hibás adatszolgáltatások okainak feltárásához …”. Ez az adatszolgáltatás `software` blokkjában lévő `softwareDevTaxNumber` alapján történik [F19]. | Art. 131. § (30) bek. [F2] | magas |
| Fejlesztő (jövő) | **Tervezett** kötelező szoftver-akkreditáció a ViDA-bevezetés keretében: önkiszolgáló, NAV-tól kapott XML-esetekkel; előzetes akkreditáció a számlázási szolgáltatóknak, adózói akkreditáció a saját szoftvert használóknak; pozitív lista. **Nincs jogszabály.** | NAV–NGM koncepció [F24] | alacsony (terv) |

---

## 13. Elektronikus számla és megőrzés

### 13.1 Fogalom és feltételek [F1] **[magas]**

- **Fogalom** (259. § 5. pont): „elektronikus számla: az e törvényben előírt adatokat tartalmazó számla, amelyet elektronikus formában bocsátottak ki és fogadtak be.” **Az e-mailben küldött PDF e-számlának minősül** (NAV: „elektronikus számla a kizárólag e-mailben megküldött számla is” [F16]).
- **Hitelesség, sértetlenség, olvashatóság** (168/A. §): „(1) A számla kibocsátásának időpontjától a számla megőrzésére vonatkozó időszak végéig biztosítani kell a számla eredetének hitelességét, adattartalma sértetlenségét és olvashatóságát. (2) Az (1) bekezdésben említett követelménynek bármely olyan üzleti ellenőrzési eljárással eleget lehet tenni, amely a számla és a termékértékesítés vagy a szolgáltatásnyújtás között megbízható ellenőrzési kapcsolatot biztosít.”
- **Biztonságos megoldások** (175. § (2) bek.): „a) minősített elektronikus aláírással látják el; vagy b) az elektronikus adatcsererendszerben (a továbbiakban: EDI) elektronikus adatként hozzák létre és továbbítják.” Ezek nem kötelezőek. Más esetben az üzleti ellenőrzési eljárás biztosítja a követelményeket.
- **Beleegyezés** (175. § (3) bek.): EDI esetén előzetes, írásbeli megállapodás kell, egyébként „a számlabefogadó beleegyezése”. A NAV szerint ez hallgatólagos is lehet, például a számla kifizetése [F16].
- **Számlaköteg** (175. § (6) bek.): ugyanannak a befogadónak küldött kötegben a közös adatokat elég egyszer feltüntetni.

### 13.2 Megőrzés és archiválás **[magas]**

> **Áfa tv. 179. §** (1) Minden személy, szervezet, aki (amely) e törvényben szabályozott jogot gyakorol, illetőleg akire (amelyre) e törvény kötelezettséget állapít meg, köteles az adómegállapítás hiánytalan és helyes volta ellenőrizhetőségének érdekében az általa vagy nevében kibocsátott, valamint a birtokában levő vagy egyéb módon rendelkezésére álló okiratot legalább az adó megállapításához való jog elévüléséig megőrizni.
> (2) […] Elektronikus okirat kizárólag elektronikus formában őrizhető meg. A kötelezettség teljesítését nem befolyásolja az elektronikus okirat formátumának a 168/A. §-ban foglalt követelményeknek megfelelő megváltoztatása. A megőrzési kötelezettség elektronikus formában történő teljesítése esetén az adóalanynak elektronikusan kell megőriznie a számla eredetének hitelességét, adattartalma sértetlenségét biztosító adatokat is.

| Szabály | Időtartam vagy forma | Forrás |
|---|---|---|
| Áfa tv. 179. § (1) bek. és Art. 78. § (3) bek. | Az adómegállapításhoz való jog elévüléséig: annak az évnek az utolsó napjától számított **5 év**, amelyben a bevallást be kellett nyújtani (Art. 202. § (1) bek.) | [F1], [F2] |
| Számv. tv. 169. § (2) bek. (gazdálkodók, pl. Kft., Zrt.) | A könyvviteli elszámolást alátámasztó bizonylatot „legalább 8 évig kell olvasható formában, a könyvelési feljegyzések hivatkozása alapján visszakereshető módon megőrizni” | [F3] |
| Számv. tv. 169. § (5) bek. | Az elektronikus bizonylatot elektronikusan kell megőrizni, a digitális archiválás szabályai szerint, úgy, hogy az „összes adatának késedelem nélküli előállítását, folyamatos leolvashatóságát” biztosítsa, és „kizárja az utólagos módosítás lehetőségét” | [F3] |
| KATA 11. § (5) bek. | A bizonylatot és a nyilvántartást „a kiállítás adóévét követő 5. naptári év végéig” kell megőrizni | [F8] |
| Számlarendelet 10. § (4) bek. | A program dokumentációját és annak kiegészítéseit az elévülésig kell megőrizni | [F4] |

**1/2018. (VI. 29.) ITM rendelet** [F6] **[magas]**:

- **3. §:** az elektronikus dokumentumot a megőrzési idő végéig védeni kell „a törlés, a megsemmisítés, a véletlen megsemmisülés, az utólagos módosítás és sérülés, valamint a jogosulatlan hozzáférés ellen”. Az értelmezhetőséget (megjelenítő szoftver és hardver) fenn kell tartani.
- **6. §: zárt rendszer.**
  - A zárt rendszerű archiválást lehetővé tevő szoftver „fejlesztőjének írásban kell nyilatkoznia arról, hogy az maradéktalanul megfelel a jogszabályi előírásoknak”.
  - A fejlesztő és a megőrzésre kötelezett **egyetemlegesen felel**.
  - A szoftvernek dokumentációval kell rendelkeznie a működésről, a technológiákról, a szabványokról, a zártságot garantáló megoldásokról és az ellenőrzésekről. → Nyílt forráskódú projektnél ez kockázat (lásd a 19. fejezetet).
- **7. §: hash-alapú megoldás e-számlára.**
  - A kötelezett a NAV közleménye szerint egyirányú hash-kódot képez az elektronikus számla dokumentumról, és azt a Számlarendelet szerinti adatszolgáltatásban megküldi.
  - Ha a NAV a sikeres feldolgozást visszaigazolja, „biztosítható az elektronikusan megőrzött számla … adattartalmának védelme és az eredet hitelessége”.
  - A hash-kódot és a dokumentumot együtt kell megőrizni.
  - Online Számlában ez az `electronicInvoiceHash` mező (`cryptoType`: SHA3-512 vagy SHA-256; `completenessIndicator = true` esetén csak SHA3-512, nagybetűs hexa) [F19]. **Ez a legolcsóbb, jogilag nevesített archiválási út.**

---

## 14. Nyelv és pénznem [F1], [F3] **[magas]**

- **Áfa tv. 178. §:**
  - „(2) Számla magyar nyelven vagy élő idegen nyelven egyaránt kiállítható.”
  - „(3) Idegen nyelven kiállított számla esetében az adóigazgatási eljárás keretében lefolytatott ellenőrzés során a számla kibocsátójától megkövetelhető, hogy saját költségére gondoskodjon a hiteles magyar nyelvű fordításról, feltéve, hogy a tényállás tisztázása másként nem lehetséges.”
  - „(4) Nyugta kizárólag magyar nyelven állítható ki.”
- **Számv. tv. 166. §:**
  - (3) bek.: a számviteli bizonylatot főszabályként magyar nyelven kell kiállítani; más nyelven is feltüntethetők az adatok;
  - (4) bek.: idegen nyelvű bizonylatnál a hitelességhez és a könyveléshez szükséges adatokat a könyvelést megelőzően, belső szabályzat szerint, magyarul is fel kell tüntetni.
  - → A kétnyelvű (HU+EN) számlakép ajánlott.
- **Pénznem:** a számla bármely pénznemben kiállítható. Az ellenérték pénznemét nem az Áfa tv. szabályozza [F16]. Belföldi ügyletnél az áthárított adót forintban is fel kell tüntetni (172. §). Az adatszolgáltatásban a pénznem ISO 4217 kódja (`currencyCode`), az árfolyam és a forintos adatok szerepelnek.

---

## 15. Támogatandó eladói státuszok (2026)

| Státusz | Számlázási következmény | Jogalap / forrás | Megbízhatóság |
|---|---|---|---|
| **Általános áfaalany** (társaság vagy egyéni vállalkozó) | Teljes 169. §-os tartalom, adómértékek: 27, 18, 5, 0% (3., 3/A., 3/B. melléklet; a listák 2026-ban is változtak) | 82. §; F14 | magas |
| **Alanyi adómentes (AAM)** | Értékhatár 2026: **20 000 000 Ft** (188. § (2) bek., 377. §), 2027: **22 000 000 Ft** (378. §; a 188. § (2) bek. 2027-01-01-től hatályos szövege), 2028: **24 000 000 Ft** (a 188. § (2) bek. 2028-01-01-től hatályos szövege; NAV [F28]). Nincs áthárított adó, mérték vagy százalékérték (187. § (2) bek. c) pont), kell mentességi utalás (169. § m) pont). Egyszerűsített tartalom választható (176. § (1) bek. e) pont). **Adatszolgáltatási kötelezettség van.** Bizonyos ügyletek nem alanyi mentesek (193. §), például a vállalkozásban tárgyi eszközként használt termék értékesítése (188. § (3) bek. a) pont), a 11. § szerinti termékértékesítés, a 14. § szerinti szolgáltatásnyújtás, az új közlekedési eszköz 12. § szerinti értékesítése és a Közösségen belüli beszerzés. EU-s AAM: „EX” utótagú azonosító (195/I. §; NAV [F16]). | [F1], [F16], [F28] | magas |
| **KATA kisadózó** (csak főfoglalkozású egyéni vállalkozó) | **Nincs KATA-specifikus számlaadat.** A tételes adó 50 000 Ft/hó; a 18 millió Ft keretösszeg felett 40% különadó (7. §). **Ha kifizetőtől (pl. cégtől) szerez bevételt, a KATA-alanyiság a bevétel megszerzését megelőző nappal megszűnik** (5. § (1) bek. g) pont; kivétel a taxi), és ezt 15 napon belül be kell jelenteni. Áfa szempontból AAM vagy áfaalany lehet. Az Online Számlában opcionális a `smallBusinessIndicator` („Kisadózó jelzése”) [F19]. A bevételi nyilvántartást a számlák teljes körű megőrzése kiválthatja (11. § (3) bek.). | [F8], [F19] | magas |
| **Egyéni vállalkozó vs. társaság** | EV: „egyéni vállalkozó” vagy „e.v.” megjelölés és nyilvántartási szám (Evtv. 16. § (4) bek.); a megőrzés az Art. szerinti elévülésig tart. Társaság: cégjegyzékszám (Ctv. 44. § (1) bek.; Kft. és rt.: 63. § (2) bek.), a Számv. tv. szerint 8 év megőrzés. | [F9], [F10], [F3] | magas |
| **Pénzforgalmi elszámolás** (XIII/A. fejezet) | Kisvállalkozás, értékhatár **125 000 000 Ft** (196/C. §), AAM-mel nem kombinálható. Kötelező a „pénzforgalmi elszámolás” kifejezés (169. § h) pont), hiányában a módszer nem alkalmazható (196/B. § (4) bek.). Nem kell a 89. §-os, a 10. § a) pont szerinti és a fordítottan adózó ügyleteknél [F16]. A módosításnak külön időzítési szabályai vannak (196/B. § (2) bek. c) pont). NAV: `cashAccountingIndicator = true`. | [F1], [F16] | magas |
| **Csoportos áfaalany** | Az eladó a csoportazonosító számot és a tag saját adószámát is feltünteti (Art. 30. § (2) bek.). Az adatszolgáltatás tartalmazza a tag adószámát (10. melléklet 5/C. pont, 2026-01-01). A program sorszámozása a csoporton belül közös lehet (Számlarendelet 8. § (3) bek.). | [F1], [F2], [F4] | magas |
| **Különbözeti adózás** (viszonteladó, utazásszervező) | Lásd a 3. fejezetet és a 20. fejezetet. | [F1] | magas |
| **Mezőgazdasági különleges jogállás** (kompenzációs felár), **felvásárlási okirat** | Az adóalap, a mérték és az áfa helyett a felár adatai szerepelnek (202. § (2) bek. b) pont). Felvásárlási okiratot csak a vevő állíthat ki, aláírással. **MAY / későbbi fázis.** | [F1], [F16] | magas |
| **Jogutód kibocsátó** | A jogelőd teljesítéséről kiállított számlánál a jogelőd adószámáról is adatot kell szolgáltatni (10. melléklet 5/B. pont, 2026-01-01). A NAV spec a `predecessorTaxNumber`-t a 3.35-ös alkalmazásverzióban vezette be. | [F1], [F19] | magas |

> ⚠️ Javítva (verifikáció) – AAM sor: a 2028-as 24 M Ft-os értékhatár a kihirdetett törvényszöveg jövőbeli időállapotában szerepel, nem csak NAV-közlés; a megbízhatóság ezért „magas”. Forrás: https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20280101 (188. § (2): „24 000 000 forintnak megfelelő pénzösszeg”).

---

## 16. Szankciók (röviden) [F2], [F15] **[magas]**

| Szabálysértés | Szankció | Jogalap |
|---|---|---|
| Általános mulasztás (hibás, hiányos, késedelmes vagy elmulasztott teljesítés) | Természetes személy: legfeljebb **400 000 Ft**; nem természetes személy: legfeljebb **1 000 000 Ft** (2025-01-01-től; korábban 200 000 / 500 000 Ft) | Art. 220. § (1)–(2) bek.; a 2024. évi LV. tv. 142. § 9. pont, hatályba lépett 2025-01-01-jén [F11], [F15] |
| **Online Számla (összesítő jelentés) adatszolgáltatás** elmulasztása, késedelme, hiányos, hibás vagy valótlan teljesítése | Felső határ: **az érintett számlák száma × az általános bírság maximuma**, azaz számlánként 1 000 000 Ft (nem természetes személy) vagy 400 000 Ft (természetes személy) | Art. 229. § („Az általános forgalmi adó összesítő jelentés szerinti adatszolgáltatási kötelezettség …”); a 10. melléklet címe „Összesítő jelentés” |
| Számla-, egyszerűsített számla- vagy nyugtakibocsátás elmulasztása, nem a tényleges ellenértékről történő kibocsátás, iratmegőrzés elmulasztása | Legfeljebb **2 000 000 Ft** (2025-01-01-től; korábban 1 000 000 Ft) | Art. 228. § (1) bek. [F15] |
| Üzlethelyiségben elmulasztott számla- vagy nyugtaadás | Mulasztási bírság mellett **12 nyitvatartási napos üzletlezárás**; ismételt esetben főszabályként nem mellőzhető | Art. 245. § (1), (1a) bek. |
| KATA-alanynál számla- vagy nyugtaadás elmulasztásáért kiszabott bírság | A KATA-alanyiság megszűnik | KATA 5. § (1) bek. c) pont [F8] |

További szabályok:

- A bírság kiszabásakor a NAV mérlegel (Art. 237. §).
- A jogsértés tudomásra jutásától számított egy év után ellenőrzésen kívül nem szabható ki bírság (Art. 238. §).
- A 2025-09-15 óta ERROR-ral elutasított adatszolgáltatás a NAV szerint olyan, „mintha nem is érkezett volna arról a számláról adatszolgáltatás” [F20].

---

## 17. Friss és várható változások (2025–2030)

| Dátum | Változás | Hatás a programra | Forrás / megbízhatóság |
|---|---|---|---|
| 2025-01-01 | Bírságemelés (Art. 220., 228. §) | Kockázat ↑, a validáció fontosabb | [F11], [F15] magas |
| 2025-04-14 | Hatályba lép a ViDA-irányelv ((EU) 2025/516) | Hosszú távú architektúra | [F25] magas; [F32] |
| 2025-07-01 | „Nyugtával egy tekintet alá eső okirat” (173/B. §) | Csak nyugtafunkció esetén | [F1], [F16] magas |
| **2025-09-15** | NAV validációs szigorítás: **15 WARN → ERROR**, 3 új WARN, 3 WARN inaktív, 1 INFO → WARN. A kódlista a NAV-spec 3.40-es alkalmazásverziójának változáslistájából származik; a darabszámok egyeznek a KPMG-összefoglalóval. Az érintett kódok: `330, 434, 560, 581, 582, 583, 584, 591, 593, 596, 620, 701, 1150, 1300, 1310`; a STORNO kikerült a hatókörből. Később a 691-es kód is ERROR lett (3.44). | Helyi elő-validáció a NAV-szabályokkal **kötelező jellegű** | [F19], [F20], [F21] magas |
| 2025-12 / 2026-02 | Specifikációfrissítések: **2025.12.08 (3.44-es alkalmazásverzió):** `691 INCORRECT_SUMMARY_DATA_VAT_EXEMPTION_NORMAL` WARN → ERROR; új blokkoló ERROR: `79 INVALID_ORIGINAL_INVOICE_NUMBER` (az `originalInvoiceNumber` elején és végén nem lehet whitespace); módosult az `INVALID_INVOICE_REFERENCE` és az `INVALID_PREDECESSOR_OPERATION` ERROR; új WARN: `72 INCORRECT_HEAD_DATA_SUPPLIER_TAXPAYERID`, `11401 UNINTENDED_CANCELLATION_DELIVERY_DATE`. **2026.02.12 (3.45.1):** a `11400`/`11401` WARN korábbi módosítás esetén az utolsó módosító okirat teljesítési dátumát vizsgálja. Az API **továbbra is v3.0**; új API-verzió bejelentését nem találtam. | Validációs táblák frissítése | [F19] magas |
| 2026-01-01 | AAM-értékhatár 20 M Ft; 10. melléklet 5/B. és 5/C. pont (jogelőd, csoporttag adószáma); 210/A. § (utazásszervezés) | Eladói státuszmodell, NAV-mezők | [F1], [F12], [F28] magas |
| 2026-07-01 → 2026-07-31 | A 10. melléklet „Számla befogadása” 9. pontjának bővített (adómérték szerinti bontású, a levonásba helyezett adót is tartalmazó) változata 2026-07-01 és 2026-07-30 között volt hatályos; a 2026. évi XXXV. tv. 2026-07-31-től visszaállította az egyszerűbb vevőoldali szabályt (a 380. § szerint a 2026. július 1-jét magában foglaló időszakra is alkalmazható). A NAV szerint a befogadott számlákra vonatkozó adatszolgáltatás nem változik | Csak bejövő számla modulnál releváns | [F13], [F27] magas |
| **2026-09-01** | 0% áfa a vényköteles gyógyszerekre és magisztrális készítményekre (3/B. melléklet); **nyugtaadat-szolgáltatás** a kézi és számítógépes nyugtákról (2026-12-31-ig bírság nélkül) | Kulcs- és kategóriatábla; nyugtafunkció esetén M2M-jelentés | [F14], [F22], [F23] magas |
| 2026-09-15 | Tűzifa (vtsz. 4401 11, 4401 12) és fűtési célú fűrészpor, fahulladék, pellet, brikett (vtsz. 4401 31, 4401 39) az 5%-os körbe (3. melléklet I. rész 61–62. sor) | Kulcstábla | [F14] magas |
| 2027-01-01 | AAM 22 M Ft (2027-re) [F1]; a nyugtaadat-szolgáltatás bírságolása indul [F23]. A hatályos terv szerint az ÁNYK 2026-12-31-én teljesen kivezetésre kerülne, a NAV ehelyett fokozatos átállást javasol [F26]. | Konfiguráció | magas (AAM, nyugta); közepes (ÁNYK) |
| 2027–2028 | NAV-**javaslat** (2026-10-15): az eÁFA 2027-ben a legnagyobb cégeknek, 2028-01-01-től a többi áfabevallónak kötelező. Ez nem elfogadott jogszabály. | Közvetett: az OSA-adatminőség a bevallástervezet alapja | [F26] közepes |
| 2028-07-01 | GTIN kötelező az e-nyugtán (173. § (1) e) pont; a 366. § átmeneti szabálya 2028-07-01-ig; az e-nyugtának nem minősülő nyugtán a 173. § (3) szerint elég az a)–d) adat); a 8/2025. NGM rendelet egyes rendelkezései hatályba lépnek; a Számlarendelet 28. §-a szerint a pénztárgéppel 2028-06-30-ig kibocsátott nyugták átmeneti szabálya | Csak nyugtafunkció esetén | [F1], [F4], [F7] magas |
| 2030-07-01 | ViDA: Közösségen belüli B2B strukturált e-számla és digitális adatszolgáltatás (EN 16931) | Új adatmodell (EN 16931 / UBL 2.1) | [F32] magas (irányelv 6. cikk (5) bek.) |
| Nincs rögzítve | **Hazai ViDA-koncepció** (NAV–NGM, 2025. november; konzultáció 2026-01-20-ig): kötelező EN 16931 XML e-számla belföldi és Közösségen belüli B2B ügyletekre; **az XML a jogilag hiteles számla**, a PDF csak megjelenítés; e-mailes küldés tilos, csak biztonságos API-csatorna; a vevő előzetes azonosítása (adószám és befogadási pont); a számlázó program kötelező elő-validációja, hibás adattal nem bocsáthat ki számlát; **önkiszolgáló akkreditáció**; NAV-archiválás; PEPPOL nem kötelező; vevői adatszolgáltatás 5 napon belül és státuszriport; **az OSA-adatszerkezetet nem fejlesztik tovább**, konverziós eszköz lesz. Dátum a koncepcióban nincs. A BDO (2025-12-08) szerint: tesztelhetőség 2028 elejétől, Közösségen belül 2030-07-01, belföldön 2035-01-01. | Architektúra: a számla belső modellje legyen EN 16931-kompatibilis, az OSA v3 XML ebből generált kimenet | [F24], [F25] magas (a koncepció tartalma); [F31] alacsony (dátumok) |

> ⚠️ Javítva (verifikáció) – „2025-12 / 2026-02” sor: korábban az `INVALID_LINE_OPERATION` ERROR-t, az új áfakulcs miatti módosításokat, a `requestId`-egyediséget és a jogelőd-kezelést sorolta ide; a spec „Dokumentum történet” táblája szerint ezek 2022.12.08-i, 2023.10.25-i, 2023.12.08-i és 2024.12.11-i változások (a PDF rétegzett táblázata félreolvasható). A 2025.12.08-i és 2026.02.12-i tényleges változásokat (3.44 és 3.45.1) a sor most tartalmazza. Forrás: NAV-spec 2026.02.12, „Dokumentum történet” és 5. fejezet – https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
>
> ⚠️ Javítva (verifikáció) – „2026-01-01” és „2026-07-31” sor: a „Számla befogadása” szigorítása nem 2026-01-01-jén, hanem 2026-07-01-jén lépett hatályba, és csak 2026-07-30-ig volt hatályos (a 2026.I.1. időállapotban még az egyszerűbb, 2026.VII.1.–VII.30. között a bővített szöveg szerepel). Forrás: https://net.jogtar.hu/jogszabaly?docid=a0700127.tv&timeshift=20260101 és …&timeshift=20260701; Áfa tv. 380. §; NAV: https://nav.gov.hu/ado/egyeb/Matol_tobb_ado-_es_vamszabaly_valtozik
>
> ⚠️ Javítva (verifikáció) – „2026-09-15” sor: kiegészítve a 3. melléklet 62. sorával (fűtési célú fűrészpor, pellet, brikett), amelyet ugyanaz a 2026. évi XLVIII. tv. iktatott be. Forrás: https://net.jogtar.hu/jogszabaly?docid=a0700127.tv (3. melléklet I. rész 61–62. sor, „Beiktatta: 2026. évi XLVIII. törvény … Hatályos: 2026. IX. 15-től”).
>
> ⚠️ Javítva (verifikáció) – „2028-07-01” sor: a GTIN a 173. § (1) e) pont szerinti adat, a 173. § (3) bek. alapján az e-nyugtának nem minősülő nyugtán elég az a)–d) adat; a GTIN-kötelezettség tehát az e-nyugtát érinti. Forrás: https://njt.hu/jogszabaly/2007-127-00-00 (173. §, 366. §).
>
> ⚠️ Javítva (verifikáció) – „2030-07-01” sor: az irányelv szövege közvetlenül ellenőrizve (6. cikk (5) bek.: „They shall apply those measures from 1 July 2030”), ezért a megbízhatóság „magas”. Forrás: https://publications.europa.eu/resource/celex/32025L0516
>
> ❓ Nem ellenőrizhető – „Nincs rögzítve” sor, BDO-dátumok (tesztelhetőség 2028 elejétől, belföld 2035-01-01): hazai elsődleges forrásban (NAV–NGM koncepció, NAV-hírek, njt.hu) nem találtam ilyen dátumot; a jelenleg letölthető koncepció (fájlnév: „2026_NAV_ViDA_implementacio_web_kiadvany.pdf”) sem tartalmaz dátumot. A 2035-01-01 csak uniós *legkésőbbi* határidőként létezik: az irányelv 6. cikk (5) bek. harmadik albekezdése szerint a 2024-01-01-jén már valós idejű adatszolgáltatást működtető tagállamok (így Magyarország) a belföldi e-számlázást és adatszolgáltatást 2035-01-01-ig igazítják az uniós szabályokhoz. A koncepció többi tartalmi eleme (EN 16931, XML a hiteles számla, e-mail tilalom, önkiszolgáló akkreditáció, pozitív lista, PEPPOL csak lehetőség, vevői adatszolgáltatás 5 napon belül, az OSA-szerkezet nem fejlődik tovább) a letöltött koncepcióban megerősítve.

---

## 18. A korábbi (2026. júliusi, nem ellenőrzött) belső jegyzet állításainak ellenőrzése

| Állítás | Eredmény | Indoklás / forrás |
|---|---|---|
| „A számlázó programot a SZAMLAZO adatlapon, ONYA-n 30 napon belül be kell jelenteni (használatba vétel és megszüntetés)” | **HAMIS** | 2021-01-04-én hatályát vesztette (17/2020. PM rendelet) [F17]. A Számlarendelet 11. és 13. §-a is hatályon kívül van [F4]. |
| „Online Számla bírság számlánként legfeljebb 1 000 000 Ft, 2024-08-01 óta” | **RÉSZBEN HAMIS** | A számlánkénti 1 000 000 Ft-os maximum (nem természetes személynél; természetes személynél 400 000 Ft) **2025-01-01** óta él (Art. 229. § + 220. § (1) bek.). 2024-09-01-én a hatályos szöveg még 500 000 / 200 000 Ft volt [F15]. Az „2024. augusztus” dátum egy másodlagos forrásból származik [F33]. |
| „Az e-nyugta kötelező 2026-09-01-től” | **HAMIS** | 2026-09-01-től a kézi és számítógépes nyugták **adatszolgáltatása** kötelező (11. melléklet B) rész). Az e-pénztárgép választható („e-pénztárgéppel is teljesítheti”, 8/2025. NGM rendelet 3. §) [F7], [F22]. |
| „A NAV 2025-09-15-től szigorított egyes validációkon” | **IGAZ** | 15 WARN → ERROR stb. [F19], [F20], [F21]. |

---

## 19. Nyitott kérdések, bizonytalanságok

1. **A díjbekérő Online Számla státusza:** kifejezett NAV-állásfoglalást nem találtam. A „nem számla” következtetés a 168. § és a 10. melléklet 1. pontja alapján közepes megbízhatóságú.
2. **A 165. § (1) bek. a) pont szerinti, „számla” feliratú számviteli bizonylat** (pl. mentes pénzügyi szolgáltatás) jelentési kötelezettsége NAV-tól pontosítandó.
3. **Kötelező kifejezések kizárólag idegen nyelven** (pl. „Reverse charge” magyar szöveg nélkül): elsődleges forrás nem rendezi. Javaslat: mindig a magyar kifejezés + fordítás.
4. **Több sorszámozási sorozat és évenkénti újraindítás:** a Számlarendelet kifejezetten nem tiltja, a 8. § (2)–(5) bek. és a 15. § több tartományt feltételez. Közepes megbízhatóság; NAV-állásfoglalás hasznos lenne.
5. **Zárt rendszerű archiválás nyílt forráskódnál:** az 1/2018. ITM rendelet 6. §-a fejlesztői írásos nyilatkozatot és egyetemleges felelősséget ír elő. Kérdés, ki tesz ilyen nyilatkozatot egy közösségi projektben. Javaslat: a 7. § szerinti NAV-hash út + append-only tárolás, és a README-ben rögzíteni, hogy a projekt nem tesz 6. § szerinti nyilatkozatot. Jogi felülvizsgálat ajánlott.
6. **A Számlarendelet 9. §-a** fizetős hosztolt vagy támogatott változatnál: ki minősül „értékesítő adóalanynak”? Üzleti modell függvénye.
7. **Kerekítés:** jogszabályi szabály nincs; a NAV-tűrés (a számított forintérték 1%-a, de legalább 1 HUF és a számla pénznemének 0,01 egysége közül a nagyobb) csak a WARN-szintű ellenőrzésekre vonatkozik.
   > ⚠️ Javítva (verifikáció): a tűrés képlete pontosítva a NAV-spec 3.0 szerint (lásd 10.1); a „csak WARN-szintű” állítás megerősítve (az ERROR-táblában nincs tűréses vizsgálat). Forrás: https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
8. **ViDA-dátumok:** a hazai kötelező dátumok jogszabályban nincsenek rögzítve; a 2035-ös belföldi és a 2028-as tesztdátum másodlagos forrásból származik.
9. **MI-ügynök mint „kiállító”:** a jog csak az adóalanyt és a meghatalmazottját (Áfa tv. 160–161. §) ismeri. Az ügynök a felhasználó eszköze, a felelősség az adóalanyé. Emberi jóváhagyást jogszabály nem ír elő; ez kockázatkezelési döntés.

---

## 20. Kötelező szöveges megjelölések (összesítő táblázat)

| # | Eset | Kötelező szöveg vagy jelölés a számlán | Egyéb kötelező számlaadat / tilalom | Jogalap | NAV-jelölés (OSA v3) | Megbízhatóság |
|---|---|---|---|---|---|---|
| 1 | Belföldi fordított adózás (142. §, pl. építőipar, 6. sz. melléklet szerinti hulladék, 6/A–6/B. melléklet, adóalany-kereskedő) | **„fordított adózás”** | A vevő teljes adószáma; **tilos** az áthárított adó és a százalékérték | 169. § n), da) pont; 142. § (7) bek. | `vatDomesticReverseCharge = true` | magas |
| 2 | Más tagállamban teljesülő B2B szolgáltatás (37. § (1) bek.) | **„fordított adózás”** | A vevő közösségi adószáma; nincs magyar áfa; határidő: a hónapot követő 15. nap | 169. § n), da) pont; 163. § (2) bek. a) pont | `vatOutOfScope/case = EUFAD37` | magas |
| 3 | Más tagállamban teljesülő egyéb, fordítottan adózó ügylet (pl. szerelt termék) | **„fordított adózás”** | A vevő közösségi adószáma | 169. § n), da) pont | `vatOutOfScope/case = EUFADE` | magas |
| 4 | Más tagállamban teljesülő, nem fordítottan adózó ügylet | Nincs kötelező kifejezés; javasolt: „Az Áfa tv. területi hatályán kívüli ügylet” | – | 10. melléklet 5/A. pont | `vatOutOfScope/case = EUE` | közepes |
| 5 | Harmadik országban teljesülő ügylet (pl. szolgáltatás) | Nincs kötelező kifejezés („fordított adózás” csak akkor, ha a vevő adófizetésre kötelezett); javasolt: „Az Áfa tv. területi hatályán kívüli ügylet” | – | 169. § n) pont; 10. melléklet 5/A. pont | `vatOutOfScope/case = HO` | közepes |
| 6 | Az Áfa tárgyi hatályán kívüli tétel (pl. kártérítés) | Javasolt: „Áfa tárgyi hatályán kívüli” | – | 2–3. § | `vatOutOfScope/case = ATK` | közepes |
| 7 | Közösségen belüli adómentes termékértékesítés (89. §) | Mentességi hivatkozás, pl. **„Adómentes Közösségen belüli termékértékesítés – Áfa tv. 89. §”** (vagy „2006/112/EK irányelv 138. cikk”) | A vevő **közösségi adószáma**; határidő: a hónapot követő 15. nap | 169. § m), db) pont | `vatExemption/case = KBAET` | magas (a követelmény); közepes (a szöveg példa) |
| 8 | Új közlekedési eszköz Közösségen belüli értékesítése | Mentességi hivatkozás (89. § (2) bek.) | 259. § 25. pont szerinti adatok (forgalomba helyezés dátuma, km vagy üzemóra stb.) | 169. § m), o) pont | `KBAUK` | magas |
| 9 | Termékexport harmadik országba (98. §) | Mentességi hivatkozás, pl. „Adómentes termékexport – Áfa tv. 98. §” (vagy „Héa-irányelv 146. cikk”) | – | 169. § m) pont | `EAM` | magas / közepes (szöveg) |
| 10 | Egyéb nemzetközi ügylethez kapcsolódó mentesség (93–95., 110–118. §) | Mentességi hivatkozás az adott §-ra | – | 169. § m) pont | `NAM` | magas |
| 11 | Tárgyi adómentes ügylet (85–86. §) | Mentességi hivatkozás, pl. „Tárgyi adómentes – Áfa tv. 85. § (1) bek. [x] pont” | Nincs áfa. A 85. § (1) bek. a), b), d), f)–o) és a 86. § (1) bek. a)–i), l), m) pontjainál számla helyett számviteli bizonylat is adható (165. § (1) bek. a) pont) | 169. § m) pont | `TAM` | magas |
| 12 | **Alanyi adómentes** eladó | Egyértelmű utalás, pl. **„Alanyi adómentes”** (+ „Áfa tv. XIII. fejezet / 187. §”) | **Tilos** az áthárított adó, az adómérték és a százalékérték | 169. § m) pont; 187. § (2) bek. c) pont | `vatExemption/case = AAM` | magas |
| 13 | **Pénzforgalmi elszámolás** | **„pénzforgalmi elszámolás”** | Hiányában a módszer nem alkalmazható | 169. § h) pont; 196/B. § (4) bek. | `cashAccountingIndicator = true` | magas |
| 14 | **Önszámlázás** (a vevő állítja ki meghatalmazottként) | **„önszámlázás”** | Írásbeli meghatalmazás; egyeztetett sorszámtartomány | 169. § l) pont; 160–161. §; Számlarendelet 15. § | `selfBillingIndicator = true` | magas |
| 15 | Utazásszervezés (XV. fejezet) | **„különbözet szerinti szabályozás – utazási irodák”** | Az adóalap és az áfa nem kell, kivéve vevői nyilatkozat esetén; **a NAV-nak forintban kötelező** | 169. § p) pont; 210/A. § | `marginSchemeIndicator = TRAVEL_AGENCY` | magas |
| 16 | Használt cikk – viszonteladó | **„különbözet szerinti szabályozás – használt cikkek”** | **Tilos** az áthárított adó, a mérték és a százalékérték | 169. § q) pont; 222. § (1) bek. b) pont | `SECOND_HAND` | magas |
| 17 | Műalkotás – viszonteladó | **„különbözet szerinti szabályozás – műalkotások”** | Mint fent | 169. § q) pont; 222. § | `ARTWORK` | magas |
| 18 | Gyűjteménydarab, régiség – viszonteladó | **„különbözet szerinti szabályozás – gyűjteménydarabok és régiségek”** (a njt-szövegben „régisek” elírás) | Mint fent | 169. § q) pont; 173. § h) pont; 222. § | `ANTIQUES` | magas |
| 19 | Pénzügyi képviselő | A képviselő neve, címe, adószáma | – | 169. § r) pont | – | magas |
| 20 | Egyszerűsített számla (a, b, d eset) | Bruttó ellenérték; **százalékérték** (21,26 / 15,25 / 4,76 / 0%) | **Tilos** az áthárított adó összege | 176. § (2) bek. a) pont; 83. § | `invoiceCategory = SIMPLIFIED`, `vatContent` | magas |
| 21 | Egyéni vállalkozó eladó | **„egyéni vállalkozó”** vagy **„e.v.”** + nyilvántartási szám a név mellett | – | Evtv. 16. § (4) bek. | – | magas |
| 22 | Csoportos áfaalany eladó | Csoportazonosító szám + a tag saját adószáma | Adatszolgáltatás a tag adószámáról | Art. 30. § (2) bek.; 10. melléklet 5/C. pont | (csoporttag-adószám) | magas |
| 23 | Mezőgazdasági, kompenzációs feláras | Az adóalap, mérték és adó helyett a felár alapja, mértéke és összege | – | 202. § (2) bek. b) pont | – | magas |

---

## 21. Implementációs teendők

### 21.1 Implementációs checklist

**A) Adatmodell és validáció**

1. **MUST** – A számlaentitás az Áfa tv. 169. § a)–r) pontjainak minden adatát strukturáltan tárolja: tételenként adóalap, egységár, árengedmény, adómérték vagy mentességi, illetve hatályon kívüliségi jogcím, áthárított adó, és devizánál forintos értékek.
2. **MUST** – Az adómértékek és -kategóriák **időbeli hatállyal, adatként** szerepeljenek (27/18/5/0%, mentességi és hatályon kívüli kódok). A 2026-os változások (0% gyógyszer 2026-09-01, tűzifa és pellet/brikett 5% 2026-09-15) kódmódosítás nélkül legyenek felvihetők; az alkalmazott kulcsot főszabályként a teljesítés napja szerint kell választani, de előlegnél, Közösségen belüli beszerzésnél, a 60. §-os és a 64. § (2)–(3) bek. szerinti esetekben a fizetendő adó megállapításának napja szerint (84. § (1)–(2) bek.).
   > ⚠️ Javítva (verifikáció): az eredeti szöveg csak a 84. § (1) főszabályát említette; a (2) bek. kivételei (különösen az előleg) a kulcsválasztásnál kötelezőek. Forrás: https://njt.hu/jogszabaly/2007-127-00-00 (84. §).
3. **MUST** – Vevőtípus-modell: belföldi áfaalany (`DOMESTIC`), nem áfaalany (belföldi vagy külföldi) természetes személy (`PRIVATE_PERSON`), egyéb (`OTHER`: külföldi áfaalany, külföldi nem áfaalany nem természetes személy, **valamint belföldi, nem áfaalany, nem természetes személy**, pl. áfaalanyisággal nem rendelkező belföldi jogi személy). A vevő adószámára vonatkozó szabályok a 2.3. pont szerint:
   > ⚠️ Javítva (verifikáció): az `OTHER` nem csak EU-s vagy harmadik országbeli vevőt jelent. Forrás: `invoiceData.xsd`, `CustomerVatStatusType` dokumentációja – https://github.com/nav-gov-hu/Online-Invoice/blob/master/src/schemas/nav/gov/hu/OSA/invoiceData.xsd
   - fordított adózás → teljes adószám kötelező;
   - 89. § és 37. § → közösségi adószám kötelező;
   - belföldi B2B → az első 8 jegy kötelező.
4. **MUST** – Forgatókönyv-alapú validáció kiállítás előtt. A 20. fejezet táblázatának minden sorához kód kell, amely ellenőrzi a kötelező kifejezést és a tiltott mezőket. Például: AAM vagy különbözeti számlán nincs áfa, mérték vagy százalékérték; fordított adózásnál nincs áthárított adó; egyszerűsített számlán nincs áfaösszeg.
5. **MUST** – Egyszerűsített számla csak a 176. § (1) bekezdésének esetében engedhető:
   - (a), (b) eset csak forintban;
   - (d) eset: bruttó ≤ **25 000 Ft**, nem 29. §-os vagy 89. §-os ügylet;
   - (c) eset: a 159. § (2) bek. c)–d) pontja szerinti eset;
   - (e) eset: AAM.
6. **MUST** – Nyugta vagy számla döntéstámogatás: ha a vevő magánszemély és a bruttó összeg ≥ **900 000 Ft**, vagy a vevő adóalany, illetve jogi személy, akkor kötelező a számla (165. §).
7. **MUST** – Az adóalap és az adó végösszege módosítás után sem lehet negatív. Ha az előleg meghaladja a végszámlát, az előlegszámla módosítását kell felajánlani.
8. **MUST** – A NAV-validációkat (különösen a 2025-09-15 óta ERROR-ként kezelt kódokat: `330, 434, 560, 581–584, 591, 593, 596, 620, 701, 1150, 1300, 1310`; a 3.44-es alkalmazásverzió óta a `691`-et és az új blokkoló `79 INVALID_ORIGINAL_INVOICE_NUMBER`-t) **helyben, a kiállítás előtt** kell ellenőrizni. Az ERROR-szintű NAV-elutasítás jogilag nem teljesített adatszolgáltatás.
   > ⚠️ Javítva (verifikáció): a `691` nem 2025-09-15-től, hanem a 3.44-es alkalmazásverziótól (spec-kiadás: 2025.12.08) ERROR; a lista kiegészült a 3.44-ben bevezetett `79`-es blokkoló ERROR-ral. Forrás: NAV-spec 2026.02.12, 5. fejezet „3.40-es” és „3.44-es alkalmazás verzió” – https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
9. **SHOULD** – Kerekítés: tételenként a pénznem pontosságára (forintnál egész forintra, 0,5-től felfelé), az összesítő a kerekített tételek összege. A NAV-tűrés (a számított forintérték 1%-a, de legalább 1 HUF és a számla pénznemének 0,01 egysége közül a nagyobb) ellenőrzése.
   > ⚠️ Javítva (verifikáció): a tűrés képlete pontosítva (lásd 10.1). Forrás: https://github.com/nav-gov-hu/Online-Invoice/tree/master/docs/API%20docs/hu
10. **SHOULD** – A vevő adószámának online ellenőrzése a NAV `queryTaxpayer` műveletével, belföldi B2B esetén; ViDA-ban ez kötelező lesz.
11. **SHOULD** – KATA-eladónál figyelmeztetés, ha a vevő nem magánszemély (kifizető), mert a KATA-alanyiság megszűnik (KATA 5. § (1) bek. g) pont).
12. **SHOULD** – AAM-eladónál a göngyölített éves bevétel figyelése és figyelmeztetés a 2026-os 20 M Ft-os, illetve a 2027-es 22 M Ft-os határ közelében.

**B) Sorszámozás és megváltoztathatatlanság**

13. **MUST** – Sorozatonként kihagyás és ismétlés nélküli, folyamatos sorszámozás atomikus foglalással, akár konkurens MCP-hívások mellett is (SQLite tranzakció; a sorszám csak lezáráskor keletkezik).
14. **MUST** – Több sorozat támogatása, de a teljes sorszám az adóalanyon belül egyedi. **Külön sorozat kötelező** a nem magyar adószámon kiállított számlákra (8. § (2) bek.). Számla és nyugta külön sorozatban lehet; a díjbekérő külön, nem számla sorozatba kerül.
15. **MUST** – Kétállapotú életciklus: piszkozat → **lezárt (kiállított)**. A lezárás időbélyege a jogi kiállítási időpont (8. § (6) bek.). Lezárt bizonylat semmilyen felületen (MCP, CLI, web, adatbázis) nem módosítható és nem törölhető.
16. **MUST** – Javítás csak új okirattal: módosító (MODIFY) vagy sztornó (STORNO). Saját sorszám, hivatkozás az eredeti számlára, a módosított adat megnevezése, a módosítás természete és számszerű hatása (170. §). A sorszám nem egyezhet az eredetiével. A `modificationIndex` számlánként monoton és egyedi.
17. **MUST** – A kétlépcsős javítás (sztornó + új számla) támogatása, ahol mindkét új bizonylat hivatkozik a hibás számla sorszámára.
18. **SHOULD** – A „téves vevő” javítását csak sztornó + új számla formájában engedni.

**C) Kötelező mezők forgatókönyvenként**

19. **MUST** – A teljesítés dátuma: elhagyható, ha egyezik a kelttel. Előlegnél az előleg napja, gyűjtőszámlán tételenként.
20. **MUST** – Előlegszámla: a beérkezéskor haladéktalanul. A végszámla tartalmazza a teljes ügyletet, az előleg levonását (`advanceIndicator`) és a különbözetet.
21. **MUST** – Devizás számla: árfolyam-választás (banki deviza-eladási / MNB / EKB, utóbbi kettő a felhasználó előzetes NAV-bejelentése mellett, az év végéig rögzítve; MNB és EKB együtt nem). Az árfolyam időpontja a 80. § (1) bek. szerint. **A forintos áthárított adó a számlán belföldi ügyletnél kötelező.**
22. **MUST** – Határidő-figyelés: 89. §-os és 37. §-os ügyletnél a hónapot követő 15. nap; utólagos fizetésnél és áfás számlánál 8 nap; előre fizetésnél haladéktalanul. Gyűjtőszámlánál a hónap vagy időszak végétől. Az ügynök és a felhasználó kapjon figyelmeztetést.
23. **MUST** – Egyéni vállalkozó eladónál „e.v.” és nyilvántartási szám, csoportos áfaalanynál csoportazonosító szám és tag-adószám, jogutódnál a jogelőd adószáma (OSA-ban is).
24. **SHOULD** – Belföldi fordított adózásnál (142. § (1) bek. b) és k) pont) a vevő előzetes írásbeli nyilatkozatának meglétét rögzíteni.
25. **MAY** – Mezőgazdasági kompenzációs felár, felvásárlási okirat, utazásszervezés, különbözeti adózás, új közlekedési eszköz: későbbi fázis, de a validációs keret legyen bővíthető.

**D) PDF / számlakép**

26. **MUST** – A PDF tartalmazza a 169. § szerinti minden alkalmazandó adatot és a 20. fejezet szerinti kötelező kifejezéseket **szó szerint**. A „régiségek” alakot kell használni.
27. **MUST** – Az áthárított adó forintban, ha a számla devizás és az ügylet belföldi (172. §).
28. **SHOULD** – Árfolyam, annak forrása és dátuma; forintos adóalap és adó adómértékenként; kétnyelvű (HU/EN) sablon; cégjegyzékszám (társaságnál); a program neve és verziója a láblécben; „Másolat” felirat az újranyomtatáson.
29. **MUST** – Aláírást nem szabad kötelezővé tenni (177. §). Minősített e-aláírás vagy -bélyegző **MAY**.
30. **SHOULD** – Készpénzes fizetésnél külön „Kerekítés” és „Fizetendő (készpénz)” sor a 2008. évi III. törvény szerint. A bruttó végösszeg és az adóadatok kerekítetlenek maradnak.

**E) NAV-adatszolgáltatás: időzítés, újrapróbálás, hibakezelés**

31. **MUST** – Lezáráskor **azonnali** `manageInvoice` beküldés (13/A. § (1) bek.), aszinkron státuszkövetés (`queryTransactionStatus`). Teljesítettnek csak a NAV sikeres feldolgozási visszaigazolása (DONE) számít; WARN mellett is teljesített, de a figyelmeztetést meg kell mutatni.
32. **MUST** – Tartós kimenő sor (outbox) újrapróbálással. Kiesésnél a kiesés kezdetének és végének naplózása. A határidők: NAV- vagy internetkiesés után 24 óra, saját rendszerhiba elhárulása után 24 óra. **48 órát meghaladó saját kiesésnél riasztás** a felhasználónak a NAV-felületen teendő jelzésről és kézi rögzítésről (13/B. §).
33. **MUST** – ABORTED vagy ERROR esetén javítás és újraküldés. Ha a hiba **3 munkanapon belül** nem javítható, figyelmeztetni kell a kézi rögzítés kötelezettségére (13/A. § (7) bek.).
34. **MUST** – Magánszemély vevőnél a név és a cím **nem kerülhet** az OSA XML-be.
35. **MUST** – Módosítás vagy sztornó beküldése előtt az eredeti számla DONE státuszát kell megvárni (vagy sorrendbe rendezni).
36. **MUST** – Technikai érvénytelenítést (`ANNUL`) csak adatszolgáltatási hibára szabad felajánlani, a számla tartalmi hibájára nem. A felhasználót tájékoztatni kell, hogy a NAV webes felületén jóvá kell hagynia.
37. **MUST** – A `software` blokk kitöltése (`softwareId`, `softwareName`, `softwareOperation`, `softwareMainVersion`, `softwareDevName`, `softwareDevContact`, opcionálisan `softwareDevCountryCode` és `softwareDevTaxNumber`) a valós verzióval, mert az Art. 131. § (30) bek. alapján a NAV a fejlesztőt ennek alapján értesítheti.
38. **SHOULD** – Elektronikus számlánál az `electronicInvoiceHash` képzése (SHA3-512) a kibocsátott PDF/XML fájlról és beküldése. Ez az 1/2018. ITM rendelet 7. §-a szerinti archiválási bizonyíték.
39. **MAY** – Számlakibocsátás a NAV útján (`completenessIndicator = true`, 13/C. §), magánszemély vevő kivételével.

**F) Archiválás és export**

40. **MUST** – Minden kiállított bizonylat (XML adat, a PDF pontos bájtsora, a beküldött OSA XML, a NAV-nyugták) megőrzése **legalább 8 évig** (Számv. tv.), és nem rövidebb ideig, mint az Art. szerinti elévülés. **Automatikus törlés nincs**; a megőrzési idő konfigurálható, javasolt alapértelmezés legalább 10 év.
41. **MUST** – Az elektronikus számla csak elektronikusan őrizhető. Védelem a törlés, a módosítás és a jogosulatlan hozzáférés ellen (1/2018. ITM rendelet 3. §): append-only tár, hash-lánc, mentés. Az olvashatóság a megőrzési idő alatt végig biztosított legyen, archiválási formátumként PDF/A ajánlott.
42. **MUST** – Önálló, beépített funkció pontosan „adóhatósági ellenőrzési adatszolgáltatás” elnevezéssel (CLI, MCP és web; a 11/A. § ezt az elnevezést írja elő). Export **dátumtartományra és sorszámtartományra**:
    - (a) a 23/2014. NGM rendelet 3. melléklete szerinti XSD (`szamlak`, névtér `http://schemas.nav.gov.hu/2013/szamla`);
    - (b) NAV OSA v3 `InvoiceData` XML-ek;
    - (c) a PDF-ek.
    - Az exportot a 3. melléklet XSD-je ellen validálni kell.
43. **SHOULD** – Ellenőrzési csomag: export + dokumentáció a használt verzióhoz + napló, „külső adathordozóra” menthető formában (18. § (2) bek.).
44. **SHOULD** – A 1/2018. ITM rendelet 6. §-a szerinti „zárt rendszer” nyilatkozatot a projekt **ne** tegye jogi felülvizsgálat nélkül. A README rögzítse a 7. §-os (hash) utat.

**G) Napló és audit**

45. **SHOULD** – Megváltoztathatatlan eseménynapló, hash-láncolva. Tartalma: ki vagy mi (felhasználó, ügynök, MCP-kliens, CLI) mikor milyen műveletet végzett (piszkozat, lezárás, PDF-generálás, NAV-beküldés, válasz, újraküldés, kiesés kezdete és vége, export). Ez a „csak dokumentált funkció” és a sértetlenség igazolására szolgál.
46. **SHOULD** – A NAV-válaszok (WARN, ERROR, INFO) tárolása és megjelenítése. Ahol a hiba a számla tartalmi hibája, a megfelelő okiratra kell vezetni a felhasználót („a számlát kell javítani, nem az adatszolgáltatást”).

**H) MI-ügynök-specifikus követelmények**

47. **MUST** – Minden MCP-tool és CLI-parancs **a felhasználói dokumentációban leírt funkció** legyen (Számlarendelet 10. § (2) bek.). Általános adatbázis- vagy fájlíró eszköz nem tehető közzé az ügynököknek.
48. **MUST** – Az irreverzibilis „kiállítás” (lezárás) külön, explicit tool legyen. A piszkozat-tool ne állítson ki számlát. Ajánlott a lezárás előtti összesítő visszaigazolás (emberi jóváhagyás konfigurálható; jogszabály nem írja elő).
49. **SHOULD** – Az ügynök a kiállítás előtt kapja vissza a validációs eredményt: hiányzó kötelező kifejezés, tiltott áfa, határidő-sértés, NAV-szabályütközés.
50. **SHOULD** – Ne lehessen „visszadátumozni”: a kelt a lezárás napja legyen. A teljesítés dátuma múltbeli lehet, de a határidő-sértést jelezni kell.

**I) Dokumentáció és verziózás**

51. **MUST** – Verziózott felhasználói dokumentáció magyarul vagy angolul, minden funkció leírásával. Programnév és verzióazonosító (2. § 3. pont).
52. **MUST** – Funkcióváltozáskor a dokumentáció kiegészítése (CHANGELOG és funkcióleírás) és elérhetővé tétele a felhasználóknak (10. § (3) bek.). A dokumentáció a kiadással együtt letölthető és archiválható legyen, mert a felhasználó az elévülésig köteles megőrizni.
53. **SHOULD** – Fizetős vagy hosztolt terjesztésnél a terjesztő vezessen eladási nyilvántartást (név, verzió, vevő, dátum), ellenőrizze a vevő adóalanyiságát, és tüntesse fel az adószámát a számlán (9. §).

**J) Előretekintés**

54. **SHOULD** – A belső számlamodell legyen **EN 16931-kompatibilis**; az OSA v3 XML ebből generált kimenet. Készülni kell a ViDA-ra: XML mint hiteles számla, akkreditáció, a vevő előzetes azonosítása, a PEPPOL opcionális.
55. **MAY** – Nyugtakibocsátás (számítógépes nyugta) csak 2026-09-01-től kötelező nyugtaadat-szolgáltatással (M2M, napi összesítés adómértékenként, 3 napon belül). Javaslat: **nem MVP**.

### 21.2 Felhasználói kötelezettségek (README-be)

A program használója (a számlakibocsátásra kötelezett adóalany) **maga** köteles:

1. **Online Számla regisztráció:** regisztráljon az onlineszamla.nav.gov.hu felületen (elsődleges felhasználó: törvényes képviselő vagy állandó meghatalmazott), hozzon létre **technikai felhasználót**, és igényelje az XML-aláírókulcsot és a cserekulcsot. Ezek nélkül a program nem tud adatot szolgáltatni (Áfa tv. 10. melléklet 6–8. pont; Számlarendelet 13/A. § (2) bek.).
2. **Nincs SZAMLAZO bejelentés:** a „SZAMLAZO” bejelentés 2021-01-04 óta nem kötelező. Ilyen bejelentést nem kell tenni.
3. **Státuszok és nyilatkozatok előre:**
   - helyesen állítsa be adózói státuszát (általános, alanyi adómentes, KATA, pénzforgalmi elszámolás, csoportos, egyéni vállalkozó vagy társaság);
   - az AAM-ről és a pénzforgalmi elszámolásról a tárgyévet megelőző év december 31-ig nyilatkozzon;
   - MNB- vagy EKB-árfolyam használata előtt tegyen előzetes bejelentést a NAV-nak.
4. **Határidők betartása:** a számlát időben kell kiállítania: haladéktalanul, 8 napon belül, vagy a következő hónap 15-éig. A program figyelmeztet, de a felelősség a felhasználóé.
5. **NAV-státusz követése:**
   - figyelje a NAV feldolgozási státuszát;
   - ERROR esetén javítson és küldjön újra;
   - ha a hiba 3 munkanapon belül nem hárítható el, rögzítse kézzel az adatokat a NAV felületén;
   - **48 óránál hosszabb saját kiesésnél** jelezzen a NAV rendszerében, és rögzítsen kézzel;
   - a technikai érvénytelenítéseket a NAV webes felületén hagyja jóvá.
6. **E-számla:** biztosítsa a vevő (akár hallgatólagos) beleegyezését, és az e-számlát elektronikusan őrizze meg.
7. **Megőrzés:** őrizze meg a számlákat (társaság legalább 8 évig, egyéb esetben legalább az elévülésig, KATA esetén az 5. év végéig), **a program dokumentációját és annak minden frissítését** az elévülésig, valamint az adatbázis mentéseit. Gondoskodjon a mentésről és a visszaállíthatóságról.
8. **Ellenőrzés:** adóellenőrzéskor bocsássa rendelkezésre az „adóhatósági ellenőrzési adatszolgáltatás” exportját és az olvasáshoz szükséges eszközöket.
9. **Fordított adózás:** építőipari (142. § (1) bek. b) pont) és adóalany-kereskedő (k) pont) esetben szerezze be a vevő előzetes írásbeli nyilatkozatát.
10. **Közösségen belüli ügyletek:** a 89. §-os értékesítéseket és a 37. §-os B2B szolgáltatásokat az **összesítő nyilatkozatban** is jelentse; ezt a program nem teljesíti.
11. **Nyugták:** ha nyugtát ad ki (nem a program), 2026-09-01-től a kézi és a számítógépes nyugtákról is szolgáltasson adatot a NAV-nak (KOBAK vagy M2M).
12. **KATA:** ha kisadózó, és kifizetőtől (cégtől) szerez bevételt, a KATA-alanyiság megszűnik; 15 napon belül be kell jelentenie.
13. **Felelősség:** a jogszabályoknak megfelelő számlakibocsátásért és adatszolgáltatásért **az adóalany felel**, akkor is, ha a programot MI-ügynök kezeli, és akkor is, ha a program hibázik.

---

## Verifikáció (2026-10-27)

**Módszer.** A 25 legnagyobb implementációs hatású állítást elsődleges forrásból, a dokumentum hivatkozásaitól függetlenül újra ellenőriztem:

- **Források:** njt.hu konszolidált szövegek (Áfa tv. 2026.09.15., Art. 2026.10.01., Számlarendelet 2026.01.01., Számv. tv. 2026.02.28., 2008. évi III. tv., 1/2018. ITM r., 8/2025. NGM r., KATA, Evtv.). A njt.hu oldal az Áfa tv. mellékleteit és záró rendelkezéseit, valamint az Art. számos szakaszát nem tölti be, ezért ezekhez, illetve a korábbi és jövőbeli időállapotok összevetéséhez a net.jogtar.hu (Wolters Kluwer, nem hivatalos, de lábjegyzetenként hatálydátumot közlő) konszolidált szövegét használtam. Ahol mindkét forrás elérhető volt, a kettő egyezett. Ezen felül: nav.gov.hu (hírek, 18. információs füzet 2026.03.02.), github.com/nav-gov-hu (Online-Invoice master, spec 2026.02.12, XSD-k, CHANGELOG, issue-k; Common `common-1.0.0`), és az (EU) 2025/516 irányelv szövege a Kiadóhivatal cellar-végpontjáról.
- **Kódfuttatás:**
  1. Python-diff a dokumentum idézetei és a njt-szöveg között: 169. § 22/22, 176. § 10/10 sor azonos; a 170. § egyezik, a „[hatályon kívül helyezve]” szerkesztői jelöléstől eltekintve.
  2. A Számlarendelet 3. melléklete szerinti XSD-t lxml-lel lefordítottam, és minimális példányon pozitív és negatív validációt futtattam.
  3. A NAV OSA v3.0 XSD-ket (invoiceData, invoiceApi, invoiceAnnulment, invoiceBase + NTCA common 1.0.0) lefordítottam. A NAV 7 saját mintája érvényes. Az enumerációkat és az elemsorrendeket programból nyertem ki.
  4. Node.js-számítás: a 25 000 Ft-os küszöb, a 83. § szerinti százalékok, a készpénzes kerekítés és az irányelv hatálybalépési napja.

| # | Állítás (szakasz) | Ítélet | Bizonyíték |
|---|---|---|---|
| 1 | Áfa tv. 169. § a)–r) szó szerint, 18 pont, „régisek” elírás (0.1, 2.1) | ✅ megerősítve | Diff: 22/22 azonos sor; a „régisek” a nyers HTML-ben is szerepel; a 173. § h) és a NAV 18. füzet „régiségek”. https://njt.hu/jogszabaly/2007-127-00-00 |
| 2 | Kötelező kifejezések és áfatilalmak: 169. § h, l, n, p, q; 142. § (7); 187. § (2) c); 222. § (1) b); 142. § (1) b), k) előzetes vevői nyilatkozat (3., 20.) | ⚠️ javítva (2.2 k) sor) | A szövegek egyeznek; a 210/A. § mentesítés („nem kell feltüntetni”), nem tilalom. njt.hu, net.jogtar 142. § |
| 3 | Egyszerűsített számla: 176. §; 100 € = 25 000 Ft; 83. § százalékok; 0% kulcs (4.1, 20.) | ✅ megerősítve | Diff 10/10. 256. § (1): 252,19 Ft/€, 100 000 Ft alatti eredménynél 1000 Ft-ra kerekítés: 25 219 → 25 000 Ft. 27/127 = 21,26%, 18/118 = 15,25%, 5/105 = 4,76%. 82. § (4): 0% (3/B. melléklet). |
| 4 | Nyugta bármilyen fizetési móddal „2023-07-15 óta” (4.2) | ⚠️ javítva | Helyesen 2021-07-01 óta (2020. évi CXVIII. tv. 45. § (1)). A 2023-07-15-i módosítás a 163. § (2) b)-t érintette. net.jogtar időállapotok: 2021.I.4., 2021.VII.1., 2023.VII.15. |
| 5 | Kelt = lezárás = kibocsátás (2.2 a)) | ⚠️ javítva | A 8. § (6) a *kiállítást* rögzíti, az adatszolgáltatás alkalmazásában; a kibocsátás a rendelkezésre bocsátás (NAV 18. füzet, 3. fejezet). |
| 6 | Számlarendelet időállapota 2026.01.01., utolsó módosítás: 21/2025. (VII. 7.) NGM r. (11.) | ✅ megerősítve | njt.hu fejléc és lábjegyzetek; a 21/2025. NGM r. módosította az 1. §, 2. §, 13/A–13/C., 17. és 28. §-t. https://njt.hu/jogszabaly/2014-23-20-2X |
| 7 | Számlarendelet szövegei: 2. § 2–3., 5. pont; 8. § (1)–(6); 9–10. §; 11/A.; 18–19. § (0.3, 11.1–11.4, 21.1 H, I) | ✅ megerősítve | A szövegek egyeznek. A 10. § (4) „[…]” helyén: „Az adóalany ezen megőrzési kötelezettségének elektronikusan is eleget tehet.” A 8. § (1) b), a 11. § és a 13. § a 17/2020. PM r.-rel hatályon kívül került. |
| 8 | Adatszolgáltatás időzítése és hibakezelése: 13/A. § (1) „azonnal”, (3), (4)–(7) 3 munkanap, (8)–(9) 6 nap; 13/B. § (3)–(5) 24 óra, 48 óra + 24 óra, ismételt bejelentés (0.4, 5.2, 21.1 E) | ✅ megerősítve | njt.hu 23/2014. NGM r. 13/A–13/B. § |
| 9 | 10. melléklet: 1., 4., 4/A–6. pont; 3. pont (nyomdai számla: 500 000 Ft-tól a következő naptári nap, egyébként 4 naptári nap); 5/B–5/C és 6–7. pont 2026-01-01-től (5.2, 6.1–6.3) | ✅ megerősítve | net.jogtar: „Beiktatta/Megállapította: 2025. évi LIV. törvény 40. § … Hatályos: 2026. I. 1-től”. A PRIVATE_PERSON név- és címtilalma blokkoló validáció (CHANGELOG_3.0, ERROR 25). |
| 10 | 3. melléklet XSD: névtér `http://schemas.nav.gov.hu/2013/szamla`, gyökérelem `szamlak`, a fej- és számlaelemek sorrendje, „Utolsó módosítás: 2014.01.29” (11.4, 21.1 #42) | ✅ megerősítve | Az XSD lefordul. A dokumentált sorrendű példány érvényes; a felcserélt `fejlec`/`szamlakibocsato` és a hiányzó `kezdo_szla_szam` érvénytelen. **Implementációs megjegyzés:** a fejlécben a `kezdo_ido`/`zaro_ido` és a `kezdo_szla_szam`/`zaro_szla_szam` mindig kötelező, a `teljdatum` is kötelező, és a `vevo/nev`, `vevo/cim` magánszemély vevőnél is kötelező (eltérően az OSA-tól). |
| 11 | A SZAMLAZO bejelentés 2021-01-04-én megszűnt (17/2020. PM r. 3–5. §); fejlesztői NAV-regisztráció nincs (0.7, 12., 21.2) | ✅ megerősítve | NAV SZAMLAZO oldal (5.0 verzió, 2021.01.18.): „2021. január 4-én vesztette hatályát”. https://nav.gov.hu/nyomtatvanyok/letoltesek/nyomtatvanykitolto_programok/nyomtatvanykitolto_programok_nav/SZAMLAZO |
| 12 | AAM 2026: 20 M, 2027: 22 M, 2028: 24 M Ft (0.9, 15., 21.1 #12) | ✅ megerősítve (pontosítva) | 188. § (2), 377–378. §; net.jogtar 2027.I.1. és 2028.I.1. időállapot; NAV hír 2025.12.11. |
| 13 | Bírságok: Art. 220. § (1) 400 000 / 1 000 000 Ft 2025-01-01-től (előtte 200 000 / 500 000), 228. § (1) 2 000 000 Ft (előtte 1 000 000), 229. § számlánkénti szorzó; 237., 238., 245. § (0.6, 16., 18.) | ✅ megerősítve | net.jogtar Art.: a 2024.XI.29.–XII.31. időállapot a régi, a 2025.I.1. időállapot az új összegeket tartalmazza; 2026.X.1.-jei szöveg. |
| 14 | NAV kerekítési tűrés (10.1, 19.7, 21.1 #9) | ⚠️ javítva | 3.0-s szabály: „a számított forintban kifejezett érték 1%-a, de legalább 1 HUF és a számla pénznemének 0,01 egysége közül a nagyobb”, csak WARN-szinten. GitHub #738: az NTCA-tax (COLLABORATOR) 2021.02.04-i válasza ✅; #716-ban csak közösségi válasz van ✅. |
| 15 | Készpénzes kerekítés, 2008. évi III. tv. 1–3. § (10.2) | ✅ megerősítve | A njt.hu szövege egyezik. Futtatott teszt: 1002,49 → 1000; 1002,50 → 1005; 1007,49 → 1005; 1007,50 → 1010. |
| 16 | Devizás számla: csak az áthárított adó forintban, csak 2. § a) szerinti (belföldi) ügyletnél, 2022-11-24 óta; 80. § és 80/A. §; MNB és EKB együtt nem választható; `exchangeRate` = 1 egység HUF-ban (9.1–9.2, 14.) | ✅ megerősítve | njt.hu 172. §, 80–80/A. §; net.jogtar „2022. évi XLV. törvény 41. § … Hatályos: 2022. XI. 24-től”; NAV 18. füzet; invoiceData.xsd. |
| 17 | Árfolyam-extrém ERROR, EUR-sáv (9.2) | ⚠️ javítva | NAV-spec ERROR 78: EUR 250–600 (nem 250–500), CREATE és MODIFY. |
| 18 | 2025-09-15: 15 WARN → ERROR (kódlista), 3 új WARN, 3 inaktív, 1 INFO → WARN, STORNO kizárva; a 691 később (3.44) (0.5, 17.) | ✅ megerősítve | NAV-spec 2026.02.12, 5. fejezet, „3.40-es alkalmazás verzió”: a 15 kód egyezik. NAV hír 2025.06.23.: „szeptember 15-től”; „mintha nem is érkezett volna … adatszolgáltatás”. |
| 19 | Spec-frissítések 2025-12 / 2026-02 (17.); helyi ERROR-lista (21.1 #8) | ⚠️ javítva | „Dokumentum történet” + 3.44 és 3.45.1. Új blokkoló ERROR: `79 INVALID_ORIGINAL_INVOICE_NUMBER`. Az API továbbra is v3.0 ✅ (csak `/v3/` végpontok, OSA/3.0 névterek). |
| 20 | OSA v3 enumok és elemsorrend, valamint Art. 131. § (30) (6.3, 7.3, 12., 20., 21.1 #3, #37). Ellenőrizve: `customerVatStatus` (DOMESTIC, OTHER, PRIVATE_PERSON), `invoiceCategory`, `invoiceOperation`, `annulmentCode` (4 érték), `ANNUL`, `marginSchemeIndicator` (4 érték), a `software` blokk 8 elemének sorrendje, az `advancePaymentData` 3 eleme, `invoiceReference`, a `VatRateType` választásai, a `vatExemption`/`vatOutOfScope` case-kódjai | ✅ megerősítve; ⚠️ javítva az `OTHER` leírása (21.1 #3) | Az XSD-k lefordulnak, a 7 NAV-minta érvényes. A case-kódok a spec 123. oldali táblázatából. Az Art. 131. § (30) szövege: net.jogtar. |
| 21 | E-számla és archiválás (13., 7.3, 11.5): 259. § 5. pont; 168/A.; 175. § (2)–(3); 179. §; Art. 78. § (3) és 202. § (1); Számv. tv. 169. § (2), (5); KATA 11. § (5); 1/2018. ITM r. 3., 6., 7. §; `electronicInvoiceHash` (SHA3-512 vagy SHA-256; `completenessIndicator = true` esetén csak nagybetűs SHA3-512); 13/C. §; a technikai érvénytelenítés szabályai | ✅ megerősítve | njt.hu és net.jogtar szövegek; NAV-spec 1.x, 2.4.1 (1–10. szabály) és ERROR 25–29; NAV 18. füzet: „elektronikus számla a kizárólag e-mailben megküldött számla is”, a beleegyezés hallgatólagos is lehet. |
| 22 | 2026-os adómérték-változások és a kulcsválasztás időpontja (0.10, 17., 21.1 #2) | ✅ megerősítve; ⚠️ javítva (84. § kivételei; 3. melléklet 62. sor) | net.jogtar: a 3/B. melléklet 2–3. sorát a 2026. évi XL. tv. iktatta be (hatályos 2026-09-01-től); a 3. melléklet 61–62. sorát a 2026. évi XLVIII. tv. (hatályos 2026-09-15-től). Áfa tv. 82. § (1)–(4), 84. § (2). |
| 23 | Nyugtaadat-szolgáltatás 2026-09-01-től (11. melléklet B) 1.: 3 naptári nap, napi összesítés, adómérték szerinti bontás); az e-pénztárgép választható; bírság 2027-01-01-től; GTIN (0.8, 4.2, 17., 18.) | ✅ megerősítve; ⚠️ javítva (GTIN: e-nyugta) | net.jogtar: „Megállapította: 2025. évi LIV. törvény 41. § … Hatályos: 2026. IX. 1-től”. 8/2025. NGM r. 3. § (1): „e-pénztárgéppel is teljesítheti”. NAV hír 2026.08.04. Áfa tv. 173. § (3), 366. §. |
| 24 | ViDA: hatálybalépés 2025-04-14; Közösségen belüli DRR 2030-07-01; a hazai koncepció tartalma; dátumok (0.11, 17.) | ✅ megerősítve; ❓ a BDO-dátumok | HL L 2025/516 (2025.03.25.); a 7. cikk szerinti 20. nap 2025-04-14. 6. cikk (5): 2030-07-01; a 2035-01-01 csak uniós legkésőbbi határidő. A NAV–NGM koncepciót letöltöttem (fájlnév: „2026_NAV_ViDA_implementacio_web_kiadvany.pdf”). |
| 25 | „Számla befogadása” időrendje (17.) | ⚠️ javítva | 2026.I.1.: a régi szöveg hatályos; 2026.VII.1.–VII.30.: a bővített szöveg; 2026.VII.31.-től visszaállítva (2026. évi XXXV. tv. 15. §, Áfa tv. 380. §). NAV hír 2026.07.31. |

**Mellékesen ellenőrizve (✅):**

- a forrástábla F1–F9 időállapotai;
- KATA: 50 000 Ft/hó, 18 M Ft keretösszeg, 40% különadó, 5. § (1) c) és g), 5. § (3) 15 nap, 11. § (3);
- Evtv. 16. § (4) (2026.09.27.);
- Art. 30. § (2);
- Áfa tv. 196/C. § (125 M Ft), 192. § (2), 196/G. § (2);
- 173/B. § (hatályos 2025-07-01-től), 210/A. § (hatályos 2026-01-01-től);
- spec 2.9 (végszámla, `advanceExchangeRate`), a `DONE` megvárása, a módosító okirat nem módosítható.

**Nem ellenőriztem újra** a csak másodlagos forrásra (KPMG F21, WTS F33, BDO F31) épülő mellékállításokat; ahol elsődleges forrás rendelkezésre állt, azt használtam. A Ctv. 44. § (1) és 63. § (2) bekezdését sem ellenőriztem újra.
