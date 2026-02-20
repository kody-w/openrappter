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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

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
// Generated files live in tmpdir, so relative imports must become absolute.

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
  return result;
}

// ── The Agent ───────────────────────────────────────────────────────

export class OuroborosAgent extends BasicAgent {
  readonly generation = 0;
  readonly workDir: string;
  readonly evolutionLog: string[] = [];

  constructor(workDir?: string) {
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

    this.workDir = workDir ?? join(tmpdir(), `ouroboros-${Date.now()}`);
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

    // Read own source
    // Resolve self: .mjs (generated evolution), .js (compiled dist/), or .ts (dev tsx)
    const mjsPath = fileURLToPath(new URL('./OuroborosAgent.mjs', import.meta.url));
    const jsPath = fileURLToPath(new URL('./OuroborosAgent.js', import.meta.url));
    const tsPath = fileURLToPath(new URL('./OuroborosAgent.ts', import.meta.url));
    const selfPath = existsSync(mjsPath) ? mjsPath : existsSync(jsPath) ? jsPath : tsPath;
    const selfSource = readFileSync(selfPath, 'utf-8');
    this.evolutionLog.push(
      `Gen ${this.generation}: reading own source (${selfSource.split('\n').length} lines)`,
    );

    // Apply next evolution from the catalog
    const nextGen = this.generation + 1;
    const entry = EVOLUTION_CATALOG[nextGen - 1];
    const nextSource = entry.apply(selfSource, nextGen);
    const nextName = `OuroborosGen${nextGen}Agent`;
    // Use same extension as source: .ts in dev/test (vitest), .mjs for compiled .js
    const ext = selfPath.endsWith('.ts') ? '.ts' : '.mjs';
    const nextPath = join(this.workDir, `${nextName}${ext}`);

    // Fix imports for tmpdir and write the evolved source
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

    // Gen 0: wrap with diff and final report
    if (this.generation === 0) {
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
      const finalLog = (childParsed.evolution_log as string[]) ?? nextAgent.evolutionLog;

      return JSON.stringify(
        {
          status: 'success',
          agent: 'OuroborosAgent',
          description: 'Self-evolution complete — 5 generations of deterministic mutation',
          input: inputText,
          generations: 5,
          evolution_log: finalLog,
          capabilities_output: childParsed.capabilities ?? childParsed,
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
              generations_evolved: 5,
              capabilities_added: 5,
              lines_added: linesAdded,
            },
          }),
        },
        null,
        2,
      );
    }

    // Gen 1-4: pass through child result
    return childResult;
  }
}
