export type VoiceQueueErrorCode = 'queue_full' | 'cancelled';

export class VoiceQueueError extends Error {
  constructor(readonly code: VoiceQueueErrorCode) {
    super(code === 'queue_full'
      ? 'The voice queue is full.'
      : 'Voice generation was cancelled.');
    this.name = 'VoiceQueueError';
  }
}

interface QueueItem<T> {
  characters: number;
  work: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface VoiceOutputQueueOptions {
  maxQueued?: number;
  maxQueuedCharacters?: number;
}

export class VoiceOutputQueue {
  private readonly maxQueued: number;
  private readonly maxQueuedCharacters: number;
  private readonly pending: QueueItem<unknown>[] = [];
  private active: {
    controller: AbortController;
    item: QueueItem<unknown>;
  } | null = null;

  constructor(options: VoiceOutputQueueOptions = {}) {
    this.maxQueued = options.maxQueued ?? 2;
    this.maxQueuedCharacters = options.maxQueuedCharacters ?? 5_000;
  }

  enqueue<T>(
    characters: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const queuedCharacters = this.pending.reduce(
      (sum, item) => sum + item.characters,
      0,
    );
    if (
      this.pending.length >= this.maxQueued
      || queuedCharacters + characters > this.maxQueuedCharacters
    ) {
      return Promise.reject(new VoiceQueueError('queue_full'));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        characters,
        work,
        resolve,
        reject,
      } as QueueItem<unknown>);
      this.pump();
    });
  }

  cancelAll(): void {
    this.active?.controller.abort();
    for (const item of this.pending.splice(0)) {
      item.reject(new VoiceQueueError('cancelled'));
    }
  }

  getStatus(): { active: boolean; queued: number; queuedCharacters: number } {
    return {
      active: this.active !== null,
      queued: this.pending.length,
      queuedCharacters: this.pending.reduce(
        (sum, item) => sum + item.characters,
        0,
      ),
    };
  }

  private pump(): void {
    if (this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    const controller = new AbortController();
    this.active = { controller, item };
    void item.work(controller.signal).then(
      (result) => item.resolve(result),
      (error) => item.reject(error),
    ).finally(() => {
      if (this.active?.item === item) this.active = null;
      this.pump();
    });
  }
}
