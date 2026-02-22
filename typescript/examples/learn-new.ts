/**
 * LearnNewAgent + AgentChain Demo — The Droste Effect
 *
 * Watches LearnNewAgent create a brand new agent from a description,
 * hot-load it, then chain it through a pipeline with ShellAgent.
 * Agents building agents, wired together, zero manual code.
 *
 * Zero API keys required — template-based generation.
 *
 * Run: npx tsx examples/learn-new.ts
 */

import chalk from 'chalk';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LearnNewAgent } from '../src/agents/LearnNewAgent.js';
import { ShellAgent } from '../src/agents/ShellAgent.js';
import { AgentChain } from '../src/agents/chain.js';

// ── Helpers ──────────────────────────────────────────────────────────

const dim = chalk.dim;
const bold = chalk.bold;
const cyan = chalk.cyan;
const green = chalk.green;
const yellow = chalk.yellow;
const magenta = chalk.magenta;
const red = chalk.red;

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
  // Use a temp dir so we don't pollute the real agents dir
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-new-demo-'));

  // ── Banner ───────────────────────────────────────────────────────
  console.log();
  console.log(bold.green('  ╔══════════════════════════════════════════════════╗'));
  console.log(bold.green('  ║') + bold('  LearnNewAgent + AgentChain — The Droste Effect  ') + bold.green('║'));
  console.log(bold.green('  ╚══════════════════════════════════════════════════╝'));
  console.log();
  console.log(dim('  Agents that build agents, chained together.'));
  console.log(dim('  Zero API keys. Zero config. Pure runtime generation.'));
  console.log();

  try {
    // ── Step 1: Create the meta-agent ───────────────────────────
    step(1, 'Initialize LearnNewAgent');

    const learner = new LearnNewAgent(tmpDir);
    console.log(`  ${dim('Name:')}          ${learner.name}`);
    console.log(`  ${dim('Agents dir:')}    ${tmpDir}`);
    console.log(`  ${dim('Actions:')}       create, list, delete`);
    console.log();

    await pause(300);

    // ── Step 2: Generate Agent #1 — a text analyzer ─────────────
    step(2, 'Generate Agent #1 — TextAnalyzer');

    console.log(dim('  Describing the agent in natural language...'));
    console.log(`  ${cyan('"analyze text and count word frequency"')}`);
    console.log();

    const result1 = JSON.parse(await learner.execute({
      description: 'analyze text and count word frequency',
      name: 'TextAnalyzer',
    }));

    label('status', result1.status);
    label('agent_name', result1.agent_name);
    label('hot_loaded', result1.hot_loaded);
    label('file_path', result1.file_path);
    console.log();

    if (result1.status === 'success') {
      console.log(green('  Agent created and hot-loaded successfully.'));
    } else {
      console.log(red(`  Error: ${result1.message}`));
    }

    await pause(300);

    // ── Step 3: Generate Agent #2 — a greeter ───────────────────
    step(3, 'Generate Agent #2 — Greeter');

    console.log(dim('  Creating a second agent from description...'));
    console.log(`  ${cyan('"generate personalized greetings"')}`);
    console.log();

    const result2 = JSON.parse(await learner.execute({
      description: 'generate personalized greetings',
      name: 'Greeter',
    }));

    label('status', result2.status);
    label('agent_name', result2.agent_name);
    label('hot_loaded', result2.hot_loaded);
    console.log();

    await pause(300);

    // ── Step 4: List all generated agents ────────────────────────
    step(4, 'List generated agents');

    const listResult = JSON.parse(await learner.execute({ action: 'list' }));
    console.log(`  ${bold(`${listResult.count} agents`)} found in ${dim(tmpDir)}`);
    console.log();
    for (const agent of listResult.agents) {
      const tag = agent.auto_generated ? green('auto') : yellow('manual');
      console.log(`    ${tag}  ${agent.name} ${dim(`(${agent.file})`)}`);
    }
    console.log();

    await pause(300);

    // ── Step 5: Execute the generated agent ──────────────────────
    step(5, 'Execute the generated TextAnalyzer');

    const textAnalyzer = learner.getLoadedAgents().get('TextAnalyzer');
    if (textAnalyzer) {
      const testInput = 'the quick brown fox jumps over the lazy dog the fox the dog';
      console.log(`  ${dim('Input:')} ${yellow(`"${testInput}"`)}`);
      console.log();

      const analyzeResult = JSON.parse(await textAnalyzer.execute({ query: testInput }));
      label('status', analyzeResult.status);
      label('result', analyzeResult.result ?? analyzeResult.query);
      console.log();
      console.log(magenta('  A brand new agent, born from a sentence, executing live.'));
    } else {
      console.log(red('  TextAnalyzer not found in loaded agents.'));
    }

    await pause(300);

    // ── Step 6: Chain agents together ────────────────────────────
    step(6, 'AgentChain — pipe Shell → TextAnalyzer');

    const shell = new ShellAgent();
    const chain = new AgentChain()
      .add('system-info', shell, { action: 'bash', command: 'echo "hello world from the chain pipeline"' })
      .add('analyze', textAnalyzer!, {}, (prevResult) => ({
        query: (prevResult as Record<string, unknown>).output as string ?? 'no output',
      }));

    console.log(`  ${dim('Chain:')} ${chain.getStepNames().join(' → ')}`);
    console.log(dim('  data_slush flows automatically between steps.'));
    console.log();

    const chainResult = await chain.run();

    label('chain status', chainResult.status);
    label('total duration', `${chainResult.totalDurationMs}ms`);
    label('steps completed', chainResult.steps.length);
    console.log();

    for (const s of chainResult.steps) {
      const icon = s.result.status === 'success' ? green('✓') : red('✗');
      console.log(`    ${icon} ${s.name} ${dim(`(${s.agentName}, ${s.durationMs}ms)`)}`);
      if (s.dataSlush) {
        console.log(`      ${dim('slush →')} source=${dim(String(s.dataSlush.source_agent))}`);
      }
    }
    console.log();
    console.log(magenta('  Shell talked to a runtime-generated agent via data_slush.'));

    await pause(300);

    // ── Step 7: Delete an agent ──────────────────────────────────
    step(7, 'Cleanup — delete Greeter agent');

    const deleteResult = JSON.parse(await learner.execute({
      action: 'delete',
      name: 'Greeter',
    }));

    label('status', deleteResult.status);
    label('message', deleteResult.message);
    console.log();

    const finalList = JSON.parse(await learner.execute({ action: 'list' }));
    console.log(`  ${bold(`${finalList.count} agent(s)`)} remaining.`);
    console.log();

    // ── Wrap up ──────────────────────────────────────────────────
    step(8, "What's next?");

    console.log(`  ${cyan('Generate with LLM')}   new LearnNewAgent(dir, provider)`);
    console.log(`  ${cyan('Chain agents')}        new AgentChain().add(...).add(...).run()`);
    console.log(`  ${cyan('Run prompts')}         See PROMPTS.md #31-40`);
    console.log(`  ${cyan('Run tests')}           cd typescript && npm test`);
    console.log();
    hr();
    console.log(dim('  Agents building agents. The Droste Effect.'));
    console.log();

  } finally {
    // Clean up temp dir
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

main().catch((err) => {
  console.error(red(`\nError: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
