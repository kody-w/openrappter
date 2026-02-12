/**
 * Plugin System Parity Tests
 * Tests for plugin API, hook executor, and plugin types
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPluginAPI } from '../../plugins/api.js';
import { HookExecutor } from '../../plugins/hooks.js';
import type { PluginAPI } from '../../plugins/api.js';
import type { HookEvent, HookEntry } from '../../plugins/hooks.js';
import type { Plugin } from '../../plugins/types.js';

describe('Plugin API', () => {
  let api: PluginAPI;

  beforeEach(() => {
    api = createPluginAPI('test-plugin', {});
  });

  it('should create API instance', () => {
    const api = createPluginAPI('test-plugin', {});
    expect(api).toBeDefined();
    expect(api).toBeTruthy();
  });

  it('should have all registration methods', () => {
    expect(api.registerAgent).toBeDefined();
    expect(typeof api.registerAgent).toBe('function');

    expect(api.registerTool).toBeDefined();
    expect(typeof api.registerTool).toBe('function');

    expect(api.registerCommand).toBeDefined();
    expect(typeof api.registerCommand).toBe('function');

    expect(api.registerGatewayMethod).toBeDefined();
    expect(typeof api.registerGatewayMethod).toBe('function');

    expect(api.registerHook).toBeDefined();
    expect(typeof api.registerHook).toBe('function');

    expect(api.registerProvider).toBeDefined();
    expect(typeof api.registerProvider).toBe('function');

    expect(api.registerHttpHandler).toBeDefined();
    expect(typeof api.registerHttpHandler).toBe('function');
  });

  it('should have config methods', () => {
    expect(api.getConfig).toBeDefined();
    expect(typeof api.getConfig).toBe('function');

    const config = api.getConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');

    expect(api.setConfig).toBeDefined();
    expect(typeof api.setConfig).toBe('function');
  });

  it('should have getLogger', () => {
    const logger = api.getLogger();
    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(logger.warn).toBeDefined();
    expect(typeof logger.warn).toBe('function');
    expect(logger.error).toBeDefined();
    expect(typeof logger.error).toBe('function');
  });

  it('should have emitEvent', () => {
    expect(api.emitEvent).toBeDefined();
    expect(typeof api.emitEvent).toBe('function');
  });

  it('all registration methods should be callable without throwing', () => {
    // These should not throw errors
    expect(() => api.registerAgent({ id: 'test' })).not.toThrow();
    expect(() => api.registerTool({ name: 'test' })).not.toThrow();
    expect(() => api.registerCommand({ name: 'test' })).not.toThrow();
    expect(() => api.registerGatewayMethod({ name: 'test' })).not.toThrow();
    expect(() => api.registerHook('test_event', () => {}, 10)).not.toThrow();
    expect(() => api.registerProvider({ id: 'test' })).not.toThrow();
    expect(() => api.registerHttpHandler('/test', () => {})).not.toThrow();
    expect(() => api.setConfig('test', 'value')).not.toThrow();
    expect(() => api.emitEvent('test_event', {})).not.toThrow();

    // Logger methods should also be callable
    const logger = api.getLogger();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });
});

describe('Hook Executor', () => {
  let executor: HookExecutor;

  beforeEach(() => {
    executor = new HookExecutor();
  });

  it('should register and execute hooks', async () => {
    let executed = false;

    const hook: HookEntry = {
      pluginId: 'test-plugin',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        executed = true;
        return { ...context as object, modified: true };
      },
      priority: 0,
    };

    executor.register(hook);

    const result = await executor.execute('before_agent_start', { original: true });
    expect(executed).toBe(true);
    expect(result).toEqual({ original: true, modified: true });
  });

  it('should execute hooks in priority order', async () => {
    const executionOrder: number[] = [];

    const hook1: HookEntry = {
      pluginId: 'plugin-1',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        executionOrder.push(1);
        return context;
      },
      priority: 1,
    };

    const hook2: HookEntry = {
      pluginId: 'plugin-2',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        executionOrder.push(3);
        return context;
      },
      priority: 3,
    };

    const hook3: HookEntry = {
      pluginId: 'plugin-3',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        executionOrder.push(2);
        return context;
      },
      priority: 2,
    };

    executor.register(hook1);
    executor.register(hook2);
    executor.register(hook3);

    await executor.execute('before_agent_start', {});

    // Hooks should execute in descending priority order: 3, 2, 1
    expect(executionOrder).toEqual([3, 2, 1]);
  });

  it('should chain hook results', async () => {
    const hook1: HookEntry = {
      pluginId: 'plugin-1',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        return { ...context as object, a: 1 };
      },
      priority: 2,
    };

    const hook2: HookEntry = {
      pluginId: 'plugin-2',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        return { ...context as object, b: 2 };
      },
      priority: 1,
    };

    executor.register(hook1);
    executor.register(hook2);

    const result = await executor.execute('before_agent_start', {});

    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should handle hook errors gracefully', async () => {
    const hook1: HookEntry = {
      pluginId: 'plugin-error',
      event: 'before_agent_start',
      handler: async () => {
        throw new Error('Hook error');
      },
      priority: 2,
    };

    const hook2: HookEntry = {
      pluginId: 'plugin-success',
      event: 'before_agent_start',
      handler: async (context: unknown) => {
        return { ...context as object, success: true };
      },
      priority: 1,
    };

    executor.register(hook1);
    executor.register(hook2);

    // Should not throw, error is caught internally
    const result = await executor.execute('before_agent_start', {});

    // Second hook should still execute and return its result
    expect(result).toEqual({ success: true });
  });

  it('should unregister hooks by pluginId', () => {
    const hookA1: HookEntry = {
      pluginId: 'plugin-a',
      event: 'before_agent_start',
      handler: async (context) => context,
      priority: 0,
    };

    const hookA2: HookEntry = {
      pluginId: 'plugin-a',
      event: 'agent_end',
      handler: async (context) => context,
      priority: 0,
    };

    const hookB: HookEntry = {
      pluginId: 'plugin-b',
      event: 'before_agent_start',
      handler: async (context) => context,
      priority: 0,
    };

    executor.register(hookA1);
    executor.register(hookA2);
    executor.register(hookB);

    executor.unregister('plugin-a');

    const startHooks = executor.getHooks('before_agent_start');
    const endHooks = executor.getHooks('agent_end');

    // Only plugin-b hooks should remain
    expect(startHooks.length).toBe(1);
    expect(startHooks[0].pluginId).toBe('plugin-b');
    expect(endHooks.length).toBe(0);
  });

  it('should get hooks for event', () => {
    const hook1: HookEntry = {
      pluginId: 'plugin-1',
      event: 'before_agent_start',
      handler: async (context) => context,
      priority: 0,
    };

    const hook2: HookEntry = {
      pluginId: 'plugin-2',
      event: 'agent_end',
      handler: async (context) => context,
      priority: 0,
    };

    const hook3: HookEntry = {
      pluginId: 'plugin-3',
      event: 'before_agent_start',
      handler: async (context) => context,
      priority: 0,
    };

    executor.register(hook1);
    executor.register(hook2);
    executor.register(hook3);

    const startHooks = executor.getHooks('before_agent_start');
    const endHooks = executor.getHooks('agent_end');

    expect(startHooks.length).toBe(2);
    expect(startHooks.every((h) => h.event === 'before_agent_start')).toBe(true);

    expect(endHooks.length).toBe(1);
    expect(endHooks[0].event).toBe('agent_end');
  });

  it('should clear all hooks', () => {
    const hook1: HookEntry = {
      pluginId: 'plugin-1',
      event: 'before_agent_start',
      handler: async (context) => context,
      priority: 0,
    };

    const hook2: HookEntry = {
      pluginId: 'plugin-2',
      event: 'agent_end',
      handler: async (context) => context,
      priority: 0,
    };

    executor.register(hook1);
    executor.register(hook2);

    executor.clear();

    const startHooks = executor.getHooks('before_agent_start');
    const endHooks = executor.getHooks('agent_end');

    expect(startHooks.length).toBe(0);
    expect(endHooks.length).toBe(0);
  });

  it('should support all 13 hook events', () => {
    const events: HookEvent[] = [
      'before_agent_start',
      'agent_end',
      'before_compaction',
      'after_compaction',
      'message_received',
      'message_sending',
      'message_sent',
      'before_tool_call',
      'after_tool_call',
      'session_start',
      'session_end',
      'gateway_start',
      'gateway_stop',
    ];

    // Register a hook for each event
    events.forEach((event, index) => {
      const hook: HookEntry = {
        pluginId: `plugin-${index}`,
        event,
        handler: async (context) => context,
        priority: 0,
      };

      expect(() => executor.register(hook)).not.toThrow();
    });

    // Verify each event has its hook
    events.forEach((event) => {
      const hooks = executor.getHooks(event);
      expect(hooks.length).toBe(1);
      expect(hooks[0].event).toBe(event);
    });

    // Total should be 13
    const allHooks = events.flatMap((event) => executor.getHooks(event));
    expect(allHooks.length).toBe(13);
  });
});

describe('Plugin Types', () => {
  it('Plugin interface should support initialize', async () => {
    const mockPlugin: Plugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      initialize: async (api: unknown) => {
        // Mock initialization
        expect(api).toBeDefined();
      },
    };

    expect(mockPlugin).toBeDefined();
    expect(mockPlugin.initialize).toBeDefined();
    expect(typeof mockPlugin.initialize).toBe('function');

    // Should be callable
    await expect(mockPlugin.initialize!({})).resolves.toBeUndefined();
  });

  it('Plugin interface should support httpHandlers', () => {
    const mockPlugin: Plugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      httpHandlers: [
        {
          route: '/test',
          method: 'GET',
          handler: async (req: unknown, res: unknown) => {
            expect(req).toBeDefined();
            expect(res).toBeDefined();
          },
        },
        {
          route: '/api/test',
          method: 'POST',
          handler: async (req: unknown, res: unknown) => {
            // Handler implementation
          },
        },
      ],
    };

    expect(mockPlugin).toBeDefined();
    expect(mockPlugin.httpHandlers).toBeDefined();
    expect(Array.isArray(mockPlugin.httpHandlers)).toBe(true);
    expect(mockPlugin.httpHandlers!.length).toBe(2);
    expect(mockPlugin.httpHandlers![0].route).toBe('/test');
    expect(mockPlugin.httpHandlers![0].method).toBe('GET');
    expect(typeof mockPlugin.httpHandlers![0].handler).toBe('function');
  });

  it('Plugin interface should support providers', () => {
    const mockPlugin: Plugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      providers: [
        {
          id: 'custom-provider',
          name: 'Custom Provider',
          authenticate: async (creds: unknown) => {
            expect(creds).toBeDefined();
            return { token: 'test-token' };
          },
        },
        {
          id: 'another-provider',
          name: 'Another Provider',
          authenticate: async (creds: unknown) => {
            return { apiKey: (creds as Record<string, string>).apiKey };
          },
        },
      ],
    };

    expect(mockPlugin).toBeDefined();
    expect(mockPlugin.providers).toBeDefined();
    expect(Array.isArray(mockPlugin.providers)).toBe(true);
    expect(mockPlugin.providers!.length).toBe(2);
    expect(mockPlugin.providers![0].id).toBe('custom-provider');
    expect(mockPlugin.providers![0].name).toBe('Custom Provider');
    expect(typeof mockPlugin.providers![0].authenticate).toBe('function');
  });

  it('Plugin interface should support services', () => {
    const mockPlugin: Plugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      services: [
        {
          id: 'cache-service',
          name: 'Cache Service',
          factory: () => {
            return {
              get: (key: string) => null,
              set: (key: string, value: unknown) => {},
              clear: () => {},
            };
          },
        },
        {
          id: 'logger-service',
          name: 'Logger Service',
          factory: () => {
            return {
              log: (...args: unknown[]) => console.log(...args),
              error: (...args: unknown[]) => console.error(...args),
            };
          },
        },
      ],
    };

    expect(mockPlugin).toBeDefined();
    expect(mockPlugin.services).toBeDefined();
    expect(Array.isArray(mockPlugin.services)).toBe(true);
    expect(mockPlugin.services!.length).toBe(2);
    expect(mockPlugin.services![0].id).toBe('cache-service');
    expect(mockPlugin.services![0].name).toBe('Cache Service');
    expect(typeof mockPlugin.services![0].factory).toBe('function');

    // Should be able to create service instances
    const cacheService = mockPlugin.services![0].factory({});
    expect(cacheService).toBeDefined();

    const loggerService = mockPlugin.services![1].factory({});
    expect(loggerService).toBeDefined();
  });
});
