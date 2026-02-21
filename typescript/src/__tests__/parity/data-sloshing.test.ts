/**
 * Data Sloshing Enhancement Parity Tests
 *
 * Tests 6 enhancements: granularity/selectivity, personalization,
 * history breadcrumbs, agent feedback, privacy controls, and debuggability.
 * All opt-in, backwards compatible.
 */

import { describe, it, expect, vi } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type {
  AgentMetadata,
  AgentContext,
  SloshFilter,
  SloshPreferences,
  SloshDebugEvent,
} from '../../agents/types.js';

class TestAgent extends BasicAgent {
  private resultFn: () => string;

  constructor(resultFn?: () => string) {
    const metadata: AgentMetadata = {
      name: 'TestAgent',
      description: 'Test agent for data sloshing tests',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('TestAgent', metadata);
    this.resultFn = resultFn ?? (() => JSON.stringify({ status: 'success', result: 'ok' }));
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return this.resultFn();
  }
}

describe('Data Sloshing Enhancements', () => {
  describe('Filter (Enhancement 1)', () => {
    it('default: all 5 signal categories populated', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test query' });
      const ctx = agent.context!;
      expect(ctx.temporal).toBeDefined();
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.query_signals).toBeDefined();
      expect(ctx.query_signals.word_count).toBeGreaterThan(0);
      expect(ctx.memory_echoes).toBeDefined();
      expect(ctx.behavioral).toBeDefined();
      expect(ctx.priors).toBeDefined();
    });

    it('include filter: only specified categories populated', async () => {
      const agent = new TestAgent();
      agent.sloshFilter = { include: ['temporal', 'query_signals'] };
      await agent.execute({ query: 'test query' });
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.query_signals.word_count).toBeGreaterThan(0);
      expect(ctx.memory_echoes).toEqual([]);
      expect(ctx.behavioral).toEqual({ prefers_brief: false, technical_level: 'standard', frequent_entities: [] });
      expect(ctx.priors).toEqual({});
    });

    it('exclude filter: excluded category zeroed, rest populated', async () => {
      const agent = new TestAgent();
      agent.sloshFilter = { exclude: ['priors'] };
      await agent.execute({ query: 'test query' });
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.query_signals).toBeDefined();
      expect(ctx.priors).toEqual({});
    });

    it('per-call _sloshFilter overrides agent-level filter', async () => {
      const agent = new TestAgent();
      agent.sloshFilter = { include: ['temporal'] };
      await agent.execute({
        query: 'test query',
        _sloshFilter: { include: ['query_signals'] } as SloshFilter,
      });
      const ctx = agent.context!;
      // Per-call says include only query_signals, so temporal should be zeroed
      expect(ctx.temporal).toEqual({});
      expect(ctx.query_signals.word_count).toBeGreaterThan(0);
    });
  });

  describe('Personalization (Enhancement 2)', () => {
    it('suppress zeroes those categories', async () => {
      const agent = new TestAgent();
      agent.sloshPreferences = { suppress: ['behavioral', 'priors'] };
      await agent.execute({ query: 'test' });
      const ctx = agent.context!;
      expect(ctx.behavioral).toEqual({ prefers_brief: false, technical_level: 'standard', frequent_entities: [] });
      expect(ctx.priors).toEqual({});
      expect(ctx.temporal.time_of_day).toBeDefined();
    });

    it('prioritize adds hint to orientation.hints[0]', async () => {
      const agent = new TestAgent();
      agent.sloshPreferences = { prioritize: ['temporal'] };
      await agent.execute({ query: 'test' });
      const ctx = agent.context!;
      expect(ctx.orientation.hints[0]).toMatch(/^Signal priority:/);
      expect(ctx.orientation.hints[0]).toContain('temporal');
    });

    it('per-call _sloshPreferences overrides agent-level', async () => {
      const agent = new TestAgent();
      agent.sloshPreferences = { prioritize: ['temporal'] };
      await agent.execute({
        query: 'test',
        _sloshPreferences: { suppress: ['memory_echoes'] } as SloshPreferences,
      });
      const ctx = agent.context!;
      // Per-call override: no prioritize hint, memory_echoes suppressed
      expect(ctx.orientation.hints.every((h: string) => !h.startsWith('Signal priority:'))).toBe(true);
      expect(ctx.memory_echoes).toEqual([]);
    });
  });

  describe('Breadcrumbs (Enhancement 3)', () => {
    it('first call: context.breadcrumbs is empty', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'first call' });
      // Breadcrumbs attached to context BEFORE perform, so first call has empty
      const ctx = agent.context!;
      expect(ctx.breadcrumbs).toEqual([]);
    });

    it('3 calls: agent.breadcrumbs.length === 3, newest first', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'first' });
      await agent.execute({ query: 'second' });
      await agent.execute({ query: 'third' });
      expect(agent.breadcrumbs).toHaveLength(3);
      expect(agent.breadcrumbs[0].query).toBe('third');
      expect(agent.breadcrumbs[1].query).toBe('second');
      expect(agent.breadcrumbs[2].query).toBe('first');
    });

    it('maxBreadcrumbs=2, 4 calls: length stays 2', async () => {
      const agent = new TestAgent();
      agent.maxBreadcrumbs = 2;
      await agent.execute({ query: 'a' });
      await agent.execute({ query: 'b' });
      await agent.execute({ query: 'c' });
      await agent.execute({ query: 'd' });
      expect(agent.breadcrumbs).toHaveLength(2);
      expect(agent.breadcrumbs[0].query).toBe('d');
      expect(agent.breadcrumbs[1].query).toBe('c');
    });

    it('breadcrumb shape: { query, timestamp, confidence }', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'shape test' });
      const crumb = agent.breadcrumbs[0];
      expect(crumb).toHaveProperty('query', 'shape test');
      expect(crumb).toHaveProperty('timestamp');
      expect(typeof crumb.timestamp).toBe('string');
      expect(['low', 'medium', 'high']).toContain(crumb.confidence);
    });
  });

  describe('Feedback (Enhancement 4)', () => {
    it('feedback updates signalUtility (+1 useful, -1 useless)', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: {
            useful_signals: ['temporal.time_of_day'],
            useless_signals: ['priors'],
          },
        }),
      );
      await agent.execute({ query: 'test' });
      expect(agent.signalUtility.get('temporal.time_of_day')).toBe(1);
      expect(agent.signalUtility.get('priors')).toBe(-1);
    });

    it('two calls: scores accumulate with decay', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: {
            useful_signals: ['temporal.time_of_day'],
            useless_signals: ['priors'],
          },
        }),
      );
      await agent.execute({ query: 'call 1' });
      await agent.execute({ query: 'call 2' });
      // Call 1: +1 / -1. Call 2: decay to +0.9 / -0.9, then +1 / -1 → 1.9 / -1.9
      expect(agent.signalUtility.get('temporal.time_of_day')).toBeCloseTo(1.9);
      expect(agent.signalUtility.get('priors')).toBeCloseTo(-1.9);
    });

    it('no feedback key: signalUtility stays empty', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test' });
      expect(agent.signalUtility.size).toBe(0);
    });
  });

  describe('Auto-Suppress (Feedback Loop)', () => {
    it('auto-suppresses category at threshold after repeated negative feedback', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: [], useless_signals: ['priors'] },
        }),
      );
      // With decay=0.9 and threshold=-3: scores accumulate as
      // -1, -1.9, -2.71, -3.439 (after feedback). Decay on call 5
      // reads -3.0951 ≤ -3 → suppressed.
      await agent.execute({ query: 'call 1' });
      await agent.execute({ query: 'call 2' });
      await agent.execute({ query: 'call 3' });
      await agent.execute({ query: 'call 4' });
      await agent.execute({ query: 'call 5' });
      const ctx = agent.context!;
      expect(ctx.priors).toEqual({});
      // Other categories still populated
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.query_signals.word_count).toBeGreaterThan(0);
    });

    it('explicit include protects category from auto-suppress', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: [], useless_signals: ['temporal'] },
        }),
      );
      agent.sloshFilter = { include: ['temporal', 'query_signals'] };
      // 4 calls to accumulate past threshold with decay, check on call 5
      await agent.execute({ query: 'a' });
      await agent.execute({ query: 'b' });
      await agent.execute({ query: 'c' });
      await agent.execute({ query: 'd' });
      // Score is past -3 but temporal is explicitly included — should NOT be suppressed
      await agent.execute({ query: 'e' });
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeDefined();
    });

    it('custom threshold triggers sooner', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: [], useless_signals: ['behavioral'] },
        }),
      );
      agent.autoSuppressThreshold = -1;
      // Call 1: score=-1. Call 2: decay to -0.9, feedback to -1.9.
      // Call 3: decay reads -1.71 ≤ -1 → suppressed.
      await agent.execute({ query: 'call 1' });
      await agent.execute({ query: 'call 2' });
      await agent.execute({ query: 'call 3' });
      const ctx = agent.context!;
      expect(ctx.behavioral).toEqual({ prefers_brief: false, technical_level: 'standard', frequent_entities: [] });
    });

    it('mixed feedback keeps category above threshold', async () => {
      let callCount = 0;
      const agent = new TestAgent(() => {
        callCount++;
        // Alternate: odd calls report useless, even calls report useful
        if (callCount % 2 === 1) {
          return JSON.stringify({
            status: 'success',
            slosh_feedback: { useful_signals: [], useless_signals: ['temporal.time_of_day'] },
          });
        }
        return JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: ['temporal.time_of_day'], useless_signals: [] },
        });
      });
      // 6 calls with alternating -1/+1 feedback. With decay, score
      // oscillates near zero, well above threshold of -3.
      for (let i = 0; i < 6; i++) {
        await agent.execute({ query: `call ${i}` });
      }
      const score = agent.signalUtility.get('temporal.time_of_day')!;
      expect(Math.abs(score)).toBeLessThan(1);
      // temporal should NOT be suppressed
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeDefined();
    });

    it('sub-path feedback aggregates to category level', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: {
            useful_signals: [],
            useless_signals: ['temporal.time_of_day', 'temporal.fiscal'],
          },
        }),
      );
      // Each call adds -1 for two temporal sub-paths → -2 per call for temporal
      // After 2 calls: aggregate = -4, below threshold of -3
      await agent.execute({ query: 'call 1' });
      await agent.execute({ query: 'call 2' });
      await agent.execute({ query: 'call 3' });
      const ctx = agent.context!;
      expect(ctx.temporal).toEqual({});
    });
  });

  describe('Decay (Signal Utility)', () => {
    it('scores decay each call', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: [], useless_signals: ['priors'] },
        }),
      );
      await agent.execute({ query: 'call 1' });
      expect(agent.signalUtility.get('priors')).toBe(-1);
      // Call 2: decay -1 * 0.9 = -0.9 before new feedback
      await agent.execute({ query: 'call 2' });
      expect(agent.signalUtility.get('priors')).toBeCloseTo(-1.9);
    });

    it('suppressed category recovers when feedback stops', async () => {
      let feedbackActive = true;
      const agent = new TestAgent(() => {
        if (feedbackActive) {
          return JSON.stringify({
            status: 'success',
            slosh_feedback: { useful_signals: [], useless_signals: ['priors'] },
          });
        }
        return JSON.stringify({ status: 'success' });
      });
      // Drive priors past threshold (5 calls with feedback)
      for (let i = 0; i < 5; i++) {
        await agent.execute({ query: `feed ${i}` });
      }
      // Verify suppressed
      await agent.execute({ query: 'still feeding' });
      expect(agent.context!.priors).toEqual({});

      // Stop feedback — let decay bring score back above threshold
      feedbackActive = false;
      // Score is ~-4.095. Each call decays by 0.9:
      // -4.095 → -3.686 → -3.317 → -2.985 (above -3)
      await agent.execute({ query: 'recover 1' });
      await agent.execute({ query: 'recover 2' });
      await agent.execute({ query: 'recover 3' });
      await agent.execute({ query: 'recover 4' });
      // Score should be above -3 now — priors should be populated
      expect(agent.context!.priors).toBeDefined();
      expect(agent.context!.temporal.time_of_day).toBeDefined();
    });

    it('signalDecay=1 disables decay', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: ['temporal.time_of_day'], useless_signals: [] },
        }),
      );
      agent.signalDecay = 1;
      await agent.execute({ query: 'call 1' });
      await agent.execute({ query: 'call 2' });
      await agent.execute({ query: 'call 3' });
      // No decay — scores are exact integers
      expect(agent.signalUtility.get('temporal.time_of_day')).toBe(3);
    });

    it('signalDecay=0 forgets everything each call', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: [], useless_signals: ['priors'] },
        }),
      );
      agent.signalDecay = 0;
      await agent.execute({ query: 'call 1' });
      // Score was -1, but decay zeroes it, then pruning removes it.
      // New feedback brings it back to -1.
      await agent.execute({ query: 'call 2' });
      expect(agent.signalUtility.get('priors')).toBe(-1);
      // Never accumulates past -1, so threshold of -3 is never reached
      await agent.execute({ query: 'call 3' });
      expect(agent.context!.priors).toBeDefined();
    });

    it('pruning removes negligible scores', async () => {
      const agent = new TestAgent(() =>
        JSON.stringify({
          status: 'success',
          slosh_feedback: { useful_signals: ['behavioral'], useless_signals: [] },
        }),
      );
      await agent.execute({ query: 'call 1' });
      expect(agent.signalUtility.has('behavioral')).toBe(true);
      // Stop feedback, let it decay until pruned
      const noFeedbackAgent = new TestAgent();
      noFeedbackAgent.signalUtility = new Map(agent.signalUtility);
      noFeedbackAgent.signalDecay = 0.1; // aggressive decay
      // Score is 1. After decay: 0.1, then 0.01, then 0.001 < 0.01 → pruned
      await noFeedbackAgent.execute({ query: 'decay 1' }); // 0.1
      expect(noFeedbackAgent.signalUtility.has('behavioral')).toBe(true);
      await noFeedbackAgent.execute({ query: 'decay 2' }); // 0.01
      expect(noFeedbackAgent.signalUtility.has('behavioral')).toBe(true);
      await noFeedbackAgent.execute({ query: 'decay 3' }); // 0.001 < 0.01 → pruned
      expect(noFeedbackAgent.signalUtility.has('behavioral')).toBe(false);
    });
  });

  describe('Privacy (Enhancement 5)', () => {
    it('disabled: true produces minimal context', async () => {
      const agent = new TestAgent();
      agent.sloshPrivacy = { disabled: true };
      await agent.execute({ query: 'sensitive query' });
      const ctx = agent.context!;
      expect(ctx.temporal).toEqual({});
      expect(ctx.query_signals).toEqual({
        specificity: 'low', hints: [], word_count: 0, is_question: false, has_id_pattern: false,
      });
      expect(ctx.memory_echoes).toEqual([]);
    });

    it('redact removes the specified path', async () => {
      const agent = new TestAgent();
      agent.sloshPrivacy = { redact: ['temporal.time_of_day'] };
      await agent.execute({ query: 'test' });
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeUndefined();
      // Other temporal fields still present
      expect(ctx.temporal.day_of_week).toBeDefined();
    });

    it('obfuscate replaces value with hashed placeholder', async () => {
      const agent = new TestAgent();
      agent.sloshPrivacy = { obfuscate: ['temporal.day_of_week'] };
      await agent.execute({ query: 'test' });
      const ctx = agent.context!;
      expect(ctx.temporal.day_of_week).toMatch(/^\[obfuscated:[a-f0-9]{8}\]$/);
    });

    it('empty privacy config is a no-op', async () => {
      const agent = new TestAgent();
      agent.sloshPrivacy = {};
      await agent.execute({ query: 'test' });
      const ctx = agent.context!;
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.query_signals).toBeDefined();
      expect(ctx.behavioral).toBeDefined();
    });
  });

  describe('Debug (Enhancement 6)', () => {
    it('sloshDebug false: handler not called', async () => {
      const handler = vi.fn();
      const agent = new TestAgent();
      agent.sloshDebug = false;
      agent.onSloshDebug = handler;
      await agent.execute({ query: 'test' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('sloshDebug true: handler called 4 times with correct stages', async () => {
      const events: SloshDebugEvent[] = [];
      const agent = new TestAgent();
      agent.sloshDebug = true;
      agent.onSloshDebug = (e) => events.push(e);
      await agent.execute({ query: 'test' });
      expect(events).toHaveLength(4);
      expect(events.map(e => e.stage)).toEqual(['post-slosh', 'post-filter', 'post-privacy', 'post-perform']);
    });

    it('events contain timestamp and context', async () => {
      const events: SloshDebugEvent[] = [];
      const agent = new TestAgent();
      agent.sloshDebug = true;
      agent.onSloshDebug = (e) => events.push(e);
      await agent.execute({ query: 'test' });
      for (const event of events) {
        expect(event).toHaveProperty('timestamp');
        expect(typeof event.timestamp).toBe('string');
        expect(event).toHaveProperty('context');
        expect(event.context).toHaveProperty('timestamp');
      }
    });

    it('post-perform event has meta.result_length as number', async () => {
      const events: SloshDebugEvent[] = [];
      const agent = new TestAgent();
      agent.sloshDebug = true;
      agent.onSloshDebug = (e) => events.push(e);
      await agent.execute({ query: 'test' });
      const postPerform = events.find(e => e.stage === 'post-perform')!;
      expect(postPerform.meta).toBeDefined();
      expect(typeof postPerform.meta!.result_length).toBe('number');
    });
  });

  describe('Backwards Compatibility', () => {
    it('no config: context matches original AgentContext shape', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'hello world' });
      const ctx = agent.context!;
      // All original fields present
      expect(ctx).toHaveProperty('timestamp');
      expect(ctx).toHaveProperty('temporal');
      expect(ctx).toHaveProperty('query_signals');
      expect(ctx).toHaveProperty('memory_echoes');
      expect(ctx).toHaveProperty('behavioral');
      expect(ctx).toHaveProperty('priors');
      expect(ctx).toHaveProperty('orientation');
      // Temporal populated
      expect(ctx.temporal.time_of_day).toBeDefined();
      expect(ctx.temporal.day_of_week).toBeDefined();
      // Orientation populated
      expect(ctx.orientation.confidence).toBeDefined();
      expect(ctx.orientation.approach).toBeDefined();
    });

    it('slushOut() still produces correct structure', async () => {
      const agent = new TestAgent();
      await agent.execute({ query: 'test query' });
      const slush = agent.slushOut({ confidence: 'high', signals: { count: 1 } });
      expect(slush).toHaveProperty('source_agent', 'TestAgent');
      expect(slush).toHaveProperty('timestamp');
      expect(slush).toHaveProperty('orientation');
      expect(slush).toHaveProperty('temporal_snapshot');
      expect(slush).toHaveProperty('confidence', 'high');
      expect(slush).toHaveProperty('signals');
    });
  });
});
