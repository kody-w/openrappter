/**
 * The Bar's frame publisher — the producer half of `zen.*`.
 *
 * Its job is to keep a 30fps screen inside a gateway connection's frame
 * budget without ever letting a slow gateway build a backlog of stale
 * screens. These tests pin the drop rules, because "publish every frame and
 * hope" is exactly what the gateway's rate limiter would reject.
 */
import { describe, it, expect, vi } from 'vitest';
import { createZenPublisher } from '../../tui/zen-publisher.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('zen publisher', () => {
  it('publishes a frame with the session identity the viewer lists', async () => {
    const call = vi.fn().mockResolvedValue({ published: true });
    const publisher = createZenPublisher({
      call,
      sessionId: 'bar-pong',
      name: 'Pong — You vs AI',
      now: () => 0,
    });

    publisher.publish('ANSI');
    await flush();

    expect(call).toHaveBeenCalledWith('zen.publish', {
      sessionId: 'bar-pong',
      name: 'Pong — You vs AI',
      frame: 'ANSI',
    });
    expect(publisher.stats.published).toBe(1);
  });

  it('drops frames rendered faster than the minimum interval', async () => {
    const call = vi.fn().mockResolvedValue({});
    let clock = 0;
    const publisher = createZenPublisher({
      call,
      sessionId: 's',
      name: 'n',
      minIntervalMs: 100,
      now: () => clock,
    });

    publisher.publish('f1');
    await flush();
    clock = 50;
    publisher.publish('f2');
    await flush();
    clock = 150;
    publisher.publish('f3');
    await flush();

    expect(call.mock.calls.map((c) => (c[1] as { frame: string }).frame)).toEqual(['f1', 'f3']);
    expect(publisher.stats.dropped).toBe(1);
  });

  it('never queues behind a publish that has not answered yet', async () => {
    const gate = deferred();
    const call = vi.fn().mockReturnValue(gate.promise);
    let clock = 0;
    const publisher = createZenPublisher({
      call,
      sessionId: 's',
      name: 'n',
      minIntervalMs: 0,
      now: () => clock,
    });

    publisher.publish('f1');
    clock = 1000;
    publisher.publish('f2');
    clock = 2000;
    publisher.publish('f3');
    await flush();

    // A stalled gateway must cost dropped frames, not an unbounded backlog.
    expect(call).toHaveBeenCalledTimes(1);
    expect(publisher.stats.dropped).toBe(2);

    gate.resolve();
    await flush();
    clock = 3000;
    publisher.publish('f4');
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('stops publishing to a gateway that keeps refusing, instead of once per frame', async () => {
    const call = vi.fn().mockRejectedValue(new Error('Method not found: zen.publish'));
    let clock = 0;
    const publisher = createZenPublisher({
      call,
      sessionId: 's',
      name: 'n',
      minIntervalMs: 0,
      maxConsecutiveFailures: 3,
      now: () => clock,
    });

    for (let i = 0; i < 10; i++) {
      clock += 100;
      publisher.publish(`f${i}`);
      await flush();
    }

    expect(call).toHaveBeenCalledTimes(3);
    expect(publisher.stats.disabled).toBe(true);
    expect(publisher.stats.lastError).toMatch(/Method not found/);
  });

  it('ends only a session it actually started', async () => {
    const call = vi.fn().mockResolvedValue({});
    const publisher = createZenPublisher({ call, sessionId: 'bar-pong', name: 'n', now: () => 0 });

    await publisher.end();
    expect(call).not.toHaveBeenCalled();

    publisher.publish('f1');
    await flush();
    await publisher.end();

    expect(call).toHaveBeenLastCalledWith('zen.end', { sessionId: 'bar-pong' });
  });
});
