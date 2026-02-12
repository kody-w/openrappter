/**
 * Parity test: Gateway RPC Methods
 *
 * Tests the registration and structure of all RPC methods exposed by the gateway.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllMethods } from '../../gateway/methods/index.js';

interface MethodInfo {
  handler: Function;
  requiresAuth: boolean;
}

describe('Gateway RPC Methods', () => {
  const methods = new Map<string, MethodInfo>();

  beforeAll(() => {
    // Create a mock server that captures registered methods
    const mockServer = {
      registerMethod<P = unknown, R = unknown>(
        name: string,
        handler: (params: P, connection: unknown) => Promise<R>,
        options?: { requiresAuth?: boolean }
      ): void {
        methods.set(name, {
          handler: handler as Function,
          requiresAuth: options?.requiresAuth ?? false,
        });
      },
    };

    // Register all methods
    registerAllMethods(mockServer);
  });

  describe('Method Registration', () => {
    it('should register all method groups', () => {
      // Should have methods from all 13 method groups
      expect(methods.size).toBeGreaterThanOrEqual(20);
    });

    it('should register chat methods', () => {
      expect(methods.has('chat.abort')).toBe(true);
      expect(methods.has('chat.inject')).toBe(true);
    });

    it('should register models methods', () => {
      expect(methods.has('models.list')).toBe(true);
    });

    it('should register browser methods', () => {
      expect(methods.has('browser.request')).toBe(true);
    });

    it('should register TTS methods', () => {
      expect(methods.has('tts.status')).toBe(true);
      expect(methods.has('tts.convert')).toBe(true);
      expect(methods.has('tts.providers')).toBe(true);
      expect(methods.has('tts.enable')).toBe(true);
      expect(methods.has('tts.disable')).toBe(true);
    });

    it('should register nodes methods', () => {
      expect(methods.has('nodes.list')).toBe(true);
      expect(methods.has('nodes.describe')).toBe(true);
      expect(methods.has('nodes.invoke')).toBe(true);
      expect(methods.has('nodes.pair.request')).toBe(true);
      expect(methods.has('nodes.pair.confirm')).toBe(true);
    });

    it('should register exec methods', () => {
      expect(methods.has('exec.approval.request')).toBe(true);
      expect(methods.has('exec.approval.resolve')).toBe(true);
      expect(methods.has('exec.approvals.get')).toBe(true);
      expect(methods.has('exec.approvals.set')).toBe(true);
    });

    it('should register usage methods', () => {
      expect(methods.has('usage.status')).toBe(true);
      expect(methods.has('usage.cost')).toBe(true);
    });

    it('should register logs methods', () => {
      expect(methods.has('logs.tail')).toBe(true);
    });

    it('should register session methods', () => {
      expect(methods.has('sessions.preview')).toBe(true);
      expect(methods.has('sessions.patch')).toBe(true);
      expect(methods.has('sessions.reset')).toBe(true);
      expect(methods.has('sessions.compact')).toBe(true);
    });

    it('should register skills methods', () => {
      expect(methods.has('skills.install')).toBe(true);
      expect(methods.has('skills.update')).toBe(true);
    });

    it('should register config methods', () => {
      expect(methods.has('config.patch')).toBe(true);
      expect(methods.has('config.schema')).toBe(true);
    });

    it('should register cron methods', () => {
      expect(methods.has('cron.update')).toBe(true);
      expect(methods.has('cron.status')).toBe(true);
      expect(methods.has('cron.runs')).toBe(true);
    });

    it('should register agents methods', () => {
      expect(methods.has('agents.identity.get')).toBe(true);
      expect(methods.has('agents.files.list')).toBe(true);
      expect(methods.has('agents.files.get')).toBe(true);
    });
  });

  describe('Method Handlers', () => {
    it('each registered method should have a function handler', () => {
      methods.forEach((info, name) => {
        expect(typeof info.handler).toBe('function');
      });
    });

    it('chat.abort handler should be callable', async () => {
      const methodInfo = methods.get('chat.abort');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({ runId: 'test' }, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });

    it('chat.inject handler should be callable', async () => {
      const methodInfo = methods.get('chat.inject');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler(
        { sessionId: 'test', content: 'hello' },
        {}
      );
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('messageId');
    });

    it('models.list handler should be callable', async () => {
      const methodInfo = methods.get('models.list');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('models');
      expect(Array.isArray(result.models)).toBe(true);
    });

    it('browser.request handler should be callable', async () => {
      const methodInfo = methods.get('browser.request');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler(
        { action: 'navigate', url: 'https://example.com' },
        {}
      );
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
    });

    it('tts.status handler should be callable', async () => {
      const methodInfo = methods.get('tts.status');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('enabled');
    });

    it('nodes.list handler should be callable', async () => {
      const methodInfo = methods.get('nodes.list');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('nodes');
      expect(Array.isArray(result.nodes)).toBe(true);
    });

    it('usage.status handler should be callable', async () => {
      const methodInfo = methods.get('usage.status');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalRequests');
      expect(result).toHaveProperty('totalTokens');
      expect(result).toHaveProperty('totalCost');
    });

    it('logs.tail handler should be callable', async () => {
      const methodInfo = methods.get('logs.tail');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('entries');
      expect(Array.isArray(result.entries)).toBe(true);
    });

    it('config.schema handler should be callable', async () => {
      const methodInfo = methods.get('config.schema');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('schema');
    });

    it('cron.status handler should be callable', async () => {
      const methodInfo = methods.get('cron.status');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('running');
      expect(result).toHaveProperty('jobCount');
    });

    it('skills.install handler should be callable but may throw without registry', async () => {
      const methodInfo = methods.get('skills.install');
      expect(methodInfo).toBeDefined();

      // This will throw because no registry is provided
      await expect(
        methodInfo!.handler({ name: 'test-skill' }, {})
      ).rejects.toThrow();
    });

    it('agents.files.list handler should be callable', async () => {
      const methodInfo = methods.get('agents.files.list');
      expect(methodInfo).toBeDefined();

      const result = await methodInfo!.handler({}, {});
      expect(result).toBeDefined();
      expect(result).toHaveProperty('files');
      expect(Array.isArray(result.files)).toBe(true);
    });
  });

  describe('Method Naming Convention', () => {
    it('all methods should follow dot notation', () => {
      methods.forEach((info, name) => {
        expect(name).toContain('.');
      });
    });

    it('method names should be lowercase', () => {
      methods.forEach((info, name) => {
        expect(name).toBe(name.toLowerCase());
      });
    });

    it('method names should follow group.action pattern', () => {
      methods.forEach((info, name) => {
        const parts = name.split('.');
        expect(parts.length).toBeGreaterThanOrEqual(2);

        // First part should be the group (chat, models, browser, etc.)
        expect(parts[0]).toBeTruthy();
        expect(parts[0].length).toBeGreaterThan(0);

        // Last part should be the action
        expect(parts[parts.length - 1]).toBeTruthy();
        expect(parts[parts.length - 1].length).toBeGreaterThan(0);
      });
    });
  });

  describe('Method Organization', () => {
    it('should group methods by domain', () => {
      const groups = new Map<string, string[]>();

      methods.forEach((info, name) => {
        const [group] = name.split('.');
        if (!groups.has(group)) {
          groups.set(group, []);
        }
        groups.get(group)!.push(name);
      });

      // Should have all expected groups
      expect(groups.has('chat')).toBe(true);
      expect(groups.has('models')).toBe(true);
      expect(groups.has('browser')).toBe(true);
      expect(groups.has('tts')).toBe(true);
      expect(groups.has('nodes')).toBe(true);
      expect(groups.has('exec')).toBe(true);
      expect(groups.has('usage')).toBe(true);
      expect(groups.has('logs')).toBe(true);
      expect(groups.has('sessions')).toBe(true);
      expect(groups.has('skills')).toBe(true);
      expect(groups.has('config')).toBe(true);
      expect(groups.has('cron')).toBe(true);
      expect(groups.has('agents')).toBe(true);

      expect(groups.size).toBe(13);
    });

    it('chat group should have expected methods', () => {
      const chatMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('chat.')
      );

      expect(chatMethods).toContain('chat.abort');
      expect(chatMethods).toContain('chat.inject');
      expect(chatMethods.length).toBe(2);
    });

    it('tts group should have expected methods', () => {
      const ttsMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('tts.')
      );

      expect(ttsMethods).toContain('tts.status');
      expect(ttsMethods).toContain('tts.providers');
      expect(ttsMethods).toContain('tts.enable');
      expect(ttsMethods).toContain('tts.disable');
      expect(ttsMethods).toContain('tts.convert');
      expect(ttsMethods.length).toBe(5);
    });

    it('nodes group should have expected methods', () => {
      const nodesMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('nodes.')
      );

      expect(nodesMethods).toContain('nodes.list');
      expect(nodesMethods).toContain('nodes.describe');
      expect(nodesMethods).toContain('nodes.invoke');
      expect(nodesMethods).toContain('nodes.pair.request');
      expect(nodesMethods).toContain('nodes.pair.confirm');
      expect(nodesMethods.length).toBe(5);
    });

    it('exec group should have expected methods', () => {
      const execMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('exec.')
      );

      expect(execMethods).toContain('exec.approval.request');
      expect(execMethods).toContain('exec.approval.resolve');
      expect(execMethods).toContain('exec.approvals.get');
      expect(execMethods).toContain('exec.approvals.set');
      expect(execMethods.length).toBe(4);
    });

    it('sessions group should have expected methods', () => {
      const sessionMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('sessions.')
      );

      expect(sessionMethods).toContain('sessions.preview');
      expect(sessionMethods).toContain('sessions.patch');
      expect(sessionMethods).toContain('sessions.reset');
      expect(sessionMethods).toContain('sessions.compact');
      expect(sessionMethods.length).toBe(4);
    });

    it('agents group should have expected methods', () => {
      const agentsMethods = Array.from(methods.keys()).filter((name) =>
        name.startsWith('agents.')
      );

      expect(agentsMethods).toContain('agents.identity.get');
      expect(agentsMethods).toContain('agents.files.list');
      expect(agentsMethods).toContain('agents.files.get');
      expect(agentsMethods.length).toBe(3);
    });
  });

  describe('Method Auth Requirements', () => {
    it('should track requiresAuth flag for each method', () => {
      methods.forEach((info, name) => {
        expect(typeof info.requiresAuth).toBe('boolean');
      });
    });

    it('should default to requiresAuth: false when not specified', () => {
      // Most methods don't specify requiresAuth, so should default to false
      const authRequiredCount = Array.from(methods.values()).filter(
        (info) => info.requiresAuth
      ).length;

      // Currently none of the methods require auth
      expect(authRequiredCount).toBe(0);
    });
  });
});
