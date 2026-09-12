import { AgentRuntimeError } from "./types.js";

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new AgentRuntimeError("interrupted"));
    if (signal.aborted) {
      operation.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class Semaphore {
  private used = 0;
  private readonly waiters: {
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: Error) => void;
    abort: () => void;
  }[] = [];

  constructor(private readonly capacity: number) {}

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.used < this.capacity) { this.used++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal, resolve, reject,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new AgentRuntimeError("interrupted"));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else this.used--;
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.release();
    }
  }
}
