/**
 * Showcase: Data Sloshing Deep Dive
 *
 * Tests the full data sloshing pipeline: signal categories, SloshFilter,
 * SloshPrivacy, debug handler, feedback loop, breadcrumbs, and getSignal().
 */

import { describe, it, expect } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, SloshDebugEvent } from '../../agents/types.js';

// ── Inline agent that captures context in perform() ──

class SloshTestAgent extends BasicAgent {
  capturedContext: Record<string, unknown> | null = null;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'SloshTest',
      description: 'Captures slosh context for inspection',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('SloshTest', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.capturedContext = kwargs._context as Record<string, unknown>;
    const feedback = kwargs.feedback as { useful_signals?: string[]; useless_signals?: string[] } | undefined;
    return JSON.stringify({
      status: 'success',
      context_keys: this.capturedContext ? Object.keys(this.capturedContext) : [],
      data_slush: { source_agent: 'SloshTest', captured: true },
      ...(feedback ? { slosh_feedback: feedback } : {}),
    });
  }
}

describe('Showcase: Data Sloshing Deep Dive', () => {
  describe('Default slosh populates all signal categories', () => {
    it('should populate temporal, query_signals, memory_echoes, behavioral, priors', async () => {
      const agent = new SloshTestAgent();
      await agent.execute({ query: 'test query' });

      expect(agent.context).toBeTruthy();
      expect(agent.context!.temporal).toBeDefined();
      expect(agent.context!.query_signals).toBeDefined();
      expect(agent.context!.memory_echoes).toBeDefined();
      expect(agent.context!.behavioral).toBeDefined();
      expect(agent.context!.priors).toBeDefined();
      expect(agent.context!.orientation).toBeDefined();
    });
  });

  describe('SloshFilter include', () => {
    it('should only populate specified categories', async () => {
      const agent = new SloshTestAgent();
      agent.sloshFilter = { include: ['temporal', 'query_signals'] };

      await agent.execute({ query: 'filtered test' });

      // Included categories should have real data
      expect(agent.context!.temporal.time_of_day).toBeTruthy();
      expect(agent.context!.query_signals.word_count).toBeGreaterThan(0);

      // Excluded categories should be zeroed
      expect(agent.context!.memory_echoes).toEqual([]);
      expect(agent.context!.behavioral.technical_level).toBe('standard');
      expect(agent.context!.priors).toEqual({});
    });
  });

  describe('SloshFilter exclude', () => {
    it('should zero specified categories', async () => {
      const agent = new SloshTestAgent();
      agent.sloshFilter = { exclude: ['temporal', 'priors'] };

      await agent.execute({ query: 'exclude test' });

      // Excluded categories should be zeroed
      expect(agent.context!.temporal).toEqual({});
      expect(agent.context!.priors).toEqual({});

      // Other categories should be populated
      expect(agent.context!.query_signals.word_count).toBeGreaterThan(0);
    });
  });

  describe('SloshPrivacy redact', () => {
    it('should delete redacted field paths', async () => {
      const agent = new SloshTestAgent();
      agent.sloshPrivacy = { redact: ['temporal.time_of_day', 'behavioral.technical_level'] };

      await agent.execute({ query: 'privacy test' });

      // Redacted fields should be deleted
      expect(agent.context!.temporal.time_of_day).toBeUndefined();
      expect(agent.context!.behavioral.technical_level).toBeUndefined();

      // Non-redacted fields should remain
      expect(agent.context!.temporal.day_of_week).toBeTruthy();
    });
  });

  describe('SloshPrivacy obfuscate', () => {
    it('should replace with [obfuscated:hash]', async () => {
      const agent = new SloshTestAgent();
      agent.sloshPrivacy = { obfuscate: ['temporal.day_of_week'] };

      await agent.execute({ query: 'obfuscate test' });

      const dayValue = agent.context!.temporal.day_of_week;
      expect(dayValue).toMatch(/^\[obfuscated:[a-f0-9]+\]$/);
    });
  });

  describe('SloshDebug captures 4 stages', () => {
    it('should emit post-slosh, post-filter, post-privacy, post-perform events', async () => {
      const agent = new SloshTestAgent();
      agent.sloshDebug = true;
      agent.sloshFilter = { include: ['temporal'] };
      agent.sloshPrivacy = { redact: ['temporal.fiscal'] };

      const events: SloshDebugEvent[] = [];
      agent.onSloshDebug = (event) => events.push(event);

      await agent.execute({ query: 'debug test' });

      const stages = events.map(e => e.stage);
      expect(stages).toContain('post-slosh');
      expect(stages).toContain('post-filter');
      expect(stages).toContain('post-privacy');
      expect(stages).toContain('post-perform');
      expect(events.length).toBe(4);
    });
  });

  describe('Signal feedback loop', () => {
    it('should accumulate utility scores and auto-suppress at threshold', async () => {
      const agent = new SloshTestAgent();
      agent.autoSuppressThreshold = -2;
      agent.signalDecay = 1; // disable decay for test

      // Push negative feedback for temporal 3 times to cross threshold
      for (let i = 0; i < 3; i++) {
        await agent.execute({
          query: 'feedback test',
          feedback: { useful_signals: [], useless_signals: ['temporal.time_of_day'] },
        });
      }

      // temporal should have accumulated -3, which is <= -2 threshold
      const score = agent.signalUtility.get('temporal.time_of_day');
      expect(score).toBeLessThanOrEqual(-2);

      // Next execution should auto-suppress temporal
      await agent.execute({ query: 'after suppression' });
      // After auto-suppress, temporal should be zeroed
      expect(agent.context!.temporal).toEqual({});
    });
  });

  describe('getSignal() dot-notation and breadcrumbs', () => {
    it('should resolve dot-notation paths with defaults', async () => {
      const agent = new SloshTestAgent();
      await agent.execute({ query: 'signal test' });

      const timeOfDay = agent.getSignal<string>('temporal.time_of_day');
      expect(timeOfDay).toBeTruthy();

      const missing = agent.getSignal<string>('nonexistent.path', 'fallback');
      expect(missing).toBe('fallback');
    });

    it('should accumulate breadcrumbs LIFO up to maxBreadcrumbs', async () => {
      const agent = new SloshTestAgent();
      agent.maxBreadcrumbs = 3;

      await agent.execute({ query: 'first' });
      await agent.execute({ query: 'second' });
      await agent.execute({ query: 'third' });
      await agent.execute({ query: 'fourth' });

      expect(agent.breadcrumbs.length).toBe(3);
      // LIFO: most recent first
      expect(agent.breadcrumbs[0].query).toBe('fourth');
      expect(agent.breadcrumbs[1].query).toBe('third');
      expect(agent.breadcrumbs[2].query).toBe('second');
    });
  });
});
