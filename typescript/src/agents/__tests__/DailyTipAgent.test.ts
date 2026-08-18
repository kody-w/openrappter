import { describe, it, expect } from 'vitest';
import { DailyTipAgent } from '../DailyTipAgent.js';

/**
 * `day` arrives as an unchecked cast and must not be able to crash the agent.
 *
 * `perform` reads `kwargs.day as number | undefined`, so a caller can hand
 * `sendSpecificDay` a float or a string. Both slip past a bare range check —
 * `1.5` is inside 1..30, and comparing `"abc"` to a number is false in either
 * direction — and then index `TIPS` with a fraction or `NaN`. That yields
 * `undefined`, and reading `.title` off it threw:
 *
 *     TypeError: Cannot read properties of undefined (reading 'title')
 *
 * Reproduced against the built agent before the fix, for `1.5` and `"abc"`.
 * The function already had an error path for a bad day; the cast meant some bad
 * days reached the crash instead of the report.
 *
 * These are the agent's first behavioural tests. It was constructed by
 * `builtin-agents-load.test.ts` like every other built-in, which proves it
 * loads and says nothing about what it does.
 *
 * Every case here returns before any notification is sent, deliberately: this
 * agent's success path shells out to `terminal-notifier` or `osascript`, and a
 * test suite should not put desktop notifications on the machine running it.
 */
describe('DailyTipAgent day validation', () => {
  const agent = new DailyTipAgent();

  async function send(day: unknown): Promise<Record<string, unknown>> {
    const raw = await agent.perform({ action: 'send', day });
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('reports a fractional day instead of crashing', async () => {
    expect(await send(1.5)).toEqual({ status: 'error', message: 'Day must be 1-30' });
  });

  it('reports a non-numeric day instead of crashing', async () => {
    expect(await send('abc')).toEqual({ status: 'error', message: 'Day must be 1-30' });
    expect(await send({})).toEqual({ status: 'error', message: 'Day must be 1-30' });
  });

  it('still reports days outside the range', async () => {
    // The behaviour that already worked, pinned so the stricter check did not
    // quietly replace it.
    for (const day of [0, -1, 31, 999]) {
      expect(await send(day), `day ${day}`).toEqual({
        status: 'error',
        message: 'Day must be 1-30',
      });
    }
  });

  it('rejects NaN and Infinity', async () => {
    for (const day of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(await send(day), String(day)).toEqual({
        status: 'error',
        message: 'Day must be 1-30',
      });
    }
  });

  it('covers every day the range admits', async () => {
    // The range check and the table have to agree. If TIPS ever stops covering
    // 1..30, the null check added alongside this reports it rather than
    // throwing — but this is what would catch the mismatch first.
    const preview = JSON.parse(await agent.perform({ action: 'preview' })) as {
      tips?: { title: string }[];
    };
    expect(preview.tips?.length).toBe(30);
  });
});
