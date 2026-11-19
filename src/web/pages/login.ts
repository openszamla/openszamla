/** Login page (shown for every request without a valid session). */
import { html } from '../html.ts';
import { documentHtml, type Flash } from '../layout.ts';

export function loginPage(o: { nonce: string; next: string; flash?: Flash }): string {
  const main = html`<div class="login-wrap"><div class="card">
<h1>Belépés</h1>
<p class="muted">Az OpenSzámla webes felületéhez add meg a hozzáférési kulcsot (tokent).</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${o.next}">
<div class="field"><label for="f-token">Hozzáférési kulcs</label>
<input id="f-token" name="token" type="password" autocomplete="current-password" required autofocus spellcheck="false" aria-describedby="f-token-hint">
<p class="hint" id="f-token-hint">A legegyszerűbb a program indításakor kiírt teljes belépési címet (<code>…/?token=…</code>) megnyitni: az be is léptet. A kulcsot az <code>openszamla serve</code> indításkor kiírja; fájlban: <code>&lt;adatkönyvtár&gt;/http-token</code>.</p></div>
<div class="actions"><button class="btn btn-primary" type="submit">Belépés</button></div>
</form>
</div></div>`;
  return documentHtml({ nonce: o.nonce, title: 'Belépés', csrf: null, flashes: o.flash ? [o.flash] : [], main }).html;
}

/** Simple logged-out page for errors that happen before authentication (e.g. a rejected POST). */
export function bareMessagePage(o: { nonce: string; title: string; flash: Flash; link?: { href: string; label: string } }): string {
  const main = html`<div class="login-wrap"><div class="card"><h1>${o.title}</h1>${
    o.link ? html`<p><a class="btn" href="${o.link.href}">${o.link.label}</a></p>` : ''
  }</div></div>`;
  return documentHtml({ nonce: o.nonce, title: o.title, csrf: null, flashes: [o.flash], main }).html;
}
