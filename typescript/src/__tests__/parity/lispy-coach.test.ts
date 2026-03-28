import { describe, it, expect, vi } from 'vitest';
import { LispyVM, STRATEGIES } from '../../tui/lispy.js';
import { LispyCoach } from '../../tui/lispy-coach.js';
import type { GameSituation } from '../../tui/lispy-coach.js';

function makeSituation(overrides: Partial<GameSituation> = {}): GameSituation {
  return {
    myScore: 2,
    opponentScore: 2,
    ballSpeed: 0.6,
    rallyLength: 5,
    currentStrategy: STRATEGIES.predictor,
    side: 'right',
    ...overrides,
  };
}

describe('LispyCoach', () => {
  describe('without LLM (fallback mode)', () => {
    it('uses predictor for close games', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      await coach.strategize(makeSituation({ myScore: 2, opponentScore: 2 }));
      expect(vm.getStrategy()).toContain('predict-y');
    });

    it('uses aggressive when losing badly', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      await coach.strategize(makeSituation({ myScore: 0, opponentScore: 3 }));
      expect(vm.getStrategy()).toContain('1.0'); // aggressive speed
    });

    it('uses lazy when winning comfortably', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      await coach.strategize(makeSituation({ myScore: 4, opponentScore: 1 }));
      expect(vm.getStrategy()).toContain('0.3'); // lazy drift speed
    });

    it('strategy count stays 0 without LLM', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      await coach.strategize(makeSituation());
      expect(coach.getStrategyCount()).toBe(0);
    });
  });

  describe('with LLM', () => {
    it('loads LLM-generated strategy into VM', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockResolvedValue('(move :down 0.9)');
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      expect(vm.getStrategy()).toBe('(move :down 0.9)');
      expect(coach.getStrategyCount()).toBe(1);
    });

    it('strips markdown fences from LLM output', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockResolvedValue('```lisp\n(move :up 0.7)\n```');
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      expect(vm.getStrategy()).toBe('(move :up 0.7)');
    });

    it('falls back when LLM returns garbage', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockResolvedValue('I think you should try being more aggressive');
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      // Should have fallen back to a preset
      expect(vm.getStrategy()).toContain('predict-y');
      expect(coach.getStrategyCount()).toBe(0);
    });

    it('falls back when LLM throws', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockRejectedValue(new Error('network down'));
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      expect(vm.getStrategy().length).toBeGreaterThan(0);
      expect(coach.getStrategyCount()).toBe(0);
    });

    it('extracts s-expression from noisy LLM output', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockResolvedValue(
        'Here is the strategy:\n\n(if (> ball-y paddle-center) (move :down 0.8) (move :up 0.8))\n\nThis should work well.'
      );
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      expect(vm.getStrategy()).toBe('(if (> ball-y paddle-center) (move :down 0.8) (move :up 0.8))');
    });

    it('rejects output with no move keyword', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const mockLLM = vi.fn().mockResolvedValue('(+ 1 2)');
      coach.setLLM(mockLLM);

      await coach.strategize(makeSituation());
      // No 'move' → rejected → fallback
      expect(vm.getStrategy()).toContain('predict-y');
    });
  });

  describe('shouldRestrategize', () => {
    it('returns true on first call', () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      expect(coach.shouldRestrategize(makeSituation())).toBe(true);
    });

    it('returns false when score unchanged', () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      const sit = makeSituation({ myScore: 3, opponentScore: 1 });
      coach.shouldRestrategize(sit);
      expect(coach.shouldRestrategize(sit)).toBe(false);
    });

    it('returns true when score changes', () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      coach.shouldRestrategize(makeSituation({ myScore: 3, opponentScore: 1 }));
      expect(coach.shouldRestrategize(makeSituation({ myScore: 3, opponentScore: 2 }))).toBe(true);
    });
  });

  describe('concurrent protection', () => {
    it('does not call LLM twice concurrently', async () => {
      const vm = new LispyVM();
      const coach = new LispyCoach(vm);
      let resolveFirst: (v: string) => void;
      const slow = new Promise<string>(r => { resolveFirst = r; });
      const mockLLM = vi.fn().mockReturnValueOnce(slow).mockResolvedValue('(move :up 0.5)');
      coach.setLLM(mockLLM);

      const p1 = coach.strategize(makeSituation());
      const p2 = coach.strategize(makeSituation()); // should be ignored

      resolveFirst!('(move :down 0.7)');
      await p1;
      await p2;

      expect(mockLLM).toHaveBeenCalledTimes(1);
    });
  });
});
