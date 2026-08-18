import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerApprovalsCommand } from '../approvals.js';

/**
 * A command the safety policy gates has to be resolvable.
 *
 * The gateway has served `exec.pending` and `exec.respond` for some time, and
 * the only production client calling them was the macOS menu bar app. On Linux
 * and Windows a gated command could be requested and never granted: the agent
 * returns an approval id and there was nowhere to take it. Widening what needs
 * approval — `git`, environment assignments, plantable paths — made that gap
 * matter more often.
 *
 * These assert the wire contract, because the value of this command is that it
 * speaks the same one the Bar does.
 */

const calls: Array<{ method: string; params?: unknown }> = [];

vi.mock('../rpc-client.js', () => ({
  RpcClient: class {
    async connect(): Promise<void> {}
    disconnect(): void {}
    async call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      if (method === 'exec.pending') {
        return [{
          id: 'token_1',
          cmd: 'LD_PRELOAD=/tmp/evil.so ls',
          reason: 'Environment assignment before the command can change what it loads',
        }];
      }
      return { ok: true };
    }
  },
}));

async function run(args: string[]): Promise<void> {
  calls.length = 0;
  const program = new Command();
  program.exitOverride();
  registerApprovalsCommand(program);
  await program.parseAsync(['node', 'openrappter', 'approvals', ...args]);
}

describe('openrappter approvals', () => {
  it('lists what is waiting, with the reason', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
    await run(['list']);
    spy.mockRestore();

    expect(calls[0].method).toBe('exec.pending');
    const output = lines.join('\n');
    expect(output).toContain('token_1');
    expect(output).toContain('LD_PRELOAD=/tmp/evil.so ls');
    // The reason is the point: the command alone reads as an ordinary `ls`.
    expect(output).toContain('Environment assignment');
  });

  it('approves with an explicit boolean, never an inferred decision', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['approve', 'token_1']);
    spy.mockRestore();

    expect(calls[0]).toEqual({
      method: 'exec.respond',
      params: { approvalId: 'token_1', approved: true },
    });
  });

  it('denies with an explicit boolean too', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['deny', 'token_1']);
    spy.mockRestore();

    expect(calls[0]).toEqual({
      method: 'exec.respond',
      params: { approvalId: 'token_1', approved: false },
    });
  });

  it('uses the same method names the Bar calls', () => {
    // If these drift, one client resolves approvals and the other does not,
    // which is the state this command exists to end. Read from the Bar's own
    // source rather than restated here, so a rename there fails this.
    const barClient = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../macos/Sources/OpenRappterBar/Services/RpcClient.swift',
      ),
      'utf8',
    );
    const ours = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../approvals.ts'),
      'utf8',
    );
    for (const method of ['exec.pending', 'exec.respond']) {
      expect(barClient, `Bar should call ${method}`).toContain(`"${method}"`);
      expect(ours, `this command should call ${method}`).toContain(`'${method}'`);
    }
  });
});
