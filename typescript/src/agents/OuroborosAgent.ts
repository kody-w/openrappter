/**
 * OuroborosAgent - A self-evolving agent that reads its own source code,
 * generates evolved versions with new capabilities, hot-loads them, and
 * chains execution through 5 generations.
 *
 * Zero API keys required - uses a deterministic evolution catalog.
 *
 * Execution flow:
 *   Gen 0 → reads own source → applies mutation → writes Gen 1 → imports & executes
 *   Gen 1 → reads own source → applies mutation → writes Gen 2 → imports & executes
 *   ...
 *   Gen 5 → terminal case → runs ALL capabilities on input → returns report
 *   Gen 0 → diffs Gen 0 vs Gen 5 → returns final report with evolution log
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import type { LLMProvider } from '../providers/types.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { join } from 'path';
import { HOME_DIR } from '../env.js';

// Absolute path to BasicAgent — computed in Gen 0, frozen as literal in generated files
// Resolve .js (compiled dist/) or .ts (dev tsx) — same pattern as selfPath below
const _baJs = fileURLToPath(new URL('./BasicAgent.js', import.meta.url));
const _baTs = fileURLToPath(new URL('./BasicAgent.ts', import.meta.url));
const BASIC_AGENT_PATH = existsSync(_baJs) ? _baJs : _baTs;

// ── Evolution Catalog ───────────────────────────────────────────────
// Each entry adds a new capability via string splicing on the source.

export interface EvolutionEntry {
  name: string;
  description: string;
  apply: (source: string, nextGen: number) => string;
}

// ── Capability Assessment Types ─────────────────────────────────────

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CapabilityTrend {
  capability: string;
  direction: 'improving' | 'declining' | null;
  consecutive: number;
  multiplier: number; // 0.80 to 1.20
}

export interface CapabilityScore {
  capability: string;
  quality: number; // 0-100
  base_quality: number; // before trend multiplier
  checks: Check[];
  status: 'strong' | 'developing' | 'weak';
  summary: string;
  trend: CapabilityTrend | null;
}

export interface RunDelta {
  capability: string;
  quality_delta: number;
  status_change: string; // e.g. "weak→strong" or "=" for unchanged
}

export interface LineageRunSummary {
  run_number: number;
  timestamp: string;
  input_hash: string;
  overall_quality: number;
  status: string;
  level_qualities: number[];
  level_statuses: string[];
}

export interface EvolutionLineage {
  run_number: number;
  prior_quality: number | null;
  prior_status: string | null;
  deltas: RunDelta[];
  trend: 'improving' | 'stable' | 'declining';
  cumulative_runs: number;
  history: LineageRunSummary[];
  trajectory: number; // slope of quality over history (-100 to 100)
}

export interface EvolutionReport {
  capabilities: CapabilityScore[];
  overall_quality: number; // 0-100
  status: 'strong' | 'developing' | 'weak';
  formatted: string;
  judge_mode: 'deterministic' | 'hybrid';
  lineage: EvolutionLineage | null;
}

export const EVOLUTION_CATALOG: EvolutionEntry[] = [
  // Gen 0 → 1: Word Statistics
  {
    name: 'Word Statistics',
    description: 'Adds wordStats() — word count, unique words, avg length, most frequent',
    apply: (source, nextGen) => {
      const method = `
  wordStats(text) {
    const words = text.toLowerCase().match(/\\b[a-z]+\\b/g) ?? [];
    const freq = {};
    for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const avgLen = words.length ? words.reduce((s, w) => s + w.length, 0) / words.length : 0;
    return {
      word_count: words.length,
      unique_words: Object.keys(freq).length,
      avg_word_length: Math.round(avgLen * 100) / 100,
      most_frequent: sorted.slice(0, 5).map(([w, c]) => ({ word: w, count: c })),
    };
  }`;
      const capability = `    capabilityResults.wordStats = this.wordStats(inputText);`;
      return spliceEvolution(source, nextGen, method, capability);
    },
  },

  // Gen 1 → 2: Caesar Cipher
  {
    name: 'Caesar Cipher',
    description: 'Adds caesarEncrypt()/caesarDecrypt() — ROT13 encode/decode',
    apply: (source, nextGen) => {
      const method = `
  caesarEncrypt(text, shift = 13) {
    return text.replace(/[a-zA-Z]/g, (ch) => {
      const base = ch >= 'a' ? 97 : 65;
      return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
    });
  }

  caesarDecrypt(text, shift = 13) {
    return this.caesarEncrypt(text, 26 - shift);
  }`;
      const capability = `    const encrypted = this.caesarEncrypt(inputText);
    capabilityResults.caesarCipher = { encrypted, decrypted: this.caesarDecrypt(encrypted) };`;
      return spliceEvolution(source, nextGen, method, capability);
    },
  },

  // Gen 2 → 3: Pattern Detection
  {
    name: 'Pattern Detection',
    description: 'Adds detectPatterns() — finds emails, URLs, numbers, dates via regex',
    apply: (source, nextGen) => {
      const method = `
  detectPatterns(text) {
    return {
      emails: text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g) ?? [],
      urls: text.match(/https?:\\/\\/[^\\s)]+/g) ?? [],
      numbers: text.match(/\\b\\d+\\.?\\d*\\b/g) ?? [],
      dates: text.match(/\\d{4}-\\d{2}-\\d{2}/g) ?? [],
    };
  }`;
      const capability = `    capabilityResults.patterns = this.detectPatterns(inputText);`;
      return spliceEvolution(source, nextGen, method, capability);
    },
  },

  // Gen 3 → 4: Sentiment Heuristic
  {
    name: 'Sentiment Heuristic',
    description: 'Adds analyzeSentiment() — positive/negative word scoring (-1 to 1)',
    apply: (source, nextGen) => {
      const method = `
  analyzeSentiment(text) {
    const positiveWords = ['good','great','excellent','amazing','wonderful','fantastic','love','happy','best','brilliant','perfect','beautiful','awesome'];
    const negativeWords = ['bad','terrible','awful','horrible','worst','hate','ugly','stupid','boring','poor','broken','fail','error'];
    const words = text.toLowerCase().match(/\\b[a-z]+\\b/g) ?? [];
    const pos = words.filter(w => positiveWords.includes(w));
    const neg = words.filter(w => negativeWords.includes(w));
    const total = pos.length + neg.length;
    const score = total === 0 ? 0 : Math.round(((pos.length - neg.length) / total) * 100) / 100;
    const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
    return { score, label, positive: pos, negative: neg };
  }`;
      const capability = `    capabilityResults.sentiment = this.analyzeSentiment(inputText);`;
      return spliceEvolution(source, nextGen, method, capability);
    },
  },

  // Gen 4 → 5: Self-Reflection
  {
    name: 'Self-Reflection',
    description: 'Adds reflectOnEvolution() — inspects own capabilities and produces identity summary',
    apply: (source, nextGen) => {
      const method = `
  reflectOnEvolution() {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
      .filter(m => m !== 'constructor' && !m.startsWith('_'));
    return {
      generation: this.generation,
      className: this.constructor.name,
      capabilities: methods,
      capability_count: methods.length,
      identity: \`I am \${this.constructor.name}, generation \${this.generation}. I have \${methods.length} methods. I evolved through \${this.generation} mutations from the original Ouroboros.\`,
    };
  }`;
      const capability = `    capabilityResults.reflection = this.reflectOnEvolution();`;
      return spliceEvolution(source, nextGen, method, capability);
    },
  },
];

// ── String Splicing Helpers ─────────────────────────────────────────

function spliceEvolution(
  source: string,
  nextGen: number,
  newMethod: string,
  capabilityCall: string,
): string {
  // 1. Bump the generation class field (handles TS `readonly` and compiled JS forms)
  let result = source.replace(
    /^(\s*(?:readonly )?)generation = \d+/m,
    `$1generation = ${nextGen}`,
  );

  // 2. Rename class globally
  const prevGen = nextGen - 1;
  const prevName = prevGen === 0 ? 'OuroborosAgent' : `OuroborosGen${prevGen}Agent`;
  const nextName = `OuroborosGen${nextGen}Agent`;
  result = result.replace(new RegExp(prevName, 'g'), nextName);

  // 3. Insert new method before the class closing brace
  const lastBrace = result.lastIndexOf('}');
  result = result.slice(0, lastBrace) + newMethod + '\n}\n';

  // 4. Add capability call after the EVOLVED CAPABILITIES marker
  // NOTE: The marker string is split via concatenation so that the replace
  // does not match THIS line in the source when operating on itself.
  const marker = '// --- EVOLVED' + ' CAPABILITIES ---';
  result = result.replace(marker, marker + '\n' + capabilityCall);

  return result;
}

// ── Import Fixer ────────────────────────────────────────────────────
// Generated files live outside the source tree, so relative imports must become absolute.

// Resolve env module path — .js (compiled dist/) or .ts (dev tsx)
const _envJs = fileURLToPath(new URL('../env.js', import.meta.url));
const _envTs = fileURLToPath(new URL('../env.ts', import.meta.url));
const ENV_MODULE_PATH = existsSync(_envJs) ? _envJs : _envTs;

// Persistent cache directory for evolved files (must precede fixImports so regex matches definition first)
export const EVOLVED_DIR = join(HOME_DIR, 'evolved');

function fixImports(source: string): string {
  let result = source;
  // Fix the BasicAgent import to absolute path
  result = result.replace(
    /from ['"]\.\/BasicAgent\.js['"]/,
    `from '${BASIC_AGENT_PATH}'`,
  );
  // Freeze the BASIC_AGENT_PATH constant so generated files don't need import.meta.url
  result = result.replace(
    /const BASIC_AGENT_PATH = .+;/,
    `const BASIC_AGENT_PATH = '${BASIC_AGENT_PATH}';`,
  );
  // Fix the env.js import to absolute path
  result = result.replace(
    /from ['"]\.\.\/env\.js['"]/,
    `from '${ENV_MODULE_PATH}'`,
  );
  // Freeze the ENV_MODULE_PATH constant so generated files don't need import.meta.url
  result = result.replace(
    /const ENV_MODULE_PATH = .+;/,
    `const ENV_MODULE_PATH = '${ENV_MODULE_PATH}';`,
  );
  // Freeze EVOLVED_DIR so generated files don't re-resolve
  result = result.replace(
    /export const EVOLVED_DIR = .+;/,
    `export const EVOLVED_DIR = '${EVOLVED_DIR}';`,
  );
  return result;
}

// ── Persistence Cache ───────────────────────────────────────────────

interface CacheMeta {
  sourceHash: string;
  basicAgentPath: string;
  ext: string;
  createdAt: string;
}

function computeSourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function loadCacheMeta(workDir: string): CacheMeta | null {
  try {
    const data = readFileSync(join(workDir, '.cache-meta.json'), 'utf-8');
    const parsed = JSON.parse(data) as CacheMeta;
    if (
      typeof parsed.sourceHash === 'string' &&
      typeof parsed.basicAgentPath === 'string' &&
      typeof parsed.ext === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCacheMeta(workDir: string, meta: CacheMeta): void {
  try {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, '.cache-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // Best-effort — don't break evolution if cache write fails
  }
}

// ── Lineage Log Persistence ─────────────────────────────────────────

const MAX_LINEAGE_ENTRIES = 20;
const LINEAGE_FILE = 'lineage-log.json';

export function loadLineageLog(workDir: string): LineageRunSummary[] {
  try {
    const data = readFileSync(join(workDir, LINEAGE_FILE), 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed?.runs)) {
      return parsed.runs as LineageRunSummary[];
    }
    return [];
  } catch {
    return [];
  }
}

export function saveLineageLog(workDir: string, runs: LineageRunSummary[]): void {
  try {
    mkdirSync(workDir, { recursive: true });
    const capped = runs.slice(-MAX_LINEAGE_ENTRIES);
    writeFileSync(
      join(workDir, LINEAGE_FILE),
      JSON.stringify({ version: 1, max_entries: MAX_LINEAGE_ENTRIES, runs: capped }, null, 2),
      'utf-8',
    );
  } catch {
    // Best-effort — don't break evolution if log write fails
  }
}

// ── Capability Assessment ───────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function statusFromQuality(quality: number): 'strong' | 'developing' | 'weak' {
  if (quality >= 80) return 'strong';
  if (quality >= 50) return 'developing';
  return 'weak';
}

export function checkWordStats(ws: Record<string, unknown> | undefined): { quality: number; checks: Check[] } {
  if (!ws) return { quality: 0, checks: [] };
  const wordCount = (ws.word_count as number) ?? 0;
  const unique = (ws.unique_words as number) ?? 0;
  const avgLen = (ws.avg_word_length as number) ?? 0;
  const freq = (ws.most_frequent as unknown[]) ?? [];

  const checks: Check[] = [
    { name: 'has_words', passed: wordCount >= 3, detail: `word_count=${wordCount}` },
    { name: 'has_diversity', passed: wordCount > 0 && (unique / wordCount) >= 0.5, detail: `unique_ratio=${wordCount > 0 ? (unique / wordCount).toFixed(2) : '0'}` },
    { name: 'balanced_length', passed: avgLen >= 3 && avgLen <= 7, detail: `avg_length=${avgLen}` },
    { name: 'frequency_depth', passed: freq.length >= 3, detail: `freq_entries=${freq.length}` },
    { name: 'substantial_input', passed: wordCount >= 10, detail: `word_count=${wordCount}` },
  ];
  const passed = checks.filter(c => c.passed).length;
  return { quality: Math.round((passed / checks.length) * 100), checks };
}

export function checkCaesarCipher(cc: Record<string, unknown> | undefined, inputText: string): { quality: number; checks: Check[] } {
  if (!cc) return { quality: 0, checks: [] };
  const encrypted = (cc.encrypted as string) ?? '';
  const decrypted = (cc.decrypted as string) ?? '';

  const checks: Check[] = [
    { name: 'produced_output', passed: encrypted.length > 0, detail: `encrypted_length=${encrypted.length}` },
    { name: 'roundtrip_intact', passed: decrypted === inputText, detail: `match=${decrypted === inputText}` },
    { name: 'transformed', passed: encrypted !== inputText, detail: `different=${encrypted !== inputText}` },
  ];
  const passed = checks.filter(c => c.passed).length;
  return { quality: Math.round((passed / checks.length) * 100), checks };
}

export function checkPatterns(p: Record<string, unknown> | undefined): { quality: number; checks: Check[] } {
  if (!p) return { quality: 0, checks: [] };
  const emails = (p.emails as unknown[]) ?? [];
  const urls = (p.urls as unknown[]) ?? [];
  const numbers = (p.numbers as unknown[]) ?? [];
  const dates = (p.dates as unknown[]) ?? [];

  const checks: Check[] = [
    { name: 'found_emails', passed: emails.length > 0, detail: `count=${emails.length}` },
    { name: 'found_urls', passed: urls.length > 0, detail: `count=${urls.length}` },
    { name: 'found_numbers', passed: numbers.length > 0, detail: `count=${numbers.length}` },
    { name: 'found_dates', passed: dates.length > 0, detail: `count=${dates.length}` },
  ];
  const passed = checks.filter(c => c.passed).length;
  return { quality: Math.round((passed / checks.length) * 100), checks };
}

export function checkSentiment(s: Record<string, unknown> | undefined): { quality: number; checks: Check[] } {
  if (!s) return { quality: 0, checks: [] };
  const label = (s.label as string) ?? 'neutral';
  const pos = (s.positive as unknown[]) ?? [];
  const neg = (s.negative as unknown[]) ?? [];
  const score = (s.score as number) ?? 0;

  const checks: Check[] = [
    { name: 'detected_sentiment', passed: label !== 'neutral', detail: `label=${label}` },
    { name: 'found_words', passed: (pos.length + neg.length) > 0, detail: `total=${pos.length + neg.length}` },
    { name: 'sufficient_evidence', passed: (pos.length + neg.length) >= 2, detail: `sentiment_words=${pos.length + neg.length}` },
    { name: 'has_confidence', passed: Math.abs(score) > 0.2, detail: `abs_score=${Math.abs(score)}` },
  ];
  const passed = checks.filter(c => c.passed).length;
  return { quality: Math.round((passed / checks.length) * 100), checks };
}

export function checkReflection(r: Record<string, unknown> | undefined): { quality: number; checks: Check[] } {
  if (!r) return { quality: 0, checks: [] };
  const generation = (r.generation as number) ?? 0;
  const identity = (r.identity as string) ?? '';
  const className = (r.className as string) ?? '';
  const capCount = (r.capability_count as number) ?? 0;

  const checks: Check[] = [
    { name: 'correct_generation', passed: generation === 5, detail: `generation=${generation}` },
    { name: 'knows_identity', passed: identity.length > 0, detail: `identity_length=${identity.length}` },
    { name: 'correct_class', passed: className.includes('Gen5'), detail: `className=${className}` },
    { name: 'counted_capabilities', passed: capCount > 0, detail: `count=${capCount}` },
  ];
  const passed = checks.filter(c => c.passed).length;
  return { quality: Math.round((passed / checks.length) * 100), checks };
}

export function computeTrends(priorRuns: LineageRunSummary[]): CapabilityTrend[] {
  const capNames = ['Word Statistics', 'Caesar Cipher', 'Pattern Detection', 'Sentiment Heuristic', 'Self-Reflection'];
  const trends: CapabilityTrend[] = [];
  for (let idx = 0; idx < 5; idx++) {
    let improvements = 0;
    let declines = 0;

    // Walk backwards through runs counting consecutive direction
    for (let i = priorRuns.length - 1; i >= 1; i--) {
      const curr = priorRuns[i].level_qualities[idx] ?? 0;
      const prev = priorRuns[i - 1].level_qualities[idx] ?? 0;
      if (curr > prev) {
        if (declines > 0) break; // streak broken
        improvements++;
      } else if (curr < prev) {
        if (improvements > 0) break;
        declines++;
      } else {
        break; // tie breaks streak
      }
    }

    let multiplier = 1.0;
    let direction: CapabilityTrend['direction'] = null;
    if (improvements >= 3) {
      multiplier = 1.0 + Math.min(improvements - 2, 4) * 0.05;
      direction = 'improving';
    } else if (declines >= 3) {
      multiplier = 1.0 - Math.min(declines - 2, 4) * 0.05;
      direction = 'declining';
    }

    trends.push({
      capability: capNames[idx],
      direction,
      consecutive: Math.max(improvements, declines),
      multiplier: Math.round(multiplier * 100) / 100,
    });
  }
  return trends;
}

function buildCapabilityScore(
  capability: string,
  result: { quality: number; checks: Check[] },
  trend?: CapabilityTrend,
): CapabilityScore {
  const baseQuality = result.quality;
  const multiplier = trend?.multiplier ?? 1.0;
  const quality = clamp(Math.round(baseQuality * multiplier), 0, 100);
  const status = statusFromQuality(quality);
  const checkStr = result.checks.map(c => c.passed ? '\u2713' : '\u2717').join('');
  const trendTag = trend?.direction ? ` [${trend.direction} x${trend.multiplier}]` : '';
  const summary = `${capability}: ${quality}/100 ${status} ${checkStr}${trendTag}`;
  return { capability, quality, base_quality: baseQuality, checks: result.checks, status, summary, trend: trend ?? null };
}

function computeOverall(capabilities: CapabilityScore[]): { overallQuality: number; status: 'strong' | 'developing' | 'weak' } {
  const totalQuality = capabilities.reduce((sum, c) => sum + c.quality, 0);
  const overallQuality = Math.round(totalQuality / capabilities.length);
  return { overallQuality, status: statusFromQuality(overallQuality) };
}

function formatReport(capabilities: CapabilityScore[], overall: ReturnType<typeof computeOverall>): string {
  const W = 62;
  const border = '╔' + '═'.repeat(W) + '╗';
  const bottom = '╚' + '═'.repeat(W) + '╝';
  const sep    = '╠' + '═'.repeat(W) + '╣';
  const row = (s: string) => `║  ${s.padEnd(W - 2)}║`;

  const lines: string[] = [border];
  lines.push(row('EVOLUTION REPORT'));
  lines.push(row(`Overall: ${overall.overallQuality}/100  Status: ${overall.status}`));
  lines.push(sep);

  for (const cap of capabilities) {
    const checkStr = cap.checks.map(c => c.passed ? '\u2713' : '\u2717').join('');
    const trendTag = cap.trend?.direction ? `  ${cap.trend.direction}` : '';
    lines.push(row(`${cap.capability.padEnd(20)} ${String(cap.quality).padStart(3)}/100  ${cap.status.padEnd(12)} ${checkStr}${trendTag}`));
  }

  lines.push(sep);
  lines.push(row(`QUALITY: ${String(overall.overallQuality).padStart(3)}  STATUS: ${overall.status}`));
  lines.push(bottom);

  return lines.join('\n');
}

function computeTrajectory(runs: LineageRunSummary[]): number {
  if (runs.length < 2) return 0;
  // Simple linear regression slope on overall_quality
  const n = runs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += runs[i].overall_quality;
    sumXY += i * runs[i].overall_quality;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return clamp(Math.round(slope * 10) / 10, -100, 100);
}

function computeLineage(
  capabilities: CapabilityScore[],
  overall: ReturnType<typeof computeOverall>,
  priorRuns: LineageRunSummary[],
): EvolutionLineage | null {
  if (priorRuns.length === 0) return null;

  const latest = priorRuns[priorRuns.length - 1];

  const deltas: RunDelta[] = capabilities.map((cap, i) => {
    const priorQuality = latest.level_qualities[i] ?? 0;
    const priorStatus = latest.level_statuses[i] ?? 'weak';
    const statusChange = priorStatus === cap.status ? '=' : `${priorStatus}\u2192${cap.status}`;
    return { capability: cap.capability, quality_delta: cap.quality - priorQuality, status_change: statusChange };
  });

  const trajectory = computeTrajectory([
    ...priorRuns,
    // Include current run as a synthetic entry for trajectory calculation
    { run_number: latest.run_number + 1, timestamp: '', input_hash: '',
      overall_quality: overall.overallQuality, status: overall.status,
      level_qualities: capabilities.map(c => c.quality), level_statuses: capabilities.map(c => c.status) },
  ]);

  // Trend: with 3+ data points use trajectory, otherwise use simple delta
  let trend: EvolutionLineage['trend'];
  if (priorRuns.length >= 2) {
    // 3+ total data points (prior runs + current) — use trajectory
    trend = trajectory > 1 ? 'improving' : trajectory < -1 ? 'declining' : 'stable';
  } else {
    // 2 total data points — use simple delta
    const delta = overall.overallQuality - latest.overall_quality;
    trend = delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'stable';
  }

  return {
    run_number: latest.run_number + 1,
    prior_quality: latest.overall_quality,
    prior_status: latest.status,
    deltas,
    trend,
    cumulative_runs: latest.run_number + 1,
    history: priorRuns,
    trajectory,
  };
}

async function enhanceWithLLM(
  capabilities: CapabilityScore[],
  input: string,
  caps: Record<string, unknown>,
  provider: LLMProvider,
  lineage: EvolutionLineage | null,
): Promise<boolean> {
  try {
    const available = await provider.isAvailable();
    if (!available) return false;

    const summaryLines = capabilities.map(c =>
      `"${c.capability}": quality=${c.quality}/100, status=${c.status}, checks=${c.checks.map(ch => `${ch.name}:${ch.passed}`).join(',')}`
    );

    const promptParts = [
      'You are reviewing an AI agent\'s capability assessment after self-evolution through 5 stages.',
      `Input text processed: "${input.slice(0, 200)}"`,
      '',
      'Capability scores:',
      ...summaryLines,
    ];

    // Inject lineage context to guide commentary
    if (lineage && lineage.history.length > 0) {
      promptParts.push('');
      promptParts.push(`This is run #${lineage.run_number} (${lineage.cumulative_runs} total). Trajectory: ${lineage.trajectory > 0 ? '+' : ''}${lineage.trajectory}.`);

      if (lineage.trend === 'declining' && lineage.history.length >= 2) {
        promptParts.push('WARNING: This agent has been DECLINING for multiple runs. Focus on identifying weaknesses and how to recover.');
      } else if (lineage.trend === 'improving') {
        promptParts.push('This agent has been IMPROVING. Highlight what is driving the improvement and suggest next steps.');
      } else if (lineage.trend === 'stable') {
        promptParts.push('This agent has PLATEAUED. Suggest specific areas to push harder.');
      }

      const statusChanges = lineage.deltas
        .filter(d => d.status_change !== '=')
        .map(d => `${d.capability}: ${d.status_change}`);
      if (statusChanges.length > 0) {
        promptParts.push(`Status changes since last run: ${statusChanges.join(', ')}`);
      }
    }

    // Include active trends
    const activeTrends = capabilities
      .filter(c => c.trend?.direction)
      .map(c => `${c.capability} ${c.trend!.direction} (x${c.trend!.multiplier})`);
    if (activeTrends.length > 0) {
      promptParts.push(`Active trends: ${activeTrends.join(', ')}.`);
    }

    promptParts.push('');
    promptParts.push('Write exactly 5 short improvement suggestions (one per capability), returned as a JSON array of strings.');
    promptParts.push('Each should be 1-2 sentences describing what the capability did well and what could improve. Return ONLY the JSON array, no other text.');

    const prompt = promptParts.join('\n');

    const response = await provider.chat([{ role: 'user', content: prompt }], {
      temperature: 0.7,
      max_tokens: 500,
    });

    if (!response.content) return false;

    const parsed = JSON.parse(response.content) as string[];
    if (!Array.isArray(parsed) || parsed.length !== 5) return false;

    for (let i = 0; i < 5; i++) {
      if (typeof parsed[i] === 'string') {
        capabilities[i].summary = parsed[i];
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function assessEvolution(
  input: string,
  caps: Record<string, unknown>,
  provider?: LLMProvider,
  priorRuns?: LineageRunSummary[],
): Promise<EvolutionReport> {
  const capNames = ['Word Statistics', 'Caesar Cipher', 'Pattern Detection', 'Sentiment Heuristic', 'Self-Reflection'];

  const results: { quality: number; checks: Check[] }[] = [
    checkWordStats(caps.wordStats as Record<string, unknown> | undefined),
    checkCaesarCipher(caps.caesarCipher as Record<string, unknown> | undefined, input),
    checkPatterns(caps.patterns as Record<string, unknown> | undefined),
    checkSentiment(caps.sentiment as Record<string, unknown> | undefined),
    checkReflection(caps.reflection as Record<string, unknown> | undefined),
  ];

  const trends = (priorRuns && priorRuns.length >= 3) ? computeTrends(priorRuns) : [];
  const capabilities = results.map((result, i) => buildCapabilityScore(capNames[i], result, trends[i]));

  const overall = computeOverall(capabilities);
  const lineage = computeLineage(capabilities, overall, priorRuns ?? []);

  let judgeMode: 'deterministic' | 'hybrid' = 'deterministic';
  if (provider) {
    const enhanced = await enhanceWithLLM(capabilities, input, caps, provider, lineage);
    if (enhanced) judgeMode = 'hybrid';
  }

  const formatted = formatReport(capabilities, overall);

  return {
    capabilities,
    overall_quality: overall.overallQuality,
    status: overall.status,
    formatted,
    judge_mode: judgeMode,
    lineage,
  };
}

// ── The Agent ───────────────────────────────────────────────────────

export class OuroborosAgent extends BasicAgent {
  readonly generation = 0;
  readonly workDir: string;
  readonly evolutionLog: string[] = [];
  readonly judgeProvider?: LLMProvider;

  constructor(workDir?: string, judgeProvider?: LLMProvider) {
    const metadata: AgentMetadata = {
      name: 'Ouroboros',
      description:
        'Self-evolving agent that reads its own source, generates evolved versions with new capabilities, hot-loads them, and chains execution through 5 generations.',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Text input to process through all evolved capabilities.',
          },
        },
        required: [],
      },
    };
    super('Ouroboros', metadata);

    this.workDir = workDir ?? EVOLVED_DIR;
    this.judgeProvider = judgeProvider;
  }

  /** Resolve own source path: .mjs (generated), .js (compiled dist/), or .ts (dev tsx) */
  private _resolveSelfPath(): string {
    const mjsPath = fileURLToPath(new URL('./OuroborosAgent.mjs', import.meta.url));
    const jsPath = fileURLToPath(new URL('./OuroborosAgent.js', import.meta.url));
    const tsPath = fileURLToPath(new URL('./OuroborosAgent.ts', import.meta.url));
    return existsSync(mjsPath) ? mjsPath : existsSync(jsPath) ? jsPath : tsPath;
  }

  /** Gen 0 final report: diff Gen 0 vs Gen 5, wrap child result with evolution summary */
  private async _wrapFinalReport(
    childResult: string,
    selfSource: string,
    selfPath: string,
    inputText: string,
    childLog: string[],
  ): Promise<string> {
    let childParsed: Record<string, unknown>;
    try {
      childParsed = JSON.parse(childResult);
    } catch {
      childParsed = { raw: childResult };
    }

    // Diff Gen 0 vs Gen 5
    const gen5Ext = selfPath.endsWith('.ts') ? '.ts' : '.mjs';
    const gen5Path = join(this.workDir, `OuroborosGen5Agent${gen5Ext}`);
    let diff = '';
    let gen5Lines = 0;
    if (existsSync(gen5Path)) {
      const gen5Source = readFileSync(gen5Path, 'utf-8');
      gen5Lines = gen5Source.split('\n').length;
      try {
        diff = execSync(`diff -u "${selfPath}" "${gen5Path}" || true`, {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch {
        diff = `[diff unavailable — Gen 0: ${selfSource.split('\n').length} lines, Gen 5: ${gen5Lines} lines]`;
      }
    }

    const selfLines = selfSource.split('\n').length;
    const linesAdded = gen5Lines - selfLines;
    const finalLog = (childParsed.evolution_log as string[]) ?? childLog;

    // Generate capability assessment report — auto-load lineage log for cross-run tracking
    const capabilitiesOutput = (childParsed.capabilities ?? childParsed) as Record<string, unknown>;
    const lineageRuns = loadLineageLog(this.workDir);
    const report = await assessEvolution(inputText, capabilitiesOutput, this.judgeProvider, lineageRuns);

    // Build capability digests for downstream agents
    const ws = capabilitiesOutput.wordStats as Record<string, unknown> | undefined;
    const cc = capabilitiesOutput.caesarCipher as Record<string, unknown> | undefined;
    const pt = capabilitiesOutput.patterns as Record<string, unknown> | undefined;
    const sn = capabilitiesOutput.sentiment as Record<string, unknown> | undefined;
    const rf = capabilitiesOutput.reflection as Record<string, unknown> | undefined;

    const capabilityDigests = {
      word_stats: ws ? {
        word_count: ws.word_count,
        unique_ratio: (ws.unique_words as number) / Math.max(ws.word_count as number, 1),
        avg_word_length: ws.avg_word_length,
        top_words: ((ws.most_frequent as Array<Record<string, unknown>>) ?? []).slice(0, 3).map(e => e.word),
      } : null,
      caesar_cipher: cc ? {
        roundtrip_intact: (cc.decrypted as string) === inputText,
        encrypted_length: (cc.encrypted as string)?.length ?? 0,
      } : null,
      patterns: pt ? {
        emails_found: (pt.emails as unknown[])?.length ?? 0,
        urls_found: (pt.urls as unknown[])?.length ?? 0,
        numbers_found: (pt.numbers as unknown[])?.length ?? 0,
        dates_found: (pt.dates as unknown[])?.length ?? 0,
        total_patterns: ((pt.emails as unknown[])?.length ?? 0) + ((pt.urls as unknown[])?.length ?? 0) +
                        ((pt.numbers as unknown[])?.length ?? 0) + ((pt.dates as unknown[])?.length ?? 0),
      } : null,
      sentiment: sn ? {
        score: sn.score,
        label: sn.label,
        positive_count: (sn.positive as unknown[])?.length ?? 0,
        negative_count: (sn.negative as unknown[])?.length ?? 0,
      } : null,
      reflection: rf ? {
        generation: rf.generation,
        capability_count: rf.capability_count,
        class_name: rf.className,
      } : null,
    };

    const inputProfile = {
      length: inputText.length,
      word_count: (inputText.match(/\b\w+\b/g) ?? []).length,
      has_email: /\S+@\S+\.\S+/.test(inputText),
      has_url: /https?:\/\//.test(inputText),
      has_date: /\d{4}-\d{2}-\d{2}/.test(inputText),
    };

    const runNumber = report.lineage?.run_number ?? 1;

    // Persist current run to lineage log for future runs
    const currentRunSummary: LineageRunSummary = {
      run_number: runNumber,
      timestamp: new Date().toISOString(),
      input_hash: computeSourceHash(inputText),
      overall_quality: report.overall_quality,
      status: report.status,
      level_qualities: report.capabilities.map(c => c.quality),
      level_statuses: report.capabilities.map(c => c.status),
    };
    saveLineageLog(this.workDir, [...lineageRuns, currentRunSummary]);

    return JSON.stringify(
      {
        status: 'success',
        agent: 'OuroborosAgent',
        description: 'Self-evolution complete — 5 generations of deterministic mutation',
        input: inputText,
        generations: 5,
        evolution_log: finalLog,
        capabilities_output: capabilitiesOutput,
        report,
        diff_summary: {
          gen0_lines: selfLines,
          gen5_lines: gen5Lines,
          lines_added: linesAdded,
          methods_gained: [
            'wordStats',
            'caesarEncrypt',
            'caesarDecrypt',
            'detectPatterns',
            'analyzeSentiment',
            'reflectOnEvolution',
          ],
        },
        diff,
        data_slush: this.slushOut({
          signals: {
            // Evolution metadata
            generations_evolved: 5,
            capabilities_added: 5,
            lines_added: linesAdded,
            run_number: runNumber,

            // Report summary — downstream agents see these directly
            report_summary: {
              overall_quality: report.overall_quality,
              status: report.status,
              judge_mode: report.judge_mode,
              capability_scores: report.capabilities.map(c => ({
                capability: c.capability,
                quality: c.quality,
                status: c.status,
              })),
              summaries: report.capabilities.map(c => c.summary),
            },

            // Capability digests — what was actually found
            capability_digests: capabilityDigests,

            // Input profile — what the input looked like
            input_profile: inputProfile,

            // Lineage — cross-run progression
            lineage: report.lineage,
          },
        }),
      },
      null,
      2,
    );
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const inputText = (kwargs.input ?? kwargs.query ?? 'The quick brown fox jumps over the lazy dog.') as string;

    // Ensure work directory exists
    if (!existsSync(this.workDir)) {
      mkdirSync(this.workDir, { recursive: true });
    }

    // Collect capability results — evolved capabilities are inserted after this marker
    const capabilityResults: Record<string, unknown> = {};
    // --- EVOLVED CAPABILITIES ---

    // Terminal case (Gen 5) — run all accumulated capabilities and return
    if (this.generation >= 5) {
      this.evolutionLog.push(
        `Gen ${this.generation}: TERMINAL — ran ${Object.keys(capabilityResults).length} capabilities`,
      );
      return JSON.stringify({
        status: 'terminal',
        generation: this.generation,
        capabilities: capabilityResults,
        evolution_log: this.evolutionLog,
        data_slush: this.slushOut({
          signals: { generation: this.generation, is_terminal: true },
        }),
      });
    }

    // Resolve own source path
    const selfPath = this._resolveSelfPath();
    const selfSource = readFileSync(selfPath, 'utf-8');
    const ext = selfPath.endsWith('.ts') ? '.ts' : '.mjs';

    // ── Fast path: check persistence cache (Gen 0 only) ──
    if (this.generation === 0) {
      const sourceHash = computeSourceHash(selfSource);
      const cached = loadCacheMeta(this.workDir);

      if (
        cached &&
        cached.sourceHash === sourceHash &&
        cached.basicAgentPath === BASIC_AGENT_PATH &&
        cached.ext === ext
      ) {
        const gen5Path = join(this.workDir, `OuroborosGen5Agent${ext}`);
        if (existsSync(gen5Path)) {
          // Cache hit — load persisted Gen 5 directly
          this.evolutionLog.push(
            `Gen 0: cache hit — loading persisted Gen 5 (cached ${cached.createdAt})`,
          );
          this.evolutionLog.push(
            `Gen 0: reading own source (${selfSource.split('\n').length} lines)`,
          );

          const gen5Module = await import(`${gen5Path}?t=${Date.now()}`);
          const Gen5Class = gen5Module.OuroborosGen5Agent;
          const gen5Agent = new Gen5Class(this.workDir);
          gen5Agent.evolutionLog.push(...this.evolutionLog);

          const childResult = await gen5Agent.execute({ input: inputText });
          return await this._wrapFinalReport(childResult, selfSource, selfPath, inputText, gen5Agent.evolutionLog);
        }
      }
    }

    // ── Slow path: full evolution ──
    this.evolutionLog.push(
      `Gen ${this.generation}: reading own source (${selfSource.split('\n').length} lines)`,
    );

    // Apply next evolution from the catalog
    const nextGen = this.generation + 1;
    const entry = EVOLUTION_CATALOG[nextGen - 1];
    const nextSource = entry.apply(selfSource, nextGen);
    const nextName = `OuroborosGen${nextGen}Agent`;
    const nextPath = join(this.workDir, `${nextName}${ext}`);

    // Fix imports and write the evolved source
    const fixedSource = fixImports(nextSource);
    writeFileSync(nextPath, fixedSource, 'utf-8');
    this.evolutionLog.push(
      `Gen ${this.generation} → Gen ${nextGen}: applied "${entry.name}"`,
    );

    // Hot-load and execute next generation
    const nextModule = await import(`${nextPath}?t=${Date.now()}`);
    const NextClass = nextModule[nextName];
    const nextAgent = new NextClass(this.workDir);
    nextAgent.evolutionLog.push(...this.evolutionLog);

    const childResult = await nextAgent.execute({ input: inputText });

    // Gen 0: wrap with final report and persist cache
    if (this.generation === 0) {
      // Save cache metadata for future fast-path
      saveCacheMeta(this.workDir, {
        sourceHash: computeSourceHash(selfSource),
        basicAgentPath: BASIC_AGENT_PATH,
        ext,
        createdAt: new Date().toISOString(),
      });

      return await this._wrapFinalReport(childResult, selfSource, selfPath, inputText, nextAgent.evolutionLog);
    }

    // Gen 1-4: pass through child result
    return childResult;
  }
}
