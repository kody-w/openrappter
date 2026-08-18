import { describe, it, expect, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerMemoryCommand } from '../memory.js';

/**
 * `openrappter memory` has to reach the memory the product keeps.
 *
 * The module was complete and never registered, so the command fell through to
 * the `[message]` positional and was sent to the model as a chat prompt. It was
 * left unregistered on purpose: it built a `MemoryManager`, which holds
 * everything in `Map`s and performs no file I/O, so `add` printed an id and
 * discarded it on exit. Registering that would have been worse than the command
 * not existing. #204
 *
 * The product's memory is `MemoryAgent`'s, in `~/.openrappter/memory.json`.
 * What matters is therefore not that the command runs, but that what it writes
 * is still there afterwards — so this asserts a round trip through a scratch
 * home, which the previous implementation could not have passed.
 */

const originalHome = process.env.HOME;
const scratchHomes: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of scratchHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function scratchHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cli-'));
  scratchHomes.push(dir);
  process.env.HOME = dir;
  return dir;
}

async function runMemory(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    lines.push(a.join(' '));
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);
    await program.parseAsync(['node', 'openrappter', 'memory', ...args]);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('openrappter memory', () => {
  it('writes to the file the product reads', async () => {
    const home = scratchHome();
    await runMemory(['add', 'the kettle is in the third cupboard']);

    const stored = path.join(home, '.openrappter', 'memory.json');
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored, 'utf8')).toContain('third cupboard');
  });

  it('recalls what an earlier invocation remembered', async () => {
    scratchHome();
    await runMemory(['add', 'the kettle is in the third cupboard']);

    // A separate command object, reading from disk rather than from anything
    // the first invocation left in memory — the distinction the old
    // implementation could not make.
    const found = await runMemory(['search', 'kettle']);
    expect(found).toMatch(/1 matching|third cupboard/i);
  });

  it('refuses to forget without --yes', async () => {
    scratchHome();
    await runMemory(['add', 'the kettle is in the third cupboard']);
    const output = await runMemory(['forget', 'kettle']);

    expect(output).toContain('WARNING');
    const found = await runMemory(['search', 'kettle']);
    expect(found).toMatch(/1 matching|third cupboard/i);
  });
});
