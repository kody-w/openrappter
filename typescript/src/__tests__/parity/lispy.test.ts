import { describe, it, expect } from 'vitest';
import { LispyVM, STRATEGIES } from '../../tui/lispy.js';
import type { LispAction } from '../../tui/lispy.js';

// ── Helper ──────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    'ball-x': 35,
    'ball-y': 10,
    'ball-vx': 0.5,
    'ball-vy': 0.3,
    'paddle-y': 8,
    'paddle-center': 10,
    'paddle-x': 68,
    'opponent-y': 8,
    'field-w': 70,
    'field-h': 16,
    'paddle-h': 4,
    ...overrides,
  };
}

describe('LispyVM', () => {
  // ── Basics ──────────────────────────────────────────────────────────────

  describe('basics', () => {
    it('returns no-op when no strategy is set', () => {
      const vm = new LispyVM();
      const action = vm.tick(makeState());
      expect(action.direction).toBe('none');
      expect(action.speed).toBe(0);
    });

    it('getStrategy returns the loaded source', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up 1)');
      expect(vm.getStrategy()).toBe('(move :up 1)');
    });

    it('evaluates a simple move up', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up 0.7)');
      const action = vm.tick(makeState());
      expect(action.direction).toBe('up');
      expect(action.speed).toBeCloseTo(0.7);
    });

    it('evaluates a simple move down', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :down 1.0)');
      const action = vm.tick(makeState());
      expect(action.direction).toBe('down');
      expect(action.speed).toBeCloseTo(1.0);
    });

    it('move :none returns none direction', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :none 0)');
      const action = vm.tick(makeState());
      expect(action.direction).toBe('none');
    });
  });

  // ── Arithmetic ──────────────────────────────────────────────────────────

  describe('arithmetic', () => {
    it('adds numbers', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (+ 0.3 0.4))');
      const action = vm.tick(makeState());
      expect(action.speed).toBeCloseTo(0.7);
    });

    it('subtracts numbers', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (- 1.0 0.3))');
      const action = vm.tick(makeState());
      expect(action.speed).toBeCloseTo(0.7);
    });

    it('multiplies numbers', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (* 0.5 2))');
      const action = vm.tick(makeState());
      expect(action.speed).toBeCloseTo(1.0);
    });

    it('divides numbers (safe div by zero)', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (/ 1.0 0))');
      const action = vm.tick(makeState());
      expect(action.speed).toBe(0); // safe default
    });

    it('abs works', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (abs -0.8))');
      const action = vm.tick(makeState());
      expect(action.speed).toBeCloseTo(0.8);
    });

    it('min and max work', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (min 0.9 0.3))');
      expect(vm.tick(makeState()).speed).toBeCloseTo(0.3);
      vm.setStrategy('(move :up (max 0.9 0.3))');
      expect(vm.tick(makeState()).speed).toBeCloseTo(0.9);
    });
  });

  // ── Comparisons and branching ───────────────────────────────────────────

  describe('branching', () => {
    it('if true branch', () => {
      const vm = new LispyVM();
      vm.setStrategy('(if (> 5 3) (move :up 1) (move :down 1))');
      expect(vm.tick(makeState()).direction).toBe('up');
    });

    it('if false branch', () => {
      const vm = new LispyVM();
      vm.setStrategy('(if (< 5 3) (move :up 1) (move :down 1))');
      expect(vm.tick(makeState()).direction).toBe('down');
    });

    it('cond selects correct clause', () => {
      const vm = new LispyVM();
      vm.setStrategy(`
        (cond
          ((> 1 5) (move :up 1))
          ((> 5 1) (move :down 0.5))
          (else (move :none 0)))
      `);
      const action = vm.tick(makeState());
      expect(action.direction).toBe('down');
      expect(action.speed).toBeCloseTo(0.5);
    });

    it('cond falls through to else', () => {
      const vm = new LispyVM();
      vm.setStrategy(`
        (cond
          ((> 1 5) (move :up 1))
          ((> 2 5) (move :down 1))
          (else (move :none 0)))
      `);
      expect(vm.tick(makeState()).direction).toBe('none');
    });

    it('and/or/not logic', () => {
      const vm = new LispyVM();
      vm.setStrategy('(if (and (> 5 3) (< 2 4)) (move :up 1) (move :down 1))');
      expect(vm.tick(makeState()).direction).toBe('up');

      vm.setStrategy('(if (or (> 1 3) (< 2 4)) (move :up 1) (move :down 1))');
      expect(vm.tick(makeState()).direction).toBe('up');

      vm.setStrategy('(if (not (> 5 3)) (move :up 1) (move :down 1))');
      expect(vm.tick(makeState()).direction).toBe('down');
    });
  });

  // ── Variables and let bindings ──────────────────────────────────────────

  describe('variables', () => {
    it('reads game state variables', () => {
      const vm = new LispyVM();
      vm.setStrategy('(if (> ball-y paddle-center) (move :down 1) (move :up 1))');

      // ball-y=10, paddle-center=10 → not greater → up
      expect(vm.tick(makeState({ 'ball-y': 10, 'paddle-center': 10 })).direction).toBe('up');

      // ball-y=12, paddle-center=10 → greater → down
      expect(vm.tick(makeState({ 'ball-y': 12, 'paddle-center': 10 })).direction).toBe('down');
    });

    it('let creates local bindings', () => {
      const vm = new LispyVM();
      vm.setStrategy(`
        (let ((diff (- ball-y paddle-center)))
          (if (> diff 0) (move :down 0.8) (move :up 0.8)))
      `);
      expect(vm.tick(makeState({ 'ball-y': 12, 'paddle-center': 10 })).direction).toBe('down');
      expect(vm.tick(makeState({ 'ball-y': 8, 'paddle-center': 10 })).direction).toBe('up');
    });

    it('unknown variables default to 0', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up unknown-var)');
      expect(vm.tick(makeState()).speed).toBe(0);
    });
  });

  // ── predict-y ─────────────────────────────────────────────────────────

  describe('predict-y', () => {
    it('predicts straight trajectory', () => {
      const vm = new LispyVM();
      // Ball at (35,8) moving right at vx=0.5, vy=0 → target at x=68 → y stays 8
      vm.setStrategy('(move :up (predict-y 68 35 8 0.5 0 16))');
      const action = vm.tick({});
      expect(action.speed).toBeCloseTo(8, 0);
    });

    it('returns ball-y when ball going away', () => {
      const vm = new LispyVM();
      // Ball moving left (vx=-0.5), target is to the right → should return ball-y
      vm.setStrategy('(move :up (predict-y 68 35 8 -0.5 0 16))');
      const action = vm.tick({});
      expect(action.speed).toBeCloseTo(8, 0);
    });
  });

  // ── Preset strategies ─────────────────────────────────────────────────

  describe('preset strategies', () => {
    it('tracker: moves toward ball', () => {
      const vm = new LispyVM();
      vm.setStrategy(STRATEGIES.tracker);

      // Ball above paddle → move up
      const up = vm.tick(makeState({ 'ball-y': 5, 'paddle-center': 10 }));
      expect(up.direction).toBe('up');

      // Ball below paddle → move down
      const down = vm.tick(makeState({ 'ball-y': 14, 'paddle-center': 10 }));
      expect(down.direction).toBe('down');
    });

    it('predictor: uses predict-y and has dead zone', () => {
      const vm = new LispyVM();
      vm.setStrategy(STRATEGIES.predictor);

      // Ball heading toward paddle (vx > 0), far from center → should move
      const action = vm.tick(makeState({ 'ball-y': 2, 'ball-vx': 0.5, 'paddle-center': 10 }));
      expect(action.direction).toBe('up');
    });

    it('predictor: stays still in dead zone', () => {
      const vm = new LispyVM();
      vm.setStrategy(STRATEGIES.predictor);

      // Ball very close to paddle center → should not move
      const action = vm.tick(makeState({
        'ball-y': 10, 'ball-vx': 0.5, 'ball-vy': 0,
        'paddle-center': 10, 'paddle-x': 68,
        'ball-x': 60,
      }));
      expect(action.direction).toBe('none');
    });

    it('lazy: only reacts when ball approaches', () => {
      const vm = new LispyVM();
      vm.setStrategy(STRATEGIES.lazy);

      // Ball going away (vx > 0 means going right, but for left paddle vx < 0 means approaching)
      // lazy checks ball-vx < 0 to decide if ball is coming
      const away = vm.tick(makeState({ 'ball-vx': 0.5, 'ball-y': 2, 'paddle-center': 10 }));
      // Ball going right → lazy drifts to center, doesn't chase
      expect(['up', 'down', 'none']).toContain(away.direction);

      // Ball coming toward us (vx < 0) and far away → should react
      const coming = vm.tick(makeState({ 'ball-vx': -0.5, 'ball-y': 2, 'paddle-center': 10 }));
      expect(coming.direction).toBe('up');
    });

    it('aggressive: fast tracking', () => {
      const vm = new LispyVM();
      vm.setStrategy(STRATEGIES.aggressive);

      const action = vm.tick(makeState({ 'ball-y': 2, 'ball-vx': 0.5, 'paddle-center': 10 }));
      expect(action.direction).toBe('up');
      expect(action.speed).toBeCloseTo(1.0);
    });

    it('all strategies return valid LispAction', () => {
      const vm = new LispyVM();
      const state = makeState();

      for (const [name, source] of Object.entries(STRATEGIES)) {
        vm.setStrategy(source);
        const action = vm.tick(state);
        expect(action).toHaveProperty('direction');
        expect(action).toHaveProperty('speed');
        expect(['up', 'down', 'none']).toContain(action.direction);
        expect(typeof action.speed).toBe('number');
      }
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty expression', () => {
      const vm = new LispyVM();
      vm.setStrategy('');
      const action = vm.tick(makeState());
      expect(action.direction).toBe('none');
    });

    it('handles comments', () => {
      const vm = new LispyVM();
      vm.setStrategy('; this is a comment\n(move :down 0.5)');
      expect(vm.tick(makeState()).direction).toBe('down');
    });

    it('handles nested expressions', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up (+ (* 0.5 0.5) (abs (- 0 0.5))))');
      // 0.5*0.5 = 0.25, abs(0-0.5) = 0.5, total = 0.75
      expect(vm.tick(makeState()).speed).toBeCloseTo(0.75);
    });

    it('strategy can be hot-swapped', () => {
      const vm = new LispyVM();
      vm.setStrategy('(move :up 1)');
      expect(vm.tick(makeState()).direction).toBe('up');

      vm.setStrategy('(move :down 1)');
      expect(vm.tick(makeState()).direction).toBe('down');
    });

    it('do/begin evaluates sequentially, returns last', () => {
      const vm = new LispyVM();
      vm.setStrategy('(do (move :up 1) (move :down 0.5))');
      const action = vm.tick(makeState());
      expect(action.direction).toBe('down');
      expect(action.speed).toBeCloseTo(0.5);
    });
  });
});
