import { MAX_REPLAY_NONCES } from './types.js';
import type { ReplayCache } from './types.js';

export class BoundedReplayCache implements ReplayCache {
  private readonly nonces = new Map<string, true>();

  constructor(
    private readonly limit = MAX_REPLAY_NONCES,
    initial: readonly string[] = [],
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('replay cache limit must be a positive integer');
    }
    for (const nonce of initial) this.add(nonce);
  }

  has(nonce: string): boolean {
    return this.nonces.has(nonce);
  }

  add(nonce: string): void {
    if (this.nonces.has(nonce)) this.nonces.delete(nonce);
    this.nonces.set(nonce, true);
    while (this.nonces.size > this.limit) {
      const oldest = this.nonces.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.nonces.delete(oldest);
    }
  }

  values(): string[] {
    return [...this.nonces.keys()];
  }
}
