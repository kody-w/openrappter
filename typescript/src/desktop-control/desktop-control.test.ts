import { mkdtempSync, rmSync } from 'node:fs';
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
