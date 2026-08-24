import { describe, expect, it } from 'vitest';
import { VoiceOutputQueue } from './output-queue.js';

describe('VoiceOutputQueue', () => {
  it('serializes synthesis so output never overlaps', async () => {
    let active = 0;
    let maximum = 0;
    const queue = new VoiceOutputQueue({ maxQueued: 2, maxQueuedCharacters: 100 });
    const work = async (_signal: AbortSignal) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return 'done';
    };
    await Promise.all([
      queue.enqueue(5, work),
      queue.enqueue(5, work),
      queue.enqueue(5, work),
    ]);
    expect(maximum).toBe(1);
  });

  it('bounds queued requests and queued cost before doing provider work', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const queue = new VoiceOutputQueue({ maxQueued: 1, maxQueuedCharacters: 8 });
    const first = queue.enqueue(5, async () => {
      await blocker;
      return 'one';
    });
    const second = queue.enqueue(3, async () => 'two');
    await expect(queue.enqueue(1, async () => 'three')).rejects.toMatchObject({
      code: 'queue_full',
    });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['one', 'two']);
  });

  it('cancels active and pending work without starting another request', async () => {
    let started = 0;
    const queue = new VoiceOutputQueue({ maxQueued: 2, maxQueuedCharacters: 100 });
    const first = queue.enqueue(3, (signal) => new Promise<string>((_resolve, reject) => {
      started += 1;
      signal.addEventListener('abort', () => reject(
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
      ));
    }));
    const second = queue.enqueue(3, async () => {
      started += 1;
      return 'should not run';
    });
    await Promise.resolve();
    queue.cancelAll();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(started).toBe(1);
  });
});
