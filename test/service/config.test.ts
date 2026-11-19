/** Runtime configuration: data directory resolution and the precedence of NAV settings. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NAV_CREDENTIALS_FILE, defaultDataDir, isRelativeConfiguredPath, loadConfig, loadNavConfig } from '../../src/service/config.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openszamla-config-'));
  dirs.push(d);
  return d;
}

/** A data directory with the nav-credentials.json that `openszamla nav-setup` writes. */
function withCredentialsFile(environment: string): string {
  const dir = tempDir();
  writeFileSync(
    join(dir, NAV_CREDENTIALS_FILE),
    JSON.stringify({ environment, login: 'prodlogin', password: 'jelszo', signingKey: 'alairo-kulcs', exchangeKey: 'cserekulcs123456' }),
  );
  return dir;
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('data directory', () => {
  it('expands a leading ~ (MCP clients start the server without a shell)', () => {
    expect(defaultDataDir({ OPENSZAMLA_HOME: '~/.openszamla' })).toBe(join(homedir(), '.openszamla'));
    expect(defaultDataDir({ OPENSZAMLA_HOME: '~' })).toBe(homedir());
    expect(defaultDataDir({ OPENSZAMLA_HOME: '~\\Számlák 2026' })).toBe(join(homedir(), 'Számlák 2026'));
    expect(defaultDataDir({})).toBe(join(homedir(), '.openszamla'));
    expect(defaultDataDir({ OPENSZAMLA_HOME: '  ' })).toBe(join(homedir(), '.openszamla'));
  });

  it('expands ~ in OPENSZAMLA_DB and in an explicit data directory', () => {
    const c = loadConfig({ env: { OPENSZAMLA_DB: '~/x.db' }, dataDir: '~/osz-data', overrides: { nav: null } });
    expect(c.dataDir).toBe(join(homedir(), 'osz-data'));
    expect(c.dbPath).toBe(join(homedir(), 'x.db'));
    expect(c.pdfDir).toBe(join(homedir(), 'osz-data', 'pdf'));
  });

  it('refuses a variable the client did not expand instead of creating a database under the working directory', () => {
    for (const value of ['${OPENSZAMLA_HOME}', '${OPENSZAMLA_HOME:-~/.openszamla}', '${user_config.data_dir}', '$HOME/.openszamla', '%USERPROFILE%\\.openszamla', 'C:/${X}/a']) {
      expect(errorCode(() => loadConfig({ env: { OPENSZAMLA_HOME: value }, overrides: { nav: null } })), value).toBe('INVALID_CONFIG');
    }
    expect(errorCode(() => loadConfig({ dataDir: tempDir(), env: { OPENSZAMLA_DB: '${DB}' }, overrides: { nav: null } }))).toBe('INVALID_CONFIG');
    expect(errorCode(() => loadConfig({ dataDir: '${CLAUDE_PROJECT_DIR}/data', env: {}, overrides: { nav: null } }))).toBe('INVALID_CONFIG');
  });

  it('still resolves an ordinary relative path against the working directory, and reports it as relative', () => {
    expect(defaultDataDir({ OPENSZAMLA_HOME: 'adatok' })).toBe(resolve('adatok'));
    expect(isRelativeConfiguredPath('adatok')).toBe(true);
    expect(isRelativeConfiguredPath('./.tmp/dev-data')).toBe(true);
    expect(isRelativeConfiguredPath('~/.openszamla')).toBe(false);
    expect(isRelativeConfiguredPath(tmpdir())).toBe(false);
  });
});

describe('NAV settings', () => {
  it('an empty OPENSZAMLA_NAV_ENV (extension/plugin option left empty) keeps the environment chosen in nav-setup', () => {
    const dir = withCredentialsFile('production');
    expect(loadNavConfig(dir, {})).toMatchObject({ environment: 'production', source: 'file' });
    expect(loadNavConfig(dir, { OPENSZAMLA_NAV_ENV: '' })).toMatchObject({ environment: 'production', source: 'file' });
    expect(loadNavConfig(dir, { OPENSZAMLA_NAV_ENV: '  ' })).toMatchObject({ environment: 'production', source: 'file' });
  });

  it('a set OPENSZAMLA_NAV_ENV still overrides the file (documented precedence)', () => {
    const dir = withCredentialsFile('production');
    expect(loadNavConfig(dir, { OPENSZAMLA_NAV_ENV: 'test' })).toMatchObject({ environment: 'test', source: 'file' });
    expect(loadNavConfig(withCredentialsFile('test'), { OPENSZAMLA_NAV_ENV: 'éles' })).toMatchObject({ environment: 'production' });
  });

  it('unexpanded ${user_config.…} placeholders count as not set and fall back to the file', () => {
    const dir = withCredentialsFile('production');
    const nav = loadNavConfig(dir, {
      OPENSZAMLA_NAV_ENV: '${user_config.nav_env}',
      OPENSZAMLA_NAV_LOGIN: '${user_config.nav_login}',
      OPENSZAMLA_NAV_PASSWORD: '${user_config.nav_password}',
      OPENSZAMLA_NAV_SIGNING_KEY: '${user_config.nav_signing_key}',
      OPENSZAMLA_NAV_EXCHANGE_KEY: '${user_config.nav_exchange_key}',
      OPENSZAMLA_NAV_BASE_URL: '${user_config.base_url}',
    });
    expect(nav).toMatchObject({ environment: 'production', source: 'file', credentials: { login: 'prodlogin' } });
    expect(nav?.baseUrl).toBeUndefined();
    expect(loadNavConfig(tempDir(), { OPENSZAMLA_NAV_LOGIN: '${user_config.nav_login}', OPENSZAMLA_NAV_ENV: '' })).toBeNull();
  });

  it('credentials from the environment with an empty OPENSZAMLA_NAV_ENV use the test environment', () => {
    const nav = loadNavConfig(tempDir(), {
      OPENSZAMLA_NAV_ENV: '',
      OPENSZAMLA_NAV_LOGIN: 'envlogin',
      OPENSZAMLA_NAV_PASSWORD: 'pw',
      OPENSZAMLA_NAV_SIGNING_KEY: 'sign',
      OPENSZAMLA_NAV_EXCHANGE_KEY: 'exch',
    });
    expect(nav).toMatchObject({ environment: 'test', source: 'env', credentials: { login: 'envlogin' } });
    expect(errorCode(() => loadNavConfig(tempDir(), { OPENSZAMLA_NAV_LOGIN: 'envlogin', OPENSZAMLA_NAV_PASSWORD: '${user_config.nav_password}' }))).toBe('INVALID_CONFIG');
  });

  it('no setting redirects NAV reporting: OPENSZAMLA_NAV_BASE_URL is not read (DOC-2)', () => {
    const dir = withCredentialsFile('production');
    expect(loadNavConfig(dir, { OPENSZAMLA_NAV_BASE_URL: 'http://127.0.0.1:9/elsewhere' })?.baseUrl).toBeUndefined();
    const env = { OPENSZAMLA_NAV_LOGIN: 'envlogin', OPENSZAMLA_NAV_PASSWORD: 'pw', OPENSZAMLA_NAV_SIGNING_KEY: 'sign', OPENSZAMLA_NAV_EXCHANGE_KEY: 'cserekulcs123456', OPENSZAMLA_NAV_BASE_URL: 'http://127.0.0.1:9/elsewhere' };
    expect(loadConfig({ dataDir: tempDir(), env }).nav?.baseUrl).toBeUndefined();
  });

  it('checks the NAV settings when loading them and keeps the problem instead of failing later (BIZ-5)', () => {
    expect(loadConfig({ dataDir: withCredentialsFile('production'), env: {} }).navProblem).toBeNull();
    const badKey = loadConfig({ dataDir: tempDir(), env: { OPENSZAMLA_NAV_LOGIN: 'envlogin', OPENSZAMLA_NAV_PASSWORD: 'pw', OPENSZAMLA_NAV_SIGNING_KEY: 'sign', OPENSZAMLA_NAV_EXCHANGE_KEY: 'cserekulcs12345' } });
    expect(badKey.nav).not.toBeNull();
    expect(badKey.navProblem).toBe('A NAV technikai felhasználó adatai hibásak: az XML cserekulcs nem 16 karakteres.');
    const badSoftware = loadConfig({ dataDir: withCredentialsFile('test'), env: { OPENSZAMLA_SOFTWARE_ID: 'hu12345676-abc001' } });
    expect(badSoftware.navProblem).toMatch(/softwareId, OPENSZAMLA_SOFTWARE_ID/);
    // without NAV there is nothing to check
    expect(loadConfig({ dataDir: tempDir(), env: { OPENSZAMLA_SOFTWARE_ID: 'hu12345676-abc001' } }).navProblem).toBeNull();
    // settings passed in (overrides) are checked too
    const nav = { environment: 'test' as const, source: 'env' as const, credentials: { login: 'a.b', password: 'pw', signingKey: 'sign', exchangeKey: 'cserekulcs123456' } };
    expect(loadConfig({ dataDir: tempDir(), env: {}, overrides: { nav } }).navProblem).toMatch(/login név/);
  });

  it('other settings treat empty and placeholder values as not set', () => {
    const c = loadConfig({
      dataDir: tempDir(),
      env: {
        OPENSZAMLA_CONFIRM_MODE: '${user_config.confirm_mode}',
        OPENSZAMLA_SOFTWARE_ID: '${user_config.software_id}',
        OPENSZAMLA_NAV_WAIT_SECONDS: '',
        OPENSZAMLA_NAV_AUTO_SUBMIT: '${user_config.auto_submit}',
        OPENSZAMLA_ALLOW_FILE_COPY: '',
      },
      overrides: { nav: null },
    });
    expect(c.confirmMode).toBe('code');
    expect(c.software.softwareId).toBe('OPENSZAMLA-0000001');
    expect(c.navWaitSeconds).toBe(20);
    expect(c.navAutoSubmit).toBe(true);
    expect(c.allowFileCopy).toBe(true);
  });

  it('file copy: on by default, off by default for serve (fileCopyDefault: false) – the variable decides when set', () => {
    const copy = (env: Record<string, string>, fileCopyDefault?: boolean): boolean =>
      loadConfig({ dataDir: tempDir(), env, overrides: { nav: null }, ...(fileCopyDefault === undefined ? {} : { fileCopyDefault }) }).allowFileCopy;
    expect(copy({})).toBe(true);
    expect(copy({}, false)).toBe(false);
    expect(copy({ OPENSZAMLA_ALLOW_FILE_COPY: '' }, false)).toBe(false);
    expect(copy({ OPENSZAMLA_ALLOW_FILE_COPY: '${user_config.allow_file_copy}' }, false)).toBe(false);
    expect(copy({ OPENSZAMLA_ALLOW_FILE_COPY: '1' }, false)).toBe(true);
    expect(copy({ OPENSZAMLA_ALLOW_FILE_COPY: 'false' })).toBe(false);
  });
});
