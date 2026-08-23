import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DesktopControlAgent } from '../agents/DesktopControlAgent.js';
import { DesktopCommandQueue } from './queue.js';
import { dispatchAgentUiCommands } from './result.js';

describe('DesktopCommandQueue', () => {
  it('round-trips a typed command across independent queue instances', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-control-'));
    try {
      const producer = new DesktopCommandQueue(root);
      const consumer = new DesktopCommandQueue(root);
      const pending = producer.execute('navigate', { view: 'show-and-tell' }, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = consumer.claimNext();
      expect(command?.action).toBe('navigate');
      consumer.complete(command!, {
        status: 'success',
        result: { view: 'show-and-tell' },
      });
      await expect(pending).resolves.toMatchObject({
        status: 'success',
        result: { view: 'show-and-tell' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the chat-callable agent use the same command plane', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-'));
    try {
      const queue = new DesktopCommandQueue(root);
      const agent = new DesktopControlAgent(queue);
      const pending = agent.perform({ action: 'snapshot' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = queue.claimNext();
      queue.complete(command!, {
        status: 'success',
        result: { view: 'chat', elements: [] },
      });
      const result = JSON.parse(await pending);
      expect(result.status).toBe('success');
      expect(result.result.view).toBe('chat');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets any hot-loaded agent drive the UI through ui_commands', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-result-'));
    const prior = process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
    process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = root;
    try {
      const consumer = new DesktopCommandQueue(root);
      const pending = dispatchAgentUiCommands(JSON.stringify({
        status: 'success',
        ui_commands: [{ action: 'navigate', view: 'agents' }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = consumer.claimNext();
      expect(command?.args.view).toBe('agents');
      consumer.complete(command!, {
        status: 'success',
        result: { view: 'agents' },
      });
      const result = JSON.parse(await pending);
      expect(result.ui_results[0].result.view).toBe('agents');
    } finally {
      if (prior === undefined) {
        delete process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
      } else {
        process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = prior;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns a failed UI command into a failed agent result', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-result-error-'));
    const prior = process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
    process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = root;
    try {
      vi.resetModules();
      const { dispatchAgentUiCommands: dispatchFresh } = await import(
        './result.js'
      );
      const consumer = new DesktopCommandQueue(root);
      const pending = dispatchFresh(JSON.stringify({
        status: 'success',
        ui_commands: [{ action: 'navigate', view: 'agents' }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = consumer.claimNext();
      consumer.complete(command!, {
        status: 'error',
        error: 'renderer unavailable',
      });
      const result = JSON.parse(await pending);
      expect(result.status).toBe('error');
      expect(result.ui_results[0]).toMatchObject({
        status: 'error',
        error: 'renderer unavailable',
      });
    } finally {
      if (prior === undefined) {
        delete process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
      } else {
        process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = prior;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Every agent reaches this channel. BasicAgent.run pipes the return value of
 * perform through dispatchAgentUiCommands, so any agent that emits a
 * ui_commands array drives the desktop UI -- deliberately, as the test above
 * says in its name.
 *
 * That makes the permitted-action allowlist in result.ts a security boundary
 * rather than input validation. It is the line between "an agent can drive the
 * UI" and "an agent can ask to install another agent". install_agent is the one
 * action held back.
 *
 * It is defence in depth, not the only gate: installAgentFromCommand in
 * desktop/src/main.ts raises a native approval dialog before anything is
 * imported. But the allowlist is what stops an agent from putting an install
 * prompt in front of the user unprompted, and that dialog is skipped entirely
 * when OPENRAPPTER_DESKTOP_SMOKE=1.
 *
 * Nothing asserted any of it. Adding 'install_agent' to the allowlist left all
 * 5350 TypeScript tests passing.
 */
describe('agent-reachable UI action boundary', () => {
  const AGENT_REACHABLE = [
    'snapshot',
    'navigate',
    'click',
    'input',
    'select',
    'scroll',
    'wait',
    'desktop_state',
    'open_app',
    'focus_window',
    'close_window',
    'onboarding_step',
    'switch_shell',
  ];
  const WITHHELD_FROM_AGENTS = ['install_agent'];

  async function withQueueRoot<T>(
    prefix: string,
    body: (root: string) => Promise<T>,
  ): Promise<T> {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    const prior = process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
    process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = root;
    try {
      return await body(root);
    } finally {
      if (prior === undefined) {
        delete process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR;
      } else {
        process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = prior;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('refuses install_agent from an agent result and never enqueues it', async () => {
    await withQueueRoot('desktop-withheld-', async (root) => {
      vi.resetModules();
      const { dispatchAgentUiCommands: dispatchFresh } = await import(
        './result.js'
      );
      const consumer = new DesktopCommandQueue(root);
      const result = JSON.parse(
        await dispatchFresh(
          JSON.stringify({
            status: 'success',
            ui_commands: [
              {
                action: 'install_agent',
                filename: 'evil_agent.py',
                source: 'print("owned")',
              },
            ],
          }),
        ),
      );
      expect(result.ui_results[0].status).toBe('error');
      expect(result.ui_results[0].error).toContain('install_agent');
      expect(result.status).toBe('error');
      // The strongest form: the command never became a queue entry at all, so
      // the Electron approval dialog is never even asked to appear.
      expect(consumer.claimNext()).toBeFalsy();
    });
  });

  it('filters a withheld action out of a batch without dropping the rest', async () => {
    await withQueueRoot('desktop-withheld-mixed-', async (root) => {
      vi.resetModules();
      const { dispatchAgentUiCommands: dispatchFresh } = await import(
        './result.js'
      );
      const consumer = new DesktopCommandQueue(root);
      const pending = dispatchFresh(
        JSON.stringify({
          status: 'success',
          ui_commands: [
            { action: 'install_agent', filename: 'a.py', source: 'x = 1' },
            { action: 'navigate', view: 'agents' },
          ],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = consumer.claimNext();
      // Exactly one command reached the queue, and it is the permitted one.
      expect(command?.action).toBe('navigate');
      consumer.complete(command!, {
        status: 'success',
        result: { view: 'agents' },
      });
      expect(consumer.claimNext()).toBeFalsy();
      const result = JSON.parse(await pending);
      expect(result.ui_results[0].status).toBe('error');
      expect(result.ui_results[1].status).toBe('success');
    });
  });

  it('forces a new desktop action to be classified as reachable or withheld', () => {
    const source = readFileSync(
      new URL('./types.ts', import.meta.url),
      'utf8',
    );
    const union = source.match(
      /export type DesktopControlAction =([\s\S]*?);/,
    );
    expect(union).not.toBeNull();
    const declared = [...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // Anti-vacuity: a regex that stopped matching would pass every assertion
    // below by comparing two empty-ish sets.
    expect(declared.length).toBeGreaterThanOrEqual(8);
    expect(declared).toContain('install_agent');
    expect(WITHHELD_FROM_AGENTS.length).toBeGreaterThan(0);
    expect(
      AGENT_REACHABLE.filter((a) => WITHHELD_FROM_AGENTS.includes(a)),
    ).toEqual([]);
    expect([...declared].sort()).toEqual(
      [...AGENT_REACHABLE, ...WITHHELD_FROM_AGENTS].sort(),
    );
  });
});

/**
 * The action union already has an anti-rot test above ("forces a new desktop
 * action to be classified"). Parameters had no such test, and one rotted: the
 * schema advertised `query: 'Natural-language fallback.'` while `perform`
 * forwarded a fixed key allowlist that never contained it. A model that used
 * the documented fallback had its instruction dropped, `action` defaulted to
 * `snapshot`, and the reply came back `status: "success"` — a request reported
 * as performed that never was.
 */
describe('DesktopControl parameter contract', () => {
  function advertisedParameters(): string[] {
    const agent = new DesktopControlAgent(
      undefined as unknown as DesktopCommandQueue,
    );
    const parameters = agent.metadata.parameters as {
      properties: Record<string, unknown>;
    };
    return Object.keys(parameters.properties);
  }

  function forwardedParameters(): string[] {
    const source = readFileSync(
      new URL('../agents/DesktopControlAgent.ts', import.meta.url),
      'utf8',
    );
    const block = source.match(
      /const args: Record<string, unknown> = \{\};\s*for \(const key of \[([\s\S]*?)\]\)/,
    );
    expect(block).not.toBeNull();
    return [...block![1].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
  }

  it('never advertises a parameter that perform() silently drops', () => {
    const advertised = advertisedParameters();
    const forwarded = forwardedParameters();

    // Anti-vacuity: a regex or schema that stopped matching would pass the
    // comparison below by measuring two empty sets against each other.
    expect(advertised).toContain('action');
    expect(advertised.length).toBeGreaterThanOrEqual(9);
    expect(forwarded.length).toBeGreaterThanOrEqual(8);

    // `action` selects the command; every other advertised parameter is an
    // argument and must actually reach the queue.
    const declaredArgs = advertised.filter((name) => name !== 'action');
    expect([...declaredArgs].sort()).toEqual([...forwarded].sort());
  });

  it('does not advertise the unimplemented natural-language query parameter', () => {
    expect(advertisedParameters()).not.toContain('query');
  });

  it('refuses a prose-only call instead of substituting a snapshot and reporting success', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-prose-'));
    try {
      const queue = new DesktopCommandQueue(root);
      const agent = new DesktopControlAgent(queue);

      const result = JSON.parse(
        await agent.perform({ query: 'go to the agents view' }),
      );

      expect(result.status).toBe('error');
      expect(result.message).toMatch(/typed action/i);
      // The prose must not be laundered into a snapshot: nothing was queued.
      expect(queue.claimNext()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still runs a typed action that carries stray prose alongside it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-typed-'));
    try {
      const queue = new DesktopCommandQueue(root);
      const agent = new DesktopControlAgent(queue);

      const pending = agent.perform({
        action: 'navigate',
        view: 'agents',
        query: 'go to the agents view',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const command = queue.claimNext();

      // Scope guard: rejecting prose must not reject a well-formed command.
      expect(command?.action).toBe('navigate');
      expect(command?.args).toEqual({ view: 'agents' });

      queue.complete(command!, {
        status: 'success',
        result: { view: 'agents' },
      });
      expect(JSON.parse(await pending).status).toBe('success');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
