/**
 * The Ouroboros — Self-Evolving Agent Demo
 *
 * Watches an agent read its own source, generate evolved versions with new
 * capabilities, hot-load them, and chain execution through 5 generations.
 * At the end, diffs the original against the final evolved form.
 *
 * Zero API keys required — deterministic evolution.
 *
 * Run: npx tsx examples/ouroboros.ts
 */

import chalk from 'chalk';
import { OuroborosAgent } from '../src/agents/OuroborosAgent.js';

// ── Helpers ──────────────────────────────────────────────────────────

const dim = chalk.dim;
const bold = chalk.bold;

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

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // ── Banner ───────────────────────────────────────────────────────
  console.log();
  console.log(bold.green('  ╔══════════════════════════════════════════════════╗'));
  console.log(bold.green('  ║') + bold('   The Ouroboros — self-evolving agent             ') + bold.green('║'));
  console.log(bold.green('  ╚══════════════════════════════════════════════════╝'));
  console.log();
  console.log(dim('  An agent that reads its own source code, generates'));
  console.log(dim('  evolved versions of itself, and hot-loads them.'));
  console.log(dim('  5 generations. 5 new capabilities. Zero API keys.'));
  console.log();

  // ── Step 1: Create the agent ──────────────────────────────────
  step(1, 'Initialize Gen 0 — the original Ouroboros');

  const agent = new OuroborosAgent();
  console.log(`  ${dim('Name:')}          ${agent.name}`);
  console.log(`  ${dim('Generation:')}    ${agent.generation}`);
  console.log(`  ${dim('Work dir:')}      ${agent.workDir}`);
  console.log();

  // ── Step 2: Run the evolution chain ───────────────────────────
  step(2, 'Execute — evolving through 5 generations');

  const inputText = 'The amazing brown fox happily jumps over the lazy dog. Contact us at fox@example.com or visit https://fox.dev for more info. Date: 2026-02-16. Score: 42.';

  console.log(`  ${dim('Input:')} ${chalk.yellow(`"${inputText.slice(0, 70)}..."`)}`);
  console.log();
  console.log(dim('  Evolving...'));
  console.log();

  const resultStr = await agent.execute({ input: inputText });
  const result = JSON.parse(resultStr);

  // ── Step 3: Show evolution log ─────────────────────────────────
  step(3, 'Evolution log');

  const capabilities = [
    'Word Statistics',
    'Caesar Cipher',
    'Pattern Detection',
    'Sentiment Heuristic',
    'Self-Reflection',
  ];

  for (const line of result.evolution_log ?? []) {
    const genMatch = line.match(/Gen (\d+)/);
    const gen = genMatch ? Number(genMatch[1]) : 0;
    const color = [chalk.white, chalk.cyan, chalk.blue, chalk.magenta, chalk.yellow, chalk.green][gen] ?? chalk.white;
    console.log(`  ${color('●')} ${line}`);
  }
  console.log();

  // ── Step 4: Show capabilities output ──────────────────────────
  step(4, 'Final agent output — all 5 capabilities');

  const caps = result.capabilities_output ?? {};

  if (caps.wordStats) {
    console.log(bold.cyan('  Word Statistics:'));
    console.log(`    Words: ${caps.wordStats.word_count}, Unique: ${caps.wordStats.unique_words}, Avg length: ${caps.wordStats.avg_word_length}`);
    const top = (caps.wordStats.most_frequent ?? []).map((f: { word: string; count: number }) => `${f.word}(${f.count})`).join(', ');
    console.log(`    Most frequent: ${top}`);
    console.log();
  }

  if (caps.caesarCipher) {
    console.log(bold.blue('  Caesar Cipher (ROT13):'));
    console.log(`    Encrypted: ${dim(caps.caesarCipher.encrypted.slice(0, 60))}...`);
    console.log(`    Decrypted: ${dim(caps.caesarCipher.decrypted.slice(0, 60))}...`);
    console.log();
  }

  if (caps.patterns) {
    console.log(bold.magenta('  Pattern Detection:'));
    console.log(`    Emails: ${caps.patterns.emails.join(', ') || dim('none')}`);
    console.log(`    URLs:   ${caps.patterns.urls.join(', ') || dim('none')}`);
    console.log(`    Dates:  ${caps.patterns.dates.join(', ') || dim('none')}`);
    console.log(`    Numbers: ${caps.patterns.numbers.join(', ') || dim('none')}`);
    console.log();
  }

  if (caps.sentiment) {
    const s = caps.sentiment;
    const emoji = s.score > 0 ? '+' : s.score < 0 ? '-' : '~';
    console.log(bold.yellow('  Sentiment Analysis:'));
    console.log(`    Score: ${emoji}${s.score} (${s.label})`);
    console.log(`    Positive words: ${s.positive.join(', ') || dim('none')}`);
    console.log(`    Negative words: ${s.negative.join(', ') || dim('none')}`);
    console.log();
  }

  if (caps.reflection) {
    console.log(bold.green('  Self-Reflection:'));
    console.log(`    ${caps.reflection.identity}`);
    console.log(`    Capability count: ${caps.reflection.capability_count}`);
    console.log();
  }

  // ── Step 5: Show diff summary ─────────────────────────────────
  step(5, 'Diff — Gen 0 vs Gen 5');

  const ds = result.diff_summary ?? {};
  console.log(`  ${dim('Gen 0 lines:')}     ${ds.gen0_lines}`);
  console.log(`  ${dim('Gen 5 lines:')}     ${ds.gen5_lines}`);
  console.log(`  ${dim('Lines added:')}     ${chalk.green(`+${ds.lines_added}`)}`);
  console.log(`  ${dim('Methods gained:')}  ${(ds.methods_gained ?? []).length}`);
  console.log();

  const methodLabels: Record<string, string> = {
    wordStats: 'Word Statistics',
    caesarEncrypt: 'Caesar Cipher (encrypt)',
    caesarDecrypt: 'Caesar Cipher (decrypt)',
    detectPatterns: 'Pattern Detection',
    analyzeSentiment: 'Sentiment Heuristic',
    reflectOnEvolution: 'Self-Reflection',
  };
  for (const m of ds.methods_gained ?? []) {
    console.log(`    ${chalk.green('+')} ${m}() ${dim(`— ${methodLabels[m] ?? m}`)}`);
  }
  console.log();

  hr();
  console.log(dim('  The serpent eats its own tail. Evolution complete.'));
  console.log();
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
