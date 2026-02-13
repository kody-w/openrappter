/**
 * OpenRappter Quickstart Demo
 *
 * Zero API keys. Zero config. Shows data sloshing, ShellAgent,
 * MemoryAgent, and agent chaining — all running locally.
 *
 * Run: npx tsx examples/quickstart.ts
 */

import chalk from 'chalk';
import { ShellAgent } from '../src/agents/ShellAgent.js';
import { MemoryAgent } from '../src/agents/MemoryAgent.js';
import type { AgentContext } from '../src/agents/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

const dim = chalk.dim;
const bold = chalk.bold;
const cyan = chalk.cyan;
const green = chalk.green;
const yellow = chalk.yellow;
const magenta = chalk.magenta;

function hr() {
  console.log(dim('─'.repeat(60)));
}

function step(n: number, title: string) {
  console.log();
  hr();
  console.log(bold.cyan(`  Step ${n}: ${title}`));
  hr();
  console.log();
}

function label(key: string, value: unknown) {
  const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
  console.log(`  ${dim(key.padEnd(22))} ${val}`);
}

function pause(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // ── Banner ───────────────────────────────────────────────────────
  console.log();
  console.log(bold.green('  ╔══════════════════════════════════════════════════╗'));
  console.log(bold.green('  ║') + bold('       openrappter — quickstart demo             ') + bold.green('║'));
  console.log(bold.green('  ╚══════════════════════════════════════════════════╝'));
  console.log();
  console.log(dim('  Zero API keys. Zero config. Pure local agents.'));
  console.log(dim('  Everything below runs on your machine, right now.'));
  console.log();

  // ── Step 1: Data Sloshing ────────────────────────────────────────
  step(1, 'Data Sloshing — automatic context enrichment');

  console.log(dim('  Every agent call enriches context BEFORE it acts.'));
  console.log(dim('  Let\'s slosh a simple query and see what comes out.\n'));

  const shell = new ShellAgent();
  const query = 'What files changed in my project today?';
  console.log(`  Query: ${cyan(`"${query}"`)}`);
  console.log();

  const ctx: AgentContext = shell.slosh(query);

  console.log(yellow('  Temporal signals:'));
  label('time_of_day', ctx.temporal.time_of_day);
  label('day_of_week', ctx.temporal.day_of_week);
  label('is_weekend', ctx.temporal.is_weekend);
  label('quarter', ctx.temporal.quarter);
  label('fiscal', ctx.temporal.fiscal);
  label('likely_activity', ctx.temporal.likely_activity);
  console.log();

  console.log(yellow('  Query analysis:'));
  label('specificity', ctx.query_signals.specificity);
  label('word_count', ctx.query_signals.word_count);
  label('is_question', ctx.query_signals.is_question);
  label('hints', ctx.query_signals.hints);
  console.log();

  console.log(yellow('  Orientation (synthesized):'));
  label('confidence', ctx.orientation.confidence);
  label('approach', ctx.orientation.approach);
  label('hints', ctx.orientation.hints);
  label('response_style', ctx.orientation.response_style);
  console.log();

  console.log(
    bold.magenta('  8 words in. 20+ signals out. That\'s data sloshing.')
  );

  await pause(500);

  // ── Step 2: ShellAgent ───────────────────────────────────────────
  step(2, 'ShellAgent — system interaction');

  console.log(dim('  ShellAgent wraps bash, file reads, and dir listing.\n'));

  console.log(green('  > shell.execute({ action: "list", path: "." })'));
  const listResult = JSON.parse(
    await shell.execute({ action: 'list', path: '.' })
  );
  const files = listResult.items?.slice(0, 8) ?? [];
  for (const f of files) {
    const icon = f.type === 'directory' ? '/' : '';
    console.log(`    ${dim(f.type === 'directory' ? 'd' : 'f')}  ${f.name}${icon}`);
  }
  if ((listResult.count ?? 0) > 8) {
    console.log(dim(`    ... and ${listResult.count - 8} more`));
  }
  console.log();

  console.log(green('  > shell.execute({ action: "bash", command: "node --version" })'));
  const nodeResult = JSON.parse(
    await shell.execute({ action: 'bash', command: 'node --version' })
  );
  console.log(`    ${nodeResult.output?.trim()}`);
  console.log();

  console.log(dim('  Context was enriched internally before each action.'));

  await pause(500);

  // ── Step 3: MemoryAgent ──────────────────────────────────────────
  step(3, 'MemoryAgent — persistent memory');

  const memory = new MemoryAgent();
  const memMsg = 'openrappter quickstart completed successfully';

  console.log(green(`  > memory.execute({ action: "remember", message: "...", theme: "milestone" })`));
  const rememberResult = JSON.parse(
    await memory.execute({
      action: 'remember',
      message: memMsg,
      theme: 'milestone',
    })
  );
  console.log(`    ${rememberResult.message}`);
  console.log();

  console.log(green('  > memory.execute({ action: "recall", query: "quickstart" })'));
  const recallResult = JSON.parse(
    await memory.execute({ action: 'recall', query: 'quickstart' })
  );
  console.log(`    ${recallResult.message}`);
  for (const m of recallResult.matches ?? []) {
    console.log(`    ${dim('-')} ${m.message} ${dim(`[${m.theme}]`)}`);
  }
  console.log();
  console.log(dim('  Persisted to ~/.openrappter/memory.json'));

  await pause(500);

  // ── Step 4: Agent Chaining ───────────────────────────────────────
  step(4, 'Agent Chaining — data_slush pipeline');

  console.log(dim('  Agents pass context to each other via data_slush.'));
  console.log(dim('  No LLM needed — just structured signal flow.\n'));

  console.log(green('  > shell.execute({ action: "bash", command: "whoami" })'));
  const whoamiResult = JSON.parse(
    await shell.execute({ action: 'bash', command: 'whoami' })
  );
  const username = whoamiResult.output?.trim();
  console.log(`    ${username}`);
  console.log();

  console.log(green('  > shell.slushOut({ signals: { username } })'));
  const slush = shell.slushOut({
    signals: { username },
    confidence: 'high',
  });
  console.log(yellow('  data_slush package:'));
  label('source_agent', slush.source_agent);
  label('timestamp', (slush.timestamp as string).slice(0, 19));
  label('confidence', slush.confidence);
  label('signals', slush.signals);
  if (slush.orientation) label('orientation', slush.orientation);
  if (slush.temporal_snapshot) label('temporal_snapshot', slush.temporal_snapshot);
  console.log();

  console.log(green('  > memory.execute({ ..., upstream_slush: slush })'));
  await memory.execute({
    action: 'remember',
    message: `User ${username} ran the quickstart demo`,
    theme: 'event',
    upstream_slush: slush,
  });
  console.log(`    Memory received upstream context from Shell.`);
  console.log();

  const upstreamAgent = (memory.context?.upstream_slush as Record<string, unknown>)?.source_agent;
  console.log(
    `  ${dim('memory.context.upstream_slush.source_agent ===')} ${bold.magenta(String(upstreamAgent))}`
  );
  console.log();
  console.log(
    bold.magenta('  Shell talked to Memory. No LLM needed. Just data_slush.')
  );

  await pause(500);

  // ── Next Steps ───────────────────────────────────────────────────
  step(5, 'What\'s next?');

  console.log(`  ${cyan('Read the code')}      typescript/examples/quickstart.ts`);
  console.log(`  ${cyan('Create an agent')}    Add a new *Agent.ts in src/agents/`);
  console.log(`  ${cyan('Run full system')}    cd typescript && npm run dev`);
  console.log(`  ${cyan('Run tests')}          cd typescript && npm test`);
  console.log(`  ${cyan('Documentation')}      https://kody-w.github.io/openrappter`);
  console.log();
  hr();
  console.log(dim('  Done. Explore, build, break things.'));
  console.log();
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
