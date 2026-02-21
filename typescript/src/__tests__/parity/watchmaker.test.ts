/**
 * WatchmakerAgent Parity Tests
 *
 * Tests the self-evolving agent ecosystem manager that evaluates agent
 * capabilities, A/B tests competing versions, and promotes winners.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WatchmakerAgent } from '../../agents/WatchmakerAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

// --- Mock agents ---

class MockStrongAgent extends BasicAgent {
  constructor(name = 'StrongAgent') {
    super(name, {
      name,
      description: 'Always succeeds with data_slush',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      result: 'strong response',
      data_slush: { source_agent: this.name, quality: 100 },
    });
  }
}

class MockWeakAgent extends BasicAgent {
  constructor(name = 'WeakAgent') {
    super(name, {
      name,
      description: 'Always returns error status',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'error',
      message: 'weak agent failed',
    });
  }
}

class MockCrashAgent extends BasicAgent {
  constructor(name = 'CrashAgent') {
    super(name, {
      name,
      description: 'Always throws',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    throw new Error('crash agent exploded');
  }
}

class MockSlowAgent extends BasicAgent {
  constructor(name = 'SlowAgent') {
    super(name, {
      name,
      description: 'Adds 50ms delay then succeeds',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.stringify({
      status: 'success',
      result: 'slow response',
      data_slush: { source_agent: this.name },
    });
  }
}

// --- Helpers ---

function registerStrong(agent: WatchmakerAgent, version = '1.0', name = 'TestAgent'): void {
  agent.perform({
    action: 'register',
    agent: name,
    version,
    agentInstance: new MockStrongAgent(name),
  });
}

function registerWeak(agent: WatchmakerAgent, version = '2.0', name = 'TestAgent'): void {
  agent.perform({
    action: 'register',
    agent: name,
    version,
    agentInstance: new MockWeakAgent(name),
  });
}

// --- Tests ---

describe('WatchmakerAgent', () => {
  let watchmaker: WatchmakerAgent;

  beforeEach(() => {
    watchmaker = new WatchmakerAgent();
  });

  describe('Constructor', () => {
    it('should have correct metadata name', () => {
      expect(watchmaker.name).toBe('Watchmaker');
      expect(watchmaker.metadata.name).toBe('Watchmaker');
    });

    it('should have a description', () => {
      expect(watchmaker.metadata.description).toBeDefined();
      expect(watchmaker.metadata.description.length).toBeGreaterThan(0);
    });

    it('should have parameters schema with all 7 actions in enum', () => {
      expect(watchmaker.metadata.parameters.type).toBe('object');
      expect(watchmaker.metadata.parameters.properties.action).toBeDefined();
      expect(watchmaker.metadata.parameters.properties.action.enum).toEqual([
        'evaluate', 'compare', 'register', 'promote', 'cycle', 'status', 'history',
      ]);
    });

    it('should extend BasicAgent', () => {
      expect(watchmaker).toBeInstanceOf(BasicAgent);
    });

    it('should have all expected parameter properties', () => {
      const props = watchmaker.metadata.parameters.properties;
      expect(props.action).toBeDefined();
      expect(props.agent).toBeDefined();
      expect(props.version).toBeDefined();
      expect(props.versionA).toBeDefined();
      expect(props.versionB).toBeDefined();
      expect(props.testCases).toBeDefined();
      expect(props.reason).toBeDefined();
    });
  });

  describe('No action / unknown action', () => {
    it('should return error when no action specified', async () => {
      const result = await watchmaker.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('No action specified');
    });

    it('should return error for unknown action', async () => {
      const result = await watchmaker.perform({ action: 'unknown' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Unknown action');
    });
  });

  describe('register action', () => {
    it('should create slot with version as active', async () => {
      const result = await watchmaker.perform({
        action: 'register',
        agent: 'MyAgent',
        version: '1.0',
        agentInstance: new MockStrongAgent('MyAgent'),
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('register');
      expect(parsed.agent).toBe('MyAgent');
      expect(parsed.version).toBe('1.0');
      expect(parsed.role).toBe('active');
    });

    it('should add second version as candidate', async () => {
      await watchmaker.perform({
        action: 'register',
        agent: 'MyAgent',
        version: '1.0',
        agentInstance: new MockStrongAgent('MyAgent'),
      });
      const result = await watchmaker.perform({
        action: 'register',
        agent: 'MyAgent',
        version: '2.0',
        agentInstance: new MockWeakAgent('MyAgent'),
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.role).toBe('candidate');
    });

    it('should prevent duplicate version', async () => {
      await watchmaker.perform({
        action: 'register',
        agent: 'MyAgent',
        version: '1.0',
        agentInstance: new MockStrongAgent('MyAgent'),
      });
      const result = await watchmaker.perform({
        action: 'register',
        agent: 'MyAgent',
        version: '1.0',
        agentInstance: new MockStrongAgent('MyAgent'),
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('already registered');
    });

    it('should require agent, version, and agentInstance', async () => {
      const result = await watchmaker.perform({ action: 'register', agent: 'MyAgent' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('required');
    });
  });

  describe('evaluate action', () => {
    it('should score strong agent with quality 100 and status strong', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.evaluation.quality).toBe(100);
      expect(parsed.evaluation.status).toBe('strong');
      expect(parsed.evaluation.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    });

    it('should score weak agent lower with status_matches failing', async () => {
      registerWeak(watchmaker, '1.0');

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.evaluation.quality).toBeLessThan(100);
      const statusCheck = parsed.evaluation.checks.find(
        (c: { name: string }) => c.name === 'status_matches',
      );
      expect(statusCheck.passed).toBe(false);
    });

    it('should handle crash agent without throwing', async () => {
      await watchmaker.perform({
        action: 'register',
        agent: 'CrashAgent',
        version: '1.0',
        agentInstance: new MockCrashAgent(),
      });

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'CrashAgent',
        testCases: [{ input: { query: 'test' } }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.evaluation.quality).toBe(0);
      const errorCheck = parsed.evaluation.checks.find(
        (c: { name: string }) => c.name === 'executes_without_error',
      );
      expect(errorCheck.passed).toBe(false);
    });

    it('should record evaluation in history', async () => {
      registerStrong(watchmaker);

      await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
      });

      const historyResult = await watchmaker.perform({
        action: 'history',
        agent: 'TestAgent',
      });
      const historyParsed = JSON.parse(historyResult);

      expect(historyParsed.evaluationCount).toBe(1);
      expect(historyParsed.evaluations[0].agentName).toBe('TestAgent');
    });

    it('should work with no testCases provided (default)', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.evaluation.checks.length).toBeGreaterThan(0);
    });

    it('should include data_slush with source_agent, quality, and eval_status', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.source_agent).toBe('Watchmaker');
      expect(parsed.data_slush.signals.quality).toBeDefined();
      expect(parsed.data_slush.signals.eval_status).toBeDefined();
    });

    it('should return error without agent name', async () => {
      const result = await watchmaker.perform({ action: 'evaluate' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('required');
    });

    it('should return error for unknown agent', async () => {
      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'nonexistent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should check has_data_slush', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
        testCases: [{ input: { query: 'test' } }],
      });
      const parsed = JSON.parse(result);

      const slushCheck = parsed.evaluation.checks.find(
        (c: { name: string }) => c.name === 'has_data_slush',
      );
      expect(slushCheck).toBeDefined();
      expect(slushCheck.passed).toBe(true);
    });

    it('should check expectedFields', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
        testCases: [{ input: { query: 'test' }, expectedFields: ['result', 'nonexistent'] }],
      });
      const parsed = JSON.parse(result);

      const resultField = parsed.evaluation.checks.find(
        (c: { name: string }) => c.name === 'has_field_result',
      );
      expect(resultField.passed).toBe(true);

      const missingField = parsed.evaluation.checks.find(
        (c: { name: string }) => c.name === 'has_field_nonexistent',
      );
      expect(missingField.passed).toBe(false);
    });
  });

  describe('compare action', () => {
    it('should declare strong agent wins over weak agent (A wins)', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'compare',
        agent: 'TestAgent',
        versionA: '1.0',
        versionB: '2.0',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.comparison.winner).toBe('A');
      expect(parsed.comparison.qualityDelta).toBeLessThan(0);
    });

    it('should declare B wins when B is stronger', async () => {
      registerWeak(watchmaker, '1.0');
      registerStrong(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'compare',
        agent: 'TestAgent',
        versionA: '1.0',
        versionB: '2.0',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.comparison.winner).toBe('B');
      expect(parsed.comparison.qualityDelta).toBeGreaterThan(0);
    });

    it('should tie when agents are equal', async () => {
      registerStrong(watchmaker, '1.0');
      // Register a second strong agent as candidate
      await watchmaker.perform({
        action: 'register',
        agent: 'TestAgent',
        version: '2.0',
        agentInstance: new MockStrongAgent('TestAgent'),
      });

      const result = await watchmaker.perform({
        action: 'compare',
        agent: 'TestAgent',
        versionA: '1.0',
        versionB: '2.0',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.comparison.winner).toBe('tie');
    });

    it('should use latency tiebreaker when quality is similar', async () => {
      // Both are strong (same quality), but one is slow
      await watchmaker.perform({
        action: 'register',
        agent: 'RaceAgent',
        version: 'slow',
        agentInstance: new MockSlowAgent('RaceAgent'),
      });
      await watchmaker.perform({
        action: 'register',
        agent: 'RaceAgent',
        version: 'fast',
        agentInstance: new MockStrongAgent('RaceAgent'),
      });

      const result = await watchmaker.perform({
        action: 'compare',
        agent: 'RaceAgent',
        versionA: 'slow',
        versionB: 'fast',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      // Both have 100% quality so latency decides; fast agent (B) should win
      expect(parsed.comparison.winner).toBe('B');
      expect(parsed.comparison.reason).toContain('atency');
    });

    it('should require versionA and versionB', async () => {
      const result = await watchmaker.perform({
        action: 'compare',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('required');
    });
  });

  describe('promote action', () => {
    it('should swap candidate into active slot', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'promote',
        agent: 'TestAgent',
        version: '2.0',
        reason: 'testing promotion',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.version).toBe('2.0');

      // Verify active version changed
      const statusResult = await watchmaker.perform({
        action: 'status',
        agent: 'TestAgent',
      });
      const statusParsed = JSON.parse(statusResult);
      expect(statusParsed.slot.activeVersion).toBe('2.0');
      expect(statusParsed.slot.candidateCount).toBe(0);
    });

    it('should record PromotionRecord in slot history', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      await watchmaker.perform({
        action: 'promote',
        agent: 'TestAgent',
        version: '2.0',
        reason: 'test reason',
      });

      const historyResult = await watchmaker.perform({
        action: 'history',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(historyResult);

      expect(parsed.promotionCount).toBe(1);
      expect(parsed.promotions[0].fromVersion).toBe('1.0');
      expect(parsed.promotions[0].toVersion).toBe('2.0');
      expect(parsed.promotions[0].reason).toBe('test reason');
    });

    it('should return error when version not found in candidates', async () => {
      registerStrong(watchmaker, '1.0');

      const result = await watchmaker.perform({
        action: 'promote',
        agent: 'TestAgent',
        version: '999',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should return error when slot not found', async () => {
      const result = await watchmaker.perform({
        action: 'promote',
        agent: 'nonexistent',
        version: '1.0',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });
  });

  describe('cycle action', () => {
    it('should evaluate active with no candidates and no promotions', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({ action: 'cycle' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.cycle.evaluated.length).toBe(1);
      expect(parsed.cycle.comparisons.length).toBe(0);
      expect(parsed.cycle.promotions.length).toBe(0);
    });

    it('should promote candidate that beats active', async () => {
      // Weak is active, strong is candidate
      registerWeak(watchmaker, '1.0');
      registerStrong(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'cycle',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.cycle.promotions.length).toBe(1);
      expect(parsed.cycle.promotions[0].toVersion).toBe('2.0');

      // Verify active is now the strong version
      const statusResult = await watchmaker.perform({
        action: 'status',
        agent: 'TestAgent',
      });
      const statusParsed = JSON.parse(statusResult);
      expect(statusParsed.slot.activeVersion).toBe('2.0');
    });

    it('should not promote when active beats candidate', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'cycle',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.cycle.promotions.length).toBe(0);

      const statusResult = await watchmaker.perform({
        action: 'status',
        agent: 'TestAgent',
      });
      const statusParsed = JSON.parse(statusResult);
      expect(statusParsed.slot.activeVersion).toBe('1.0');
    });

    it('should record in cycleHistory', async () => {
      registerStrong(watchmaker);

      await watchmaker.perform({ action: 'cycle' });

      const historyResult = await watchmaker.perform({ action: 'history' });
      const parsed = JSON.parse(historyResult);

      expect(parsed.count).toBe(1);
      expect(parsed.cycles[0].timestamp).toBeDefined();
      expect(parsed.cycles[0].summary).toContain('Evaluated');
    });

    it('should include data_slush with evaluations_run, comparisons_run, promotions_made', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      const result = await watchmaker.perform({
        action: 'cycle',
        testCases: [{ input: { query: 'test' }, expectedStatus: 'success' }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.signals.evaluations_run).toBeGreaterThan(0);
      expect(parsed.data_slush.signals.comparisons_run).toBeGreaterThan(0);
      expect(typeof parsed.data_slush.signals.promotions_made).toBe('number');
    });
  });

  describe('status action', () => {
    it('should return slot info for single agent', async () => {
      registerStrong(watchmaker);

      const result = await watchmaker.perform({
        action: 'status',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.slot.name).toBe('TestAgent');
      expect(parsed.slot.activeVersion).toBe('1.0');
      expect(parsed.slot.candidateCount).toBe(0);
    });

    it('should return all slots when no agent name', async () => {
      registerStrong(watchmaker, '1.0', 'AgentA');
      registerStrong(watchmaker, '1.0', 'AgentB');

      const result = await watchmaker.perform({ action: 'status' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.count).toBe(2);
      expect(parsed.slots.length).toBe(2);
    });

    it('should return error for unknown agent', async () => {
      const result = await watchmaker.perform({
        action: 'status',
        agent: 'nonexistent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });
  });

  describe('history action', () => {
    it('should return eval + promotion history for agent', async () => {
      registerStrong(watchmaker, '1.0');
      registerWeak(watchmaker, '2.0');

      await watchmaker.perform({
        action: 'evaluate',
        agent: 'TestAgent',
      });

      await watchmaker.perform({
        action: 'promote',
        agent: 'TestAgent',
        version: '2.0',
      });

      const result = await watchmaker.perform({
        action: 'history',
        agent: 'TestAgent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.evaluationCount).toBe(1);
      expect(parsed.promotionCount).toBe(1);
    });

    it('should return cycleHistory when no agent name', async () => {
      registerStrong(watchmaker);
      await watchmaker.perform({ action: 'cycle' });

      const result = await watchmaker.perform({ action: 'history' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.count).toBe(1);
      expect(parsed.cycles).toBeDefined();
    });

    it('should return error for unknown agent', async () => {
      const result = await watchmaker.perform({
        action: 'history',
        agent: 'nonexistent',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });
  });

  describe('setAgents', () => {
    it('should allow injecting agents for testing', async () => {
      const freshWatchmaker = new WatchmakerAgent();
      freshWatchmaker.setAgents([
        { agent: new MockStrongAgent('Injected'), version: '1.0' },
      ]);

      const statusResult = await freshWatchmaker.perform({
        action: 'status',
        agent: 'Injected',
      });
      const parsed = JSON.parse(statusResult);

      expect(parsed.status).toBe('success');
      expect(parsed.slot.name).toBe('Injected');
      expect(parsed.slot.activeVersion).toBe('1.0');
    });

    it('should add second injection as candidate', async () => {
      const freshWatchmaker = new WatchmakerAgent();
      freshWatchmaker.setAgents([
        { agent: new MockStrongAgent('Injected'), version: '1.0' },
        { agent: new MockWeakAgent('Injected'), version: '2.0' },
      ]);

      const statusResult = await freshWatchmaker.perform({
        action: 'status',
        agent: 'Injected',
      });
      const parsed = JSON.parse(statusResult);

      expect(parsed.slot.activeVersion).toBe('1.0');
      expect(parsed.slot.candidateCount).toBe(1);
    });
  });

  describe('Python parity', () => {
    it('should follow single-file agent pattern', () => {
      expect(watchmaker).toBeInstanceOf(BasicAgent);
      expect(watchmaker.name).toBe('Watchmaker');
      expect(watchmaker.metadata.name).toBe('Watchmaker');
      expect(watchmaker.metadata.description).toBeDefined();
      expect(watchmaker.metadata.parameters).toBeDefined();
    });

    it('should have same metadata schema as Python version', () => {
      const params = watchmaker.metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.properties.action.enum).toEqual([
        'evaluate', 'compare', 'register', 'promote', 'cycle', 'status', 'history',
      ]);
      expect(params.properties.agent.type).toBe('string');
      expect(params.properties.version.type).toBe('string');
      expect(params.properties.versionA.type).toBe('string');
      expect(params.properties.versionB.type).toBe('string');
      expect(params.properties.testCases.type).toBe('array');
      expect(params.properties.reason.type).toBe('string');
    });
  });
});
