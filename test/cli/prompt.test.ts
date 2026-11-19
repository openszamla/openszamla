/** Interactive questions of `openszamla init` / `nav-setup`: no echo for secrets, piped answers. */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter } from '../../src/cli/prompt.ts';

/** A stand-in terminal: input with isTTY (readline switches it to raw mode) and the text shown on screen. */
function fakeTerminal(): { input: PassThrough & { isTTY?: boolean }; screen: () => string; output: Writable } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  input.isTTY = true;
  input.setRawMode = () => input;
  let shown = '';
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      shown += chunk.toString();
      cb();
    },
  });
  return { input, output, screen: () => shown.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}

/** Types the text key by key, then Enter. */
function type(input: PassThrough, text: string): void {
  for (const ch of text) input.write(ch);
  input.write('\r');
}

describe('createPrompter on a terminal', () => {
  it('echoes ordinary answers but not secrets', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const login = p.ask('Felhasználónév (login)');
    type(t.input, 'tesztelek');
    expect(await login).toBe('tesztelek');
    const password = p.askSecret('Jelszó');
    type(t.input, 'Titkos-Jelszo-123');
    expect(await password).toBe('Titkos-Jelszo-123');
    const key = p.askSecret('XML cserekulcs');
    type(t.input, 'CSEREKULCS123456');
    expect(await key).toBe('CSEREKULCS123456');
    p.close();
    const screen = t.screen();
    expect(screen).toContain('Felhasználónév (login)');
    expect(screen).toContain('tesztelek'); // the harness does see echoed text
    expect(screen).toContain('Jelszó (a beírt szöveg nem jelenik meg)');
    expect(screen).toContain('XML cserekulcs');
    expect(screen).not.toContain('Titkos');
    expect(screen).not.toContain('CSEREKULCS');
  });

  it('gives the default for an empty answer', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const env = p.ask('Környezet (test / production)', 'test');
    type(t.input, '');
    expect(await env).toBe('test');
    expect(t.screen()).toContain('Környezet (test / production) [test]: ');
    p.close();
  });

  it('Ctrl+C cancels with an AppError instead of hanging', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const password = p.askSecret('Jelszó');
    t.input.write('abc');
    t.input.write('\u0003');
    await expect(password).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.screen()).not.toContain('abc');
  });
});

describe('createPrompter with piped input', () => {
  it('keeps answers that arrive before their question (no lost lines)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter(input, output);
    input.end('production\r\ntesztelek\nTitkos-Jelszo-123\n');
    expect(await p.ask('Környezet', 'test')).toBe('production');
    expect(await p.ask('Felhasználónév')).toBe('tesztelek');
    expect(await p.askSecret('Jelszó')).toBe('Titkos-Jelszo-123');
    await expect(p.ask('XML aláírókulcs')).rejects.toMatchObject({ code: 'INPUT_ENDED' });
    p.close();
  });
});
