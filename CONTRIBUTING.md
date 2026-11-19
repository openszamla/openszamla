# Közreműködés

Köszönjük, hogy segítesz! Az OpenSzámla magyar vállalkozások számláit kezeli, ezért a
helyesség fontosabb a sebességnél.

## Fejlesztői környezet

```bash
npm install
npm test
npm run typecheck
```

Fejlesztéshez Node.js 22.18 vagy újabb kell (ajánlott: 24): build lépés nélkül, a Node beépített
TypeScript-típuseltávolításával fut a `node src/cli/main.ts …` és minden teszt. A kiadott csomag
(`dist/`) Node.js 22.13.0-tól fut – ezért csak olyan Node-API-t használj, ami 22.13.0-ban már megvan;
a CI a csomagot ezen a változaton is telepíti és kipróbálja (`node scripts/smoke.mjs`).
Kísérletezéshez mindig külön adatkönyvtárat használj: `OPENSZAMLA_HOME=/tmp/osz node src/cli/main.ts status`.

## Szabályok

- Olvasd el az [AGENTS.md](AGENTS.md)-t – ugyanazok a szabályok vonatkoznak emberre és ügynökre.
- Minden változáshoz teszt kell. NAV XML-t érintő változásnál a hivatalos XSD-validációs teszt is.
- **Új vagy módosított funkció → dokumentáció.** A 23/2014. (VI. 30.) NGM rendelet 10. §-a szerint a
  számlázó program csak a felhasználói dokumentációban leírt funkciókat hajthatja végre, ezért minden
  MCP-eszközt, CLI-parancsot és webes műveletet a [docs/felhasznaloi-dokumentacio.md](docs/felhasznaloi-dokumentacio.md)
  fájlban dokumentálni kell, és a [CHANGELOG.md](CHANGELOG.md)-be is bekerül.
- Jogszabályi állításnál hivatkozz forrásra (njt.hu, nav.gov.hu, NAV interfész-specifikáció).
- A felhasználónak szóló szövegek magyarul, a kód és a kommentek angolul.
- Pénzösszeg soha nem lebegőpontos szám (`src/core/decimal.ts`).

## Pull request

1. Ágazz le a `main`-ről, kis, egy témájú változtatásokkal.
2. `npm run typecheck && npm test` legyen zöld; ha a `skills/` mappát módosítottad, futtasd a
   `node scripts/sync-skills.mjs` parancsot (a CI `--check`-kel ellenőrzi a másolatokat).
3. Írd le a PR-ben, mi változott a felhasználó (és a NAV-adatszolgáltatás) szempontjából.

Biztonsági hibát ne nyilvános issue-ban jelents: lásd [SECURITY.md](SECURITY.md).
