/**
 * Web-specific advice for service messages whose fix is written for MCP and CLI callers ("MCP:
 * seller_update", "customerId", "a vatReason mezőben"). The service texts stay as they are – agents and
 * the CLI rely on them –; the web UI shows these instead, keyed by the stable error / issue code.
 */
import type { Invoice, ValidationIssue } from '../core/types.ts';
import type { Flash } from './layout.ts';
import { CUSTOMER_VAT_STATUS } from './labels.ts';

const ERROR_HINTS: Readonly<Record<string, Pick<Flash, 'hint' | 'link'>>> = {
  SELLER_NOT_CONFIGURED: {
    hint: 'Először állítsd be az eladó adatait (név, adószám, cím, ÁFA-státusz) a Beállítások oldalon.',
    link: { href: '/settings', label: 'Beállítások megnyitása' },
  },
  DUPLICATE_CUSTOMER: {
    hint: 'Ez a vevő már szerepel a vevők között: válaszd ki a vevőt a listából (új bizonylatnál a „Vevő a vevőlistából” mezőben); az adatait az adatlapján módosíthatod.',
  },
  // The web form takes a decimal comma too (forms.ts numberInput), unlike the service's own hint.
  INVALID_NUMBER: {
    hint: 'Számot írj be, ezres elválasztó nélkül; a tizedesjel vessző vagy pont lehet (pl. 12500 vagy 1,5).',
  },
  // The web form has a checkbox for it (the service names the MCP field).
  OVERPAYMENT_NOT_CONFIRMED: {
    hint: 'Ellenőrizd az összeget (nem csúszott el egy számjegy vagy a tizedesjel?). Ha a vevő valóban ennyit fizetett, jelöld be a „Túlfizetést rögzítek” jelölőt a befizetés űrlapján, és küldd el újra.',
  },
  // A product picked for a line whose price is in another currency than the document's.
  CURRENCY_MISMATCH: {
    hint: 'Írd be az egységárat a tétel sorába, a bizonylat pénznemében – a termék árát a program nem váltja át.',
  },
};

/** API field names a service message may quote ("a(z) \"from\" mezőben"), as the web forms label those fields. */
const WEB_FIELD_NAMES: Readonly<Record<string, string>> = {
  from: 'Időszak kezdete',
  to: 'Időszak vége',
  date: 'Dátum',
  amount: 'Összeg',
  exchangeRate: 'Árfolyam',
  issueDate: 'Kelte',
  fulfillmentDate: 'Teljesítés dátuma',
  dueDate: 'Fizetési határidő',
  unitPrice: 'Egységár',
  quantity: 'Mennyiség',
};

/**
 * A service message with its quoted API field name said as the form labels the field: a(z) "from" mezőben → a(z)
 * „Időszak kezdete” mezőben.
 */
export function webFieldMessage(message: string): string {
  return message.replace(/a\(z\) "([A-Za-z]+)" mezőben/g, (whole: string, field: string) => {
    const label = Object.hasOwn(WEB_FIELD_NAMES, field) ? WEB_FIELD_NAMES[field] : undefined;
    return label ? `a(z) „${label}” mezőben` : whole;
  });
}

const ISSUE_NOTES: Readonly<Record<string, string>> = {
  LINE_EXEMPTION_REFERENCE_RECOMMENDED:
    'A webes űrlapon ehhez nincs mező: a pontos jogszabályhelyet az AI-asszisztens írhatja be (pl. „Az 1. tételhez írd be a mentesség jogszabályhelyét: Áfa tv. 85. § (1) e)”); ' +
    'utána a piszkozat a weben már nem szerkeszthető. Enélkül is kiállítható: a számlára az általános mentességi megjelölés kerül.',
  BUYER_DIFFERS_FROM_RECORD:
    'A webes felületen: a Piszkozat szerkesztése oldalon mentve a piszkozat a vevőlistában kiválasztott vevő tárolt adatait kapja. ' +
    'A weben nem szerkeszthető piszkozatnál ezt az AI-asszisztens teheti meg: kérd meg, hogy a piszkozat vevőjét állítsa vissza a mentett vevőre.',
  PROFORMA_PAYMENT_NOT_CARRIED: 'A webes felületen a befizetést a kiállítás után, a bizonylat oldalán rögzítheted (Befizetés rögzítése).',
};

/** The buyer types as the web forms name them (the service messages say DOMESTIC / OTHER / PRIVATE_PERSON). */
const DOMESTIC = `„${CUSTOMER_VAT_STATUS.DOMESTIC}”`;
const OTHER = `„${CUSTOMER_VAT_STATUS.OTHER}”`;
const PRIVATE = `„${CUSTOMER_VAT_STATUS.PRIVATE_PERSON}”`;
const EU_CODES: ReadonlySet<string> = new Set(['KBAET', 'EUFAD37', 'EUFADE']);

/** The line an issue is about ("lines[k]…" in its field), as the document numbers it. */
function lineOf(i: ValidationIssue, inv: Pick<Invoice, 'lines'>): { no: number; vatCode: string } | null {
  const m = /^lines\[(\d+)\]/.exec(i.field ?? '');
  const line = m ? inv.lines[Number(m[1])] : undefined;
  return line ? { no: line.lineNo, vatCode: line.vatCode } : null;
}

function euCodesOf(inv: Pick<Invoice, 'lines'>): string {
  const codes = [...new Set(inv.lines.map((l) => l.vatCode).filter((c) => EU_CODES.has(c)))];
  return codes.length > 0 ? codes.join(', ') : 'közösségi';
}

/**
 * Validation messages worded for agents (buyer types as DOMESTIC / OTHER / PRIVATE_PERSON, MCP field and tool names,
 * NAV error numbers), said in the words of the web forms – by issue code; the service message stays for MCP and the CLI.
 */
const WEB_ISSUE_TEXT: Readonly<Record<string, (i: ValidationIssue, inv: Pick<Invoice, 'lines'>) => string | null>> = {
  EU_CODE_CUSTOMER_NOT_OTHER: (_i, inv) =>
    `A(z) ${euCodesOf(inv)} kódú tétel csak más uniós tagállamban nyilvántartott cégnek (adóalanynak) számlázható: a vevő típusa legyen ${OTHER}, és add meg a közösségi adószámát.`,
  EU_CODE_CUSTOMER_EU_VAT_REQUIRED: (_i, inv) =>
    `A(z) ${euCodesOf(inv)} kódú ügyletnél a vevő közösségi adószáma kötelező (Áfa tv. 169. §): add meg (pl. DE123456789), és ellenőrizd az EU VIES-rendszerében.`,
  CUSTOMER_TAX_NUMBER_REQUIRED: () =>
    `Belföldi áfaalany vevőnél az adószám kötelező (Áfa tv. 169. § d)): add meg (12345676‑1‑23), vagy ha a vevő nem áfaalany, válaszd a vevő típusánál az ${OTHER} vagy a ${PRIVATE} lehetőséget.`,
  CUSTOMER_DOMESTIC_FOREIGN_ADDRESS: () => `A vevő típusa ${DOMESTIC}, a címe viszont külföldi: ellenőrizd a vevő típusát (külföldi cégnél ${OTHER}, a közösségi adószámával).`,
  CUSTOMER_OTHER_WITH_HU_VAT_NUMBER: () => `Magyar közösségi adószámú vevő belföldi áfaalany: a vevő típusa ${DOMESTIC} legyen, az adószámával (12345676‑1‑23).`,
  CUSTOMER_OTHER_DOMESTIC_TAXPAYER: () =>
    `A vevő magyar adószáma áfaalanyra utal (a 9. jegye 2–5): belföldi áfaalanynál a vevő típusa ${DOMESTIC}. Ha a vevő valóban nem áfaalany, maradhat ${OTHER}.`,
  CUSTOMER_PRIVATE_PERSON_TAX_ID: () =>
    `Magánszemély vevőnek adószáma van megadva. Ha adóalanyként (pl. egyéni vállalkozóként) vásárol, a vevő típusa ${DOMESTIC} vagy ${OTHER} legyen; magánszemély adatai nem kerülnek a NAV-hoz.`,
  CUSTOMER_TAX_NUMBER_GROUP_MEMBER: () =>
    'A vevő adószámának 9. jegye 4 (áfacsoport tagja): a számlára adószámként a csoportazonosító szám kell (…‑5‑…), a tag adószáma a „Csoporttagi adószám” mezőbe kerül.',
  FAD_CUSTOMER_NOT_DOMESTIC: () => `Belföldi fordított adózás (FAD) csak belföldi áfaalany vevőnek számlázható: a vevő típusa ${DOMESTIC} legyen.`,
  KBAUK_CUSTOMER_DOMESTIC: () => `Új közlekedési eszköz Közösségen belüli értékesítése (KBAUK) nem számlázható ${DOMESTIC} típusú vevőnek.`,
  SELLER_MISSING: () => 'Hiányoznak az eladó (saját cég) adatai: add meg őket a Beállítások oldalon.',
  SELLER_BANK_ACCOUNT_MISSING: () => 'Átutalásos számlán az eladó bankszámlaszáma nincs megadva, így a vevő nem tudja, hová utaljon: add meg a Beállítások oldalon, az eladó adatainál.',
  SELLER_EU_VAT_NUMBER_MISSING: () => 'Közösségi ügylethez az eladónak közösségi adószám (HU + a törzsszám) kell: add meg a Beállítások oldalon, az eladó adatainál.',
  LINE_EXEMPTION_REFERENCE_RECOMMENDED: (i, inv) => {
    const line = lineOf(i, inv);
    if (!line) return null;
    const kind = line.vatCode === 'NAM' ? 'nemzetközi ügylethez kapcsolódó adómentes' : 'tárgyi adómentes';
    return `A(z) ${line.no}. tétel ${kind}: a számlán a mentesség pontos jogszabályhelye is feltüntethető (pl. „Áfa tv. 85. § (1) e) – oktatás”), hogy egyértelmű legyen (Áfa tv. 169. § m)).`;
  },
  LINES_REQUIRED: () => 'Legalább egy tétel szükséges: add meg a megnevezését, a mennyiségét és az egységárát.',
  LINE_AMOUNTS_INVALID: (i, inv) => {
    const line = lineOf(i, inv);
    return line ? `A(z) ${line.no}. tétel összegei hiányoznak vagy nem számok: mentsd újra a piszkozatot.` : null;
  },
};

/** The hint (and link) that replaces the service hint of an AppError with this code (errorFlash). */
export function webErrorHint(code: string): Pick<Flash, 'hint' | 'link'> | undefined {
  return Object.hasOwn(ERROR_HINTS, code) ? ERROR_HINTS[code] : undefined;
}

/** A note shown after the message of a validation issue with this code (the draft page). */
export function webIssueNote(code: string): string | undefined {
  return Object.hasOwn(ISSUE_NOTES, code) ? ISSUE_NOTES[code] : undefined;
}

/** The web wording of a validation issue whose service message is worded for agents; undefined: show the service message. */
export function webIssueText(i: ValidationIssue, inv: Pick<Invoice, 'lines'>): string | undefined {
  const text = Object.hasOwn(WEB_ISSUE_TEXT, i.code) ? WEB_ISSUE_TEXT[i.code]?.(i, inv) : null;
  return text ?? undefined;
}
