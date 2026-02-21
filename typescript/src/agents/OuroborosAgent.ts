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

// ── RPG Scorecard Types ─────────────────────────────────────────────

export interface RPGStat {
  value: number;
  label: string;
  description: string;
}

export interface RPGStats {
  PWR: RPGStat;
  INT: RPGStat;
  DEX: RPGStat;
  WIS: RPGStat;
}

export interface LevelStreak {
  level: number;
  consecutive_improvements: number;
  consecutive_declines: number;
  multiplier: number; // 0.80 to 1.20
  label: 'MOMENTUM' | 'STAGNATION' | null;
}

export interface LevelScore {
  level: number;
  title: string;
  capability: string;
  stats: RPGStats;
  xp: number;
  base_xp: number;
  grade: string;
  verdict: string;
  streak: LevelStreak | null;
}

export interface RunDelta {
  level: number;
  xp_delta: number;
  grade_change: string; // e.g. "D→B" or "=" for unchanged
}

export interface LineageRunSummary {
  run_number: number;
  timestamp: string;
  input_hash: string;
  power_level: number;
  overall_grade: string;
  rank_title: string;
  total_xp: number;
  level_xps: number[];
  level_grades: string[];
}

export interface EvolutionLineage {
  run_number: number;
  prior_power_level: number | null;
  prior_grade: string | null;
  deltas: RunDelta[];
  trend: 'improving' | 'stable' | 'declining';
  cumulative_runs: number;
  history: LineageRunSummary[];
  trajectory: number; // slope of power_level over history (-100 to 100)
}

export interface EvolutionScorecard {
  levels: LevelScore[];
  total_xp: number;
  power_level: number;
  overall_grade: string;
  rank_title: string;
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

// ── RPG Scoring System ──────────────────────────────────────────────

const LEVEL_TITLES: Record<number, string> = {
  1: 'Lexicon Analyst',
  2: 'Cipher Adept',
  3: 'Pattern Seeker',
  4: 'Emotion Reader',
  5: 'Ouroboros Sage',
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function buildStats(pwr: number, int_: number, dex: number, wis: number): RPGStats {
  return {
    PWR: { value: clamp(Math.round(pwr), 0, 10), label: 'PWR', description: 'Output volume' },
    INT: { value: clamp(Math.round(int_), 0, 10), label: 'INT', description: 'Analysis depth' },
    DEX: { value: clamp(Math.round(dex), 0, 10), label: 'DEX', description: 'Precision' },
    WIS: { value: clamp(Math.round(wis), 0, 10), label: 'WIS', description: 'Self-awareness' },
  };
}

function computeXP(stats: RPGStats): number {
  const sum = stats.PWR.value + stats.INT.value + stats.DEX.value + stats.WIS.value;
  return Math.round((sum / 40) * 1000);
}

function gradeFromXP(xp: number): string {
  if (xp >= 900) return 'S';
  if (xp >= 750) return 'A';
  if (xp >= 600) return 'B';
  if (xp >= 400) return 'C';
  return 'D';
}

export function scoreWordStats(ws: Record<string, unknown> | undefined): RPGStats {
  if (!ws) return buildStats(0, 0, 0, 0);
  const wordCount = (ws.word_count as number) ?? 0;
  const unique = (ws.unique_words as number) ?? 0;
  const avgLen = (ws.avg_word_length as number) ?? 0;
  const freq = (ws.most_frequent as unknown[]) ?? [];

  const pwr = clamp(wordCount / 5, 0, 10);
  const int_ = wordCount > 0 ? clamp((unique / wordCount) * 10, 0, 10) : 0;
  const dex = clamp(10 - Math.abs(avgLen - 5.0) * 2, 0, 10);
  const wis = clamp(freq.length * 2, 0, 10);
  return buildStats(pwr, int_, dex, wis);
}

export function scoreCaesarCipher(cc: Record<string, unknown> | undefined, inputText: string): RPGStats {
  if (!cc) return buildStats(0, 0, 0, 0);
  const encrypted = (cc.encrypted as string) ?? '';
  const decrypted = (cc.decrypted as string) ?? '';

  const pwr = clamp(encrypted.length / 10, 0, 10);
  const int_ = 3; // Simple algo, fixed
  const dex = decrypted === inputText ? 10 : clamp(5, 0, 10);
  const wis = 2; // Fixed — no self-awareness in cipher
  return buildStats(pwr, int_, dex, wis);
}

export function scorePatterns(p: Record<string, unknown> | undefined): RPGStats {
  if (!p) return buildStats(0, 0, 0, 0);
  const emails = (p.emails as unknown[]) ?? [];
  const urls = (p.urls as unknown[]) ?? [];
  const numbers = (p.numbers as unknown[]) ?? [];
  const dates = (p.dates as unknown[]) ?? [];

  const total = emails.length + urls.length + numbers.length + dates.length;
  const pwr = clamp(total * 2, 0, 10);

  const categories = [emails, urls, numbers, dates];
  const withMatches = categories.filter(c => c.length > 0).length;
  const int_ = clamp((withMatches / 4) * 10, 0, 10);

  // Distribution: how spread across categories (more spread = higher DEX)
  const dex = total > 0 ? clamp((withMatches / 4) * 10, 0, 10) : 0;
  const wis = 2; // Fixed
  return buildStats(pwr, int_, dex, wis);
}

export function scoreSentiment(s: Record<string, unknown> | undefined): RPGStats {
  if (!s) return buildStats(0, 0, 0, 0);
  const label = (s.label as string) ?? 'neutral';
  const pos = (s.positive as unknown[]) ?? [];
  const neg = (s.negative as unknown[]) ?? [];
  const score = (s.score as number) ?? 0;

  const pwr = label !== 'neutral' ? clamp((pos.length + neg.length) * 2, 0, 10) : 1;
  const int_ = clamp((pos.length + neg.length) * 2, 0, 10);
  const dex = pos.length > 0 && neg.length > 0 ? 10 : clamp((pos.length + neg.length) * 2, 0, 10);
  const wis = clamp(Math.abs(score) * 10, 0, 10);
  return buildStats(pwr, int_, dex, wis);
}

export function scoreReflection(r: Record<string, unknown> | undefined): RPGStats {
  if (!r) return buildStats(0, 0, 0, 0);
  const generation = (r.generation as number) ?? 0;
  const identity = (r.identity as string) ?? '';
  const className = (r.className as string) ?? '';
  const capCount = (r.capability_count as number) ?? 0;

  const pwr = generation === 5 ? 10 : 2;
  const int_ = clamp(identity.length / 10, 0, 10);
  const dex = className.includes('Gen5') ? 10 : 3;
  const wis = clamp(capCount, 0, 10);
  return buildStats(pwr, int_, dex, wis);
}

export function computeStreaks(priorRuns: LineageRunSummary[]): LevelStreak[] {
  const streaks: LevelStreak[] = [];
  for (let lvl = 0; lvl < 5; lvl++) {
    let improvements = 0;
    let declines = 0;

    // Walk backwards through runs counting consecutive direction
    for (let i = priorRuns.length - 1; i >= 1; i--) {
      const curr = priorRuns[i].level_xps[lvl] ?? 0;
      const prev = priorRuns[i - 1].level_xps[lvl] ?? 0;
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
    let label: LevelStreak['label'] = null;
    if (improvements >= 3) {
      multiplier = 1.0 + Math.min(improvements - 2, 4) * 0.05;
      label = 'MOMENTUM';
    } else if (declines >= 3) {
      multiplier = 1.0 - Math.min(declines - 2, 4) * 0.05;
      label = 'STAGNATION';
    }

    streaks.push({
      level: lvl + 1,
      consecutive_improvements: improvements,
      consecutive_declines: declines,
      multiplier: Math.round(multiplier * 100) / 100,
      label,
    });
  }
  return streaks;
}

function buildLevelScore(level: number, capability: string, stats: RPGStats, streak?: LevelStreak): LevelScore {
  const baseXP = computeXP(stats);
  const multiplier = streak?.multiplier ?? 1.0;
  const xp = clamp(Math.round(baseXP * multiplier), 0, 1000);
  const grade = gradeFromXP(xp);
  const title = LEVEL_TITLES[level] ?? `Level ${level}`;
  const streakTag = streak?.label ? ` [${streak.label} x${streak.multiplier}]` : '';
  const verdict = `${title}: PWR=${stats.PWR.value} INT=${stats.INT.value} DEX=${stats.DEX.value} WIS=${stats.WIS.value} → ${xp}XP [${grade}]${streakTag}`;
  return { level, title, capability, stats, xp, base_xp: baseXP, grade, verdict, streak: streak ?? null };
}

function computeOverall(levels: LevelScore[]): { totalXP: number; powerLevel: number; overallGrade: string; rankTitle: string } {
  const totalXP = levels.reduce((sum, l) => sum + l.xp, 0);
  const powerLevel = Math.round((totalXP / (levels.length * 1000)) * 100);
  const overallGrade = gradeFromXP(Math.round(totalXP / levels.length));
  const rankTitle =
    powerLevel >= 90 ? 'Mythic Architect' :
    powerLevel >= 75 ? 'Grand Sorcerer' :
    powerLevel >= 60 ? 'Elite Codeweaver' :
    powerLevel >= 45 ? 'Journeyman Mage' :
    powerLevel >= 30 ? 'Apprentice Scribe' :
    'Fledgling Mutant';
  return { totalXP, powerLevel, overallGrade, rankTitle };
}

function formatScorecard(levels: LevelScore[], overall: ReturnType<typeof computeOverall>): string {
  const W = 62;
  const border = '╔' + '═'.repeat(W) + '╗';
  const bottom = '╚' + '═'.repeat(W) + '╝';
  const sep    = '╠' + '═'.repeat(W) + '╣';
  const row = (s: string) => `║  ${s.padEnd(W - 2)}║`;

  const lines: string[] = [border];
  lines.push(row('OUROBOROS EVOLUTION SCORECARD'));
  lines.push(row(`Rank: ${overall.rankTitle}`));
  lines.push(sep);

  for (const lvl of levels) {
    lines.push(row(`Lv${lvl.level} ${lvl.title.padEnd(20)} ${lvl.capability}`));
    const streakTag = lvl.streak?.label ? `  ${lvl.streak.label}` : '';
    lines.push(row(`  PWR:${String(lvl.stats.PWR.value).padStart(2)} INT:${String(lvl.stats.INT.value).padStart(2)} DEX:${String(lvl.stats.DEX.value).padStart(2)} WIS:${String(lvl.stats.WIS.value).padStart(2)}  XP:${String(lvl.xp).padStart(4)} [${lvl.grade}]${streakTag}`));
  }

  lines.push(sep);
  lines.push(row(`TOTAL XP: ${String(overall.totalXP).padStart(5)}  POWER: ${String(overall.powerLevel).padStart(3)}  GRADE: ${overall.overallGrade}`));
  lines.push(bottom);

  return lines.join('\n');
}

function computeTrajectory(runs: LineageRunSummary[]): number {
  if (runs.length < 2) return 0;
  // Simple linear regression slope on power_level
  const n = runs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += runs[i].power_level;
    sumXY += i * runs[i].power_level;
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return clamp(Math.round(slope * 10) / 10, -100, 100);
}

function computeLineage(
  levels: LevelScore[],
  overall: ReturnType<typeof computeOverall>,
  priorRuns: LineageRunSummary[],
): EvolutionLineage | null {
  if (priorRuns.length === 0) return null;

  const latest = priorRuns[priorRuns.length - 1];

  const deltas: RunDelta[] = levels.map((lvl, i) => {
    const priorXP = latest.level_xps[i] ?? 0;
    const priorG = latest.level_grades[i] ?? 'D';
    const gradeChange = priorG === lvl.grade ? '=' : `${priorG}→${lvl.grade}`;
    return { level: lvl.level, xp_delta: lvl.xp - priorXP, grade_change: gradeChange };
  });

  const trajectory = computeTrajectory([
    ...priorRuns,
    // Include current run as a synthetic entry for trajectory calculation
    { run_number: latest.run_number + 1, timestamp: '', input_hash: '',
      power_level: overall.powerLevel, overall_grade: overall.overallGrade,
      rank_title: overall.rankTitle, total_xp: overall.totalXP,
      level_xps: levels.map(l => l.xp), level_grades: levels.map(l => l.grade) },
  ]);

  // Trend: with 3+ data points use trajectory, otherwise use simple delta
  let trend: EvolutionLineage['trend'];
  if (priorRuns.length >= 2) {
    // 3+ total data points (prior runs + current) — use trajectory
    trend = trajectory > 1 ? 'improving' : trajectory < -1 ? 'declining' : 'stable';
  } else {
    // 2 total data points — use simple delta
    const delta = overall.powerLevel - latest.power_level;
    trend = delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'stable';
  }

  return {
    run_number: latest.run_number + 1,
    prior_power_level: latest.power_level,
    prior_grade: latest.overall_grade,
    deltas,
    trend,
    cumulative_runs: latest.run_number + 1,
    history: priorRuns,
    trajectory,
  };
}

async function enhanceVerdictsWithLLM(
  levels: LevelScore[],
  input: string,
  caps: Record<string, unknown>,
  provider: LLMProvider,
  lineage: EvolutionLineage | null,
): Promise<boolean> {
  try {
    const available = await provider.isAvailable();
    if (!available) return false;

    const summaryLines = levels.map(l =>
      `Level ${l.level} "${l.title}" (${l.capability}): PWR=${l.stats.PWR.value} INT=${l.stats.INT.value} DEX=${l.stats.DEX.value} WIS=${l.stats.WIS.value}, XP=${l.xp}, Grade=${l.grade}`
    );

    const promptParts = [
      'You are an RPG game narrator rating an AI agent\'s evolution through 5 levels.',
      `Input text processed: "${input.slice(0, 200)}"`,
      '',
      'Level scores:',
      ...summaryLines,
    ];

    // Inject lineage context to guide commentary
    if (lineage && lineage.history.length > 0) {
      promptParts.push('');
      promptParts.push(`This is run #${lineage.run_number} (${lineage.cumulative_runs} total). Trajectory: ${lineage.trajectory > 0 ? '+' : ''}${lineage.trajectory}.`);

      if (lineage.trend === 'declining' && lineage.history.length >= 2) {
        promptParts.push('WARNING: This agent has been DECLINING for multiple runs. Focus your commentary on identifying weaknesses, what went wrong, and how to recover.');
      } else if (lineage.trend === 'improving') {
        promptParts.push('This agent has been IMPROVING. Celebrate the growth, highlight what is driving the improvement, and push for even more.');
      } else if (lineage.trend === 'stable') {
        promptParts.push('This agent has PLATEAUED. Challenge it — suggest specific areas to push harder and break through to the next tier.');
      }

      const gradeChanges = lineage.deltas
        .filter(d => d.grade_change !== '=')
        .map(d => `Lv${d.level}: ${d.grade_change}`);
      if (gradeChanges.length > 0) {
        promptParts.push(`Grade changes since last run: ${gradeChanges.join(', ')}`);
      }
    }

    // Include active streak multipliers
    const activeStreaks = levels
      .filter(l => l.streak?.label)
      .map(l => `Lv${l.level} ${l.streak!.label} (x${l.streak!.multiplier})`);
    if (activeStreaks.length > 0) {
      promptParts.push(`Active streaks: ${activeStreaks.join(', ')}. Mention these in your commentary — momentum should feel exciting, stagnation should feel urgent.`);
    }

    promptParts.push('');
    promptParts.push('Write exactly 5 short RPG-flavored commentary strings (one per level), returned as a JSON array of strings.');
    promptParts.push('Each should be 1-2 sentences, dramatic and fun. Return ONLY the JSON array, no other text.');

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
        levels[i].verdict = parsed[i];
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function judgeEvolution(
  input: string,
  caps: Record<string, unknown>,
  provider?: LLMProvider,
  priorRuns?: LineageRunSummary[],
): Promise<EvolutionScorecard> {
  const capNames = ['Word Statistics', 'Caesar Cipher', 'Pattern Detection', 'Sentiment Heuristic', 'Self-Reflection'];

  const scores: RPGStats[] = [
    scoreWordStats(caps.wordStats as Record<string, unknown> | undefined),
    scoreCaesarCipher(caps.caesarCipher as Record<string, unknown> | undefined, input),
    scorePatterns(caps.patterns as Record<string, unknown> | undefined),
    scoreSentiment(caps.sentiment as Record<string, unknown> | undefined),
    scoreReflection(caps.reflection as Record<string, unknown> | undefined),
  ];

  const streaks = (priorRuns && priorRuns.length >= 3) ? computeStreaks(priorRuns) : [];
  const levels = scores.map((stats, i) => buildLevelScore(i + 1, capNames[i], stats, streaks[i]));

  const overall = computeOverall(levels);
  const lineage = computeLineage(levels, overall, priorRuns ?? []);

  let judgeMode: 'deterministic' | 'hybrid' = 'deterministic';
  if (provider) {
    const enhanced = await enhanceVerdictsWithLLM(levels, input, caps, provider, lineage);
    if (enhanced) judgeMode = 'hybrid';
  }

  const formatted = formatScorecard(levels, overall);

  return {
    levels,
    total_xp: overall.totalXP,
    power_level: overall.powerLevel,
    overall_grade: overall.overallGrade,
    rank_title: overall.rankTitle,
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

    // Generate RPG scorecard — auto-load lineage log for cross-run tracking
    const capabilitiesOutput = (childParsed.capabilities ?? childParsed) as Record<string, unknown>;
    const lineageRuns = loadLineageLog(this.workDir);
    const scorecard = await judgeEvolution(inputText, capabilitiesOutput, this.judgeProvider, lineageRuns);

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

    const runNumber = scorecard.lineage?.run_number ?? 1;

    // Persist current run to lineage log for future runs
    const currentRunSummary: LineageRunSummary = {
      run_number: runNumber,
      timestamp: new Date().toISOString(),
      input_hash: computeSourceHash(inputText),
      power_level: scorecard.power_level,
      overall_grade: scorecard.overall_grade,
      rank_title: scorecard.rank_title,
      total_xp: scorecard.total_xp,
      level_xps: scorecard.levels.map(l => l.xp),
      level_grades: scorecard.levels.map(l => l.grade),
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
        scorecard,
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

            // Scorecard summary — downstream agents see these directly
            scorecard_summary: {
              power_level: scorecard.power_level,
              overall_grade: scorecard.overall_grade,
              rank_title: scorecard.rank_title,
              total_xp: scorecard.total_xp,
              judge_mode: scorecard.judge_mode,
              level_grades: scorecard.levels.map(l => ({
                level: l.level,
                title: l.title,
                capability: l.capability,
                xp: l.xp,
                grade: l.grade,
              })),
              verdicts: scorecard.levels.map(l => l.verdict),
            },

            // Capability digests — what was actually found
            capability_digests: capabilityDigests,

            // Input profile — what the input looked like
            input_profile: inputProfile,

            // Lineage — cross-run progression
            lineage: scorecard.lineage,
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
