# NAV Online Számla v3.0 – hivatalos sémák és minták

Ez a mappa a Nemzeti Adó- és Vámhivatal által közzétett, **MIT licenc** alatt álló fájlok változatlan
másolatait tartalmazza (lásd `LICENCE.md`). Csak tesztelésre és referenciaként használjuk: a
generált `invoiceData` és API XML-eket ezekkel a sémákkal validáljuk (`test/helpers/nav-xsd.ts`).

| Mappa | Forrás |
|---|---|
| `schemas/invoiceData.xsd`, `invoiceBase.xsd`, `invoiceApi.xsd`, `invoiceAnnulment.xsd`, `serviceMetrics.xsd` | https://github.com/nav-gov-hu/Online-Invoice – `src/schemas/nav/gov/hu/OSA/` (v3.0) |
| `schemas/common.xsd` | https://github.com/nav-gov-hu/Common – NTCA 1.0 common séma (v1.0 RC4, 2023-02-10) |
| `samples/data/*.xml` | https://github.com/nav-gov-hu/Online-Invoice – `sample/Data sample/` (fájlnevek ékezet és szóköz nélkül) |
| `samples/api/*.xml` | https://github.com/nav-gov-hu/Online-Invoice – `sample/API sample/` |

A sémák `xs:import` elemei nem tartalmaznak `schemaLocation`-t (a NAV XML katalógust használ); a
teszt-segéd ezeket memóriában egészíti ki.
