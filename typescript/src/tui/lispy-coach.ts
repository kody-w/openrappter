/**
 * LispyCoach — LLM generates lispy strategies at runtime.
 *
 * The coach asks the LLM to write a pong strategy as a lispy s-expression
 * based on the current game situation. The strategy is parsed once and
 * executed by the VM at 60fps until the coach decides to re-strategize.
 *
 * Flow:
 *   Game state → Coach.strategize() → LLM writes s-expression → VM.setStrategy()
 *   Then: VM.tick() runs at 60fps with zero latency until next re-strategize
 *
 * The coach re-strategizes when:
 *   - Game starts (initial strategy)
 *   - Score changes (adapt to opponent)
 *   - Every N seconds (periodic refresh)
 *
 * Falls back to preset strategies if the LLM is unavailable or returns garbage.
 */

import type { LispyVM } from './lispy.js';
import { STRATEGIES } from './lispy.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface GameSituation {
  myScore: number;
  opponentScore: number;
  ballSpeed: number;
  rallyLength: number;
  currentStrategy: string;
  side: 'left' | 'right';
}

export interface LLMCaller {
  (prompt: string): Promise<string>;
}

// ── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a pong AI coach. Write a lispy s-expression strategy for a pong paddle.

Available variables (all numbers, updated every frame):
  ball-x, ball-y         — ball position
  ball-vx, ball-vy       — ball velocity
  paddle-y               — this paddle's top Y
  paddle-center          — this paddle's center Y
  paddle-x               — this paddle's X position
  opponent-y             — opponent paddle top Y
  field-w, field-h       — field dimensions
  paddle-h               — paddle height

Available functions:
  (move :up speed)       — move paddle up at given speed (0.0-1.0)
  (move :down speed)     — move paddle down
  (move :none 0)         — stay still
  (predict-y target-x ball-x ball-y ball-vx ball-vy field-h) — predict ball Y at target X
  (if cond then else)    — conditional
  (let ((var val) ...) body) — local variables
  (cond (test1 val1) (test2 val2) (else default)) — multi-branch
  (> < >= <= = != + - * / abs min max clamp) — math and comparison
  (and a b) (or a b) (not a) — logic

Rules:
- Return ONLY the s-expression. No explanation, no markdown, no comments.
- The expression must return a (move ...) action.
- Keep it simple — this runs 60 times per second.
- Use predict-y for anticipation. Use let for clarity.`;

// ── Coach ───────────────────────────────────────────────────────────────────

export class LispyCoach {
  private vm: LispyVM;
  private llmCall: LLMCaller | null = null;
  private lastScore = '';
  private generating = false;
  private strategyCount = 0;

  constructor(vm: LispyVM) {
    this.vm = vm;
  }

  /** Wire up an LLM caller. Without this, coach uses preset strategies. */
  setLLM(caller: LLMCaller): void {
    this.llmCall = caller;
  }

  /** Ask the LLM to generate a strategy for the current game situation. */
  async strategize(situation: GameSituation): Promise<string> {
    if (this.generating) return this.vm.getStrategy();
    if (!this.llmCall) return this.fallback(situation);

    this.generating = true;
    try {
      const prompt = this.buildPrompt(situation);
      const raw = await this.llmCall(prompt);
      const strategy = this.extractStrategy(raw);

      if (strategy) {
        this.vm.setStrategy(strategy);
        this.strategyCount++;
        return strategy;
      }
      // LLM returned garbage — fall back
      return this.fallback(situation);
    } catch {
      return this.fallback(situation);
    } finally {
      this.generating = false;
    }
  }

  /** Check if we should re-strategize based on game state changes. */
  shouldRestrategize(situation: GameSituation): boolean {
    const scoreKey = `${situation.myScore}-${situation.opponentScore}`;
    if (scoreKey !== this.lastScore) {
      this.lastScore = scoreKey;
      return true;
    }
    return false;
  }

  /** How many LLM-generated strategies have been loaded. */
  getStrategyCount(): number {
    return this.strategyCount;
  }

  private buildPrompt(situation: GameSituation): string {
    const { myScore, opponentScore, ballSpeed, side, currentStrategy } = situation;
    const losing = opponentScore > myScore;
    const winning = myScore > opponentScore;

    let context = `Score: me ${myScore} - ${opponentScore} opponent. Ball speed: ${ballSpeed.toFixed(1)}. I'm the ${side} paddle.`;

    if (losing && opponentScore - myScore >= 2) {
      context += ' I\'m losing badly — be more aggressive, predict where the ball will go.';
    } else if (winning && myScore - opponentScore >= 2) {
      context += ' I\'m winning comfortably — play conservatively, hold center when ball is away.';
    } else {
      context += ' Close game — play smart, use prediction.';
    }

    if (currentStrategy) {
      context += `\n\nCurrent strategy (improve on this):\n${currentStrategy.trim()}`;
    }

    return `${SYSTEM_PROMPT}\n\n${context}\n\nWrite the strategy:`;
  }

  /** Extract a valid s-expression from LLM output. */
  private extractStrategy(raw: string): string | null {
    // Strip markdown code fences if present
    let s = raw.trim();
    s = s.replace(/^```\w*\n?/gm, '').replace(/\n?```$/gm, '').trim();

    // Must start with ( and end with )
    const start = s.indexOf('(');
    if (start === -1) return null;

    // Find the matching closing paren
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') depth--;
      if (depth === 0) { end = i; break; }
    }
    if (end === -1) return null;

    const expr = s.slice(start, end + 1);

    // Sanity check: must contain 'move'
    if (!expr.includes('move')) return null;

    return expr;
  }

  /** Pick a preset strategy based on game situation. */
  private fallback(situation: GameSituation): string {
    const { myScore, opponentScore } = situation;
    let strategy: string;

    if (opponentScore - myScore >= 2) {
      strategy = STRATEGIES.aggressive;
    } else if (myScore - opponentScore >= 2) {
      strategy = STRATEGIES.lazy;
    } else {
      strategy = STRATEGIES.predictor;
    }

    this.vm.setStrategy(strategy);
    return strategy;
  }
}
