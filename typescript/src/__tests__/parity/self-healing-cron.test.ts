/**
 * SelfHealingCronAgent Parity Tests
 *
 * Tests the autonomous self-healing health check agent that orchestrates
 * WebAgent, ShellAgent, and MessageAgent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SelfHealingCronAgent } from '../../agents/SelfHealingCronAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

// --- Mock agents ---

class MockWebAgent extends BasicAgent {
  fetchResults: string[] = [];
  private callIndex = 0;

  constructor() {
    super('Web', {
      name: 'Web',
      description: 'Mock WebAgent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    const result = this.fetchResults[this.callIndex] ?? JSON.stringify({ status: 'error', message: 'No mock result' });
    this.callIndex++;
    return result;
  }

  reset(): void {
    this.callIndex = 0;
  }
}

class MockShellAgent extends BasicAgent {
  lastCommand: string | undefined;
  result: string = JSON.stringify({ status: 'success', command: 'mock', output: 'restarted', return_code: 0 });

  constructor() {
    super('Shell', {
      name: 'Shell',
      description: 'Mock ShellAgent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.lastCommand = kwargs.command as string;
    return this.result;
  }
}

class MockMessageAgent extends BasicAgent {
  lastMessage: { channelId?: string; conversationId?: string; content?: string } = {};
  called = false;

  constructor() {
    super('Message', {
      name: 'Message',
      description: 'Mock MessageAgent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.called = true;
    this.lastMessage = {
      channelId: kwargs.channelId as string,
      conversationId: kwargs.conversationId as string,
      content: kwargs.content as string,
    };
    return JSON.stringify({ status: 'success', action: 'send', message: 'sent' });
  }
}

// --- Helpers ---

const HEALTHY_RESPONSE = JSON.stringify({ status: 'success', action: 'fetch', url: 'http://example.com/health', content: 'OK' });
const UNHEALTHY_RESPONSE = JSON.stringify({ status: 'error', message: 'HTTP 503: Service Unavailable' });

function setupTestJob(agent: SelfHealingCronAgent, overrides: Record<string, unknown> = {}): string {
  return agent.perform({
    action: 'setup',
    name: 'api-health',
    url: 'http://example.com/health',
    restartCommand: 'systemctl restart api',
    notifyChannel: 'slack',
    conversationId: 'C123',
    maxRetries: 2,
    ...overrides,
  }) as unknown as string;
}

// --- Tests ---

describe('SelfHealingCronAgent', () => {
  let agent: SelfHealingCronAgent;
  let mockWeb: MockWebAgent;
  let mockShell: MockShellAgent;
  let mockMessage: MockMessageAgent;

  beforeEach(() => {
    mockWeb = new MockWebAgent();
    mockShell = new MockShellAgent();
    mockMessage = new MockMessageAgent();
    agent = new SelfHealingCronAgent({
      webAgent: mockWeb,
      shellAgent: mockShell,
      messageAgent: mockMessage,
    });
  });

  describe('Constructor', () => {
    it('should have correct metadata name', () => {
      expect(agent.name).toBe('SelfHealingCron');
      expect(agent.metadata.name).toBe('SelfHealingCron');
    });

    it('should have a description', () => {
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.description.length).toBeGreaterThan(0);
    });

    it('should have parameters schema with action enum', () => {
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toEqual([
        'setup', 'check', 'status', 'history', 'teardown',
      ]);
    });

    it('should have all expected parameter properties', () => {
      const props = agent.metadata.parameters.properties;
      expect(props.name).toBeDefined();
      expect(props.url).toBeDefined();
      expect(props.schedule).toBeDefined();
      expect(props.restartCommand).toBeDefined();
      expect(props.notifyChannel).toBeDefined();
      expect(props.conversationId).toBeDefined();
      expect(props.maxRetries).toBeDefined();
      expect(props.timeoutMs).toBeDefined();
    });
  });

  describe('No action', () => {
    it('should return error when no action specified', async () => {
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('No action specified');
    });

    it('should return error for unknown action', async () => {
      const result = await agent.perform({ action: 'unknown' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Unknown action');
    });
  });

  describe('setup action', () => {
    it('should store job config and return success', async () => {
      const result = await agent.perform({
        action: 'setup',
        name: 'api-health',
        url: 'http://example.com/health',
        restartCommand: 'systemctl restart api',
        notifyChannel: 'slack',
        conversationId: 'C123',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('setup');
      expect(parsed.job.name).toBe('api-health');
      expect(parsed.job.url).toBe('http://example.com/health');
      expect(parsed.job.restartCommand).toBe('systemctl restart api');
      expect(parsed.job.notifyChannel).toBe('slack');
      expect(parsed.job.conversationId).toBe('C123');
      expect(parsed.job.schedule).toBe('*/5 * * * *');
      expect(parsed.job.maxRetries).toBe(2);
      expect(parsed.job.timeoutMs).toBe(5000);
      expect(parsed.message).toContain('api-health');
    });

    it('should include data_slush in setup response', async () => {
      const result = await agent.perform({
        action: 'setup',
        name: 'test-job',
        url: 'http://example.com',
        restartCommand: 'restart',
      });
      const parsed = JSON.parse(result);
      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.source_agent).toBe('SelfHealingCron');
      expect(parsed.data_slush.signals.job_name).toBe('test-job');
    });

    it('should return error when required params missing', async () => {
      const result = await agent.perform({ action: 'setup', name: 'test' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('required');
    });

    it('should use default schedule when not provided', async () => {
      const result = await agent.perform({
        action: 'setup',
        name: 'test',
        url: 'http://example.com',
        restartCommand: 'restart',
      });
      const parsed = JSON.parse(result);
      expect(parsed.job.schedule).toBe('*/5 * * * *');
    });
  });

  describe('check action (healthy)', () => {
    it('should return healthy when web fetch succeeds', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.healthy).toBe(true);
      expect(parsed.check.healthy).toBe(true);
      expect(parsed.check.restarted).toBe(false);
      expect(parsed.check.notified).toBe(false);
    });

    it('should not call shell or message agents when healthy', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];

      await agent.perform({ action: 'check', name: 'api-health' });

      expect(mockShell.lastCommand).toBeUndefined();
      expect(mockMessage.called).toBe(false);
    });

    it('should emit data_slush with healthy status', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.health_status).toBe('healthy');
      expect(parsed.data_slush.action_taken).toBe('none');
      expect(parsed.data_slush.source_agent).toBe('SelfHealingCron');
    });
  });

  describe('check action (unhealthy → recovered)', () => {
    it('should restart and detect recovery', async () => {
      await setupTestJob(agent);
      // Initial checks fail (maxRetries=2 → 3 attempts), then re-check after restart succeeds
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,  // re-check after restart
      ];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.healthy).toBe(true);
      expect(parsed.check.restarted).toBe(true);
      expect(parsed.check.recovered).toBe(true);
      expect(parsed.alert).toContain('recovered');
    });

    it('should call ShellAgent with restart command', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,
      ];

      await agent.perform({ action: 'check', name: 'api-health' });

      expect(mockShell.lastCommand).toBe('systemctl restart api');
    });

    it('should notify via MessageAgent with recovery message', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,
      ];

      await agent.perform({ action: 'check', name: 'api-health' });

      expect(mockMessage.called).toBe(true);
      expect(mockMessage.lastMessage.channelId).toBe('slack');
      expect(mockMessage.lastMessage.conversationId).toBe('C123');
      expect(mockMessage.lastMessage.content).toContain('recovered');
    });

    it('should emit data_slush with recovered status', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,
      ];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush.health_status).toBe('recovered');
      expect(parsed.data_slush.action_taken).toBe('restarted_recovered');
    });
  });

  describe('check action (unhealthy → still down)', () => {
    it('should report still down when restart fails to fix', async () => {
      await setupTestJob(agent);
      // All attempts fail including post-restart re-check
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,  // re-check also fails
      ];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.healthy).toBe(false);
      expect(parsed.check.restarted).toBe(true);
      expect(parsed.check.recovered).toBe(false);
      expect(parsed.alert).toContain('DOWN');
    });

    it('should notify with DOWN message', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
      ];

      await agent.perform({ action: 'check', name: 'api-health' });

      expect(mockMessage.called).toBe(true);
      expect(mockMessage.lastMessage.content).toContain('DOWN');
    });

    it('should emit data_slush with down status', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
      ];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush.health_status).toBe('down');
      expect(parsed.data_slush.action_taken).toBe('restarted_still_down');
    });
  });

  describe('retry logic', () => {
    it('should succeed on retry after initial failure', async () => {
      await setupTestJob(agent);
      // First attempt fails, second succeeds (within maxRetries=2)
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,
      ];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.healthy).toBe(true);
      expect(parsed.check.restarted).toBe(false);
    });

    it('should respect maxRetries setting', async () => {
      await agent.perform({
        action: 'setup',
        name: 'zero-retry',
        url: 'http://example.com/health',
        restartCommand: 'restart',
        notifyChannel: '',
        conversationId: '',
        maxRetries: 0,
      });
      // With maxRetries=0: only 1 attempt, then restart path
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        HEALTHY_RESPONSE,  // re-check after restart
      ];

      const result = await agent.perform({ action: 'check', name: 'zero-retry' });
      const parsed = JSON.parse(result);

      expect(parsed.check.restarted).toBe(true);
      expect(parsed.check.recovered).toBe(true);
    });
  });

  describe('status action', () => {
    it('should return job config and stats', async () => {
      await setupTestJob(agent);

      const result = await agent.perform({ action: 'status', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('status');
      expect(parsed.job.name).toBe('api-health');
      expect(parsed.stats.totalChecks).toBe(0);
      expect(parsed.stats.uptimePercent).toBe(100);
      expect(parsed.lastCheck).toBeNull();
    });

    it('should reflect check results in stats', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];
      await agent.perform({ action: 'check', name: 'api-health' });

      mockWeb.reset();
      mockWeb.fetchResults = [
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
        UNHEALTHY_RESPONSE,
      ];
      await agent.perform({ action: 'check', name: 'api-health' });

      const result = await agent.perform({ action: 'status', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.stats.totalChecks).toBe(2);
      expect(parsed.stats.healthyChecks).toBe(1);
      expect(parsed.stats.uptimePercent).toBe(50);
      expect(parsed.lastCheck).toBeDefined();
      expect(parsed.lastCheck.healthy).toBe(false);
    });
  });

  describe('history action', () => {
    it('should return ordered check history', async () => {
      await setupTestJob(agent);

      // Run two checks
      mockWeb.fetchResults = [HEALTHY_RESPONSE];
      await agent.perform({ action: 'check', name: 'api-health' });

      mockWeb.reset();
      mockWeb.fetchResults = [HEALTHY_RESPONSE];
      await agent.perform({ action: 'check', name: 'api-health' });

      const result = await agent.perform({ action: 'history', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('history');
      expect(parsed.count).toBe(2);
      expect(parsed.checks).toHaveLength(2);
      expect(parsed.checks[0].timestamp).toBeDefined();
      expect(parsed.checks[1].timestamp).toBeDefined();
    });

    it('should return empty history for new job', async () => {
      await setupTestJob(agent);

      const result = await agent.perform({ action: 'history', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.count).toBe(0);
      expect(parsed.checks).toEqual([]);
    });
  });

  describe('teardown action', () => {
    it('should remove job', async () => {
      await setupTestJob(agent);

      const result = await agent.perform({ action: 'teardown', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('teardown');
      expect(parsed.message).toContain('removed');
    });

    it('should make status return not found after teardown', async () => {
      await setupTestJob(agent);
      await agent.perform({ action: 'teardown', name: 'api-health' });

      const result = await agent.perform({ action: 'status', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });
  });

  describe('unknown job', () => {
    it('should return error for check on non-existent job', async () => {
      const result = await agent.perform({ action: 'check', name: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should return error for status on non-existent job', async () => {
      const result = await agent.perform({ action: 'status', name: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should return error for history on non-existent job', async () => {
      const result = await agent.perform({ action: 'history', name: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });

    it('should return error for teardown on non-existent job', async () => {
      const result = await agent.perform({ action: 'teardown', name: 'nonexistent' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('not found');
    });
  });

  describe('data_slush output', () => {
    it('should include source_agent in all check slush', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush.source_agent).toBe('SelfHealingCron');
      expect(parsed.data_slush.timestamp).toBeDefined();
    });

    it('should include health_status and action_taken fields', async () => {
      await setupTestJob(agent);
      mockWeb.fetchResults = [HEALTHY_RESPONSE];

      const result = await agent.perform({ action: 'check', name: 'api-health' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush.health_status).toBeDefined();
      expect(parsed.data_slush.action_taken).toBeDefined();
    });
  });

  describe('setAgents', () => {
    it('should allow replacing agents via setAgents', async () => {
      const freshAgent = new SelfHealingCronAgent();
      const newMockWeb = new MockWebAgent();
      newMockWeb.fetchResults = [HEALTHY_RESPONSE];

      freshAgent.setAgents({ webAgent: newMockWeb, shellAgent: mockShell, messageAgent: mockMessage });

      await freshAgent.perform({
        action: 'setup',
        name: 'test',
        url: 'http://example.com',
        restartCommand: 'restart',
      });

      const result = await freshAgent.perform({ action: 'check', name: 'test' });
      const parsed = JSON.parse(result);

      expect(parsed.healthy).toBe(true);
    });
  });

  describe('Python parity', () => {
    it('should follow single-file agent pattern', () => {
      expect(agent).toBeInstanceOf(BasicAgent);
      expect(agent.name).toBe('SelfHealingCron');
      expect(agent.metadata.name).toBe('SelfHealingCron');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have same metadata schema as Python version', () => {
      const params = agent.metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.properties.action.enum).toEqual(['setup', 'check', 'status', 'history', 'teardown']);
      expect(params.properties.name.type).toBe('string');
      expect(params.properties.url.type).toBe('string');
      expect(params.properties.schedule.type).toBe('string');
      expect(params.properties.restartCommand.type).toBe('string');
      expect(params.properties.notifyChannel.type).toBe('string');
      expect(params.properties.conversationId.type).toBe('string');
      expect(params.properties.maxRetries.type).toBe('number');
      expect(params.properties.timeoutMs.type).toBe('number');
    });
  });
});
