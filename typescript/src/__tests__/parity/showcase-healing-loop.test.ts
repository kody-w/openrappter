/**
 * Showcase: Healing Loop
 *
 * Tests SelfHealingCronAgent: setup, healthy check, unhealthy→restart→recovery,
 * persistent failure, status, history, teardown, and data_slush output.
 */

import { describe, it, expect } from 'vitest';
import { SelfHealingCronAgent } from '../../agents/SelfHealingCronAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';

// ── Mock agents ──

class MockWebAgent extends BasicAgent {
  private responses: Array<{ status: string; message?: string }>;
  private callIndex = 0;

  constructor(responses: Array<{ status: string; message?: string }>) {
    const metadata: AgentMetadata = {
      name: 'MockWeb',
      description: 'Mock web agent',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('MockWeb', metadata);
    this.responses = responses;
  }

  async perform(): Promise<string> {
    const resp = this.responses[Math.min(this.callIndex++, this.responses.length - 1)];
    return JSON.stringify(resp);
  }
}

class MockShellAgent extends BasicAgent {
  commands: string[] = [];

  constructor() {
    const metadata: AgentMetadata = {
      name: 'MockShell',
      description: 'Mock shell agent',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('MockShell', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.commands.push(kwargs.command as string ?? 'unknown');
    return JSON.stringify({ status: 'success', output: 'restarted' });
  }
}

class MockMessageAgent extends BasicAgent {
  messages: string[] = [];

  constructor() {
    const metadata: AgentMetadata = {
      name: 'MockMessage',
      description: 'Mock message agent',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('MockMessage', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    this.messages.push(kwargs.content as string ?? '');
    return JSON.stringify({ status: 'success' });
  }
}

describe('Showcase: Healing Loop', () => {
  describe('Setup', () => {
    it('should create job config', async () => {
      const agent = new SelfHealingCronAgent();
      const result = JSON.parse(await agent.execute({
        action: 'setup',
        name: 'api-health',
        url: 'http://localhost:3000/health',
        restartCommand: 'systemctl restart api',
        notifyChannel: 'slack',
        conversationId: 'C123',
      }));

      expect(result.status).toBe('success');
      expect(result.action).toBe('setup');
      expect(result.job.name).toBe('api-health');
      expect(result.data_slush).toBeDefined();
    });
  });

  describe('Healthy check', () => {
    it('should return health_status=healthy in data_slush', async () => {
      const webAgent = new MockWebAgent([{ status: 'success' }]);
      const agent = new SelfHealingCronAgent({ webAgent });

      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'restart', notifyChannel: '', conversationId: '',
      });

      const result = JSON.parse(await agent.execute({ action: 'check', name: 'api' }));
      expect(result.status).toBe('success');
      expect(result.healthy).toBe(true);
      expect(result.data_slush.health_status).toBe('healthy');
      expect(result.data_slush.action_taken).toBe('none');
    });
  });

  describe('Unhealthy → restart → recovery', () => {
    it('should restart and recover when post-restart check succeeds', async () => {
      // First 3 calls fail (initial + 2 retries), 4th succeeds (post-restart check)
      const webAgent = new MockWebAgent([
        { status: 'error', message: 'HTTP 503' },
        { status: 'error', message: 'HTTP 503' },
        { status: 'error', message: 'HTTP 503' },
        { status: 'success' },
      ]);
      const shellAgent = new MockShellAgent();
      const messageAgent = new MockMessageAgent();

      const agent = new SelfHealingCronAgent({ webAgent, shellAgent, messageAgent });

      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'systemctl restart api',
        notifyChannel: 'slack', conversationId: 'C123',
      });

      const result = JSON.parse(await agent.execute({ action: 'check', name: 'api' }));
      expect(result.healthy).toBe(true);
      expect(result.check.restarted).toBe(true);
      expect(result.check.recovered).toBe(true);
      expect(result.data_slush.action_taken).toBe('restarted_recovered');
      expect(messageAgent.messages.length).toBe(1);
      expect(messageAgent.messages[0]).toContain('recovered');
    });
  });

  describe('Persistent failure', () => {
    it('should report still down when restart does not help', async () => {
      const webAgent = new MockWebAgent([
        { status: 'error' },
        { status: 'error' },
        { status: 'error' },
        { status: 'error' }, // post-restart still fails
      ]);
      const shellAgent = new MockShellAgent();
      const messageAgent = new MockMessageAgent();

      const agent = new SelfHealingCronAgent({ webAgent, shellAgent, messageAgent });
      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'restart', notifyChannel: 'slack', conversationId: 'C1',
      });

      const result = JSON.parse(await agent.execute({ action: 'check', name: 'api' }));
      expect(result.healthy).toBe(false);
      expect(result.check.restarted).toBe(true);
      expect(result.check.recovered).toBe(false);
      expect(result.data_slush.action_taken).toBe('restarted_still_down');
    });
  });

  describe('Status and history', () => {
    it('should track uptime percentage and history', async () => {
      const webAgent = new MockWebAgent([{ status: 'success' }]);
      const agent = new SelfHealingCronAgent({ webAgent });

      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'restart', notifyChannel: '', conversationId: '',
      });

      // Run two healthy checks
      await agent.execute({ action: 'check', name: 'api' });
      await agent.execute({ action: 'check', name: 'api' });

      const status = JSON.parse(await agent.execute({ action: 'status', name: 'api' }));
      expect(status.stats.totalChecks).toBe(2);
      expect(status.stats.uptimePercent).toBe(100);

      const history = JSON.parse(await agent.execute({ action: 'history', name: 'api' }));
      expect(history.count).toBe(2);
      expect(history.checks.length).toBe(2);
    });
  });

  describe('Teardown', () => {
    it('should remove job and history', async () => {
      const agent = new SelfHealingCronAgent();
      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'restart', notifyChannel: '', conversationId: '',
      });

      const teardown = JSON.parse(await agent.execute({ action: 'teardown', name: 'api' }));
      expect(teardown.status).toBe('success');
      expect(teardown.action).toBe('teardown');

      // Should no longer find the job
      const status = JSON.parse(await agent.execute({ action: 'status', name: 'api' }));
      expect(status.status).toBe('error');
    });
  });

  describe('data_slush includes action_taken', () => {
    it('should include action_taken in all check results', async () => {
      const webAgent = new MockWebAgent([{ status: 'success' }]);
      const agent = new SelfHealingCronAgent({ webAgent });

      await agent.execute({
        action: 'setup', name: 'api', url: 'http://localhost/health',
        restartCommand: 'restart', notifyChannel: '', conversationId: '',
      });

      const result = JSON.parse(await agent.execute({ action: 'check', name: 'api' }));
      expect(result.data_slush).toHaveProperty('action_taken');
    });
  });
});
