/**
 * Lifecycle Hooks System — Comprehensive Tests
 *
 * Covers:
 * - HookRegistry: registration, priority ordering, unregister, phase filtering
 * - HookExecutor: run, runWaterfall, runBail, timeout enforcement, error isolation
 * - HookLoader: markdown parsing, code extraction, frontmatter handling,
 *               invalid/missing files, loadIntoRegistry
 * - Built-in templates: BOOT.md, MESSAGE.md, SHUTDOWN.md structure
 * - End-to-end: registry + executor + loader wired together
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { HookRegistry } from '../registry.js';
import { HookExecutor } from '../executor.js';
import { HookLoader } from '../loader.js';
import type {
  HookContext,
  HookPhase,
  HookResult,
  HookDefinition,
} from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(
  phase: HookPhase = 'boot',
  data: Record<string, unknown> = {}
): HookContext {
  return { phase, timestamp: new Date(), data, metadata: {} };
}

function makeHandler(
  result?: HookResult | void
): (ctx: HookContext) => Promise<HookResult | void> {
  return vi.fn().mockResolvedValue(result);
}

// ── HookRegistry ─────────────────────────────────────────────────────────────

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  describe('register', () => {
    it('returns a unique id for each registered handler', () => {
      const h = makeHandler();
      const id1 = registry.register('boot', h);
      const id2 = registry.register('boot', h);
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('accepts an explicit id via options', () => {
      const h = makeHandler();
      const id = registry.register('boot', h, 100, { id: 'my-custom-id' });
      expect(id).toBe('my-custom-id');
    });

    it('increments size for each registration', () => {
      registry.register('boot', makeHandler());
      registry.register('boot', makeHandler());
      registry.register('shutdown', makeHandler());
      expect(registry.size).toBe(3);
    });

    it('stores source and timeout in the handler entry', () => {
      const h = makeHandler();
      const id = registry.register('boot', h, 50, {
        source: 'test-plugin',
        timeout: 5000,
      });
      const entry = registry.getHandler(id);
      expect(entry?.source).toBe('test-plugin');
      expect(entry?.timeout).toBe(5000);
    });
  });

  describe('unregister', () => {
    it('removes the handler and returns true', () => {
      const id = registry.register('boot', makeHandler());
      expect(registry.unregister(id)).toBe(true);
      expect(registry.size).toBe(0);
    });

    it('returns false when the id does not exist', () => {
      expect(registry.unregister('nonexistent-id')).toBe(false);
    });
  });

  describe('getHandlers', () => {
    it('returns only handlers for the requested phase', () => {
      registry.register('boot', makeHandler(), 10);
      registry.register('boot', makeHandler(), 20);
      registry.register('shutdown', makeHandler(), 5);

      const bootHandlers = registry.getHandlers('boot');
      expect(bootHandlers).toHaveLength(2);
      bootHandlers.forEach((h) => expect(h.phase).toBe('boot'));
    });

    it('returns an empty array when no handlers are registered for a phase', () => {
      expect(registry.getHandlers('error')).toHaveLength(0);
    });

    it('sorts handlers by ascending priority (lower runs first)', () => {
      registry.register('boot', makeHandler(), 200);
      registry.register('boot', makeHandler(), 50);
      registry.register('boot', makeHandler(), 100);

      const handlers = registry.getHandlers('boot');
      expect(handlers.map((h) => h.priority)).toEqual([50, 100, 200]);
    });

    it('default priority is 100 when not specified', () => {
      const id = registry.register('boot', makeHandler());
      const entry = registry.getHandler(id);
      expect(entry?.priority).toBe(100);
    });
  });

  describe('getActivePhases', () => {
    it('returns all phases that have at least one handler', () => {
      registry.register('boot', makeHandler());
      registry.register('shutdown', makeHandler());
      registry.register('boot', makeHandler());

      const phases = registry.getActivePhases();
      expect(phases).toHaveLength(2);
      expect(phases).toContain('boot');
      expect(phases).toContain('shutdown');
    });

    it('returns empty array when nothing is registered', () => {
      expect(registry.getActivePhases()).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('removes all handlers', () => {
      registry.register('boot', makeHandler());
      registry.register('shutdown', makeHandler());
      registry.clear();
      expect(registry.size).toBe(0);
    });
  });
});

// ── HookExecutor ──────────────────────────────────────────────────────────────

describe('HookExecutor', () => {
  let registry: HookRegistry;
  let executor: HookExecutor;

  beforeEach(() => {
    registry = new HookRegistry();
    executor = new HookExecutor(registry);
    // Suppress debug/warn output during tests
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── run ───────────────────────────────────────────────────────────────────

  describe('run', () => {
    it('executes all registered handlers for the phase', async () => {
      const h1 = makeHandler();
      const h2 = makeHandler();
      registry.register('boot', h1 as (ctx: HookContext) => Promise<HookResult | void>);
      registry.register('boot', h2 as (ctx: HookContext) => Promise<HookResult | void>);

      const ctx = makeContext('boot');
      const summary = await executor.run('boot', ctx);

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(summary.ran).toBe(2);
    });

    it('returns ran=0 when no handlers are registered', async () => {
      const summary = await executor.run('error', makeContext('error'));
      expect(summary.ran).toBe(0);
      expect(summary.errors).toHaveLength(0);
    });

    it('executes handlers in priority order', async () => {
      const order: number[] = [];
      registry.register('boot', async () => { order.push(2); }, 200);
      registry.register('boot', async () => { order.push(1); }, 50);

      await executor.run('boot', makeContext('boot'));
      expect(order).toEqual([1, 2]);
    });

    it('isolates errors — one failure does not stop others', async () => {
      const good = vi.fn().mockResolvedValue(undefined);
      registry.register('boot', async () => { throw new Error('boom'); }, 10);
      registry.register('boot', good, 20);

      const summary = await executor.run('boot', makeContext('boot'));

      expect(good).toHaveBeenCalledOnce();
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].error.message).toBe('boom');
    });

    it('marks bailed as false (run mode never bails)', async () => {
      registry.register('boot', async () => ({ bail: true }));
      const summary = await executor.run('boot', makeContext('boot'));
      expect(summary.bailed).toBe(false);
    });

    it('propagates error when isolateErrors is false', async () => {
      registry.register('boot', async () => { throw new Error('critical'); });
      await expect(
        executor.run('boot', makeContext('boot'), { isolateErrors: false })
      ).rejects.toThrow('critical');
    });
  });

  // ── runWaterfall ──────────────────────────────────────────────────────────

  describe('runWaterfall', () => {
    it('merges returned data into context for subsequent hooks', async () => {
      registry.register(
        'message.incoming',
        async (ctx) => ({ data: { ...ctx.data, step1: true } }),
        10
      );
      registry.register(
        'message.incoming',
        async (ctx) => ({ data: { ...ctx.data, step2: true } }),
        20
      );

      const ctx = makeContext('message.incoming');
      const summary = await executor.runWaterfall('message.incoming', ctx);

      expect(summary.context.data.step1).toBe(true);
      expect(summary.context.data.step2).toBe(true);
    });

    it('passes transformed data from one hook to the next', async () => {
      const seen: unknown[] = [];

      registry.register(
        'agent.before',
        async (ctx) => {
          seen.push(ctx.data.counter);
          return { data: { counter: 1 } };
        },
        10
      );
      registry.register(
        'agent.before',
        async (ctx) => {
          seen.push(ctx.data.counter);
          return { data: { counter: (ctx.data.counter as number) + 1 } };
        },
        20
      );
      registry.register(
        'agent.before',
        async (ctx) => {
          seen.push(ctx.data.counter);
        },
        30
      );

      const ctx = makeContext('agent.before', { counter: 0 });
      await executor.runWaterfall('agent.before', ctx);

      // hook1 sees 0, hook2 sees 1 (set by hook1), hook3 sees 2 (set by hook2)
      expect(seen).toEqual([0, 1, 2]);
    });

    it('isolates errors in waterfall mode', async () => {
      const good = vi.fn().mockResolvedValue({ data: { ok: true } });
      registry.register('boot', async () => { throw new Error('waterfall-err'); }, 10);
      registry.register('boot', good, 20);

      const summary = await executor.runWaterfall('boot', makeContext('boot'));
      expect(good).toHaveBeenCalledOnce();
      expect(summary.errors).toHaveLength(1);
    });
  });

  // ── runBail ───────────────────────────────────────────────────────────────

  describe('runBail', () => {
    it('stops execution when a handler returns bail: true', async () => {
      const second = vi.fn().mockResolvedValue(undefined);
      registry.register('message.incoming', async () => ({ bail: true }), 10);
      registry.register('message.incoming', second, 20);

      const summary = await executor.runBail(
        'message.incoming',
        makeContext('message.incoming')
      );

      expect(second).not.toHaveBeenCalled();
      expect(summary.bailed).toBe(true);
      expect(summary.ran).toBe(1);
    });

    it('does not bail when no handler returns bail: true', async () => {
      registry.register('boot', async () => ({ data: { x: 1 } }), 10);
      registry.register('boot', async () => ({ data: { y: 2 } }), 20);

      const summary = await executor.runBail('boot', makeContext('boot'));
      expect(summary.bailed).toBe(false);
      expect(summary.ran).toBe(2);
    });

    it('propagates data up to the bail point', async () => {
      registry.register('boot', async () => ({ data: { before: true } }), 10);
      registry.register(
        'boot',
        async (ctx) => {
          return { bail: true, data: { ...ctx.data, atBail: true } };
        },
        20
      );
      registry.register('boot', async () => ({ data: { after: true } }), 30);

      const ctx = makeContext('boot');
      await executor.runBail('boot', ctx);

      expect(ctx.data.before).toBe(true);
      expect(ctx.data.atBail).toBe(true);
      expect(ctx.data.after).toBeUndefined();
    });

    it('continues past errors in bail mode (error isolation)', async () => {
      const third = vi.fn().mockResolvedValue(undefined);
      registry.register('boot', async () => { throw new Error('bail-err'); }, 10);
      registry.register('boot', third, 20);

      const summary = await executor.runBail('boot', makeContext('boot'));
      expect(third).toHaveBeenCalledOnce();
      expect(summary.errors).toHaveLength(1);
    });
  });

  // ── Timeout enforcement ───────────────────────────────────────────────────

  describe('timeout enforcement', () => {
    it('times out a slow handler and captures the error', async () => {
      registry.register(
        'boot',
        () => new Promise(() => { /* never resolves */ }),
        100,
        { timeout: 50 }
      );

      const summary = await executor.run('boot', makeContext('boot'));
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].error.message).toMatch(/timed out/i);
    }, 5000);

    it('respects executor-level timeout when handler has no custom timeout', async () => {
      registry.register(
        'boot',
        () => new Promise(() => { /* never resolves */ })
      );

      const summary = await executor.run('boot', makeContext('boot'), {
        timeout: 50,
      });
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].error.message).toMatch(/timed out/i);
    }, 5000);

    it('does not time out a fast handler', async () => {
      registry.register(
        'boot',
        async () => { /* resolves immediately */ },
        100,
        { timeout: 500 }
      );

      const summary = await executor.run('boot', makeContext('boot'));
      expect(summary.errors).toHaveLength(0);
    });
  });

  // ── ExecutionSummary shape ────────────────────────────────────────────────

  describe('ExecutionSummary', () => {
    it('returns phase, ran, errors, context, bailed fields', async () => {
      registry.register('cron.tick', makeHandler() as (ctx: HookContext) => Promise<HookResult | void>);
      const ctx = makeContext('cron.tick');
      const summary = await executor.run('cron.tick', ctx);

      expect(summary.phase).toBe('cron.tick');
      expect(typeof summary.ran).toBe('number');
      expect(Array.isArray(summary.errors)).toBe(true);
      expect(summary.context).toBe(ctx);
      expect(typeof summary.bailed).toBe('boolean');
    });
  });
});

// ── HookLoader ────────────────────────────────────────────────────────────────

describe('HookLoader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── loadFile (in-memory via mocking) ──────────────────────────────────────

  describe('loadFile', () => {
    it('parses a well-formed HOOK.md file', async () => {
      const content = `---
id: test-hook
name: Test Hook
phase: boot
priority: 50
timeout: 3000
---

## Test Hook

\`\`\`typescript
console.log('hello');
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/test-hook.md');

      expect(def).not.toBeNull();
      expect(def?.id).toBe('test-hook');
      expect(def?.name).toBe('Test Hook');
      expect(def?.phase).toBe('boot');
      expect(def?.priority).toBe(50);
      expect(def?.timeout).toBe(3000);
      expect(def?.code).toContain("console.log('hello')");
    });

    it('uses filename as id when frontmatter lacks id field', async () => {
      const content = `---
phase: shutdown
---

\`\`\`typescript
console.log('done');
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/my-shutdown.md');

      expect(def?.id).toBe('my-shutdown');
    });

    it('defaults priority to 100 when not specified in frontmatter', async () => {
      const content = `---
phase: boot
---

\`\`\`typescript
// noop
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/hook.md');

      expect(def?.priority).toBe(100);
    });

    it('returns null when the phase is unknown', async () => {
      const content = `---
phase: unknown-phase
---

\`\`\`typescript
// code
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/bad.md');

      expect(def).toBeNull();
    });

    it('returns null when no code block is found', async () => {
      const content = `---
phase: boot
---

No code block here.
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/no-code.md');

      expect(def).toBeNull();
    });

    it('returns null when the file cannot be read', async () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/missing.md');

      expect(def).toBeNull();
    });

    it('accepts javascript code blocks', async () => {
      const content = `---
phase: error
---

\`\`\`javascript
console.error('caught');
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/err-hook.md');

      expect(def).not.toBeNull();
      expect(def?.phase).toBe('error');
    });

    it('parses without frontmatter when file has no YAML block', async () => {
      // Without frontmatter there is no phase — should return null
      const content = `## No Frontmatter

\`\`\`typescript
// code
\`\`\`
`;
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const loader = new HookLoader('/tmp/hooks');
      const def = await loader.loadFile('/tmp/hooks/no-fm.md');

      expect(def).toBeNull(); // phase is empty → invalid
    });
  });

  // ── scanDirectory ─────────────────────────────────────────────────────────

  describe('scanDirectory', () => {
    it('returns empty array when directory does not exist', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const loader = new HookLoader('/nonexistent');
      const defs = await loader.scanDirectory();

      expect(defs).toHaveLength(0);
    });

    it('returns empty array when directory read fails', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
        throw new Error('EACCES');
      });

      const loader = new HookLoader('/tmp/hooks');
      const defs = await loader.scanDirectory();

      expect(defs).toHaveLength(0);
    });

    it('parses all valid .md files in the directory', async () => {
      const validContent = `---
phase: boot
---

\`\`\`typescript
// noop
\`\`\`
`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeEntries: any[] = [
        { name: 'hook1.md', isFile: () => true, isDirectory: () => false },
        { name: 'hook2.md', isFile: () => true, isDirectory: () => false },
        { name: 'README.txt', isFile: () => true, isDirectory: () => false },
      ];

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(fs, 'readdirSync').mockReturnValue(fakeEntries as any);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(validContent);

      const loader = new HookLoader('/tmp/hooks');
      const defs = await loader.scanDirectory();

      // Only .md files are parsed; README.txt is ignored
      expect(defs).toHaveLength(2);
    });
  });

  // ── loadIntoRegistry ──────────────────────────────────────────────────────

  describe('loadIntoRegistry', () => {
    it('registers compiled handlers into the registry', async () => {
      const content = `---
id: reg-boot
phase: boot
priority: 30
---

\`\`\`typescript
return { data: { loaded: true } };
\`\`\`
`;
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(fs, 'readdirSync').mockReturnValue([
        { name: 'reg-boot.md', isFile: () => true, isDirectory: () => false },
      ] as any);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const registry = new HookRegistry();
      const loader = new HookLoader('/tmp/hooks');
      const loaded = await loader.loadIntoRegistry(registry);

      expect(loaded).toBe(1);
      expect(registry.size).toBe(1);
      const handlers = registry.getHandlers('boot');
      expect(handlers).toHaveLength(1);
      expect(handlers[0].id).toBe('reg-boot');
      expect(handlers[0].priority).toBe(30);
    });

    it('returns 0 when the hooks directory is empty', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const registry = new HookRegistry();
      const loader = new HookLoader('/tmp/hooks');
      const loaded = await loader.loadIntoRegistry(registry);

      expect(loaded).toBe(0);
      expect(registry.size).toBe(0);
    });
  });

  // ── compile (unit) ────────────────────────────────────────────────────────

  describe('compile', () => {
    it('produces an executable handler from a HookDefinition', async () => {
      const def: HookDefinition = {
        id: 'test',
        name: 'Test',
        phase: 'boot',
        priority: 100,
        code: 'return { data: { compiled: true } };',
        filePath: '/tmp/test.md',
      };

      const loader = new HookLoader();
      const handler = loader.compile(def);

      const ctx = makeContext('boot');
      const result = await handler(ctx);

      expect(result).toEqual({ data: { compiled: true } });
    });

    it('handler receives the context object', async () => {
      const def: HookDefinition = {
        id: 'ctx-test',
        name: 'Context Test',
        phase: 'boot',
        priority: 100,
        code: 'return { data: { phase: context.phase } };',
        filePath: '/tmp/ctx-test.md',
      };

      const loader = new HookLoader();
      const handler = loader.compile(def);

      const ctx = makeContext('boot');
      const result = await handler(ctx) as HookResult;

      expect(result?.data?.phase).toBe('boot');
    });
  });
});

// ── Built-in Hook Templates ───────────────────────────────────────────────────

describe('Built-in Hook Templates', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const templatesDir = path.join(__dirname, '..', 'templates');

  it('BOOT.md exists and is parseable', async () => {
    const filePath = path.join(templatesDir, 'BOOT.md');
    expect(fs.existsSync(filePath)).toBe(true);

    const loader = new HookLoader(templatesDir);
    // Use real fs — no mocking for template existence checks
    const def = await loader.loadFile(filePath);

    expect(def).not.toBeNull();
    expect(def?.phase).toBe('boot');
    expect(def?.code.length).toBeGreaterThan(0);
  });

  it('MESSAGE.md exists and targets message.incoming', async () => {
    const filePath = path.join(templatesDir, 'MESSAGE.md');
    expect(fs.existsSync(filePath)).toBe(true);

    const loader = new HookLoader(templatesDir);
    const def = await loader.loadFile(filePath);

    expect(def?.phase).toBe('message.incoming');
  });

  it('SHUTDOWN.md exists and targets shutdown', async () => {
    const filePath = path.join(templatesDir, 'SHUTDOWN.md');
    expect(fs.existsSync(filePath)).toBe(true);

    const loader = new HookLoader(templatesDir);
    const def = await loader.loadFile(filePath);

    expect(def?.phase).toBe('shutdown');
  });

  it('all templates have non-empty code blocks', async () => {
    const templates = ['BOOT.md', 'MESSAGE.md', 'SHUTDOWN.md'];
    const loader = new HookLoader(templatesDir);

    for (const name of templates) {
      const filePath = path.join(templatesDir, name);
      const def = await loader.loadFile(filePath);
      expect(def?.code.trim().length, `${name} has empty code block`).toBeGreaterThan(0);
    }
  });
});

// ── Phase Filtering ───────────────────────────────────────────────────────────

describe('Phase filtering', () => {
  const ALL_PHASES: HookPhase[] = [
    'boot',
    'shutdown',
    'message.incoming',
    'message.outgoing',
    'agent.before',
    'agent.after',
    'channel.connect',
    'channel.disconnect',
    'cron.tick',
    'error',
  ];

  it('registry correctly isolates handlers per phase', () => {
    const registry = new HookRegistry();
    for (const phase of ALL_PHASES) {
      registry.register(phase, makeHandler() as (ctx: HookContext) => Promise<HookResult | void>);
    }

    for (const phase of ALL_PHASES) {
      const handlers = registry.getHandlers(phase);
      expect(handlers).toHaveLength(1);
      expect(handlers[0].phase).toBe(phase);
    }
  });

  it('executor.run only fires handlers for the requested phase', async () => {
    const registry = new HookRegistry();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const bootFn = vi.fn().mockResolvedValue(undefined);
    const shutdownFn = vi.fn().mockResolvedValue(undefined);
    registry.register('boot', bootFn);
    registry.register('shutdown', shutdownFn);

    const executor = new HookExecutor(registry);
    await executor.run('boot', makeContext('boot'));

    expect(bootFn).toHaveBeenCalledOnce();
    expect(shutdownFn).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ── End-to-End: Registry + Executor wired together ───────────────────────────

describe('End-to-end integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boot lifecycle: register hooks, run, collect summary', async () => {
    const registry = new HookRegistry();
    const executor = new HookExecutor(registry);

    registry.register(
      'boot',
      async (ctx) => ({ data: { ...ctx.data, step: 'initialized' } }),
      10,
      { source: 'core' }
    );
    registry.register(
      'boot',
      async (ctx) => {
        if (ctx.data.step !== 'initialized') throw new Error('Bad state');
      },
      20,
      { source: 'validator' }
    );

    const ctx = makeContext('boot');
    const summary = await executor.runWaterfall('boot', ctx);

    expect(summary.ran).toBe(2);
    expect(summary.errors).toHaveLength(0);
    expect(summary.context.data.step).toBe('initialized');
  });

  it('message.incoming lifecycle with bail on empty message', async () => {
    const registry = new HookRegistry();
    const executor = new HookExecutor(registry);

    const downstream = vi.fn().mockResolvedValue(undefined);

    registry.register(
      'message.incoming',
      async (ctx) => {
        const msg = ctx.data.message as string;
        if (!msg || msg.trim() === '') return { bail: true };
      },
      10
    );
    registry.register('message.incoming', downstream, 20);

    const ctx = makeContext('message.incoming', { message: '' });
    const summary = await executor.runBail('message.incoming', ctx);

    expect(summary.bailed).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
  });

  it('error hook receives error metadata', async () => {
    const registry = new HookRegistry();
    const executor = new HookExecutor(registry);
    let captured: Record<string, unknown> = {};

    registry.register('error', async (ctx) => {
      captured = { ...ctx.metadata };
    });

    const ctx: HookContext = {
      phase: 'error',
      timestamp: new Date(),
      data: {},
      metadata: { errorMessage: 'something went wrong', code: 500 },
    };

    await executor.run('error', ctx);

    expect(captured.errorMessage).toBe('something went wrong');
    expect(captured.code).toBe(500);
  });

  it('cron.tick hooks accumulate data across waterfall', async () => {
    const registry = new HookRegistry();
    const executor = new HookExecutor(registry);

    registry.register(
      'cron.tick',
      async (ctx) => ({ data: { ...ctx.data, ticks: 1 } }),
      10
    );
    registry.register(
      'cron.tick',
      async (ctx) => ({
        data: { ...ctx.data, ticks: (ctx.data.ticks as number) + 1 },
      }),
      20
    );

    const ctx = makeContext('cron.tick', { ticks: 0 });
    const summary = await executor.runWaterfall('cron.tick', ctx);

    expect(summary.context.data.ticks).toBe(2);
  });
});
