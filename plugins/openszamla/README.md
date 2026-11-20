# OpenSzámla – Claude Code plugin

Ez a plugin két dolgot telepít:

1. az **`openszamla` MCP szervert** (`npx -y openszamla mcp`) – magyar számlázás NAV Online Számla
   adatszolgáltatással;
2. a **`magyar-szamlazas` skillt**, ami végigvezeti Claude-ot a számlázási munkameneten
   (vevő → piszkozat → előnézet → jóváhagyás → kiállítás → PDF → NAV).

Telepítés:

```text
/plugin marketplace add openszamla/openszamla
/plugin install openszamla@openszamla
```

Első lépésként mondd Claude-nak: „Mi a helyzet a számlázóval?” – a `setup_status` eszköz megmondja,
mit kell még beállítani (eladói adatok, NAV technikai felhasználó: `npx -y openszamla nav-setup`).

Beállítások (`/plugin` → *Configure*):

- **Adatkönyvtár** (`data_dir`) – üresen hagyva `~/.openszamla`. Ha megadod, a NAV-adatokat is oda
  mentsd: `npx -y openszamla nav-setup --data-dir <ugyanez a mappa>` (különben a szerver a megadott
  mappában nem találja őket, és „NAV nincs beállítva” állapotot jelez).
- **NAV környezet** (`nav_env`) – üresen hagyva a `nav-setup`-ban választott környezet (`test` vagy
  `production`) érvényes. Ha itt megadod (`test` vagy `production`), az **felülírja** a `nav-setup`
  választását.

Dokumentáció: https://github.com/openszamla/openszamla/blob/v0.1.1/docs/felhasznaloi-dokumentacio.md
(az MCP-kliensek beállítása: `docs/kliensek.md`).
