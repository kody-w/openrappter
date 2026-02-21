/**
 * Ouroboros Showstopper — 10-run lineage evolution demo
 *
 * Feeds a carefully crafted input that lights up every capability,
 * then runs it 10 times to watch the lineage system evolve.
 *
 * Run: npx tsx examples/ouroboros-showstopper.ts
 */

import chalk from 'chalk';
import { OuroborosAgent } from '../src/agents/OuroborosAgent.js';

const dim = chalk.dim;
const bold = chalk.bold;

function hr() {
  console.log(dim('─'.repeat(72)));
}

const INPUT = 'The market crashed 2024-01-15, losing $2.3B. Contact panic@sell.now. Amazing disaster. http://doom.com';

async function main() {
  console.log();
  console.log(bold.red('  ╔══════════════════════════════════════════════════════════════════╗'));
  console.log(bold.red('  ║') + bold('   Ouroboros Showstopper — 10-Run Lineage Evolution              ') + bold.red('║'));
  console.log(bold.red('  ╚══════════════════════════════════════════════════════════════════╝'));
  console.log();
  console.log(dim('  Input: ') + chalk.yellow(`"${INPUT}"`));
  console.log(dim('  This input activates every capability: dates, numbers, emails,'));
  console.log(dim('  URLs, mixed sentiment, rich vocabulary, and cipher-friendly text.'));
  console.log();
  hr();

  const RUNS = 10;

  for (let run = 1; run <= RUNS; run++) {
    const agent = new OuroborosAgent();
    const resultStr = await agent.execute({ input: INPUT });
    const result = JSON.parse(resultStr);
    const report = result.report;

    // Header
    console.log();
    console.log(bold(`  Run ${String(run).padStart(2)}/${RUNS}`) + dim(` ─── overall: `) + statusColor(report.status)(`${report.overall_quality}/100 ${report.status}`));

    // Per-capability one-liner
    for (const cap of report.capabilities) {
      const bar = progressBar(cap.quality, 20);
      const trend = cap.trend?.direction
        ? (cap.trend.direction === 'improving' ? chalk.green(` ▲ x${cap.trend.multiplier}`) : chalk.red(` ▼ x${cap.trend.multiplier}`))
        : '';
      console.log(`    ${cap.capability.padEnd(22)} ${bar} ${String(cap.quality).padStart(3)}/100 ${statusColor(cap.status)(cap.status)}${trend}`);
    }

    // Lineage info
    if (report.lineage) {
      const l = report.lineage;
      const trendIcon = l.trend === 'improving' ? chalk.green('▲') : l.trend === 'declining' ? chalk.red('▼') : chalk.yellow('─');
      const trajStr = l.trajectory > 0 ? chalk.green(`+${l.trajectory}`) : l.trajectory < 0 ? chalk.red(`${l.trajectory}`) : dim('0');
      console.log(dim(`    ── lineage: run #${l.run_number}, trajectory ${trajStr}, trend ${trendIcon} ${l.trend}, prior ${l.prior_quality}/100`));

      // Show deltas
      const changes = l.deltas.filter((d: { status_change: string }) => d.status_change !== '=');
      if (changes.length > 0) {
        const changeStr = changes.map((d: { capability: string; status_change: string; quality_delta: number }) =>
          `${d.capability.split(' ')[0]} ${d.status_change} (${d.quality_delta >= 0 ? '+' : ''}${d.quality_delta})`
        ).join(', ');
        console.log(dim(`    ── changes: ${changeStr}`));
      }
    }

    hr();
  }

  console.log();
  console.log(bold.green('  The serpent has devoured itself 10 times. Lineage complete.'));
  console.log();
}

function statusColor(status: string) {
  if (status === 'strong') return chalk.green;
  if (status === 'developing') return chalk.yellow;
  return chalk.red;
}

function progressBar(value: number, width: number): string {
  const filled = Math.round((value / 100) * width);
  const empty = width - filled;
  const color = value >= 80 ? chalk.green : value >= 50 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + dim('░'.repeat(empty));
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
