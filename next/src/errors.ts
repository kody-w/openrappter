export class Refusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new Refusal(code, message);
}

export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof Refusal
    ? { code: error.code, message: error.message }
    : { code: 'unavailable', message: 'The operation did not complete; no automatic retry or fallback was attempted.' };
}
