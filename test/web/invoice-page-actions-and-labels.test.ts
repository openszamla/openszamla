/**
 * The invoice page says what each action does and what follows: the issue button names the document and
 * whether it goes to NAV, the final-action panel lists the consequences, the NAV button is labelled by
 * the document's NAV state, the head has jump links to every available action, "lejárt" marks an overdue
 * receivable, and the storno flow is worded as a preview first, then a final, red confirmation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/service/config.ts';
import { INVOICE_DOMESTIC, INVOICE_STORNO, SELLER_NORMAL } from '../fixtures/invoices.ts';
import { hiddenValue, insertDraft, insertIssued, startWeb, type WebEnv } from './helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.close();
});

async function env(opts: Parameters<typeof startWeb>[0] = {}): Promise<WebEnv> {
  const e = await startWeb(opts);
  envs.push(e);
  e.app.store.setSetting('seller', SELLER_NORMAL);
  return e;
}

const NAV_TEST: AppConfig['nav'] = {
  environment: 'test',
  credentials: { login: 'LABELLOGIN7f3a', password: 'label-password-1', signingKey: 'LABEL-SIGNING-KEY-55e0', exchangeKey: 'LABELEXCH-d00d42' },
  source: 'env',
  baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
};

/** The page head (title, badges, key facts and the action links). */
function headOf(body: string): string {
  const start = body.indexOf('<div class="page-head">');
  return body.slice(start, body.indexOf('<section', start));
}

describe('issuing a draft', () => {
  it('without NAV: "Számla kiállítása (végleges)", the consequences, the delete in its own danger zone', async () => {
    const e = await env();
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000d1')).body;
    expect(page).toContain('<section class="card final" aria-labelledby="h-draft">');
    expect(page).toContain('A kiállítás végleges – mi történik?');
    expect(page).toContain('A számla sorszámot kap, a kelte a kiállítás napja (2026.10.27.) lesz.');
    expect(page).toContain('hibát csak sztornó vagy módosító számlával lehet javítani');
    expect(page).toContain('A NAV-kapcsolat nincs beállítva, ezért most nem kerül a NAV-hoz');
    expect(page).toMatch(/<button class="btn btn-primary" type="submit"><svg[^>]*>.*?<\/svg>Számla kiállítása \(végleges\)<\/button>/);
    expect(page).toContain('<details class="no-print danger-zone" id="torles"><summary class="btn btn-danger-quiet">');
    expect(page).toContain('Piszkozat végleges törlése</button>');
    // The head jumps to the delete and keeps the PDF and edit actions.
    const head = headOf(page);
    expect(head).toContain('href="/invoices/inv_00000000d1.pdf">PDF letöltése</a>');
    expect(head).toContain('href="/invoices/inv_00000000d1/edit">Piszkozat szerkesztése</a>');
    expect(head).toMatch(/<a class="btn btn-danger-quiet" href="#torles">.*Piszkozat törlése…<\/a>/);
    expect(head).toContain('Bruttó: <strong>');
  });

  it('with a usable NAV connection: "… kiállítása és beküldése a NAV TESZT rendszerébe" in the TEST environment', async () => {
    const e = await env({ nav: NAV_TEST });
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d1' });
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000d1')).body;
    expect(page).toContain('Számla kiállítása és beküldése a NAV TESZT rendszerébe</button>');
    expect(page).toContain('Kiállításkor a program azonnal beküldi a NAV TESZT rendszerébe – éles adatszolgáltatás nem történik.');
    // The confirmation stays bound to the content: the label change did not touch the form.
    expect(hiddenValue(page, 'confirmation')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(page).toContain('name="confirm" type="checkbox" value="yes" required');
  });

  it('a díjbekérő and an előlegszámla: the button and the first consequence name the document', async () => {
    const e = await env({ nav: NAV_TEST });
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d2', documentType: 'proforma' });
    insertDraft(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000d3', documentType: 'advance' });
    const b = await e.loggedIn();
    const proforma = (await b.get('/invoices/inv_00000000d2')).body;
    expect(proforma).toContain('Díjbekérő kiállítása (végleges)</button>');
    expect(proforma).toContain('A díjbekérő nem számla: a NAV-nak nem jelentendő.');
    expect(proforma).toContain('Utána nem módosítható és nem törölhető, csak visszavonható.');
    const advance = (await b.get('/invoices/inv_00000000d3')).body;
    expect(advance).toContain('Az előlegszámla sorszámot kap');
    expect(advance).toContain('Előlegszámla kiállítása és beküldése a NAV TESZT rendszerébe</button>');
  });
});

describe('an issued invoice', () => {
  it('the head: badges with "lejárt" for an overdue receivable, payable and due date, jump links to payment, NAV and storno', async () => {
    const e = await env({ nav: NAV_TEST });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b1', number: 'SZ-2026-00010', dueDate: '2026-10-01', issueDate: '2026-09-20', fulfillmentDate: '2026-09-20' });
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const head = headOf((await b.get('/invoices/inv_00000000b1')).body);
    expect(head).toContain('lejárt</span>');
    expect(head).toContain('Fizetendő: <strong>');
    expect(head).toContain('Fizetési határidő: <strong>2026.10.01.</strong>');
    expect(head).toContain('<nav class="action-bar" aria-label="Ugrás a bizonylat műveleteihez">');
    expect(head).toMatch(/href="#h-pay">.*Befizetés rögzítése…<\/a>/);
    expect(head).toMatch(/href="#h-nav">.*Számla beküldése a NAV-nak…<\/a>/);
    expect(head).toMatch(/<a class="btn btn-danger-quiet" href="#h-cancel">.*Sztornó számla készítése…<\/a>/);
    // Not overdue (due 2026.11.04., today 2026.10.27.): no "lejárt".
    expect(headOf((await b.get('/invoices/inv_00000000a1')).body)).not.toContain('lejárt');
    // Paid: no payment form, so no shortcut to it either.
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000b2', number: 'SZ-2026-00011', paymentStatus: 'paid', paidAmount: INVOICE_DOMESTIC.totals.payableAmount, paidDate: '2026-10-27' });
    const paid = (await b.get('/invoices/inv_00000000b2')).body;
    expect(paid).not.toContain('action="/invoices/inv_00000000b2/payment"');
    expect(headOf(paid)).not.toContain('href="#h-pay"');
  });

  it('the NAV button says what it does in each NAV state; an accepted invoice has no NAV shortcut in the head', async () => {
    const e = await env({ nav: NAV_TEST });
    const states = [
      ['inv_00000000c1', 'pending', 'Számla beküldése a NAV-nak', 'Beküldi a bizonylatot a NAV-nak'],
      ['inv_00000000c2', 'processing', 'NAV-feldolgozás állapotának lekérdezése', 'Lekérdezi, hol tart a NAV'],
      ['inv_00000000c3', 'aborted', 'Számla újraküldése a NAV-nak', 'Csak a hiba javítása után küldd újra'],
      ['inv_00000000c4', 'error', 'Számla újraküldése a NAV-nak', 'Csak a hiba elhárítása után küldd újra'],
      ['inv_00000000c5', 'done', 'NAV-állapot ellenőrzése', 'újra nem küldi be'],
    ] as const;
    states.forEach(([id, navStatus], i) => insertIssued(e.app, INVOICE_DOMESTIC, { id, number: `SZ-2026-0002${i}`, navStatus }));
    const b = await e.loggedIn();
    for (const [id, status, label, hint] of states) {
      const page = (await b.get(`/invoices/${id}`)).body;
      expect(page, status).toContain(`${label}</button>`);
      expect(page, status).toContain(hint);
      expect(page, status).not.toContain('NAV-szinkron');
      if (status === 'done') expect(headOf(page), status).not.toContain('href="#h-nav"');
      else expect(headOf(page), status).toContain('href="#h-nav"');
    }
  });

  it('without NAV the NAV part says where the setup steps are, and the head has no NAV shortcut', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000a1')).body;
    expect(page).toContain('a beállítás lépései az Áttekintés oldalon (Első lépések) és a Beállítások oldalon olvashatók');
    expect(headOf(page)).not.toContain('href="#h-nav"');
  });

  it('a storno invoice shows its gross total, not an amount to pay', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    insertIssued(e.app, INVOICE_STORNO);
    const b = await e.loggedIn();
    const head = headOf((await b.get('/invoices/inv_00000000a4')).body);
    expect(head).toContain('Bruttó: <strong>');
    expect(head).not.toContain('Fizetendő:');
    expect(head).not.toContain('href="#h-cancel"');
  });
});

describe('storno', () => {
  it('the start is a preview, the preview lists the consequences and confirms with a red button naming the result', async () => {
    const e = await env();
    insertIssued(e.app, INVOICE_DOMESTIC);
    const b = await e.loggedIn();
    const page = (await b.get('/invoices/inv_00000000a1')).body;
    expect(page).toContain('<summary class="btn btn-danger-quiet">');
    expect(page).toContain('Sztornó számla készítése…</summary>');
    expect(page).toContain('Sztornó előnézete (még nem végleges)</button>');
    expect(page).toContain('Első lépésként előnézetet kérsz: az még nem végleges');
    const preview = (await b.post('/invoices/inv_00000000a1/cancel-preview', { reason: 'Hibás összeg' })).body;
    expect(preview).toContain('<section class="card final">');
    expect(preview).toContain('A művelet végleges – mi történik?');
    expect(preview).toContain('Új sorszámú sztornó számla készül, az eredeti számla ezután sztornózott.');
    expect(preview).toContain('A NAV-kapcsolat nincs beállítva, ezért most nem kerül a NAV-hoz');
    expect(preview).toMatch(/<button class="btn btn-danger" type="submit"><svg[^>]*>.*?<\/svg>Sztornó számla kiállítása \(végleges\)<\/button>/);
    expect(preview).toContain('<a class="btn btn-quiet" href="/invoices/inv_00000000a1">Mégsem, vissza a számlához</a>');
  });

  it('with NAV (TEST): "Sztornó számla kiállítása és beküldése a NAV TESZT rendszerébe"; a díjbekérő: "Díjbekérő visszavonása (végleges)"', async () => {
    const e = await env({ nav: NAV_TEST });
    // Accepted by the TEST system: its storno goes to NAV right away (one waiting for its original says so instead).
    insertIssued(e.app, INVOICE_DOMESTIC, { navStatus: 'done', navEnvironment: 'test' });
    insertIssued(e.app, INVOICE_DOMESTIC, { id: 'inv_00000000f9', number: 'DB-2026-00001', documentType: 'proforma', navStatus: 'not_applicable' });
    const b = await e.loggedIn();
    await b.get('/invoices/inv_00000000a1');
    const storno = (await b.post('/invoices/inv_00000000a1/cancel-preview', { reason: 'Hibás összeg' })).body;
    expect(storno).toContain('Sztornó számla kiállítása és beküldése a NAV TESZT rendszerébe</button>');
    const page = (await b.get('/invoices/inv_00000000f9')).body;
    expect(page).toContain('Díjbekérő visszavonása…</summary>');
    expect(page).toContain('Visszavonás előnézete (még nem végleges)</button>');
    expect(headOf(page)).toMatch(/href="#h-cancel">.*Díjbekérő visszavonása…<\/a>/);
    const revoke = (await b.post('/invoices/inv_00000000f9/cancel-preview', { reason: 'A megrendelő visszalépett' })).body;
    expect(revoke).toContain('Díjbekérő visszavonása (végleges)</button>');
    expect(revoke).toContain('Mégsem, vissza a díjbekérőhöz</a>');
    expect(revoke).toContain('A díjbekérő visszavont állapotba kerül');
  });
});
