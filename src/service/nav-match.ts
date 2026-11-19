/**
 * Is the invoice NAV holds under a number (queryInvoiceData) the same invoice as ours? Used when NAV rejects a
 * submission as a duplicate (INVOICE_NUMBER_NOT_UNIQUE) or the outcome of one is unknown: a valid number alone
 * proves nothing – after a restored backup, or when another invoicing program uses the same series, the number
 * can belong to a different invoice. A report NAV received before the invoice was issued is never this invoice
 * (navReceivedBeforeIssue). A report entered by hand on the NAV web interface (WEB – docs/nav-beallitas.md, 5.)
 * never equals our data byte for byte, but its key data do: issue date, seller, buyer (tax number, or the name
 * without one), currency and the HUF totals. A report from any other channel was made by a program – through the
 * machine interface (MGM: ours, another installation, another invoicing program), as an uploaded XML file, in NAV's
 * own online invoicing program or by an online cash register –, so it is this invoice only when its lines agree too:
 * a sale to another private person at the same price has the same key data.
 */
import { searchKey } from '../core/canonical.ts';
import { dec, toDec } from '../core/decimal.ts';
import type { CustomerData, Invoice } from '../core/types.ts';
import { parseInvoiceDataKeys } from '../nav/api-xml.ts';
import { buildInvoiceDataXml, splitHuTaxNumber } from '../nav/invoice-data.ts';
import type { NavInvoiceKeys, NavInvoiceLineKeys } from '../nav/types.ts';
import { normalizeXmlText } from '../nav/xml.ts';

/**
 * The source of a report (queryInvoiceData auditData) whose data were typed by hand: WEB – the NAV web interface (the
 * outage procedure, docs/nav-beallitas.md 5.). Every other source is compared line by line: MGM – the machine
 * interface –, XML – an XML file uploaded on the NAV web interface (our own report uploaded by hand has our lines) –,
 * OSZ – NAV's own online invoicing program –, OPG – an online cash register –, or none.
 */
const MANUAL_SOURCES: ReadonlySet<string> = new Set(['WEB']);

/** Sources of a report that did not come through a program's machine interface (MGM): WEB, XML, OSZ, OPG. */
const OTHER_CHANNELS: ReadonlySet<string> = new Set(['WEB', 'XML', 'OSZ', 'OPG']);

/** The report was typed by hand on NAV's web interface (MANUAL_SOURCES): only its key data are compared. */
export function navManualSource(source: string): boolean {
  return MANUAL_SOURCES.has(source.trim().toUpperCase());
}

/** The report came through another channel than a program's machine interface (OTHER_CHANNELS: WEB, XML, OSZ, OPG). */
export function navOtherChannel(source: string): boolean {
  return OTHER_CHANNELS.has(source.trim().toUpperCase());
}

/** A NAV timestamp (InvoiceTimestampType: UTC with a Z, at most milliseconds) – the only form compared in time. */
const NAV_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * NAV received the report it holds under the number (auditData insDate) more than `marginMs` – the clock difference
 * tolerated between this machine and NAV – before `inv` was issued (issuedAt): that report existed before this
 * invoice did, so it is another invoice whatever its data. After a restored backup the number can go to the same
 * goods at the same price for another private person (NAV gets no data of private persons): the two reports are then
 * byte for byte the same, and only the time tells them apart. A genuine re-send of `inv` reached NAV after it was
 * issued. issuedAt is this machine's time and insDate NAV's: `clockOffsetMs` (how far this machine's clock is ahead of
 * NAV's, NavClient.clockOffsetMs) turns the issue time into NAV time first – a PC clock 10 minutes fast would otherwise
 * make our own lost-response report look 10 minutes older than the invoice. False when either time is missing or not
 * a timestamp.
 */
export function navReceivedBeforeIssue(inv: Pick<Invoice, 'issuedAt'>, insDate: string | null | undefined, marginMs: number, clockOffsetMs: number | null = null): boolean {
  const at = typeof insDate === 'string' ? insDate.trim() : '';
  const received = NAV_TIMESTAMP.test(at) ? Date.parse(at) : Number.NaN;
  const issued = inv.issuedAt ? Date.parse(inv.issuedAt) - (clockOffsetMs ?? 0) : Number.NaN;
  return Number.isFinite(received) && Number.isFinite(issued) && issued - received > marginMs;
}

/**
 * What makes the invoice NAV holds (`keys`, its auditData `source`) another invoice than `inv`, in Hungarian; [] when
 * it is this one. The key data always (navInvoiceDifferences); for a report not typed by hand on the NAV web
 * interface (not navManualSource) the lines too (navLineDifferences).
 */
export function navRecordDifferences(inv: Invoice, keys: NavInvoiceKeys, source: string): string[] {
  const key = navInvoiceDifferences(inv, keys);
  return key.length > 0 || navManualSource(source) ? key : navLineDifferences(inv, keys);
}

/**
 * The line data in which the invoice NAV holds (`keys`) differs from `inv`, in Hungarian; [] when none does: the
 * number of lines, and line by line the description (case, accents and spacing do not count), quantity, unit of
 * measure, net amount and VAT rate – as our report of `inv` gives them.
 */
export function navLineDifferences(inv: Invoice, keys: NavInvoiceKeys): string[] {
  let ours: NavInvoiceLineKeys[];
  try {
    ours = parseInvoiceDataKeys(buildInvoiceDataXml(inv)).lines;
  } catch {
    return ['tételek']; // no report of ours to compare with: it cannot be ours
  }
  if (ours.length !== keys.lines.length) return ['tételek száma'];
  const fields: Array<[string, (a: NavInvoiceLineKeys, b: NavInvoiceLineKeys) => boolean]> = [
    ['megnevezése', (a, b) => a.description !== null && nameKey(a.description) === nameKey(b.description)],
    ['mennyisége', (a, b) => sameAmount(a.quantity, b.quantity ?? '')],
    ['mennyiségi egysége', (a, b) => a.unit !== null && unitKey(a.unit) === unitKey(b.unit)],
    ['nettó összege', (a, b) => sameAmount(a.netAmount, b.netAmount ?? '')],
    ['ÁFA-kulcsa', (a, b) => sameVat(a, b)],
  ];
  const out: string[] = [];
  for (const [label, same] of fields) {
    const lines = ours.flatMap((o, i) => (same(keys.lines[i] as NavInvoiceLineKeys, o) ? [] : [`${i + 1}.`]));
    if (lines.length > 0) out.push(`${lines.length > 5 ? `${lines.slice(0, 5).join(', ')} …` : lines.join(', ')} tétel ${label}`);
  }
  return out;
}

/** OWN units by their text (case and spacing do not count), the others by NAV's code. */
function unitKey(v: string | null): string {
  const s = (v ?? '').trim();
  return s.toUpperCase().startsWith('OWN:') ? `OWN:${nameKey(s.slice(4))}` : s.toUpperCase();
}

/** The same VAT choice with the same value: rates as decimals, cases by their code. */
function sameVat(a: NavInvoiceLineKeys, b: NavInvoiceLineKeys): boolean {
  if (a.vatKind === null || a.vatKind !== b.vatKind) return false;
  if (a.vatValue === null || b.vatValue === null) return a.vatValue === b.vatValue;
  if (a.vatKind === 'vatPercentage' || a.vatKind === 'vatContent') return sameAmount(a.vatValue, b.vatValue);
  return a.vatValue.trim().toUpperCase() === b.vatValue.trim().toUpperCase();
}

/** The key data in which the invoice NAV holds (`keys`) differs from `inv`, in Hungarian; [] when none does. */
export function navInvoiceDifferences(inv: Invoice, keys: NavInvoiceKeys): string[] {
  const out: string[] = [];
  if (keys.issueDate !== inv.issueDate) out.push('kelte');
  const seller = splitHuTaxNumber(inv.seller.taxNumber)?.taxpayerId ?? null;
  if (seller === null || keys.supplierTaxpayerId !== seller) out.push('eladó adószáma');
  if (!sameBuyer(inv.customer, keys)) out.push('vevő');
  if ((keys.currency ?? '').toUpperCase() !== inv.currency.trim().toUpperCase()) out.push('pénznem');
  if (!sameAmount(keys.netAmountHuf, inv.totals.netAmountHuf)) out.push('nettó összeg (HUF)');
  if (!sameAmount(keys.vatAmountHuf, inv.totals.vatAmountHuf)) out.push('ÁFA (HUF)');
  if (!sameAmount(keys.grossAmountHuf ?? plus(keys.netAmountHuf, keys.vatAmountHuf), inv.totals.grossAmountHuf)) out.push('bruttó összeg (HUF)');
  return out;
}

/** Private persons by their status (NAV gets no data of them); others by tax number, else by name. */
function sameBuyer(c: CustomerData, k: NavInvoiceKeys): boolean {
  if (c.vatStatus === 'PRIVATE_PERSON' || k.customerVatStatus === 'PRIVATE_PERSON') return c.vatStatus === k.customerVatStatus;
  const hu = splitHuTaxNumber(c.taxNumber)?.taxpayerId ?? null;
  if (hu && k.customerTaxpayerId) return hu === k.customerTaxpayerId;
  const eu = communityVatNumber(c.euVatNumber);
  if (eu && k.customerCommunityVatNumber) return eu === communityVatNumber(k.customerCommunityVatNumber);
  const third = normalizeXmlText(c.thirdStateTaxId, 50);
  if (third && k.customerThirdStateTaxId) return third.toUpperCase() === k.customerThirdStateTaxId.toUpperCase();
  const name = nameKey(c.name);
  return name !== '' && name === nameKey(k.customerName);
}

function communityVatNumber(v: string | null | undefined): string | null {
  const s = (v ?? '').toUpperCase().replace(/[\s.-]/g, '');
  return s || null;
}

/** Case, accents and spacing do not count (a name typed by hand). */
function nameKey(v: string | null | undefined): string {
  return searchKey(normalizeXmlText(v, 512) ?? '').replace(/\s+/g, ' ').trim();
}

function sameAmount(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    return dec(a).eq(dec(b));
  } catch {
    return false;
  }
}

function plus(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  try {
    return toDec(dec(a).plus(dec(b)));
  } catch {
    return null;
  }
}
