import { describe, expect, it, vi } from 'vitest';
import { watchOwnerProcess } from './owner-watch.js';

describe('desktop owner watcher', () => {
  it('runs cleanup once when the owner disappears', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const isAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const cancel = watchOwnerProcess(12345, cleanup, {
      intervalMs: 100,
      isAlive,
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(cleanup).toHaveBeenCalledTimes(1);
    cancel();
    vi.useRealTimers();
  });
});
