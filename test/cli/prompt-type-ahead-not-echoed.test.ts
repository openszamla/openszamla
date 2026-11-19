/**
 * TA: on a terminal, keys typed ahead – a pasted batch of answers, or typing while the program works – are not echoed
 * while no question is on the screen. An ordinary answer typed ahead is shown after its question once that is asked;
 * before a secret question (NAV password, keys) the pending input is discarded, so a secret typed ahead is never shown
 * and never taken: the secret is what is typed after its own question, without echo. Piped input is unchanged.
 */
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

/** Lets the input written so far be read. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const DISCARDED = '(A kérdés előtt beírt szöveget a program elvetette – a titkos adatot a kérdés után írd be.)';

describe('type-ahead on a terminal (TA)', () => {
  it('a secret pasted together with the answer before it is not echoed, not taken, and asked for again', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const login = p.ask('Felhasználónév (login)');
    t.input.write('tesztelek\rElore-Begepelt-Titok\r');
    await settle();
    expect(await login).toBe('tesztelek');
    expect(t.screen()).not.toContain('Elore-Begepelt-Titok');
    const password = p.askSecret('Jelszó');
    await settle();
    expect(t.screen()).toContain(DISCARDED);
    for (const ch of 'Kesobbi-Titok-123') t.input.write(ch);
    t.input.write('\r');
    expect(await password).toBe('Kesobbi-Titok-123');
    p.close();
    const screen = t.screen();
    expect(screen).toContain('Felhasználónév (login): tesztelek');
    expect(screen).toContain('Jelszó (a beírt szöveg nem jelenik meg): ');
    expect(screen).not.toContain('Elore-Begepelt-Titok');
    expect(screen).not.toContain('Kesobbi-Titok-123');
  });

  it('a secret begun before its question (no Enter yet) is discarded unseen', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const env = p.ask('Környezet (test / production)', 'test');
    t.input.write('\r');
    expect(await env).toBe('test');
    t.input.write('Felig-Begepelt');
    await settle();
    const key = p.askSecret('XML cserekulcs');
    for (const ch of 'CSEREKULCS123456') t.input.write(ch);
    t.input.write('\r');
    expect(await key).toBe('CSEREKULCS123456');
    p.close();
    expect(t.screen()).toContain(DISCARDED);
    expect(t.screen()).not.toContain('Felig-Begepelt');
    expect(t.screen()).not.toContain('CSEREKULCS123456');
  });

  it('ordinary answers typed ahead are not echoed while no question is shown, then appear after their question', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    // Typed before the program asks anything (e.g. while it opens the database).
    t.input.write('Teszt Kft.\r12345676-2-42\r');
    await settle();
    expect(t.screen()).not.toContain('Teszt Kft.');
    expect(await p.ask('Cégnév')).toBe('Teszt Kft.');
    expect(await p.ask('Adószám')).toBe('12345676-2-42');
    // Nothing typed ahead: the question waits, and the answer is echoed as it is typed.
    const city = p.ask('Település');
    for (const ch of 'Budapest') t.input.write(ch);
    t.input.write('\r');
    expect(await city).toBe('Budapest');
    p.close();
    const screen = t.screen();
    expect(screen).toContain('Cégnév: Teszt Kft.\n');
    expect(screen).toContain('Adószám: 12345676-2-42\n');
    expect(screen).toContain('Település: Budapest');
    expect(screen.indexOf('Teszt Kft.')).toBeGreaterThan(screen.indexOf('Cégnév'));
    expect(screen).not.toContain(DISCARDED);
  });

  it('without type-ahead a secret question says nothing about discarded input', async () => {
    const t = fakeTerminal();
    const p = createPrompter(t.input, t.output);
    const secret = p.askSecret('Jelszó');
    for (const ch of 'Titkos-Jelszo-123') t.input.write(ch);
    t.input.write('\r');
    expect(await secret).toBe('Titkos-Jelszo-123');
    p.close();
    expect(t.screen()).not.toContain(DISCARDED);
    expect(t.screen()).not.toContain('Titkos');
  });

  it('piped input (not a terminal) keeps every answer, secrets included', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter(input, output);
    input.end('tesztelek\nTitkos-Jelszo-123\n');
    expect(await p.ask('Felhasználónév')).toBe('tesztelek');
    expect(await p.askSecret('Jelszó')).toBe('Titkos-Jelszo-123');
    p.close();
  });
});
