/**
 * Interactive questions of the command line: `init` and `nav-setup` write them to stderr so stdout stays
 * free for command output; `setup` writes its whole dialogue to stdout.
 *
 * - Secrets (NAV password and keys) are read without echo when the input is a terminal: readline
 *   would otherwise print every typed character, leaving the secret on screen and in the scrollback.
 * - Answers can also be piped (one per line): lines that arrive before the question is asked are
 *   queued, not dropped.
 * - On a terminal nothing typed is echoed while no question is on the screen (type-ahead, e.g. a pasted
 *   batch of answers or keys pressed while the program works): an ordinary answer typed ahead is shown
 *   after its question when that is asked, and a secret question first discards the pending input – a
 *   secret is only taken from what is typed after its own question, so it is never echoed.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { AppError } from '../core/errors.ts';

/** Passes writes through to the real output, except while a secret is being typed. */
class MutableOutput extends Writable {
  muted = false;
  private readonly target: NodeJS.WritableStream;

  constructor(target: NodeJS.WritableStream) {
    super();
    this.target = target;
  }

  /** Terminal width for readline's line editing. */
  get columns(): number | undefined {
    return (this.target as { columns?: number }).columns;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}

export interface Prompter {
  /** Asks a question; an empty answer gives `dflt` (shown in brackets). */
  ask(question: string, dflt?: string): Promise<string>;
  /** Asks for a secret: on a terminal the typed characters are not shown. */
  askSecret(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(input: NodeJS.ReadableStream & { isTTY?: boolean }, output: NodeJS.WritableStream): Prompter {
  const out = new MutableOutput(output);
  // On a terminal readline (in raw mode) does the echoing – so it can be muted. Without terminal mode
  // the terminal driver itself would echo the secret.
  const terminal = input.isTTY === true;
  const rl = createInterface({ input, output: out, terminal, historySize: 0 });
  // No question on the screen yet: what is typed is not echoed (it is shown with the question that takes it).
  out.muted = terminal;
  /** Writes to the screen whether or not readline's echo is muted. */
  const show = (text: string): void => {
    output.write(text);
  };
  const queued: string[] = [];
  let ended = false;
  /** Ctrl+C was pressed: every later question is cancelled too (setup asks several in a row). */
  let cancelled = false;
  let waiting: { resolve: (line: string) => void; reject: (e: AppError) => void } | null = null;
  const endError = (): AppError =>
    cancelled ? new AppError('CANCELLED', 'Megszakítva (Ctrl+C) – semmi nem lett mentve.') : new AppError('INPUT_ENDED', 'A bemenet véget ért, mielőtt minden kérdésre válasz érkezett.');

  const settle = (fn: (w: NonNullable<typeof waiting>) => void): void => {
    const w = waiting;
    waiting = null;
    if (w) fn(w);
  };
  rl.on('line', (line) => {
    // Answered: the rest of a pasted batch – processed right now – and whatever is typed until the next question
    // is not echoed.
    if (terminal) out.muted = true;
    if (waiting) settle((w) => w.resolve(line));
    else queued.push(line);
  });
  rl.on('close', () => {
    ended = true;
    settle((w) => w.reject(endError()));
  });
  rl.on('SIGINT', () => {
    out.muted = false;
    out.write('\n');
    cancelled = true;
    settle((w) => w.reject(endError()));
    rl.close();
  });

  const nextLine = (): Promise<string> => {
    const line = cancelled ? undefined : queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(endError());
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };

  return {
    async ask(question, dflt) {
      const prompt = dflt ? `${question} [${dflt}]: ` : `${question}: `;
      rl.setPrompt(prompt);
      if (terminal && !cancelled && queued.length > 0) {
        // Typed ahead (not echoed then): shown after its question now.
        const line = queued.shift() as string;
        show(`${prompt}${line}\n`);
        return line.trim() || dflt || '';
      }
      out.muted = false;
      rl.prompt();
      const answer = (await nextLine()).trim();
      return answer || dflt || '';
    },
    async askSecret(question) {
      if (!terminal) {
        rl.setPrompt(`${question}: `);
        rl.prompt();
        return (await nextLine()).trim();
      }
      // Pending input typed before this question – lines sent and a line begun – is discarded, unseen: the secret is
      // what is typed after the question, without echo.
      const pending = !cancelled && (queued.length > 0 || rl.line.length > 0);
      out.muted = true;
      if (pending) {
        queued.length = 0;
        if (!ended) {
          // The line begun: to its end, then deleted (Ctrl+E, Ctrl+U) – muted, so nothing is drawn.
          rl.write(null, { ctrl: true, name: 'e' });
          rl.write(null, { ctrl: true, name: 'u' });
        }
        show('(A kérdés előtt beírt szöveget a program elvetette – a titkos adatot a kérdés után írd be.)\n');
      }
      show(`${question} (a beírt szöveg nem jelenik meg): `);
      rl.setPrompt('');
      rl.prompt();
      try {
        return (await nextLine()).trim();
      } finally {
        if (!cancelled) show('\n');
      }
    },
    close() {
      rl.close();
    },
  };
}
