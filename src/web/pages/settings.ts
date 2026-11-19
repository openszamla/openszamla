/**
 * "/settings": seller profile (updateSeller), invoice defaults (updateDefaults), number series (read
 * only) and the NAV connection STATUS – never any credential (only environment/source flags are read).
 */
import { isAppError } from '../../core/errors.ts';
import type { SellerProfile, ValidationIssue } from '../../core/types.ts';
import { navSetupCommandLine } from '../../service/config.ts';
import type { InvoiceDefaults } from '../../service/inputs.ts';
import { VERSION } from '../../version.ts';
import { badge, checkboxField, csrfInput, dataTable, inputField, selectField, textareaField } from '../components.ts';
import { attempt, emptyNote, failure, forRedisplay, redirect, renderPage, sectionError, withWithheldFields, type Ctx } from '../context.ts';
import { defaultsPatchFrom, sellerInputFrom } from '../forms.ts';
import { html, type SafeHtml } from '../html.ts';
import type { Flash } from '../layout.ts';
import { icon } from '../icons.ts';
import { APPEARANCE, LANGUAGE, PAYMENT_METHOD, SELLER_VAT_STATUS, SERIES_KIND } from '../labels.ts';
import { commandBlock, COPY_SCRIPT, navSetupHelp } from '../setup-guide.ts';
import { navConnection, navConnectionBadge } from './dashboard.ts';

type FormState = { form: 'seller' | 'defaults'; values: Record<string, string>; error: Flash; status: number };

function formValues(f: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of f) if (k !== '_csrf' && !(k in out)) out[k] = v;
  return out;
}

function sellerValues(s: SellerProfile | null): Record<string, string> {
  if (!s) return { countryCode: 'HU', vatStatus: 'normal' };
  return {
    name: s.name ?? '',
    taxNumber: s.taxNumber ?? '',
    groupMemberTaxNumber: s.groupMemberTaxNumber ?? '',
    euVatNumber: s.euVatNumber ?? '',
    countryCode: s.address?.countryCode ?? 'HU',
    postalCode: s.address?.postalCode ?? '',
    city: s.address?.city ?? '',
    addressLine: s.address?.addressLine ?? '',
    region: s.address?.region ?? '',
    bankAccount: s.bankAccount ?? '',
    bankName: s.bankName ?? '',
    swift: s.swift ?? '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    website: s.website ?? '',
    registrationNumber: s.registrationNumber ?? '',
    vatStatus: s.vatStatus ?? 'normal',
    cashAccounting: s.cashAccounting ? '1' : '',
    smallBusiness: s.smallBusiness ? '1' : '',
    invoiceFooter: s.invoiceFooter ?? '',
  };
}

function defaultsValues(d: InvoiceDefaults): Record<string, string> {
  return {
    paymentMethod: d.paymentMethod,
    paymentDays: String(d.paymentDays),
    language: d.language,
    appearance: d.appearance,
    currency: d.currency,
    exchangeRateSource: d.exchangeRateSource,
  };
}

function sellerForm(ctx: Ctx, values: Record<string, string>, issues: ValidationIssue[] | null): SafeHtml {
  const v = (n: string): string => values[n] ?? '';
  return html`<form method="post" action="/settings/seller" aria-label="Eladó adatai">${csrfInput(ctx)}
${
    issues && issues.length > 0
      ? html`<ul class="issues">${issues.map((i) => html`<li>${i.severity === 'error' ? badge('hiba', 'err') : badge('figyelmeztetés', 'warn')}<span>${i.message}</span></li>`)}</ul>`
      : ''
  }
<div class="grid">
${inputField({ name: 'name', label: 'Név (cégnév)', value: v('name'), required: true, wide: true, extra: { maxlength: 512, autocomplete: 'organization' } })}
${inputField({ name: 'taxNumber', label: 'Adószám', value: v('taxNumber'), required: true, hint: 'Teljes formában: 12345676‑1‑23.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'euVatNumber', label: 'Közösségi adószám', value: v('euVatNumber'), hint: 'Uniós ügyletekhez, pl. HU12345676.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'groupMemberTaxNumber', label: 'Csoporttagi adószám', value: v('groupMemberTaxNumber'), hint: 'Csak ÁFA-csoport tagjánál.', extra: { autocomplete: 'off' } })}
${selectField({ name: 'vatStatus', label: 'ÁFA-státusz', value: v('vatStatus') || 'normal', options: Object.entries(SELLER_VAT_STATUS) })}
${inputField({ name: 'countryCode', label: 'Ország (kód)', value: v('countryCode') || 'HU', extra: { maxlength: 2 } })}
${inputField({ name: 'postalCode', label: 'Irányítószám', value: v('postalCode'), required: true, extra: { autocomplete: 'postal-code' } })}
${inputField({ name: 'city', label: 'Település', value: v('city'), required: true, extra: { autocomplete: 'address-level2' } })}
${inputField({ name: 'addressLine', label: 'Cím (utca, házszám)', value: v('addressLine'), required: true, wide: true, extra: { autocomplete: 'street-address' } })}
${v('region') ? inputField({ name: 'region', label: 'Régió / tartomány', value: v('region'), hint: 'Üresen hagyva törlődik.', extra: { maxlength: 50 } }) : ''}
${inputField({ name: 'bankAccount', label: 'Bankszámlaszám', value: v('bankAccount'), hint: 'Pl. 11773016‑11111018 (2×8 vagy 3×8 számjegy), vagy IBAN.', extra: { autocomplete: 'off' } })}
${inputField({ name: 'bankName', label: 'Bank neve', value: v('bankName') })}
${inputField({ name: 'swift', label: 'SWIFT/BIC', value: v('swift'), extra: { autocomplete: 'off' } })}
${inputField({ name: 'email', label: 'E-mail', type: 'email', value: v('email'), extra: { autocomplete: 'email' } })}
${inputField({ name: 'phone', label: 'Telefon', type: 'tel', value: v('phone'), extra: { autocomplete: 'tel' } })}
${inputField({ name: 'website', label: 'Weboldal', value: v('website'), extra: { autocomplete: 'url' } })}
${inputField({ name: 'registrationNumber', label: 'Cégjegyzékszám / nyilvántartási szám', value: v('registrationNumber') })}
${checkboxField({ name: 'cashAccounting', label: 'Pénzforgalmi elszámolás', checked: v('cashAccounting') !== '' })}
${checkboxField({ name: 'smallBusiness', label: 'Kisadózó (KATA)', checked: v('smallBusiness') !== '' })}
${textareaField({ name: 'invoiceFooter', label: 'Lábléc szövege a számlán', value: v('invoiceFooter'), maxlength: 1000 })}
</div>
<p class="hint">Az üresen hagyott nem kötelező mezők törlődnek. A változás csak az ezután készülő bizonylatokat érinti.</p>
<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}Eladói adatok mentése</button></div>
</form>`;
}

function defaultsForm(ctx: Ctx, values: Record<string, string>): SafeHtml {
  const v = (n: string): string => values[n] ?? '';
  return html`<form method="post" action="/settings/defaults" aria-label="Alapértelmezések">${csrfInput(ctx)}<div class="grid">
${selectField({ name: 'paymentMethod', label: 'Fizetési mód', value: v('paymentMethod'), options: Object.entries(PAYMENT_METHOD) })}
${inputField({ name: 'paymentDays', label: 'Fizetési határidő (nap, átutalásnál)', type: 'number', value: v('paymentDays'), extra: { min: 0, max: 365, step: 1, inputmode: 'numeric' } })}
${selectField({ name: 'language', label: 'Nyelv', value: v('language'), options: Object.entries(LANGUAGE) })}
${selectField({ name: 'appearance', label: 'Megjelenési forma', value: v('appearance'), options: Object.entries(APPEARANCE) })}
${inputField({ name: 'currency', label: 'Pénznem', value: v('currency'), extra: { maxlength: 3, pattern: '[A-Za-z]{3}' } })}
${selectField({
    name: 'exchangeRateSource',
    label: 'Devizás számlák árfolyama',
    value: v('exchangeRateSource'),
    options: [['MNB', 'MNB-árfolyam (automatikus)'], ['manual', 'kézi (számlánként megadva)']],
    hint: 'Az MNB-árfolyam használatát előzetesen be kell jelenteni a NAV-nak (Áfa tv. 80. §).',
  })}
</div><div class="actions"><button class="btn btn-primary" type="submit">${icon('check')}Alapértelmezések mentése</button></div></form>`;
}

export function settingsPage(ctx: Ctx, form?: FormState): void {
  const { app } = ctx;
  const seller = attempt(() => app.getSeller());
  const defaults = attempt(() => app.getDefaults());
  const series = attempt(() => app.listSeries());
  const status = attempt(() => app.status());
  const nav = navConnection(app);

  const sellerSection = seller.ok
    ? sellerForm(ctx, form?.form === 'seller' ? form.values : sellerValues(seller.value), status.ok ? status.value.sellerIssues : null)
    : sectionError(ctx, seller.error);
  const defaultsSection = defaults.ok ? defaultsForm(ctx, form?.form === 'defaults' ? form.values : defaultsValues(defaults.value)) : sectionError(ctx, defaults.error);
  const seriesSection = series.ok
    ? series.value.length > 0
      ? html`${dataTable({
          rows: series.value,
          columns: [
            { label: 'Név', cell: (s) => s.name },
            { label: 'Bizonylatok', cell: (s) => SERIES_KIND[s.kind] },
            { label: 'Minta', cls: 'mono', cell: (s) => s.pattern },
            { label: 'Következő sorszám', num: true, cell: (s) => html`${s.nextSeq}${s.seqYear ? html` <span class="muted small">(${s.seqYear})</span>` : ''}` },
            { label: 'Évente újraindul', cell: (s) => (s.yearlyReset ? 'igen' : 'nem') },
            { label: 'Állapot', cell: (s) => html`${s.isDefault ? badge('alapértelmezett', 'info') : ''} ${s.archived ? badge('archivált', 'neutral') : ''}` },
          ],
        })}<p class="hint">Új sorszámtartományt (pl. külön előtaggal) az AI-asszisztenssel hozhatsz létre – kérd meg rá.</p>`
      : emptyNote('Nincs sorszámtartomány.')
    : sectionError(ctx, series.error);

  // In the TEST environment: the command that switches to production, to copy (the dashboard to-do points here).
  const testEnv = nav.configured && nav.environment === 'test';
  const navSection = html`<dl class="kv">
<dt>Állapot</dt><dd>${navConnectionBadge(nav)}</dd>
${nav.configured ? html`<dt>Hitelesítő adatok forrása</dt><dd>${nav.source === 'env' ? 'a program indításakor megadott beállítások (környezeti változók)' : 'nav-credentials.json az adatkönyvtárban'}</dd>` : ''}
${nav.configured ? html`<dt>Beküldés</dt><dd>${nav.autoSubmit ? 'automatikusan, a kiállításkor' : 'kézzel, a bizonylat oldalán vagy az Áttekintés „Függő számlák beküldése a NAV-nak” gombjával'}</dd>` : ''}
</dl>
${
    testEnv
      ? html`<p>TESZT környezet: a számlák csak a NAV tesztrendszerébe kerülnek, éles adatszolgáltatás nem történik. Valódi számlázás előtt állítsd éles környezetre – egy új terminálablakban, az éles technikai felhasználó adataival:</p>${commandBlock('settings-prod-cmd', navSetupCommandLine(app.config.dataDir, 'production'))}`
      : ''
  }${
    nav.configured
      ? html`<p class="hint">A technikai felhasználó adatai (jelszó, aláíró- és cserekulcs) biztonsági okból sehol nem jelennek meg. Beállításuk és módosításuk – azon a gépen, ahol a program fut: <code>${navSetupCommandLine(app.config.dataDir)}</code>.</p>`
      : navSetupHelp(app.config.dataDir, 'settings-nav', { problem: nav.problem })
  }`;

  renderPage(ctx, {
    title: 'Beállítások',
    active: 'settings',
    ...(nav.configured && !testEnv ? {} : { script: COPY_SCRIPT }),
    ...(form ? { status: form.status, flashes: [form.error] } : {}),
    main: html`<div class="page-head"><div><h1>Beállítások</h1></div></div>
<section class="card" aria-labelledby="h-seller"><h2 id="h-seller">Eladó (saját cég)</h2>${sellerSection}</section>
<section class="card" aria-labelledby="h-defaults"><h2 id="h-defaults">Új bizonylatok alapértelmezései</h2>${defaultsSection}</section>
<section class="card" aria-labelledby="h-series"><h2 id="h-series">Sorszámtartományok</h2>${seriesSection}</section>
<section class="card" aria-labelledby="h-nav"><h2 id="h-nav">NAV Online Számla kapcsolat</h2>${navSection}</section>
<section class="card" aria-labelledby="h-safety"><h2 id="h-safety">Mentés és ellenőrzés</h2>
<p class="muted">A számlákat 8 évig meg kell őrizni. A mentés az adatbázis teljes másolata – benne minden kiállított bizonylat eredeti PDF-jével – az adatkönyvtár <span class="mono">backups</span> mappájában; onnan másold a gépen kívülre is (pendrive, felhő), mert az ugyanazon a lemezen lévő mentés a lemez hibáját nem éli túl. Visszaállítani az <span class="mono">openszamla restore &lt;mentésfájl&gt;</span> paranccsal kell, nem a fájl kézi másolásával.</p>
<div class="actions">
<form method="post" action="/settings/backup" aria-label="Mentés készítése">${csrfInput(ctx)}<button class="btn btn-primary" type="submit">${icon('download')}Mentés készítése most</button></form>
<form method="post" action="/settings/verify" aria-label="Adatbázis ellenőrzése">${csrfInput(ctx)}<button class="btn" type="submit">${icon('check')}Adatbázis ellenőrzése</button></form>
</div>
<p class="hint">Az ellenőrzés azt vizsgálja, hogy a kiállított bizonylatokat, a naplót, a sorszámozást, a befizetéseket és a megőrzött PDF-eket nem módosították-e a programon kívül (mint az <span class="mono">openszamla verify</span>). Sok ezer bizonylatnál eltarthat néhány másodpercig.</p>
</section>
<section class="card" aria-labelledby="h-sys"><h2 id="h-sys">Rendszer</h2><dl class="kv"><dt>Verzió</dt><dd>OpenSzámla ${VERSION}</dd><dt>Adatkönyvtár</dt><dd class="mono">${app.config.dataDir}</dd></dl></section>`,
  });
}

export function saveSeller(ctx: Ctx): void {
  let stored: Record<string, string> = {};
  try {
    stored = sellerValues(ctx.app.getSeller());
    // A field the page could not show (it contains a secret) was not submitted: it keeps its stored value.
    ctx = withWithheldFields(ctx, stored);
    const { issues } = ctx.app.updateSeller(sellerInputFrom(ctx.form), 'web');
    const errors = issues.filter((i) => i.severity === 'error').length;
    redirect(ctx, '/settings', {
      tone: issues.length > 0 ? 'warn' : 'ok',
      title: errors > 0 ? `Eladói adatok mentve, de ${errors} hibát javítani kell a számlázás előtt.` : 'Eladói adatok mentve.',
      lines: issues.map((i) => i.message),
    });
  } catch (e) {
    settingsPage(ctx, { form: 'seller', values: formValues(forRedisplay(ctx, stored)), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}

/** "Mentés készítése most": a backup into <dataDir>/backups (service: createBackup); the page says where it is. */
export function makeBackup(ctx: Ctx): void {
  try {
    const b = ctx.app.createBackup();
    redirect(ctx, '/settings', {
      tone: 'ok',
      title: `Mentés elkészült (${(b.bytes / (1024 * 1024)).toLocaleString('hu-HU', { maximumFractionDigits: 1 })} MB).`,
      lines: [`A mentésfájl: ${b.path}`, 'Másold a gépen kívülre is (pendrive, felhő). Visszaállítás: openszamla restore <mentésfájl>.'],
    });
  } catch (e) {
    redirect(ctx, '/settings', failure(ctx, e));
  }
}

/** "Adatbázis ellenőrzése": the integrity check (service: verifyIntegrity), its result in the words of `openszamla verify`. */
export function verifyDatabase(ctx: Ctx): void {
  try {
    const r = ctx.app.verifyIntegrity();
    const found: Array<[string, string[]]> = [
      ['Megváltozott tartalmú bizonylatok', r.invoiceMismatches],
      ['A naplóval ellentmondó bizonylatok', r.auditMismatches],
      ['Naplózatlan (a programon kívül felvett) bizonylatok', r.unauditedInvoices],
      ['Sorszámhézagok', r.numberingGaps],
      ['Hiányzó vagy módosított adatbázis-védelmek', r.alteredTriggers],
      ['A befizetési naplóval ellentmondó befizetett összegek', r.paymentMismatches],
      ['A megőrzött eredeti PDF-ekkel ellentmondó adatok', r.documentMismatches],
    ];
    const lines = [
      `Ellenőrzött bizonylatok: ${r.invoicesChecked}; auditnapló: ${r.audit.ok ? 'rendben' : `SÉRÜLT (bejegyzés #${r.audit.brokenAtId})`} (${r.audit.entries} bejegyzés); megőrzött eredeti PDF-ek: ${r.documentsChecked}.`,
      ...found.filter(([, list]) => list.length > 0).flatMap(([title, list]) => [`${title}:`, ...list.slice(0, 20).map((x) => `– ${x}`), ...(list.length > 20 ? [`– … és még ${list.length - 20}`] : [])]),
      ...[...r.documentWarnings, ...r.restoreWarnings].slice(0, 20).map((w) => `Figyelmeztetés: ${w}`),
    ];
    redirect(ctx, '/settings', r.ok
      ? { tone: 'ok', title: 'Ellenőrzés: rendben – nem találtam a programon kívüli módosítás nyomát.', lines }
      : {
          tone: 'err',
          title: 'Ellenőrzés: ELTÉRÉST TALÁLT – az adatbázist a programon kívül módosíthatták.',
          hint: 'Ne próbáld kézzel javítani: állíts vissza egy ép mentést (openszamla restore <mentésfájl>), és kérj könyvelői segítséget. A részleteket az openszamla verify parancs is kiírja.',
          lines,
        });
  } catch (e) {
    redirect(ctx, '/settings', failure(ctx, e));
  }
}

export function saveDefaults(ctx: Ctx): void {
  try {
    ctx.app.updateDefaults(defaultsPatchFrom(ctx.form), 'web');
    redirect(ctx, '/settings', { tone: 'ok', title: 'Alapértelmezések mentve.' });
  } catch (e) {
    settingsPage(ctx, { form: 'defaults', values: formValues(ctx.form), error: failure(ctx, e), status: isAppError(e) ? 422 : 500 });
  }
}
