import { Refusal } from './errors.js';

export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new Refusal('observation-ended', 'The bounded observation ended; no late outcome may be committed.'));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(new Refusal('observation-ended', 'The bounded observation ended; no late outcome may be committed.'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
