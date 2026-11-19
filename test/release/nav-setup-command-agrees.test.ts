/**
 * The NAV setup command never differs between the places that give it: the service's to-dos and errors, the web UI
 * (first-run guide, settings page, the NAV part of an invoice of the other system), `openszamla setup`, `openszamla
 * doctor` and the documentation (README, user doc 3.4) all show navSetupCommandLine – the data directory given whenever it
 * is not the built-in ~/.openszamla (an MCP client's OPENSZAMLA_HOME is not set in a terminal), under the home folder as
 * "~…" – and the npx form next to it where they offer one.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenSzamla } from '../../src/service/app.ts';
import { dataDirOption, navSetupCommand, navSetupCommandLine, type AppConfig } from '../../src/service/config.ts';
import { SELLER_INPUT } from '../helpers/app.ts';
import { makeProfile, removeProfiles, runIn } from '../helpers/client-profile.ts';
import { startWeb, type WebEnv } from '../web/helpers.ts';

const envs: WebEnv[] = [];
afterEach(async () => {
  removeProfiles();
  while (envs.length > 0) await envs.pop()?.close();
});

const esc = (s: string): string => s.replace(/"/g, '&quot;');
const TEST_NAV: AppConfig['nav'] = {
  environment: 'test',
  credentials: { login: 'AGREELOGIN7f3a', password: 'agree-password-1', signingKey: 'AGREE-SIGNING-KEY-55e0', exchangeKey: 'AGREEEXCH-d00d42' },
  source: 'env',
  baseUrl: 'http://127.0.0.1:9/invoiceService/v3',
};

describe('one nav-setup command everywhere', () => {
  it('the service: navSetupCommand is the command line and its npx form; the to-do names it', async () => {
    const dir = 'C:\\Adatok\\OpenSzámla';
    expect(navSetupCommandLine(dir)).toBe('openszamla nav-setup --data-dir "C:\\Adatok\\OpenSzámla"');
    expect(navSetupCommandLine(dir, 'production')).toBe('openszamla nav-setup --env production --data-dir "C:\\Adatok\\OpenSzámla"');
    expect(navSetupCommand(dir)).toBe(`${navSetupCommandLine(dir)} (telepítés nélkül: npx -y ${navSetupCommandLine(dir)})`);
    const e = await startWeb();
    envs.push(e);
    expect(e.app.status().nextSteps.join('\n')).toContain(navSetupCommand(e.app.config.dataDir));
  });

  it('the web UI: the first-run guide and the settings page show the same command line (and its npx form)', async () => {
    const e = await startWeb();
    envs.push(e);
    const b = await e.loggedIn();
    const line = esc(navSetupCommandLine(e.app.config.dataDir));
    const dashboard = (await b.get('/')).body;
    expect(dashboard).toContain(`<code class="cmd" id="guide-nav-cmd">${line}</code>`);
    expect(dashboard).toContain(`<code class="cmd" id="guide-nav-npx">npx -y ${line}</code>`);
    expect((await b.get('/settings')).body).toContain(`<code class="cmd" id="settings-nav-cmd">${line}</code>`);
    // With TEST settings: the production switch, as setup and doctor print it.
    const t = await startWeb({ nav: TEST_NAV });
    envs.push(t);
    const tb = await t.loggedIn();
    t.app.updateSeller(SELLER_INPUT);
    expect((await tb.get('/')).body).toContain(esc(navSetupCommandLine(t.app.config.dataDir, 'production')));
    expect((await tb.get('/settings')).body).toContain(`<code>${esc(navSetupCommandLine(t.app.config.dataDir))}</code>`);
  });

  it('openszamla doctor and openszamla setup print the same production switch for TEST settings', async () => {
    const p = makeProfile();
    const dataDir = join(p.home, '.openszamla');
    const app = OpenSzamla.open({ dataDir, env: {}, actor: 'cli' });
    try {
      app.updateSeller(SELLER_INPUT);
    } finally {
      app.close();
    }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'nav-credentials.json'), JSON.stringify({ environment: 'test', login: 'tesztelek1', password: 'Titkos-Jelszo-123', signingKey: 'ALAIRO-KULCS-XYZ', exchangeKey: 'CSEREKULCS123456' }));
    // The profile's own ~/.openszamla is the built-in data directory of the programs it runs: no --data-dir.
    expect(dataDirOption(dataDir, p.home)).toBe('');
    const production = 'openszamla nav-setup --env production';
    const doctor = await runIn(p, ['doctor']);
    expect(doctor.stdout).toContain(`Éles számlázás előtt: ${production} (az éles technikai felhasználó adataival)`);
    const setup = await runIn(p, ['setup']);
    expect(setup.stdout).toContain(`Éles számlázás előtt: ${production}`);
  });

  it('the documentation gives the same form', () => {
    const doc = readFileSync('docs/felhasznaloi-dokumentacio.md', 'utf8');
    expect(doc).toContain('`openszamla nav-setup --data-dir "<adatkönyvtár>"` (telepítés nélkül: `npx -y openszamla\n  nav-setup --data-dir "<adatkönyvtár>"`)');
    expect(readFileSync('README.md', 'utf8')).toContain('openszamla nav-setup --data-dir <ugyanaz a mappa>');
  });
});
