/**
 * Error type shared by every layer. `code` is stable and machine readable; `message` is a
 * human (Hungarian) explanation; `hint` tells the caller – often an AI agent – how to fix it.
 */
export class AppError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function notFound(entity: string, id: string): AppError {
  return new AppError('NOT_FOUND', `${entity} nem található: ${id}`, {
    hint: 'Ellenőrizd az azonosítót, vagy keresd meg a megfelelő listázó/kereső eszközzel.',
  });
}
