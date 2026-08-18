import type { Command } from 'commander';

import { MemoryAgent } from '../agents/MemoryAgent.js';

/**
 * Read and write the memory the product actually keeps.
 *
 * This module existed, implemented `search`/`add`/`list`/`clear`/`stats`, was
 * re-exported from `cli/index.ts` — and was never registered, so `openrappter
 * memory` fell through to the `[message]` positional and went to the model as a
 * chat prompt.
 *
 * Registering it as it stood would have been worse than leaving it out. It built
 * a `MemoryManager`, which keeps everything in `Map`s and performs no file I/O
 * at all, so every invocation started empty: `memory add` printed an id and
 * discarded it on exit, `memory list` reported nothing afterwards, and
 * `memory clear` cleared zero. #204
 *
 * The memory the product keeps is `MemoryAgent`'s, in
 * `~/.openrappter/memory.json` — the same file `anatomy.ts` reads and `doctor`
 * inspects. So this drives that agent rather than standing a second,
 * non-persistent store beside it.
 *
 * There is no `clear`. `MemoryAgent` forgets by query, not wholesale, and a
 * command that said "Delete all memories" while doing nothing of the sort is the
 * mistake this file already made once.
 */

interface AgentResult {
  status?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Agents here do not throw: `execute()` returns a JSON string and reports
 * failure as `{"status":"error"}` inside it. Trusting the absence of an
 * exception is how #134 recorded an alert as delivered that was never sent.
 */
async function run(input: Record<string, unknown>): Promise<AgentResult> {
  const raw = await new MemoryAgent().execute(input);
  let parsed: AgentResult;
  try {
    parsed = JSON.parse(raw) as AgentResult;
  } catch {
    throw new Error(`Memory returned something that is not JSON: ${raw.slice(0, 200)}`);
  }
  if (parsed.status === 'error') {
    throw new Error(parsed.error ?? parsed.message ?? 'Memory reported an error');
  }
  return parsed;
}

function show(result: AgentResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const text = result.message ?? result.response ?? result.result;
  console.log(typeof text === 'string' && text ? text : JSON.stringify(result, null, 2));
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('Search and record what this rappter remembers');

  memory
    .command('list', { isDefault: true })
    .description('List what is remembered')
    .option('--json', 'Print the raw response')
    .action(async (options: { json?: boolean }) => {
      show(await run({ action: 'list' }), Boolean(options.json));
    });

  memory
    .command('search <query>')
    .description('Recall memories matching a query')
    .option('--json', 'Print the raw response')
    .action(async (query: string, options: { json?: boolean }) => {
      show(await run({ action: 'recall', query }), Boolean(options.json));
    });

  memory
    .command('add <content>')
    .description('Remember something')
    .option('--theme <theme>', 'Group this memory under a theme')
    .option('--json', 'Print the raw response')
    .action(async (content: string, options: { theme?: string; json?: boolean }) => {
      show(
        await run({ action: 'remember', message: content, theme: options.theme }),
        Boolean(options.json),
      );
    });

  memory
    .command('forget <query>')
    .description('Forget memories matching a query')
    .option('--yes', 'Skip confirmation prompt')
    .option('--json', 'Print the raw response')
    .action(async (query: string, options: { yes?: boolean; json?: boolean }) => {
      if (!options.yes) {
        console.log(`WARNING: This deletes memories matching "${query}".`);
        console.log('Run with --yes to confirm.');
        return;
      }
      show(await run({ action: 'forget', query }), Boolean(options.json));
    });
}
