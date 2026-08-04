/**
 * `predict-y` reflects a predicted ball position back inside the field.
 *
 * It used to do that with a loop that folded the value across each edge until
 * it landed in range, and that loop could not always finish. At a field height
 * of 1 the two folds undo one another and the value oscillates forever; at 0 or
 * less, or a fractional height, it diverges — measured with a bounded copy, a
 * height of 0 walked the value to -200005 in 100,000 iterations and kept going.
 *
 * `field-h` arrives as an ordinary argument from a lispy program, so a script
 * could spin the process with a single call.
 */
import { describe, it, expect } from 'vitest';
import { LispyVM } from './lispy.js';

/** Surface predict-y's value through the one output the VM exposes. */
function predictY(state: Record<string, number>): number {
  const vm = new LispyVM();
  vm.setStrategy('(move :down (predict-y paddle-x ball-x ball-y ball-vx ball-vy field-h))');
  return vm.tick(state).speed;
}

function state(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    'paddle-x': 68, 'ball-x': 0, 'ball-y': 5,
    'ball-vx': 1, 'ball-vy': 0, 'field-h': 16,
    ...overrides,
  };
}

describe('predict-y termination', () => {
  it.each([
    ['a field height of 1, where the two folds cancel', 1],
    ['a field height of 0', 0],
    ['a negative field height', -2],
    ['a fractional field height below 1', 0.5],
  ])('returns instead of spinning with %s', (_label, fieldHeight) => {
    // Reaching the assertion at all is the point: this call did not return.
    const result = predictY(state({ 'field-h': fieldHeight, 'ball-vy': 0.3 }));
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(0);
  });
});

describe('predict-y reflection', () => {
  it('leaves a position already inside the field alone', () => {
    expect(predictY(state({ 'ball-y': 5, 'ball-vy': 0 }))).toBe(5);
  });

  it('reflects a position below the floor back up', () => {
    // ball-y 5, vy -1 over 8 ticks lands at -3, which reflects to 3.
    expect(predictY(state({ 'ball-x': 60, 'ball-y': 5, 'ball-vy': -1 }))).toBe(3);
  });

  it('reflects a position past the ceiling back down', () => {
    // Lands at 25 in a field of height 16, reflecting to 2 * 15 - 25 = 5.
    expect(predictY(state({ 'ball-x': 48, 'ball-y': 5, 'ball-vy': 1 }))).toBe(5);
  });

  it('folds repeatedly for a position several field-heights away', () => {
    // The old loop needed many iterations here; the closed form does not.
    const result = predictY(state({ 'ball-x': 0, 'ball-y': 5, 'ball-vy': 7 }));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(15);
  });

  it('always lands within [0, field-h - 1]', () => {
    for (const vy of [-9.5, -4, -1, 0, 0.3, 2, 6, 13.25]) {
      const result = predictY(state({ 'ball-vy': vy }));
      expect(result, `vy ${vy}`).toBeGreaterThanOrEqual(0);
      expect(result, `vy ${vy}`).toBeLessThanOrEqual(15);
    }
  });

  it('returns the current position when the ball is moving away', () => {
    expect(predictY(state({ 'ball-x': 70, 'ball-vx': 1, 'ball-y': 9 }))).toBe(9);
  });

  it('returns the current position when the ball has no horizontal motion', () => {
    expect(predictY(state({ 'ball-vx': 0, 'ball-y': 11 }))).toBe(11);
  });
});
