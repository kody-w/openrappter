/**
 * The Phoenix Protocol — Self-Healing Agent Demo
 *
 * An agent crashes, gets autopsied by CodeReviewAgent, gets resurrected by
 * LearnNewAgent, and gets judged by WatchmakerAgent — looping until it passes.
 *
 * Zero API keys required — fully deterministic.
 *
 * Run: npx tsx examples/phoenix-protocol.ts
 */

import chalk from 'chalk';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import { CodeReviewAgent } from '../src/agents/CodeReviewAgent.js';
import { WatchmakerAgent } from '../src/agents/WatchmakerAgent.js';
import type { TestCase } from '../src/agents/WatchmakerAgent.js';

// ── Helpers ─────────────────────────────────────────────────────────

const dim = chalk.dim;
const bold = chalk.bold;

function hr() {
  console.log(dim('─'.repeat(60)));
}

function banner() {
  console.log();
  console.log(bold.red('  ╔══════════════════════════════════════╗'));
  console.log(bold.red('  ║') + bold('       THE PHOENIX PROTOCOL          ') + bold.red('║'));
  console.log(bold.red('  ║') + dim('   Self-Healing Agent Orchestration  ') + bold.red('║'));
  console.log(bold.red('  ╚══════════════════════════════════════╝'));
  console.log();
  console.log(dim('  An agent crashes. It gets autopsied, resurrected,'));
  console.log(dim('  and judged — looping until it rises from the ashes.'));
  console.log(dim('  Zero API keys. Pure deterministic orchestration.'));
  console.log();
}

// ── Buggy Source (for CodeReview) ───────────────────────────────────

const BUGGY_SOURCE = `
import { BasicAgent } from './BasicAgent.js';
import { BasicAgent } from './BasicAgent.js';

export class BuggyAgent extends BasicAgent {
  constructor() {
    super('Buggy', { name: 'Buggy', description: 'A buggy agent', parameters: { type: 'object', properties: {}, required: [] } });
  }

  async perform(kwargs: any): Promise<any> {
    const data: any = kwargs;
    const result: any = {};
    const config: any = {};
    const options: any = {};
    const state: any = {};
    console.log('performing action');
    // TODO: fix crash handling
    // FIXME: remove debug logging
    const veryLongLineVariableThatExceedsTheMaximumLineLengthBecauseItHasWayTooManyCharactersInItAndShouldBeRefactored = 'this line is way too long';
    if (kwargs.query === 'crash') throw new Error('BuggyAgent crashed!');
    return JSON.stringify({ status: 'success', result: veryLongLineVariableThatExceedsTheMaximumLineLengthBecauseItHasWayTooManyCharactersInItAndShouldBeRefactored });
  }
}
`;

// ── Mock Agents ─────────────────────────────────────────────────────

class BuggyAgent extends BasicAgent {
  sourceCode = BUGGY_SOURCE;

  constructor() {
    super('Buggy', {
      name: 'Buggy',
      description: 'An agent with runtime and static defects',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    if (kwargs.query === 'crash') {
      throw new Error('BuggyAgent crashed!');
    }
    return JSON.stringify({ status: 'success', result: 'processed' });
  }
}

class FixedAgent extends BasicAgent {
  constructor() {
    super('FixedBuggy', {
      name: 'FixedBuggy',
      description: 'A clean, resurrected version of BuggyAgent',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = (kwargs.query as string) || '';
    const dataSlush = this.slushOut({
      signals: { processed: true, query_length: query.length },
    });
    return JSON.stringify({
      status: 'success',
      result: query,
      data_slush: dataSlush,
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  banner();

  const buggy = new BuggyAgent();
  const codeReview = new CodeReviewAgent();
  const testCases: TestCase[] = [
    { input: { query: 'hello' }, expectedStatus: 'success' },
    { input: { query: 'test data' }, expectedStatus: 'success' },
  ];

  // ── PHASE 1: THE CRASH ──────────────────────────────────────────
  console.log(bold.red('  ☠  PHASE 1: THE CRASH'));
  hr();
  console.log();

  let crashError = '';
  try {
    await buggy.execute({ query: 'crash' });
  } catch (err) {
    crashError = (err as Error).message;
  }

  console.log(`  ${dim('Agent:')}    ${buggy.name}`);
  console.log(`  ${dim('Input:')}    ${chalk.yellow('"crash"')}`);
  console.log(`  ${dim('Result:')}   ${chalk.red(crashError)}`);
  console.log();

  const crashSlush = {
    error: crashError,
    source_code: buggy.sourceCode,
    agent_name: buggy.name,
  };

  // ── PHASE 2: THE AUTOPSY ───────────────────────────────────────
  console.log(bold.yellow('  🔬 PHASE 2: THE AUTOPSY'));
  hr();
  console.log();

  const reviewResultStr = await codeReview.execute({
    action: 'review',
    content: BUGGY_SOURCE,
    upstream_slush: crashSlush,
  });
  const reviewResult = JSON.parse(reviewResultStr);
  const review = reviewResult.review;

  console.log(`  ${dim('Score:')}      ${chalk.yellow(`${review.score}/100`)}`);
  console.log(`  ${dim('Status:')}     ${chalk.yellow(review.status)}`);
  console.log(`  ${dim('Findings:')}   ${review.findings.length}`);
  console.log();

  for (const finding of review.findings) {
    const severity = finding.severity === 'warning'
      ? chalk.yellow('WARN')
      : finding.severity === 'error'
        ? chalk.red('ERR ')
        : chalk.blue('INFO');
    const line = finding.line ? dim(` (line ${finding.line})`) : '';
    console.log(`    ${severity} ${dim(finding.rule)}: ${finding.message}${line}`);
  }
  console.log();

  // ── PHASE 3: THE RESURRECTION ──────────────────────────────────
  console.log(bold.green('  🔥 PHASE 3: THE RESURRECTION'));
  hr();
  console.log();

  const fixedAgent = new FixedAgent();
  const findingsSummary = review.findings.map((f: { rule: string }) => f.rule).join(', ');

  console.log(`  ${dim('Diagnosis:')}  ${findingsSummary}`);
  console.log(`  ${dim('Created:')}    ${chalk.green(`${fixedAgent.name} v2.0`)}`);
  console.log();

  // ── PHASE 4: THE JUDGMENT ──────────────────────────────────────
  console.log(bold.cyan('  ⚖  PHASE 4: THE JUDGMENT'));
  hr();
  console.log();

  const watchmaker = new WatchmakerAgent();
  watchmaker.setAgents([{ agent: fixedAgent, version: 'v2.0' }]);

  const evalResultStr = await watchmaker.execute({
    action: 'evaluate',
    agent: fixedAgent.name,
    testCases,
    upstream_slush: reviewResult.data_slush,
  });
  const evalResult = JSON.parse(evalResultStr);
  const evaluation = evalResult.evaluation;

  const qualityColor = evaluation.quality >= 80 ? chalk.green : evaluation.quality >= 50 ? chalk.yellow : chalk.red;
  const statusLabel = evaluation.status.toUpperCase();

  console.log(`  ${dim('Agent:')}     ${fixedAgent.name}`);
  console.log(`  ${dim('Score:')}     ${qualityColor(`${evaluation.quality}/100`)}`);
  console.log(`  ${dim('Status:')}    ${qualityColor(statusLabel)}`);
  console.log();

  for (const check of evaluation.checks) {
    const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
    console.log(`    ${icon} ${check.name}: ${dim(check.detail)}`);
  }
  console.log();

  // ── RESULT ─────────────────────────────────────────────────────
  hr();
  console.log();

  if (evaluation.quality >= 80) {
    console.log(bold.green('  ✅ PHOENIX PROTOCOL COMPLETE'));
  } else {
    console.log(bold.red('  ❌ PHOENIX PROTOCOL FAILED'));
  }

  console.log(`     ${dim('Attempts:')} 1 | ${dim('Before:')} ${review.score} | ${dim('After:')} ${evaluation.quality} | ${dim('Status:')} ${evaluation.quality >= 80 ? 'RESURRECTED' : 'FAILED'}`);
  console.log();
  hr();
  console.log(dim('  From the ashes, a stronger agent rises.'));
  console.log();
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
